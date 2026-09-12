/**
 * `SuiCoreFake`: an in-memory `SuiCore` for tests.
 *
 * It holds a map of objects keyed by id with their version and BCS content, the
 * Clock object `0x6`, and scripted outcomes for the methods a transaction
 * lifecycle touches. Anything that is not scripted dies with a message naming
 * the method, so a test never silently passes against a stub.
 *
 * There is no Move execution here and no real BCS validation of a transaction:
 * localnet covers those.
 *
 * @since 0.1.0
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"
import { Inputs, TransactionDataBuilder } from "@mysten/sui/transactions"
import { parseSerializedSignature } from "@mysten/sui/cryptography"
import { publicKeyFromRawBytes } from "@mysten/sui/verify"
import type { TransactionPlugin } from "@mysten/sui/transactions"
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
  SUI_TYPE_ARG,
  toBase58
} from "@mysten/sui/utils"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import { typeMatches } from "../domain/bcs.ts"
import { ExecutionReason } from "../domain/schemas.ts"
import type { SuiCoreService } from "./SuiCore.ts"
import { DefectMarker, makeFromClient, SuiCore } from "./SuiCore.ts"

/** The BCS layout of `0x2::clock::Clock`. */
export const ClockBcs = bcs.struct("Clock", {
  id: bcs.Address,
  timestamp_ms: bcs.U64
})

/** The Move type of the Clock object. */
export const CLOCK_TYPE = "0x2::clock::Clock"

/** A deterministic base58 32-byte digest, for fixtures. */
export const fakeDigest = (seed: number): string => {
  const bytes = new Uint8Array(32)
  bytes[0] = (seed % 255) + 1
  bytes[31] = 7
  return toBase58(bytes)
}

/** An object the fake serves. */
export interface FakeObject {
  readonly objectId: string
  readonly type: string
  readonly version: bigint
  readonly content: Uint8Array
  readonly digest?: string
  readonly owner?: SuiClientTypes.ObjectOwner
  /**
   * The digest of the transaction that last mutated this object, served when
   * the caller includes `previousTransaction`.
   *
   * This is the field `Tx.reconcile` reads to tell "someone else spent our
   * input" from "we spent it ourselves and this node has not caught up", so a
   * test that bumps a version has to say who bumped it. `undefined` models a
   * node that will not say, which is evidence of nothing.
   */
  readonly previousTransaction?: string
}

/** A created, mutated or deleted object in a scripted execution. */
export interface FakeChange {
  readonly objectId: string
  readonly type: string
  readonly version?: bigint
  /**
   * The version this transaction took the object at, which is what
   * `Tx.reconcile` reads to decide that a **different** transaction consumed
   * the version a set of bytes pinned.
   *
   * Sui stamps every output with the transaction's Lamport version —
   * `max(input versions) + 1` across all of its inputs — so the input version
   * is not "the output version minus one" on a real network, and a test that
   * means "this transaction consumed version 3" has to say 3. It defaults to
   * `version - 1` for a mutated or deleted object, and is `null` for a created
   * one.
   */
  readonly inputVersion?: bigint
  readonly owner?: SuiClientTypes.ObjectOwner
  /** `PackageWrite` marks a published package; `AccumulatorWriteV1` an accumulator write. */
  readonly outputState?: SuiClientTypes.ChangedObject["outputState"]
  /**
   * The balance this coin has **after** the transaction, in MIST.
   *
   * Only meaningful for a `0x2::coin::Coin<...>`: a created coin joins the
   * fake's coin set with this balance and a mutated one has its balance
   * rewritten, so a test that splits a coin and then builds again sees the gas
   * selection the split left behind. Leave it out for anything that is not a
   * coin.
   */
  readonly balance?: bigint
}

/** What a scripted success returns. Everything is optional and defaulted. */
export interface FakeExecution {
  readonly digest?: string
  readonly created?: ReadonlyArray<FakeChange>
  readonly mutated?: ReadonlyArray<FakeChange>
  readonly deleted?: ReadonlyArray<FakeChange>
  readonly events?: ReadonlyArray<SuiClientTypes.Event>
  readonly balanceChanges?: ReadonlyArray<SuiClientTypes.BalanceChange>
  /**
   * The per-command results a simulation reports.
   *
   * Both arrays of `SuiClientTypes.CommandResult` are required on the wire and
   * either may be left out here: a missing one defaults to empty, which is what
   * the node reports for a command that returned nothing. Giving only
   * `returnValues` used to fail the whole `Simulation` decode with an issue
   * naming `mutatedReferences`, a field the test never mentioned.
   */
  readonly commandResults?: ReadonlyArray<Partial<SuiClientTypes.CommandResult>>
  readonly gasUsed?: SuiClientTypes.GasCostSummary
  readonly checkpoint?: string
  readonly timestampMs?: number
}

/** One scripted outcome of a call. The last entry of a script repeats forever. */
export type FakeOutcome =
  | { readonly _tag: "succeed"; readonly value: FakeExecution }
  | { readonly _tag: "failWith"; readonly reason: SuiClientTypes.ExecutionError; readonly value: FakeExecution }
  | { readonly _tag: "transportError"; readonly status: string }
  | { readonly _tag: "notFound" }
  | { readonly _tag: "timeoutThen"; readonly found: boolean }

/**
 * The wire `ExecutionError` a scripted failure needs, from either shape a test
 * is likely to hold.
 *
 * The SDK's own shape — a required top-level `message` and an `abortCode`
 * **string** — is what the node sends and what the fake must hand back. A test
 * that has sui-effect's decoded {@link ExecutionReason} instead (`abortCode` a
 * `bigint`, no `message`) used to be accepted silently, then fail the
 * `Simulation`/`Executed` decode much later as a `DecodeError` or a
 * `TransportError`, and — because the outcome cursor had already moved — often
 * surface as an unrelated `FakeUnimplemented` on some other method. So it is
 * encoded here, at the point where the fixture is written, and anything that is
 * neither shape says so immediately.
 */
const executionErrorOf = (
  reason: SuiClientTypes.ExecutionError | ExecutionReason
): SuiClientTypes.ExecutionError => {
  const kind = (reason as { readonly $kind?: unknown })?.$kind
  if (typeof kind !== "string") {
    throw new Error(
      "FakeOutcome.failWith: an execution failure is `{ $kind, [$kind]: …, message }` —" +
        " the SDK's `SuiClientTypes.ExecutionError` — or sui-effect's decoded" +
        " `ExecutionReason` (`{ $kind, [$kind]: … }`, `abortCode` a bigint)." +
        ` This value has no $kind: ${String(reason)}`
    )
  }
  if (typeof (reason as { readonly message?: unknown }).message === "string") {
    return reason as SuiClientTypes.ExecutionError
  }
  const encoded = Schema.encodeUnknownResult(ExecutionReason)(reason)
  if (Result.isFailure(encoded)) {
    throw new Error(
      `FakeOutcome.failWith: this ${kind} is neither the SDK's ExecutionError` +
        " (a top-level `message`, `abortCode` a decimal string) nor a decodable" +
        ` ExecutionReason: ${encoded.failure.message}`
    )
  }
  return {
    message: `fake execution failure (${kind})`,
    ...(encoded.success as object)
  } as SuiClientTypes.ExecutionError
}

