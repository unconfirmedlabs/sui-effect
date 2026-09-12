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
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  RcMap,
  Result,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { bcs as bcsCodec, decodeContent, typeMatches } from "../domain/bcs.ts"
import {
  BuildError,
  DecodeError,
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
import {
  Balance,
  CoinType,
  Digest,
  DynamicField,
  DynamicFieldEntry,
  DynamicFieldName,
  executionReasonOf,
  KNOWN_CHAIN_IDS,
  makeSuiObject,
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

const boundaryError = (method: string) => (issue: { readonly message: string }): TransportError =>
  new TransportError({
    method,
    retryable: false,
    cause: `the node returned a response this version cannot read: ${issue.message}`
  })

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
   */
  readonly getObjectsOrFail: {
    <S>(
      ids: ReadonlyArray<ObjectId>,
      opts: { readonly schema: Schema.Codec<S, Uint8Array>; readonly expectedType?: string }
    ): Effect.Effect<ReadonlyArray<SuiObject<S>>, BatchItemError | TransportError>
    (
      ids: ReadonlyArray<ObjectId>,
      opts?: { readonly schema?: undefined; readonly expectedType?: string }
    ): Effect.Effect<ReadonlyArray<SuiObject<Uint8Array>>, BatchItemError | TransportError>
  }

  /** The balance of one coin type for one owner. Fails with: `TransportError`. */
  readonly getBalance: (
    owner: SuiAddress,
    coinType?: CoinType
  ) => Effect.Effect<Balance, TransportError>

  /**
   * Reads one dynamic field; absence is `None`.
   *
   * Fails with: `TransportError`.
   */
  readonly getDynamicFieldOption: (
    parent: ObjectId,
    name: DynamicFieldName
  ) => Effect.Effect<Option.Option<DynamicField>, TransportError>

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
   * The codec may be a bare `@mysten/bcs` `BcsType` — `bcs.Address()`,
   * `bcs.vector(bcs.u64())` — because a Move **return value** has no struct tag
   * to check it against. A `SuiSchema.bcs` codec works too, and so does one
   * composed with `Schema.decodeTo(DomainClass, …)`; no type tag is compared
   * either way.
   *
   * `opts.sender` is the address the call is simulated as, defaulting to the
   * zero address the way the SDK does; a recipe that sets its own sender wins.
   *
   * Fails with: `SimulationFailed`, `BuildError`, `DecodeError`, `TransportError`.
   */
  readonly view: <S, I>(
    recipe: Recipe,
    schema: Schema.Codec<S, Uint8Array> | BcsType<S, I>,
    opts?: {
      readonly command?: number
      readonly result?: number
      readonly sender?: SuiAddress
    }
  ) => Effect.Effect<S, SimulationFailed | BuildError | DecodeError | TransportError>

  /** Every object an address owns, paginated. Fails with: `TransportError`. */
  readonly streamOwnedObjects: (
    owner: SuiAddress,
    opts?: { readonly type?: StructTag }
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
   * Serializes work for one sender, so two transactions from the same address
   * cannot pick the same gas coin. Adds no failures of its own.
   */
  readonly withSenderLock: (
    address: SuiAddress
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/** How long an unused sender lock is kept before it is released. */
const SENDER_LOCK_TTL = "1 minute"

const CHUNK = 50

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

  const decodeObject = Effect.fn("Sui.decodeObject")(function*<S>(
    object: SuiClientTypes.Object<typeof OBJECT_INCLUDE>,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<SuiObject<S | Uint8Array>, DecodeError | TransportError> {
    const envelope = yield* envelopeOf(object)
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
          issue: `object ${envelope.objectId} has type ${envelope.type}`
        })
      }
      return makeSuiObject(envelope, object.content)
    }
    // One rule for every Move type check in the library: `typeMatches` inside
    // `decodeContent`, which accepts a bare tag as every instantiation of it
    // and compares a parameterized one in full.
    const content = yield* decodeContent(schema, object.content, {
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

  const chunk = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
    const chunks: Array<ReadonlyArray<A>> = []
    for (let index = 0; index < items.length; index += CHUNK) {
      chunks.push(items.slice(index, index + CHUNK))
    }
    return chunks
  }

  const getObjects = Effect.fn("Sui.getObjects")(function*<S>(
    ids: ReadonlyArray<ObjectId>,
    opts?: ReadOptions<S>
  ): Effect.fn.Return<
    ReadonlyArray<Result.Result<SuiObject<S | Uint8Array>, BatchItemError>>,
    TransportError
  > {
    type Item = Result.Result<SuiObject<S | Uint8Array>, BatchItemError>
    const unique: Array<ObjectId> = []
    const requested = new Set<string>()
    for (const id of ids) {
      const key = keyOf(id)
      if (requested.has(key)) continue
      requested.add(key)
      unique.push(id)
    }
    const answers = new Map<string, Item>()
    for (const page of chunk(unique)) {
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
          answers.set(keyOf(id), Result.fail(mapObjectItemError(id, item)))
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
          answers.set(keyOf(id), Result.fail(decoded.failure))
          continue
        }
        answers.set(keyOf(id), Result.succeed(decoded.success))
      }
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

  const getObjectsOrFail = Effect.fn("Sui.getObjectsOrFail")(function*<S>(
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
    coinType?: CoinType
  ): Effect.fn.Return<Balance, TransportError> {
    const { balance } = yield* core.getBalance({
      owner,
      ...(coinType === undefined ? {} : { coinType })
    })
    return yield* decodeBalance(balance).pipe(Effect.mapError(boundaryError("getBalance")))
  })

  const getDynamicFieldOption = Effect.fn("Sui.getDynamicFieldOption")(function*(
    parent: ObjectId,
    name: DynamicFieldName
  ): Effect.fn.Return<Option.Option<DynamicField>, TransportError> {
    return yield* core.getDynamicField({ parentId: parent, name }).pipe(
      Effect.flatMap(({ dynamicField }) =>
        decodeDynamicField(dynamicField).pipe(
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
  })

  const getTransaction = Effect.fn("Sui.getTransaction")(function*(
    digest: Digest
  ): Effect.fn.Return<Executed, ExecutionFailed | TransactionNotFound | TransportError> {
    return yield* core.getTransaction({ digest, include: EXECUTE_INCLUDE }).pipe(
      Effect.flatMap(fromTransactionResult),
      Effect.catchTag("DecodeError", (error) =>
        Effect.fail(
          new TransportError({ method: "getTransaction", retryable: false, cause: error })
        ))
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

  const simulateRaw = Effect.fn("Sui.simulateRaw")(function*(
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

  const toSimulation = Effect.fn("Sui.toSimulation")(function*(
    result: SuiClientTypes.SimulateTransactionResult<typeof SIMULATE_INCLUDE>
  ): Effect.fn.Return<Simulation, SimulationFailed | TransportError> {
    if (result.$kind === "FailedTransaction") {
      const status = result.FailedTransaction.status
      if (status.success) {
        return yield* new TransportError({
          method: "simulateTransaction",
          retryable: false,
          cause: "the node reported a failed transaction whose status says it succeeded"
        })
      }
      return yield* new SimulationFailed({
        reason: executionReasonOf(status.error),
        message: status.error.message
      })
    }
    const transaction = result.Transaction
    return yield* decodeSimulation({
      digest: transaction.digest,
      effects: transaction.effects,
      events: transaction.events,
      balanceChanges: transaction.balanceChanges,
      objectTypes: transaction.objectTypes,
      commandResults: result.commandResults
    }).pipe(Effect.mapError(boundaryError("simulateTransaction")))
  })

  const simulate = Effect.fn("Sui.simulate")(function*(
    input: Recipe | Transaction | Uint8Array,
    opts?: { readonly sender?: SuiAddress }
  ): Effect.fn.Return<Simulation, SimulationFailed | BuildError | TransportError> {
    return yield* toSimulation(yield* simulateRaw(input, true, opts?.sender))
  })

  const view = Effect.fn("Sui.view")(function*<S, I>(
    recipe: Recipe,
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
    const simulation = yield* toSimulation(yield* simulateRaw(recipe, false, opts?.sender))
    const index = opts?.command ?? simulation.commandResults.length - 1
    const command = simulation.commandResults[index]
    if (command === undefined) {
      return yield* new DecodeError({ issue: `the simulation has no command ${index}` })
    }
    const position = opts?.result ?? 0
    const value = command.returnValues[position]
    if (value === undefined) {
      return yield* new DecodeError({
        issue: `command ${index} has no return value ${position}`
      })
    }
    return yield* decodeContent(codec, value.bcs)
  })

  const streamOwnedObjects = (owner: SuiAddress, opts?: { readonly type?: StructTag }) =>
    Stream.paginate(null as string | null, (cursor: string | null) =>
      core
        .listOwnedObjects({
          owner,
          include: OBJECT_INCLUDE,
          ...(opts?.type === undefined ? {} : { type: opts.type }),
          ...(cursor === null ? {} : { cursor })
        })
        .pipe(
          Effect.flatMap((response) =>
            Effect.forEach(response.objects, (object) => decodeObject<Uint8Array>(object)).pipe(
              Effect.map((objects) =>
                [
                  objects as ReadonlyArray<SuiObject<Uint8Array>>,
                  response.hasNextPage && response.cursor !== null
                    ? Option.some<string | null>(response.cursor)
                    : Option.none<string | null>()
                ] as const
              )
            )
          ),
          Effect.catchTag("DecodeError", (error) =>
            Effect.fail(
              new TransportError({ method: "listOwnedObjects", retryable: false, cause: error })
            ))
        )).pipe(Stream.withSpan("Sui.streamOwnedObjects"))

  const streamDynamicFields = (parent: ObjectId) =>
    Stream.paginate(null as string | null, (cursor: string | null) =>
      core
        .listDynamicFields({
          parentId: parent,
          ...(cursor === null ? {} : { cursor })
        })
        .pipe(
          Effect.flatMap((response) =>
            Effect.forEach(response.dynamicFields, (field) =>
              decodeDynamicFieldEntry(field).pipe(
                Effect.mapError(boundaryError("listDynamicFields"))
              )).pipe(
                Effect.map((fields) =>
                  [
                    fields,
                    response.hasNextPage && response.cursor !== null
                      ? Option.some<string | null>(response.cursor)
                      : Option.none<string | null>()
                  ] as const
                )
              )
          )
        )).pipe(Stream.withSpan("Sui.streamDynamicFields"))

  const withSenderLock = (address: SuiAddress) =>
    Effect.fn("Sui.withSenderLock")(function*<A, E, R>(
      effect: Effect.Effect<A, E, R>
    ): Effect.fn.Return<A, E, R> {
      // The semaphore is reference counted: whoever is inside the lock holds a
      // reference, so a sender's semaphore cannot be dropped while it is in
      // use, and an idle one is released a minute after the last holder leaves
      // rather than sitting in the map for the life of the process. A service
      // that sponsors thousands of addresses therefore holds entries for the
      // senders it is actually working for, not for every sender it has ever
      // seen.
      return yield* Effect.scoped(
        Effect.flatMap(
          RcMap.get(locks, address),
          (semaphore) => Semaphore.withPermits(semaphore, 1)(effect)
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
    getObjectsOrFail: getObjectsOrFail as SuiService["getObjectsOrFail"],
    getBalance,
    getDynamicFieldOption,
    getTransaction,
    simulate,
    view,
    streamOwnedObjects,
    streamDynamicFields,
    withSenderLock
  }
}

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
        const { chainIdentifier } = yield* core.getChainIdentifier()
        const expected = options.chainId ?? KNOWN_CHAIN_IDS[core.network]
        if (expected !== undefined && expected !== chainIdentifier) {
          return yield* new NetworkMismatch({ expected, actual: chainIdentifier })
        }
        const locks = yield* RcMap.make({
          lookup: (_address: string) => Effect.succeed(Semaphore.makeUnsafe(1)),
          idleTimeToLive: SENDER_LOCK_TTL
        })
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
        const locks = yield* RcMap.make({
          lookup: (_address: string) => Effect.succeed(Semaphore.makeUnsafe(1)),
          idleTimeToLive: SENDER_LOCK_TTL
        })
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
