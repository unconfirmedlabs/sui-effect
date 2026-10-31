/**
 * `Sui`: the opinionated tier.
 *
 * Where `SuiCore` mirrors the SDK, `Sui` makes the decisions: fixed include
 * sets, decoded BCS content, `Option` instead of not-found errors where a
 * caller can act on absence, chunked and integrity-checked batch reads, streams
 * for pagination, and one sender lock so gas selection cannot race itself.
 *
 * @since 0.1.0
 */
import type { BcsType } from "@mysten/bcs"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import { normalizeSuiAddress, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import {
  Array,
  Clock,
  Config,
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  RcMap,
  Result,
  Schedule,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { bcs as bcsCodec, decodeContent, typeMatches } from "../domain/bcs.ts"
import {
  BuildError,
  DecodeError,
  decodePayload,
  ExecutionFailed,
  NetworkMismatch,
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  SimulationFailed,
  TransactionNotFound,
  TransportError
} from "../domain/errors.ts"
import { EXECUTE_INCLUDE, Executed, fromTransactionResult } from "../domain/executed.ts"
import * as Metrics from "../domain/metrics.ts"
import {
  Balance,
  Coin,
  CoinMetadata,
  CoinType,
  Digest,
  DynamicField,
  DynamicFieldEntry,
  DynamicFieldName,
  EventEntry,
  executionReasonOf,
  KNOWN_CHAIN_IDS,
  makeSuiObject,
  normalizeStructTagSafe,
  ObjectEnvelope,
  ObjectId,
  Simulation,
  StructTag,
  SuiAddress,
  type SuiObject
} from "../domain/schemas.ts"
import type { SuiGrpcLayerOptions } from "./SuiCore.ts"
import { SuiCore } from "./SuiCore.ts"

/** A synchronous transaction draft. Reads happen before it, so it stays replayable. */
export type Recipe = (tx: Transaction) => void

/** The include set every object read asks for. */
export const OBJECT_INCLUDE = { content: true } as const

/** The include set every simulation asks for. */
export const SIMULATE_INCLUDE = { ...EXECUTE_INCLUDE, commandResults: true } as const

/** What can go wrong reading one object with a schema. */
export type GetObjectError =
  | ObjectNotFound
  | ObjectDeleted
  | ObjectUnavailable
  | DecodeError
  | TransportError

/** What can go wrong decoding one object of a batch read. */
export type BatchItemError = ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError

const CLOCK_TYPE = "0x2::clock::Clock"

/** The Clock object's Move layout, read through the same bridge user code uses. */
const clockCodec = bcsCodec(
  bcs.struct("Clock", { id: bcs.Address, timestamp_ms: bcs.U64 }),
  CLOCK_TYPE
)

const decodeEnvelope = Schema.decodeUnknownEffect(ObjectEnvelope)
const decodeBalance = Schema.decodeUnknownEffect(Balance)
const decodeDynamicField = Schema.decodeUnknownEffect(DynamicField)
const decodeDynamicFieldEntry = Schema.decodeUnknownEffect(DynamicFieldEntry)
const decodeSimulation = Schema.decodeUnknownEffect(Simulation)
const decodeCoin = Schema.decodeUnknownEffect(Coin)
const decodeCoinMetadata = Schema.decodeUnknownEffect(CoinMetadata)
const decodeEventEntry = Schema.decodeUnknownEffect(EventEntry)
const decodeAddress = Schema.decodeUnknownEffect(SuiAddress)

/**
 * The node answered and the answer did not match the shape this version reads.
 *
 * One representation for every such failure: a non-retryable `TransportError`
 * whose `cause` is the structured `DecodeError { kind: "shape" }`, with every
 * issue and its path — the same thing `getTransaction` and the streams produce
 * when `Executed` or an object envelope does not decode. Never fails.
 */
const boundaryError = (method: string) => (error: Schema.SchemaError): TransportError =>
  new TransportError({
    method,
    retryable: false,
    cause: new DecodeError({ kind: "shape", ...decodePayload(error) })
  })

/** A `DecodeError` that escaped a read as the `cause` of a `TransportError`. Never fails. */
const decodeAsTransport = (method: string) => (error: DecodeError): TransportError =>
  new TransportError({ method, retryable: false, cause: error })

/**
 * One page as the node answered it: the decoded items, whether the node says
 * there is more, and the SDK's cursor at the last position the page covered
 * (`null` when it names none).
 */
interface RawPage<A> {
  readonly items: ReadonlyArray<A>
  readonly hasNextPage: boolean
  readonly endCursor: string | null
}

/**
 * One page of a ledger listing (`streamEventPages`, `streamTransactionPages`,
 * `tailEventPages`, `tailTransactionPages`): its items, and the cursor to
 * resume from once they are processed.
 *
 * Commit `endCursor` **with** the items — in the same database transaction —
 * and a restarted reader that passes it back as `after` (`before` for a
 * descending read) neither skips nor repeats a page. Unlike the SDK's own
 * `endCursor`, it is never `null` once there is a position to resume from: an
 * empty page keeps the cursor it was read from, and a tail that has caught up
 * on a filtered listing moves it to the ledger head (see `tailEvents`).
 *
 * @since 0.4.0
 */
export interface ListPage<A> {
  readonly items: ReadonlyArray<A>
  /** Where to resume: pass as `after` (or `before` when descending). `null` only before any position is known. */
  readonly endCursor: string | null
  /** Whether the node said there was more after this page. */
  readonly hasNextPage: boolean
}

/**
 * The one pagination loop every `Sui.stream*` member is: ask for a page from a
 * cursor, emit it, and continue from the cursor the page names.
 *
 * Whether to continue is the page's `hasNextPage`, **never** its item count: a
 * scan-limited gRPC server may return an empty page with `hasNextPage: true`,
 * and stopping there would silently truncate the stream. A page that says there
 * is more but names no cursor ends the stream, because asking again from the
 * start would never end.
 */
const pagesOf = <A, E>(
  span: string,
  start: string | null,
  fetchPage: (cursor: string | null) => Effect.Effect<RawPage<A>, E>
): Stream.Stream<ListPage<A>, E> =>
  Stream.paginate(start, (cursor: string | null) =>
    Effect.map(fetchPage(cursor), (page) =>
      [
        [{
          items: page.items,
          endCursor: page.endCursor ?? cursor,
          hasNextPage: page.hasNextPage
        }],
        page.hasNextPage && page.endCursor !== null
          ? Option.some<string | null>(page.endCursor)
          : Option.none<string | null>()
      ] as const)).pipe(Stream.withSpan(span))

/** {@link pagesOf}, item by item. */
const paginated = <A, E>(
  span: string,
  fetchPage: (cursor: string | null) => Effect.Effect<RawPage<A>, E>,
  start: string | null = null
): Stream.Stream<A, E> =>
  pagesOf(span, start, fetchPage).pipe(
    Stream.map((page) => page.items),
    Stream.flattenIterable
  )

/** How long a tail waits before asking again once it has caught up: one second. */
const DEFAULT_POLL: Duration.Input = "1 second"

/**
 * The tail loop: {@link pagesOf} that never ends.
 *
 * When the node says there is nothing more, wait `poll` and ask again from the
 * same cursor. A retryable `TransportError` that outlives `SuiCore`'s own read
 * retries is retried here too, every `poll`, from the last cursor — a tail is
 * meant to outlive a node restart — and logged at warning level each time; a
 * non-retryable one (an `OUT_OF_RANGE` cursor the node has pruned past, say)
 * fails the stream.
 *
 * `head`, when given, is the cursor of the newest position on the **unfiltered**
 * ledger. It exists for one subtlety: a filtered listing that has caught up
 * answers an empty page with no cursor, so the reader's cursor stays on the
 * last *match* — and a pruning node prunes past it, after which resuming from
 * it fails with `OUT_OF_RANGE`. So after each wait the head is read **first**,
 * then the filtered page; if that page is empty and final, nothing matching
 * lies between the cursor and the head, and the cursor moves to the head. The
 * order matters: reading the head after the page could skip a match that
 * landed in between.
 */
const tailOf = <A>(
  span: string,
  start: string | null,
  poll: Duration.Input,
  fetchPage: (cursor: string | null) => Effect.Effect<RawPage<A>, TransportError>,
  head: Effect.Effect<string | null, TransportError> | undefined
): Stream.Stream<ListPage<A>, TransportError> => {
  // `while` is checked before the schedule steps, so the tap logs exactly the
  // retryable failures it is about to retry.
  const spaced: Schedule.Schedule<number, TransportError> = Schedule.spaced(poll)
  const retrying = spaced.pipe(
    Schedule.tap(({ input }) => Effect.logWarning(`${span}: ${input.message}; retrying from the last cursor`))
  )
  const persistently = <X>(effect: Effect.Effect<X, TransportError>) =>
    Effect.retry(effect, { schedule: retrying, while: (error) => error.retryable })
  interface State {
    readonly cursor: string | null
    readonly waited: boolean
    readonly pages: number
  }
  return Stream.paginate<State, ListPage<A>, TransportError>(
    { cursor: start, waited: false, pages: 0 },
    (state) =>
      Effect.gen(function*() {
        if (state.waited) yield* Effect.sleep(poll)
        const headCursor = state.waited && head !== undefined ? yield* persistently(head) : null
        const page = yield* persistently(fetchPage(state.cursor))
        const more = page.hasNextPage && page.endCursor !== null
        let endCursor = page.endCursor ?? state.cursor
        if (!more && page.items.length === 0 && headCursor !== null) endCursor = headCursor
        const emitted: ReadonlyArray<ListPage<A>> = page.items.length > 0 || endCursor !== state.cursor
          ? [{ items: page.items, endCursor, hasNextPage: more }]
          : []
        const pages = state.pages + emitted.length
        // On the tail's own span: how far it has read, and whether it is at
        // the head — a tail that never catches up is falling behind the chain.
        yield* Effect.annotateCurrentSpan({ "sui.page_count": pages, "sui.caught_up": !more })
        return [emitted, Option.some({ cursor: endCursor, waited: !more, pages })] as const
      })
  ).pipe(Stream.withSpan(span))
}

/**
 * An event filter with a full `eventType` normalized. The SDK passes a full
 * type through to the node unchanged, and gRPC refuses an unpadded address in
 * it (`INVALID_ARGUMENT: invalid address`) — so `0x2::coin::CoinMetadata<…>`
 * failed where its padded spelling worked. A `package::module` form, an MVR
 * name and anything else that does not parse is left for the SDK. Never fails.
 */
const normalizeEventFilter = (filter: EventFilter): EventFilter =>
  filter.eventType === undefined || filter.eventType === null
    ? filter
    : { ...filter, eventType: normalizeStructTagSafe(filter.eventType) }

/**
 * Refuses a function filter the SDK cannot paginate, before the first request.
 *
 * `@mysten/sui` throws once a cursor is passed with a `package` or
 * `package::module` function filter (JSON-RPC cannot continue one), so such a
 * stream used to return its first fifty transactions and then fail — a bug that
 * only shows once there is enough history. A defect, because it is a bug in the
 * calling program: no retry and no node can fix it.
 */
const assertPaginableFilter = (span: string, filter: TransactionFilter | undefined): void => {
  const fn = filter?.function
  if (fn === undefined || fn === null) return
  const segments = fn.split("::")
  if (segments.length === 3 && segments.every((segment) => segment !== "")) return
  throw new Error(
    `${span}: the function filter "${fn}" cannot be paginated — @mysten/sui requires a fully ` +
      "qualified `package::module::function` to continue past the first page. Filter on one " +
      "function, or read a single page with `sui.core.listTransactions({ filter })`."
  )
}

/**
 * The sender locks: one reference-counted semaphore per address, released a
 * minute after its last holder leaves.
 */
const makeSenderLocks = RcMap.make({
  lookup: (_address: string) => Effect.succeed(Semaphore.makeUnsafe(1)),
  idleTimeToLive: "1 minute"
})

/**
 * Decodes the SDK's simulation envelope into sui-effect's stable shape.
 *
 * Mainnet gRPC can omit `Transaction.digest` from a successful simulation
 * while still returning the same digest in `Transaction.effects
 * .transactionDigest`. The effects digest is authoritative enough for this
 * read-only result and is the fallback the SDK envelope itself provides. When
 * both locations are present they must agree: accepting two different digests
 * would attach effects to the wrong transaction identity.
 *
 * This is internal rather than public API; it is exported through
 * `src/internal.ts` so the two live wire shapes and the disagreement case can
 * be tested directly.
 */
export const fromSimulationResult = Effect.fnUntraced(function*(
  result: SuiClientTypes.SimulateTransactionResult<typeof SIMULATE_INCLUDE>
): Effect.fn.Return<Simulation, SimulationFailed | TransportError> {
  if (result.$kind === "FailedTransaction") {
    const status = result.FailedTransaction.status
    if (status.success) {
      return yield* TransportError.fromUnknown(
        "simulateTransaction",
        "the node reported a failed transaction whose status says it succeeded",
        false
      )
    }
    return yield* new SimulationFailed({
      reason: executionReasonOf(status.error),
      message: status.error.message,
      ...(status.error.command === undefined ? {} : { command: status.error.command })
    })
  }

  const transaction = result.Transaction
  // The SDK type says the top-level digest is always present, but Mainnet's
  // gRPC response currently disproves that. Keep the looseness confined to
  // this transport boundary and let the Digest schema validate the selected
  // value below.
  const topLevelDigest = (transaction as { readonly digest?: unknown }).digest
  const effectsDigest = (transaction.effects as {
    readonly transactionDigest?: unknown
  } | null | undefined)?.transactionDigest

  if (
    typeof topLevelDigest === "string" &&
    typeof effectsDigest === "string" &&
    topLevelDigest !== effectsDigest
  ) {
    return yield* TransportError.fromUnknown(
      "simulateTransaction",
      `the node returned two different transaction digests: ${topLevelDigest} and ${effectsDigest}`,
      false
    )
  }

  return yield* decodeSimulation({
    digest: topLevelDigest ?? effectsDigest,
    effects: transaction.effects,
    events: transaction.events,
    balanceChanges: transaction.balanceChanges,
    objectTypes: transaction.objectTypes,
    commandResults: result.commandResults,
    gasPaymentMocked: gasPaymentMockedOf(result, transaction.effects)
  }).pipe(Effect.mapError(boundaryError("simulateTransaction")))
})

/**
 * The SDK reports a mocked gas payment as `effects.gasObject` naming this id;
 * `@mysten/sui` exports it as `MOCKED_GAS_OBJECT_ID` from 2.38, and the peer
 * range admits older versions that do not.
 */
const MOCKED_GAS_OBJECT_ID = normalizeSuiAddress("0x" + "f".repeat(64))

/**
 * `gasPaymentMocked` as the SDK reported it (2.38 and later) and, on an SDK
 * that predates the field, derived the way the SDK derives it: from the gas
 * object the effects name. Read structurally so the declaration compiles
 * against every SDK version the peer range admits. Never fails.
 */
const gasPaymentMockedOf = (
  result: object,
  effects: { readonly gasObject?: { readonly objectId?: string } | null } | null | undefined
): boolean => {
  const reported = (result as { readonly gasPaymentMocked?: unknown }).gasPaymentMocked
  if (typeof reported === "boolean") return reported
  const id = effects?.gasObject?.objectId
  return id !== undefined && normalizeSuiAddress(id) === MOCKED_GAS_OBJECT_ID
}

/**
 * A filter on events: exactly one of `sender`, `emitModule` or `eventType`.
 * The SDK's `SuiClientTypes.EventFilter`, under its own name.
 */
export type EventFilter = SuiClientTypes.EventFilter

/**
 * A filter on transactions: exactly one of `sender` or `function`. The SDK's
 * `SuiClientTypes.TransactionFilter`, under its own name.
 */
export type TransactionFilter = SuiClientTypes.TransactionFilter

/** The ledger order a listing is read in. Mirrors the SDK's `order` option. */
export type ListOrder = "ascending" | "descending"

/**
 * Where a ledger listing starts and which way it reads. The SDK's own
 * pagination options, under its own names: `after` resumes an ascending read
 * strictly after a cursor (a `ListPage.endCursor` you committed), `before` a
 * descending one; `before` implies `order: "descending"`. Give at most one.
 *
 * @since 0.4.0
 */
export interface ListOptions {
  readonly order?: ListOrder
  /** Resume an ascending read strictly after this cursor; `null` is the start. */
  readonly after?: string | null
  /** Resume a descending read strictly before this cursor; `null` is the newest. */
  readonly before?: string | null
}

/**
 * Where a tail starts and how often it asks once it has caught up.
 *
 * `after` is a cursor to resume strictly after — a `ListPage.endCursor` the
 * caller committed — and, omitted, the tail starts at the beginning of the
 * history the node serves. `poll` is the wait between requests while there is
 * nothing new, one second unless given.
 *
 * @since 0.4.0
 */
export interface TailOptions {
  /** Resume strictly after this cursor (a committed `ListPage.endCursor`); `null` is the start. */
  readonly after?: string | null
  readonly poll?: Duration.Input
}

/**
 * {@link DynamicField} with its value decoded: what `getDynamicFieldOption`
 * answers when it is given a `schema`. `content` is the decoded value; the
 * raw bytes stay on `value.bcs`.
 *
 * @since 0.4.0
 */
export interface DecodedDynamicField<S> extends DynamicField {
  readonly content: S
}

/** The opinionated tier over `SuiCore`. */
export interface SuiService {
  /** The network the underlying client was built for. */
  readonly network: SuiClientTypes.Network

  /**
   * The mechanical tier this `Sui` was built over.
   *
   * `Sui` is the tier application code reads through, but writing a
   * transaction needs `executeTransaction` and the SDK client object behind
   * `use`, neither of which belongs on the opinionated tier. Exposing the core
   * here is what lets every `Tx.*` function declare `R = Sui` and nothing
   * else. Reach for it directly only for a field or method `Sui` does not
   * expose.
   */
  readonly core: SuiCore["Service"]

  /** The genesis checkpoint digest of the chain, read once at layer build. */
  readonly chainId: string

  /**
   * The chain's own clock, read from the Clock object `0x6` through the BCS
   * bridge and never cached.
   *
   * Fails with: `TransportError`.
   */
  readonly chainTime: Effect.Effect<DateTime.Utc, TransportError>

  /**
   * Reads one object, decoding its BCS content with `opts.schema` when given.
   *
   * The object's type tag is checked before the bytes are parsed: against
   * `opts.expectedType` when given, otherwise against the type
   * `SuiSchema.bcs` recorded on the codec. This member and the two below are
   * written as overloads, not `Effect.fn`, because `Effect.fn` cannot express
   * an overload set; the implementations are `Effect.fn` and carry the span.
   *
   * A Move **package** is an object too, with `type: "package"` and no Move
   * content: its `content` is an empty `Uint8Array` (the node sends none), and
   * a `schema` read of one fails the type check.
   *
   * Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`,
   * `DecodeError`, `TransportError`.
   */
  readonly getObject: {
    <S>(
      id: ObjectId,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<SuiObject<S>, GetObjectError>
    (
      id: ObjectId,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<SuiObject<Uint8Array>, GetObjectError>
  }

  /**
   * Like `getObject`, but a missing or deleted object is `None` rather than a
   * failure.
   *
   * Fails with: `ObjectUnavailable`, `DecodeError`, `TransportError`.
   */
  readonly getObjectOption: {
    <S>(
      id: ObjectId,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<
      Option.Option<SuiObject<S>>,
      ObjectUnavailable | DecodeError | TransportError
    >
    (
      id: ObjectId,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<
      Option.Option<SuiObject<Uint8Array>>,
      ObjectUnavailable | DecodeError | TransportError
    >
  }

  /**
   * Reads many objects, chunked by 50, checking that the node answered for
   * each requested id exactly once. Ids are normalized and deduplicated before
   * the request, so asking twice for the same object is legal and returns the
   * same `Result` twice. Per-object failures are `Result` values.
   *
   * Fails with: `TransportError`.
   */
  readonly getObjects: {
    <S>(
      ids: ReadonlyArray<ObjectId>,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<ReadonlyArray<Result.Result<SuiObject<S>, BatchItemError>>, TransportError>
    (
      ids: ReadonlyArray<ObjectId>,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<
      ReadonlyArray<Result.Result<SuiObject<Uint8Array>, BatchItemError>>,
      TransportError
    >
  }

  /**
   * `getObjects` for a caller who wants the first per-item failure to fail the
   * whole read.
   *
   * The soft idiom — filter or default the `Result` array `getObjects` returns
   * — is right when a missing object is ordinary. This is the hard one: every
   * id must be there, and the first that is not is the failure. Order is the
   * order of `ids`.
   *
   * Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`,
   * `DecodeError`, `TransportError`.
   *
   * @since 0.1.2
   */
  readonly getObjectsStrict: {
    <S>(
      ids: ReadonlyArray<ObjectId>,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<ReadonlyArray<SuiObject<S>>, BatchItemError | TransportError>
    (
      ids: ReadonlyArray<ObjectId>,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<ReadonlyArray<SuiObject<Uint8Array>>, BatchItemError | TransportError>
  }

  /**
   * The balance of one coin type for one owner; `coinType` defaults to SUI.
   *
   * `coinType` is any spelling — a plain `"0x2::sui::SUI"` is fine — and is
   * normalized by the SDK. Fails with: `TransportError`.
   */
  readonly getBalance: (
    owner: SuiAddress,
    coinType?: CoinType | string
  ) => Effect.Effect<Balance, TransportError>

  /**
   * Every balance an owner holds, one per coin type, paginated.
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly streamBalances: (owner: SuiAddress) => Stream.Stream<Balance, TransportError>

  /**
   * Every coin object of one coin type an owner holds, paginated. `coinType`
   * defaults to SUI, the way the SDK's `listCoins` does; it is the coin type,
   * not the `0x2::coin::Coin<…>` object type, in any spelling (the SDK
   * normalizes it).
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly streamCoins: (
    owner: SuiAddress,
    coinType?: CoinType | string
  ) => Stream.Stream<Coin, TransportError>

  /**
   * The metadata of a coin type; `None` when the coin type has no metadata
   * object, which is what the node answers for it. `coinType` is any spelling;
   * the SDK normalizes it.
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly getCoinMetadataOption: (
    coinType: CoinType | string
  ) => Effect.Effect<Option.Option<CoinMetadata>, TransportError>

  /**
   * The address a SuiNS name points at; `None` when the name resolves to
   * nothing, and when the node has no SuiNS for this network (`UNIMPLEMENTED`,
   * which is what a localnet answers).
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly resolveNameServiceAddressOption: (
    name: string
  ) => Effect.Effect<Option.Option<SuiAddress>, TransportError>

  /**
   * The default SuiNS name of an address; `None` when it has none.
   *
   * From `@mysten/sui` 2.33.2 the node's "no name" is an answer
   * (`{ data: { name: null } }`); before it, the gRPC transport threw
   * `NOT_FOUND`. Both are `None` here, so the answer does not depend on the SDK
   * version. A node with no SuiNS for this network (`UNIMPLEMENTED`, which is
   * what a localnet answers) is `None` too.
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly defaultNameServiceNameOption: (
    address: SuiAddress
  ) => Effect.Effect<Option.Option<string>, TransportError>

  /**
   * Reads one dynamic field; absence is `None`.
   *
   * `name` is the key — its Move type and BCS bytes; `SuiSchema.name(codec,
   * key)` builds one from the same codec that describes the key. With
   * `opts.schema` the value is decoded too, onto `content`, after its type
   * (`valueType`) is checked against `opts.expectedType` or the type the codec
   * records — the same check `getObject` does, so a forgotten `actualType`
   * cannot skip it. Written as an overload set for the same reason `getObject`
   * is; the implementation is `Effect.fn`.
   *
   * Fails with: `DecodeError` (only with a `schema`), `TransportError`.
   */
  readonly getDynamicFieldOption: {
    <S>(
      parent: ObjectId,
      name: DynamicFieldName,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<Option.Option<DecodedDynamicField<S>>, DecodeError | TransportError>
    (
      parent: ObjectId,
      name: DynamicFieldName,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<Option.Option<DynamicField>, TransportError>
  }

  /**
   * Reads the object stored under a dynamic **object** field
   * (`0x2::dynamic_object_field`), decoding its content with `opts.schema`
   * when given; absence is `None`.
   *
   * `name` is the key as the Move code wrote it — its own type and BCS bytes —
   * not the `dynamic_object_field::Wrapper<…>` the SDK wraps it in. The
   * object's type tag is checked the way `getObject` checks it. Written as an
   * overload set for the same reason `getObject` is; the implementation is
   * `Effect.fn`.
   *
   * Fails with: `DecodeError`, `TransportError`.
   *
   * @since 0.4.0
   */
  readonly getDynamicObjectFieldOption: {
    <S>(
      parent: ObjectId,
      name: DynamicFieldName,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<Option.Option<SuiObject<S>>, DecodeError | TransportError>
    (
      parent: ObjectId,
      name: DynamicFieldName,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<Option.Option<SuiObject<Uint8Array>>, DecodeError | TransportError>
  }

  /**
   * Reads an executed transaction. A historical transaction that failed on
   * chain fails here too, so there is one representation of an on-chain failure.
   *
   * Fails with: `ExecutionFailed`, `TransactionNotFound`, `TransportError`.
   */
  readonly getTransaction: (
    digest: Digest
  ) => Effect.Effect<Executed, ExecutionFailed | TransactionNotFound | TransportError>

  /**
   * Simulates a transaction with the fixed simulate include set.
   *
   * `opts.sender` is set on the transaction when the recipe did not set one.
   * A simulation needs *a* sender: the SDK substitutes the zero address when
   * the transaction carries none, which is what a read-only simulation of a
   * public function wants and is what happens here when `sender` is omitted. A
   * recipe may `tx.setSender(...)` itself, and then it wins. Bytes that are
   * already serialized carry their own sender and `opts.sender` does not apply.
   *
   * Fails with: `SimulationFailed`, `BuildError`, `TransportError`.
   */
  readonly simulate: (
    input: Recipe | Transaction | Uint8Array,
    opts?: { readonly sender?: SuiAddress }
  ) => Effect.Effect<Simulation, SimulationFailed | BuildError | TransportError>

  /**
   * Reads a Move return value without executing: simulates with checks disabled
   * and decodes return value `result` (default 0) of command `command`
   * (default the last command).
   *
   * The codec may be a bare `@mysten/bcs` `BcsType` — `bcs.Address` (a value,
   * 32 fixed bytes), `bcs.u64()`, `bcs.vector(bcs.u64())` — because a Move
   * **return value** has no struct tag to check it against. A `SuiSchema.bcs` codec works too, and so does one
   * composed with `Schema.decodeTo(DomainClass, …)`; no type tag is compared
   * either way.
   *
   * `input` is anything `simulate` takes: a recipe, a `Transaction`, or
   * serialized bytes. `opts.sender` is the address the call is simulated as,
   * defaulting to the zero address the way the SDK does; a recipe that sets its
   * own sender wins, and bytes carry their own.
   *
   * Fails with: `SimulationFailed`, `BuildError`, `DecodeError`, `TransportError`.
   */
  readonly view: <S, I>(
    input: Recipe | Transaction | Uint8Array,
    schema: Schema.Codec<S, Uint8Array> | BcsType<S, I>,
    opts?: {
      readonly command?: number
      readonly result?: number
      readonly sender?: SuiAddress
    }
  ) => Effect.Effect<S, SimulationFailed | BuildError | DecodeError | TransportError>

  /**
   * Every object an address owns, paginated; `opts.type` filters by Move type
   * in any spelling (a bare generic such as `0x2::coin::Coin` matches every
   * instantiation). Fails with: `TransportError`.
   */
  readonly streamOwnedObjects: (
    owner: SuiAddress,
    opts?: { readonly type?: StructTag | string }
  ) => Stream.Stream<SuiObject<Uint8Array>, TransportError>

  /**
   * Every dynamic field of a parent, paginated.
   *
   * There is no key filter: the node has none, so a caller filters the stream
   * on `entry.name.type`. Do that with `SuiSchema.matchesType`, not with the
   * SDK's `normalizeStructTag` — a dynamic-field key is legally a primitive
   * (`u64`, `bool`, `address`, `vector<u8>`) and `normalizeStructTag` throws on
   * every one of them, which turns the first such key in a parent's fields into
   * a defect. The value bytes are decoded with `SuiSchema.decode`, passing
   * `actualType: entry.valueType` so the same tag check `Sui.getObject` does
   * runs before a byte is parsed.
   *
   * Fails with: `TransportError`.
   */
  readonly streamDynamicFields: (
    parent: ObjectId
  ) => Stream.Stream<DynamicFieldEntry, TransportError>

  /**
   * Every event matching `filter` (all events when omitted), paginated in
   * ledger order — oldest first, or newest first with
   * `{ order: "descending" }`.
   *
   * `filter` is the SDK's `EventFilter`: exactly one of `sender`,
   * `emitModule` (`package::module`) or `eventType` (a module, or a full type;
   * a bare generic matches every instantiation on gRPC and GraphQL). A full
   * `eventType` is normalized here, because gRPC refuses an unpadded address
   * in one. Decode an
   * event's payload with `SuiSchema.decode(codec, entry.bcs, { actualType:
   * entry.eventType })`. The stream follows `hasNextPage`, not the item count,
   * so a scan-limited server's empty pages do not end it early, and it **ends**
   * once it has caught up — `tailEvents` is the one that follows the chain.
   * `opts.after` / `opts.before` resume from a committed cursor; to commit one,
   * read `streamEventPages` instead, which carries it.
   *
   * A malformed filter is a defect carrying the SDK's sentence, not a
   * `TransportError`. Fails with: `TransportError` (an `OUT_OF_RANGE` status
   * means the node has pruned the history the cursor points into).
   *
   * @since 0.4.0
   */
  readonly streamEvents: (
    filter?: EventFilter,
    opts?: ListOptions
  ) => Stream.Stream<EventEntry, TransportError>

  /**
   * `streamEvents` a page at a time, each page carrying the cursor to resume
   * from: commit `page.endCursor` with the page's items and pass it back as
   * `after`.
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly streamEventPages: (
    filter?: EventFilter,
    opts?: ListOptions
  ) => Stream.Stream<ListPage<EventEntry>, TransportError>

  /**
   * Every event matching `filter`, oldest first, **without end**: once caught
   * up it waits `opts.poll` (one second) and asks again from its last cursor.
   *
   * It survives a node restart: a retryable `TransportError` is retried every
   * `poll` from the last cursor, logged at warning level. On a filtered tail it
   * also keeps its cursor near the ledger head while nothing matches (see
   * `ListPage`), so a pruning node does not prune past it. `Stream.retry` on
   * the result starts again from `opts.after`, not from where it stopped: for a
   * restartable indexer use `tailEventPages` and commit each page's
   * `endCursor`.
   *
   * Fails with: `TransportError`, only when it is not retryable (a cursor the
   * node has pruned past answers `OUT_OF_RANGE`).
   *
   * @since 0.4.0
   */
  readonly tailEvents: (
    filter?: EventFilter,
    opts?: TailOptions
  ) => Stream.Stream<EventEntry, TransportError>

  /**
   * `tailEvents` a page at a time, each page carrying the cursor to resume
   * from. A caught-up filtered tail emits an **empty** page whenever it moves
   * its cursor to the ledger head, so that position can be committed too.
   *
   * Fails with: `TransportError`, only when it is not retryable.
   *
   * @since 0.4.0
   */
  readonly tailEventPages: (
    filter?: EventFilter,
    opts?: TailOptions
  ) => Stream.Stream<ListPage<EventEntry>, TransportError>

  /**
   * Every transaction matching `filter` (all transactions when omitted),
   * paginated in ledger order, oldest first unless `{ order: "descending" }`.
   *
   * `filter` is the SDK's `TransactionFilter`: exactly one of `sender` or
   * `function`. **A function filter must be fully qualified**
   * (`package::module::function`): the SDK cannot continue a `package` or
   * `package::module` filter past its first page, so this refuses one up front,
   * as a defect, rather than failing after fifty transactions. (For a single
   * page of a module filter, call `sui.core.listTransactions` directly.)
   * Each transaction is read with the execute include set and decoded to an
   * `Executed`. A transaction that applied and **failed** is an ordinary
   * entry in a history, so it is a `Result` failure carrying the
   * `ExecutionFailed` — not a failure of the stream, which `getTransaction`'s
   * "a failure is a failure" rule would make it.
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly streamTransactions: (
    filter?: TransactionFilter,
    opts?: ListOptions
  ) => Stream.Stream<Result.Result<Executed, ExecutionFailed>, TransportError>

  /**
   * `streamTransactions` a page at a time, each page carrying the cursor to
   * resume from (see `streamEventPages`).
   *
   * Fails with: `TransportError`.
   *
   * @since 0.4.0
   */
  readonly streamTransactionPages: (
    filter?: TransactionFilter,
    opts?: ListOptions
  ) => Stream.Stream<ListPage<Result.Result<Executed, ExecutionFailed>>, TransportError>

  /**
   * Every transaction matching `filter`, oldest first, without end — the
   * transaction twin of `tailEvents`, with the same polling, retry and
   * filtered-cursor behaviour, and `streamTransactions`' rule for function
   * filters.
   *
   * Fails with: `TransportError`, only when it is not retryable.
   *
   * @since 0.4.0
   */
  readonly tailTransactions: (
    filter?: TransactionFilter,
    opts?: TailOptions
  ) => Stream.Stream<Result.Result<Executed, ExecutionFailed>, TransportError>

  /**
   * `tailTransactions` a page at a time (see `tailEventPages`).
   *
   * Fails with: `TransportError`, only when it is not retryable.
   *
   * @since 0.4.0
   */
  readonly tailTransactionPages: (
    filter?: TransactionFilter,
    opts?: TailOptions
  ) => Stream.Stream<ListPage<Result.Result<Executed, ExecutionFailed>>, TransportError>

  /**
   * Serializes work for one sender, so two transactions from the same address
   * cannot pick the same gas coin. Adds no failures of its own.
   */
  readonly withSenderLock: (
    address: SuiAddress
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

const CHUNK = 50

/**
 * How many `getObjects` chunks are in flight at once.
 *
 * A 500-id read is ten chunk round trips sequentially and three at four; the
 * bound is there because the other side is a rate-limited node, and a 429 is a
 * retryable failure worth not provoking.
 */
const CHUNK_CONCURRENCY = 4

/** Options every object read accepts. */
interface ReadOptions<S> {
  readonly schema?: Schema.Codec<S, Uint8Array>
  /**
   * The Move type the object must have, overriding the type recorded on the
   * codec. The escape hatch for a codec that is not a `SuiSchema.bcs` bridge.
   */
  readonly expectedType?: string
}

/**
 * A `@mysten/bcs` layout rather than a `Schema.Codec`.
 *
 * Structural rather than `instanceof`: a consumer whose `@mysten/bcs` is a
 * second copy in the tree would fail the identity test while holding a
 * perfectly good layout. A `Schema.Codec` has neither a `read` function nor a
 * `serialize` method, so the two cannot be confused.
 */
const isBcsType = <S, I>(
  value: Schema.Codec<S, Uint8Array> | BcsType<S, I>
): value is BcsType<S, I> =>
  typeof (value as { readonly read?: unknown }).read === "function" &&
  typeof (value as { readonly serialize?: unknown }).serialize === "function"

const keyOf = (id: string): string => {
  try {
    return normalizeSuiAddress(id)
  } catch {
    return id
  }
}

const makeSui = (
  core: SuiCore["Service"],
  chainId: string,
  locks: RcMap.RcMap<string, Semaphore.Semaphore>
): SuiService => {
  const envelopeOf = (object: SuiClientTypes.Object<typeof OBJECT_INCLUDE>) =>
    decodeEnvelope(object).pipe(Effect.mapError(boundaryError("getObject")))

  const decodeObject = Effect.fnUntraced(function*<S>(
    object: SuiClientTypes.Object<typeof OBJECT_INCLUDE>,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<SuiObject<S | Uint8Array>, DecodeError | TransportError> {
    const envelope = yield* envelopeOf(object)
    // A package has no Move content and the node sends none; the type says
    // `Uint8Array`, so it gets an empty one rather than `undefined`.
    const raw: Uint8Array = object.content ?? (envelope.type === "package" ? new Uint8Array(0) : object.content)
    const schema = opts?.schema
    if (schema === undefined) {
      // An explicit `expectedType` is a question about the object, not about
      // the codec: `getObject(id, { expectedType })` with no schema is how a
      // caller says "this had better be a `Coin<SUI>`" while keeping the raw
      // bytes. Returning early without checking it answered a different
      // question than the one that was asked.
      const expected = opts?.expectedType
      if (expected !== undefined && !typeMatches(expected, envelope.type)) {
        return yield* new DecodeError({
          objectId: envelope.objectId,
          expectedType: expected,
          kind: "type",
          actualType: envelope.type,
          issue: `object ${envelope.objectId} has type ${envelope.type}`
        })
      }
      return makeSuiObject(envelope, raw)
    }
    // One rule for every Move type check in the library: `typeMatches` inside
    // `decodeContent`, which accepts a bare tag as every instantiation of it
    // and compares a parameterized one in full.
    const content = yield* decodeContent(schema, raw, {
      objectId: envelope.objectId,
      ...(opts?.expectedType === undefined ? {} : { expectedType: opts.expectedType }),
      actualType: envelope.type
    })
    return makeSuiObject(envelope, content)
  })

  const getObject = Effect.fn("Sui.getObject")(function*<S>(
    id: ObjectId,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<SuiObject<S | Uint8Array>, GetObjectError> {
    const { object } = yield* core.getObject({ objectId: id, include: OBJECT_INCLUDE })
    return yield* decodeObject(object, opts)
  })

  const getObjectOption = Effect.fn("Sui.getObjectOption")(function*<S>(
    id: ObjectId,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<
    Option.Option<SuiObject<S | Uint8Array>>,
    ObjectUnavailable | DecodeError | TransportError
  > {
    return yield* getObject(id, opts).pipe(
      Effect.map(Option.some),
      Effect.catchTag(["ObjectNotFound", "ObjectDeleted"], () =>
        Effect.succeed(Option.none<SuiObject<S | Uint8Array>>()))
    )
  })

  const getObjects = Effect.fn("Sui.getObjects")(function*<S>(
    ids: ReadonlyArray<ObjectId>,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<
    ReadonlyArray<Result.Result<SuiObject<S | Uint8Array>, BatchItemError>>,
    TransportError
  > {
    type Item = Result.Result<SuiObject<S | Uint8Array>, BatchItemError>
    type Entry = readonly [string, Item]
    const unique: Array<ObjectId> = []
    const requested = new Set<string>()
    for (const id of ids) {
      const key = keyOf(id)
      if (requested.has(key)) continue
      requested.add(key)
      unique.push(id)
    }

    /** One chunk of at most {@link CHUNK} ids, as the entries it answered. */
    const fetchPage = Effect.fn("Sui.getObjectsPage")(function*(
      page: ReadonlyArray<ObjectId>
    ): Effect.fn.Return<ReadonlyArray<Entry>, TransportError> {
      const response = yield* core.getObjects({
        objectIds: [...page],
        include: OBJECT_INCLUDE
      })
      if (response.objects.length !== page.length) {
        return yield* new TransportError({
          method: "getObjects",
          retryable: false,
          cause: `asked for ${page.length} objects and the node answered for ${response.objects.length}`
        })
      }
      const entries: Array<Entry> = []
      // `decodeObject` has no span of its own (it runs once per object), so a
      // page that decoded badly says how badly on its own span.
      let decodeFailures = 0
      for (let index = 0; index < page.length; index += 1) {
        const id = page[index] as ObjectId
        const item = response.objects[index]
        if (item === undefined) {
          return yield* new TransportError({
            method: "getObjects",
            retryable: false,
            cause: `the node returned no entry for ${id}`
          })
        }
        if (item instanceof Error) {
          entries.push([keyOf(id), Result.fail(mapObjectItemError(id, item))])
          continue
        }
        if (keyOf(item.objectId) !== keyOf(id)) {
          return yield* new TransportError({
            method: "getObjects",
            retryable: false,
            cause: `asked for ${id} and the node answered for ${item.objectId}`
          })
        }
        const decoded = yield* Effect.result(decodeObject(item, opts))
        if (Result.isFailure(decoded)) {
          if (decoded.failure._tag === "TransportError") return yield* decoded.failure
          decodeFailures += 1
          entries.push([keyOf(id), Result.fail(decoded.failure)])
          continue
        }
        entries.push([keyOf(id), Result.succeed(decoded.success)])
      }
      yield* Effect.annotateCurrentSpan({
        "sui.object_count": page.length,
        "sui.decode_failures": decodeFailures
      })
      return entries
    })

    // `Effect.forEach` preserves input order and fails on the **first** failure,
    // which is exactly what the sequential loop's `return yield*` relied on: an
    // integrity failure or a `TransportError` out of `decodeObject` still fails
    // the whole read and no partial array escapes. Bounded, not unbounded,
    // because the other side of this is a rate-limited node.
    const chunks = Array.chunksOf(unique, CHUNK)
    yield* Effect.annotateCurrentSpan({ "sui.object_count": unique.length, "sui.chunk_count": chunks.length })
    const pages = yield* Effect.forEach(
      chunks,
      fetchPage,
      { concurrency: CHUNK_CONCURRENCY }
    )
    const answers = new Map<string, Item>()
    for (const page of pages) {
      for (const [key, item] of page) answers.set(key, item)
    }

    const results: Array<Item> = []
    for (const id of ids) {
      const answer = answers.get(keyOf(id))
      if (answer === undefined) {
        return yield* new TransportError({
          method: "getObjects",
          retryable: false,
          cause: `the node returned no entry for ${id}`
        })
      }
      results.push(answer)
    }
    return results
  })

  const getObjectsStrict = Effect.fn("Sui.getObjectsStrict")(function*<S>(
    ids: ReadonlyArray<ObjectId>,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<
    ReadonlyArray<SuiObject<S | Uint8Array>>,
    BatchItemError | TransportError
  > {
    const results = yield* getObjects(ids, opts)
    const objects: Array<SuiObject<S | Uint8Array>> = []
    for (const result of results) {
      if (Result.isFailure(result)) return yield* result.failure
      objects.push(result.success)
    }
    return objects
  })

  const getBalance = Effect.fn("Sui.getBalance")(function*(
    owner: SuiAddress,
    coinType?: CoinType | string
  ): Effect.fn.Return<Balance, TransportError> {
    const { balance } = yield* core.getBalance({
      owner,
      ...(coinType === undefined ? {} : { coinType })
    })
    return yield* decodeBalance(balance).pipe(Effect.mapError(boundaryError("getBalance")))
  })

  const getDynamicFieldOption = Effect.fn("Sui.getDynamicFieldOption")(function*<S>(
    parent: ObjectId,
    name: DynamicFieldName,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<
    Option.Option<DynamicField | DecodedDynamicField<S>>,
    DecodeError | TransportError
  > {
    const field = yield* readDynamicField(parent, name)
    const schema = opts?.schema
    if (Option.isNone(field) || schema === undefined) return field
    const content = yield* decodeContent(schema, field.value.value.bcs, {
      ...(opts?.expectedType === undefined ? {} : { expectedType: opts.expectedType }),
      actualType: field.value.valueType
    })
    return Option.some({ ...field.value, content })
  })

  const readDynamicField = (
    parent: ObjectId,
    name: DynamicFieldName
  ): Effect.Effect<Option.Option<DynamicField>, TransportError> =>
    core.getDynamicField({ parentId: parent, name }).pipe(
      Effect.flatMap(({ dynamicField }) =>
        // `SuiClientTypes.DynamicField` declares `valueType`, but the SDK's
        // `getDynamicField` (through at least 2.38) only sets `value.type`.
        decodeDynamicField({
          ...dynamicField,
          valueType: dynamicField.valueType ?? dynamicField.value?.type
        }).pipe(
          Effect.mapError(boundaryError("getDynamicField")),
          Effect.map(Option.some)
        )
      ),
      Effect.catchTag(["ObjectNotFound", "ObjectDeleted"], () =>
        Effect.succeed(Option.none<DynamicField>())),
      Effect.catchTag("ObjectUnavailable", (error) =>
        Effect.fail(
          new TransportError({ method: "getDynamicField", retryable: false, cause: error })
        ))
    )

  const getTransaction = Effect.fn("Sui.getTransaction")(function*(
    digest: Digest
  ): Effect.fn.Return<Executed, ExecutionFailed | TransactionNotFound | TransportError> {
    return yield* core.getTransaction({ digest, include: EXECUTE_INCLUDE }).pipe(
      Effect.flatMap(fromTransactionResult),
      Effect.catchTag("DecodeError", (error) => Effect.fail(decodeAsTransport("getTransaction")(error)))
    )
  })

  const getDynamicObjectFieldOption = Effect.fn("Sui.getDynamicObjectFieldOption")(function*<S>(
    parent: ObjectId,
    name: DynamicFieldName,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<Option.Option<SuiObject<S | Uint8Array>>, DecodeError | TransportError> {
    return yield* core.getDynamicObjectField({ parentId: parent, name, include: OBJECT_INCLUDE }).pipe(
      Effect.flatMap(({ object }) => Effect.map(decodeObject(object, opts), Option.some)),
      Effect.catchTag(["ObjectNotFound", "ObjectDeleted"], () =>
        Effect.succeed(Option.none<SuiObject<S | Uint8Array>>())),
      // As `getDynamicFieldOption`: an object the node cannot serve is not an
      // absence, and not something the caller can act on as an object error.
      Effect.catchTag("ObjectUnavailable", (error) =>
        Effect.fail(
          new TransportError({ method: "getDynamicObjectField", retryable: false, cause: error })
        ))
    )
  })

  const getCoinMetadataOption = Effect.fn("Sui.getCoinMetadataOption")(function*(
    coinType: CoinType | string
  ): Effect.fn.Return<Option.Option<CoinMetadata>, TransportError> {
    const { coinMetadata } = yield* core.getCoinMetadata({ coinType })
    if (coinMetadata === null) return Option.none()
    return Option.some(
      yield* decodeCoinMetadata(coinMetadata).pipe(Effect.mapError(boundaryError("getCoinMetadata")))
    )
  })

  const resolveNameServiceAddressOption = Effect.fn("Sui.resolveNameServiceAddressOption")(
    function*(name: string): Effect.fn.Return<Option.Option<SuiAddress>, TransportError> {
      const answer = yield* core.resolveNameServiceAddress({ name }).pipe(
        Effect.map(Option.some),
        Effect.catchIf(noNameService, () => Effect.succeed(Option.none()))
      )
      if (Option.isNone(answer)) return Option.none()
      const { address } = answer.value
      if (address === null) return Option.none()
      return Option.some(
        yield* decodeAddress(address).pipe(
          Effect.mapError(boundaryError("resolveNameServiceAddress"))
        )
      )
    }
  )

  const defaultNameServiceNameOption = Effect.fn("Sui.defaultNameServiceNameOption")(function*(
    address: SuiAddress
  ): Effect.fn.Return<Option.Option<string>, TransportError> {
    return yield* core.defaultNameServiceName({ address }).pipe(
      Effect.map(({ data }) => Option.fromNullishOr(data.name)),
      // `@mysten/sui` before 2.33.2 threw the node's `NOT_FOUND` for an address
      // with no name instead of answering `null`.
      Effect.catchIf(
        (error: TransportError) => error.status === "NOT_FOUND" || noNameService(error),
        () => Effect.succeed(Option.none<string>())
      )
    )
  })

  const toTransaction = (
    input: Recipe | Transaction | Uint8Array,
    sender?: SuiAddress
  ): Effect.Effect<Transaction | Uint8Array, BuildError> => {
    if (input instanceof Uint8Array) return Effect.succeed(input)
    return Effect.try({
      try: () => {
        const tx = typeof input === "function" ? new Transaction() : input
        if (typeof input === "function") input(tx)
        // `setSenderIfNotSet`, so a recipe that set its own sender wins. With
        // no sender at all the SDK simulates as the zero address.
        if (sender !== undefined) tx.setSenderIfNotSet(sender)
        return tx
      },
      catch: (cause) => new BuildError({ message: "the recipe threw", cause })
    })
  }

  const simulateRaw = Effect.fnUntraced(function*(
    input: Recipe | Transaction | Uint8Array,
    checksEnabled: boolean,
    sender?: SuiAddress
  ): Effect.fn.Return<
    SuiClientTypes.SimulateTransactionResult<typeof SIMULATE_INCLUDE>,
    SimulationFailed | BuildError | TransportError
  > {
    const transaction = yield* toTransaction(input, sender)
    return yield* core.simulateTransaction({
      transaction,
      include: SIMULATE_INCLUDE,
      checksEnabled
    })
  })

  const simulate = Effect.fn("Sui.simulate")(function*(
    input: Recipe | Transaction | Uint8Array,
    opts?: { readonly sender?: SuiAddress }
  ): Effect.fn.Return<Simulation, SimulationFailed | BuildError | TransportError> {
    return yield* fromSimulationResult(yield* simulateRaw(input, true, opts?.sender))
  })

  const view = Effect.fn("Sui.view")(function*<S, I>(
    input: Recipe | Transaction | Uint8Array,
    schema: Schema.Codec<S, Uint8Array> | BcsType<S, I>,
    opts?: {
      readonly command?: number
      readonly result?: number
      readonly sender?: SuiAddress
    }
  ): Effect.fn.Return<S, SimulationFailed | BuildError | DecodeError | TransportError> {
    // A `BcsType` is a class from `@mysten/bcs` with a `read` function and a
    // `serialize` method; a `Schema.Codec` has neither. The cast on the bridge
    // call is the `T extends Input` constraint `bcs` carries for encoding,
    // which a view never uses: it only ever decodes.
    const codec = isBcsType(schema)
      ? bcsCodec(schema as unknown as BcsType<S, S>)
      : schema
    const simulation = yield* fromSimulationResult(yield* simulateRaw(input, false, opts?.sender))
    const index = opts?.command ?? simulation.commandResults.length - 1
    const command = simulation.commandResults[index]
    if (command === undefined) {
      return yield* new DecodeError({
        kind: "shape",
        issue: `the simulation has no command ${index}`
      })
    }
    const position = opts?.result ?? 0
    const value = command.returnValues[position]
    if (value === undefined) {
      return yield* new DecodeError({
        kind: "shape",
        issue: `command ${index} has no return value ${position}`
      })
    }
    return yield* decodeContent(codec, value.bcs)
  })

  const streamOwnedObjects = (owner: SuiAddress, opts?: { readonly type?: StructTag | string }) =>
    paginated("Sui.streamOwnedObjects", (cursor) =>
      core
        .listOwnedObjects({
          owner,
          include: OBJECT_INCLUDE,
          ...(opts?.type === undefined ? {} : { type: opts.type }),
          ...(cursor === null ? {} : { cursor })
        })
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(
              Effect.forEach(response.objects, (object) => decodeObject<Uint8Array>(object)),
              (objects): RawPage<SuiObject<Uint8Array>> => ({
                items: objects as ReadonlyArray<SuiObject<Uint8Array>>,
                hasNextPage: response.hasNextPage,
                endCursor: response.cursor
              })
            )
          ),
          Effect.catchTag("DecodeError", (error) =>
            Effect.fail(decodeAsTransport("listOwnedObjects")(error)))
        ))

  const streamDynamicFields = (parent: ObjectId) =>
    paginated("Sui.streamDynamicFields", (cursor) =>
      core
        .listDynamicFields({ parentId: parent, ...(cursor === null ? {} : { cursor }) })
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(
              Effect.forEach(response.dynamicFields, (field) =>
                decodeDynamicFieldEntry(field).pipe(
                  Effect.mapError(boundaryError("listDynamicFields"))
                )),
              (fields): RawPage<DynamicFieldEntry> => ({
                items: fields,
                hasNextPage: response.hasNextPage,
                endCursor: response.cursor
              })
            )
          )
        ))

  const streamBalances = (owner: SuiAddress) =>
    paginated("Sui.streamBalances", (cursor) =>
      core.listBalances({ owner, ...(cursor === null ? {} : { cursor }) }).pipe(
        Effect.flatMap((response) =>
          Effect.map(
            Effect.forEach(response.balances, (balance) =>
              decodeBalance(balance).pipe(Effect.mapError(boundaryError("listBalances")))),
            (balances): RawPage<Balance> => ({
              items: balances,
              hasNextPage: response.hasNextPage,
                endCursor: response.cursor
            })
          )
        )
      ))

  const streamCoins = (owner: SuiAddress, coinType?: CoinType | string) =>
    paginated("Sui.streamCoins", (cursor) =>
      core
        .listCoins({
          owner,
          ...(coinType === undefined ? {} : { coinType }),
          ...(cursor === null ? {} : { cursor })
        })
        .pipe(
          Effect.flatMap((response) =>
            Effect.map(
              Effect.forEach(response.objects, (coin) =>
                decodeCoin(coin).pipe(Effect.mapError(boundaryError("listCoins")))),
              (coins): RawPage<Coin> => ({
                items: coins,
                hasNextPage: response.hasNextPage,
                endCursor: response.cursor
              })
            )
          )
        ))

  /**
   * The SDK's ledger cursors: continue an ascending read with `after` and a
   * descending one with `before`, both set to the last page's `endCursor`.
   * `before` alone implies descending, as it does in the SDK.
   */
  const directionOf = (opts: ListOptions | undefined): ListOrder =>
    opts?.order ?? (opts?.before !== undefined && opts.before !== null ? "descending" : "ascending")
  const startOf = (opts: ListOptions | undefined): string | null =>
    (directionOf(opts) === "descending" ? opts?.before : opts?.after) ?? null
  const ledgerCursor = (order: ListOrder, cursor: string | null) =>
    cursor === null ? { order } : order === "descending" ? { before: cursor } : { after: cursor }

  const eventsPage = (raw: EventFilter | undefined, order: ListOrder) => {
    const filter = raw === undefined ? undefined : normalizeEventFilter(raw)
    return (cursor: string | null): Effect.Effect<RawPage<EventEntry>, TransportError> =>
      core
        .listEvents({
          ...(filter === undefined ? {} : { filter }),
        ...ledgerCursor(order, cursor)
      })
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(
            Effect.forEach(response.events, (event) =>
              decodeEventEntry(event).pipe(Effect.mapError(boundaryError("listEvents")))),
            (events): RawPage<EventEntry> => ({
              items: events,
              hasNextPage: response.hasNextPage,
              endCursor: response.endCursor
            })
          )
        )
      )
  }

  type TransactionItem = Result.Result<Executed, ExecutionFailed>

  const transactionsPage = (filter: TransactionFilter | undefined, order: ListOrder) =>
  (cursor: string | null): Effect.Effect<RawPage<TransactionItem>, TransportError> =>
    core
      .listTransactions({
        ...(filter === undefined ? {} : { filter }),
        ...ledgerCursor(order, cursor),
        include: EXECUTE_INCLUDE
      })
      .pipe(
        Effect.flatMap((response) =>
          Effect.map(
            Effect.forEach(response.transactions, (transaction) =>
              fromTransactionResult(transaction).pipe(
                Effect.map((executed): TransactionItem => Result.succeed(executed)),
                Effect.catchTag("ExecutionFailed", (failed) =>
                  Effect.succeed(Result.fail(failed) as TransactionItem)),
                Effect.catchTag("DecodeError", (error) =>
                  Effect.fail(decodeAsTransport("listTransactions")(error)))
              )),
            (transactions): RawPage<TransactionItem> => ({
              items: transactions,
              hasNextPage: response.hasNextPage,
              endCursor: response.endCursor
            })
          )
        )
      )

  /** The cursor of the newest event on the unfiltered ledger, or `null` when there is none. */
  const eventsHead = core
    .listEvents({ order: "descending", limit: 1 })
    .pipe(Effect.map((response) => response.startCursor ?? null))

  /** The cursor of the newest transaction on the unfiltered ledger, or `null`. */
  const transactionsHead = core
    .listTransactions({ order: "descending", limit: 1 })
    .pipe(Effect.map((response) => response.startCursor ?? null))

  const streamEventPages = (filter?: EventFilter, opts?: ListOptions) =>
    pagesOf("Sui.streamEventPages", startOf(opts), eventsPage(filter, directionOf(opts)))

  const streamEvents = (filter?: EventFilter, opts?: ListOptions) =>
    paginated("Sui.streamEvents", eventsPage(filter, directionOf(opts)), startOf(opts))

  const tailEventPages = (filter?: EventFilter, opts?: TailOptions) =>
    tailOf(
      "Sui.tailEvents",
      opts?.after ?? null,
      opts?.poll ?? DEFAULT_POLL,
      eventsPage(filter, "ascending"),
      filter === undefined ? undefined : eventsHead
    )

  const tailEvents = (filter?: EventFilter, opts?: TailOptions) =>
    tailEventPages(filter, opts).pipe(Stream.map((page) => page.items), Stream.flattenIterable)

  /** A stream that refuses an unpaginable function filter when it is run. */
  const checked = <A, E>(
    span: string,
    filter: TransactionFilter | undefined,
    stream: () => Stream.Stream<A, E>
  ): Stream.Stream<A, E> =>
    Stream.suspend(() => {
      assertPaginableFilter(span, filter)
      return stream()
    })

  const streamTransactionPages = (filter?: TransactionFilter, opts?: ListOptions) =>
    checked("Sui.streamTransactionPages", filter, () =>
      pagesOf(
        "Sui.streamTransactionPages",
        startOf(opts),
        transactionsPage(filter, directionOf(opts))
      ))

  const streamTransactions = (filter?: TransactionFilter, opts?: ListOptions) =>
    checked("Sui.streamTransactions", filter, () =>
      paginated(
        "Sui.streamTransactions",
        transactionsPage(filter, directionOf(opts)),
        startOf(opts)
      ))

  const tailTransactionPages = (filter?: TransactionFilter, opts?: TailOptions) =>
    checked("Sui.tailTransactions", filter, () =>
      tailOf(
        "Sui.tailTransactions",
        opts?.after ?? null,
        opts?.poll ?? DEFAULT_POLL,
        transactionsPage(filter, "ascending"),
        filter === undefined ? undefined : transactionsHead
      ))

  const tailTransactions = (filter?: TransactionFilter, opts?: TailOptions) =>
    tailTransactionPages(filter, opts).pipe(Stream.map((page) => page.items), Stream.flattenIterable)

  const withSenderLock = (address: SuiAddress) =>
    Effect.fn("Sui.withSenderLock")(function*<A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.fn.Return<A, E, R> {
      yield* Effect.annotateCurrentSpan({ "sui.sender": address })
      // The semaphore is reference counted: whoever is inside the lock holds a
      // reference, so a sender's semaphore cannot be dropped while it is in
      // use, and an idle one is released a minute after the last holder leaves
      // rather than sitting in the map for the life of the process. A service
      // that sponsors thousands of addresses therefore holds entries for the
      // senders it is actually working for, not for every sender it has ever
      // seen.
      //
      // The time spent queued for the permit is `sui_effect_sender_lock_wait`,
      // measured from asking for the semaphore to holding the permit; the
      // sender is deliberately not an attribute.
      const asked = yield* Clock.currentTimeMillis
      const held = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => Metrics.recordDuration(Metrics.senderLockWait, Duration.millis(now - asked)))
      )
      return yield* Effect.scoped(
        Effect.flatMap(
          RcMap.get(locks, address),
          (semaphore) => Semaphore.withPermit(semaphore, Effect.andThen(held, effect))
        )
      )
    })

  const chainTime = core
    .getObject({ objectId: SUI_CLOCK_OBJECT_ID, include: OBJECT_INCLUDE })
    .pipe(
      Effect.flatMap(({ object }) => decodeContent(clockCodec, object.content)),
      Effect.flatMap((clock) =>
        Effect.fromOption(DateTime.make(Number(clock.timestamp_ms))).pipe(
          Effect.mapError(
            () =>
              new DecodeError({
                expectedType: CLOCK_TYPE,
                kind: "shape",
                issue: `the clock reported ${clock.timestamp_ms}, which is not a time`
              })
          )
        )
      ),
      Effect.catchTag(
        ["ObjectNotFound", "ObjectDeleted", "ObjectUnavailable", "DecodeError"],
        (error) =>
          Effect.fail(
            new TransportError({
              method: "chainTime",
              retryable: false,
              cause: error
            })
          )
      ),
      Effect.withSpan("Sui.chainTime")
    )

  return {
    network: core.network,
    core,
    chainId,
    chainTime,
    getObject: getObject as SuiService["getObject"],
    getObjectOption: getObjectOption as SuiService["getObjectOption"],
    getObjects: getObjects as SuiService["getObjects"],
    getObjectsStrict: getObjectsStrict as SuiService["getObjectsStrict"],
    getBalance,
    streamBalances,
    streamCoins,
    getCoinMetadataOption,
    resolveNameServiceAddressOption,
    defaultNameServiceNameOption,
    getDynamicFieldOption: getDynamicFieldOption as SuiService["getDynamicFieldOption"],
    getDynamicObjectFieldOption: getDynamicObjectFieldOption as SuiService[
      "getDynamicObjectFieldOption"
    ],
    getTransaction,
    simulate,
    view,
    streamOwnedObjects,
    streamDynamicFields,
    streamEvents,
    streamEventPages,
    tailEvents,
    tailEventPages,
    streamTransactions,
    streamTransactionPages,
    tailTransactions,
    tailTransactionPages,
    withSenderLock
  }
}

/**
 * The node has no SuiNS for this network: `UNIMPLEMENTED`, which a localnet
 * answers to every name-service call. Never fails.
 */
const noNameService = (error: TransportError): boolean => error.status === "UNIMPLEMENTED"

const mapObjectItemError = (id: ObjectId, error: Error): BatchItemError => {
  const reason = (error as { readonly reason?: unknown }).reason
  if (reason === "deleted") return new ObjectDeleted({ objectId: id })
  if (reason === "notFound") return new ObjectNotFound({ objectId: id })
  return new ObjectUnavailable({ objectId: id })
}

/** Options for {@link Sui.layerNoDepsWith}. */
export interface SuiLayerOptions {
  /**
   * The chain identifier this program expects, as `getChainIdentifier` returns
   * it. When set, a layer over a node on another chain fails to build, and it
   * overrides the {@link KNOWN_CHAIN_IDS} entry for the client's network.
   *
   * Leave it unset for `mainnet` and `testnet`: their chain identifiers are in
   * the table and are asserted by default. `devnet`, `localnet` and any custom
   * network are regenerated, so set this when the program must pin one.
   */
  readonly chainId?: string
  /**
   * How to retry the one `getChainIdentifier` this layer makes, when it fails
   * with a **retryable** `TransportError`.
   *
   * It matters more than one round trip usually would, because of what holds
   * the result: a `ManagedRuntime` — which is how a browser app, a Worker or a
   * Durable Object keeps one runtime per isolate — **memoizes the layer build,
   * failure included, for its whole lifetime**. One unlucky request at boot and
   * every later use of that runtime fails with the same stale
   * `TransportError`, until something disposes it. A short schedule here is the
   * cheap half of the cure; disposing the runtime when its build failed is the
   * other half (see the guide's "Application consumers" section), and
   * `layerNoDepsPinned` avoids the read altogether when the chain id is already
   * known.
   *
   * Unset, the read is made once, as it always was.
   *
   * @since 0.1.2
   */
  readonly retry?: Schedule.Schedule<unknown, TransportError>
}

/**
 * The opinionated tier.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Sui } from "@unconfirmed/sui-effect"
 *
 * const time = Effect.gen(function*() {
 *   const sui = yield* Sui
 *   return yield* sui.chainTime
 * })
 * ```
 */
export class Sui extends Context.Service<Sui, SuiService>()("@unconfirmed/sui-effect/Sui") {
  /**
   * Like {@link layerNoDeps}, but refuses to build when the node reports a
   * different chain identifier than `options.chainId`, whatever the network.
   *
   * Fails with: `NetworkMismatch`, `TransportError`.
   */
  static readonly layerNoDepsWith = (
    options: SuiLayerOptions
  ): Layer.Layer<Sui, NetworkMismatch | TransportError, SuiCore> =>
    Layer.effect(
      Sui,
      Effect.gen(function*() {
        const core = yield* SuiCore
        const read = core.getChainIdentifier()
        const { chainIdentifier } = yield* (options.retry === undefined
          ? read
          : read.pipe(
            Effect.retry({
              schedule: options.retry,
              while: (error: TransportError) => error.retryable
            })
          ))
        const expected = options.chainId ?? KNOWN_CHAIN_IDS[core.network]
        if (expected !== undefined && expected !== chainIdentifier) {
          return yield* new NetworkMismatch({ expected, actual: chainIdentifier })
        }
        const locks = yield* makeSenderLocks
        return makeSui(core, chainIdentifier, locks)
      })
    )

  /**
   * `Sui` over whatever `SuiCore` is provided, **without reading the chain
   * identifier**: the one given is taken as the chain's.
   *
   * This exists for one caller: `SuiExtension.fromService` with `warm`, which
   * builds its runtime synchronously inside `register` and therefore cannot
   * await a `getChainIdentifier` round trip. Nothing is asserted, because
   * nothing is asked — a node on another chain is not detected here. What still
   * protects a warm registration is the chain itself: `Tx.build` stamps this id
   * on the transaction's `ValidDuring` expiration, and a validator refuses
   * bytes signed for another chain.
   *
   * Prefer {@link layerNoDeps}, which asks. Never fails.
   */
  static readonly layerNoDepsPinned = (chainId: string): Layer.Layer<Sui, never, SuiCore> =>
    Layer.effect(
      Sui,
      Effect.gen(function*() {
        const core = yield* SuiCore
        const locks = yield* makeSenderLocks
        return makeSui(core, chainId, locks)
      })
    )

  /**
   * Builds `Sui` over whatever `SuiCore` is provided, reading the chain
   * identifier once.
   *
   * When the client's network is one of the entries in {@link KNOWN_CHAIN_IDS}
   * (`mainnet`, `testnet`) the identifier the node reports must match it, so a
   * program pointed at the wrong node fails at layer build rather than reading
   * the wrong chain. `devnet`, `localnet` and custom networks have no fixed
   * identifier: the observed one is recorded on `Sui.chainId` and nothing is
   * asserted unless {@link layerNoDepsWith} is given a `chainId`.
   *
   * Fails with: `NetworkMismatch`, `TransportError`.
   */
  static readonly layerNoDeps: Layer.Layer<Sui, NetworkMismatch | TransportError, SuiCore> =
    Sui.layerNoDepsWith({})

  /**
   * `layerNoDeps` over a gRPC `SuiCore`.
   *
   * Fails with: `NetworkMismatch`, `TransportError`.
   */
  static readonly layer = (
    options: SuiGrpcLayerOptions & SuiLayerOptions
  ): Layer.Layer<Sui, NetworkMismatch | TransportError> =>
    Sui.layerNoDepsWith(options).pipe(Layer.provide(SuiCore.layerGrpc(options)))

  /**
   * `layerNoDeps` over `SuiCore.layerConfig`.
   *
   * Fails with: `ConfigError`, `NetworkMismatch`, `TransportError`.
   */
  static readonly layerConfig: Layer.Layer<
    Sui,
    Config.ConfigError | NetworkMismatch | TransportError
  > = Sui.layerNoDeps.pipe(Layer.provide(SuiCore.layerConfig))
}