/** Builders for {@link FakeOutcome}. */
export const FakeOutcome = {
  /** The call succeeds with these effects. */
  succeed: (value: FakeExecution = {}): FakeOutcome => ({ _tag: "succeed", value }),
  /**
   * The call resolves with an on-chain failure (`FailedTransaction`).
   *
   * `reason` may be the SDK's `SuiClientTypes.ExecutionError` — the wire shape,
   * with a top-level `message` and an `abortCode` **string** — or sui-effect's
   * decoded `ExecutionReason`, whose `abortCode` is a `bigint` and which
   * carries no `message`. The second is encoded into the first here; a value
   * that is neither throws immediately, naming the two shapes, rather than
   * failing a decode several calls later.
   */
  failWith: (
    reason: SuiClientTypes.ExecutionError | ExecutionReason,
    value: FakeExecution = {}
  ): FakeOutcome => ({ _tag: "failWith", reason: executionErrorOf(reason), value }),
  /** The call rejects with a gRPC status, as `RpcError` would. */
  transportError: (status: string): FakeOutcome => ({ _tag: "transportError", status }),
  /** The call rejects the way a missing transaction does. */
  notFound: (): FakeOutcome => ({ _tag: "notFound" }),
  /**
   * The call never settles until the caller's `AbortSignal` fires, then rejects
   * with a `DEADLINE_EXCEEDED`. `found` says whether a later `getTransaction`
   * for the same digest should find the transaction.
   */
  timeoutThen: (found: boolean): FakeOutcome => ({ _tag: "timeoutThen", found })
}

/**
 * A balance the fake serves, optionally for one owner.
 *
 * `owner` is the address this balance belongs to. Left out, the entry answers
 * for **any** owner, which is what every script written before 0.1.2 assumed.
 *
 * @since 0.1.2
 */
export interface FakeBalance extends SuiClientTypes.Balance {
  readonly owner?: string
}

/** Everything the fake serves. Every field is optional. */
export interface FakeScript {
  readonly chainId?: string
  readonly network?: SuiClientTypes.Network
  readonly referenceGasPrice?: bigint
  /** The timestamp the Clock object `0x6` reports, in milliseconds. */
  readonly clockTimestampMs?: bigint
  readonly objects?: ReadonlyArray<FakeObject>
  /**
   * The coins `listCoins` serves and the fake's resolve plugin picks gas
   * payment from. `type` is the full object type, `0x2::coin::Coin<T>`, the
   * way the node reports it.
   */
  readonly coins?: ReadonlyArray<SuiClientTypes.Coin>
  /** The gas budget the resolve plugin sets when a transaction has none. */
  readonly gasBudget?: bigint
  /**
   * The balances `getBalance` and `listBalances` serve.
   *
   * Keyed by **owner and coin type**: an entry with an `owner` answers only for
   * that address, and one without answers for any, which is what a script
   * written before 0.1.2 meant. A `getBalance` for an owner and coin type no
   * entry names answers zero, the way a node does for an address that holds
   * none of that coin.
   */
  readonly balances?: ReadonlyArray<FakeBalance>
  /**
   * Scripted outcomes for `getObject`, oldest first; the last repeats forever.
   *
   * This is transport-error injection on a **read**: `FakeOutcome.transportError`
   * and `FakeOutcome.timeoutThen` are what it is for, and they are how a test
   * drives `SuiCore`'s read retry policy or an extension's own fallback.
   * `FakeOutcome.notFound` answers the way a missing object does
   * (`ObjectNotFound`). A `succeed` entry — and an empty or exhausted script —
   * means "serve the object map", which is the normal behaviour.
   *
   * @since 0.1.2
   */
  readonly getObject?: ReadonlyArray<FakeOutcome>
  /**
   * What `getCoinMetadata` answers, keyed by coin type.
   *
   * Unscripted, the method dies naming itself the way every uncovered method
   * does. Scripted, a coin type the record does not name answers
   * `{ coinMetadata: null }` — which is what a node says about a type that has
   * no metadata object, and the case an extension that formats balances has to
   * handle.
   *
   * @since 0.1.1
   */
  readonly coinMetadata?: Readonly<Record<string, SuiClientTypes.CoinMetadata>>
  readonly dynamicFields?: Readonly<Record<string, ReadonlyArray<SuiClientTypes.DynamicFieldEntry>>>
  readonly dynamicFieldValues?: Readonly<Record<string, SuiClientTypes.DynamicFieldValue>>
  /** How many items a list method returns per page. Defaults to 50. */
  readonly pageSize?: number
  /**
   * The epoch `getCurrentSystemState` reports. Defaults to
   * {@link DEFAULT_EPOCH}.
   *
   * This one is defaulted rather than left to die unscripted, because it is an
   * ambient fact about the chain the way `chainId` and the reference gas price
   * are, not an outcome a test is asserting on: `Tx.build` reads it for every
   * default `ValidDuring` expiration, which bounds a transaction to this epoch
   * and the next. Set it when the epoch is what the test is about.
   */
  readonly epoch?: bigint
  readonly simulate?: ReadonlyArray<FakeOutcome>
  /**
   * What the resolve plugin's budget simulation does during
   * `transaction.build({ client })`. Empty (the default) means the plugin sets
   * the budget from `gasBudget` without simulating, which is what most tests
   * want; scripting `failWith` here is how a test makes `Tx.build` fail with
   * `SimulationFailed` the way a real node's resolver does.
   */
  readonly buildSimulate?: ReadonlyArray<FakeOutcome>
  readonly execute?: ReadonlyArray<FakeOutcome>
  readonly getTransaction?: ReadonlyArray<FakeOutcome>
  /**
   * Transactions the node knows **by digest**, served before the ordered
   * `getTransaction` script is consulted.
   *
   * The ordered script answers "what does the node say the next time it is
   * asked", which is what a reconcile test drives. This answers "what does the
   * node say about *that* transaction", which is what `Tx.reconcile` needs when
   * it follows a pinned object's `previousTransaction` to find out which
   * version the consuming transaction actually took: the answer has to depend
   * on the digest, not on the call count.
   *
   * Give the consuming transaction's effects with an explicit `inputVersion` on
   * the object in question — that equality is the whole of the
   * `NotApplied { inputConsumed }` rule.
   */
  readonly transactions?: Readonly<Record<string, FakeOutcome>>
}

/** One call the fake received, in order. */
export interface RecordedCall {
  readonly method: string
  readonly options: unknown
}

/** What a test can do to the fake while it runs. */
export interface SuiCoreFakeState {
  /**
   * The SDK client object the fake implements, for the one place a test needs
   * it directly: `transaction.build({ client })`. Its
   * `core.resolveTransactionPlugin()` is the fake's own resolver, so a
   * transaction resolves against the fake's objects, gas price and coins with
   * no network.
   */
  readonly client: ClientWithCoreApi
  /** Every call the fake has received, oldest first. */
  readonly calls: Effect.Effect<ReadonlyArray<RecordedCall>>
  /** How many calls were aborted by interruption or timeout. */
  readonly aborted: Effect.Effect<number>
  /** Inserts or replaces an object. */
  readonly setObject: (object: FakeObject) => Effect.Effect<void>
  /**
   * The object the fake currently serves for this id, `None` when there is
   * none. What a helper that has to change an object relative to its current
   * state (bumping a version, rewriting content) reads first.
   */
  readonly readObject: (objectId: string) => Effect.Effect<Option.Option<FakeObject>>
  /** Removes an object, so a later read reports it deleted. */
  readonly deleteObject: (objectId: string) => Effect.Effect<void>
  /** Moves the Clock object forward or back. */
  readonly setClock: (timestampMs: bigint) => Effect.Effect<void>
  /** Moves the epoch `getCurrentSystemState` reports. */
  readonly setEpoch: (epoch: bigint) => Effect.Effect<void>
  /**
   * Teaches the fake about one transaction **by digest**, the way
   * `FakeScript.transactions` does for a script written up front.
   */
  readonly recordTransaction: (digest: string, outcome: FakeOutcome) => Effect.Effect<void>
  /** Replaces the remaining scripted outcomes of a method. */
  readonly setOutcomes: (
    method: "simulate" | "execute" | "getTransaction" | "buildSimulate" | "getObject",
    outcomes: ReadonlyArray<FakeOutcome>
  ) => Effect.Effect<void>
}

