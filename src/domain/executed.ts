/**
 * `Executed`: a transaction that reached the chain, with accessors that answer
 * the questions the next transaction needs answered.
 *
 * Every accessor returns {@link ChangedRef}s — the object's id plus whatever
 * else the effects actually carried — and ignores accumulator writes
 * (`outputState: "AccumulatorWriteV1"`), which are balance bookkeeping rather
 * than objects. Use {@link objectRefOf} to turn one into the full `ObjectRef`
 * the transaction builder wants, which succeeds exactly when the node reported
 * every field it needs.
 *
 * @since 0.1.0
 */
import type { SuiClientTypes } from "@mysten/sui/client"
import { fromBase64 } from "@mysten/sui/utils"
import { Effect, Schema } from "effect"
import { DecodeError, decodeIssues, ExecutionFailed, UnexpectedEffects } from "./errors.ts"
import {
  BalanceChange,
  ChangedObject,
  CoinType,
  Digest,
  Event,
  executionReasonOf,
  ObjectId,
  ObjectRef,
  ObjectType,
  Owner,
  SuiAddress,
  TransactionEffects,
  Version
} from "./schemas.ts"
import { typeMatches } from "./bcs.ts"

const isAccumulatorWrite = (change: ChangedObject): boolean =>
  change.outputState === "AccumulatorWriteV1"

/**
 * What the effects say about one object a transaction touched.
 *
 * `id` is always there. Everything else is present only when the node reported
 * it: `type` comes from the `objectTypes` join, and the version, digest and
 * owner from the side of the change being read (a deleted object has no output
 * version, and a created one has no input version). Nothing is defaulted, so a
 * caller that needs a full `ObjectRef` for the builder can see what is missing
 * rather than being handed a fabricated version 0.
 */
export interface ChangedRef {
  readonly id: ObjectId
  readonly type?: ObjectType
  readonly version?: Version
  readonly digest?: string
  readonly owner?: Owner
}

/**
 * The full builder reference of a changed object, when the effects carried
 * every field the builder needs. Never fails.
 */
export const objectRefOf = (ref: ChangedRef): ObjectRef | undefined =>
  ref.type === undefined || ref.version === undefined || ref.digest === undefined ||
    ref.owner === undefined
    ? undefined
    : { id: ref.id, type: ref.type, version: ref.version, digest: ref.digest, owner: ref.owner }

/**
 * The shape `Transaction#objectRef` and `Inputs.ObjectRef` want: `objectId`
 * rather than `id`, and a decimal **string** version rather than a `bigint`.
 *
 * sui-effect's own `ObjectRef` carries the branded `id` and a `bigint`
 * `version`, because that is what a domain model wants and what a `Version`
 * check can be run on; the SDK builder wants neither. This is the one
 * conversion, so nobody writes `{ objectId: ref.id, version: String(ref.version) }`
 * by hand and gets the field name wrong.
 *
 * **Only for an address-owned (or immutable) object.** `tx.objectRef` pins a
 * version, which is exactly right for an owned input and exactly wrong for a
 * **shared** object: a shared object is passed with `tx.sharedObjectRef({
 * objectId, initialSharedVersion, mutable })` (the initial shared version lives
 * on `ref.owner.Shared.initialSharedVersion`), and a **receiving** object with
 * `tx.receivingRef(...)`, which takes the same three fields this returns.
 * Passing a shared object by `objectRef` produces bytes a validator rejects.
 *
 * `undefined` when the effects did not carry a version or a digest — a deleted
 * object has no output version, and nothing can be consumed without both.
 * Never fails.
 */
export const sdkRefOf = (ref: ChangedRef | ObjectRef): SdkObjectRef | undefined =>
  ref.version === undefined || ref.digest === undefined
    ? undefined
    : { objectId: ref.id, version: ref.version.toString(), digest: ref.digest }

/** The SDK's own object reference shape, as `Transaction#objectRef` takes it. */
export interface SdkObjectRef {
  readonly objectId: string
  readonly version: string
  readonly digest: string
}

/**
 * A transaction the network executed, built from the fixed execute include set:
 * effects, events, balance changes and object types.
 *
 * **`events` is `ReadonlyArray<Event>`, not `SuiClientTypes.Event[]`.** It is
 * that type minus `json`: `packageId`, `module`, `sender`, `eventType` and
 * `bcs`, with the branded ids this package uses. The SDK's `json` is dropped on
 * purpose — it is the node's own rendering, it is absent on most transports,
 * and the decode a caller wants is `SuiSchema.decode(codec, event.bcs)`, which
 * gives a typed value rather than a shape that changes with the node. Code
 * typed against the SDK's `Event[]` therefore does not accept these; take
 * `ReadonlyArray<Event>` from `@unconfirmed/sui-effect`, or map the fields you
 * need.
 */
