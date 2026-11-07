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
import { bcs, TypeTagSerializer } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"
import { Inputs, TransactionDataBuilder } from "@mysten/sui/transactions"
import { parseSerializedSignature } from "@mysten/sui/cryptography"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { publicKeyFromRawBytes } from "@mysten/sui/verify"
import type { Argument, TransactionPlugin } from "@mysten/sui/transactions"
import {
  deriveDynamicFieldID,
  fromBase58,
  fromBase64,
  fromHex,
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
  SUI_TYPE_ARG,
  toBase58,
  toHex
} from "@mysten/sui/utils"
import { Context, Effect, Layer, Option, Result, Schema } from "effect"
import {
  ADDRESS_ALIAS_STATE_ID,
  ADDRESS_ALIASES_TYPE,
  AddressAliasesBcs,
  aliasesId,
  MAX_ALIASES
} from "../domain/address-alias.ts"
import { typeMatches } from "../domain/bcs.ts"
import { Digest, ExecutionReason } from "../domain/schemas.ts"
import type { SuiCoreReadOptions, SuiCoreService } from "./SuiCore.ts"
import { DefectMarker, makeFromClient, SuiCore } from "./SuiCore.ts"

/** The BCS layout of `0x2::clock::Clock`. */
export const ClockBcs = bcs.struct("Clock", {
  id: bcs.Address,
  timestamp_ms: bcs.U64
})

/** The Move type of the Clock object. */
export const CLOCK_TYPE = "0x2::clock::Clock"

/**
 * A deterministic base58 32-byte digest, for fixtures, already branded as a
 * {@link Digest} so it compares with `executed.digest` and fills any field
 * typed `Digest` without a cast. Never fails.
 */
export const fakeDigest = (seed: number): Digest => {
  const bytes = new Uint8Array(32)
  bytes[0] = (seed % 255) + 1
  bytes[31] = 7
  return Digest.make(toBase58(bytes))
}

/**
 * A gas coin for {@link FakeScript.coins}, in the SDK's `SuiClientTypes.Coin`
 * shape, with the fields a fixture rarely cares about filled in: `coinType`
 * defaults to SUI, `version` to 1 and `digest` to a {@link fakeDigest}. `owner`
 * is an address; the coin is `AddressOwner`-owned by it. Never fails.
 *
 * @since 0.4.0
 *
 * @example
 * ```ts
 * import { fakeCoin, layerTest } from "@unconfirmed/sui-effect/testing"
 *
 * const layer = layerTest({
 *   coins: [fakeCoin({ objectId: "0xc01", owner: signer.address, balance: 1_000_000_000n })]
 * })
 * ```
 */
export const fakeCoin = (options: {
  readonly objectId: string
  readonly owner: string
  readonly balance: bigint
  readonly coinType?: string
  readonly version?: bigint
  readonly digest?: string
}): SuiClientTypes.Coin => ({
  objectId: normalizeSuiAddress(options.objectId),
  version: (options.version ?? 1n).toString(),
  digest: options.digest ?? fakeDigest(Number((options.version ?? 1n) % 200n) + 40),
  owner: addressOwner(options.owner),
  type: `0x2::coin::Coin<${options.coinType ?? SUI_TYPE_ARG}>`,
  balance: options.balance.toString()
})

/**
 * An event in a scripted execution: the SDK's `SuiClientTypes.Event` with
 * `json` **optional**, because the library's own {@link Event} treats it as
 * the node's rendering and never reads it. Leave it out; give it only to test
 * code that reads `event.json` off a listing.
 *
 * @since 0.4.0
 */
export type FakeEvent = Omit<SuiClientTypes.Event, "json"> & {
  readonly json?: SuiClientTypes.Event["json"]
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
  /**
   * The node's JSON rendering of the content, served when the caller includes
   * `json` (`null` when this is left out, as a node with nothing to render
   * answers).
   *
   * @since 0.5.0
   */
  readonly json?: Record<string, unknown>
  /**
   * The Display output, served when the caller includes `display` (`null` when
   * this is left out: the type has no Display template).
   *
   * @since 0.5.0
   */
  readonly display?: SuiClientTypes.Display
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
  /**
   * The owner going **in**, for a transaction that moved the object: a transfer
   * is `inputOwner` the sender and `owner` the recipient, which is what
   * `checkClaims` and `transferred()` (on `Simulation` and `Executed`) read.
   * Defaults to `owner`, an object that stayed put.
   *
   * @since 0.5.0
   */
  readonly inputOwner?: SuiClientTypes.ObjectOwner
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
  /**
   * The transaction's digest. Leave it out for an `execute` outcome: the fake
   * derives the digest from the bytes it was handed, as a node does, and an
   * execute scripted with a **different** digest dies naming both. Give it for
   * a `simulate` of an unbuilt transaction, for a transaction scripted by
   * digest, or for a `getTransaction` answer.
   */
  readonly digest?: string
  readonly created?: ReadonlyArray<FakeChange>
  readonly mutated?: ReadonlyArray<FakeChange>
  readonly deleted?: ReadonlyArray<FakeChange>
  /**
   * The events the execution emitted. `json` may be left out (see
   * {@link FakeEvent}); `bcs` is what `Executed.eventsOf` decodes.
   */
  readonly events?: ReadonlyArray<FakeEvent>
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
  /**
   * The sender `listTransactions`' `sender` filter matches, for a transaction
   * scripted by digest (`FakeScript.transactions`). A transaction the fake
   * executed takes its sender from its bytes, and this is ignored.
   *
   * @since 0.4.0
   */
  readonly sender?: string
  /**
   * The Move calls, as `package::module::function`, that `listTransactions`'
   * `function` filter matches, for a transaction scripted by digest. A
   * transaction the fake executed takes them from its bytes' commands.
   *
   * @since 0.4.0
   */
  readonly moveCalls?: ReadonlyArray<string>
}

