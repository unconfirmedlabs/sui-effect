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
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Transaction } from "@mysten/sui/transactions"
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import {
  Config,
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream
} from "effect"
import { bcs as bcsCodec, decodeContent, expectedTypeOf, typeMatches } from "../domain/bcs.ts"
import {
  BuildError,
  DecodeError,
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
   * Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`,
   * `DecodeError`, `TransportError`.
   */
  readonly getObject: {
    <S>(
      id: ObjectId,
      opts: { readonly schema: Schema.Codec<S, Uint8Array> }
    ): Effect.Effect<SuiObject<S>, GetObjectError>
    (id: ObjectId, opts?: { readonly schema?: undefined }): Effect.Effect<
      SuiObject<Uint8Array>,
      GetObjectError
    >
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
      opts: { readonly schema: Schema.Codec<S, Uint8Array> }
    ): Effect.Effect<
      Option.Option<SuiObject<S>>,
      ObjectUnavailable | DecodeError | TransportError
    >
    (id: ObjectId, opts?: { readonly schema?: undefined }): Effect.Effect<
      Option.Option<SuiObject<Uint8Array>>,
      ObjectUnavailable | DecodeError | TransportError
    >
  }

  /**
   * Reads many objects, chunked by 50, checking that the node answered for each
   * requested id exactly once. Per-object failures are `Result` values.
   *
   * Fails with: `TransportError`.
   */
  readonly getObjects: {
    <S>(
      ids: ReadonlyArray<ObjectId>,
      opts: { readonly schema: Schema.Codec<S, Uint8Array> }
    ): Effect.Effect<ReadonlyArray<Result.Result<SuiObject<S>, BatchItemError>>, TransportError>
    (
      ids: ReadonlyArray<ObjectId>,
      opts?: { readonly schema?: undefined }
    ): Effect.Effect<
      ReadonlyArray<Result.Result<SuiObject<Uint8Array>, BatchItemError>>,
      TransportError
    >
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
  ) => Effect.Effect<
    Executed,
    import("../domain/errors.ts").ExecutionFailed | TransactionNotFound | TransportError
  >

  /**
   * Simulates a transaction with the fixed simulate include set.
   *
   * Fails with: `SimulationFailed`, `BuildError`, `TransportError`.
   */
  readonly simulate: (
    input: Recipe | Transaction | Uint8Array
  ) => Effect.Effect<Simulation, SimulationFailed | BuildError | TransportError>

  /**
   * Reads a Move return value without executing: simulates with checks disabled
   * and decodes return value `result` (default 0) of command `command`
   * (default the last command).
   *
   * Fails with: `SimulationFailed`, `BuildError`, `DecodeError`, `TransportError`.
   */
  readonly view: <S>(
    recipe: Recipe,
    schema: Schema.Codec<S, Uint8Array>,
    opts?: { readonly command?: number; readonly result?: number }
  ) => Effect.Effect<S, SimulationFailed | BuildError | DecodeError | TransportError>

  /** Every object an address owns, paginated. Fails with: `TransportError`. */
  readonly streamOwnedObjects: (
    owner: SuiAddress,
    opts?: { readonly type?: StructTag }
  ) => Stream.Stream<SuiObject<Uint8Array>, TransportError>

  /** Every dynamic field of a parent, paginated. Fails with: `TransportError`. */
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

const CHUNK = 50

const makeSui = (
  core: SuiCore["Service"],
  chainId: string,
  locks: Ref.Ref<ReadonlyMap<string, Semaphore.Semaphore>>
): SuiService => {
  const envelopeOf = (object: SuiClientTypes.Object<typeof OBJECT_INCLUDE>) =>
    decodeEnvelope(object).pipe(Effect.mapError(boundaryError("getObject")))

  const decodeObject = <S>(
    object: SuiClientTypes.Object<typeof OBJECT_INCLUDE>,
    schema?: Schema.Codec<S, Uint8Array>
  ): Effect.Effect<SuiObject<S | Uint8Array>, DecodeError | TransportError> =>
    Effect.gen(function*() {
      const envelope = yield* envelopeOf(object)
      if (schema === undefined) return makeSuiObject(envelope, object.content)
      const expected = expectedTypeOf(schema)
      if (expected !== undefined && !typeMatches(expected, envelope.type)) {
        return yield* new DecodeError({
          objectId: envelope.objectId,
          expectedType: expected,
          issue: `object ${envelope.objectId} has type ${envelope.type}`
        })
      }
      const content = yield* decodeContent(schema, object.content, {
        objectId: envelope.objectId,
        expectedType: envelope.type
      })
      return makeSuiObject(envelope, content)
    })

  const getObject = <S>(id: ObjectId, opts?: { readonly schema?: Schema.Codec<S, Uint8Array> }) =>
    core
      .getObject({ objectId: id, include: OBJECT_INCLUDE })
      .pipe(
        Effect.flatMap(({ object }) => decodeObject(object, opts?.schema)),
        Effect.withSpan("Sui.getObject")
      )

  const getObjectOption = <S>(
    id: ObjectId,
    opts?: { readonly schema?: Schema.Codec<S, Uint8Array> }
  ) =>
    getObject(id, opts).pipe(
      Effect.map(Option.some),
      Effect.catchTag(["ObjectNotFound", "ObjectDeleted"], () =>
        Effect.succeed(Option.none<SuiObject<S | Uint8Array>>())),
      Effect.withSpan("Sui.getObjectOption")
    )

  const chunk = <A>(items: ReadonlyArray<A>): ReadonlyArray<ReadonlyArray<A>> => {
    const chunks: Array<ReadonlyArray<A>> = []
    for (let index = 0; index < items.length; index += CHUNK) {
      chunks.push(items.slice(index, index + CHUNK))
    }
    return chunks
  }

  const getObjects = <S>(
    ids: ReadonlyArray<ObjectId>,
    opts?: { readonly schema?: Schema.Codec<S, Uint8Array> }
  ) =>
    Effect.gen(function*() {
      const results: Array<Result.Result<SuiObject<S | Uint8Array>, BatchItemError>> = []
      for (const page of chunk(ids)) {
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
        const seen = new Set<string>()
        for (let index = 0; index < page.length; index += 1) {
          const requested = page[index] as ObjectId
          if (seen.has(requested)) {
            return yield* new TransportError({
              method: "getObjects",
              retryable: false,
              cause: `duplicate object id ${requested} in the request`
            })
          }
          seen.add(requested)
          const item = response.objects[index]
          if (item === undefined) {
            return yield* new TransportError({
              method: "getObjects",
              retryable: false,
              cause: `the node returned no entry for ${requested}`
            })
          }
          if (item instanceof Error) {
            const mapped = mapObjectItemError(requested, item)
            results.push(Result.fail(mapped))
            continue
          }
          if (item.objectId !== requested) {
            return yield* new TransportError({
              method: "getObjects",
              retryable: false,
              cause: `asked for ${requested} and the node answered for ${item.objectId}`
            })
          }
          const decoded = yield* Effect.result(decodeObject(item, opts?.schema))
          if (Result.isFailure(decoded)) {
            if (decoded.failure._tag === "TransportError") return yield* decoded.failure
            results.push(Result.fail(decoded.failure))
            continue
          }
          results.push(Result.succeed(decoded.success))
        }
      }
      return results as ReadonlyArray<Result.Result<SuiObject<S | Uint8Array>, BatchItemError>>
    }).pipe(Effect.withSpan("Sui.getObjects"))

  const getBalance = (owner: SuiAddress, coinType?: CoinType) =>
    core
      .getBalance({ owner, ...(coinType === undefined ? {} : { coinType }) })
      .pipe(
        Effect.flatMap(({ balance }) =>
          decodeBalance(balance).pipe(Effect.mapError(boundaryError("getBalance")))
        ),
        Effect.withSpan("Sui.getBalance")
      )

  const getDynamicFieldOption = (parent: ObjectId, name: DynamicFieldName) =>
    core
      .getDynamicField({ parentId: parent, name })
      .pipe(
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
            new TransportError({
              method: "getDynamicField",
              retryable: false,
              cause: error
            })
          )),
        Effect.withSpan("Sui.getDynamicFieldOption")
      )

  const getTransaction = (digest: Digest) =>
    core
      .getTransaction({ digest, include: EXECUTE_INCLUDE })
      .pipe(
        Effect.flatMap(fromTransactionResult),
        Effect.catchTag("DecodeError", (error) =>
          Effect.fail(
            new TransportError({ method: "getTransaction", retryable: false, cause: error })
          )),
        Effect.withSpan("Sui.getTransaction")
      )

  const toTransaction = (
    input: Recipe | Transaction | Uint8Array
  ): Effect.Effect<Transaction | Uint8Array, BuildError> => {
    if (input instanceof Uint8Array) return Effect.succeed(input)
    if (typeof input !== "function") return Effect.succeed(input)
    return Effect.try({
      try: () => {
        const tx = new Transaction()
        input(tx)
        return tx
      },
      catch: (cause) => new BuildError({ message: "the recipe threw", cause })
    })
  }

  const simulateRaw = (
    input: Recipe | Transaction | Uint8Array,
    checksEnabled: boolean
  ): Effect.Effect<
    SuiClientTypes.SimulateTransactionResult<typeof SIMULATE_INCLUDE>,
    SimulationFailed | BuildError | TransportError
  > =>
    toTransaction(input).pipe(
      Effect.flatMap((transaction) =>
        core.simulateTransaction({ transaction, include: SIMULATE_INCLUDE, checksEnabled })
      )
    )

  const toSimulation = (
    result: SuiClientTypes.SimulateTransactionResult<typeof SIMULATE_INCLUDE>
  ): Effect.Effect<Simulation, SimulationFailed | TransportError> =>
    Effect.gen(function*() {
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

  const simulate = (input: Recipe | Transaction | Uint8Array) =>
    simulateRaw(input, true).pipe(
      Effect.flatMap(toSimulation),
      Effect.withSpan("Sui.simulate")
    )

  const view = <S>(
    recipe: Recipe,
    schema: Schema.Codec<S, Uint8Array>,
    opts?: { readonly command?: number; readonly result?: number }
  ) =>
    simulateRaw(recipe, false).pipe(
      Effect.flatMap(toSimulation),
      Effect.flatMap((simulation) => {
        const index = opts?.command ?? simulation.commandResults.length - 1
        const command = simulation.commandResults[index]
        if (command === undefined) {
          return Effect.fail(
            new DecodeError({ issue: `the simulation has no command ${index}` })
          )
        }
        const position = opts?.result ?? 0
        const value = command.returnValues[position]
        if (value === undefined) {
          return Effect.fail(
            new DecodeError({
              issue: `command ${index} has no return value ${position}`
            })
          )
        }
        return decodeContent(schema, value.bcs)
      }),
      Effect.withSpan("Sui.view")
    )

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
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function*() {
      const semaphore = yield* Ref.modify(locks, (current) => {
        const existing = current.get(address)
        if (existing !== undefined) return [existing, current] as const
        const created = Semaphore.makeUnsafe(1)
        const next = new Map(current)
        next.set(address, created)
        return [created, next as ReadonlyMap<string, Semaphore.Semaphore>] as const
      })
      return yield* Semaphore.withPermits(semaphore, 1)(effect)
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
    chainId,
    chainTime,
    getObject: getObject as SuiService["getObject"],
    getObjectOption: getObjectOption as SuiService["getObjectOption"],
    getObjects: getObjects as SuiService["getObjects"],
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
   * it. When set, a layer over a node on another chain fails to build.
   */
  readonly chainId?: string
}

/**
 * The opinionated tier.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Sui } from "sui-effect"
 *
 * const time = Effect.gen(function*() {
 *   const sui = yield* Sui
 *   return yield* sui.chainTime
 * })
 * ```
 */
export class Sui extends Context.Service<Sui, SuiService>()("sui-effect/Sui") {
  /**
   * Like {@link layerNoDeps}, but refuses to build when the node reports a
   * different chain identifier than the one given.
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
        if (options.chainId !== undefined && options.chainId !== chainIdentifier) {
          return yield* new NetworkMismatch({
            expected: options.chainId,
            actual: chainIdentifier
          })
        }
        const locks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map())
        return makeSui(core, chainIdentifier, locks)
      })
    )

  /**
   * Builds `Sui` over whatever `SuiCore` is provided, reading the chain
   * identifier once and making no assertion about which chain it is.
   *
   * Fails with: `TransportError`.
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
