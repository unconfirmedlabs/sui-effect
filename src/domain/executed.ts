/**
 * `Executed`: a transaction that reached the chain, with accessors that answer
 * the questions the next transaction needs answered.
 *
 * Every accessor returns {@link ChangedRef}s — the object's id plus whatever
 * else the effects actually carried — and ignores accumulator writes
 * (`outputState: "AccumulatorWriteV1"`), which are balance bookkeeping rather
 * than objects. `Simulation` (0.5.0) lives here too and shares every accessor
 * with `Executed`, through one implementation. Use {@link objectRefOf} to turn one into the full `ObjectRef`
 * the transaction builder wants, which succeeds exactly when the node reported
 * every field it needs.
 *
 * @since 0.1.0
 */
import type { SuiClientTypes } from "@mysten/sui/client"
import { fromBase64, isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Predicate, Schema } from "effect"
import { DecodeError, decodePayload, ExecutionFailed, UnexpectedEffects } from "./errors.ts"
import {
  BalanceChange,
  ChangedObject,
  type Coin,
  CommandResult,
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
import { decodeContent, expectedTypeOf, typeMatches } from "./bcs.ts"

const decodeObjectType = Schema.decodeUnknownOption(ObjectType)

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
 * A {@link Coin} from `Sui.listCoins` / `Sui.streamCoins` is accepted too
 * (since 0.4.0): it is an owned object with its id under `objectId`, which is
 * exactly what a coin passed to `tx.objectRef` or `tx.setGasPayment` needs,
 * and it always carries a version and a digest, so for a `Coin` the answer is
 * never `undefined`.
 *
 * `undefined` when the effects did not carry a version or a digest — a deleted
 * object has no output version, and nothing can be consumed without both.
 * Never fails.
 */
export const sdkRefOf = (ref: ChangedRef | ObjectRef | Coin): SdkObjectRef | undefined =>
  "objectId" in ref
    ? { objectId: ref.objectId, version: ref.version.toString(), digest: ref.digest }
    : ref.version === undefined || ref.digest === undefined
    ? undefined
    : { objectId: ref.id, version: ref.version.toString(), digest: ref.digest }

/** The SDK's own object reference shape, as `Transaction#objectRef` takes it. */
export interface SdkObjectRef {
  readonly objectId: string
  readonly version: string
  readonly digest: string
}

/**
 * A changed object whose **owner changed**: what {@link Executed.transferred}
 * and {@link Simulation.transferred} return. The output side's ref, with the
 * owner it had going in as `inputOwner` and the one it has now as `owner`.
 *
 * @since 0.5.0
 */
export interface TransferredRef extends ChangedRef {
  /** The owner the object had going in. */
  readonly inputOwner: Owner
  /** The owner it has afterwards. */
  readonly owner: Owner
}

/**
 * What the shared accessors read: the fields `Executed` and `Simulation` have
 * in common. Internal; both classes delegate every accessor to the functions
 * below, so the two can never disagree about what "created" means.
 */
interface ChangeSource {
  readonly digest: Digest
  readonly effects: TransactionEffects
  readonly events: ReadonlyArray<Event>
  readonly balanceChanges: ReadonlyArray<BalanceChange>
  readonly objectTypes: { readonly [objectId: string]: string }
}

/**
 * The type of a changed object, from the `objectTypes` join. A published
 * package reports the literal `package` rather than a struct tag, so the
 * decode goes through {@link ObjectType}.
 */
const typeOf = (source: ChangeSource, objectId: ObjectId): ObjectType | undefined => {
  const type = source.objectTypes[objectId]
  if (type === undefined) return undefined
  const decoded = decodeObjectType(type)
  return decoded._tag === "Some" ? decoded.value : undefined
}

/**
 * Everything the effects actually say about one changed object. Nothing is
 * invented: a field the node did not report stays `undefined`, so a caller
 * that needs a full builder reference can tell the difference between
 * "version 0" and "the node did not say".
 */
const refOf = (source: ChangeSource, change: ChangedObject, side: "input" | "output"): ChangedRef => {
  const version = side === "output" ? change.outputVersion : change.inputVersion
  const digest = side === "output" ? change.outputDigest : change.inputDigest
  const owner = side === "output" ? change.outputOwner : change.inputOwner
  const type = typeOf(source, change.objectId)
  return {
    id: change.objectId,
    ...(type === undefined ? {} : { type }),
    ...(version === null ? {} : { version }),
    ...(digest === null ? {} : { digest }),
    ...(owner === null ? {} : { owner })
  }
}

/**
 * The changes that pass `predicate`, as refs read off one side, **never an
 * accumulator write**: an `AccumulatorWriteV1` output is an address balance
 * moving (the node's bookkeeping object for `balance::send_funds`, a gas
 * charge from a balance, a fold's deposit). It has no owner on either side,
 * no type in the `objectTypes` join and no version a builder could use, and
 * nobody holds it; the amount it moved is in `balanceChanges`.
 */
const select = (
  source: ChangeSource,
  predicate: (change: ChangedObject) => boolean,
  side: "input" | "output",
  filter?: (ref: ChangedRef) => boolean
): ReadonlyArray<ChangedRef> => {
  const refs: Array<ChangedRef> = []
  for (const change of source.effects.changedObjects) {
    if (isAccumulatorWrite(change)) continue
    if (!predicate(change)) continue
    const ref = refOf(source, change, side)
    if (filter !== undefined && !filter(ref)) continue
    refs.push(ref)
  }
  return refs
}

const byType = (type?: string): ((ref: ChangedRef) => boolean) | undefined =>
  type === undefined ? undefined : (ref) => ref.type !== undefined && typeMatches(type, ref.type)

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
const wroteAnObject = (change: ChangedObject): boolean =>
  change.outputState === "ObjectWrite" || change.outputState === "Unknown"

const isDeleted = (change: ChangedObject): boolean => change.idOperation === "Deleted"

const isWrapped = (change: ChangedObject): boolean =>
  change.idOperation === "None" && change.inputState === "Exists" && change.outputState === "DoesNotExist"

/**
 * Who an owner is, for comparing two of them: the kind and the party, never
 * the versions (`Shared.initialSharedVersion` never changes, and a
 * `ConsensusAddressOwner`'s `startVersion` moves without the owner changing).
 * `undefined` for `Unknown`, which cannot be compared with anything.
 */
const ownerKey = (owner: Owner): string | undefined => {
  switch (owner.$kind) {
    case "AddressOwner":
      return `address:${owner.AddressOwner}`
    case "ObjectOwner":
      return `object:${owner.ObjectOwner}`
    case "Shared":
      return "shared"
    case "Immutable":
      return "immutable"
    case "ConsensusAddressOwner":
      return `consensus:${owner.ConsensusAddressOwner.owner}`
    case "Unknown":
      return undefined
  }
}

/**
 * An object that existed before and after, kept its id, and changed owner. Both
 * owners must be known: a reduced envelope that left either out says nothing.
 */
const isTransferred = (change: ChangedObject): boolean => {
  if (change.idOperation !== "None" || change.inputState !== "Exists" || !wroteAnObject(change)) return false
  if (change.inputOwner === null || change.outputOwner === null) return false
  const before = ownerKey(change.inputOwner)
  const after = ownerKey(change.outputOwner)
  return before !== undefined && after !== undefined && before !== after
}

const createdWhereOf = (source: ChangeSource, predicate: (ref: ChangedRef) => boolean) =>
  select(source, (change) => change.idOperation === "Created" && wroteAnObject(change), "output", predicate)

const createdOf = (source: ChangeSource, type?: string) => createdWhereOf(source, byType(type) ?? (() => true))

const mutatedOf = (source: ChangeSource, type?: string) =>
  select(
    source,
    (change) =>
      change.idOperation === "None" &&
      wroteAnObject(change) &&
      (change.inputState === "Exists" || change.inputState === "Unknown"),
    "output",
    byType(type)
  )

const deletedOf = (source: ChangeSource) =>
  select(source, (change) => isDeleted(change) || isWrapped(change), "input")

const wrappedOf = (source: ChangeSource) => select(source, isWrapped, "input")

const transferredOf = (source: ChangeSource, type?: string): ReadonlyArray<TransferredRef> => {
  const refs: Array<TransferredRef> = []
  const filter = byType(type)
  for (const change of source.effects.changedObjects) {
    if (isAccumulatorWrite(change) || !isTransferred(change)) continue
    if (change.inputOwner === null || change.outputOwner === null) continue
    const ref = { ...refOf(source, change, "output"), inputOwner: change.inputOwner, owner: change.outputOwner }
    if (filter !== undefined && !filter(ref)) continue
    refs.push(ref)
  }
  return refs
}

const packagesPublishedOf = (source: ChangeSource): ReadonlyArray<ChangedRef> => {
  const refs: Array<ChangedRef> = []
  for (const change of source.effects.changedObjects) {
    if (change.outputState !== "PackageWrite" || change.idOperation !== "Created") continue
    const ref = refOf(source, change, "output")
    // gRPC reports the literal `package` as a published package's type, and
    // some nodes omit it from `objectTypes` entirely; a `PackageWrite` is a
    // package either way.
    refs.push(ref.type === undefined ? { ...ref, type: "package" } : ref)
  }
  return refs
}

const balanceChangeOf = (source: ChangeSource, address: SuiAddress, coinType: CoinType | string): bigint => {
  let total = 0n
  for (const change of source.balanceChanges) {
    if (change.address === address && typeMatches(coinType, change.coinType)) total += change.amount
  }
  return total
}

const gasUsedTotalOf = (source: ChangeSource): bigint => {
  const gas = source.effects.gasUsed
  return gas.computationCost + gas.storageCost - gas.storageRebate
}

const expectCreatedOf = (source: ChangeSource, type: string): Effect.Effect<ChangedRef, UnexpectedEffects> => {
  const created = createdOf(source, type)
  const only = created[0]
  if (created.length === 1 && only !== undefined) return Effect.succeed(only)
  return Effect.fail(
    new UnexpectedEffects({ digest: source.digest, expected: type, found: created.map((ref) => ref.id) })
  )
}

const eventsOfType = (source: ChangeSource, type: string): ReadonlyArray<Event> =>
  source.events.filter((event) => typeMatches(type, event.eventType))

const eventsOfOf = <T>(
  source: ChangeSource,
  codec: Schema.Codec<T, Uint8Array>,
  eventType?: string
): Effect.Effect<ReadonlyArray<T>, DecodeError> =>
  Effect.flatMap(
    selectingType(codec, eventType),
    (wanted) =>
      Effect.forEach(
        eventsOfType(source, wanted),
        (event) => decodeContent(codec, event.bcs, { expectedType: wanted, actualType: event.eventType })
      )
  )

const expectEventOf = <T>(
  source: ChangeSource,
  codec: Schema.Codec<T, Uint8Array>,
  eventType?: string
): Effect.Effect<T, UnexpectedEffects | DecodeError> =>
  Effect.flatMap(selectingType(codec, eventType), (wanted): Effect.Effect<T, UnexpectedEffects | DecodeError> => {
    const matching = eventsOfType(source, wanted)
    const only = matching[0]
    if (matching.length !== 1 || only === undefined) {
      return Effect.fail(
        new UnexpectedEffects({
          digest: source.digest,
          expected: `exactly one event ${wanted}`,
          found: matching.map((event) => event.packageId)
        })
      )
    }
    return decodeContent(codec, only.bcs, { expectedType: wanted, actualType: only.eventType })
  })

const expectPublishedOf = (source: ChangeSource): Effect.Effect<Published, UnexpectedEffects> => {
  const packages = packagesPublishedOf(source)
  const pkg = packages[0]
  if (packages.length !== 1 || pkg === undefined) {
    return Effect.fail(
      new UnexpectedEffects({
        digest: source.digest,
        expected: "exactly one published package",
        found: packages.map((ref) => ref.id)
      })
    )
  }
  const created = createdOf(source, UPGRADE_CAP_TYPE)
  const caps = created.length > 0 ? created : mutatedOf(source, UPGRADE_CAP_TYPE)
  const cap = caps[0]
  if (caps.length !== 1 || cap === undefined) {
    return Effect.fail(
      new UnexpectedEffects({
        digest: source.digest,
        expected: `exactly one ${UPGRADE_CAP_TYPE}`,
        found: caps.map((ref) => ref.id)
      })
    )
  }
  return Effect.succeed({ packageId: pkg.id, package: pkg, upgradeCap: cap })
}

/**
 * A transaction the network executed, built from the fixed execute include set:
 * effects, events, balance changes and object types.
 *
 * **`events` is `ReadonlyArray<Event>`, not `SuiClientTypes.Event[]`.** It
 * carries `packageId`, `module`, `sender`, `eventType` and `bcs`, with the
 * branded ids this package uses, and an **optional** `json`: the node's own
 * rendering, present only when the source carried one — a reduced envelope
 * read through {@link Executed.fromPartial} may; a gRPC execute never does. Do
 * not branch on it. The decode a caller wants is {@link Executed.eventsOf} /
 * {@link Executed.expectEvent} (or `SuiSchema.decode(codec, event.bcs)`), which
 * gives a typed value rather than a shape that changes with the node. Code
 * typed against the SDK's `Event[]` (whose `json` is required) therefore does
 * not accept these; take `ReadonlyArray<Event>` from `@unconfirmed/sui-effect`,
 * or map the fields you need.
 *
 * The data fields are `digest`, `effects`, `events`, `balanceChanges`,
 * `objectTypes` (object id to Move type), `checkpoint` (`null` until the node
 * says), `timestampMs` (`null` likewise) and `sender` (0.5.0).
 *
 * The accessors are **one implementation shared with {@link Simulation}**, so
 * a preview reads a simulation exactly the way a receipt reads an execution.
 */
export class Executed extends Schema.Class<Executed>("sui-effect/Executed")({
  digest: Digest,
  effects: TransactionEffects,
  events: Schema.Array(Event),
  balanceChanges: Schema.Array(BalanceChange),
  objectTypes: Schema.Record(Schema.String, Schema.String),
  checkpoint: Schema.NullOr(Schema.BigIntFromString),
  timestampMs: Schema.NullOr(Schema.Finite),
  /**
   * The transaction's sender. `Tx.submit`, `Tx.submitVia`, `Tx.resubmit`,
   * `Tx.reconcile` (given the signed bytes) and `Tx.run` always fill it from
   * the bytes they sent; a read fills it when the node returned the
   * transaction data (`include: { transaction: true }`), and
   * {@link Executed.fromPartial} when the envelope names one. Absent only when
   * nothing said.
   *
   * @since 0.5.0
   */
  sender: Schema.optionalKey(SuiAddress)
}) {
  /**
   * Objects this transaction created, optionally filtered by Move type through
   * `typeMatches`: a bare tag matches every instantiation of the generic, a
   * parameterized one is compared in full after normalization. Never fails.
   */
  created(type?: string): ReadonlyArray<ChangedRef> {
    return createdOf(this, type)
  }

  /**
   * Objects this transaction created whose reference satisfies a predicate.
   *
   * The direct replacement for the substring matching every repo hand-rolls
   * (`createdByType("::Receipt")`), without making substring matching the
   * default: `created(type)` still compares through `typeMatches`.
   * Never fails.
   */
  createdWhere(predicate: (ref: ChangedRef) => boolean): ReadonlyArray<ChangedRef> {
    return createdWhereOf(this, predicate)
  }

  /**
   * Objects this transaction mutated in place, optionally filtered by type.
   * An object that changed owner is mutated too, and is also in
   * {@link transferred}. Never fails.
   */
  mutated(type?: string): ReadonlyArray<ChangedRef> {
    return mutatedOf(this, type)
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
    return deletedOf(this)
  }

  /**
   * Objects this transaction wrapped: they went in existing and came out
   * nonexistent without their id being deleted, which is how the SDK's effects
   * converter represents wrapping. They are a subset of {@link deleted}.
   * Never fails.
   */
  wrapped(): ReadonlyArray<ChangedRef> {
    return wrappedOf(this)
  }

  /**
   * Objects whose **owner changed**, optionally filtered by type: they existed
   * going in, still exist with the same id, and their input owner and output
   * owner differ. Owners are compared by kind and party — an address, an
   * object (a dynamic object field's parent), shared, immutable, a consensus
   * address — never by version, so a transfer to someone else, a freeze, a
   * move under a dynamic object field and a move between `AddressOwner` and
   * `ConsensusAddressOwner` all count, while a consensus object whose
   * `startVersion` moved does not. A created object is not transferred (its
   * owner is on {@link created}'s ref), and neither is a deleted or wrapped
   * one. Either owner unknown — a reduced envelope that left it out, or the
   * `Unknown` variant — is not evidence of a change and is left out. Each ref
   * is the output side, with `inputOwner` the owner going in. Never fails.
   *
   * @since 0.5.0
   */
  transferred(type?: string): ReadonlyArray<TransferredRef> {
    return transferredOf(this, type)
  }

  /**
   * Packages this transaction published (`PackageWrite` plus `Created`), as
   * full refs like every other accessor. A package's `type` is the literal
   * `package` when the node reports one, and the ref falls back to it when the
   * `objectTypes` join has no entry, so a publish is never silently dropped.
   * Never fails.
   */
  packagesPublished(): ReadonlyArray<ChangedRef> {
    return packagesPublishedOf(this)
  }

  /**
   * The net balance change for one address and coin type, in the coin's base
   * unit (MIST for SUI). `coinType` is any spelling — `"0x2::sui::SUI"`,
   * `CoinType.SUI` — compared under the one Move type rule. It covers coin
   * objects and the address balance alike, netted per address: a fold that
   * moves 1,000 SUI of coins into its owner's address balance reports only
   * the gas it cost (`Tx.foldMovement` reports the movement). Never fails.
   */
  balanceChange(address: SuiAddress, coinType: CoinType | string): bigint {
    return balanceChangeOf(this, address, coinType)
  }

  /** Computation plus storage less the storage rebate, in MIST. Can be negative. Never fails. */
  get gasUsedTotal(): bigint {
    return gasUsedTotalOf(this)
  }

  /**
   * An `Executed` from the SDK's own `TransactionResult`, read with
   * {@link EXECUTE_INCLUDE}.
   *
   * This is what `Tx.submit` uses, exported so a caller holding a result from
   * somewhere else — `client.core.executeTransaction`, a sponsor's SDK call —
   * can get the accessors without re-implementing the decode. `sender` is
   * filled when the result carries the transaction data (it was read with
   * `transaction: true` as well).
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
   *   success. `sender` (or `transaction.sender`) is kept when it is an
   *   address.
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
    return expectCreatedOf(this, type)
  }

  /**
   * Every event this transaction emitted whose type matches the codec's Move
   * type, decoded with that codec, in emission order.
   *
   * The codec is a `SuiSchema.bcs(layout, type)` (or anything piped from one):
   * the type it was built with selects the events under the one Move type rule
   * (`typeMatches` — a bare tag matches every instantiation of a generic event),
   * and its layout decodes each one's `bcs`. Pass `eventType` to select by a
   * different type than the codec records, or to give one to a codec built
   * without a type.
   *
   * **After a package upgrade an event struct keeps the id of the package that
   * first defined it**, even when a later version emits it, so a codec tagged
   * with the latest package id selects nothing for a struct that existed in v1.
   *
   * No match is an empty array, not a failure; {@link expectEvent} is the
   * "exactly one" form. An event with no BCS (a relay envelope that rendered
   * events as JSON, read through {@link Executed.fromPartial}) fails to decode.
   *
   * Fails with: `DecodeError` — `kind: "bytes"` when a selected event's bytes do
   * not parse, `kind: "type"` when neither the codec nor `eventType` names a
   * Move type to select by.
   *
   * @since 0.4.0
   *
   * @example
   * ```ts
   * import { bcs } from "@mysten/sui/bcs"
   * import { Effect } from "effect"
   * import { SuiSchema } from "@unconfirmed/sui-effect"
   * import type { Executed } from "@unconfirmed/sui-effect"
   *
   * const Posted = SuiSchema.bcs(bcs.struct("Posted", { index: bcs.u64() }), `${PKG}::board::Posted`)
   *
   * const indices = (executed: Executed) =>
   *   Effect.map(executed.eventsOf(Posted), (events) => events.map((event) => event.index))
   * ```
   */
  eventsOf<T>(
    codec: Schema.Codec<T, Uint8Array>,
    eventType?: string
  ): Effect.Effect<ReadonlyArray<T>, DecodeError> {
    return eventsOfOf(this, codec, eventType)
  }

  /**
   * The single event of the codec's type this transaction emitted, decoded.
   *
   * The "this call emits exactly one `Posted`" assertion, so a caller does not
   * write `events.find(...)` plus a decode plus a `die` for the missing case.
   * Selection and decoding are {@link eventsOf}'s.
   *
   * Fails with: `UnexpectedEffects` when the transaction emitted no event of
   * that type, or more than one — its `found` holds the emitting package id of
   * each matching event, so its length is the count; `DecodeError` when the one
   * event does not decode, or when there is no Move type to select by.
   *
   * @since 0.4.0
   */
  expectEvent<T>(
    codec: Schema.Codec<T, Uint8Array>,
    eventType?: string
  ): Effect.Effect<T, UnexpectedEffects | DecodeError> {
    return expectEventOf(this, codec, eventType)
  }

  /**
   * The package this transaction published — or the new version an upgrade
   * created — and its `UpgradeCap`.
   *
   * A publish creates exactly one package (`packagesPublished()`) and one
   * `0x2::package::UpgradeCap`; an upgrade creates the new package version
   * and **mutates** the cap it was authorized with, so `upgradeCap` is the
   * created cap when there is one and the mutated one otherwise. The cap is
   * found through `objectTypes`, which every execute and `Tx.submit` reads.
   *
   * Remember that a publish's `UpgradeCap` must go somewhere: the recipe
   * `transferObjects`es the `tx.publish(...)` result to the sender, or the
   * transaction fails with an unused value.
   *
   * Fails with: `UnexpectedEffects` when the transaction published no package
   * or more than one (`found` lists the package ids), or when no single
   * `UpgradeCap` was created or mutated (`found` lists the caps it saw).
   *
   * @since 0.4.0
   *
   * @example
   * ```ts
   * import { Effect } from "effect"
   * import { Tx } from "@unconfirmed/sui-effect/tx"
   *
   * const deploy = Effect.gen(function*() {
   *   const executed = yield* Tx.run(publishRecipe, { signer })
   *   const { packageId, upgradeCap } = yield* executed.expectPublished()
   *   return { packageId, upgradeCapId: upgradeCap.id }
   * })
   * ```
   */
  expectPublished(): Effect.Effect<Published, UnexpectedEffects> {
    return expectPublishedOf(this)
  }
}

/**
 * The result of a successful simulation, with the fixed include set `Sui` asks
 * for: effects, events, balance changes, object types and command results.
 *
 * `gasPaymentMocked` mirrors the SDK field of the same name: `true` when the
 * simulated transaction had no gas payment, so the node ran it on a mocked gas
 * coin — gas costs and logic are exercised, but anything drawn from `tx.gas`
 * was funded by the mock, not the sender. `false` when gas was paid with real
 * coins or from the sender's address balance.
 *
 * **A `Schema.Class` since 0.5.0** (a `Schema.Struct` before), so it carries
 * {@link Executed}'s accessors — `created`, `createdWhere`, `mutated`,
 * `deleted`, `wrapped`, `transferred`, `packagesPublished`, `balanceChange`,
 * `gasUsedTotal`, `expectCreated`, `eventsOf`, `expectEvent`,
 * `expectPublished` — through **the same implementation**, so a preview and
 * the receipt it predicts read the same way. The fields are unchanged. Values
 * come from `Sui.simulate` or a decode (`Schema.decodeUnknownEffect(Simulation)`);
 * one assembled by hand is `new Simulation({ ... })`.
 */
export class Simulation extends Schema.Class<Simulation>("sui-effect/Simulation")({
  digest: Digest,
  effects: TransactionEffects,
  events: Schema.Array(Event),
  balanceChanges: Schema.Array(BalanceChange),
  objectTypes: Schema.Record(Schema.String, Schema.String),
  commandResults: Schema.Array(CommandResult),
  gasPaymentMocked: Schema.Boolean
}) {
  /** {@link Executed.created}, over the simulated effects. Never fails. @since 0.5.0 */
  created(type?: string): ReadonlyArray<ChangedRef> {
    return createdOf(this, type)
  }

  /** {@link Executed.createdWhere}, over the simulated effects. Never fails. @since 0.5.0 */
  createdWhere(predicate: (ref: ChangedRef) => boolean): ReadonlyArray<ChangedRef> {
    return createdWhereOf(this, predicate)
  }

  /** {@link Executed.mutated}, over the simulated effects. Never fails. @since 0.5.0 */
  mutated(type?: string): ReadonlyArray<ChangedRef> {
    return mutatedOf(this, type)
  }

  /** {@link Executed.deleted} (deleted or wrapped), over the simulated effects. Never fails. @since 0.5.0 */
  deleted(): ReadonlyArray<ChangedRef> {
    return deletedOf(this)
  }

  /** {@link Executed.wrapped}, over the simulated effects. Never fails. @since 0.5.0 */
  wrapped(): ReadonlyArray<ChangedRef> {
    return wrappedOf(this)
  }

  /** {@link Executed.transferred}: objects whose owner changed. Never fails. @since 0.5.0 */
  transferred(type?: string): ReadonlyArray<TransferredRef> {
    return transferredOf(this, type)
  }

  /** {@link Executed.packagesPublished}, over the simulated effects. Never fails. @since 0.5.0 */
  packagesPublished(): ReadonlyArray<ChangedRef> {
    return packagesPublishedOf(this)
  }

  /** {@link Executed.balanceChange}: the net delta for one address and coin type. Never fails. @since 0.5.0 */
  balanceChange(address: SuiAddress, coinType: CoinType | string): bigint {
    return balanceChangeOf(this, address, coinType)
  }

  /** Computation plus storage less the storage rebate, in MIST. Can be negative. Never fails. @since 0.5.0 */
  get gasUsedTotal(): bigint {
    return gasUsedTotalOf(this)
  }

  /**
   * {@link Executed.expectCreated}, over the simulated effects.
   *
   * Fails with: `UnexpectedEffects` when the simulation created no object of
   * that type, or more than one.
   *
   * @since 0.5.0
   */
  expectCreated(type: string): Effect.Effect<ChangedRef, UnexpectedEffects> {
    return expectCreatedOf(this, type)
  }

  /**
   * {@link Executed.eventsOf}, over the simulated events.
   *
   * Fails with: `DecodeError`.
   *
   * @since 0.5.0
   */
  eventsOf<T>(
    codec: Schema.Codec<T, Uint8Array>,
    eventType?: string
  ): Effect.Effect<ReadonlyArray<T>, DecodeError> {
    return eventsOfOf(this, codec, eventType)
  }

  /**
   * {@link Executed.expectEvent}, over the simulated events.
   *
   * Fails with: `UnexpectedEffects`, `DecodeError`.
   *
   * @since 0.5.0
   */
  expectEvent<T>(
    codec: Schema.Codec<T, Uint8Array>,
    eventType?: string
  ): Effect.Effect<T, UnexpectedEffects | DecodeError> {
    return expectEventOf(this, codec, eventType)
  }

  /**
   * {@link Executed.expectPublished}, over the simulated effects: the package a
   * publish would create, and its `UpgradeCap`.
   *
   * Fails with: `UnexpectedEffects`.
   *
   * @since 0.5.0
   */
  expectPublished(): Effect.Effect<Published, UnexpectedEffects> {
    return expectPublishedOf(this)
  }
}

/**
 * The Move type that selects events for `eventsOf`/`expectEvent`: the caller's
 * override, else the type the codec was built with.
 */
const selectingType = <T>(
  codec: Schema.Codec<T, Uint8Array>,
  eventType: string | undefined
): Effect.Effect<string, DecodeError> => {
  const wanted = eventType ?? expectedTypeOf(codec)
  return wanted === undefined
    ? Effect.fail(
      new DecodeError({
        kind: "type",
        issue: "the codec carries no Move type to select events by: build it with" +
          " SuiSchema.bcs(layout, eventType), or pass eventType to eventsOf/expectEvent"
      })
    )
    : Effect.succeed(wanted)
}

/** The Move type of the capability a publish creates and an upgrade consumes. */
const UPGRADE_CAP_TYPE = "0x2::package::UpgradeCap"

/**
 * What {@link Executed.expectPublished} answers: the package id, the package's
 * own changed ref, and the `UpgradeCap` that governs it.
 *
 * @since 0.4.0
 */
export interface Published {
  readonly packageId: ObjectId
  readonly package: ChangedRef
  readonly upgradeCap: ChangedRef
}

/**
 * The `include` set every execute, simulate and transaction read asks for, and
 * the one `Executed.fromTransactionResult` is typed over: a `SuiCore` read made
 * with `{ include: EXECUTE_INCLUDE }` is a result that method accepts.
 */
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
export const fromTransactionResult = Effect.fnUntraced(
  function*(
    result: SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
  ): Effect.fn.Return<Executed, ExecutionFailed | DecodeError> {
    const transaction = result.$kind === "Transaction" ? result.Transaction : result.FailedTransaction
    // Present only when the caller also asked for `transaction: true`; the
    // execute include set does not, so `Tx` fills it from the signed bytes.
    const sender = senderOf(
      (transaction as unknown as { readonly transaction?: { readonly sender?: unknown } | null }).transaction?.sender
    )
    const encoded = {
      digest: transaction.digest,
      effects: transaction.effects,
      events: transaction.events,
      balanceChanges: transaction.balanceChanges,
      objectTypes: transaction.objectTypes,
      checkpoint: transaction.checkpoint,
      timestampMs: transaction.timestampMs,
      ...(sender === undefined ? {} : { sender })
    }
    const executed = yield* decodeExecuted(encoded).pipe(
      Effect.mapError((error) => new DecodeError({ kind: "shape", ...decodePayload(error) }))
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

/** A sender someone reported, as the padded address, or `undefined` when it is not an address. */
const senderOf = (value: unknown): string | undefined =>
  typeof value === "string" && isValidSuiAddress(normalizeSuiAddress(value)) ? normalizeSuiAddress(value) : undefined

/**
 * `executed` with `sender` filled in from the bytes that were sent, when the
 * node's answer did not carry it. Internal: what `Tx` applies to everything it
 * returns for a `Signed`. Never fails.
 */
export const withSender = (executed: Executed, sender: SuiAddress): Executed =>
  executed.sender !== undefined ? executed : new Executed({ ...executed, sender }, { disableChecks: true })

/** The zero gas summary a reduced envelope gets when it reports no gas at all. */
const NO_GAS = {
  computationCost: "0",
  storageCost: "0",
  storageRebate: "0",
  nonRefundableStorageFee: "0"
} as const

// `Predicate.isObject` is the non-null, non-array guard; Effect's own agent
// guide is explicit that a hand-written `isRecord` is never the right answer.
const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined

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
    ...(() => {
      const sender = senderOf(field(envelope, "sender") ?? field(field(envelope, "transaction"), "sender"))
      return sender === undefined ? {} : { sender }
    })(),
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
      (() => {
        const payload = decodePayload(error)
        return new DecodeError({
          kind: "shape",
          ...payload,
          issue: `this is not an execute envelope Executed can be built from: ${payload.issue}`
        })
      })()
    )
  )
}