/** One scripted outcome of a call. The last entry of a script repeats forever. */
export type FakeOutcome =
  | { readonly _tag: "succeed"; readonly value: FakeExecution }
  | { readonly _tag: "failWith"; readonly reason: SuiClientTypes.ExecutionError; readonly value: FakeExecution }
  | { readonly _tag: "transportError"; readonly status: string; readonly message?: string }
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
  /**
   * The call rejects with a gRPC status, as `RpcError` would. `message` is the
   * node's text, for a test about what a refusal *says* — a validator's
   * "already locked by a different transaction" is a `FAILED_PRECONDITION`
   * whose message names the conflicting digest.
   */
  transportError: (status: string, message?: string): FakeOutcome =>
    message === undefined ? { _tag: "transportError", status } : { _tag: "transportError", status, message },
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
 * Since 0.4.0 `addressBalance` is a **seed**, not a constant: it is the
 * starting value of the fake's address balance for that owner and coin type,
 * which an execution then moves (gas paid from the balance, `FundsWithdrawal`
 * debits, `send_funds` deposits) and `SuiTest.setAddressBalance` replaces. An
 * owner-specific entry seeds its owner; otherwise the first owner-less entry of
 * the coin type seeds every owner. `coinBalance` is served as written, and
 * `balance` is served as `balance - addressBalance + <current address balance>`,
 * so an entry nothing has touched comes back verbatim.
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
   * The balances `getBalance` and `listBalances` serve, and the seeds of the
   * fake's **address balances**.
   *
   * Keyed by **owner and coin type**: an entry with an `owner` answers only for
   * that address, and one without answers for any, which is what a script
   * written before 0.1.2 meant. An owner-specific entry wins over an owner-less
   * one of the same coin type.
   *
   * Since 0.4.0 the fake keeps one address balance per owner and coin type,
   * seeded lazily from the entry's `addressBalance` (0 when no entry names the
   * type) and moved by every execution it settles (see {@link FakeBalance}).
   * For an owner and coin type no entry names, `coinBalance` is the sum of the
   * owner's coins of that type in the fake's coin set and `balance` is that
   * plus the address balance — so an address that holds none of the coin
   * answers zero, the way a node does. `listBalances` serves the matching
   * entries, then every coin type the owner holds coins of or has a non-zero
   * address balance in that no entry names.
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
  /**
   * The dynamic fields of each parent, keyed by parent id.
   *
   * An entry of `$kind: "DynamicObject"` is a dynamic **object** field:
   * `getDynamicObjectField` finds it by the key's own type and bytes (or by
   * the `0x2::dynamic_object_field::Wrapper<…>` of that type, which is how a
   * node lists it) and serves the object its `childId` names from the object
   * map.
   */
  readonly dynamicFields?: Readonly<Record<string, ReadonlyArray<SuiClientTypes.DynamicFieldEntry>>>
  /**
   * The value `getDynamicField` serves for an entry of {@link dynamicFields},
   * keyed by that entry's **`fieldId`** (not by the parent, and not by the
   * key). `type` is the value's Move type and `bcs` its BCS bytes — what
   * `sui.getDynamicField(parent, name, { schema })` decodes. An entry with no
   * value here is served with empty bytes and its own `valueType`, which
   * decodes only as an empty layout. Dynamic **object** fields do not use it:
   * their value is the object `childId` names in the object map.
   */
  readonly dynamicFieldValues?: Readonly<Record<string, SuiClientTypes.DynamicFieldValue>>
  /** How many items a list method returns per page. Defaults to 50. */
  readonly pageSize?: number
  /**
   * How many ledger items one `listEvents` or `listTransactions` request
   * **examines**, matching or not. Unset, a request scans as far as it needs.
   *
   * This is the gRPC server's scan bound: with a filter that matches rarely, a
   * page can come back short — even empty — with `hasNextPage: true`, and
   * continuing from `endCursor` still makes progress. Set it to prove a
   * consumer paginates on `hasNextPage` rather than on the item count.
   *
   * @since 0.4.0
   */
  readonly scanLimit?: number
  /**
   * The SuiNS names the fake knows, name to target address.
   * `resolveNameServiceAddress` answers `null` for a name the record does not
   * hold, and `defaultNameServiceName` answers the **first** name that targets
   * the address, or `null`. Unscripted, both die naming themselves.
   *
   * @since 0.4.0
   */
  readonly names?: Readonly<Record<string, string>>
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
   * What the resolve plugin's budget simulation answers during
   * `transaction.build({ client })` — which `Tx.build` always reaches, since
   * it sets no budget up front.
   *
   * The resolver simulates whenever the transaction has no gas budget yet, and
   * that call is **always recorded** as a `simulateTransaction` with
   * `resolver: true`, scripted or not. It is answered by this script when it
   * has entries, else by the ordered {@link simulate} script (so
   * `simulate: [FakeOutcome.failWith(...)]` surfaces through `Tx.build` too),
   * else not at all, and the budget comes from {@link gasBudget}. Script
   * `failWith` here to make `Tx.build` fail with `SimulationFailed` without
   * touching the `simulate` script a later `Tx.verify` or `preflight` reads;
   * `timeoutThen` blocks the build until it is interrupted.
   *
   * Since 0.5.0 it also answers, in turn, an ordinary `simulateTransaction`
   * when the {@link simulate} script is empty: a test that scripted the build's
   * simulation alone no longer dies with `FakeUnimplemented` on the preflight
   * simulate after it. With neither script, that simulate still dies, naming
   * `simulate` / `SuiTest.scriptSimulate`.
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
  /**
   * How long `waitForTransaction` takes to see a transaction this fake
   * executed, in **real** milliseconds, or `"never"`: the wait does not settle
   * until the caller's `AbortSignal` fires (a `SubmitConfig.visibilityTimeout`
   * on a `TestClock`, or an interruption). Unset, a transaction is visible the
   * moment it executes.
   *
   * This is how a test reaches the window between "the node answered the
   * execute" and "the transaction is visible to reads" — the window `Tx.submit`
   * spends in its visibility wait, where an interrupt or a timeout must not
   * lose the `Executed` it already has. Change it mid-test with
   * `SuiTest.setVisibilityDelay`.
   *
   * @since 0.4.0
   */
  readonly visibilityDelay?: number | "never"
  /**
   * The history the node still holds, served through `client.ledgerService`
   * the way a gRPC node serves `GetServiceInfo.lowestAvailableCheckpoint` and
   * `GetEpoch.firstCheckpoint`.
   *
   * `Tx.reconcile` reads it before it calls a `getTransaction` miss evidence
   * of expiry: a node that has pruned into a transaction's validity window
   * misses transactions that did apply. `firstCheckpoints` is keyed by epoch;
   * an epoch it does not name answers `NOT_FOUND`, the way a node that pruned
   * the epoch does. Unscripted, the client has no `ledgerService` at all, which
   * is what a JSON-RPC or GraphQL transport looks like.
   *
   * Scripted (`ledger: {}` is enough), the ledger service also answers
   * `ListTransactions` with an `affectedAddress` predicate from the fake's
   * transaction history — executed and `FakeScript.transactions` alike — which
   * is what `Sui.streamTransactions({ affectedAddress })` reads (0.5.0). A
   * transaction affects an address when the address sent it, a balance change
   * names it, or an object it owned before or after changed.
   *
   * @since 0.4.0
   */
  readonly ledger?: {
    readonly lowestAvailableCheckpoint?: bigint
    readonly firstCheckpoints?: Readonly<Record<string, bigint>>
  }
  /**
   * The read options the fake's `SuiCore` is built with — what
   * `SuiCore.layerGrpc(..., { readRetry, requestTimeout })` would be given —
   * so a test can prove a read, or `Tx.build`'s resolver retry, runs under a
   * custom `readRetry`. Unscripted, the defaults.
   *
   * @since 0.4.0
   */
  readonly readOptions?: SuiCoreReadOptions
  /**
   * Address alias sets (`0x2::address_alias`), keyed by address: each becomes
   * the address's `AddressAliases` object at its derived id (BCS content,
   * party-owned by the address), which is what `AddressAlias.getAliases` reads
   * and what the fake's signature check consults. An address not named here
   * has not enabled aliases. Executions of `0x2::address_alias::enable`, `add`,
   * `remove` and `replace_all` then edit the sets, and
   * `SuiTest.setAddressAliases` replaces one.
   *
   * @since 0.6.0
   */
  readonly addressAliases?: Readonly<Record<string, ReadonlyArray<string>>>
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
   * Replaces {@link FakeScript.visibilityDelay}; `undefined` makes executed
   * transactions visible at once again.
   *
   * @since 0.4.0
   */
  readonly setVisibilityDelay: (delay: number | "never" | undefined) => Effect.Effect<void>
  /**
   * Teaches the fake about one transaction **by digest**, the way
   * `FakeScript.transactions` does for a script written up front.
   */
  readonly recordTransaction: (digest: string, outcome: FakeOutcome) => Effect.Effect<void>
  /**
   * Replaces the fake's address balance of one owner in one coin type (a full
   * coin type, e.g. `0x2::sui::SUI`). Never fails.
   *
   * @since 0.4.0
   */
  readonly setAddressBalance: (owner: string, coinType: string, amount: bigint) => Effect.Effect<void>
  /**
   * The fake's current address balance of one owner in one coin type: the
   * value an execution or `setAddressBalance` last wrote, else the scripted
   * seed, else 0. Never fails.
   *
   * @since 0.4.0
   */
  readonly readAddressBalance: (owner: string, coinType: string) => Effect.Effect<bigint>
  /**
   * Replaces `address`'s alias set: its `AddressAliases` object at the derived
   * id, at the next version. `undefined` removes the object, so the address is
   * back to signing only for itself (which no chain allows; a test may).
   * Never fails.
   *
   * @since 0.6.0
   */
  readonly setAddressAliases: (address: string, aliases: ReadonlyArray<string> | undefined) => Effect.Effect<void>
  /**
   * `address`'s alias set as the fake holds it, `None` when it has not enabled
   * aliases. Never fails.
   *
   * @since 0.6.0
   */
  readonly readAddressAliases: (address: string) => Effect.Effect<Option.Option<ReadonlyArray<string>>>
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
  /**
   * The address balance of each owner in each coin type, keyed
   * `<normalized owner>|<normalized coin type>`. A key that is absent has its
   * scripted seed (or 0); once written, the value here wins.
   */
  addressBalances: Map<string, bigint>
  deleted: Set<string>
  clockTimestampMs: bigint
  epoch: bigint
  visibilityDelay: number | "never" | undefined
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
  /**
   * Every transaction the ledger holds, in ledger order: those scripted by
   * digest first, then each recorded or executed one as it lands. This is what
   * `listTransactions` and `listEvents` page through.
   */
  ledger: Array<string>
  /** The sender and Move calls of each executed transaction, read off its bytes. */
  executedMeta: Map<string, { readonly sender?: string; readonly moveCalls: ReadonlyArray<string> }>
  /** The bytes of every transaction the fake executed, by digest: what a `bcs` include serves. */
  executedBytes: Map<string, Uint8Array>
}

/** What a settled call produced, kept so `getTransaction` can serve it again. */
interface SettledTransaction {
  readonly transaction: SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
  readonly failed: boolean
  readonly commandResults: ReadonlyArray<SuiClientTypes.CommandResult>
  /** The scripted `FakeExecution.sender`, for a transaction the fake did not execute from bytes. */
  readonly sender?: string
}

const DEFAULT_GAS: SuiClientTypes.GasCostSummary = {
  computationCost: "1000000",
  storageCost: "2000000",
  storageRebate: "980000",
  nonRefundableStorageFee: "20000"
}

/** The accumulator root a coin reservation ref's object id is derived under. */
const ACCUMULATOR_ROOT_ID = normalizeSuiAddress("0xacc")
const ACCUMULATOR_KEY_TYPE_TAG = TypeTagSerializer.parseFromStr(
  "0x2::accumulator::Key<0x2::balance::Balance<0x2::sui::SUI>>"
)
/** The byte a coin reservation digest repeats from offset 12. */
const COIN_RESERVATION_MAGIC = 0xac

/** Whether a payment ref is a coin reservation (version 0, magic digest tail). */
const isReservationRef = (ref: { readonly version: string | number; readonly digest: string }): boolean => {
  if (String(ref.version) !== "0") return false
  try {
    const bytes = fromBase58(ref.digest)
    return bytes.length === 32 && bytes.slice(12).every((byte) => byte === COIN_RESERVATION_MAGIC)
  } catch {
    return false
  }
}

/** The amount a coin reservation ref reserves: its digest's first eight bytes, u64 LE. */
const reservedAmountOf = (ref: { readonly digest: string }): bigint => {
  const bytes = fromBase58(ref.digest)
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true)
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

/** The type of the shared object `0xa`, which every `AddressAliases` is derived from. */
const ADDRESS_ALIAS_STATE_TYPE = "0x2::address_alias::AddressAliasState"

/**
 * The shared `AddressAliasState` (`0xa`) a node serves, so that
 * `AddressAlias.enable()` resolves its input against the fake.
 */
const aliasStateObject: FakeObject = {
  objectId: ADDRESS_ALIAS_STATE_ID,
  type: ADDRESS_ALIAS_STATE_TYPE,
  version: 1n,
  digest: fakeDigest(10),
  owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
  content: bcs.struct("AddressAliasState", { id: bcs.Address, version: bcs.u64() })
    .serialize({ id: ADDRESS_ALIAS_STATE_ID, version: "0" }).toBytes()
}

/**
 * `address`'s `AddressAliases` object holding `aliases` (deduplicated, in the
 * order given) at `version`, party-owned by the address as `enable` leaves it.
 */
const aliasesObject = (address: string, aliases: ReadonlyArray<string>, version: bigint): FakeObject => {
  const id = aliasesId(address)
  const contents = [...new Set(aliases.map((alias) => normalizeSuiAddress(alias)))]
  return {
    objectId: id,
    type: ADDRESS_ALIASES_TYPE,
    version,
    owner: {
      $kind: "ConsensusAddressOwner",
      ConsensusAddressOwner: { startVersion: "1", owner: normalizeSuiAddress(address) }
    },
    content: AddressAliasesBcs.serialize({ id, aliases: { contents } }).toBytes()
  }
}

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
    // Served when asked for, as a node does: `undefined` only when the include
    // set did not request them.
    json: include?.json === true ? object.json ?? null : undefined,
    display: include?.display === true ? object.display ?? null : undefined
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
  inputOwner: kind === "created"
    ? null
    : (change.inputOwner ?? change.owner ?? addressOwner("0x1")),
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