interface Mutable {
  objects: Map<string, FakeObject>
  /**
   * Which transaction produced each version of each object, keyed by object id
   * and then by version.
   *
   * This is the fake's transaction history, and it exists because the live
   * object only ever names its **latest** mutation: identifying the transaction
   * that consumed a particular version means reading the object *at the version
   * after it*, which is what `SuiCore.getObjectAtVersion` does and what
   * `tryGetPastObject` below serves.
   */
  history: Map<string, Map<string, string | undefined>>
  coins: Array<SuiClientTypes.Coin>
  deleted: Set<string>
  clockTimestampMs: bigint
  epoch: bigint
  calls: Array<RecordedCall>
  aborted: number
  cursors: {
    simulate: number
    execute: number
    getTransaction: number
    buildSimulate: number
    getObject: number
  }
  scripts: {
    simulate: ReadonlyArray<FakeOutcome>
    execute: ReadonlyArray<FakeOutcome>
    getTransaction: ReadonlyArray<FakeOutcome>
    buildSimulate: ReadonlyArray<FakeOutcome>
    getObject: ReadonlyArray<FakeOutcome>
  }
  pendingDigests: Map<string, boolean>
  knownTransactions: Map<string, SettledTransaction>
  /** What the node says about a transaction asked for by digest. */
  byDigest: Map<string, FakeOutcome>
}

/** What a settled call produced, kept so `getTransaction` can serve it again. */
interface SettledTransaction {
  readonly transaction: SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
  readonly failed: boolean
  readonly commandResults: ReadonlyArray<SuiClientTypes.CommandResult>
}

const DEFAULT_GAS: SuiClientTypes.GasCostSummary = {
  computationCost: "1000000",
  storageCost: "2000000",
  storageRebate: "980000",
  nonRefundableStorageFee: "20000"
}

const addressOwner = (address: string): SuiClientTypes.ObjectOwner => ({
  $kind: "AddressOwner",
  AddressOwner: normalizeSuiAddress(address)
})

const clockObject = (timestampMs: bigint): FakeObject => ({
  objectId: SUI_CLOCK_OBJECT_ID,
  type: CLOCK_TYPE,
  version: 1n,
  digest: fakeDigest(6),
  owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
  content: ClockBcs.serialize({
    id: SUI_CLOCK_OBJECT_ID,
    timestamp_ms: timestampMs.toString()
  }).toBytes()
})

/**
 * The SDK shape of an object, with the optional fields served only when the
 * caller asked for them — the way a real node behaves, and what lets a test
 * assert that `Tx.reconcile` sent `previousTransaction` in its include set.
 */
const toSdkObject = (
  object: FakeObject,
  include?: SuiClientTypes.ObjectInclude
): SuiClientTypes.Object<{ content: true }> =>
  ({
    objectId: normalizeSuiAddress(object.objectId),
    version: object.version.toString(),
    digest: object.digest ?? fakeDigest(Number(object.version % 200n) + 1),
    owner: object.owner ?? addressOwner("0x1"),
    type: object.type,
    content: include === undefined || include.content === true ? object.content : undefined,
    previousTransaction: include?.previousTransaction === true
      ? object.previousTransaction ?? null
      : undefined,
    objectBcs: undefined,
    json: undefined,
    display: undefined
  }) as SuiClientTypes.Object<{ content: true }>

const changedObject = (
  change: FakeChange,
  kind: "created" | "mutated" | "deleted"
): SuiClientTypes.ChangedObject => ({
  objectId: normalizeSuiAddress(change.objectId),
  inputState: kind === "created" ? "DoesNotExist" : "Exists",
  inputVersion: kind === "created"
    ? null
    : (change.inputVersion ?? (change.version ?? 2n) - 1n).toString(),
  inputDigest: kind === "created" ? null : fakeDigest(11),
  inputOwner: kind === "created" ? null : (change.owner ?? addressOwner("0x1")),
  outputState:
    change.outputState ?? (kind === "deleted" ? "DoesNotExist" : "ObjectWrite"),
  outputVersion: kind === "deleted" ? null : (change.version ?? 2n).toString(),
  outputDigest: kind === "deleted" ? null : fakeDigest(12),
  outputOwner: kind === "deleted" ? null : (change.owner ?? addressOwner("0x1")),
  idOperation: kind === "created" ? "Created" : kind === "deleted" ? "Deleted" : "None"
})

/** One scripted command result with both of the arrays the wire shape requires. */
const toCommandResult = (
  result: Partial<SuiClientTypes.CommandResult>
): SuiClientTypes.CommandResult => ({
  returnValues: result.returnValues ?? [],
  mutatedReferences: result.mutatedReferences ?? []
})

const commandResultsOf = (
  execution: FakeExecution
): ReadonlyArray<SuiClientTypes.CommandResult> =>
  (execution.commandResults ?? []).map(toCommandResult)

const executionToTransaction = (
  execution: FakeExecution,
  status: SuiClientTypes.ExecutionStatus,
  digest: string
): SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude> => {
  const changes = [
    ...(execution.created ?? []).map((change) => changedObject(change, "created")),
    ...(execution.mutated ?? []).map((change) => changedObject(change, "mutated")),
    ...(execution.deleted ?? []).map((change) => changedObject(change, "deleted"))
  ]
  const objectTypes: Record<string, string> = {}
  for (const change of [
    ...(execution.created ?? []),
    ...(execution.mutated ?? []),
    ...(execution.deleted ?? [])
  ]) {
    objectTypes[normalizeSuiAddress(change.objectId)] = change.type
  }
  return {
    digest,
    signatures: [],
    epoch: "1",
    timestampMs: execution.timestampMs ?? null,
    checkpoint: execution.checkpoint ?? null,
    status,
    balanceChanges: execution.balanceChanges ?? [],
    effects: {
      bcs: null,
      version: 2,
      status,
      gasUsed: execution.gasUsed ?? DEFAULT_GAS,
      transactionDigest: digest,
      gasObject: null,
      eventsDigest: null,
      dependencies: [],
      lamportVersion: "2",
      changedObjects: changes,
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null
    },
    events: execution.events ?? [],
    objectTypes,
    transaction: undefined,
    bcs: undefined
  } as unknown as SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
}

/** A gRPC-shaped rejection, so `mapSdkError` reads `code` off it. */
/** The epoch the fake reports when a script does not set one. */
export const DEFAULT_EPOCH = 100n

/** A plausible `SystemStateInfo` around the one field anything here reads. */
const systemState = (epoch: bigint, timestampMs: bigint): SuiClientTypes.SystemStateInfo => ({
  systemStateVersion: "2",
  epoch: epoch.toString(),
  protocolVersion: "70",
  referenceGasPrice: "1000",
  epochStartTimestampMs: timestampMs.toString(),
  safeMode: false,
  safeModeStorageRewards: "0",
  safeModeComputationRewards: "0",
  safeModeStorageRebates: "0",
  safeModeNonRefundableStorageFee: "0",
  parameters: {
    epochDurationMs: "86400000",
    stakeSubsidyStartEpoch: "0",
    maxValidatorCount: "150",
    minValidatorJoiningStake: "30000000000000000",
    validatorLowStakeThreshold: "20000000000000000",
    validatorLowStakeGracePeriod: "7"
  },
  storageFund: { totalObjectStorageRebates: "0", nonRefundableBalance: "0" },
  stakeSubsidy: {
    balance: "0",
    distributionCounter: "0",
    currentDistributionAmount: "0",
    stakeSubsidyPeriodLength: "10",
    stakeSubsidyDecreaseRate: 1000
  }
})

/**
 * Whether two dynamic-field key encodings are the same bytes.
 *
 * A scripted entry with **no** `bcs` matches any key of its type, which is what
 * a test that only cares about the type wants; two entries of one type on one
 * parent are told apart by their bytes, which is what a test that cares about
 * the key encoding needs and what matching on `name.type` alone made
 * impossible. Never fails.
 */