export class Executed extends Schema.Class<Executed>("sui-effect/Executed")({
  digest: Digest,
  effects: TransactionEffects,
  events: Schema.Array(Event),
  balanceChanges: Schema.Array(BalanceChange),
  objectTypes: Schema.Record(Schema.String, Schema.String),
  checkpoint: Schema.NullOr(Schema.BigIntFromString),
  timestampMs: Schema.NullOr(Schema.Number)
}) {
  /**
   * The type of a changed object, from the `objectTypes` join. A published
   * package reports the literal `package` rather than a struct tag, so the
   * decode goes through {@link ObjectType}.
   */
  private typeOf(objectId: ObjectId): ObjectType | undefined {
    const type = this.objectTypes[objectId]
    if (type === undefined) return undefined
    const decoded = Schema.decodeUnknownOption(ObjectType)(type)
    return decoded._tag === "Some" ? decoded.value : undefined
  }

  /**
   * Everything the effects actually say about one changed object. Nothing is
   * invented: a field the node did not report stays `undefined`, so a caller
   * that needs a full builder reference can tell the difference between
   * "version 0" and "the node did not say".
   */
  private refOf(change: ChangedObject, side: "input" | "output"): ChangedRef {
    const version = side === "output" ? change.outputVersion : change.inputVersion
    const digest = side === "output" ? change.outputDigest : change.inputDigest
    const owner = side === "output" ? change.outputOwner : change.inputOwner
    const type = this.typeOf(change.objectId)
    return {
      id: change.objectId,
      ...(type === undefined ? {} : { type }),
      ...(version === null ? {} : { version }),
      ...(digest === null ? {} : { digest }),
      ...(owner === null ? {} : { owner })
    }
  }

  private select(
    predicate: (change: ChangedObject) => boolean,
    side: "input" | "output",
    filter?: (ref: ChangedRef) => boolean
  ): ReadonlyArray<ChangedRef> {
    const refs: Array<ChangedRef> = []
    for (const change of this.effects.changedObjects) {
      if (isAccumulatorWrite(change)) continue
      if (!predicate(change)) continue
      const ref = this.refOf(change, side)
      if (filter !== undefined && !filter(ref)) continue
      refs.push(ref)
    }
    return refs
  }

  private static byType(type?: string): ((ref: ChangedRef) => boolean) | undefined {
    if (type === undefined) return undefined
    return (ref) => ref.type !== undefined && typeMatches(type, ref.type)
  }

  /**
   * Objects this transaction created, optionally filtered by Move type
   * (compared with `normalizeStructTag`). Never fails.
   */
  created(type?: string): ReadonlyArray<ChangedRef> {
    return this.select(
      (change) => change.idOperation === "Created" && Executed.wroteAnObject(change),
      "output",
      Executed.byType(type)
    )
  }

  /**
   * Objects this transaction created whose reference satisfies a predicate.
   *
   * The direct replacement for the substring matching every repo hand-rolls
   * (`createdByType("::Receipt")`), without making substring matching the
   * default: `created(type)` still compares normalized struct tags.
   * Never fails.
   */
  createdWhere(predicate: (ref: ChangedRef) => boolean): ReadonlyArray<ChangedRef> {
    return this.select(
      (change) => change.idOperation === "Created" && Executed.wroteAnObject(change),
      "output",
      predicate
    )
  }

  /** Objects this transaction mutated in place, optionally filtered by type. Never fails. */
  mutated(type?: string): ReadonlyArray<ChangedRef> {
    return this.select(
      (change) =>
        change.idOperation === "None" &&
        Executed.wroteAnObject(change) &&
        (change.inputState === "Exists" || change.inputState === "Unknown"),
      "output",
      Executed.byType(type)
    )
  }

  /**
   * Objects this transaction deleted or wrapped. The refs carry the versions the
   * objects had going in, since they have no output version.
   *
   * Two effect shapes land here, because from a caller's side both mean "this
   * object is gone from where it was":
   *
   * - a **delete**, which the node reports as `idOperation: "Deleted"`;
   * - a **wrap**, which has no id operation at all (`"None"`) and shows up only
   *   as an input that existed and an output that does not. {@link wrapped}
   *   returns just those, for a caller that has to tell the two apart — a
   *   wrapped object still exists inside its wrapper and can come back.
   *
   * Never fails.
   */
  deleted(): ReadonlyArray<ChangedRef> {
    return this.select(
      (change) => Executed.isDeleted(change) || Executed.isWrapped(change),
      "input"
    )
  }

  /**
   * Objects this transaction wrapped: they went in existing and came out
   * nonexistent without their id being deleted, which is how the SDK's effects
   * converter represents wrapping. They are a subset of {@link deleted}.
   * Never fails.
   */
  wrapped(): ReadonlyArray<ChangedRef> {
    return this.select(Executed.isWrapped, "input")
  }

  /**
   * Whether this change wrote an object, treating `Unknown` as "the envelope
   * did not say".
   *
   * A node always reports the output state; a reduced envelope from a relay or
   * a sponsor often reports nothing but the id and the id operation, and
   * {@link Executed.fromPartial} leaves what it was not told as `Unknown`
   * rather than inventing `ObjectWrite`. Reading `Unknown` as "not an object
   * write" would make `created()` silently empty for exactly those envelopes.
   */
  private static wroteAnObject(change: ChangedObject): boolean {
    return change.outputState === "ObjectWrite" || change.outputState === "Unknown"
  }

  private static isDeleted(change: ChangedObject): boolean {
    return change.idOperation === "Deleted"
  }

  private static isWrapped(change: ChangedObject): boolean {
    return change.idOperation === "None" && change.inputState === "Exists" &&
      change.outputState === "DoesNotExist"
  }

  /**
   * Packages this transaction published (`PackageWrite` plus `Created`), as
   * full refs like every other accessor. A package's `type` is the literal
   * `package` when the node reports one, and the ref falls back to it when the
   * `objectTypes` join has no entry, so a publish is never silently dropped.
   * Never fails.
   */
  packagesPublished(): ReadonlyArray<ChangedRef> {
    const refs: Array<ChangedRef> = []
    for (const change of this.effects.changedObjects) {
      if (change.outputState !== "PackageWrite" || change.idOperation !== "Created") continue
      const ref = this.refOf(change, "output")
      // gRPC reports the literal `package` as a published package's type, and
      // some nodes omit it from `objectTypes` entirely; a `PackageWrite` is a
      // package either way.
      refs.push(ref.type === undefined ? { ...ref, type: "package" } : ref)
    }
    return refs
  }

  /** The net balance change for one address and coin type, in MIST. Never fails. */
  balanceChange(address: SuiAddress, coinType: CoinType): bigint {
    let total = 0n
    for (const change of this.balanceChanges) {
      if (change.address === address && typeMatches(coinType, change.coinType)) {
        total += change.amount
      }
    }
    return total
  }

  /** Computation plus storage less the storage rebate, in MIST. Can be negative. Never fails. */
  get gasUsedTotal(): bigint {
    const gas = this.effects.gasUsed
    return gas.computationCost + gas.storageCost - gas.storageRebate
  }

  /**
   * An `Executed` from the SDK's own `TransactionResult`, read with
   * {@link EXECUTE_INCLUDE}.
   *
   * This is what `Tx.submit` uses, exported so a caller holding a result from
   * somewhere else — `client.core.executeTransaction`, a sponsor's SDK call —
   * can get the accessors without re-implementing the decode.
   *
   * Fails with: `ExecutionFailed` (the transaction applied and failed),
   * `DecodeError` (the response does not carry the include set).
   *
   * @since 0.1.2
   */
  static readonly fromTransactionResult = (
    result: SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
  ): Effect.Effect<Executed, ExecutionFailed | DecodeError> => fromTransactionResult(result)

  /**
   * An `Executed` from a **reduced** execute envelope: what a relay, a sponsor
   * or another service hands back, over JSON, after submitting on your behalf.
   *
   * Such an envelope is rarely the SDK's full include set. Everything optional
   * is filled in with "the node did not say" rather than refused:
   *
   * - `changedObjects` entries need only `objectId` and `idOperation`; the
   *   version, digest and owner on either side default to `null`, and
   *   `outputState` defaults to `ObjectWrite` (`DoesNotExist` for a
   *   `Deleted`), so {@link created} and {@link deleted} classify correctly
   *   from the id operation alone.
   * - `objectTypes` defaults to `{}`. **The type filters need it**:
   *   `created(type)`, `mutated(type)` and `expectCreated(type)` can only
   *   match a change whose type the envelope carried, so without
   *   `objectTypes` they return nothing. `created()` with no argument, and
   *   {@link createdWhere}, still list every created id.
   * - `balanceChanges` and `events` default to `[]`, `checkpoint` and
   *   `timestampMs` to `null`, `gasUsed` to zeros, and `effects.status` to
   *   success.
   * - **JSON spellings are accepted** where the SDK's types are not JSON:
   *   `bcs` as base64 or as an array of byte values as well as a
   *   `Uint8Array`, and every `u64` (versions, balances, gas, `checkpoint`)
   *   as a number or a `bigint` as well as the decimal string the wire uses.
   *
   * An envelope with no usable digest, or whose values are the wrong shape
   * rather than merely absent, fails: absence is filled in, nonsense is not.
   *
   * Fails with: `DecodeError`.
   *
   * @since 0.1.2
   */
  static readonly fromPartial = (envelope: unknown): Effect.Effect<Executed, DecodeError> =>
    fromPartial(envelope)

  /**
   * The single object of this type the transaction created.
   *
   * Fails with: `UnexpectedEffects` when the transaction created no object of
   * that type, or more than one.
   */
  expectCreated(type: string): Effect.Effect<ChangedRef, UnexpectedEffects> {
    const created = this.created(type)
    const only = created[0]
    if (created.length === 1 && only !== undefined) return Effect.succeed(only)
    return Effect.fail(
      new UnexpectedEffects({
        digest: this.digest,
        expected: type,
        found: created.map((ref) => ref.id)
      })
    )
  }
}