/**
 * What a node reports as `gasPaymentMocked` for the transaction it was asked
 * to simulate: `true` when the transaction carries no gas payment at all (an
 * unbuilt recipe), or an empty one with no expiration — nothing could pay, so
 * the node mocks a gas coin. An empty payment **with** an expiration is the
 * address-balance form (`Tx.sponsored`, `gaslessStablecoinTransfer`), and a
 * non-empty one is real coins: both `false`. Bytes the SDK cannot read answer
 * `false`. Never throws.
 */
const gasPaymentMockedOf = (transaction: Uint8Array | { getData(): unknown }): boolean => {
  try {
    const data = (transaction instanceof Uint8Array
      ? TransactionDataBuilder.fromBytes(transaction)
      : transaction.getData()) as {
        readonly gasData: { readonly payment?: ReadonlyArray<unknown> | null }
        readonly expiration?: unknown
      }
    const payment = data.gasData.payment
    if (payment === null || payment === undefined) return true
    if (payment.length > 0) return false
    return data.expiration === null || data.expiration === undefined ||
      (data.expiration as { readonly $kind?: string }).$kind === "None"
  } catch {
    return false
  }
}

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

/**
 * The smallest transaction data that names `sender`: an empty programmable
 * transaction paid from the sender's balance. What a `bcs` include serves for
 * a transaction scripted with a `sender` and no bytes.
 */
