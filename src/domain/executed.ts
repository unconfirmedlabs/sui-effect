/**
 * `Executed`: a transaction that reached the chain, with accessors that answer
 * the questions the next transaction needs answered.
 *
 * Every accessor returns full `ObjectRef`s, so a created object can be fed
 * straight back into the builder, and every accessor ignores accumulator writes
 * (`outputState: "AccumulatorWriteV1"`), which are balance bookkeeping rather
 * than objects.
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
  StructTag,
  SuiAddress,
  TransactionEffects,
  Version
} from "./schemas.ts"
import { typeMatches } from "./bcs.ts"

const UNKNOWN_OWNER = Owner.cases.Unknown.make({ $kind: "Unknown" })

const isAccumulatorWrite = (change: ChangedObject): boolean =>
  change.outputState === "AccumulatorWriteV1"

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

  private refOf(change: ChangedObject, side: "input" | "output"): ObjectRef | undefined {
    const type = this.typeOf(change.objectId)
    if (type === undefined) return undefined
    const version = side === "output" ? change.outputVersion : change.inputVersion
    const digest = side === "output" ? change.outputDigest : change.inputDigest
    const owner = side === "output" ? change.outputOwner : change.inputOwner
    return {
      id: change.objectId,
      type,
      version: version ?? (0n as Version),
      digest: digest ?? "",
      owner: owner ?? UNKNOWN_OWNER
    }
  }

  private select(
    predicate: (change: ChangedObject) => boolean,
    side: "input" | "output",
    type?: string
  ): ReadonlyArray<ObjectRef> {
    const refs: Array<ObjectRef> = []
    for (const change of this.effects.changedObjects) {
      if (isAccumulatorWrite(change)) continue
      if (!predicate(change)) continue
      const ref = this.refOf(change, side)
      if (ref === undefined) continue
      if (type !== undefined && !typeMatches(type, ref.type)) continue
      refs.push(ref)
    }
    return refs
  }

  /**
   * Objects this transaction created, optionally filtered by Move type
   * (compared with `normalizeStructTag`). Never fails.
   */
  created(type?: string): ReadonlyArray<ObjectRef> {
    return this.select(
      (change) => change.idOperation === "Created" && change.outputState === "ObjectWrite",
      "output",
      type
    )
  }

  /** Objects this transaction mutated in place, optionally filtered by type. Never fails. */
  mutated(type?: string): ReadonlyArray<ObjectRef> {
    return this.select(
      (change) =>
        change.idOperation === "None" &&
        change.outputState === "ObjectWrite" &&
        change.inputState === "Exists",
      "output",
      type
    )
  }

  /**
   * Objects this transaction deleted or wrapped. The refs carry the versions the
   * objects had going in, since they have no output version. Never fails.
   */
  deleted(): ReadonlyArray<ObjectRef> {
    return this.select((change) => change.idOperation === "Deleted", "input")
  }

  /**
   * Packages this transaction published (`PackageWrite` plus `Created`), as
   * full refs like every other accessor. A package's `type` is the literal
   * `package` when the node reports one, and the ref falls back to it when the
   * `objectTypes` join has no entry, so a publish is never silently dropped.
   * Never fails.
   */
  packagesPublished(): ReadonlyArray<ObjectRef> {
    const refs: Array<ObjectRef> = []
    for (const change of this.effects.changedObjects) {
      if (change.outputState !== "PackageWrite" || change.idOperation !== "Created") continue
      refs.push(
        this.refOf(change, "output") ?? {
          id: change.objectId,
          type: "package",
          version: change.outputVersion ?? (0n as Version),
          digest: change.outputDigest ?? "",
          owner: change.outputOwner ?? UNKNOWN_OWNER
        }
      )
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
  expectCreated(type: string): Effect.Effect<ObjectRef, UnexpectedEffects> {
    const created = this.created(type)
    const only = created[0]
    if (created.length === 1 && only !== undefined) return Effect.succeed(only)
    const expected = Schema.decodeUnknownOption(StructTag)(type)
    return Effect.fail(
      new UnexpectedEffects({
        digest: this.digest,
        expected: expected._tag === "Some" ? expected.value : StructTag.make("0x2::sui::SUI"),
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