/** The `include` set every execute, simulate and transaction read asks for. */
export const EXECUTE_INCLUDE = {
  effects: true,
  events: true,
  balanceChanges: true,
  objectTypes: true
} as const

const decodeExecutedAst = Schema.decodeUnknownEffect(Executed)

/**
 * Decodes an `Executed`, reporting **every** issue rather than the first, so
 * the `DecodeError` an envelope produces can carry one entry per bad field.
 */
const decodeExecuted = (input: unknown) => decodeExecutedAst(input, { errors: "all" })

/**
 * Turns an SDK `TransactionResult` read with {@link EXECUTE_INCLUDE} into an
 * `Executed`, or into the one representation of an on-chain failure.
 *
 * Fails with: `ExecutionFailed` when the transaction was applied and failed,
 * and `DecodeError` when the response does not carry the include set that was
 * asked for.
 */
export const fromTransactionResult = Effect.fn("Executed.fromTransactionResult")(
  function*(
    result: SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
  ): Effect.fn.Return<Executed, ExecutionFailed | DecodeError> {
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction
    const encoded = {
      digest: transaction.digest,
      effects: transaction.effects,
      events: transaction.events,
      balanceChanges: transaction.balanceChanges,
      objectTypes: transaction.objectTypes,
      checkpoint: transaction.checkpoint,
      timestampMs: transaction.timestampMs
    }
    const executed = yield* decodeExecuted(encoded).pipe(
      Effect.mapError((error) =>
        new DecodeError({ kind: "shape", issue: error.message, issues: decodeIssues(error) })
      )
    )
    if (!transaction.status.success) {
      return yield* new ExecutionFailed({
        digest: executed.digest,
        reason: executionReasonOf(transaction.status.error),
        ...(transaction.status.error.command === undefined
          ? {}
          : { command: transaction.status.error.command }),
        effects: executed.effects
      })
    }
    return executed
  }
)