const transactionDataNaming = (sender: string): Uint8Array | undefined => {
  try {
    return bcs.TransactionData.serialize({
      V1: {
        kind: { ProgrammableTransaction: { inputs: [], commands: [] } },
        sender,
        gasData: { payment: [], owner: sender, price: "1000", budget: "1000000" },
        expiration: { None: true }
      }
    }).toBytes()
  } catch {
    return undefined
  }
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

const rpcError = (status: string, message?: string): Error => {
  const error = new Error(message ?? `fake transport error: ${status}`)
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

/**
 * Thrown, and re-thrown as a defect, when a script asks the fake for something
 * no node would do — an execute answered with a digest that is not the bytes'
 * own. A broken fixture, not a failing test.
 */
class FakeScriptError extends Error {
  readonly [DefectMarker] = true
  constructor(message: string) {
    super(`SuiCoreFake: ${message}`)
    this.name = "FakeScriptError"
  }
}

const unimplemented = (method: string): never => {
  throw new FakeUnimplemented(method)
}

/**
 * The in-memory `SuiCore`.
 *
 * What a test has to know about it, because none of it is visible from the
 * outside:
 *
 * - **Its `client` implements `$extend`.** `SuiCoreFakeState.client` is a
 *   `ClientWithCoreApi`, so `fake.client.$extend(myExtension(options))` gives a
 *   derived Promise face over the fake and a test can exercise a registration
 *   exactly the way a consumer writes it, with no network.
 * - **`listOwnedObjects` filters like a node.** The `type` option goes through
 *   the same `typeMatches` rule as the BCS bridge, so a bare tag matches every
 *   instantiation of a generic rather than only its own spelling.
 * - **`getDynamicField` matches on `name.type` *and* `name.bcs`**, the type
 *   under the same `typeMatches` rule, so a short and a padded spelling of one
 *   key type are the same key. An entry
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
 * - **An execute's digest is the bytes' own.** The fake derives it with
 *   `TransactionDataBuilder.getDigestFromBytes`, the way a node does, and an
 *   execute outcome scripted with a different `digest` is a broken fixture: the
 *   call dies saying so rather than handing `Tx.submit` another transaction.
 * - **It models address balances** (since 0.4.0): one per owner and coin type,
 *   seeded from `FakeScript.balances` and set with `SuiTest.setAddressBalance`.
 *   The resolver pays gas from it the way the SDK does, an execution it cannot
 *   fund is refused with `INVALID_ARGUMENT` like a node refuses it, and a
 *   settled execution moves it (gas, `FundsWithdrawal`, `send_funds`) — see
 *   `applyBalanceEffects` for exactly which shapes it follows without Move.
 * - **Visibility is instant unless scripted.** `FakeScript.visibilityDelay`
 *   (or `SuiTest.setVisibilityDelay`) holds `waitForTransaction` for an executed
 *   transaction, which is how a test reaches the window after the execute
 *   answered and before `Tx.submit` returns.
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
    const seeded = [
      ...(script.objects ?? []),
      ...Object.entries(script.addressAliases ?? {}).map(([address, aliases]) => aliasesObject(address, aliases, 1n))
    ]
    for (const object of seeded) {
      objects.set(normalizeSuiAddress(object.objectId), object)
    }
    const history = new Map<string, Map<string, string | undefined>>()
    for (const object of seeded) {
      const id = normalizeSuiAddress(object.objectId)
      history.set(id, new Map([[object.version.toString(), object.previousTransaction]]))
    }
    return makeInternal(script, {
      objects,
      history,
      coins: [...(script.coins ?? [])],
      addressBalances: new Map(),
      deleted: new Set(),
      clockTimestampMs: script.clockTimestampMs ?? 1_700_000_000_000n,
      epoch: script.epoch ?? DEFAULT_EPOCH,
      visibilityDelay: script.visibilityDelay,
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
      byDigest: new Map(Object.entries(script.transactions ?? {})),
      ledger: Object.keys(script.transactions ?? {}),
      executedMeta: new Map(),
      executedBytes: new Map()
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
    if (id === ADDRESS_ALIAS_STATE_ID && !state.objects.has(id)) return aliasStateObject
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

  /** The scripted execution the last `execute` outcome applied, for its `FakeChange`s. */
  let lastExecution: FakeExecution | undefined

  const applyOutcome = async (
    outcome: FakeOutcome,
    method: "simulate" | "execute" | "getTransaction",
    digest: string,
    executingPayment: ReadonlyArray<string> = []
  ): Promise<SettledTransaction> => {
    switch (outcome._tag) {
      case "transportError":
        throw rpcError(outcome.status, outcome.message)
      case "notFound":
        throw new TransactionError("notFound", digest)
      case "timeoutThen":
        return unimplemented("timeoutThen is handled before applyOutcome")
      case "failWith": {
        const resolved = outcome.value.digest ?? digest
        if (method === "execute") lastExecution = outcome.value
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
          commandResults: commandResultsOf(outcome.value),
          ...(outcome.value.sender === undefined ? {} : { sender: outcome.value.sender })
        }
      }
      case "succeed": {
        const resolved = outcome.value.digest ?? digest
        if (method === "execute") {
          lastExecution = outcome.value
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
          commandResults: commandResultsOf(outcome.value),
          ...(outcome.value.sender === undefined ? {} : { sender: outcome.value.sender })
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

  /**
   * The scripted wait before an executed transaction is visible: nothing,
   * a real-time delay that the caller's signal cuts short, or a wait that only
   * the signal ends.
   */
  const visibility = async (options: unknown): Promise<void> => {
    const delay = state.visibilityDelay
    if (delay === undefined || delay === 0) return
    if (delay === "never") {
      await pending<never>("waitForTransaction (visibilityDelay: \"never\")", options)
      return
    }
    const signal = signalOf(options)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          state.aborted += 1
          reject(abortError())
        },
        { once: true }
      )
    })
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
    executingPayment: ReadonlyArray<string> = [],
    derivedFromBytes = false
  ): Promise<SettledTransaction> => {
    // An unscripted simulate after a build whose resolver simulate *was*
    // scripted answers the way that build simulation did: the same bytes
    // simulate the same way, and a test that scripted `buildSimulate` alone
    // should not die on the preflight simulate that follows. With neither
    // script it still dies — and says which script to add, because the build
    // before it "simulated fine" only by taking its budget from `gasBudget`.
    const outcome = next(method) ??
      (method === "simulate" && state.scripts.buildSimulate.length > 0 ? next("buildSimulate") : undefined) ??
      unimplemented(
        method === "simulate"
          ? "simulateTransaction (script `simulate` — or `SuiTest.scriptSimulate` — for the simulate after the" +
            " build; a build with neither `simulate` nor `buildSimulate` scripted takes its budget from" +
            " `gasBudget` without simulating anything)"
          : METHOD_NAMES[method]
      )
    if (
      derivedFromBytes &&
      (outcome._tag === "succeed" || outcome._tag === "failWith") &&
      outcome.value.digest !== undefined &&
      outcome.value.digest !== digest
    ) {
      // A network derives the digest from the bytes; no node answers an
      // execute of these bytes with another transaction's digest. Serving the
      // scripted one made a test of `Tx.submit` pass on an `Executed` for a
      // transaction it never sent.
      throw new FakeScriptError(
        `${METHOD_NAMES[method]}: the script answers digest ${outcome.value.digest}, but` +
          ` the bytes it was handed have digest ${digest}. A node derives the digest from` +
          " the bytes: leave `digest` out of an execute outcome, or script the transaction" +
          " you mean by digest with `FakeScript.transactions`."
      )
    }
    if (outcome._tag === "timeoutThen") {
      state.pendingDigests.set(digest, outcome.found)
      return pending<never>(method, options)
    }
    return applyOutcome(outcome, method, digest, executingPayment)
  }

  const bcsOfSettled = (result: SettledTransaction, sender = result.sender): Uint8Array | undefined => {
    const executed = state.executedBytes.get(result.transaction.digest)
    if (executed !== undefined) return executed
    return sender === undefined ? undefined : transactionDataNaming(sender)
  }

  const asResult = (
    result: SettledTransaction,
    include?: { readonly bcs?: boolean } | undefined,
    sender?: string
  ) => {
    // `bcs` is served only when asked for, as a node does: the bytes the fake
    // executed, else — for a transaction scripted with a `sender` — minimal
    // transaction data naming that sender, which is what the `Sui` tier reads.
    const bytes = include?.bcs === true ? bcsOfSettled(result, sender ?? result.sender) : undefined
    const transaction = bytes === undefined
      ? result.transaction
      : { ...result.transaction, bcs: bytes } as unknown as SettledTransaction["transaction"]
    return result.failed
      ? { $kind: "FailedTransaction", FailedTransaction: transaction }
      : { $kind: "Transaction", Transaction: transaction }
  }

  /** A coin type in its normalized spelling, or as given when it does not parse. */
  const normalizeCoinType = (coinType: string): string => {
    try {
      return normalizeStructTag(coinType)
    } catch {
      return coinType
    }
  }

  const balanceKey = (owner: string, coinType: string): string =>
    `${normalizeSuiAddress(owner)}|${normalizeCoinType(coinType)}`

  /**
   * The scripted entry that answers for this owner and coin type: an entry that
   * names the owner wins over an owner-less one, which answers for everyone.
   */
  const scriptedBalanceOf = (owner: string, coinType: string): FakeBalance | undefined => {
    const address = normalizeSuiAddress(owner)
    const type = normalizeCoinType(coinType)
    const entries = script.balances ?? []
    return entries.find((entry) =>
      entry.owner !== undefined && normalizeSuiAddress(entry.owner) === address &&
      normalizeCoinType(entry.coinType) === type
    ) ?? entries.find((entry) => entry.owner === undefined && normalizeCoinType(entry.coinType) === type)
  }

  /** The current address balance: written state, else the scripted seed, else 0. */
  const addressBalanceOf = (owner: string, coinType: string): bigint => {
    const written = state.addressBalances.get(balanceKey(owner, coinType))
    if (written !== undefined) return written
    const seed = scriptedBalanceOf(owner, coinType)?.addressBalance
    try {
      return seed === undefined ? 0n : BigInt(seed)
    } catch {
      // A fixture that scripts a malformed balance to test the decode boundary.
      return 0n
    }
  }

  const setAddressBalanceOf = (owner: string, coinType: string, amount: bigint): void => {
    state.addressBalances.set(balanceKey(owner, coinType), amount)
  }

  /** Moves an address balance by `delta`, never below zero. */
  const adjustAddressBalance = (owner: string, coinType: string, delta: bigint): void => {
    const next = addressBalanceOf(owner, coinType) + delta
    setAddressBalanceOf(owner, coinType, next < 0n ? 0n : next)
  }

  /**
   * The balance `getBalance` serves: a scripted entry with its address balance
   * swapped for the current one, or the owner's coins plus its address balance.
   */
  const balanceOf = (owner: string, coinType: string): SuiClientTypes.Balance => {
    const addressBalance = addressBalanceOf(owner, coinType)
    const scripted = scriptedBalanceOf(owner, coinType)
    if (scripted !== undefined) {
      const { owner: _owner, ...balance } = scripted
      // Untouched, the entry is served verbatim — malformed fields included,
      // which is how a test reaches the decode boundary.
      if (!state.addressBalances.has(balanceKey(owner, coinType))) return balance
      return {
        ...balance,
        balance: (BigInt(scripted.balance) - BigInt(scripted.addressBalance) + addressBalance).toString(),
        addressBalance: addressBalance.toString()
      }
    }
    const coinBalance = coinsOf(owner, coinType).reduce((sum, coin) => sum + BigInt(coin.balance), 0n)
    return {
      coinType,
      balance: (coinBalance + addressBalance).toString(),
      coinBalance: coinBalance.toString(),
      addressBalance: addressBalance.toString()
    }
  }

  /** `T` out of a `0x2::coin::Coin<T>` object type, normalized, or `undefined`. */
  const coinTypeOfCoin = (type: string): string | undefined => {
    if (!isCoin(type)) return undefined
    const normalized = normalizeStructTag(type)
    return normalized.slice(normalized.indexOf("<") + 1, normalized.lastIndexOf(">"))
  }

  /**
   * Every balance this owner has, the way `listBalances` serves them: the
   * scripted entries that answer for it (one per coin type), then each coin
   * type it has a non-zero address balance in or holds coins of that no entry
   * names.
   */
  const balancesOf = (owner: string): ReadonlyArray<SuiClientTypes.Balance> => {
    const address = normalizeSuiAddress(owner)
    const seen = new Set<string>()
    const out: Array<SuiClientTypes.Balance> = []
    const add = (coinType: string): void => {
      const type = normalizeCoinType(coinType)
      if (seen.has(type)) return
      seen.add(type)
      out.push(balanceOf(address, coinType))
    }
    for (const entry of script.balances ?? []) {
      if (entry.owner !== undefined && normalizeSuiAddress(entry.owner) !== address) continue
      add(entry.coinType)
    }
    for (const [key, amount] of state.addressBalances) {
      const [keyOwner, type] = key.split("|") as [string, string]
      if (keyOwner === address && amount !== 0n) add(type)
    }
    for (const coin of state.coins) {
      if (coin.owner.$kind !== "AddressOwner") continue
      if (normalizeSuiAddress(coin.owner.AddressOwner) !== address) continue
      const type = coinTypeOfCoin(coin.type)
      if (type !== undefined) add(type)
    }
    return out
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

  /** Whether any command reads `tx.gas`, the SDK's `transactionUsesGasCoin`. */
  const usesGasCoinOf = (data: TransactionDataBuilder): boolean => {
    let uses = false
    data.mapArguments((argument) => {
      if (argument.$kind === "GasCoin") uses = true
      return argument
    })
    return uses
  }

  /** One `FundsWithdrawal` input: who it draws from, in which coin type, how much. */
  interface Withdrawal {
    readonly source: string
    readonly coinType: string
    readonly amount: bigint
  }

  /**
   * Every `FundsWithdrawal` input with a `MaxAmountU64` reservation, with its
   * source resolved the way the SDK resolves it: `Sender` is the sender,
   * `Sponsor` the gas owner (or the sender), `SenderAllowance` its funder.
   */
  const withdrawalsOf = (data: TransactionDataBuilder): ReadonlyArray<Withdrawal> => {
    const out: Array<Withdrawal> = []
    for (const input of data.inputs) {
      if (input.$kind !== "FundsWithdrawal") continue
      const withdrawal = input.FundsWithdrawal
      if (withdrawal.reservation.$kind !== "MaxAmountU64") continue
      // Spelled out so it typechecks on SDKs before allowances (2.30), whose
      // `withdrawFrom` has no `SenderAllowance`.
      const from: {
        readonly Sender?: unknown
        readonly SenderAllowance?: { readonly funder: string }
      } = withdrawal.withdrawFrom
      const source = from.SenderAllowance
        ? from.SenderAllowance.funder
        : from.Sender
        ? data.sender
        : data.gasData.owner ?? data.sender
      if (source === null || source === undefined) continue
      out.push({
        source: normalizeSuiAddress(source),
        coinType: normalizeCoinType(withdrawal.typeArg.Balance),
        amount: BigInt(withdrawal.reservation.MaxAmountU64)
      })
    }
    return out
  }

  /** The SUI the transaction withdraws from `payer`'s address balance. */
  const suiWithdrawalsFrom = (data: TransactionDataBuilder, payer: string): bigint => {
    const address = normalizeSuiAddress(payer)
    const sui = normalizeCoinType(SUI_TYPE_ARG)
    return withdrawalsOf(data)
      .filter((withdrawal) => withdrawal.source === address && withdrawal.coinType === sui)
      .reduce((sum, withdrawal) => sum + withdrawal.amount, 0n)
  }

  /**
   * A coin reservation ref, the SDK's `createCoinReservationRef`: version `0`,
   * a digest of the amount (u64 LE), the epoch (u32 LE) and twenty `0xAC`
   * bytes, and the owner's SUI accumulator field id XOR the chain identifier
   * (left as the field id when the chain id is not 32 base58 bytes).
   */
  const coinReservationRef = (
    amount: bigint,
    owner: string
  ): { objectId: string; version: string; digest: string } => {
    const field = fromHex(
      deriveDynamicFieldID(
        ACCUMULATOR_ROOT_ID,
        ACCUMULATOR_KEY_TYPE_TAG,
        bcs.Address.serialize(normalizeSuiAddress(owner)).toBytes()
      ).slice(2)
    )
    let chain: Uint8Array | undefined
    try {
      chain = fromBase58(chainId)
    } catch {
      chain = undefined
    }
    const id = new Uint8Array(32)
    for (let index = 0; index < 32; index++) {
      id[index] = (field[index] ?? 0) ^ (chain?.length === 32 ? (chain[index] ?? 0) : 0)
    }
    const digest = new Uint8Array(32)
    const view = new DataView(digest.buffer)
    view.setBigUint64(0, amount, true)
    view.setUint32(8, Number(state.epoch & 0xffffffffn), true)
    digest.fill(COIN_RESERVATION_MAGIC, 12)
    return { objectId: `0x${toHex(id)}`, version: "0", digest: toBase58(digest) }
  }

  /**
   * The fake's stand-in for the transport's resolve plugin, so
   * `transaction.build({ client })` works with no network.
   *
   * It fills the gas price from the scripted reference gas price, the gas
   * budget from `script.gasBudget` (default 50 MIST-per-unit times the price),
   * resolves every `UnresolvedObject` input from the object map, choosing a
   * shared, immutable or owned reference from the stored owner, and — when the
   * payment is unset — chooses it the way the SDK core resolver's
   * `setGasPayment` does, over the fake's balances (since 0.4.0). The payer is
   * the gas owner, else the sender:
   *
   * - `[]` (the address balance pays) when the budget is zero, or when no
   *   command reads `tx.gas` and the payer's SUI address balance covers the
   *   budget plus the SUI its `FundsWithdrawal` inputs draw from the payer;
   * - otherwise the payer's SUI coins that are not inputs of the transaction,
   *   preceded — for a `tx.gas` user whose address balance exceeds those
   *   withdrawals — by a coin reservation ref for the difference (version `0`,
   *   the SDK's digest layout and object-id derivation, the fake's epoch);
   * - and with neither coins nor a reservation it throws the SDK's own
   *   `"No valid gas coins found for the transaction."`, which `Tx.build`
   *   reports as a `BuildError`.
   *
   * An explicit payment, `[]` included, is left alone, the way a sponsored
   * transaction wants it; a transaction with no sender and no gas owner gets
   * `[]`. Unlike the SDK, it never sets an expiration: `Tx.build` does. Everything
   * else — argument normalization, BCS layout, validation — is the SDK's own
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
    //
    // It mirrors the SDK's **core** resolver, which every non-gRPC transport
    // uses: that resolver simulates only inside `setGasBudget`, which returns
    // at once when the budget is already set. So a preset budget means no
    // resolver simulate here either, and `Tx.build`'s own explicit simulate is
    // what the harness records — which is how a test sees that "building
    // always simulates" holds on a transport whose resolver does not.
    if (!options.onlyTransactionKind && !transactionData.gasData.budget) {
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
          // Never settles until the build is interrupted, which is exactly what
          // a resolver's in-flight simulate does.
          if (lastSignal === undefined) {
            return unimplemented(
              "buildSimulate timeoutThen (no AbortSignal reached the resolver; build through Tx.build)"
            )
          }
          await waitForAbort(lastSignal)
        }
        await applyOutcome(budgetOutcome, "simulate", fakeDigest(state.calls.length + 200))
      }
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
      const coins = payer === null || payer === undefined
        ? []
        : coinsOf(payer).filter((coin) => !inputIds.has(normalizeSuiAddress(coin.objectId)))
      const refs = coins.map((coin) => ({
        objectId: coin.objectId,
        version: coin.version,
        digest: coin.digest
      }))
      if (payer === null || payer === undefined) {
        // Nobody to pay: what the fake has always answered, rather than the
        // SDK's "a gas owner or sender must be set".
        transactionData.gasData.payment = []
      } else {
        // The SDK core resolver's `setGasPayment`, over the fake's balances.
        const budget = BigInt(transactionData.gasData.budget ?? 0)
        const usesGasCoin = usesGasCoinOf(transactionData)
        const withdrawals = suiWithdrawalsFrom(transactionData, payer)
        const addressBalance = addressBalanceOf(payer, SUI_TYPE_ARG)
        if (budget === 0n || (!usesGasCoin && addressBalance >= budget + withdrawals)) {
          transactionData.gasData.payment = []
        } else if (usesGasCoin && addressBalance - withdrawals > 0n) {
          transactionData.gasData.payment = [
            coinReservationRef(addressBalance - withdrawals, payer),
            ...refs
          ]
        } else if (refs.length === 0) {
          throw new Error("No valid gas coins found for the transaction.")
        } else {
          transactionData.gasData.payment = refs
        }
      }
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
   * signature the SDK cannot parse (a zkLogin proof, a fixture that is not a
   * real signature) makes the address check stand down, so only the count
   * applies there. A multisig counts as the multisig's address (0.6.0).
   *
   * **Address aliases** (0.6.0): a required address that has an
   * `AddressAliases` object in the fake is covered by a signature from any
   * member of its set and **only** by one — its own key too only while it is
   * a member — the way a validator resolves aliases for the sender and the gas
   * owner. An address without one is covered by its own signature, as before.
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
        if (parsed.signatureScheme === "MultiSig") {
          // A multisig's address is its public key's, readable without the
          // network (0.6.0); its members' signatures are not checked here.
          addresses.push(normalizeSuiAddress(new MultiSigPublicKey(parsed.multisig.multisig_pk).toSuiAddress()))
          continue
        }
        if (parsed.signatureScheme === "ZkLogin") {
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
    const covers = (address: string, signer: string): boolean => {
      const aliases = aliasesOf(address)
      return aliases === undefined ? signer === address : aliases.includes(signer)
    }
    const missing = required.filter((address) => !signed.some((signer) => covers(address, signer)))
    if (missing.length > 0) {
      const sets = missing.map((address) => aliasesOf(address)).filter((set) => set !== undefined)
      refuse(
        `these bytes name ${missing.join(", ")} as (a) signer(s) and carry no signature` +
          ` from ${missing.length === 1 ? "that address" : "those addresses"}` +
          (sets.length > 0 ? ` or an alias of ${missing.length === 1 ? "it" : "them"} (${sets.map((set) => set.join(", ")).join("; ")})` : "") +
          ` (the signatures are from ${signed.join(", ")})`
      )
    }
  }

  /** `address`'s alias set as the fake holds it (its `AddressAliases` object), or `undefined`. */
  const aliasesOf = (address: string): ReadonlyArray<string> | undefined => {
    const object = state.objects.get(aliasesId(address))
    if (object === undefined) return undefined
    try {
      return AddressAliasesBcs.parse(object.content).aliases.contents.map((alias) => normalizeSuiAddress(alias))
    } catch {
      return undefined
    }
  }

  /** Replaces `address`'s alias set at the next version (or removes it), keeping its history. */
  const writeAliases = (address: string, aliases: ReadonlyArray<string> | undefined, digest?: string): void => {
    const id = aliasesId(address)
    if (aliases === undefined) {
      state.objects.delete(id)
      return
    }
    const version = (state.objects.get(id)?.version ?? 0n) + 1n
    const object = {
      ...aliasesObject(address, aliases, version),
      ...(digest === undefined ? {} : { previousTransaction: digest })
    }
    state.objects.set(id, object)
    state.deleted.delete(id)
    remember(id, version, digest)
  }

  /**
   * Edits alias sets for a transaction the fake just executed successfully,
   * following its `0x2::address_alias` entry calls the way the Move module
   * does — `enable` creates the sender's set `[sender]`; `add`, `remove` and
   * `replace_all` edit the set whose object is the call's first argument. A
   * call Move would abort (`enable` twice, adding a member, removing the last
   * alias, more than 8) changes nothing: the fake runs no Move, so a test that
   * wants the abort scripts it with `FakeOutcome.failWith`.
   */
  const applyAliasEffects = (data: TransactionDataBuilder, digest: string): void => {
    const sender = typeof data.sender === "string" ? normalizeSuiAddress(data.sender) : undefined
    const objectOf = (argument: Argument | undefined): string | undefined => {
      if (argument === undefined || argument.$kind !== "Input") return undefined
      const input = data.inputs[argument.Input]
      const id = input?.Object?.SharedObject?.objectId ?? input?.Object?.ImmOrOwnedObject?.objectId ??
        input?.UnresolvedObject?.objectId
      return id === undefined ? undefined : normalizeSuiAddress(id)
    }
    const pureOf = (argument: Argument | undefined): Uint8Array | undefined => {
      if (argument === undefined || argument.$kind !== "Input") return undefined
      const bytes = data.inputs[argument.Input]?.Pure?.bytes
      return bytes === undefined ? undefined : fromBase64(bytes)
    }
    const ownerOfAliases = (id: string | undefined): string | undefined => {
      if (id === undefined) return undefined
      const owner = state.objects.get(id)?.owner
      return owner?.$kind === "ConsensusAddressOwner" ? normalizeSuiAddress(owner.ConsensusAddressOwner.owner) : undefined
    }
    for (const command of data.commands) {
      if (command.$kind !== "MoveCall") continue
      const call = command.MoveCall
      let framework = false
      try {
        framework = normalizeSuiAddress(call.package) === SUI_FRAMEWORK
      } catch {
        framework = false
      }
      if (!framework || call.module !== "address_alias") continue
      if (call.function === "enable") {
        if (sender !== undefined && aliasesOf(sender) === undefined) writeAliases(sender, [sender], digest)
        continue
      }
      const account = ownerOfAliases(objectOf(call.arguments[0]))
      const current = account === undefined ? undefined : aliasesOf(account)
      if (account === undefined || current === undefined) continue
      try {
        switch (call.function) {
          case "add": {
            const bytes = pureOf(call.arguments[1])
            if (bytes === undefined) break
            const alias = normalizeSuiAddress(bcs.Address.parse(bytes))
            if (!current.includes(alias) && current.length < MAX_ALIASES) writeAliases(account, [...current, alias], digest)
            break
          }
          case "remove": {
            const bytes = pureOf(call.arguments[1])
            if (bytes === undefined) break
            const alias = normalizeSuiAddress(bcs.Address.parse(bytes))
            if (current.includes(alias) && current.length > 1) {
              writeAliases(account, current.filter((member) => member !== alias), digest)
            }
            break
          }
          case "replace_all": {
            const bytes = pureOf(call.arguments[1])
            if (bytes === undefined) break
            const next = [...new Set(bcs.vector(bcs.Address).parse(bytes).map((alias) => normalizeSuiAddress(alias)))]
            if (next.length > 0 && next.length <= MAX_ALIASES) writeAliases(account, next, digest)
            break
          }
          default:
            break
        }
      } catch {
        // Bytes the fake cannot read change nothing.
      }
    }
  }

  /** The bytes as transaction data, or `undefined` for a fixture that is not one. */
  const dataOfBytes = (bytes: Uint8Array): TransactionDataBuilder | undefined => {
    try {
      return TransactionDataBuilder.fromBytes(bytes)
    } catch {
      return undefined
    }
  }

  /** A coin type the way a node's message spells it: `0x2::sui::SUI` for SUI. */
  const displayCoinType = (coinType: string): string =>
    normalizeCoinType(coinType) === normalizeCoinType(SUI_TYPE_ARG) ? "0x2::sui::SUI" : coinType

  /** A node's own refusal: an `RpcError` carrying `INVALID_ARGUMENT` and the node's text. */
  const refuseLikeNode = (message: string): never => {
    throw rpcError("INVALID_ARGUMENT", message)
  }

  const insufficient = (coinType: string, address: string, required: bigint, available: bigint): never =>
    refuseLikeNode(
      `Invalid withdraw reservation: Insufficient address balance of coin type ${displayCoinType(coinType)}` +
        ` for address ${address}: the transaction requires ${required} but only ${available} is available`
    )

  /**
   * Refuses, the way a node does, an execution its balances cannot fund: an
   * empty gas payment the payer's SUI address balance does not cover (budget
   * plus the SUI it withdraws from the payer), a coin reservation in the
   * payment whose amount plus the SUI the bytes withdraw from the payer is more
   * than the payer's SUI address balance **now** (a reservation is the
   * resolver's read of the whole balance at build time, so any spend that
   * lands between its build and its send makes it stale, and a node refuses it
   * at submit with the same "Invalid withdraw reservation" text), a
   * `FundsWithdrawal` its source's balance does not cover, and an empty
   * payment with neither an
   * address-owned input nor a `ValidDuring`/`Validity` expiration (nothing
   * would stop it replaying).
   */
  const refuseUnfunded = (data: TransactionDataBuilder): void => {
    const payment = data.gasData.payment ?? []
    const budget = BigInt(data.gasData.budget ?? 0)
    const payer = data.gasData.owner ?? data.sender
    const withdrawals = withdrawalsOf(data)
    if (payment.length === 0 && budget > 0n && payer !== null && payer !== undefined) {
      const required = budget + suiWithdrawalsFrom(data, payer)
      const available = addressBalanceOf(payer, SUI_TYPE_ARG)
      if (available < required) insufficient(SUI_TYPE_ARG, normalizeSuiAddress(payer), required, available)
    }
    const reservation = payment.find(isReservationRef)
    if (reservation !== undefined && payer !== null && payer !== undefined) {
      const required = reservedAmountOf(reservation) + suiWithdrawalsFrom(data, payer)
      const available = addressBalanceOf(payer, SUI_TYPE_ARG)
      if (available < required) insufficient(SUI_TYPE_ARG, normalizeSuiAddress(payer), required, available)
    }
    const reserved = new Map<string, Withdrawal>()
    for (const withdrawal of withdrawals) {
      const key = balanceKey(withdrawal.source, withdrawal.coinType)
      const total = reserved.get(key)
      reserved.set(key, { ...withdrawal, amount: (total?.amount ?? 0n) + withdrawal.amount })
    }
    for (const total of reserved.values()) {
      const available = addressBalanceOf(total.source, total.coinType)
      if (available < total.amount) insufficient(total.coinType, total.source, total.amount, available)
    }
    if (payment.length === 0) {
      const owned = data.inputs.some((input) =>
        input.Object?.ImmOrOwnedObject !== undefined || input.Object?.Receiving !== undefined
      )
      const kind = data.expiration?.$kind
      if (!owned && kind !== "ValidDuring" && kind !== "Validity") {
        refuseLikeNode(
          "Transactions must either have address-owned inputs, or a ValidDuring expiration with at most two epochs of validity"
        )
      }
    }
  }

  /** What one argument holds, as far as the fake can follow it without Move. */
  interface Tracked {
    readonly kind: "coin" | "balance" | "withdrawal"
    readonly coinType: string
    amount: bigint
    /** The input coin this value is, which is deleted when it is consumed. */
    readonly coinId?: string
    /** Whether this is `tx.gas`. */
    readonly gas?: boolean
  }

  const SUI_FRAMEWORK = normalizeSuiAddress("0x2")

  /**
   * Moves balances for a transaction the fake just settled, for the shapes it
   * can follow without running Move:
   *
   * - the net gas charge (computation + storage − rebate of the effects it
   *   returned) comes off the payer's SUI address balance when the payment is
   *   empty or holds a coin reservation; this is all a **failed** execution does;
   * - each `FundsWithdrawal` comes off its source's balance of its type;
   * - `0x2::coin::send_funds<T>` / `0x2::balance::send_funds<T>` deposit what
   *   flowed into them into the recipient's balance of `T`: an input coin, the
   *   gas coin (the payment coins' total plus any reservation, less the gas
   *   charge — a gas coin with a reservation in it moves the reservation off the
   *   payer's balance instead of the gas charge), a `SplitCoins` amount,
   *   `redeem_funds`, `into_balance`/`from_balance`, `zero` and `MergeCoins` of
   *   those;
   * - a consumed input coin (sent, merged in, `into_balance`, `destroy_zero`) is
   *   deleted from the coin set, and a consumed gas coin deletes every payment
   *   coin — unless a scripted `FakeChange` mutated it, which wins.
   *
   * It does **not** rewrite the balance of a coin that was split from or merged
   * into: those come from the script (`FakeChange.balance`), as before.
   */
  const applyBalanceEffects = (
    data: TransactionDataBuilder,
    settled: SettledTransaction,
    before: ReadonlyArray<SuiClientTypes.Coin>,
    execution: FakeExecution | undefined
  ): void => {
    const effects = settled.transaction.effects as SuiClientTypes.TransactionEffects | undefined
    const gasUsed = effects?.gasUsed ?? DEFAULT_GAS
    const netGas = BigInt(gasUsed.computationCost) + BigInt(gasUsed.storageCost) -
      BigInt(gasUsed.storageRebate)
    const payment = data.gasData.payment ?? []
    const reservation = payment.find(isReservationRef)
    const reserved = reservation === undefined ? 0n : reservedAmountOf(reservation)
    const paymentCoinIds = payment
      .filter((ref) => !isReservationRef(ref))
      .map((ref) => normalizeSuiAddress(ref.objectId))
    const payer = data.gasData.owner ?? data.sender
    const fromAddressBalance = payment.length === 0 || reservation !== undefined
    const sui = normalizeCoinType(SUI_TYPE_ARG)
    if (settled.failed) {
      if (fromAddressBalance && payer) adjustAddressBalance(payer, sui, -netGas)
      return
    }
    for (const withdrawal of withdrawalsOf(data)) {
      adjustAddressBalance(withdrawal.source, withdrawal.coinType, -withdrawal.amount)
    }

    const coinsBefore = new Map(before.map((coin) => [normalizeSuiAddress(coin.objectId), coin]))
    const values = new Map<string, Tracked>()
    const consumedCoins = new Set<string>()
    let gasConsumed = false
    const deposits: Array<{ readonly recipient: string; readonly coinType: string; readonly amount: bigint }> = []

    const keyOf = (argument: Argument): string | undefined => {
      switch (argument.$kind) {
        case "GasCoin":
          return "gas"
        case "Input":
          return `input:${argument.Input}`
        case "Result":
          return `result:${argument.Result}:0`
        case "NestedResult":
          return `result:${argument.NestedResult[0]}:${argument.NestedResult[1]}`
        default:
          return undefined
      }
    }

    const valueOf = (argument: Argument | undefined): Tracked | undefined => {
      if (argument === undefined) return undefined
      const key = keyOf(argument)
      if (key === undefined) return undefined
      const known = values.get(key)
      if (known !== undefined) return known
      let value: Tracked | undefined
      if (argument.$kind === "GasCoin") {
        const coins = paymentCoinIds.reduce(
          (sum, id) => sum + BigInt(coinsBefore.get(id)?.balance ?? "0"),
          0n
        )
        const amount = coins + reserved - netGas
        value = { kind: "coin", coinType: sui, amount: amount < 0n ? 0n : amount, gas: true }
      } else if (argument.$kind === "Input") {
        const input = data.inputs[argument.Input]
        const owned = input?.Object?.ImmOrOwnedObject
        if (owned !== undefined) {
          const id = normalizeSuiAddress(owned.objectId)
          const coin = coinsBefore.get(id)
          const coinType = coin === undefined ? undefined : coinTypeOfCoin(coin.type)
          if (coin !== undefined && coinType !== undefined) {
            value = { kind: "coin", coinType, amount: BigInt(coin.balance), coinId: id }
          }
        } else if (input?.$kind === "FundsWithdrawal" && input.FundsWithdrawal.reservation.$kind === "MaxAmountU64") {
          value = {
            kind: "withdrawal",
            coinType: normalizeCoinType(input.FundsWithdrawal.typeArg.Balance),
            amount: BigInt(input.FundsWithdrawal.reservation.MaxAmountU64)
          }
        }
      }
      if (value !== undefined) values.set(key, value)
      return value
    }

    const consume = (argument: Argument | undefined): void => {
      const value = valueOf(argument)
      if (value === undefined) return
      if (value.coinId !== undefined) consumedCoins.add(value.coinId)
      if (value.gas === true) gasConsumed = true
      value.amount = 0n
    }

    const pureOf = (argument: Argument | undefined): Uint8Array | undefined => {
      if (argument === undefined || argument.$kind !== "Input") return undefined
      const bytes = data.inputs[argument.Input]?.Pure?.bytes
      return bytes === undefined ? undefined : fromBase64(bytes)
    }

    const u64Of = (argument: Argument | undefined): bigint | undefined => {
      const bytes = pureOf(argument)
      if (bytes === undefined) return undefined
      try {
        return BigInt(bcs.u64().parse(bytes))
      } catch {
        return undefined
      }
    }

    const addressOf = (argument: Argument | undefined): string | undefined => {
      const bytes = pureOf(argument)
      if (bytes === undefined) return undefined
      try {
        return normalizeSuiAddress(bcs.Address.parse(bytes))
      } catch {
        return undefined
      }
    }

    data.commands.forEach((command, index) => {
      const result = (nested: number, value: Tracked): void => {
        values.set(`result:${index}:${nested}`, value)
      }
      switch (command.$kind) {
        case "SplitCoins": {
          const source = valueOf(command.SplitCoins.coin)
          command.SplitCoins.amounts.forEach((amountArgument, nested) => {
            const amount = u64Of(amountArgument)
            if (source === undefined || amount === undefined) return
            source.amount = source.amount > amount ? source.amount - amount : 0n
            result(nested, { kind: "coin", coinType: source.coinType, amount })
          })
          return
        }
        case "MergeCoins": {
          const destination = valueOf(command.MergeCoins.destination)
          for (const sourceArgument of command.MergeCoins.sources) {
            const source = valueOf(sourceArgument)
            if (destination !== undefined && source !== undefined) destination.amount += source.amount
            consume(sourceArgument)
          }
          return
        }
        case "MoveCall": {
          const call = command.MoveCall
          let framework = false
          try {
            framework = normalizeSuiAddress(call.package) === SUI_FRAMEWORK
          } catch {
            framework = false
          }
          if (!framework) return
          const typeArgument = call.typeArguments[0]
          const coinType = typeArgument === undefined ? undefined : normalizeCoinType(typeArgument)
          const name = `${call.module}::${call.function}`
          const first = call.arguments[0]
          switch (name) {
            case "coin::redeem_funds":
            case "balance::redeem_funds": {
              const withdrawal = valueOf(first)
              if (withdrawal === undefined) return
              result(0, {
                kind: call.module === "coin" ? "coin" : "balance",
                coinType: coinType ?? withdrawal.coinType,
                amount: withdrawal.amount
              })
              return
            }
            case "coin::into_balance":
            case "coin::from_balance": {
              const value = valueOf(first)
              if (value === undefined) return
              const amount = value.amount
              consume(first)
              result(0, {
                kind: call.function === "into_balance" ? "balance" : "coin",
                coinType: coinType ?? value.coinType,
                amount
              })
              return
            }
            case "coin::zero":
            case "balance::zero":
              if (coinType !== undefined) {
                result(0, { kind: call.module === "coin" ? "coin" : "balance", coinType, amount: 0n })
              }
              return
            case "coin::send_funds":
            case "balance::send_funds": {
              const value = valueOf(first)
              const recipient = addressOf(call.arguments[1])
              if (value !== undefined && recipient !== undefined) {
                deposits.push({ recipient, coinType: coinType ?? value.coinType, amount: value.amount })
              }
              consume(first)
              return
            }
            case "coin::destroy_zero":
              consume(first)
              return
            default:
              return
          }
        }
        default:
          return
      }
    })

    if (fromAddressBalance && payer) {
      // A gas coin that carried a reservation and was sent away took the
      // reservation with it, and the gas charge came out of the coin.
      adjustAddressBalance(payer, sui, gasConsumed && reservation !== undefined ? -reserved : -netGas)
    }
    for (const deposit of deposits) {
      if (deposit.amount !== 0n) adjustAddressBalance(deposit.recipient, deposit.coinType, deposit.amount)
    }
    if (gasConsumed) for (const id of paymentCoinIds) consumedCoins.add(id)
    const scripted = new Set(
      (execution?.mutated ?? []).map((change) => normalizeSuiAddress(change.objectId))
    )
    if (consumedCoins.size > 0) {
      state.coins = state.coins.filter((coin) => {
        const id = normalizeSuiAddress(coin.objectId)
        return !consumedCoins.has(id) || scripted.has(id)
      })
    }
  }

  /** The digest of the bytes that were handed to us, as the network derives it. */
  const derivedDigestOf = (bytes: Uint8Array): string | undefined => {
    try {
      return TransactionDataBuilder.getDigestFromBytes(bytes)
    } catch {
      return undefined
    }
  }

  /** The same, with a stand-in for bytes that are not a transaction (a unit-test fixture). */
  const digestOfBytes = (bytes: Uint8Array): string =>
    derivedDigestOf(bytes) ?? fakeDigest(state.calls.length + 1)

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
        throw rpcError(outcome.status, outcome.message)
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

  const appendToLedger = (digest: string): void => {
    if (!state.ledger.includes(digest)) state.ledger.push(digest)
  }

  /** The sender and Move calls a set of bytes names, for the ledger filters. */
  const metaOfBytes = (
    bytes: Uint8Array
  ): { readonly sender?: string; readonly moveCalls: ReadonlyArray<string> } => {
    try {
      const data = TransactionDataBuilder.fromBytes(bytes)
      const moveCalls: Array<string> = []
      for (const command of data.commands) {
        if (command.$kind !== "MoveCall") continue
        const call = command.MoveCall
        moveCalls.push(`${call.package}::${call.module}::${call.function}`)
      }
      return {
        ...(data.sender === null || data.sender === undefined ? {} : { sender: data.sender }),
        moveCalls
      }
    } catch {
      return { moveCalls: [] }
    }
  }

  /**
   * One transaction of the ledger as the node would list it, or `undefined`
   * for a digest whose scripted outcome is not a transaction (a transport
   * failure, a miss, a pending timeout).
   */
  interface LedgerTransaction {
    readonly digest: string
    readonly settled: SettledTransaction
    readonly sender: string | undefined
    readonly moveCalls: ReadonlyArray<string>
  }

  const ledgerTransactions = async (): Promise<ReadonlyArray<LedgerTransaction>> => {
    const out: Array<LedgerTransaction> = []
    for (const digest of state.ledger) {
      const scripted = state.byDigest.get(digest)
      if (scripted !== undefined) {
        if (scripted._tag !== "succeed" && scripted._tag !== "failWith") continue
        out.push({
          digest,
          settled: await applyOutcome(scripted, "getTransaction", digest),
          sender: scripted.value.sender,
          moveCalls: scripted.value.moveCalls ?? []
        })
        continue
      }
      const known = state.knownTransactions.get(digest)
      if (known === undefined) continue
      const meta = state.executedMeta.get(digest)
      out.push({
        digest,
        settled: known,
        sender: meta?.sender,
        moveCalls: meta?.moveCalls ?? []
      })
    }
    return out
  }

  /** Whether a `::`-path names the same package (and module, and member) as another. */
  const pathMatches = (filter: string, path: string): boolean => {
    const wanted = filter.split("::")
    const actual = path.split("::")
    if (wanted.length > actual.length) return false
    return wanted.every((part, index) => {
      const other = actual[index] as string
      if (index > 0) return part === other
      try {
        return normalizeSuiAddress(part) === normalizeSuiAddress(other)
      } catch {
        return part === other
      }
    })
  }

  const sameAddress = (left: string, right: string | undefined): boolean =>
    right !== undefined && normalizeSuiAddress(left) === normalizeSuiAddress(right)

  const transactionMatches = (
    filter: SuiClientTypes.TransactionFilter | undefined,
    transaction: LedgerTransaction
  ): boolean => {
    if (filter === undefined) return true
    if (filter.sender !== undefined) return sameAddress(filter.sender, transaction.sender)
    if (filter.function !== undefined) {
      const wanted = filter.function
      return transaction.moveCalls.some((call) => pathMatches(wanted, call))
    }
    return true
  }

  const eventMatches = (
    filter: SuiClientTypes.EventFilter | undefined,
    event: SuiClientTypes.Event
  ): boolean => {
    if (filter === undefined) return true
    if (filter.sender !== undefined) return sameAddress(filter.sender, event.sender)
    if (filter.emitModule !== undefined) {
      return pathMatches(filter.emitModule, `${event.packageId}::${event.module}`)
    }
    if (filter.eventType !== undefined) {
      // `package::module` names every event type defined in that module; a
      // longer path is a type, compared under the one Move type rule.
      return filter.eventType.split("::").length === 2
        ? pathMatches(filter.eventType, event.eventType)
        : typeMatches(filter.eventType, event.eventType)
    }
    return true
  }

  /**
   * One page of a ledger listing, the way the SDK's `listEvents` and
   * `listTransactions` page: `after` reads ascending from strictly after a
   * cursor, `before` descending from strictly before one, and neither reads
   * from the start in `order`. A cursor is the item's ledger position. At most
   * `scanLimit` items are examined per request, so a page may be short or empty
   * with `hasNextPage: true`; its `endCursor` is then the last position
   * examined, so continuing from it still makes progress.
   */
  const ledgerPage = <A>(
    items: ReadonlyArray<A>,
    matches: (item: A) => boolean,
    options: {
      readonly limit?: number
      readonly after?: string | null
      readonly before?: string | null
      readonly order?: "ascending" | "descending"
    }
  ): {
    items: ReadonlyArray<A>
    hasNextPage: boolean
    startCursor: string | null
    endCursor: string | null
  } => {
    const descending = options.before !== undefined && options.before !== null
      ? true
      : options.after !== undefined && options.after !== null
      ? false
      : options.order === "descending"
    const step = descending ? -1 : 1
    let position = descending
      ? (options.before === undefined || options.before === null
        ? items.length - 1
        : Number(options.before) - 1)
      : (options.after === undefined || options.after === null ? 0 : Number(options.after) + 1)
    const limit = options.limit ?? pageSize
    const scanLimit = script.scanLimit ?? Number.POSITIVE_INFINITY
    const found: Array<A> = []
    let first: number | undefined
    let last: number | undefined
    let examined = 0
    while (position >= 0 && position < items.length && found.length < limit && examined < scanLimit) {
      const item = items[position] as A
      examined += 1
      last = position
      if (matches(item)) {
        if (first === undefined) first = position
        found.push(item)
      }
      position += step
    }
    return {
      items: found,
      hasNextPage: position >= 0 && position < items.length,
      startCursor: first === undefined ? null : String(first),
      endCursor: last === undefined ? null : String(last)
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
          // The one Move type rule, so `0x2::object::ID` and its padded
          // spelling name the same key type.
          typeMatches(options.name.type, field.name.type) &&
          sameBytes(field.name.bcs, options.name.bcs)
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
      // Like the real SDK, return the value type only under `value.type`.
      const { valueType: _valueType, ...withoutValueType } = entry
      return {
        dynamicField: {
          ...(withoutValueType as typeof entry),
          value,
          version: "1",
          digest: fakeDigest(21),
          previousTransaction: null
        } as SuiClientTypes.DynamicField
      }
    },
    getDynamicObjectField: async (options: SuiClientTypes.GetDynamicObjectFieldOptions) => {
      record("getDynamicObjectField", options)
      const parent = normalizeSuiAddress(options.parentId)
      const wrapped = `0x2::dynamic_object_field::Wrapper<${options.name.type}>`
      const entry = (script.dynamicFields?.[parent] ?? []).find(
        (field) =>
          field.$kind === "DynamicObject" &&
          (typeMatches(options.name.type, field.name.type) ||
            typeMatches(wrapped, field.name.type)) &&
          sameBytes(field.name.bcs, options.name.bcs)
      )
      if (entry === undefined || entry.childId === undefined) {
        throw new ObjectError("notFound", "dynamic object field not found", {
          reason: "notFound",
          objectId: parent
        })
      }
      return { object: toSdkObject(lookup(entry.childId), options.include) }
    },
    getBalance: async (options: SuiClientTypes.GetBalanceOptions) => {
      record("getBalance", options)
      return { balance: balanceOf(options.owner, options.coinType ?? SUI_TYPE_ARG) }
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
        return asResult(await applyOutcome(recorded, "getTransaction", options.digest), options.include)
      }
      const known = state.knownTransactions.get(options.digest)
      if (known !== undefined && state.scripts.getTransaction.length === 0) {
        return asResult(known, options.include)
      }
      return asResult(await settle("getTransaction", options.digest, options), options.include)
    },
    executeTransaction: async (options: SuiClientTypes.ExecuteTransactionOptions) => {
      record("executeTransaction", options)
      const derived = derivedDigestOf(options.transaction)
      const digest = derived ?? fakeDigest(state.calls.length + 1)
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
      // Balances are checked and moved only for bytes the fake can read, and
      // only here — a replay of a known digest above moves nothing. A refusal
      // throws before anything is settled or recorded as known.
      const data = derived === undefined ? undefined : dataOfBytes(options.transaction)
      if (data !== undefined) refuseUnfunded(data)
      const before = [...state.coins]
      lastExecution = undefined
      const settled = await settle(
        "execute",
        digest,
        options,
        paymentOfBytes(options.transaction),
        derived !== undefined
      )
      if (data !== undefined) applyBalanceEffects(data, settled, before, lastExecution)
      if (data !== undefined && !settled.failed) applyAliasEffects(data, digest)
      state.knownTransactions.set(digest, settled)
      appendToLedger(digest)
      state.executedMeta.set(digest, metaOfBytes(options.transaction))
      state.executedBytes.set(digest, options.transaction)
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
      if (known !== undefined) {
        await visibility(options)
        return asResult(known, options.include)
      }
      return asResult(await settle("getTransaction", digest, options), options.include)
    },
    simulateTransaction: async (options: SuiClientTypes.SimulateTransactionOptions) => {
      record("simulateTransaction", options)
      const digest = options.transaction instanceof Uint8Array
        ? digestOfBytes(options.transaction)
        : fakeDigest(state.calls.length + 100)
      const result = await settle("simulate", digest, options)
      return {
        ...asResult(result),
        commandResults: result.commandResults,
        gasPaymentMocked: gasPaymentMockedOf(options.transaction)
      }
    },
    listTransactions: async (options: SuiClientTypes.ListTransactionsOptions) => {
      record("listTransactions", options)
      const transactions = await ledgerTransactions()
      const result = ledgerPage(
        transactions,
        (transaction) => transactionMatches(options.filter, transaction),
        options
      )
      return {
        // A ledger entry scripted by digest names its sender on the entry.
        transactions: result.items.map((transaction) =>
          asResult(transaction.settled, options.include, transaction.sender)
        ),
        hasNextPage: result.hasNextPage,
        startCursor: result.startCursor,
        endCursor: result.endCursor
      } as unknown as SuiClientTypes.ListTransactionsResponse
    },
    listEvents: async (options: SuiClientTypes.ListEventsOptions) => {
      record("listEvents", options)
      const entries: Array<SuiClientTypes.EventEntry> = []
      for (const transaction of await ledgerTransactions()) {
        const { checkpoint } = transaction.settled.transaction
        // The fake's transactions always carry every include, events among them.
        const events = (transaction.settled.transaction.events ?? []) as ReadonlyArray<
          SuiClientTypes.Event
        >
        events.forEach((event, eventIndex) => {
          entries.push({
            ...event,
            checkpoint: checkpoint ?? null,
            transactionDigest: transaction.digest,
            eventIndex
          })
        })
      }
      const result = ledgerPage(entries, (entry) => eventMatches(options.filter, entry), options)
      return {
        events: [...result.items],
        hasNextPage: result.hasNextPage,
        startCursor: result.startCursor,
        endCursor: result.endCursor
      }
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
      if (script.names === undefined) return unimplemented("resolveNameServiceAddress")
      const target = script.names[options.name]
      return { address: target === undefined ? null : normalizeSuiAddress(target) }
    },
    defaultNameServiceName: async (options: SuiClientTypes.DefaultNameServiceNameOptions) => {
      record("defaultNameServiceName", options)
      if (script.names === undefined) return unimplemented("defaultNameServiceName")
      const named = Object.entries(script.names).find(([, target]) =>
        sameAddress(options.address, target)
      )
      return { data: { name: named === undefined ? null : named[0] } }
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

  const ownedBy = (address: string, owner: SuiClientTypes.ObjectOwner | null | undefined): boolean =>
    owner?.$kind === "AddressOwner"
      ? sameAddress(address, owner.AddressOwner)
      : owner?.$kind === "ConsensusAddressOwner"
      ? sameAddress(address, owner.ConsensusAddressOwner.owner)
      : false

  /**
   * Whether a transaction moved `address`'s state, the way the gRPC ledger's
   * `affectedAddress` predicate reads it: the address sent it (and so paid
   * its gas), a balance change names it, or an object it owned before or
   * owns after the transaction changed.
   */
  const affects = (address: string, transaction: LedgerTransaction): boolean => {
    if (sameAddress(address, transaction.sender)) return true
    // The fake's transactions always carry every include.
    const settled = transaction.settled.transaction as SuiClientTypes.Transaction<
      { readonly balanceChanges: true; readonly effects: true }
    >
    if ((settled.balanceChanges ?? []).some((change) => sameAddress(address, change.address))) return true
    return (settled.effects?.changedObjects ?? []).some((change) =>
      ownedBy(address, change.inputOwner) || ownedBy(address, change.outputOwner)
    )
  }

  const cursorBytes = (position: string): Uint8Array => new TextEncoder().encode(position)
  const cursorOf = (bytes: Uint8Array | undefined): string | null =>
    bytes === undefined || bytes.length === 0 ? null : new TextDecoder().decode(bytes)

  /**
   * `LedgerService.ListTransactions` with an `affectedAddress` predicate, in
   * the server-streaming shape the gRPC client returns (`{ responses }`): one
   * frame per matching digest with its watermark cursor, then an `end` frame —
   * `ITEM_LIMIT`, `SCAN_LIMIT` (under `FakeScript.scanLimit`) or
   * `CHECKPOINT_BOUND` — carrying the last position examined. Any other
   * predicate is not modelled and dies naming it.
   */
  const listLedgerTransactions = (input: {
    readonly filter?: {
      readonly terms?: ReadonlyArray<{
        readonly literals?: ReadonlyArray<{
          readonly predicate?: { readonly oneofKind?: string; readonly affectedAddress?: { readonly address?: string } }
        }>
      }>
    }
    readonly options?: {
      readonly limit?: number
      readonly ordering?: number
      readonly after?: Uint8Array
      readonly before?: Uint8Array
    }
  }) => {
    record("ledgerService.listTransactions", input)
    const predicate = input.filter?.terms?.[0]?.literals?.[0]?.predicate
    const address = predicate?.oneofKind === "affectedAddress" ? predicate.affectedAddress?.address : undefined
    if (address === undefined) {
      return unimplemented("ledgerService.listTransactions (only an affectedAddress predicate is modelled)")
    }
    const options = input.options ?? {}
    const limit = options.limit ?? pageSize
    async function* responses() {
      const indexed = (await ledgerTransactions()).map((transaction, position) => ({ transaction, position }))
      const page = ledgerPage(indexed, ({ transaction }) => affects(address as string, transaction), {
        limit,
        after: cursorOf(options.after),
        before: cursorOf(options.before),
        order: options.ordering === 1 ? "descending" : "ascending"
      })
      for (const { transaction, position } of page.items) {
        yield {
          transaction: { digest: transaction.digest },
          watermark: { cursor: cursorBytes(String(position)) }
        }
      }
      yield {
        end: { reason: !page.hasNextPage ? 3 : page.items.length >= limit ? 1 : 2 },
        ...(page.endCursor === null ? {} : { watermark: { cursor: cursorBytes(page.endCursor) } })
      }
    }
    return { responses: responses() }
  }

  const ledger = script.ledger
  // The `LedgerService` calls `Tx.reconcile` makes, in the `UnaryCall` shape
  // the gRPC client returns (`{ response: Promise<…> }`), and the
  // `affectedAddress` listing `Sui.streamTransactions` makes.
  const ledgerService = ledger === undefined ? undefined : {
    listTransactions: listLedgerTransactions,
    getServiceInfo: (input: unknown) => {
      record("getServiceInfo", input)
      return {
        response: Promise.resolve(
          ledger.lowestAvailableCheckpoint === undefined
            ? {}
            : { lowestAvailableCheckpoint: ledger.lowestAvailableCheckpoint }
        )
      }
    },
    getEpoch: (input: { readonly epoch?: bigint }) => {
      record("getEpoch", input)
      const first = input.epoch === undefined ? undefined : ledger.firstCheckpoints?.[String(input.epoch)]
      return {
        response: first === undefined
          ? Promise.reject(rpcError("NOT_FOUND", `epoch ${String(input.epoch)} is not available`))
          : Promise.resolve({ epoch: { epoch: input.epoch, firstCheckpoint: first } })
      }
    }
  }

  const client: ClientWithCoreApi = {
    network: script.network ?? "localnet",
    cache: undefined,
    core,
    tryGetPastObject,
    ...(ledgerService === undefined ? {} : { ledgerService }),
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
    core: makeFromClient(client, script.readOptions),
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
    setVisibilityDelay: (delay) =>
      Effect.sync(() => {
        state.visibilityDelay = delay
      }),
    recordTransaction: (digest, outcome) =>
      Effect.sync(() => {
        state.byDigest.set(digest, outcome)
        appendToLedger(digest)
      }),
    setAddressBalance: (owner, coinType, amount) =>
      Effect.sync(() => {
        setAddressBalanceOf(owner, coinType, amount)
      }),
    readAddressBalance: (owner, coinType) => Effect.sync(() => addressBalanceOf(owner, coinType)),
    setAddressAliases: (address, aliases) =>
      Effect.sync(() => {
        writeAliases(address, aliases)
      }),
    readAddressAliases: (address) => Effect.sync(() => Option.fromNullishOr(aliasesOf(address))),
    setOutcomes: (method, outcomes) =>
      Effect.sync(() => {
        state.scripts = { ...state.scripts, [method]: outcomes }
        state.cursors = { ...state.cursors, [method]: 0 }
      })
  }
}