const sameBytes = (left: Uint8Array | undefined, right: Uint8Array | undefined): boolean => {
  if (left === undefined || right === undefined) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

const rpcError = (status: string): Error => {
  const error = new Error(`fake transport error: ${status}`)
  Object.assign(error, { code: status, name: "RpcError" })
  return error
}

const abortError = (): Error => {
  const error = new Error("The operation was aborted")
  Object.assign(error, { name: "AbortError", code: "DEADLINE_EXCEEDED" })
  return error
}

/** Thrown, and re-thrown as a defect, when a test reaches an unscripted method. */
export class FakeUnimplemented extends Error {
  readonly [DefectMarker] = true
  constructor(readonly method: string) {
    super(
      `SuiCoreFake: ${method} is not scripted. Add it to the script, or use a narrower test.`
    )
    this.name = "FakeUnimplemented"
  }
}

const unimplemented = (method: string): never => {
  throw new FakeUnimplemented(method)
}

/**
 * The in-memory `SuiCore`.
 *
 * Three things about it that a test has to know, because they are not visible
 * from the outside:
 *
 * - **Its `client` implements `$extend`.** `SuiCoreFakeState.client` is a
 *   `ClientWithCoreApi`, so `fake.client.$extend(myExtension(options))` gives a
 *   derived Promise face over the fake and a test can exercise a registration
 *   exactly the way a consumer writes it, with no network.
 * - **`listOwnedObjects` filters like a node.** The `type` option goes through
 *   the same `typeMatches` rule as the BCS bridge, so a bare tag matches every
 *   instantiation of a generic rather than only its own spelling.
 * - **`getDynamicField` matches on `name.type` *and* `name.bcs`.** An entry
 *   scripted without `bcs` still matches any key of its type, which is what a
 *   test that only cares about the type wants; two entries of one type on one
 *   parent are told apart by their bytes, so a test can prove which key encoding
 *   a lookup used.
 * - **Call recording is reached through `SuiTest.calls`.** Every call the fake
 *   received, oldest first, optionally filtered by method:
 *   `yield* SuiTest.calls("getDynamicField")`. That is how a test asserts what
 *   an extension *sent* — the include set on a read, the fact that a recipe
 *   fragment reached exactly one `executeTransaction` — rather than only what it
 *   got back.
 * - **`getTransaction` can be answered by digest.** `FakeScript.transactions`
 *   (and `SuiTest.recordTransaction`) answers a specific digest before the
 *   ordered `getTransaction` script is consulted, which is what `Tx.reconcile`
 *   needs when it follows a pinned object's `previousTransaction` to find out
 *   which version the consuming transaction took. `FakeChange.inputVersion` is
 *   how a test says which version that was.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiCoreFake } from "@unconfirmed/sui-effect/testing"
 *
 * const layer = SuiCoreFake.layer({ chainId: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" })
 * ```
 */
export class SuiCoreFake extends Context.Service<SuiCoreFake, SuiCoreFakeState>()(
  "@unconfirmed/sui-effect/testing/SuiCoreFake"
) {
  /**
   * Provides both `SuiCore` (backed by the fake) and `SuiCoreFake` (the handle a
   * test drives it with). Never fails.
   */
  static readonly layer = (script: FakeScript = {}): Layer.Layer<SuiCore | SuiCoreFake> => {
    const fake = Layer.effect(SuiCoreFake, makeState(script))
    const core = Layer.effect(
      SuiCore,
      Effect.gen(function*() {
        const state = yield* SuiCoreFake
        return (state as InternalState).core
      })
    ).pipe(Layer.provide(fake))
    return Layer.merge(fake, core)
  }
}

interface InternalState extends SuiCoreFakeState {
  readonly core: SuiCoreService
}

const makeState = (script: FakeScript): Effect.Effect<InternalState> =>
  Effect.sync(() => {
    const objects = new Map<string, FakeObject>()
    for (const object of script.objects ?? []) {
      objects.set(normalizeSuiAddress(object.objectId), object)
    }
    const history = new Map<string, Map<string, string | undefined>>()
    for (const object of script.objects ?? []) {
      const id = normalizeSuiAddress(object.objectId)
      history.set(id, new Map([[object.version.toString(), object.previousTransaction]]))
    }
    return makeInternal(script, {
      objects,
      history,
      coins: [...(script.coins ?? [])],
      deleted: new Set(),
      clockTimestampMs: script.clockTimestampMs ?? 1_700_000_000_000n,
      epoch: script.epoch ?? DEFAULT_EPOCH,
      calls: [],
      aborted: 0,
      cursors: { simulate: 0, execute: 0, getTransaction: 0, buildSimulate: 0, getObject: 0 },
      scripts: {
        simulate: script.simulate ?? [],
        execute: script.execute ?? [],
        getTransaction: script.getTransaction ?? [],
        buildSimulate: script.buildSimulate ?? [],
        getObject: script.getObject ?? []
      },
      pendingDigests: new Map(),
      knownTransactions: new Map(),
      byDigest: new Map(Object.entries(script.transactions ?? {}))
    })
  })

const makeInternal = (script: FakeScript, state: Mutable): InternalState => {
  const pageSize = script.pageSize ?? 50
  const chainId = script.chainId ?? "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

  /**
   * The most recent `AbortSignal` the fake was handed.
   *
   * The SDK's `Transaction#build` takes no signal; the only way one reaches a
   * resolver is through the `client` it was given, one Core call at a time. The
   * fake's resolve plugin makes a real Core call for the gas price, so this
   * holds the signal `Tx.build` injected — which is what lets a scripted
   * `buildSimulate: [FakeOutcome.timeoutThen(...)]` block until the build is
   * interrupted, and therefore what lets a test prove that an interrupted build
   * cancels the request it started.
   */
  let lastSignal: AbortSignal | undefined

  const record = (method: string, options: unknown): void => {
    const signal = signalOf(options)
    if (signal !== undefined) lastSignal = signal
    state.calls.push({ method, options })
  }

  /** Remembers which transaction produced one version of one object. */
  const remember = (objectId: string, version: bigint, by: string | undefined): void => {
    const id = normalizeSuiAddress(objectId)
    const versions = state.history.get(id) ?? new Map<string, string | undefined>()
    versions.set(version.toString(), by)
    state.history.set(id, versions)
  }

  const isCoin = (type: string): boolean => {
    try {
      return normalizeStructTag(type).startsWith("0x0000000000000000000000000000000000000000000000000000000000000002::coin::Coin<")
    } catch {
      return false
    }
  }

  /** The object ids a set of signed bytes names as gas payment. */
  const paymentOfBytes = (bytes: Uint8Array): ReadonlyArray<string> => {
    try {
      return (TransactionDataBuilder.fromBytes(bytes).gasData.payment ?? []).map((ref) =>
        normalizeSuiAddress(ref.objectId)
      )
    } catch {
      return []
    }
  }

  /**
   * Evolves the fake's coin set the way an execution would: a coin the
   * transaction deleted is gone, a coin it mutated takes its new version and
   * balance, a gas coin is bumped because gas is always mutated, and a coin the
   * transaction created joins the set.
   *
   * Without this, gas selection in a second build picks the same coins at the
   * same versions the first build already spent, and no lifecycle test can tell
   * a correct selection from a stale one.
   */
  const evolveCoins = (execution: FakeExecution, payment: ReadonlyArray<string>): void => {
    const deleted = new Set(
      (execution.deleted ?? []).map((change) => normalizeSuiAddress(change.objectId))
    )
    const mutated = new Map(
      (execution.mutated ?? []).map((change) => [normalizeSuiAddress(change.objectId), change])
    )
    const next: Array<SuiClientTypes.Coin> = []
    for (const coin of state.coins) {
      const id = normalizeSuiAddress(coin.objectId)
      if (deleted.has(id)) continue
      const change = mutated.get(id)
      if (change !== undefined) {
        next.push({
          ...coin,
          version: (change.version ?? BigInt(coin.version) + 1n).toString(),
          ...(change.balance === undefined ? {} : { balance: change.balance.toString() })
        })
        continue
      }
      if (payment.includes(id)) {
        next.push({ ...coin, version: (BigInt(coin.version) + 1n).toString() })
        continue
      }
      next.push(coin)
    }
    for (const change of execution.created ?? []) {
      if (!isCoin(change.type)) continue
      const id = normalizeSuiAddress(change.objectId)
      if (next.some((coin) => normalizeSuiAddress(coin.objectId) === id)) continue
      next.push({
        objectId: id,
        version: (change.version ?? 2n).toString(),
        digest: fakeDigest(13),
        owner: change.owner ?? addressOwner("0x1"),
        type: change.type,
        balance: (change.balance ?? 0n).toString()
      })
    }
    state.coins = next
  }

  const next = (
    key: "simulate" | "execute" | "getTransaction" | "buildSimulate" | "getObject"
  ): FakeOutcome | undefined => {
    const outcomes = state.scripts[key]
    if (outcomes.length === 0) return undefined
    const index = Math.min(state.cursors[key], outcomes.length - 1)
    state.cursors[key] = state.cursors[key] + 1
    return outcomes[index]
  }

  const waitForAbort = (signal: AbortSignal): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        state.aborted += 1
        reject(abortError())
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          state.aborted += 1
          reject(abortError())
        },
        { once: true }
      )
    })

  const lookup = (objectId: string): FakeObject => {
    const id = normalizeSuiAddress(objectId)
    if (id === normalizeSuiAddress(SUI_CLOCK_OBJECT_ID)) {
      return clockObject(state.clockTimestampMs)
    }
    if (state.deleted.has(id)) {
      throw new ObjectError("deleted", `object ${id} was deleted`, {
        reason: "deleted",
        objectId: id
      })
    }
    const object = state.objects.get(id)
    if (object === undefined) {
      throw new ObjectError("notFound", `object ${id} does not exist`, {
        reason: "notFound",
        objectId: id
      })
    }
    return object
  }

  const applyOutcome = async (
    outcome: FakeOutcome,
    method: "simulate" | "execute" | "getTransaction",
    digest: string,
    executingPayment: ReadonlyArray<string> = []
  ): Promise<SettledTransaction> => {
    switch (outcome._tag) {
      case "transportError":
        throw rpcError(outcome.status)
      case "notFound":
        throw new TransactionError("notFound", digest)
      case "timeoutThen":
        return unimplemented("timeoutThen is handled before applyOutcome")
      case "failWith": {
        const resolved = outcome.value.digest ?? digest
        if (method === "simulate") {
          throw new SimulationError(`Transaction resolution failed: ${outcome.reason.message}`, {
            executionError: outcome.reason
          })
        }
        return {
          transaction: executionToTransaction(
            outcome.value,
            { success: false, error: outcome.reason },
            resolved
          ),
          failed: true,
          commandResults: commandResultsOf(outcome.value)
        }
      }
      case "succeed": {
        const resolved = outcome.value.digest ?? digest
        if (method === "execute") {
          for (const change of [
            ...(outcome.value.created ?? []),
            ...(outcome.value.mutated ?? [])
          ]) {
            const id = normalizeSuiAddress(change.objectId)
            const existing = state.objects.get(id)
            const version = change.version ?? (existing === undefined ? 2n : existing.version + 1n)
            state.objects.set(id, {
              objectId: id,
              type: change.type,
              version,
              content: existing?.content ?? new Uint8Array(),
              // The executing transaction is now what last mutated it, which is
              // what `Tx.reconcile`'s evidence rules read back.
              previousTransaction: resolved,
              ...(change.owner === undefined ? {} : { owner: change.owner })
            })
            remember(id, version, resolved)
          }
          for (const change of outcome.value.deleted ?? []) {
            const id = normalizeSuiAddress(change.objectId)
            const existing = state.objects.get(id)
            // The version the delete produced is still history: it is what
            // names this transaction as the one that consumed the version
            // before it.
            remember(id, change.version ?? (existing === undefined ? 2n : existing.version + 1n), resolved)
            state.objects.delete(id)
            state.deleted.add(id)
          }
          evolveCoins(outcome.value, executingPayment)
        }
        return {
          transaction: executionToTransaction(
            outcome.value,
            { success: true, error: null },
            resolved
          ),
          failed: false,
          commandResults: commandResultsOf(outcome.value)
        }
      }
    }
  }

  const page = <A>(
    items: ReadonlyArray<A>,
    cursor: string | null | undefined,
    limit: number | undefined
  ): { items: ReadonlyArray<A>; hasNextPage: boolean; cursor: string | null } => {
    const start = cursor === null || cursor === undefined ? 0 : Number(cursor)
    const size = limit ?? pageSize
    const slice = items.slice(start, start + size)
    const end = start + slice.length
    const hasNextPage = end < items.length
    return { items: slice, hasNextPage, cursor: hasNextPage ? String(end) : null }
  }

  const signalOf = (options: unknown): AbortSignal | undefined => {
    if (typeof options !== "object" || options === null) return undefined
    const signal = (options as { readonly signal?: unknown }).signal
    return signal instanceof AbortSignal ? signal : undefined
  }

  const pending = async <A>(method: string, options: unknown): Promise<A> => {
    const signal = signalOf(options)
    if (signal === undefined) {
      return unimplemented(`${method} (the fake needs an AbortSignal to model a timeout)`)
    }
    return waitForAbort(signal)
  }

  const METHOD_NAMES = {
    simulate: "simulateTransaction",
    execute: "executeTransaction",
    getTransaction: "getTransaction"
  } as const

  const settle = async (
    method: "simulate" | "execute" | "getTransaction",
    digest: string,
    options: unknown,
    executingPayment: ReadonlyArray<string> = []
  ): Promise<SettledTransaction> => {
    const outcome = next(method) ?? unimplemented(METHOD_NAMES[method])
    if (outcome._tag === "timeoutThen") {
      state.pendingDigests.set(digest, outcome.found)
      return pending<never>(method, options)
    }
    return applyOutcome(outcome, method, digest, executingPayment)
  }

  const asResult = (result: SettledTransaction) =>
    result.failed
      ? { $kind: "FailedTransaction", FailedTransaction: result.transaction }
      : { $kind: "Transaction", Transaction: result.transaction }

  /** Whether two coin types name the same coin, comparing normalized tags. */
  const sameCoinType = (left: string, right: string): boolean => {
    if (left === right) return true
    try {
      return normalizeStructTag(left) === normalizeStructTag(right)
    } catch {
      return false
    }
  }

  /**
   * The balances this owner has, with the owner stripped: an entry that names
   * no owner answers for everyone, which is what a pre-0.1.2 script meant.
   */
  const balancesOf = (owner: string): ReadonlyArray<SuiClientTypes.Balance> => {
    const address = normalizeSuiAddress(owner)
    const matching: Array<SuiClientTypes.Balance> = []
    for (const entry of script.balances ?? []) {
      if (entry.owner !== undefined && normalizeSuiAddress(entry.owner) !== address) continue
      const { owner: _owner, ...balance } = entry
      matching.push(balance)
    }
    return matching
  }

  const coinsOf = (
    owner: string,
    coinType?: string
  ): ReadonlyArray<SuiClientTypes.Coin> => {
    const address = normalizeSuiAddress(owner)
    const wanted = normalizeStructTag(`0x2::coin::Coin<${coinType ?? SUI_TYPE_ARG}>`)
    return state.coins.filter((coin) => {
      if (coin.owner.$kind !== "AddressOwner") return false
      if (normalizeSuiAddress(coin.owner.AddressOwner) !== address) return false
      try {
        return normalizeStructTag(coin.type) === wanted
      } catch {
        return false
      }
    })
  }

  /**
   * The fake's stand-in for the transport's resolve plugin, so
   * `transaction.build({ client })` works with no network.
   *
   * It fills the gas price from the scripted reference gas price, the gas
   * budget from `script.gasBudget` (default 50 MIST-per-unit times the price),
   * gas payment from the scripted coins the payer owns when it is unset (an
   * explicit `[]` is left alone, the way a sponsored transaction wants it), and
   * resolves every `UnresolvedObject` input from the object map, choosing a
   * shared, immutable or owned reference from the stored owner. Everything else
   * — argument normalization, BCS layout, validation — is the SDK's own
   * `TransactionDataBuilder`.
   *
   * It does not run Move, so it cannot resolve an `UnresolvedPure` whose type
   * only the function signature knows: use `tx.pure.u64(...)` and friends.
   */
  const resolvePlugin: TransactionPlugin = async (transactionData, options, proceed) => {
    // A real resolver reads the reference gas price through the client it was
    // given, and that is the only place an `AbortSignal` reaches a resolver at
    // all: `BuildTransactionOptions` has no signal field. Going through the
    // client rather than reading the script directly is what makes an
    // interrupted `Tx.build` observable here.
    const core = options.client?.core ?? client.core
    const { referenceGasPrice } = await core.getReferenceGasPrice({})
    // A real transport's resolver simulates to choose the gas budget, which is
    // why `Tx.build` can fail with `SimulationFailed` — and why "building
    // always simulates" has to be observable here. The call is **recorded**
    // whether or not a script drives it, so `SuiTest.calls("simulateTransaction")`
    // counts the build's simulate the way it counts every other call; before
    // 0.1.2 a build on the fake recorded nothing and a conversion moving onto
    // this build could not see its own simulate at all.
    //
    // Which script answers it: `buildSimulate` when there is one — the slot
    // that exists precisely for the resolver's simulate — and otherwise the
    // ordered `simulate` script, so `simulate: [FakeOutcome.failWith(...)]`
    // surfaces through `Tx.build` as the `SimulationFailed` a node would give.
    // With neither, the resolver sets the budget from `script.gasBudget` and
    // the recorded call is the only trace.
    record("simulateTransaction", {
      transaction: undefined,
      checks: "enabled",
      resolver: true,
      signal: lastSignal
    })
    const budgetOutcome = state.scripts.buildSimulate.length > 0
      ? next("buildSimulate")
      : state.scripts.simulate.length > 0
      ? next("simulate")
      : undefined
    if (budgetOutcome !== undefined) {
      if (budgetOutcome._tag === "timeoutThen") {
        // Never settles until the build is interrupted, which is exactly what a
        // resolver's in-flight simulate does.
        if (lastSignal === undefined) {
          return unimplemented(
            "buildSimulate timeoutThen (no AbortSignal reached the resolver; build through Tx.build)"
          )
        }
        await waitForAbort(lastSignal)
      }
      await applyOutcome(budgetOutcome, "simulate", fakeDigest(state.calls.length + 200))
    }
    if (!options.onlyTransactionKind) {
      if (!transactionData.gasData.price) {
        transactionData.gasData.price = String(referenceGasPrice)
      }
      if (!transactionData.gasData.budget) {
        transactionData.gasData.budget = String(script.gasBudget ?? 50_000_000n)
      }
    }
    transactionData.inputs.forEach((input, index) => {
      const unresolved = input.UnresolvedObject
      if (!unresolved) return
      const id = normalizeSuiAddress(unresolved.objectId)
      const object = lookup(id)
      const owner = object.owner ?? addressOwner("0x1")
      const initialSharedVersion = owner.$kind === "Shared"
        ? owner.Shared.initialSharedVersion
        : owner.$kind === "ConsensusAddressOwner"
        ? owner.ConsensusAddressOwner.startVersion
        : null
      const shared = unresolved.initialSharedVersion ?? initialSharedVersion
      transactionData.inputs[index] = shared
        ? Inputs.SharedObjectRef({
          objectId: id,
          initialSharedVersion: shared,
          mutable: unresolved.mutable ?? true
        })
        : Inputs.ObjectRef({
          objectId: id,
          digest: unresolved.digest ?? toSdkObject(object).digest,
          version: unresolved.version ?? object.version.toString()
        })
    })
    if (!options.onlyTransactionKind && transactionData.gasData.payment == null) {
      const payer = transactionData.gasData.owner ?? transactionData.sender
      // A gas coin may not also be an input of the transaction: the SDK
      // documents the prohibition and a validator enforces it. Resolving the
      // inputs first and then excluding them is what a real transport does.
      const inputIds = new Set<string>()
      for (const input of transactionData.inputs) {
        const owned = input.Object?.ImmOrOwnedObject ?? input.Object?.Receiving
        if (owned !== undefined) inputIds.add(normalizeSuiAddress(owned.objectId))
      }
      const coins = payer === null
        ? []
        : coinsOf(payer).filter((coin) => !inputIds.has(normalizeSuiAddress(coin.objectId)))
      transactionData.gasData.payment = coins.map((coin) => ({
        objectId: coin.objectId,
        version: coin.version,
        digest: coin.digest
      }))
    }
    await proceed()
  }

  /**
   * Refuses a submission whose signatures do not cover the addresses the bytes
   * name as signers, the way a validator refuses it.
   *
   * A transaction takes a signature from its sender and, when its gas owner is
   * someone else, from that party too; one signature on sponsored bytes is
   * something a validator rejects outright. Two checks, in order: the **count**
   * (fewer signatures than distinct signers), and the **addresses** — every
   * signature whose public key can be read is turned back into the address it
   * signs as, and a required address nobody signed for is a refusal. A
   * signature the SDK cannot parse (a multisig, a zkLogin proof, a fixture that
   * is not a real signature) makes the address check stand down, so only the
   * count applies there.
   *
   * **It rejects the way a gRPC node does**: an `RpcError` carrying
   * `INVALID_ARGUMENT`, which `mapSdkError` turns into
   * `TransportError { retryable: false, status: "INVALID_ARGUMENT" }` and which
   * `Tx.submit` reports as-is rather than reconciling. A plain `Error` here was
   * classified as a retryable transport failure, so `Tx.submit` retried it,
   * reconciled, and a scripted `getTransaction: succeed` reported a **success**
   * for bytes no validator would have accepted.
   *
   * A sponsored submission against the fake therefore needs `Tx.cosign` (or
   * `Tx.run`'s `sponsor`) first, exactly as it does against a node.
   */
  const signerAddressesOf = (
    signatures: ReadonlyArray<string>
  ): ReadonlyArray<string> | undefined => {
    const addresses: Array<string> = []
    for (const signature of signatures) {
      try {
        const parsed = parseSerializedSignature(signature)
        if (parsed.signatureScheme === "MultiSig" || parsed.signatureScheme === "ZkLogin") {
          return undefined
        }
        addresses.push(
          normalizeSuiAddress(
            publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey).toSuiAddress()
          )
        )
      } catch {
        // A multisig, a zkLogin signature, or a fixture that is not a real
        // signature at all: the address check cannot speak about this set.
        return undefined
      }
    }
    return addresses
  }

  const refuse = (message: string): never => {
    const error = new Error(`fake validator: ${message}`)
    Object.assign(error, { code: "INVALID_ARGUMENT", name: "RpcError" })
    throw error
  }

  const assertSignatures = (bytes: Uint8Array, signatures: ReadonlyArray<string>): void => {
    let required: ReadonlyArray<string>
    try {
      const data = TransactionDataBuilder.fromBytes(bytes)
      required = [...new Set(
        [data.sender, data.gasData.owner]
          .filter((address): address is string => typeof address === "string" && address.length > 0)
          .map((address) => normalizeSuiAddress(address))
      )]
    } catch {
      return
    }
    if (signatures.length < required.length) {
      refuse(
        `these bytes name ${required.length} signer(s) (${required.join(", ")})` +
          ` and carry ${signatures.length} signature(s).` +
          (required.length > 1
            ? " A sponsored transaction is signed by both parties: Tx.cosign the" +
              " signed bytes with the gas owner's signer, or use Tx.run(recipe," +
              " { signer, sponsor })."
            : "")
      )
    }
    const signed = signerAddressesOf(signatures)
    if (signed === undefined) return
    const missing = required.filter((address) => !signed.includes(address))
    if (missing.length > 0) {
      refuse(
        `these bytes name ${missing.join(", ")} as (a) signer(s) and carry no signature` +
          ` from ${missing.length === 1 ? "that address" : "those addresses"}` +
          ` (the signatures are from ${signed.join(", ")})`
      )
    }
  }

  /** The digest of the bytes that were handed to us, as the network derives it. */
  const digestOfBytes = (bytes: Uint8Array): string => {
    try {
      return TransactionDataBuilder.getDigestFromBytes(bytes)
    } catch {
      return fakeDigest(state.calls.length + 1)
    }
  }

  /**
   * The scripted read failure for this `getObject` call, if a script asked for
   * one. `succeed` (and an exhausted or absent script) means "serve the object
   * map", which is the normal path.
   */
  const readOutcome = async (options: SuiClientTypes.GetObjectOptions): Promise<void> => {
    if (state.scripts.getObject.length === 0) return
    const outcome = next("getObject")
    if (outcome === undefined) return
    switch (outcome._tag) {
      case "transportError":
        throw rpcError(outcome.status)
      case "notFound":
        throw new ObjectError("notFound", `object ${options.objectId} does not exist`, {
          reason: "notFound",
          objectId: normalizeSuiAddress(options.objectId)
        })
      case "timeoutThen":
        await pending<never>("getObject", options)
        return
      default:
        return
    }
  }

  const core = {
    getObject: async (options: SuiClientTypes.GetObjectOptions) => {
      record("getObject", options)
      await readOutcome(options)
      return { object: toSdkObject(lookup(options.objectId), options.include) }
    },
    getObjects: async (options: SuiClientTypes.GetObjectsOptions) => {
      record("getObjects", options)
      return {
        objects: options.objectIds.map((id) => {
          try {
            return toSdkObject(lookup(id), options.include)
          } catch (cause) {
            return cause as Error
          }
        })
      }
    },
    listOwnedObjects: async (options: SuiClientTypes.ListOwnedObjectsOptions) => {
      record("listOwnedObjects", options)
      const owner = normalizeSuiAddress(options.owner)
      const owned = [...state.objects.values()].filter((object) => {
        const objectOwner = object.owner ?? addressOwner("0x1")
        if (objectOwner.$kind !== "AddressOwner") return false
        if (normalizeSuiAddress(objectOwner.AddressOwner) !== owner) return false
        // A node matches a bare type filter against every instantiation of a
        // generic; exact string equality here would hide `Composition<Share>`
        // from a `streamOwnedObjects(owner, { type: "pkg::m::Composition" })`.
        return options.type === undefined || typeMatches(options.type, object.type)
      })
      const result = page(owned, options.cursor, options.limit)
      return {
        objects: result.items.map((object) => toSdkObject(object, options.include)),
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    listCoins: async (options: SuiClientTypes.ListCoinsOptions) => {
      record("listCoins", options)
      const result = page(coinsOf(options.owner, options.coinType), options.cursor, options.limit)
      return {
        objects: result.items as Array<SuiClientTypes.Coin>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    listDynamicFields: async (options: SuiClientTypes.ListDynamicFieldsOptions) => {
      record("listDynamicFields", options)
      const fields = script.dynamicFields?.[normalizeSuiAddress(options.parentId)] ?? []
      const result = page(fields, options.cursor, options.limit)
      return {
        dynamicFields: result.items as Array<SuiClientTypes.DynamicFieldEntry>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    getDynamicField: async (options: SuiClientTypes.GetDynamicFieldOptions) => {
      record("getDynamicField", options)
      const parent = normalizeSuiAddress(options.parentId)
      const entry = (script.dynamicFields?.[parent] ?? []).find(
        (field) =>
          field.name.type === options.name.type && sameBytes(field.name.bcs, options.name.bcs)
      )
      if (entry === undefined) {
        throw new ObjectError("notFound", "dynamic field not found", {
          reason: "notFound",
          objectId: parent
        })
      }
      const value = script.dynamicFieldValues?.[entry.fieldId] ?? {
        type: entry.valueType,
        bcs: new Uint8Array()
      }
      return {
        dynamicField: {
          ...entry,
          value,
          version: "1",
          digest: fakeDigest(21),
          previousTransaction: null
        } as SuiClientTypes.DynamicField
      }
    },
    getDynamicObjectField: async (options: SuiClientTypes.GetDynamicObjectFieldOptions) => {
      record("getDynamicObjectField", options)
      return unimplemented("getDynamicObjectField")
    },
    getBalance: async (options: SuiClientTypes.GetBalanceOptions) => {
      record("getBalance", options)
      const coinType = options.coinType ?? SUI_TYPE_ARG
      const balance = balancesOf(options.owner).find((item) => sameCoinType(item.coinType, coinType))
      return {
        balance: balance ?? { coinType, balance: "0", coinBalance: "0", addressBalance: "0" }
      }
    },
    listBalances: async (options: SuiClientTypes.ListBalancesOptions) => {
      record("listBalances", options)
      const result = page(balancesOf(options.owner), options.cursor, options.limit)
      return {
        balances: result.items as Array<SuiClientTypes.Balance>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    getCoinMetadata: async (options: SuiClientTypes.GetCoinMetadataOptions) => {
      record("getCoinMetadata", options)
      if (script.coinMetadata === undefined) return unimplemented("getCoinMetadata")
      const metadata = script.coinMetadata[options.coinType]
      // A node answers `null` for a coin type with no metadata object, so the
      // fake does too rather than dying: "there is none" is an answer.
      return { coinMetadata: metadata ?? null }
    },
    getTransaction: async (options: SuiClientTypes.GetTransactionOptions) => {
      record("getTransaction", options)
      const pending = state.pendingDigests.get(options.digest)
      if (pending === false) throw new TransactionError("notFound", options.digest)
      // Keyed by digest, so following one object's `previousTransaction` to the
      // transaction that consumed it does not eat an entry of the ordered
      // script, which is about *this* transaction and not about that one.
      const recorded = state.byDigest.get(options.digest)
      if (recorded !== undefined && recorded._tag !== "timeoutThen") {
        return asResult(await applyOutcome(recorded, "getTransaction", options.digest))
      }
      const known = state.knownTransactions.get(options.digest)
      if (known !== undefined && state.scripts.getTransaction.length === 0) {
        return asResult(known)
      }
      return asResult(await settle("getTransaction", options.digest, options))
    },
    executeTransaction: async (options: SuiClientTypes.ExecuteTransactionOptions) => {
      record("executeTransaction", options)
      const digest = digestOfBytes(options.transaction)
      assertSignatures(options.transaction, options.signatures ?? [])
      const known = state.knownTransactions.get(digest)
      if (known !== undefined) {
        // Re-submitting identical bytes is what `Tx.submit` does after a
        // retryable transport failure, and a validator answers with the
        // recorded result rather than executing again. Re-applying the scripted
        // changes here took an object from version 3 to version 5 and made
        // replay idempotency untestable.
        return asResult(known)
      }
      const settled = await settle("execute", digest, options, paymentOfBytes(options.transaction))
      state.knownTransactions.set(digest, settled)
      return asResult(settled)
    },
    signAndExecuteTransaction: async (
      options: SuiClientTypes.SignAndExecuteTransactionOptions
    ) => {
      record("signAndExecuteTransaction", options)
      return unimplemented("signAndExecuteTransaction")
    },
    waitForTransaction: async (options: SuiClientTypes.WaitForTransactionOptions) => {
      record("waitForTransaction", options)
      const digest = "digest" in options && options.digest !== undefined
        ? options.digest
        : fakeDigest(1)
      const pending = state.pendingDigests.get(digest)
      if (pending === false) throw new TransactionError("notFound", digest)
      // A transaction this fake executed is visible: the visibility wait
      // `Tx.submit` makes after a successful execute must not consume the
      // `getTransaction` script a reconcile test set up.
      const known = state.knownTransactions.get(digest)
      if (known !== undefined) return asResult(known)
      return asResult(await settle("getTransaction", digest, options))
    },
    simulateTransaction: async (options: SuiClientTypes.SimulateTransactionOptions) => {
      record("simulateTransaction", options)
      const digest = options.transaction instanceof Uint8Array
        ? digestOfBytes(options.transaction)
        : fakeDigest(state.calls.length + 100)
      const result = await settle("simulate", digest, options)
      return { ...asResult(result), commandResults: result.commandResults }
    },
    listTransactions: async (options: SuiClientTypes.ListTransactionsOptions) => {
      record("listTransactions", options)
      return unimplemented("listTransactions")
    },
    listEvents: async (options: SuiClientTypes.ListEventsOptions) => {
      record("listEvents", options)
      return unimplemented("listEvents")
    },
    getReferenceGasPrice: async (options?: SuiClientTypes.GetReferenceGasPriceOptions) => {
      record("getReferenceGasPrice", options)
      return { referenceGasPrice: (script.referenceGasPrice ?? 1000n).toString() }
    },
    getCurrentSystemState: async (options?: SuiClientTypes.GetCurrentSystemStateOptions) => {
      record("getCurrentSystemState", options)
      return { systemState: systemState(state.epoch, state.clockTimestampMs) }
    },
    getProtocolConfig: async (options?: SuiClientTypes.GetProtocolConfigOptions) => {
      record("getProtocolConfig", options)
      return unimplemented("getProtocolConfig")
    },
    getChainIdentifier: async (options?: SuiClientTypes.GetChainIdentifierOptions) => {
      record("getChainIdentifier", options)
      return { chainIdentifier: chainId }
    },
    getMoveFunction: async (options: SuiClientTypes.GetMoveFunctionOptions) => {
      record("getMoveFunction", options)
      return unimplemented("getMoveFunction")
    },
    verifyZkLoginSignature: async (options: SuiClientTypes.VerifyZkLoginSignatureOptions) => {
      record("verifyZkLoginSignature", options)
      return unimplemented("verifyZkLoginSignature")
    },
    resolveNameServiceAddress: async (
      options: SuiClientTypes.ResolveNameServiceAddressOptions
    ) => {
      record("resolveNameServiceAddress", options)
      return unimplemented("resolveNameServiceAddress")
    },
    defaultNameServiceName: async (options: SuiClientTypes.DefaultNameServiceNameOptions) => {
      record("defaultNameServiceName", options)
      return unimplemented("defaultNameServiceName")
    },
    mvr: {
      resolvePackage: async (options: SuiClientTypes.MvrResolvePackageOptions) => {
        record("mvr.resolvePackage", options)
        return unimplemented("mvr.resolvePackage")
      },
      resolveType: async (options: SuiClientTypes.MvrResolveTypeOptions) => {
        record("mvr.resolveType", options)
        return unimplemented("mvr.resolveType")
      },
      resolve: async (options: SuiClientTypes.MvrResolveOptions) => {
        record("mvr.resolve", options)
        return unimplemented("mvr.resolve")
      }
    },
    resolveTransactionPlugin: () => resolvePlugin
  }

  /**
   * The historical object read, in the JSON-RPC `sui_tryGetPastObject` shape.
   *
   * `SuiCore.getObjectAtVersion` duck-types this method, so implementing it is
   * what gives the fake a transaction history and lets `Tx.reconcile` identify
   * the consumer of a pinned version the way it does against a real node. A
   * version the fake never recorded answers `VersionNotFound`, which is
   * evidence of nothing.
   */
  const tryGetPastObject = async (options: {
    readonly id: string
    readonly version: number
    readonly options?: { readonly showPreviousTransaction?: boolean }
    readonly signal?: AbortSignal
  }) => {
    record("tryGetPastObject", options)
    const id = normalizeSuiAddress(options.id)
    const versions = state.history.get(id)
    const version = String(options.version)
    if (versions === undefined || !versions.has(version)) {
      return { status: "VersionNotFound" as const, details: [id, version] as [string, string] }
    }
    return {
      status: "VersionFound" as const,
      details: {
        objectId: id,
        version,
        previousTransaction: versions.get(version) ?? null
      }
    }
  }

  const client: ClientWithCoreApi = {
    network: script.network ?? "localnet",
    cache: undefined,
    core,
    tryGetPastObject,
    // The SDK's registration mechanism, implemented so an extension's derived
    // Promise face can be tested exactly the way a consumer writes it:
    // `client.$extend(myExtension())` — variadic, and chainable, because the
    // SDK's is both and a test that chains two registrations must not silently
    // lose the first.
    $extend(
      this: ClientWithCoreApi | undefined,
      ...registrations: ReadonlyArray<
        { readonly name: string; readonly register: (client: ClientWithCoreApi) => unknown }
      >
    ) {
      const base = (this ?? client) as ClientWithCoreApi
      return Object.assign(
        Object.create(Object.getPrototypeOf(base) ?? Object.prototype),
        base,
        Object.fromEntries(
          // `client`, not `base`: the registration gets the one underlying
          // client object, so two registrations on it share a base `Sui` the
          // way they do against a real client.
          registrations.map((registration) => [registration.name, registration.register(client)])
        )
      )
    }
  } as unknown as ClientWithCoreApi

  return {
    core: makeFromClient(client),
    client,
    calls: Effect.sync(() => [...state.calls]),
    aborted: Effect.sync(() => state.aborted),
    readObject: (objectId) =>
      Effect.sync(() => Option.fromNullishOr(state.objects.get(normalizeSuiAddress(objectId)))),
    setObject: (object) =>
      Effect.sync(() => {
        const id = normalizeSuiAddress(object.objectId)
        state.objects.set(id, object)
        state.deleted.delete(id)
        // Every version the fake has ever served is history, which is what a
        // versioned read asks for. `SuiTest.bumpVersion(id, { consumedBy })`
        // lands here, so "someone else spent this version" is recorded at the
        // version it produced.
        remember(id, object.version, object.previousTransaction)
      }),
    deleteObject: (objectId) =>
      Effect.sync(() => {
        const id = normalizeSuiAddress(objectId)
        state.objects.delete(id)
        state.deleted.add(id)
      }),
    setClock: (timestampMs) =>
      Effect.sync(() => {
        state.clockTimestampMs = timestampMs
      }),
    setEpoch: (epoch) =>
      Effect.sync(() => {
        state.epoch = epoch
      }),
    recordTransaction: (digest, outcome) =>
      Effect.sync(() => {
        state.byDigest.set(digest, outcome)
      }),
    setOutcomes: (method, outcomes) =>
      Effect.sync(() => {
        state.scripts = { ...state.scripts, [method]: outcomes }
        state.cursors = { ...state.cursors, [method]: 0 }
      })
  }
}
