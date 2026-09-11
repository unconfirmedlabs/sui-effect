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
import { Effect, Schema } from "effect"
import { DecodeError, ExecutionFailed, UnexpectedEffects } from "./errors.ts"
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
 * A transaction the network executed, built from the fixed execute include set:
 * effects, events, balance changes and object types.
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
      (change) => change.idOperation === "Created" && change.outputState === "ObjectWrite",
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
      (change) => change.idOperation === "Created" && change.outputState === "ObjectWrite",
      "output",
      predicate
    )
  }

  /** Objects this transaction mutated in place, optionally filtered by type. Never fails. */
  mutated(type?: string): ReadonlyArray<ChangedRef> {
    return this.select(
      (change) =>
        change.idOperation === "None" &&
        change.outputState === "ObjectWrite" &&
        change.inputState === "Exists",
      "output",
      Executed.byType(type)
    )
  }

  /**
   * Objects this transaction deleted or wrapped. The refs carry the versions the
   * objects had going in, since they have no output version. Never fails.
   */
  deleted(): ReadonlyArray<ChangedRef> {
    return this.select((change) => change.idOperation === "Deleted", "input")
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

const decodeExecuted = Schema.decodeUnknownEffect(Executed)

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
      Effect.mapError((error) => new DecodeError({ issue: error.message }))
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