/** The zero gas summary a reduced envelope gets when it reports no gas at all. */
const NO_GAS = {
  computationCost: "0",
  storageCost: "0",
  storageRebate: "0",
  nonRefundableStorageFee: "0"
} as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const field = (value: unknown, key: string): unknown => (isRecord(value) ? value[key] : undefined)

/** A `u64` in whatever spelling JSON left it in, as the decimal string the schemas take. */
const u64String = (value: unknown, fallback?: string): string | undefined => {
  if (typeof value === "string") return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value)).toString()
  return fallback
}

/** The same, for a field the schema allows to be `null`. */
const u64OrNull = (value: unknown): string | null =>
  value === undefined || value === null ? null : u64String(value) ?? null

/**
 * Event bytes in whatever spelling survived JSON: the bytes themselves, base64,
 * or an array of byte values. An absent one is empty rather than a failure — a
 * relay that reports events as JSON carries no BCS to give.
 */
const bytesOf = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (typeof value === "string") {
    try {
      return fromBase64(value)
    } catch {
      return new Uint8Array()
    }
  }
  if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) {
    return Uint8Array.from(value as ReadonlyArray<number>)
  }
  return new Uint8Array()
}

/** One changed object, with every field the envelope left out filled in as "not said". */
const partialChange = (value: unknown): Record<string, unknown> => ({
  objectId: field(value, "objectId"),
  inputState: field(value, "inputState") ?? "Unknown",
  inputVersion: u64OrNull(field(value, "inputVersion")),
  inputDigest: field(value, "inputDigest") ?? null,
  inputOwner: field(value, "inputOwner") ?? null,
  outputState: field(value, "outputState") ?? "Unknown",
  outputVersion: u64OrNull(field(value, "outputVersion")),
  outputDigest: field(value, "outputDigest") ?? null,
  outputOwner: field(value, "outputOwner") ?? null,
  idOperation: field(value, "idOperation") ?? "Unknown"
})

const partialEvent = (value: unknown): Record<string, unknown> => {
  const json = field(value, "json")
  return {
    packageId: field(value, "packageId"),
    module: field(value, "module"),
    sender: field(value, "sender"),
    eventType: field(value, "eventType") ?? field(value, "type"),
    // A relay that renders events as JSON carries no BCS; the bytes are empty
    // and `json` is the whole of the event.
    bcs: bytesOf(field(value, "bcs")),
    ...(json === undefined ? {} : { json })
  }
}

const partialBalanceChange = (value: unknown): Record<string, unknown> => ({
  coinType: field(value, "coinType"),
  address: field(value, "address") ?? field(value, "owner"),
  amount: u64String(field(value, "amount"), "0")
})

const asArray = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : [])

/**
 * The body of {@link Executed.fromPartial}: normalize what a reduced envelope
 * carries into the encoded shape `Executed` decodes, then decode it.
 */
const fromPartial = (envelope: unknown): Effect.Effect<Executed, DecodeError> => {
  const effects = field(envelope, "effects")
  const digest = field(envelope, "digest") ?? field(effects, "transactionDigest")
  const status = field(effects, "status") ?? field(envelope, "status")
  const encoded = {
    digest,
    effects: {
      version: field(effects, "version") ?? 2,
      status: { success: field(status, "success") ?? true },
      gasUsed: {
        computationCost: u64String(field(field(effects, "gasUsed"), "computationCost"), NO_GAS.computationCost),
        storageCost: u64String(field(field(effects, "gasUsed"), "storageCost"), NO_GAS.storageCost),
        storageRebate: u64String(field(field(effects, "gasUsed"), "storageRebate"), NO_GAS.storageRebate),
        nonRefundableStorageFee: u64String(
          field(field(effects, "gasUsed"), "nonRefundableStorageFee"),
          NO_GAS.nonRefundableStorageFee
        )
      },
      transactionDigest: field(effects, "transactionDigest") ?? digest,
      gasObject: field(effects, "gasObject") ?? null,
      eventsDigest: field(effects, "eventsDigest") ?? null,
      dependencies: asArray(field(effects, "dependencies")),
      lamportVersion: u64OrNull(field(effects, "lamportVersion")),
      changedObjects: asArray(field(effects, "changedObjects") ?? field(envelope, "changedObjects"))
        .map(partialChange),
      unchangedConsensusObjects: asArray(field(effects, "unchangedConsensusObjects")),
      auxiliaryDataDigest: field(effects, "auxiliaryDataDigest") ?? null
    },
    events: asArray(field(envelope, "events")).map(partialEvent),
    balanceChanges: asArray(field(envelope, "balanceChanges")).map(partialBalanceChange),
    objectTypes: field(envelope, "objectTypes") ?? {},
    checkpoint: u64OrNull(field(envelope, "checkpoint")),
    timestampMs: (() => {
      const value = field(envelope, "timestampMs")
      if (value === undefined || value === null) return null
      const asNumber = typeof value === "string" ? Number(value) : value
      return typeof asNumber === "number" && Number.isFinite(asNumber) ? asNumber : null
    })()
  }
  return decodeExecuted(encoded).pipe(
    Effect.mapError((error) =>
      new DecodeError({
        kind: "shape",
        issue: `this is not an execute envelope Executed can be built from: ${error.message}`,
        issues: decodeIssues(error)
      })
    )
  )
}
