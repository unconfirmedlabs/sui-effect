/**
 * `Tx`: the transaction lifecycle as functions with typed outcomes.
 *
 * Build, sign, submit and reconcile are separate functions rather than a state
 * machine object, because the thing a program wants to say is "put this on
 * chain and tell me what happened", and the thing it must be able to say after
 * a crash is "what did I already send?". Every function takes what it needs and
 * returns what it learned; the union is in the journal, not in the API.
 *
 * Every function here has `R = Sui` and nothing else. `SubmitConfig` and
 * `Journal` are `Context.Reference`s with defaults, so a one-shot script needs
 * no wiring at all.
 *
 * @since 0.1.0
 */
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { SuiGrpcClient } from "@mysten/sui/grpc"
import { GrpcCoreClient, isSuiGrpcClient } from "@mysten/sui/grpc"
import type { TransactionPlugin } from "@mysten/sui/transactions"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { fromBase58, normalizeStructTag, normalizeSuiAddress, SUI_TYPE_ARG } from "@mysten/sui/utils"

/** The shape `Transaction#setExpiration` accepts, which the SDK does not export. */
type SdkExpiration = NonNullable<Parameters<Transaction["setExpiration"]>[0]>
import { Clock, DateTime, Duration, Effect, Option, Result, Schema, Scope, Semaphore } from "effect"
import {
  BuildError,
  ExecutionFailed,
  JournalError,
  NotApplied,
  PolicyDenied,
  SigningError,
  SimulationFailed,
  SubmissionUnknown,
  SuiError,
  TransportError
} from "../domain/errors.ts"
import type { Built } from "../domain/built.ts"
import { type BuiltGas, BuiltGas as BuiltGasSchema, GasPaymentRef as GasPaymentRefSchema } from "../domain/built.ts"
import { EXECUTE_INCLUDE, Executed, fromTransactionResult, type Simulation, withSender } from "../domain/executed.ts"
import * as Metrics from "../domain/metrics.ts"
import { isUnresolved, JournalEntry } from "../domain/journal-entry.ts"
import {
  chainOf,
  CoinType,
  Digest,
  maxEpochOf,
  maxTimestampMsOf,
  Nonce,
  type NotAppliedEvidence,
  ObjectId,
  Signature,
  SignedTransaction,
  SuiAddress,
  TransactionExpiration,
  U32_MAX,
  Version
} from "../domain/schemas.ts"
import { allows as aliasAllows, readAliases, requireSigner } from "./AddressAlias.ts"
import { Journal } from "./Journal.ts"
import { defaultReadPolicy } from "./SuiCore.ts"
import { verifyTransactionSignature } from "./Verify.ts"
import type { Signer } from "./Signer.ts"
import type { FoldBatch, FoldPlan } from "./Fold.ts"
import { fold, planFold, sendFunds } from "./Fold.ts"
import { verifySponsored } from "./Sponsored.ts"
import type { LockSenderPolicy, SubmitConfigService } from "./SubmitConfig.ts"
import { SubmitConfig } from "./SubmitConfig.ts"
import type { Recipe } from "./Sui.ts"
import { Sui } from "./Sui.ts"

/** A transaction built into bytes, with the expiration the builder settled on. */
export type { Built } from "../domain/built.ts"

/**
 * Signed bytes: everything `executeTransaction` needs, plus what `reconcile`
 * needs.
 *
 * An interface rather than a type alias so the name survives into `.d.ts`,
 * editor hover and `LLMS.md`; structurally it is {@link SignedTransaction}.
 */
export interface Signed extends SignedTransaction {}
/** The schema of {@link Signed}. */
export const Signed = SignedTransaction

/** What `Tx.reconcile` can be asked about. */
export type ReconcileInput = Digest | Signed | SubmissionUnknown

/**
 * Everything {@link submit} can fail with, as one name.
 *
 * A library that wraps a submission spells its own errors plus this, rather
 * than repeating four tags that will grow with the taxonomy.
 */
export type SubmitError =
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | JournalError
  | TransportError

/**
 * Everything {@link run} can fail with, as one name: {@link SubmitError} plus
 * what building, preflighting and signing can produce.
 */
export type RunError =
  | BuildError
  | SimulationFailed
  | PolicyDenied
  | SigningError
  | SubmitError
  | TransportError

/**
 * What one entry of `Tx.reconcileAll` settled to, as a tagged union.
 *
 * Every case carries **one** discriminator in the same place: `_tag` is
 * `"Executed"`, `"ExecutionFailed"`, `"NotApplied"` or `"SubmissionUnknown"`,
 * and the payload is `executed` for the first and `error` for the other three.
 * Before 0.1.2 this was a bare union of an `Executed` (which has no `_tag`) and
 * three errors (which do), so the only way to tell a success from a failure was
 * `"_tag" in entry` — a shape nothing could `Schema.match` or serialize.
 *
 * @since 0.1.2
 */
export const Reconciled = Schema.TaggedUnion({
  /** The transaction is on chain and succeeded. */
  Executed: { executed: Executed },
  /** The transaction is on chain and failed. Gas was charged. */
  ExecutionFailed: { error: ExecutionFailed },
  /** The transaction provably never applied and never will. */
  NotApplied: { error: NotApplied },
  /** The outcome is still not known; the bytes are in the error. */
  SubmissionUnknown: { error: SubmissionUnknown }
})
/** One settled entry of `Tx.reconcileAll`. @since 0.1.2 */
export type Reconciled = typeof Reconciled.Type

/**
 * The transport statuses that mean **the node refused the request outright**,
 * so the bytes were never executed and never will be by this send.
 *
 * gRPC `INVALID_ARGUMENT` (numerically `3`) is what a node answers when the
 * submission itself is malformed: bytes that do not parse, or — the case this
 * exists for — a sponsored transaction carrying only the sender's signature.
 * That is not "the network was unreachable": the answer came *from* the node
 * and it is final. Reconciling it would ask a second question whose answer is
 * about some other transaction ("is this digest on chain?"), and against a
 * scripted or lagging node that question can come back yes.
 *
 * Everything else that is not retryable is still `SubmissionUnknown`: an
 * unrecognised status says nothing about whether the bytes reached a validator.
 */
const REFUSED_OUTRIGHT: ReadonlySet<string> = new Set(["INVALID_ARGUMENT", "3"])

/** Whether a transport failure is the node refusing the submission outright. */
const refusedOutright = (error: TransportError): boolean =>
  !error.retryable && error.status !== undefined && REFUSED_OUTRIGHT.has(error.status)

/** The readable text of whatever a failure carried as its cause. Never fails. */
const reasonOf = (cause: unknown): string => {
  if (typeof cause === "string") return cause
  if (typeof cause === "object" && cause !== null) {
    if (typeof (cause as { readonly _tag?: unknown })._tag === "string") {
      return SuiError.describe(cause as { readonly _tag: string })
    }
    const message = (cause as { readonly message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(cause)
}

/**
 * What a validator quorum says when **another transaction holds a lock on an
 * input these bytes pinned**: `FAILED_PRECONDITION`, "rejected as invalid by
 * more than 1/3 of validators by stake (non-retriable)", "already locked by a
 * different transaction". It is not a refusal of the request — the bytes were
 * well-formed and reached validators — so it is reconciled; but it names a
 * race that is usually settled a moment later, when the winner's effects
 * become readable and the `inputConsumed` evidence with them.
 */
const LOCK_CONFLICT = /already locked by a different transaction|rejected as invalid by more than 1\/3 of validators/i

/** Whether a send failed on another transaction's lock. Never fails. */
const lockConflict = (error: TransportError): boolean =>
  !error.retryable && LOCK_CONFLICT.test(reasonOf(error.cause))

/**
 * How many more times a lock-conflicted submission is reconciled,
 * `SubmitConfig.reconcileRecheck` apart, while the answer is still
 * `SubmissionUnknown`. Every round is the full evidence rule set; the rounds
 * only give the winner of the race time to become readable.
 */
const LOCK_CONFLICT_RECHECKS = 3

const decodeExpiration = Schema.decodeUnknownOption(TransactionExpiration)
const decodeDigest = Schema.decodeUnknownEffect(Digest)
const decodeDigestOption = Schema.decodeUnknownOption(Digest)
const decodeVersion = Schema.decodeUnknownOption(Version)
const decodeObjectId = Schema.decodeUnknownOption(ObjectId)
const decodeNonce = Schema.decodeUnknownEffect(Nonce)
const decodeAddress = Schema.decodeUnknownOption(SuiAddress)
const decodeSignature = Schema.decodeUnknownOption(Signature)

const buildError = (message: string) => (cause: unknown): BuildError =>
  new BuildError({ message, cause })

/**
 * The gRPC resolve plugin, re-created over a client whose
 * `transactionExecutionService.simulateTransaction` carries the Effect's
 * `AbortSignal`.
 *
 * This is the one request `abortableClient`'s `core` proxy cannot reach.
 * `GrpcCoreClient#resolveTransactionPlugin` closes over the private grpc client
 * it was constructed with and calls `simulateTransaction(request)` with no
 * second argument, while every other method on that class passes
 * `{ abort: options.signal }`. So an interrupted `Tx.build` on a gRPC client
 * ended — releasing the sender lock — with the resolver's simulate still in
 * flight.
 *
 * Nothing is re-implemented. `GrpcCoreClient` is public
 * (`@mysten/sui/grpc`), and its constructor takes the grpc client it will use:
 * handing it a `SuiGrpcClient` whose `transactionExecutionService` adds
 * `{ abort: signal }` and whose `core` is the already-signalled proxy gives back
 * the SDK's **own** plugin, line for line, with the signal attached. The cache
 * is shared through `base`, so nothing is read twice.
 *
 * Never fails.
 */
const grpcResolvePlugin = (
  client: SuiGrpcClient,
  core: object,
  signal: AbortSignal
): TransactionPlugin => {
  const service = client.transactionExecutionService
  const abortable = new Proxy(service, {
    get: (receiver, key) => {
      const value = Reflect.get(receiver, key)
      if (typeof value !== "function") return value
      if (key !== "simulateTransaction") {
        return (...args: Array<unknown>) =>
          (value as (...a: Array<unknown>) => unknown).apply(receiver, args)
      }
      return (input: unknown, options?: Record<string, unknown>) =>
        (value as (...a: Array<unknown>) => unknown).call(receiver, input, {
          ...(options ?? {}),
          // A caller that passed its own signal keeps it; the resolver passes
          // none, which is the whole bug.
          abort: options?.["abort"] ?? signal
        })
    }
  })
  const shadow = new Proxy(client, {
    get: (receiver, key) => {
      // `setAddressBalanceTransactionExpirationFromSimulatedEpoch` reads
      // `client.core.getChainIdentifier()` and `client.core
      // .getCurrentSystemState()` out of this same object, so it gets the
      // signalled core too.
      if (key === "core") return core
      if (key === "transactionExecutionService") return abortable
      const value = Reflect.get(receiver, key)
      return typeof value === "function"
        ? (value as (...a: Array<unknown>) => unknown).bind(receiver)
        : value
    }
  })
  return new GrpcCoreClient({
    client: shadow as SuiGrpcClient,
    base: client,
    network: client.network
  }).resolveTransactionPlugin()
}

/**
 * The SDK client with the Effect's `AbortSignal` injected into every Core call.
 *
 * `Transaction#build` takes no signal: `BuildTransactionOptions` has no such
 * field, and the gRPC resolve plugin simulates with whatever the client hands
 * it. So an interrupted `Tx.build` used to end — releasing the sender lock —
 * while the simulate it started stayed in flight. The only cancellation hook
 * the SDK offers is the `signal` on each Core method, and the resolver reaches
 * those through `options.client`, so a client whose `core` injects the signal is
 * how an interrupt reaches the request.
 *
 * `resolveTransactionPlugin` is delegated untouched on every transport but
 * gRPC, whose plugin simulates through a captured private client that no proxy
 * of `core` can reach: there it is rebuilt by {@link grpcResolvePlugin}, which
 * is the same SDK plugin over a client that carries the signal.
 */
const abortableClient = (client: ClientWithCoreApi, signal: AbortSignal): ClientWithCoreApi => {
  const grpc = isSuiGrpcClient(client) ? client : undefined
  let core: object | undefined
  const inject = (target: object): object =>
    new Proxy(target, {
      get: (receiver, key) => {
        const value = Reflect.get(receiver, key)
        if (typeof key !== "string") return value
        if (key === "resolveTransactionPlugin") {
          if (grpc !== undefined) {
            return () => grpcResolvePlugin(grpc, core ?? (client.core as unknown as object), signal)
          }
          return typeof value === "function"
            ? (...args: Array<unknown>) =>
              (value as (...a: Array<unknown>) => unknown).apply(receiver, args)
            : value
        }
        if (typeof value === "function") {
          return (options?: Record<string, unknown>, ...rest: Array<unknown>) =>
            (value as (...a: Array<unknown>) => unknown).call(
              receiver,
              { ...(options ?? {}), signal: options?.["signal"] ?? signal },
              ...rest
            )
        }
        if (
          value !== null && typeof value === "object" &&
          Object.getPrototypeOf(value) === Object.prototype
        ) {
          // `core.mvr` is a plain namespace of methods; it needs the same
          // treatment and nothing else does.
          return inject(value as object)
        }
        return value
      }
    })

  core = inject(client.core as unknown as object)
  const coreProxy = core
  return new Proxy(client, {
    get: (receiver, key) => {
      if (key === "core") return coreProxy
      const value = Reflect.get(receiver, key)
      // Bound, so a method reached through the proxy still sees the real
      // instance as `this` — a class with private fields would throw otherwise.
      return typeof value === "function" ? (value as (...a: Array<unknown>) => unknown).bind(receiver) : value
    }
  })
}

/**
 * Whether the SDK will have to resolve this transaction at all.
 *
 * It mirrors the SDK's own `needsTransactionResolution`, which is not exported:
 * the resolve plugin returns early — no gas-budget simulation, no plugin call
 * at all — when every input is resolved and the gas price, budget and payment
 * are already set. Resolving is necessary for the SDK to simulate, not
 * sufficient: {@link sdkSimulates} is the question `Tx.build` asks.
 *
 * Bytes this version cannot read answer `false`, which costs one simulate and
 * keeps the guarantee. Never fails.
 */
const willResolve = (tx: Transaction): boolean => {
  try {
    const data = tx.getData()
    if (
      data.inputs.some((input) =>
        input.UnresolvedObject !== undefined || input.UnresolvedPure !== undefined
      )
    ) {
      return true
    }
    const gas = data.gasData
    if (!gas.price || !gas.budget) return true
    const payment = gas.payment
    if (payment === null || payment === undefined) return true
    if (payment.length === 0 && data.expiration == null) return true
    return false
  } catch {
    return false
  }
}

/**
 * Whether building this transaction against this client simulates it with
 * checks enabled — the question "building always simulates" depends on.
 *
 * The SDK has two resolvers, and they answer differently:
 *
 * - the **gRPC** plugin (`GrpcCoreClient.resolveTransactionPlugin`) simulates,
 *   checks enabled, every time it runs;
 * - the **core** resolver every other transport uses
 *   (`coreClientResolveTransactionPlugin`) simulates only inside
 *   `setGasBudget`, which returns at once when the budget is already set. A
 *   recipe that calls `tx.setGasBudget(...)` and leaves its coins and object
 *   inputs to the resolver is resolved without ever being shown to execute.
 *
 * So: `false` when nothing resolves; `true` on a gRPC client; otherwise
 * whether the budget is still unset. Must be asked **before** the build, which
 * sets the budget. Bytes this version cannot read answer `false`, which costs
 * one simulate and keeps the guarantee. Never fails.
 */
const sdkSimulates = (tx: Transaction, client: ClientWithCoreApi): boolean => {
  if (!willResolve(tx)) return false
  if (isSuiGrpcClient(client)) return true
  try {
    return !tx.getData().gasData.budget
  } catch {
    return false
  }
}

/**
 * The object inputs the transaction has not resolved yet, which are exactly
 * the ones the resolver is about to look up. Never fails.
 */
const unresolvedObjectIdsOf = (tx: Transaction): ReadonlyArray<string> => {
  try {
    return tx.getData().inputs
      .map((input) => input.UnresolvedObject?.objectId)
      .filter((id): id is string => typeof id === "string")
  } catch {
    return []
  }
}

/**
 * The bytes as the SDK reads them, or `None` for bytes this version cannot
 * parse. Every reader below is pure over the parsed data, so a caller that
 * needs two facts out of one set of bytes parses them once.
 */
const dataOfBytes: (bytes: Uint8Array) => Option.Option<TransactionDataBuilder> = Option
  .liftThrowable((bytes: Uint8Array) => TransactionDataBuilder.fromBytes(bytes))

/** A pinned object reference: an id and the version the bytes named. */
type PinnedRef = { readonly objectId: string; readonly version: Version }

/**
 * The expiration a transaction was built with, read back out of the bytes so
 * that what is recorded is what was signed rather than what was intended.
 */
const expirationOf = (data: TransactionDataBuilder): TransactionExpiration | undefined =>
  data.expiration === null || data.expiration === undefined
    ? undefined
    : Option.getOrUndefined(decodeExpiration(data.expiration))

/** The owned object inputs a transaction referenced, with the versions it pinned. */
const ownedInputsOf = (data: TransactionDataBuilder): ReadonlyArray<PinnedRef> => {
  const inputs: Array<PinnedRef> = []
  for (const input of data.inputs) {
    const object = input.Object
    if (object === undefined) continue
    const owned = object.ImmOrOwnedObject ?? object.Receiving
    if (owned === undefined) continue
    const version = decodeVersion(String(owned.version))
    if (version._tag === "Some") {
      inputs.push({ objectId: owned.objectId, version: version.value })
    }
  }
  return inputs
}

/**
 * The 20 bytes that mark a **coin reservation** ref, at offset 12 of its
 * 32-byte digest.
 *
 * Mirrors `COIN_RESERVATION_MAGIC` and `isCoinReservationDigest` in the SDK's
 * `dist/utils/coin-reservation.mjs`, which the typed `@mysten/sui/utils` index
 * does not export (and which 2.30 does not ship at all).
 */
const COIN_RESERVATION_MAGIC = 0xac
const COIN_RESERVATION_MAGIC_OFFSET = 12
const DIGEST_LENGTH = 32

/**
 * Whether a gas payment ref is a synthetic coin reservation rather than an
 * object.
 *
 * The core resolver's `setGasPayment` and node-side gRPC gas selection may put
 * one first in `gasData.payment` to draw gas from the address balance: version
 * `0`, a digest carrying the magic, and an object id that is the accumulator
 * field id XOR the chain id. There is no such object, so reading it proves
 * nothing and only costs a read — and used to name a nonsense id as the reason
 * of every `SubmissionUnknown` for such a transaction. Never fails.
 */
const isCoinReservationRef = (ref: { readonly version: string | number; readonly digest: string }): boolean => {
  if (String(ref.version) !== "0") return false
  try {
    const bytes = fromBase58(ref.digest)
    return bytes.length === DIGEST_LENGTH &&
      bytes.slice(COIN_RESERVATION_MAGIC_OFFSET).every((byte) => byte === COIN_RESERVATION_MAGIC)
  } catch {
    return false
  }
}

/**
 * The gas coins a transaction pinned, which are owned inputs too: a sponsored
 * transaction pays from an address balance and has none, but an ordinary one
 * names its coins in `gasData.payment` rather than in `inputs`, and a coin that
 * has moved on is exactly as good evidence as any other consumed input. A coin
 * reservation ref is not a coin and is left out.
 */
const gasPaymentOf = (data: TransactionDataBuilder): ReadonlyArray<PinnedRef> => {
  const refs: Array<PinnedRef> = []
  for (const ref of data.gasData.payment ?? []) {
    if (isCoinReservationRef(ref)) continue
    const version = decodeVersion(String(ref.version))
    if (version._tag === "Some") refs.push({ objectId: ref.objectId, version: version.value })
  }
  return refs
}

/** Every object reference whose version these bytes pinned, inputs and gas alike. */
const pinnedRefsOfBytes = (bytes: Uint8Array): ReadonlyArray<PinnedRef> =>
  Option.match(dataOfBytes(bytes), {
    onNone: () => [],
    onSome: (data) => [...ownedInputsOf(data), ...gasPaymentOf(data)]
  })

/** The addresses a transaction's bytes will accept a signature from. */
const signersOfBytes = (bytes: Uint8Array): ReadonlyArray<string> =>
  Option.match(dataOfBytes(bytes), {
    onNone: () => [],
    onSome: (data) =>
      [data.sender, data.gasData.owner]
        .filter((address): address is string => typeof address === "string" && address.length > 0)
        .map((address) => normalizeSuiAddress(address))
  })

const gasBudgetOf = (data: TransactionDataBuilder): bigint | undefined => {
  const budget = data.gasData.budget
  return budget === null || budget === undefined ? undefined : BigInt(budget)
}

const gasPriceOf = (data: TransactionDataBuilder): bigint | undefined => {
  const price = data.gasData.price
  return price === null || price === undefined ? undefined : BigInt(price)
}

/**
 * The gas owner the bytes name, when it is someone other than the sender, as
 * the padded address. `undefined` for a transaction the sender pays for.
 * Never fails.
 */
const gasOwnerOf = (data: TransactionDataBuilder): SuiAddress | undefined => {
  const owner = data.gasData.owner
  if (typeof owner !== "string" || owner.length === 0) return undefined
  const normalized = normalizeSuiAddress(owner)
  if (typeof data.sender === "string" && normalizeSuiAddress(data.sender) === normalized) return undefined
  return Option.getOrUndefined(decodeAddress(normalized))
}

/**
 * The gas payment a not-yet-built transaction carries: `undefined` when the
 * recipe left it to the resolver (or the data cannot be read), else how many
 * refs it set — `0` is an explicit address-balance payment. Never fails.
 */
const paymentLengthOf = (tx: Transaction): number | undefined => {
  try {
    const payment = tx.getData().gasData.payment
    return payment === null || payment === undefined ? undefined : payment.length
  } catch {
    return undefined
  }
}

/**
 * How built bytes pay for gas, as the span attribute `sui.gas_payment` names
 * it: `"addressBalance"` for an empty payment, `"coinReservation"` when every
 * ref is a coin reservation (gas drawn from the balance through a synthetic
 * coin, which a `tx.gas` user gets), `"coins"` as soon as one coin object is
 * in it. Never fails.
 */
type GasPaymentKind = "addressBalance" | "coinReservation" | "coins"
const gasPaymentKindOf = (data: TransactionDataBuilder): GasPaymentKind => {
  const payment = data.gasData.payment ?? []
  if (payment.length === 0) return "addressBalance"
  return payment.every((ref) => isCoinReservationRef(ref)) ? "coinReservation" : "coins"
}

/**
 * Whether any argument of any command is the gas coin. Mirrors the SDK's
 * `transactionUsesGasCoin`, which is not exported, over the plain data a
 * `Transaction` gives before it is built. Never fails; data this version
 * cannot read answers `true`, which keeps an unset payment unset.
 */
const mentionsGasCoin = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(mentionsGasCoin)
  if (typeof value !== "object" || value === null) return false
  if ((value as { readonly $kind?: unknown }).$kind === "GasCoin") return true
  return Object.values(value).some(mentionsGasCoin)
}
const usesGasCoin = (tx: Transaction): boolean => {
  try {
    return mentionsGasCoin(tx.getData().commands)
  } catch {
    return true
  }
}

/**
 * The SUI the bytes reserve from `payer`'s address balance through
 * `FundsWithdrawal` inputs, which comes out of the same balance as the gas: the
 * SDK's resolver adds it to the budget before it pays gas from the balance,
 * and so does `Tx.build`'s check. Never fails.
 */
/**
 * Where a `FundsWithdrawal` draws from, as every supported SDK spells it: 2.28
 * to 2.3x know `Sender` and `Sponsor`, and allowances (2.38) add
 * `SenderAllowance`. Declared here so the read typechecks against both.
 */
interface WithdrawSource {
  readonly Sender?: unknown
  readonly Sponsor?: unknown
  readonly SenderAllowance?: { readonly funder: string }
}

const suiWithdrawalsFrom = (data: TransactionDataBuilder, payer: string): bigint => {
  const target = normalizeSuiAddress(payer)
  const sui = normalizeStructTag(SUI_TYPE_ARG)
  let total = 0n
  for (const input of data.inputs) {
    const withdrawal = input.FundsWithdrawal
    if (withdrawal === undefined) continue
    try {
      if (normalizeStructTag(withdrawal.typeArg.Balance) !== sui) continue
      const source: WithdrawSource = withdrawal.withdrawFrom
      const owner = source.SenderAllowance !== undefined
        ? source.SenderAllowance.funder
        : source.Sender !== undefined
        ? data.sender
        : data.gasData.owner ?? data.sender
      if (typeof owner !== "string" || normalizeSuiAddress(owner) !== target) continue
      if (withdrawal.reservation.$kind === "MaxAmountU64") total += BigInt(withdrawal.reservation.MaxAmountU64)
    } catch {
      continue
    }
  }
  return total
}

/**
 * Whether, under `lockSender: "whenPinned"`, `Tx.run` keeps the sender lock
 * through signing and submission for these bytes: they have an owned or
 * receiving input, or **any** gas payment — a coin, or a coin reservation.
 *
 * A coin reservation is not a pinned *reference* (reconcile leaves it out, see
 * {@link gasPaymentOf}), but it is not harmless either: the resolver gives a
 * `tx.gas` user whose payer has an address balance a reservation of that
 * **whole** balance as read at build time. A spend from the balance that lands
 * after the build makes it stale, and the node refuses it at submit
 * (`INVALID_ARGUMENT`, "Invalid withdraw reservation"); one in flight beside it
 * makes one of the two execute as `InsufficientFundsForWithdraw`. So only an
 * empty payment — gas from the balance, drawn at execution — releases the lock.
 * Bytes this version cannot read answer `true`, which keeps the lock. Never
 * fails.
 */
const keepsSenderLock = (bytes: Uint8Array): boolean =>
  Option.match(dataOfBytes(bytes), {
    onNone: () => true,
    onSome: (data) => ownedInputsOf(data).length > 0 || (data.gasData.payment ?? []).length > 0
  })

/**
 * `SubmitConfig.lockSender` as one of the three policies, whatever was
 * provided. `SubmitConfig.with` maps the pre-0.4.0 booleans, but a config
 * provided directly (`Effect.provideService`), a JavaScript caller or a value
 * stored before 0.4.0 can still hold `true` / `false` or something else:
 * `true` is `"always"`, `false` is `"never"`, and anything unrecognized is
 * `"always"`, the safe one. Never fails.
 */
const lockSenderPolicyOf = (value: unknown): LockSenderPolicy => {
  if (value === "whenPinned" || value === "always" || value === "never") return value
  if (value === false) return "never"
  return "always"
}

/**
 * The lock-free `Tx.run`s in flight on one address, as permits taken from a
 * semaphore with {@link IN_FLIGHT_PERMITS} of them, and how many runs hold a
 * reference to this entry (so an idle address is dropped).
 */
interface InFlight {
  readonly semaphore: Semaphore.Semaphore
  refs: number
}

/**
 * Permits per address: one per lock-free run, all of them to drain. Far more
 * than any process has runs in flight.
 */
const IN_FLIGHT_PERMITS = Number.MAX_SAFE_INTEGER

/**
 * The in-flight registries, one per sender-lock map. Keyed by the
 * `withSenderLock` function itself, which every spread of one `Sui` shares,
 * so every `Tx.run` that serializes on the same locks sees the same runs in
 * flight. A `WeakMap`, so a dropped `Sui` takes its registry with it.
 */
const IN_FLIGHT = new WeakMap<object, Map<string, InFlight>>()

const inFlightRegistryOf = (key: object): Map<string, InFlight> => {
  let registry = IN_FLIGHT.get(key)
  if (registry === undefined) {
    registry = new Map()
    IN_FLIGHT.set(key, registry)
  }
  return registry
}

/**
 * A reference to `address`'s in-flight entry until the scope closes, creating
 * it on first use. The last reference out deletes it, so a sponsor serving
 * thousands of senders holds entries only for the ones with a run in flight.
 */
const inFlightEntry = (
  registry: Map<string, InFlight>,
  address: string
): Effect.Effect<InFlight, never, Scope.Scope> => {
  const key = normalizeSuiAddress(address)
  return Effect.acquireRelease(
    Effect.sync(() => {
      let entry = registry.get(key)
      if (entry === undefined) {
        entry = { semaphore: Semaphore.makeUnsafe(IN_FLIGHT_PERMITS), refs: 0 }
        registry.set(key, entry)
      }
      entry.refs += 1
      return entry
    }),
    (entry) =>
      Effect.sync(() => {
        entry.refs -= 1
        if (entry.refs === 0 && registry.get(key) === entry) registry.delete(key)
      })
  )
}

/**
 * Registers a lock-free run as in flight on each address until the scope
 * closes. Each step adds its own release to the scope as it acquires —
 * `acquireRelease` and `takeScoped` both do so in one uninterruptible step —
 * so success, failure and interruption all return the permit. Never fails.
 */
const registerInFlight = (
  registry: Map<string, InFlight>,
  addresses: ReadonlyArray<string>
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.forEach(
    [...new Set(addresses.map((address) => normalizeSuiAddress(address)))],
    (address) => Effect.flatMap(inFlightEntry(registry, address), (entry) => entry.semaphore.takeScoped(1)),
    { discard: true }
  )

/**
 * Waits until no lock-free run is in flight on `address`: takes every permit
 * and gives them straight back. Called with the build locks held, so a run on
 * this address cannot register in the meantime through its own build; one paid
 * by this address for another sender (`Tx.sponsored`, which takes only the
 * sender's lock) can, and is then simply not waited for. An interrupted wait
 * leaves the queue, so nothing leaks. Never fails.
 */
const drainInFlight = (registry: Map<string, InFlight>, address: string): Effect.Effect<void> =>
  Effect.suspend(() =>
    registry.has(normalizeSuiAddress(address))
      ? Effect.scoped(
        Effect.flatMap(
          inFlightEntry(registry, address),
          (entry) => entry.semaphore.withPermits(IN_FLIGHT_PERMITS)(Effect.void)
        )
      )
      : Effect.void
  )

/**
 * The statuses with which a node refuses to **resolve** a transaction: the
 * request reached it and the answer is about the transaction, not the network.
 * A missing function, an object owned by someone else, gas selection that
 * found nothing to select — all `INVALID_ARGUMENT` (`3`), with
 * `FAILED_PRECONDITION` (`9`) for an input in a state that cannot be used.
 * Nothing has been signed, so each of them is a `BuildError`.
 */
const REFUSED_TO_RESOLVE: ReadonlySet<string> = new Set(["INVALID_ARGUMENT", "3", "FAILED_PRECONDITION", "9"])

/** Whether a value is an `Error` thrown as itself, not a subclass of it. */
const isPlainError = (cause: unknown): cause is Error =>
  cause instanceof Error && Object.getPrototypeOf(cause) === Error.prototype && cause.name === "Error"

/** The node's own words, out of whatever a transport failure carried. */
const nodeMessageOf = (cause: unknown): string => {
  if (typeof cause === "string") return cause
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === "object" && cause !== null) {
    const message = (cause as { readonly message?: unknown }).message
    if (typeof message === "string" && message.length > 0) return message
  }
  return String(cause)
}

/**
 * Thrown by the build plugin `gaslessStablecoinTransfer({ requireZeroGas })`
 * installs, when the resolver did not set zero gas. A class of its own so
 * `Tx.build` can tell it from a transport failure and report it as the
 * `BuildError` it is.
 */
class ZeroGasNotResolved extends Error {
  constructor(price: string, budget: string) {
    super(
      `the transaction was required to be gasless, but the resolver set gas price ${price} and` +
        ` budget ${budget}: the coin type, the amount or the transport does not qualify for` +
        " gasless execution (only gRPC and GraphQL resolution detect it)"
    )
    this.name = "ZeroGasNotResolved"
  }
}

/**
 * What a `TransportError` out of the SDK's resolver means to `Tx.build`.
 *
 * The resolver runs inside `SuiCore.use`, so its failures arrive named
 * `"use"` — a name that says nothing to the caller of `Tx.build`. A node that
 * refused the transaction itself (`REFUSED_TO_RESOLVE`), could not find an
 * input (`NOT_FOUND`), an SDK resolver that refused with a plain `Error`, or a
 * zero-gas requirement that was not met is a `BuildError` carrying the message and the `TransportError` as its
 * cause; anything else is still a `TransportError`, renamed `"Tx.build"`, with
 * its status and retryability intact.
 */
const resolverError = (
  error: TransportError,
  unresolved: ReadonlyArray<string>
): BuildError | TransportError => {
  if (error.cause instanceof ZeroGasNotResolved) {
    return new BuildError({ message: error.cause.message, cause: error })
  }
  if (error.status === "NOT_FOUND") {
    return new BuildError({
      message: "an input could not be resolved: the node answered NOT_FOUND" +
        (unresolved.length === 0 ? "" : ` for one of ${unresolved.join(", ")}`),
      cause: error
    })
  }
  if (!error.retryable && error.status !== undefined && REFUSED_TO_RESOLVE.has(error.status)) {
    return new BuildError({
      message: `the node refused to resolve the transaction (${error.status}): ${nodeMessageOf(error.cause)}`,
      cause: error
    })
  }
  if (!error.retryable && error.status === undefined && isPlainError(error.cause)) {
    // The SDK's own resolver refuses with a bare `Error` — "Insufficient
    // balance of <coin> for owner <address>", "Could not resolve gas payment"
    // — after reads that succeeded. A transport failure is never one: a
    // rejected `fetch` is a `TypeError`, a node's answer an `RpcError` or an
    // HTTP status error, each of which carries a name or a status.
    return new BuildError({
      message: `the SDK could not resolve the transaction: ${error.cause.message}`,
      cause: error
    })
  }
  return new TransportError({
    method: "Tx.build",
    retryable: error.retryable,
    ...(error.status === undefined ? {} : { status: error.status }),
    cause: error.cause
  })
}

const toTransaction = (input: Recipe | Transaction): Effect.Effect<Transaction, BuildError> =>
  typeof input === "function"
    ? Effect.try({
      try: () => {
        const tx = new Transaction()
        input(tx)
        return tx
      },
      catch: buildError("the recipe threw")
    })
    : Effect.succeed(input)

/**
 * Builds a transaction into signable bytes.
 *
 * **Building always simulates, on every transport.** When the SDK's resolver
 * simulates with checks enabled, an execution failure there arrives as
 * `SimulationFailed` and nothing extra is spent. It does not always: the gRPC
 * plugin simulates whenever it runs, but the core resolver every other
 * transport uses (JSON-RPC, GraphQL, a custom client) simulates only to choose
 * a gas budget it was not given, and neither runs at all for a transaction
 * that was **already fully resolved** (every input resolved, gas price,
 * budget and payment set). `Tx.build` decides which case it is in against the
 * client that resolves, before the build, and runs one explicit
 * `simulateTransaction` with checks enabled whenever the SDK will not — so a
 * recipe that presets `tx.setGasBudget(...)` on a non-gRPC transport is still
 * shown to execute, and a Move abort is `SimulationFailed` with no gas charged
 * rather than `ExecutionFailed` after a send.
 *
 * An interrupted build cancels the request it started: the SDK is handed a
 * client whose Core calls carry the Effect's `AbortSignal`.
 *
 * The resolver's own reads go straight to the SDK rather than through
 * `SuiCore`'s read retries, so `Tx.build` retries the whole resolve on a
 * retryable `TransportError` with the same policy (five attempts, jittered
 * exponential backoff capped at ten seconds). Nothing has been signed, so a
 * retry cannot send anything twice.
 *
 * When the recipe set no expiration, `SubmitConfig.expiration` decides one.
 * The default, `ValidDuring`, bounds the transaction to the **current epoch and
 * the next**, names the chain (bytes signed for testnet cannot land on mainnet)
 * and carries a `u32` nonce from `SubmitConfig.nonce`. There is **no
 * wall-clock bound** unless `SubmitConfig.validFor` asks for one: no Sui
 * network accepts a timestamp expiration yet, and a node refuses any
 * transaction carrying one. The expiration that ends up in the bytes is
 * recorded on the result, because it is what `Tx.reconcile` needs later to
 * prove a transaction can no longer land.
 *
 * `Tx.build` takes no sender lock; `Tx.run` is what holds one around every
 * build (and through submit when the bytes pin anything). Called on its own,
 * two concurrent builds for one address can pick the same gas coin.
 *
 * **A refusal from the resolver is a `BuildError`.** The SDK resolves inputs
 * and gas through the node, and a node that refuses the transaction itself —
 * a function that does not exist, an object owned by another address, gas
 * selection with nothing to select (gRPC `INVALID_ARGUMENT` or
 * `FAILED_PRECONDITION`), an input it cannot find (`NOT_FOUND`) — is reported
 * with the node's message, the `TransportError` kept as the cause; so is the
 * SDK resolver's own refusal ("Insufficient balance of <coin> for owner
 * <address>"). A `TransportError` that remains is the network, named
 * `"Tx.build"`.
 *
 * **Gas comes from the address balance by default.** A payment the recipe
 * left unset is the resolver's choice, and every SDK resolver pays from the
 * payer's SUI address balance when it covers the budget and the transaction
 * does not use `tx.gas`, and from coins otherwise; the span attribute
 * `sui.gas_payment` says which (`"addressBalance"`, `"coinReservation"`,
 * `"coins"`). Under `SubmitConfig.gasPayment: "requireAddressBalance"` an unset
 * payment is pinned to the balance before the build (unless the transaction
 * uses `tx.gas`), and coins chosen for a `tx.gas` user fail the build.
 *
 * **Gas from an address balance is checked before anything is signed.** When
 * the gas payment is an explicit empty list (what `Tx.sponsored` sets, or the
 * `"requireAddressBalance"` policy), the payer — the gas owner, or the sender —
 * must hold at least the gas budget plus the SUI the bytes withdraw from it in
 * its SUI address balance, coins not counted; the simulation does not check it
 * and the node refuses the bytes at execution. That costs one `getBalance`
 * read, for those transactions only. Bytes paying from an address balance
 * with no address-owned input need a `ValidDuring` expiration, which a node
 * otherwise refuses outright (the default expiration is one), and must not use
 * `tx.gas`: with an empty payment the gas coin is empty, which a simulation
 * does not show and execution fails on, charging gas.
 *
 * `Built.gasOwner` is read out of the bytes: it is present whenever the bytes
 * name a gas owner other than the sender, whether `opts.gasOwner` or the
 * recipe set it. So is `Built.gas` (0.5.0): budget, price, payer, payment refs
 * and their `source` — `"addressBalance"`, `"coinReservation"` or `"coins"`,
 * the `sui.gas_payment` attribute. `Built.simulation` (0.5.0) is the explicit
 * simulate above when it ran, which is a simulation of exactly the returned
 * bytes; when the SDK's resolver simulated instead (always on gRPC) it
 * simulated the transaction before its budget was set, and there is none.
 *
 * **`opts.maxEpoch` keeps the window inside a signer's bound** (0.5.0): the default
 * expiration's `maxEpoch` is the current epoch plus one or the bound,
 * whichever is lower, and a bound below the current epoch fails before
 * anything resolves. `Tx.run` passes the signer's (and sponsor's)
 * `Signer.maxEpoch` here. A recipe's own expiration is the recipe's choice
 * and is not changed.
 *
 * Fails with: `BuildError` (the recipe threw, an input could not be resolved,
 * the bound `opts.maxEpoch` is below the current epoch — its `cause`
 * is the `SigningError { reason: "expired" }` `Tx.run` reports instead,
 * the node refused to resolve the transaction, a zero-gas requirement was not
 * met, the payer's address balance cannot cover the budget and withdrawals,
 * coins were chosen under `gasPayment: "requireAddressBalance"`, or an
 * address-balance payment lacks an epoch-bounded expiration or is used with
 * `tx.gas`),
 * `SimulationFailed` (the transaction would abort on chain), `PolicyDenied`
 * (rule `"maxGasBudget"`: the budget the node chose is over
 * `SubmitConfig.maxGasBudget`), `TransportError`.
 */
export const build = Effect.fn("Tx.build")(function*(
  input: Recipe | Transaction,
  opts: {
    readonly sender: SuiAddress
    readonly gasOwner?: SuiAddress
    /**
     * The last epoch the transaction may be valid in: a signer's
     * `Signer.maxEpoch` (a zkLogin proof's). The default expiration's `maxEpoch` is capped
     * at it, and a bound already below the current epoch fails the build
     * before anything resolves.
     *
     * @since 0.5.0
     */
    readonly maxEpoch?: bigint
  }
): Effect.fn.Return<Built, BuildError | SimulationFailed | PolicyDenied | TransportError, Sui> {
  yield* Effect.annotateCurrentSpan({
    "sui.sender": opts.sender,
    ...(opts.gasOwner === undefined ? {} : { "sui.gas_owner": opts.gasOwner }),
    ...(opts.maxEpoch === undefined ? {} : { "sui.session_max_epoch": Number(opts.maxEpoch) })
  })
  const started = yield* Clock.currentTimeMillis
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const tx = yield* toTransaction(input)
  yield* Effect.try({
    try: () => {
      tx.setSender(opts.sender)
      if (opts.gasOwner !== undefined) tx.setGasOwner(opts.gasOwner)
    },
    catch: buildError("the transaction rejected its sender")
  })

  const defaulted = tx.getData().expiration == null
  const expiration = defaulted ? yield* defaultExpiration(sui, config, opts.maxEpoch) : undefined
  if (expiration !== undefined) {
    yield* Effect.try({
      try: () => tx.setExpiration(expiration),
      catch: buildError("the transaction rejected its expiration")
    })
  }
  if (opts.maxEpoch !== undefined && (!defaulted || config.expiration === "none")) {
    // No default expiration read the epoch: one read, so a bound that has
    // already ended is refused before anything resolves.
    const { systemState } = yield* sui.core.getCurrentSystemState()
    yield* sessionOpen(yield* epochOf(systemState.epoch), opts.maxEpoch)
  }

  // Whether the payment was the recipe's choice: the address-balance checks
  // below apply to an empty payment someone **set**, and the policy applies
  // only to one that was left to the resolver.
  const paymentLength = paymentLengthOf(tx)
  const paymentSet = paymentLength !== undefined
  const pinnedByPolicy = !paymentSet && config.gasPayment === "requireAddressBalance" && !usesGasCoin(tx)
  const explicitlyEmpty = pinnedByPolicy
    ? yield* Effect.try({
      // Pinned before the build, so the resolver lists no coins at all and a
      // balance that cannot cover the budget is the check's `BuildError`.
      try: () => {
        tx.setGasPayment([])
        return true
      },
      catch: buildError("the transaction rejected an address-balance gas payment")
    })
    : paymentLength === 0

  const unresolved = unresolvedObjectIdsOf(tx)
  const { bytes, simulated } = yield* sui.core
    .use(async (client, signal) => {
      // Asked of the client that will resolve, and before the build: building
      // sets the budget the core resolver's answer depends on.
      const simulated = sdkSimulates(tx, client)
      const bytes = await tx.build({ client: abortableClient(client, signal) })
      return { bytes, simulated }
    })
    .pipe(
      // The resolver's own reads (system state, coins, the budget simulate) go
      // straight to the SDK, under none of `SuiCore`'s read retries. Nothing
      // has been signed, so a transient failure is retried on the **same**
      // policy `SuiCore` reads run under — `SuiCoreReadOptions.readRetry` when
      // the layer was given one — logged and counted under method `use`.
      // `simulated` is asked afresh each attempt: an attempt that set the
      // budget before failing leaves one the next attempt must simulate itself.
      Effect.retry(sui.core.readPolicy?.("use") ?? defaultReadPolicy("use")),
      Effect.catchTag(
        ["ObjectNotFound", "ObjectDeleted", "ObjectUnavailable", "TransactionNotFound"],
        (error) =>
          Effect.fail(
            new BuildError({ message: `an input could not be resolved: ${SuiError.describe(error)}`, cause: error })
          )
      ),
      // A gRPC resolver that cannot find an input answers `NOT_FOUND` from
      // `simulateTransaction` rather than raising the SDK's `ObjectError`, and
      // one that refuses the transaction itself — a function that does not
      // exist, an object owned by someone else, gas selection with nothing to
      // select — answers `INVALID_ARGUMENT`. Both used to arrive as a bare
      // `TransportError { method: "use" }`; they are `BuildError`s with the
      // node's message, and what is left is renamed after this function.
      Effect.catchTag("TransportError", (error) => Effect.fail(resolverError(error, unresolved)))
    )

  const simulatedBy = simulated ? "sdk" : "explicit"
  yield* Effect.annotateCurrentSpan({ "sui.simulated_by": simulatedBy })
  // The SDK simulated nothing: it resolved nothing, or it ran the core
  // resolver with a preset budget. One explicit simulate with checks enabled
  // keeps the promise `Tx.run` is built on: nothing is signed that was not
  // first shown to execute. It is a simulation of exactly these bytes, so it
  // is kept on the result and reused by everything before signing.
  const simulation = simulated ? undefined : yield* sui.simulate(bytes)
  if (simulation !== undefined) BUILD_SIMULATIONS.add(simulation)

  const data = dataOfBytes(bytes)
  const budget = Option.getOrUndefined(Option.map(data, gasBudgetOf))
  if (budget !== undefined) yield* Effect.annotateCurrentSpan({ "sui.gas_budget": Number(budget) })
  yield* gasCeiling(budget, config)

  const gasOwner = Option.match(data, {
    // Bytes this version cannot read keep what the caller said.
    onNone: () =>
      opts.gasOwner === undefined || normalizeSuiAddress(opts.gasOwner) === normalizeSuiAddress(opts.sender)
        ? undefined
        : opts.gasOwner,
    onSome: gasOwnerOf
  })

  if (Option.isSome(data)) {
    const payer = gasOwner ?? opts.sender
    const kind = gasPaymentKindOf(data.value)
    yield* Effect.annotateCurrentSpan({ "sui.gas_payment": kind })
    if (!paymentSet && kind === "coins") {
      // The resolver fell back to coins: the balance did not cover the budget,
      // or the transaction uses `tx.gas`. Correct, but the run now pins a gas
      // coin and holds the sender lock through its submission.
      if (config.gasPayment === "requireAddressBalance") {
        return yield* new BuildError({
          message: `${payer} pays for gas with coin objects, and SubmitConfig.gasPayment is` +
            ' "requireAddressBalance": fold its coins into its address balance first (Tx.foldCoins),' +
            " or build the transaction without tx.gas (tx.coin({ balance }) instead of tx.splitCoins(tx.gas, ...))",
          cause: { payer, payment: kind }
        })
      }
      yield* Effect.logDebug(
        `${payer} pays for gas with coin objects rather than its address balance; Tx.foldCoins moves them into it`
      ).pipe(Effect.annotateLogs({ payer }))
    }
    if (kind === "addressBalance" && mentionsGasCoin(data.value.commands)) {
      // With an empty payment the gas coin is an empty coin: a node simulates
      // such bytes successfully (it mocks a gas coin) and then executes them as
      // a failure, "InsufficientCoinBalance", charging gas (observed on
      // localnet, protocol 139). Refused before anyone signs.
      return yield* new BuildError({
        message: pinnedByPolicy
          // The recipe did not name tx.gas: an SDK intent (tx.coin, tx.balance)
          // split it because the balance could not cover the amount.
          ? `${gasOwner ?? opts.sender} must pay from its address balance (SubmitConfig.gasPayment is` +
            ' "requireAddressBalance"), which does not cover what the transaction spends, so the SDK' +
            " took it from tx.gas, whose coin is empty under an address-balance payment: fold its coins" +
            " into its address balance first (Tx.foldCoins)"
          : "the transaction uses tx.gas but pays for gas from an address balance, where the gas coin" +
            " is empty: it would fail on chain and be charged. Use tx.coin({ balance }) (with" +
            " useGasCoin: false under Tx.sponsored) instead of tx.splitCoins(tx.gas, ...)",
        cause: { payment: kind }
      })
    }
    if (kind === "addressBalance" && ownedInputsOf(data.value).length === 0) {
      // A node refuses such bytes outright: "Transactions must either have
      // address-owned inputs, or a ValidDuring expiration with at most two
      // epochs of validity". Caught here, before anyone signs them.
      const variant = data.value.expiration?.$kind
      if (variant !== "ValidDuring" && variant !== "Validity") {
        return yield* new BuildError({
          message: `the transaction pays for gas from an address balance and has no address-owned input,` +
            ` so a node requires a ValidDuring expiration of at most two epochs, but it has` +
            ` ${variant === undefined ? "none" : `a ${variant} expiration`}: leave SubmitConfig.expiration` +
            ' at "validDuring"',
          cause: { expiration: variant ?? "None" }
        })
      }
    }
    if (explicitlyEmpty && budget !== undefined && budget > 0n) {
      // An empty payment someone set is not something the build simulation
      // checks: a node simulates it against an empty balance successfully and
      // refuses the signed bytes at execution with "Insufficient address
      // balance". One balance read here makes that a `BuildError` before anyone
      // signs. The SUI the bytes withdraw from the same balance counts too.
      const withdrawals = suiWithdrawalsFrom(data.value, payer)
      const required = budget + withdrawals
      const { addressBalance } = yield* sui.getBalance(payer)
      if (addressBalance < required) {
        return yield* new BuildError({
          message: `${payer} pays for gas from its address balance, which holds ${addressBalance} MIST,` +
            ` less than the gas budget ${budget} MIST` +
            (withdrawals === 0n ? "" : ` plus the ${withdrawals} MIST the transaction withdraws from it`) +
            ": fold its coins into it first (Tx.foldCoins), deposit SUI with" +
            " 0x2::balance::send_funds<0x2::sui::SUI>, or pay with coins by leaving the gas payment unset",
          cause: { payer, addressBalance, budget, withdrawals }
        })
      }
    }
  }

  const digest = yield* decodeDigest(TransactionDataBuilder.getDigestFromBytes(bytes)).pipe(
    Effect.mapError((issue) =>
      new BuildError({ message: `the built bytes have no readable digest: ${issue.message}`, cause: issue })
    )
  )
  const recorded = Option.getOrUndefined(Option.map(data, expirationOf))
  const maxEpoch = maxEpochOf(recorded)
  if (maxEpoch !== undefined) yield* Effect.annotateCurrentSpan({ "sui.max_epoch": Number(maxEpoch) })
  const gas = yield* gasOfBytes(data, opts.sender)
  const finished = yield* Clock.currentTimeMillis
  yield* Metrics.recordDuration(Metrics.buildDuration, Duration.millis(finished - started), {
    simulated_by: simulatedBy
  })
  if (budget !== undefined) yield* Metrics.observe(Metrics.buildGasBudget, Number(budget))
  return {
    digest,
    bytes,
    sender: opts.sender,
    // The chain these bytes were built against, so `Tx.reconcile` can refuse to
    // reason about them with a node on another one — including for the
    // expiration variants that name no chain themselves.
    chain: sui.chainId,
    ...(gasOwner === undefined ? {} : { gasOwner }),
    ...(recorded === undefined ? {} : { expiration: recorded }),
    gas,
    ...(simulation === undefined ? {} : { simulation })
  }
})

/**
 * `SubmitConfig.maxGasBudget` over a budget the bytes carry. A configured
 * limit refusing the transaction before it is signed is what `PolicyDenied`
 * means; a `BuildError` whose cause was a bare `2988000n` told a sponsor
 * nothing it could act on. Applied by `Tx.build`. Internal.
 *
 * Fails with: `PolicyDenied` (`maxGasBudget`).
 */
const gasCeiling = (budget: bigint | undefined, config: SubmitConfigService): Effect.Effect<void, PolicyDenied> =>
  budget !== undefined && budget > config.maxGasBudget
    ? Effect.fail(
      new PolicyDenied({
        rule: "maxGasBudget",
        message: `the gas budget ${budget} MIST exceeds SubmitConfig.maxGasBudget ${config.maxGasBudget} MIST`
      })
    )
    : Effect.void

/**
 * The simulations `Tx.build` made of exactly the bytes it returned, by
 * identity. `simulateBuilt` reuses `built.simulation` only when it is one of
 * these: a `Built` decoded from somewhere else — a dapp's JSON, a queue — can
 * carry any `simulation` it likes, and showing `approve` effects the bytes'
 * author wrote would show nothing.
 */
const BUILD_SIMULATIONS = new WeakSet<Simulation>()

const decodeBuiltGas = Schema.decodeUnknownOption(BuiltGasSchema)

/**
 * The gas data of parsed bytes as `Built.gas`: budget, price, the payer (the
 * gas owner, or the sender), the payment refs and their source. `None` when
 * the bytes carry no budget or price, or a ref this version cannot read.
 * Never fails.
 */
const gasOf = (data: TransactionDataBuilder, sender: string): Option.Option<BuiltGas> => {
  const budget = gasBudgetOf(data)
  const price = gasPriceOf(data)
  if (budget === undefined || price === undefined) return Option.none()
  const owner = data.gasData.owner
  return decodeBuiltGas({
    budget: budget.toString(),
    price: price.toString(),
    owner: normalizeSuiAddress(typeof owner === "string" && owner.length > 0 ? owner : sender),
    payment: (data.gasData.payment ?? []).map((ref): typeof GasPaymentRefSchema.Encoded => ({
      objectId: normalizeSuiAddress(ref.objectId),
      version: String(ref.version),
      digest: ref.digest
    })),
    source: gasPaymentKindOf(data)
  })
}

/** {@link gasOf}, or the `BuildError` for bytes whose gas cannot be read. */
const gasOfBytes = (
  data: Option.Option<TransactionDataBuilder>,
  sender: string
): Effect.Effect<BuiltGas, BuildError> =>
  Option.match(Option.flatMap(data, (parsed) => gasOf(parsed, sender)), {
    onNone: () =>
      Effect.fail(
        new BuildError({ message: "the transaction bytes carry no gas data this SDK can read", cause: sender })
      ),
    onSome: Effect.succeed
  })

/**
 * Refuses a `maxEpoch` bound that has already passed, as the `BuildError` whose
 * cause is the `SigningError { reason: "expired" }` `Tx.run` reports: a signer
 * whose `maxEpoch` is below the current epoch cannot sign anything a validator
 * will accept.
 */
const sessionOpen = (epoch: bigint, bound: bigint): Effect.Effect<void, BuildError> =>
  bound >= epoch ? Effect.void : Effect.fail(
    new BuildError({
      message: `the signer's maxEpoch ${bound} has passed and the network is at epoch ${epoch}:` +
        " the signer needs a new proof",
      cause: new SigningError({
        reason: "expired",
        cause: `the signer's maxEpoch ${bound} is below the current epoch ${epoch}`
      })
    })
  )

/** The epoch a system-state read reported, as a number the expiration can carry. */
const epochOf = (epoch: string): Effect.Effect<bigint, TransportError> =>
  Effect.try({
    try: () => BigInt(epoch),
    catch: (cause) =>
      new TransportError({
        method: "getCurrentSystemState",
        retryable: false,
        status: "INVALID_ARGUMENT",
        cause: `the node reported epoch ${epoch}, which is not a number: ${String(cause)}`
      })
  })

/**
 * The nonce for a default `ValidDuring` expiration, from
 * `SubmitConfig.nonce`, checked to be the `u32` the wire carries.
 *
 * A custom allocator that answers something else is a configuration mistake and
 * fails the build, rather than producing bytes a validator refuses.
 */
const nonceOf = (config: SubmitConfigService): Effect.Effect<number, BuildError> =>
  Effect.flatMap(config.nonce, (nonce) =>
    decodeNonce(nonce).pipe(
      // A `BuildError`, not a `TransportError`: nothing was sent, no node was
      // asked, and the build is what failed. `SubmitConfig.ts` and DESIGN
      // section 6 both say so.
      Effect.mapError((issue) =>
        new BuildError({
          message: `SubmitConfig.nonce produced ${nonce}, which is not a u32 (0 to ${U32_MAX})`,
          cause: issue
        })
      )
    ))

/** The expiration `Tx.build` sets when the recipe set none. */
const defaultExpiration = Effect.fnUntraced(function*(
  sui: Sui["Service"],
  config: SubmitConfigService,
  bound: bigint | undefined
): Effect.fn.Return<SdkExpiration | undefined, BuildError | TransportError> {
  switch (config.expiration) {
    case "none":
      return undefined
    case "epoch": {
      const { systemState } = yield* sui.core.getCurrentSystemState()
      if (bound !== undefined) yield* sessionOpen(yield* epochOf(systemState.epoch), bound)
      return { Epoch: systemState.epoch }
    }
    case "validDuring": {
      const { systemState } = yield* sui.core.getCurrentSystemState()
      const epoch = yield* epochOf(systemState.epoch)
      if (bound !== undefined) yield* sessionOpen(epoch, bound)
      // The current epoch and the next, unless a bound ends sooner: a
      // window past the signer's bound only delays the moment `Tx.reconcile`
      // can call a lost transaction expired.
      const last = bound !== undefined && bound < epoch + 1n ? bound : epoch + 1n
      const nonce = yield* nonceOf(config)
      const maxTimestamp = config.validFor === undefined
        ? null
        : (BigInt(DateTime.toEpochMillis(yield* sui.chainTime)) +
          BigInt(Duration.toMillis(config.validFor))).toString()
      return {
        ValidDuring: {
          // Epochs, not a clock. The validator rule is that a transaction must
          // either have address-owned inputs or an expiration of at most two
          // epochs, so a bound of some other kind is rejected outright for a
          // PTB whose only object inputs are shared and for every
          // `Tx.sponsored` transaction, which pays gas from an address balance
          // and therefore has no gas coins either. Two epochs is the widest
          // the rule allows.
          minEpoch: epoch.toString(),
          maxEpoch: last.toString(),
          minTimestamp: null,
          // Null unless `SubmitConfig.validFor` asks for one: a live devnet
          // node refuses any transaction carrying a timestamp bound with
          // "Feature is not supported: Timestamp-based transaction expiration
          // is not yet supported", epochs alongside it or not.
          maxTimestamp,
          chain: sui.chainId,
          nonce
        }
      }
    }
  }
})

/**
 * Refuses a signer whose address the bytes will not accept.
 *
 * A transaction takes a signature from its sender and, when it is sponsored,
 * from its gas owner. A signature from anyone else is rejected by the node with
 * a non-retryable `INVALID_ARGUMENT`, which `Tx.submit` can only report as
 * `SubmissionUnknown` — exit 3, "reconcile before doing anything else" — for a
 * transaction that never had a chance. Catching it here makes a misconfigured
 * credential a `SigningError` before any bytes are sent.
 *
 * The addresses come from the bytes rather than from `Built.sender`, so the
 * check is against what was actually signed. Bytes this version cannot parse
 * are let through: refusing to sign because the guard could not read them would
 * be worse than the failure it prevents.
 *
 * A `Signer.alias` is compared by the address it signs **as** (`address`, the
 * account), not by the alias whose key signs: whether the alias set allows that
 * key is a chain read, which `Tx.run` makes before building (`requireAliases`)
 * and this offline check cannot.
 */
const assertSignerAddress = (
  bytes: Uint8Array,
  signer: Signer
): Effect.Effect<void, SigningError> =>
  Effect.suspend(() => {
    const allowed = signersOfBytes(bytes)
    if (allowed.length === 0) return Effect.void
    const address = normalizeSuiAddress(signer.address)
    if (allowed.includes(address)) return Effect.void
    return Effect.fail(
      new SigningError({
        cause: `this signer signs as ${signer.address}, which is neither the transaction's sender` +
          ` nor its gas owner (${allowed.join(", ")}); the node would reject the signature`
      })
    )
  })

/**
 * Signs built bytes.
 *
 * The signer's address must be the transaction's sender or, for a sponsored
 * transaction, its gas owner; anything else is a `SigningError` rather than a
 * rejection at execution time. A `Signer.remote` therefore has to report the
 * address it signs as truthfully.
 *
 * A `Signer.alias(account, key)` signs as `account`, so it signs bytes whose
 * sender (or gas owner) is `account` with `key`'s signature. This makes no
 * chain read: that `key` is in `account`'s alias set is checked by `Tx.run`
 * before it builds, or by `AddressAlias.requireSigner` / `Tx.attach` /
 * `Verify.verifyTransactionSignature(…, { checkAddressAliases: true })`
 * when you sign step by step; a key outside the set is refused by the node.
 *
 * Fails with: `SigningError`.
 */
export const sign = Effect.fn("Tx.sign")(function*(
  built: Built,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
  yield* Effect.annotateCurrentSpan({ "sui.digest": built.digest, "sui.signer": signer.address })
  if (signer.alias !== undefined) yield* Effect.annotateCurrentSpan({ "sui.signer_alias": signer.alias })
  yield* assertSignerAddress(built.bytes, signer)
  const signature = yield* signer.signTransaction(built.bytes)
  return {
    digest: built.digest,
    bytes: built.bytes,
    signatures: [signature],
    sender: built.sender,
    ...(built.gasOwner === undefined ? {} : { gasOwner: built.gasOwner }),
    ...(built.expiration === undefined ? {} : { expiration: built.expiration }),
    // Carried forward from the build, so `Tx.reconcile` knows which chain these
    // bytes belong to even when the expiration names none.
    ...(built.chain === undefined ? {} : { chain: built.chain })
  }
})

/**
 * Adds one more signature to already signed bytes, for a sponsored or
 * multi-party transaction. The bytes are untouched, so both parties sign
 * exactly the same transaction.
 *
 * As in {@link sign}, the co-signer's address must be the sender or the gas
 * owner named in the bytes; a `Signer.alias` is compared by the account it
 * signs as.
 *
 * Fails with: `SigningError`.
 */
export const cosign = Effect.fn("Tx.cosign")(function*(
  signed: Signed,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
  yield* Effect.annotateCurrentSpan({ "sui.digest": signed.digest, "sui.signer": signer.address })
  if (signer.alias !== undefined) yield* Effect.annotateCurrentSpan({ "sui.signer_alias": signer.alias })
  yield* assertSignerAddress(signed.bytes, signer)
  const signature: Signature = yield* signer.signTransaction(signed.bytes)
  return { ...signed, signatures: [...signed.signatures, signature] }
})

/**
 * Turns a recipe into a sponsored one: the sender owns the transaction, the
 * gas owner pays, and gas comes from the sponsor's address balance rather than
 * from coin objects, so the two parties never have to agree on a gas coin and
 * can sign in either order.
 *
 * **The gas owner must hold SUI in its address balance**, not just in coin
 * objects: gas is drawn from that balance, and `Tx.build` refuses with
 * `BuildError` when it holds less than the budget. A sponsor funded by a
 * faucet holds coins; move SUI into the balance once with
 * `0x2::balance::send_funds<0x2::sui::SUI>`, or sponsor with coins instead by
 * passing `gasOwner` to `Tx.run`/`Tx.build` without `Tx.sponsored` (the gas
 * owner's coins are then selected under its sender lock). `Tx.foldCoins` with
 * the sponsor's signer deposits its coins.
 *
 * A sponsored transaction with no owned input pins nothing — its payment is
 * empty, so it carries no coin and no coin reservation — and `Tx.run` sends it
 * without holding either party's lock past the build. It is in flight on both
 * parties until it settles, so the sponsor's own `tx.gas` runs wait for it
 * before they build (one that starts building first is not stopped by it).
 *
 * Never fails; the recipe it returns throws only if the recipe it wraps does,
 * which `Tx.build` reports as `BuildError`.
 */
export const sponsored = (opts: {
  readonly sender: SuiAddress
  readonly gasOwner: SuiAddress
}) =>
(recipe: Recipe): Recipe =>
(tx: Transaction) => {
  recipe(tx)
  tx.setSender(opts.sender)
  tx.setGasOwner(opts.gasOwner)
  tx.setGasPayment([])
}

/**
 * Builds the canonical transfer shape that an eligible stablecoin can execute
 * without SUI gas: a `Balance<T>` from the SDK's `Transaction#balance` intent,
 * consumed by `0x2::balance::send_funds<T>`.
 *
 * The recipe deliberately does **not** set gas price, budget or payment. The
 * gRPC and GraphQL SDK resolvers simulate the transaction, check the network's
 * current protocol configuration and set zero gas only when the coin type,
 * amount and resolved PTB qualify. It also does not hardcode an allowlist or
 * the current 0.01 minimum: protocol configuration stores both eligibility and
 * each token's minimum in base units, while this API has no trustworthy token
 * decimals. `Tx.build`'s mandatory simulation therefore remains the authority;
 * a UI that already has verified coin metadata may reject a too-small display
 * amount earlier.
 *
 * This sends to the recipient's address balance. The SDK may source the amount
 * from the sender's address balance, coin objects, or both, and resolves the
 * required eligible helper calls itself.
 *
 * **`requireZeroGas: true`** makes "gasless" a requirement rather than a hope.
 * Without it, a coin type or amount that does not qualify — or a transport
 * that does not detect eligibility, such as JSON-RPC — still builds, and the
 * sender quietly pays SUI gas. With it, the recipe installs a build plugin
 * that checks what the resolver chose, and `Tx.build` fails with `BuildError`
 * unless the gas price and the gas budget are both zero.
 *
 * Never fails; the recipe it returns can throw only if the SDK rejects an
 * input, which `Tx.build` reports as `BuildError` before anything is signed.
 *
 * @since 0.2.1
 */
export const gaslessStablecoinTransfer = (opts: {
  readonly coinType: CoinType
  readonly amount: bigint
  readonly recipient: SuiAddress
  /**
   * Fail the build unless the resolved gas price and budget are both zero.
   *
   * @since 0.4.0
   */
  readonly requireZeroGas?: boolean
}): Recipe =>
(tx: Transaction) => {
  if (opts.requireZeroGas === true) tx.addBuildPlugin(requireZeroGasPlugin)
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [opts.coinType],
    arguments: [
      tx.balance({ type: opts.coinType, balance: opts.amount }),
      tx.pure.address(opts.recipient)
    ]
  })
}

/**
 * The build plugin behind `requireZeroGas`: it lets the rest of the build —
 * the resolver included, which always runs last — finish, then refuses gas
 * data that is not zero. A kind-only build resolves no gas and is let through.
 */
const requireZeroGasPlugin: TransactionPlugin = async (transactionData, options, next) => {
  await next()
  if (options.onlyTransactionKind === true) return
  const price = gasPriceOf(transactionData)
  const budget = gasBudgetOf(transactionData)
  if (price !== 0n || budget !== 0n) {
    throw new ZeroGasNotResolved(String(price ?? "unset"), String(budget ?? "unset"))
  }
}

/**
 * Turns transaction bytes that came from somewhere else into a {@link Built},
 * reading everything the lifecycle needs out of the bytes themselves.
 *
 * This is how a stateless sponsor, a wallet bridge or a service that was
 * handed someone's transaction gets back into the lifecycle: `sign`, `attach`,
 * `cosign` and `submit` all take what this returns. The sender, the gas owner
 * and the expiration are read out of the bytes, and the digest is computed from
 * them, so nothing is taken on trust. **Never build a `Built` by hand**: one
 * that leaves out `expiration` or `chain` silently disables `Tx.reconcile`'s
 * expiry rule and chain guard.
 *
 * `chain` is the chain of the `Sui` in context. Bytes whose expiration names a
 * chain (the default `ValidDuring` does) must name that one; bytes whose
 * expiration names none (`Epoch`, `None`) cannot be checked, and are taken to
 * be for this chain.
 *
 * `gas` is read out of the bytes too (budget, price, payer, payment and its
 * source); there is never a `simulation`.
 *
 * Unlike `Tx.build`, nothing is simulated: run `sui.simulate(built.bytes)`
 * before co-signing bytes you did not build.
 *
 * Fails with: `BuildError` (the bytes are not a full transaction this SDK can
 * read, name no sender or no gas data, or are bound to another chain).
 *
 * @since 0.4.0
 */
export const fromBytes = Effect.fn("Tx.fromBytes")(function*(
  bytes: Uint8Array
): Effect.fn.Return<Built, BuildError, Sui> {
  const sui = yield* Sui
  const parsed = dataOfBytes(bytes)
  if (Option.isNone(parsed)) {
    return yield* new BuildError({
      message: "these bytes are not a transaction this SDK can read (kind-only bytes are not enough:" +
        " build them into a full transaction first)",
      cause: bytes.length
    })
  }
  const data = parsed.value
  const sender = typeof data.sender === "string" ? decodeAddress(normalizeSuiAddress(data.sender)) : Option.none()
  if (Option.isNone(sender)) {
    return yield* new BuildError({ message: "these transaction bytes name no sender", cause: data.sender })
  }
  const digest = yield* decodeDigest(TransactionDataBuilder.getDigestFromBytes(bytes)).pipe(
    Effect.mapError((issue) =>
      new BuildError({ message: `these bytes have no readable digest: ${issue.message}`, cause: issue })
    )
  )
  const expiration = expirationOf(data)
  const named = chainOf(expiration)
  if (named !== undefined && named !== sui.chainId) {
    return yield* new BuildError({
      message: `these bytes are bound to chain ${named}, but this client is on ${sui.chainId}`,
      cause: named
    })
  }
  const gasOwner = gasOwnerOf(data)
  const gas = yield* gasOfBytes(Option.some(data), sender.value)
  return {
    digest,
    bytes,
    sender: sender.value,
    chain: sui.chainId,
    ...(gasOwner === undefined ? {} : { gasOwner }),
    ...(expiration === undefined ? {} : { expiration }),
    gas
  }
})

/**
 * Attaches a signature somebody else made — a sender's wallet, a remote
 * sponsor, an HSM — to built or already signed bytes, after checking it.
 *
 * The signature is verified against the bytes (`Verify.verifyTransactionSignature`,
 * so a zkLogin or multisig signature is checked through the node), and the
 * address it was made by must be one the bytes accept: the sender or the gas
 * owner they name, or — through Sui's address aliases (0.6.0) — a member of
 * the sender's or the gas owner's alias set, read from their
 * `AddressAliases` objects. That read is made only for a signature by neither
 * address; a signature by the sender's own key is attached without one (an
 * address that removed itself from its own set is refused by the node at
 * submission). A `Built` becomes a `Signed` carrying that one signature; a
 * `Signed` gains it. The same signature attached twice is attached once.
 *
 * ```ts
 * const built = yield* Tx.fromBytes(senderBytes)
 * const withSender = yield* Tx.attach(built, senderSignature)
 * const signed = yield* Tx.cosign(withSender, sponsor)
 * ```
 *
 * Fails with: `SigningError` (the signature is empty, does not parse or is not
 * valid for these bytes), `PolicyDenied` (`alias.signer`, 0.6.0: it was made
 * by an address that is neither the sender, the gas owner, nor an alias of
 * either — before 0.6.0 this was a `SigningError`), `TransportError` (a zkLogin
 * or multisig check, or an alias read, could not reach a usable answer).
 *
 * @since 0.4.0
 */
export const attach = Effect.fn("Tx.attach")(function*(
  target: Built | Signed,
  signature: string
): Effect.fn.Return<Signed, SigningError | PolicyDenied | TransportError, Sui> {
  yield* Effect.annotateCurrentSpan({ "sui.digest": target.digest })
  const decoded = decodeSignature(signature)
  if (Option.isNone(decoded)) {
    return yield* new SigningError({ cause: "the signature to attach is empty" })
  }
  const publicKey = yield* verifyTransactionSignature(target.bytes, decoded.value)
  const address = normalizeSuiAddress(publicKey.toSuiAddress())
  const allowed = [...new Set(signersOfBytes(target.bytes))]
  if (allowed.length > 0 && !allowed.includes(address)) {
    yield* Effect.annotateCurrentSpan({ "sui.signer_alias": address })
    const signer = SuiAddress.normalize(address)
    let covered = false
    const sets: Array<string> = []
    for (const required of allowed) {
      const aliases = yield* readAliases(SuiAddress.normalize(required))
      if (aliasAllows(aliases, signer)) {
        covered = true
        break
      }
      sets.push(
        aliases._tag === "NotEnabled"
          ? `${required} has not enabled address aliases`
          : `${required}'s aliases are ${aliases.aliases.join(", ")}`
      )
    }
    if (!covered) {
      return yield* new PolicyDenied({
        rule: "alias.signer",
        message: `the signature was made by ${address}, which is neither the transaction's sender` +
          ` nor its gas owner (${allowed.join(", ")}) nor an alias of either (${sets.join("; ")});` +
          " the node would reject it"
      })
    }
  }
  const existing: ReadonlyArray<Signature> = "signatures" in target ? target.signatures : []
  const signatures = existing.includes(decoded.value) ? existing : [...existing, decoded.value]
  return {
    digest: target.digest,
    bytes: target.bytes,
    signatures,
    sender: target.sender,
    ...(target.gasOwner === undefined ? {} : { gasOwner: target.gasOwner }),
    ...(target.expiration === undefined ? {} : { expiration: target.expiration }),
    ...(target.chain === undefined ? {} : { chain: target.chain })
  }
})

/**
 * Requires, of every `Signer.alias` among `signers`, that its key is in the
 * alias set of the account it signs as — one `AddressAliases` read each,
 * before anything is built, so a key the account does not (or no longer)
 * lists costs no build and no simulate. A signer without an `alias` is not
 * read for. What `Tx.run` does for its signer and sponsor.
 *
 * Fails with: `PolicyDenied` (`alias.signer`), `TransportError`.
 */
const requireAliases = (
  signers: ReadonlyArray<Signer | undefined>
): Effect.Effect<void, PolicyDenied | TransportError, Sui> =>
  Effect.forEach(signers, (signer) =>
    signer === undefined || signer.alias === undefined
      ? Effect.void
      : requireSigner(signer.address, signer.alias), { discard: true })

const journalSigned = Effect.fnUntraced(function*(signed: Signed) {
  const journal = yield* Journal
  const now = yield* DateTime.now
  const entry = JournalEntry.cases.Signed.make({
    _tag: "Signed",
    digest: signed.digest,
    signed,
    signedAt: now
  })
  yield* journal.put(entry)
})

const journalOutcome = Effect.fnUntraced(function*(
  entry: JournalEntry
): Effect.fn.Return<void, JournalError> {
  const journal = yield* Journal
  yield* journal.put(entry)
})

/**
 * Records an outcome the network has already given, and never changes it.
 *
 * `JournalError` is reserved for the write that happens **before** the first
 * `executeTransaction`: failing there is honest, because nothing has been sent
 * and the caller can safely try again. Once execute or reconcile has answered,
 * a journal that cannot be written is an operational problem, not a different
 * outcome — reporting a charged `ExecutionFailed` as `JournalError` would put
 * it on exit 4, "not applied, safe to retry", and the documented retry idiom
 * would send the transaction a second time. So the failure is logged with the
 * digest and swallowed, and the answer stands.
 */
const journalSettled = (entry: JournalEntry): Effect.Effect<void> =>
  journalOutcome(entry).pipe(
    Effect.catchTag("JournalError", (error) =>
      Effect.logError(
        "the submission journal could not record a settled transaction; the outcome stands",
        error
      )),
    Effect.annotateLogs({ digest: entry.digest, entry: entry._tag })
  )

const executedEntry = Effect.fnUntraced(function*(executed: Executed) {
  const now = yield* DateTime.now
  return JournalEntry.cases.Executed.make({
    _tag: "Executed",
    digest: executed.digest,
    ...(executed.checkpoint === null ? {} : { checkpoint: executed.checkpoint }),
    at: now
  })
})

const failedEntry = Effect.fnUntraced(function*(error: ExecutionFailed) {
  const now = yield* DateTime.now
  return JournalEntry.cases.Failed.make({
    _tag: "Failed",
    digest: error.digest,
    reason: error.reason,
    at: now
  })
})

const notAppliedEntry = Effect.fnUntraced(function*(error: NotApplied) {
  const now = yield* DateTime.now
  return JournalEntry.cases.NotApplied.make({
    _tag: "NotApplied",
    digest: error.digest,
    evidence: error.evidence,
    at: now
  })
})

/**
 * Settles the `Signed` entry of a submission the node (or the service) refused
 * before anything executed, as `NotApplied { evidence: "refused" }`. Never
 * fails: like every write after the network answered, a failure is logged.
 */
const journalRefused = (signed: Signed): Effect.Effect<void> =>
  Effect.flatMap(
    notAppliedEntry(new NotApplied({ digest: signed.digest, evidence: "refused" })),
    journalSettled
  )

const unknownEntry = Effect.fnUntraced(function*(
  signed: Signed,
  lastError: string,
  attempts: number
) {
  const now = yield* DateTime.now
  return JournalEntry.cases.Unknown.make({
    _tag: "Unknown",
    digest: signed.digest,
    signed,
    lastError,
    attempts,
    at: now
  })
})

/**
 * Waits for an execution to be visible to reads, before `Tx.submit` returns and
 * the sender lock is released.
 *
 * Execute and indexing are two different things on a Sui node: a transaction
 * that executed is not necessarily one the next `getObject` or the next build's
 * input resolution can see. Serializing per sender stops two builds picking the
 * same gas coin; it does not stop the second build resolving that coin at the
 * version the first one already spent. `waitForTransaction` is the SDK's own
 * answer, and holding the lock across it is what makes "the next `Tx.run` from
 * this sender sees this one" true.
 *
 * **It never changes the outcome.** The transaction executed; that is a fact,
 * and a wait that times out or fails does not unmake it. `Tx.submit` returns
 * the `Executed` it already has; the miss is the `Tx.awaitVisible` span's
 * `sui.visibility` attribute (`"visible"`, `"timeout"`, `"failed"`), the
 * visibility-wait metric's `result`, and a **debug** log line with the digest
 * — debug since 0.5.0, so a default program's stdout stays clean. Turn
 * the wait off with `SubmitConfig.awaitVisibility: false` and bound it with
 * `SubmitConfig.visibilityTimeout`. Never fails.
 */
const awaitVisible = (
  sui: Sui["Service"],
  config: SubmitConfigService,
  digest: Digest
): Effect.Effect<void> =>
  config.awaitVisibility === false ? Effect.void : sui.core
    .waitForTransaction({ digest })
    .pipe(
      Effect.timeoutOption(config.visibilityTimeout),
      // At debug level, which Effect's default minimum level (`Info`) does not
      // print: the default logger writes to stdout, and a warning here landed
      // in the middle of a `--json` CLI's output for a run whose outcome
      // stands. The fact stays observable as the span attribute
      // `sui.visibility` and the `result` of the visibility-wait metric.
      Effect.flatMap((visible) =>
        visible._tag === "Some" ? Effect.succeed("visible") : Effect.logDebug(
          "the transaction executed but did not become visible to reads within" +
            ` SubmitConfig.visibilityTimeout (${Duration.format(config.visibilityTimeout)}); the outcome stands`
        ).pipe(Effect.as("timeout"))
      ),
      // One line, not a cause with a stack: a `TransportError` or a
      // `TransactionNotFound` here is the failure this is allowed to swallow,
      // and the outcome it would be printed beside is going to stand anyway. A
      // **defect** is still a bug and is not caught.
      Effect.catch((error) =>
        Effect.logDebug(
          "the transaction executed but waiting for it to become visible failed; the outcome" +
            ` stands: ${SuiError.describe(error)}`
        ).pipe(Effect.as("failed"))
      ),
      Effect.tap((result) => Effect.annotateCurrentSpan({ "sui.visibility": result })),
      Effect.timed,
      Effect.flatMap(([duration, result]) => Metrics.recordDuration(Metrics.visibilityWait, duration, { result })),
      // An interrupt here is the caller's to make, and it wins — but the
      // journal already says `Executed`, and a person reading the log should
      // not have to guess that.
      Effect.onInterrupt(() =>
        Effect.logWarning(
          "interrupted while waiting for an executed transaction to become visible; it executed," +
            " and the journal records it as Executed"
        )
      ),
      Effect.annotateLogs({ digest }),
      Effect.withSpan("Tx.awaitVisible")
    )

/**
 * Sends signed bytes, and does not stop caring until it knows what happened.
 *
 * Before the first `executeTransaction` it writes a `Signed` journal entry, so
 * a process that dies mid-flight leaves a record of bytes that may be on the
 * wire. A retryable transport failure or a timeout re-sends the identical bytes
 * on `SubmitConfig.resubmit`; nothing is ever rebuilt, so a retry can only land
 * the transaction that was already signed. When the retries run out it runs
 * `Tx.reconcile`, which either finds the transaction, proves it never applied,
 * or says it does not know.
 *
 * `TransportError` almost never escapes: once bytes may have been sent, "the
 * network was unreachable" is not an answer a caller can act on, so it becomes
 * `SubmissionUnknown` carrying the signed bytes. **The one exception is a node
 * that refused the request outright** — gRPC `INVALID_ARGUMENT`, which is what
 * a validator answers for malformed bytes or for a sponsored transaction
 * carrying one signature. That answer came from the node, it is final, and
 * nothing was executed, so it is reported as the `TransportError` it is rather
 * than reconciled: a reconcile would go on to ask "is this digest on chain?",
 * a question about a transaction that was never sent, and a lagging or scripted
 * node can answer it yes. The journal entry is settled as `NotApplied
 * { evidence: "refused" }`, so `Tx.reconcileAll` has nothing left to do for it.
 * That holds for the **first** send only: a refusal after a timeout or a
 * retryable failure says nothing about the earlier send, which may have
 * landed, so it reconciles like any other ambiguous failure.
 *
 * A validator quorum's **lock conflict** — `FAILED_PRECONDITION`, "already
 * locked by a different transaction" — is reconciled too, and when that ends
 * `SubmissionUnknown` it is reconciled up to three more times,
 * `SubmitConfig.reconcileRecheck` apart, because the winner of the race is
 * usually readable a moment later and its effects are the `inputConsumed`
 * evidence. Every `SubmissionUnknown` that comes out of a send names what the
 * last send said as well as what the reconcile found.
 *
 * **An answer is journalled before anything can interrupt it.** The execute
 * attempts are interruptible; from the moment the node has answered to the
 * moment the journal holds that answer, they are not. An interrupt during the
 * visibility wait afterwards still wins — the caller asked for it — but the
 * journal already says `Executed`, and a warning says so. An execute answer for
 * a digest other than the submitted one is not trusted; it reconciles.
 *
 * `JournalError` can only come from the `Signed` write, before anything has
 * been sent. Once the network has answered, a journal write that fails is
 * logged with `Effect.logError` and the answer stands, because "the journal is
 * broken" is not a thing a caller can act on and reporting it in place of a
 * charged `ExecutionFailed` would invite a second submission.
 *
 * Fails with: `ExecutionFailed` (applied on chain and failed; gas was charged),
 * `NotApplied` (provably never applied), `SubmissionUnknown` (the outcome is
 * not known and the bytes are in the error), `JournalError` (only before the
 * first send), `TransportError` (only `INVALID_ARGUMENT` on the first send:
 * the node refused the submission and nothing was executed).
 */
export const submit: (signed: Signed) => Effect.Effect<Executed, SubmitError, Sui> = Effect.fn(
  "Tx.submit"
)(function*(
  signed: Signed
): Effect.fn.Return<Executed, SubmitError, Sui> {
  return yield* send(signed, false)
})

/**
 * The body of {@link submit} and {@link resubmit}.
 *
 * `resent` says whether these bytes may already have been sent by an earlier
 * call — a previous process, a `SubmissionUnknown` being retried. A refusal on
 * the first execute of *this* call is then not "the node refused and nothing
 * executed": the earlier send may have landed, and only a reconcile can say.
 */
const send = Effect.fnUntraced(function*(
  signed: Signed,
  resent: boolean
): Effect.fn.Return<Executed, SubmitError, Sui> {
  yield* Effect.annotateCurrentSpan({ "sui.digest": signed.digest })
  const sui = yield* Sui
  const config = yield* SubmitConfig
  yield* journalSigned(signed)

  let attempts = 0
  const once = Effect.suspend(() => {
    attempts += 1
    // On the submit span, not on the execute span: the attempt number is what
    // a trace of a stuck submission is read for, and the execute spans are
    // one per attempt anyway.
    return Effect.annotateCurrentSpan({ "sui.attempt": attempts }).pipe(
      Effect.andThen(Metrics.increment(Metrics.executeAttempts)),
      Effect.andThen(sui.core.executeTransaction({
        transaction: signed.bytes,
        signatures: [...signed.signatures],
        include: EXECUTE_INCLUDE
      })),
      // A timeout on an execute is a transport failure that may already have
      // landed: retryable, and re-sent as the identical bytes.
      Effect.timeoutOrElse({
        duration: config.executeTimeout,
        orElse: () =>
          Effect.fail(
            new TransportError({
              method: "executeTransaction",
              retryable: true,
              status: "DEADLINE_EXCEEDED",
              cause: `no answer within SubmitConfig.executeTimeout (${Duration.format(config.executeTimeout)})`
            })
          )
      })
    )
  })

  // The execute attempts are interruptible — an interrupt cancels the request
  // in flight and leaves the `Signed` entry, which is the honest record of
  // bytes that may be on the wire. **Once an answer is in, nothing may
  // interrupt before it is journalled**: an interrupt that landed between the
  // node's "executed" and the journal write used to leave a transaction that
  // applied recorded as merely sent.
  const result = yield* Effect.uninterruptibleMask((restore) =>
    restore(
      once.pipe(
        Effect.retry({
          schedule: config.resubmit,
          times: Math.max(config.resubmitAttempts - 1, 0),
          while: (error: TransportError) => error.retryable
        })
      )
    ).pipe(
      Effect.flatMap(fromTransactionResult),
      Effect.catchTag("DecodeError", (error) =>
        Effect.fail(
          new TransportError({ method: "executeTransaction", retryable: false, cause: error })
        )),
      Effect.result,
      Effect.tap((answered) => {
        if (answered._tag === "Success") {
          return answered.success.digest === signed.digest
            ? Effect.flatMap(executedEntry(answered.success), journalSettled)
            : Effect.void
        }
        return answered.failure._tag === "ExecutionFailed" && answered.failure.digest === signed.digest
          ? Effect.flatMap(failedEntry(answered.failure), journalSettled)
          : Effect.void
      })
    )
  )

  if (result._tag === "Success") {
    if (result.success.digest !== signed.digest) return yield* answeredForAnother(signed, result.success.digest, attempts)
    yield* awaitVisible(sui, config, signed.digest)
    return result.success
  }
  const failure = result.failure
  if (failure._tag === "ExecutionFailed") {
    if (failure.digest !== signed.digest) return yield* answeredForAnother(signed, failure.digest, attempts)
    return yield* failure
  }
  // The node refused the request outright — malformed bytes, a missing
  // signature — so nothing was executed and asking again would only find out
  // about some other transaction with that digest. Fail with what the node
  // said, and settle the journal entry so no startup reconciles it again.
  //
  // Only on the **first** send of bytes never sent before. After a timeout or
  // a retryable failure — or when this is a re-send of bytes an earlier call
  // may have landed — a refusal says nothing about the earlier send: that is
  // the ambiguous case, and it reconciles.
  if (!resent && attempts === 1 && refusedOutright(failure)) {
    yield* Effect.annotateCurrentSpan({ "sui.refused": true })
    yield* journalRefused(signed)
    return yield* failure
  }
  // Bytes may have reached the network: the only honest next step is to ask.
  // Another transaction's lock on a pinned input is a race whose winner is
  // usually readable a moment later, so that case asks a few more times.
  const conflicted = lockConflict(failure)
  if (conflicted) {
    yield* Effect.annotateCurrentSpan({ "sui.lock_conflict": true })
    yield* Metrics.increment(Metrics.lockConflicts)
  }
  return yield* reconcileSigned(
    signed,
    failure,
    attempts,
    conflicted ? LOCK_CONFLICT_RECHECKS : 0
  )
}, (effect, signed) =>
  // How the submit ended, on the enclosing `Tx.submit` / `Tx.resubmit` span
  // and in `sui_effect_tx_submit_total`. Interrupts and defects are neither.
  // And the sender, which the bytes name and the execute include set does not
  // return.
  effect.pipe(
    Effect.map((executed) => withSender(executed, signed.sender)),
    Effect.tap(() => submitEnded("Executed")),
    Effect.tapError((error) => submitEnded(error._tag))
  ))

/** Annotates and counts one submit's result. Never fails. */
const submitEnded = (tag: SubmitError["_tag"] | "Executed"): Effect.Effect<void> => {
  const result = Metrics.resultOf(tag)
  return Effect.annotateCurrentSpan({ "sui.outcome": result }).pipe(
    Effect.andThen(Metrics.increment(Metrics.submitResults, { result }))
  )
}

/**
 * An execute answer for a digest other than the one submitted is not an
 * answer about these bytes: whatever produced it — a proxy, a confused node —
 * the chain is asked about the digest that was signed. Never journals the
 * foreign answer.
 */
const answeredForAnother = (
  signed: Signed,
  answered: string,
  attempts: number
): Effect.Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown, Sui> =>
  reconcileSigned(
    signed,
    new TransportError({
      method: "executeTransaction",
      retryable: false,
      cause: `the node answered for transaction ${answered}, not the submitted ${signed.digest}`
    }),
    attempts,
    0
  )

/**
 * What a third party answers when it has submitted your bytes.
 *
 * Three shapes are understood, in this order: an SDK `TransactionResult` (the
 * service ran `executeTransaction` and passed the whole thing on), a reduced
 * execute envelope (anything with a `digest` or an `effects`, decoded through
 * {@link Executed.fromPartial}), and a bare digest string. Anything else — a
 * `void`, an acknowledgement with no digest — means "ask the chain", and
 * `submitVia` reconciles by the digest it already has, which is the digest of
 * the bytes it handed over.
 *
 * @since 0.1.2
 */
export type SubmitViaReply = unknown

/** Everything {@link submitVia} can fail with, before the sender's own errors. */
export type SubmitViaError =
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | JournalError

const executedOfReply = (
  signed: Signed,
  reply: SubmitViaReply
): Effect.Effect<Executed | undefined, ExecutionFailed> => {
  const none = Effect.undefined
  if (reply === undefined || reply === null || typeof reply === "string") return none
  const kind = (reply as { readonly $kind?: unknown }).$kind
  if (kind === "Transaction" || kind === "FailedTransaction") {
    return fromTransactionResult(reply as Parameters<typeof fromTransactionResult>[0]).pipe(
      Effect.catchTag("DecodeError", () => none),
      // An answer about another digest is not an answer about these bytes,
      // applied or failed: ask the chain about the digest that was signed.
      Effect.map((executed) => executed !== undefined && executed.digest === signed.digest ? executed : undefined),
      Effect.catchTag("ExecutionFailed", (failed) =>
        failed.digest === signed.digest ? Effect.fail(failed) : none)
    )
  }
  const record = reply as { readonly digest?: unknown; readonly effects?: unknown }
  // A digest with no effects is an acknowledgement, not an envelope: decoding
  // it filled every absent field with "nothing happened" and answered a hollow
  // `Executed` — no gas, nothing created — for a transaction that may have
  // done anything. Only the chain can say what it did.
  if (typeof record.effects !== "object" || record.effects === null) return none
  // A reduced envelope says nothing about *why* a transaction failed, and
  // decoding one that reports failure produced an `Executed` for it. The chain
  // has the reason.
  const status = (record.effects as { readonly status?: unknown }).status ??
    (reply as { readonly status?: unknown }).status
  if ((status as { readonly success?: unknown } | undefined)?.success === false) return none
  return Executed.fromPartial(reply).pipe(
    // A reply this cannot read is not a failure: the digest is known and the
    // chain is the authority. Fall through to the reconcile.
    Effect.catchTag("DecodeError", () => none),
    Effect.map((executed) =>
      executed !== undefined && executed.digest === signed.digest ? executed : undefined
    )
  )
}

/**
 * Submits through **someone else** — a relay, a sponsorship service, a backend
 * that holds the only key allowed to talk to the node — and keeps the journal
 * and the evidence rules that `Tx.submit` would have kept.
 *
 * The bytes never reach `executeTransaction` here; `send` does whatever the
 * service needs (an HTTP POST, a queue, another process) and answers with
 * whatever the service returns. What this owns is everything around it:
 *
 * - a `Signed` journal entry is written **before** `send` is called, so a crash
 *   between here and the service leaves the same record a direct submit leaves;
 * - `send` is called **once**. A third party's submit is not known to be
 *   idempotent and re-sending is not this function's decision;
 * - the reply is turned into an `Executed` when it carries one (see
 *   {@link SubmitViaReply}), and otherwise the chain is asked — by the digest
 *   of the bytes that were handed over, which a co-signature does not change;
 * - a failure from `send` is **ambiguous** unless it says otherwise, so it ends
 *   in `Tx.reconcile` with the full evidence rules: the ordered expiry check,
 *   the chain-identity guard, the versioned consumer check. A sender error that
 *   **declares** `outcome: "not_applied"` on the instance — a 400 from the
 *   service, a refusal before anything went out — is taken at its word and
 *   fails straight through without spending a reconcile, and the journal entry
 *   is settled as `NotApplied { evidence: "refused" }`. A `TransportError` is
 *   not that: the taxonomy calls it `not_applied`, but a transport failure
 *   *talking to the relay* is exactly the ambiguous case, so it reconciles;
 * - every terminal answer is journalled, exactly as `Tx.submit` journals it.
 *
 * Fails with: `ExecutionFailed`, `NotApplied`, `SubmissionUnknown` (carrying
 * the signed bytes, with the sender's failure as its `cause`), `JournalError`
 * (only from the write before `send`), and `E` — whatever `send` fails with —
 * when that error declares `outcome: "not_applied"`.
 *
 * @since 0.1.2
 */
export const submitVia = Effect.fn("Tx.submitVia")(function*<E, R>(
  signed: Signed,
  send: (
    bytes: Uint8Array,
    signatures: ReadonlyArray<Signature>
  ) => Effect.Effect<SubmitViaReply, E, R>
): Effect.fn.Return<Executed, SubmitViaError | E, Sui | R> {
  yield* journalSigned(signed)
  const sent = yield* Effect.result(send(signed.bytes, signed.signatures))
  if (sent._tag === "Success") {
    const decoded = yield* Effect.result(executedOfReply(signed, sent.success))
    if (decoded._tag === "Failure") {
      // The service passed on a transaction that applied and failed. Gas was
      // charged; that is terminal and it goes in the journal as such.
      yield* journalSettled(yield* failedEntry(decoded.failure))
      return yield* decoded.failure
    }
    if (decoded.success !== undefined) {
      yield* journalSettled(yield* executedEntry(decoded.success))
      return withSender(decoded.success, signed.sender)
    }
    return yield* reconcileSigned(
      signed,
      new TransportError({
        method: "submitVia",
        retryable: false,
        cause: "the service answered without an execute envelope; asking the chain"
      }),
      1,
      0
    )
  }
  const failure = sent.failure
  // A **declared** `outcome` field, not `SuiError.outcome`'s answer: the
  // taxonomy calls a `TransportError` `not_applied`, and a transport failure
  // talking to the relay is the ambiguous case this exists for. Only an error
  // whose own instance says `outcome: "not_applied"` — the refusal a service
  // returns before it sends anything — skips the reconcile.
  if ((failure as { readonly outcome?: unknown })?.outcome === "not_applied") {
    // Terminal on the service's word, so the `Signed` entry written above does
    // not stay unresolved until its expiration window closes.
    yield* journalRefused(signed)
    return yield* Effect.fail(failure)
  }
  return yield* reconcileSigned(
    signed,
    new TransportError({ method: "submitVia", retryable: false, cause: failure }),
    1,
    0
  )
})

/**
 * Reconciles signed bytes and records what that settled to: the one
 * settle-and-journal step `Tx.submit`, `Tx.submitVia`, `Tx.resubmit` and
 * `Tx.reconcileAll` share.
 *
 * `rechecks` is how many more reconciles are run, `SubmitConfig.reconcileRecheck`
 * apart, while the answer is still `SubmissionUnknown` — read-only rounds, each
 * under the full evidence rules, for the lock-conflict race whose winner
 * becomes readable a moment later.
 *
 * `Executed`, `Failed` and `NotApplied` are terminal entries; anything still
 * unknown is rewritten as `Unknown`, carrying the bytes, `lastError` (the
 * reconcile's own answer when there is none) and `attempts`. The write is
 * uninterruptible once the reconcile has answered, so an interrupt cannot
 * separate an answer from its record. A journal write that fails is logged and
 * the answer stands. Never fails.
 */
const settle = Effect.fnUntraced(function*(
  signed: Signed,
  attempts: number,
  lastError: string | undefined,
  rechecks = 0
): Effect.fn.Return<Reconciled, never, Sui> {
  const config = yield* SubmitConfig
  const answer = Effect.gen(function*() {
    let result = yield* Effect.result(reconcileUnjournaled(signed))
    for (let round = 0; round < rechecks; round++) {
      if (result._tag !== "Failure" || result.failure._tag !== "SubmissionUnknown") break
      yield* Effect.sleep(config.reconcileRecheck)
      result = yield* Effect.result(reconcileUnjournaled(signed))
    }
    return result
  })
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(answer), (result) => record(signed, attempts, lastError, result))
  )
})

/** Journals one reconcile answer as {@link settle} does, and returns it. Never fails. */
const record = Effect.fnUntraced(function*(
  signed: Signed,
  attempts: number,
  lastError: string | undefined,
  result: Result.Result<Executed, ExecutionFailed | NotApplied | SubmissionUnknown>
): Effect.fn.Return<Reconciled> {
  if (result._tag === "Success") {
    yield* journalSettled(yield* executedEntry(result.success))
    return Reconciled.cases.Executed.make({ _tag: "Executed", executed: result.success })
  }
  const failure = result.failure
  switch (failure._tag) {
    case "ExecutionFailed":
      yield* journalSettled(yield* failedEntry(failure))
      return Reconciled.cases.ExecutionFailed.make({ _tag: "ExecutionFailed", error: failure })
    case "NotApplied":
      // Terminal, so the entry stops being unresolved: without this a
      // durable journal would hold a proven-dead submission forever and
      // `onUnresolved: "fail"` would refuse to build for the life of it.
      yield* journalSettled(yield* notAppliedEntry(failure))
      return Reconciled.cases.NotApplied.make({ _tag: "NotApplied", error: failure })
    case "SubmissionUnknown":
      yield* journalSettled(
        yield* unknownEntry(signed, lastError ?? SuiError.describe(failure), attempts)
      )
      return Reconciled.cases.SubmissionUnknown.make({ _tag: "SubmissionUnknown", error: failure })
  }
})

/**
 * `reconcile` plus the journal bookkeeping `submit` owes after it.
 *
 * A `SubmissionUnknown` answer carries **what the last send said** as well as
 * what the reconcile found: "the node does not know this digest" alone hid the
 * validator's own refusal text — the lock conflict naming the transaction that
 * won — in the journal's `lastError`, where a person reading stderr never saw
 * it.
 */
const reconcileSigned = Effect.fn("Tx.reconcileSigned")(function*(
  signed: Signed,
  lastError: TransportError,
  attempts: number,
  rechecks: number
): Effect.fn.Return<Executed, ExecutionFailed | NotApplied | SubmissionUnknown, Sui> {
  const sent = SuiError.describe(lastError)
  const settled = yield* settle(signed, attempts, sent, rechecks)
  if (settled._tag === "Executed") return settled.executed
  if (settled._tag !== "SubmissionUnknown") return yield* settled.error
  const error = settled.error
  return yield* new SubmissionUnknown({
    digest: error.digest,
    ...(error.signed === undefined ? {} : { signed: error.signed }),
    cause: `${reasonOf(error.cause)}; the last send failed with ${sent}`
  })
})

const inputOf = (input: ReconcileInput): { digest: Digest; signed?: Signed } => {
  if (typeof input === "string") return { digest: input }
  if (input instanceof SubmissionUnknown) {
    return input.signed === undefined
      ? { digest: input.digest }
      : { digest: input.digest, signed: input.signed }
  }
  return { digest: input.digest, signed: input }
}

/** What the node currently says about an object a transaction pinned. */
type InputState =
  | { readonly _tag: "Absent" }
  | {
    readonly _tag: "Present"
    readonly version: bigint
    readonly previousTransaction: string | undefined
  }

/**
 * One read of a pinned object, asking for the digest that last mutated it.
 *
 * `previousTransaction` is the whole point of the read: it is the only field
 * that says *which* transaction moved the object on, and therefore the only
 * thing that can tell "someone else spent our input" from "we spent it
 * ourselves and the node has not caught up". The include set asks for nothing
 * else — no `content`, so a version bump on an object whose Move type we cannot
 * decode is still readable evidence.
 *
 * Fails with: `TransportError`.
 */
const inputStateOf = Effect.fnUntraced(function*(
  sui: Sui["Service"],
  objectId: string
): Effect.fn.Return<InputState, TransportError> {
  const found = yield* Effect.result(
    sui.core.getObject({ objectId, include: { previousTransaction: true } })
  )
  if (found._tag !== "Success") {
    // Deleted, wrapped, or the node would not say: there is no version and no
    // consuming digest to reason about, only absence.
    if (found.failure._tag === "TransportError") return yield* found.failure
    return { _tag: "Absent" }
  }
  const object = found.success.object
  const version = yield* Effect.try({
    try: () => BigInt(object.version),
    catch: (cause) =>
      new TransportError({
        method: "getObject",
        retryable: false,
        cause: `the node reported version ${object.version} for ${objectId}: ${String(cause)}`
      })
  })
  return {
    _tag: "Present",
    version,
    previousTransaction: object.previousTransaction ?? undefined
  }
})

/** What reading the pinned objects proved about a transaction the node forgot. */
type InputEvidence =
  | { readonly _tag: "NoEvidence" }
  | { readonly _tag: "ConsumedByOther"; readonly objectId: string; readonly by: string }
  | { readonly _tag: "AppliedByUs"; readonly objectId: string }
  | { readonly _tag: "Unreadable"; readonly objectId: string; readonly reason: string }

/**
 * The version of one object that a given transaction took as **input**, read
 * out of that transaction's own effects.
 *
 * `changedObjects[].inputVersion` is the only field on the network that answers
 * "which version did this transaction consume": there is no `v + 1` rule to
 * lean on, because Sui stamps every output of a transaction with that
 * transaction's **Lamport version** — `max(input versions) + 1` across all of
 * its inputs — so an owned object read alongside a newer gas coin jumps from
 * version 4 to 6,436,928 and the object "at version 5" never existed.
 *
 * A transaction that **failed** on chain still consumed its inputs, so its
 * effects are read out of `ExecutionFailed` as readily as out of `Executed`.
 * `undefined` means the question cannot be answered here — the node does not
 * serve that transaction, it answered for **another** digest, or its effects
 * do not mention this object (it was created rather than consumed).
 *
 * Fails with: `TransportError`.
 */
const consumedVersionOf = Effect.fnUntraced(function*(
  sui: Sui["Service"],
  by: string,
  objectId: string
): Effect.fn.Return<bigint | undefined, TransportError> {
  const decoded = decodeDigestOption(by)
  if (decoded._tag !== "Some") return undefined
  const found = yield* Effect.result(sui.getTransaction(decoded.value))
  if (found._tag === "Failure" && found.failure._tag === "TransportError") {
    return yield* found.failure
  }
  const answer = found._tag === "Success"
    ? found.success
    : found.failure._tag === "ExecutionFailed"
    ? found.failure
    : undefined
  // An answer about another transaction is inconclusive, never evidence: its
  // effects would turn a confused node into a false `inputConsumed`.
  if (answer === undefined || answer.digest !== decoded.value) return undefined
  const effects = answer.effects
  if (effects === undefined) return undefined
  const wanted = normalizeSuiAddress(objectId)
  for (const change of effects.changedObjects) {
    if (normalizeSuiAddress(change.objectId) !== wanted) continue
    return change.inputVersion ?? undefined
  }
  return undefined
})

/**
 * Reads every object the bytes pinned — owned inputs and gas coins alike — and
 * says what their current state proves.
 *
 * A version that has not moved proves nothing and the next reference is tried.
 * A version that has moved (or an object that is gone) says only *that* it
 * moved; it does not say **who** moved it, and that is the whole question.
 *
 * The live object's `previousTransaction` names the **latest** mutation, which
 * is not necessarily the consumer of the version these bytes pinned: T can
 * consume version 3 and U version 4, and the object then names U. So the answer
 * is read out of that transaction's own effects:
 *
 * - `previousTransaction` is **our** digest: the transaction applied, whatever
 *   the read replica that answered `getTransaction` thought;
 * - it is a **different** digest, and that transaction's effects report
 *   `inputVersion` **equal to the version we pinned**: those exact bytes can
 *   never execute again, and that is the one thing `NotApplied
 *   { inputConsumed }` may be built on;
 * - it is a different digest whose `inputVersion` is **greater** than ours:
 *   something between the two consumed our version and the node does not serve
 *   the state in between, so nothing is proven;
 * - nothing readable at all — a deleted object, a node that names no
 *   transaction, a transaction the node has pruned — proves nothing either way.
 *
 * **Every pinned reference is tried.** A gas coin that merely moved on, or an
 * input whose consumer cannot be read, does not end the search: the first
 * inconclusive reference is remembered and the next one is read, and the
 * remembered reason is only reported when no reference proved anything. Giving
 * up on the first moved reference is how a reconcile with `AppliedByUs`
 * evidence one read away returned `SubmissionUnknown`.
 *
 * Fails with: `TransportError`.
 */
const inputEvidence = Effect.fn("Tx.inputEvidence")(function*(
  sui: Sui["Service"],
  digest: Digest,
  signed: Signed
): Effect.fn.Return<InputEvidence, TransportError> {
  let inconclusive: InputEvidence | undefined
  const remember = (objectId: string, reason: string): void => {
    if (inconclusive === undefined) inconclusive = { _tag: "Unreadable", objectId, reason }
  }
  for (const pinned of pinnedRefsOfBytes(signed.bytes)) {
    const decoded = decodeObjectId(pinned.objectId)
    if (decoded._tag !== "Some") continue
    const objectId = decoded.value
    const state = yield* inputStateOf(sui, objectId)
    if (state._tag === "Present" && state.version <= pinned.version) continue
    if (state._tag === "Absent") {
      remember(objectId, "it is gone, and a deleted object names no transaction")
      continue
    }
    const by = state.previousTransaction
    if (by === undefined) {
      remember(objectId, "the node served the object but named no transaction as its last mutation")
      continue
    }
    if (by === digest) return { _tag: "AppliedByUs", objectId }
    const consumed = yield* consumedVersionOf(sui, by, objectId)
    if (consumed === undefined) {
      remember(
        objectId,
        `the node does not say which version transaction ${by}, which last mutated it, consumed`
      )
      continue
    }
    if (consumed === pinned.version) return { _tag: "ConsumedByOther", objectId, by }
    remember(
      objectId,
      `transaction ${by} consumed version ${consumed} of it, not the version ${pinned.version}` +
        " these bytes pinned, and the state in between is not served"
    )
  }
  return inconclusive ?? { _tag: "NoEvidence" }
})

/** The epoch the node currently reports. Fails with: `TransportError`. */
const currentEpoch = Effect.fnUntraced(function*(
  sui: Sui["Service"]
): Effect.fn.Return<bigint, TransportError> {
  const { systemState } = yield* sui.core.getCurrentSystemState()
  return yield* epochOf(systemState.epoch)
})

/**
 * Whether the transaction's expiration window is observably closed **right
 * now**: the current epoch is past its `maxEpoch`, or `chainTime` is past its
 * `maxTimestamp` by more than `SubmitConfig.expiryMargin`.
 *
 * One observation of this is not evidence of anything (see `reconcile`); it is
 * the thing that has to hold twice, around a `getTransaction` miss each time.
 *
 * Fails with: `TransportError`.
 */
const expiryClosed = Effect.fnUntraced(function*(
  sui: Sui["Service"],
  config: SubmitConfigService,
  signed: Signed
): Effect.fn.Return<boolean, TransportError> {
  const lastEpoch = maxEpochOf(signed.expiration)
  if (lastEpoch !== undefined) {
    // Epochs first: they are what the default expiration carries, and unlike a
    // wall clock an epoch is a consensus fact, so no skew margin is needed.
    const epoch = yield* currentEpoch(sui)
    if (epoch > lastEpoch) return true
  }
  const bound = maxTimestampMsOf(signed.expiration)
  if (bound !== undefined) {
    const now = yield* sui.chainTime
    const margin = BigInt(Duration.toMillis(config.expiryMargin))
    if (BigInt(DateTime.toEpochMillis(now)) > bound + margin) return true
  }
  return false
})

/** The first epoch a transaction can be applied in, when its expiration says. */
const minEpochOf = (expiration: TransactionExpiration | undefined): bigint | undefined => {
  if (expiration === undefined) return undefined
  switch (expiration.$kind) {
    case "ValidDuring":
      return expiration.ValidDuring.minEpoch ?? undefined
    case "Validity":
      return expiration.Validity.minEpoch ?? undefined
    default:
      return undefined
  }
}

/**
 * The two `LedgerService` calls a gRPC client exposes that say how much history
 * the node still holds, duck-typed so that a transport without them (JSON-RPC,
 * GraphQL, an older SDK) is simply "does not say" rather than a type error.
 */
interface LedgerReader {
  readonly getServiceInfo: (
    input: object,
    options?: { readonly abort?: AbortSignal }
  ) => { readonly response: PromiseLike<{ readonly lowestAvailableCheckpoint?: unknown }> }
  readonly getEpoch: (
    input: { readonly epoch: bigint; readonly readMask?: { readonly paths: ReadonlyArray<string> } },
    options?: { readonly abort?: AbortSignal }
  ) => {
    readonly response: PromiseLike<{ readonly epoch?: { readonly firstCheckpoint?: unknown } }>
  }
}

const ledgerOf = (client: ClientWithCoreApi): LedgerReader | undefined => {
  const ledger = (client as { readonly ledgerService?: unknown }).ledgerService
  if (typeof ledger !== "object" || ledger === null) return undefined
  const record = ledger as Record<string, unknown>
  return typeof record["getServiceInfo"] === "function" && typeof record["getEpoch"] === "function"
    ? (ledger as LedgerReader)
    : undefined
}

/** Whether the node still holds every checkpoint a transaction could have landed in. */
type History =
  | { readonly _tag: "Covered" }
  | { readonly _tag: "Unreported" }
  | { readonly _tag: "Pruned"; readonly reason: string }

/**
 * Whether a `getTransaction` miss on this node can mean "it never applied".
 *
 * The expiry rule reads a miss as absence, which is only true on a node whose
 * history reaches back to the start of the transaction's validity window. A
 * pruning fullnode forgets transactions minutes after they land, so a miss
 * there says nothing. On gRPC the node says how far back it reaches
 * (`GetServiceInfo.lowestAvailableCheckpoint`) and where the window starts
 * (`GetEpoch(minEpoch).firstCheckpoint`; an expiration with no `minEpoch`
 * starts at genesis): the miss counts only when the lowest available checkpoint
 * is at or before that first checkpoint. Anything the node does not answer —
 * no lowest checkpoint, the window's epoch no longer served — is `Pruned`,
 * because "I cannot tell" is not evidence.
 *
 * A transport that exposes no such call (JSON-RPC, GraphQL, the test fake
 * unless `FakeScript.ledger` is set) is `Unreported`, and the rule runs as it
 * always has: behind a pruning node on those transports set
 * `SubmitConfig.expiryEvidence: "never"`.
 *
 * Read **after** the misses it vouches for: a node only ever prunes forward, so
 * history that covers the window now covered it at every earlier lookup.
 *
 * Fails with: `TransportError`.
 */
const historyOf = Effect.fn("Tx.historyOf")(function*(
  sui: Sui["Service"],
  signed: Signed
): Effect.fn.Return<History, TransportError> {
  const start = minEpochOf(signed.expiration) ?? 0n
  const answered = yield* Effect.result(
    sui.core.use(async (client, signal): Promise<History> => {
      const ledger = ledgerOf(client)
      if (ledger === undefined) return { _tag: "Unreported" }
      const info = await ledger.getServiceInfo({}, { abort: signal }).response
      const lowest = info.lowestAvailableCheckpoint
      if (typeof lowest !== "bigint") {
        return { _tag: "Pruned", reason: "the node does not say how much history it holds" }
      }
      if (lowest === 0n) return { _tag: "Covered" }
      const epoch = await ledger.getEpoch(
        { epoch: start, readMask: { paths: ["epoch", "first_checkpoint"] } },
        { abort: signal }
      ).response
      const first = epoch.epoch?.firstCheckpoint
      if (typeof first !== "bigint") {
        return {
          _tag: "Pruned",
          reason: `the node does not say where epoch ${start}, where this transaction's window starts, begins`
        }
      }
      return lowest <= first ? { _tag: "Covered" } : {
        _tag: "Pruned",
        reason: `the node has pruned its history to checkpoint ${lowest}, after checkpoint ${first}` +
          ` where this transaction's window (epoch ${start}) starts, so a miss there is not evidence`
      }
    })
  )
  if (answered._tag === "Success") return answered.success
  const failure = answered.failure
  if (failure._tag === "TransportError") {
    // A node that will not say where an old epoch starts has, in practice,
    // pruned it: that is "cannot tell", which never concludes anything.
    if (failure.status === "NOT_FOUND" || failure.status === "5") {
      return { _tag: "Pruned", reason: `the node no longer serves epoch ${start}, where this transaction's window starts` }
    }
    return yield* failure
  }
  return { _tag: "Pruned", reason: `the node's history could not be read: ${SuiError.describe(failure)}` }
})

/**
 * The chain these bytes belong to: the one the expiration names, or the one
 * `Tx.build` recorded for the variants that name none. `undefined` when neither
 * is available, which is every hand-built `Signed` from before this field
 * existed.
 */
const chainOfSigned = (signed: Signed): string | undefined =>
  chainOf(signed.expiration) ?? signed.chain

/**
 * Finds out what happened to a transaction that was sent but never answered
 * for.
 *
 * A transaction the node knows is `Executed`, or `ExecutionFailed` when it
 * applied and aborted. A transaction the node does not know is only ever
 * `NotApplied` on evidence, and there are exactly two kinds:
 *
 * - `"expired"`, under an **ordered and repeated** rule, because a closed
 *   expiration window proves only that the bytes cannot execute *later*, not
 *   that they did not execute *earlier*, and a transaction can execute between
 *   a lookup and an expiry check. So: the window must be observed closed, then
 *   `getTransaction` must miss, then — after `SubmitConfig.reconcileRecheck`
 *   (two seconds by default, through the `Clock`) — both must hold again. Any
 *   other order, or a single observation, is `SubmissionUnknown`. Set
 *   `SubmitConfig.expiryEvidence: "never"` to disable the rule entirely, which
 *   is what a deployment behind a mixed-node load balancer wants. **Positive
 *   evidence vetoes it**: when a pinned object names this digest as its last
 *   mutation the transaction applied, whatever `getTransaction` said, and the
 *   answer is the receipt or `SubmissionUnknown` — never `expired`. **A miss
 *   only counts on a node that still holds the window**: on gRPC the node's
 *   `lowestAvailableCheckpoint` must be at or before the first checkpoint of
 *   the window's `minEpoch`, or the answer is `SubmissionUnknown` naming the
 *   pruning. Transports that do not report their history (JSON-RPC, GraphQL)
 *   cannot be checked; behind a pruning node on those, set `expiryEvidence:
 *   "never"`. The residual risk is a node whose transaction index lags its
 *   epoch view;
 * - `"inputConsumed"` when the transaction that last mutated a pinned object is
 *   a **different** one **and its own effects report `inputVersion` equal to
 *   the version these bytes pinned**, so those exact bytes can never execute
 *   again.
 *
 * An input that merely advanced is not evidence: the transaction being
 * reconciled is itself the likeliest thing to have advanced it, and calling
 * that `NotApplied` would tell the documented retry idiom to execute the
 * caller's intent a second time. When the live object names *our* digest the
 * transaction applied and `getTransaction` is asked again; when the consuming
 * transaction took a **later** version than ours — which is the common case,
 * because Sui stamps every output with the transaction's Lamport version and
 * the object "one version on" from ours usually never existed — nothing is
 * proven and the answer is `SubmissionUnknown`, which carries the bytes so a
 * later process, or a person, can settle it. Every pinned reference is tried
 * before that answer is given.
 *
 * **Chain identity is checked before anything is asked.** Bytes built for one
 * chain must never be declared expired by another chain's epoch, which a
 * process-wide journal holding two networks' submissions makes easy to do. A
 * mismatch is `SubmissionUnknown` naming both chains.
 *
 * **No `TransportError` escapes.** A recovery read that fails says nothing
 * about whether the transaction applied, and `SuiError.outcome` puts
 * `TransportError` on `"not_applied"` — which would tell a wrapper to retry a
 * submission whose outcome is genuinely unknown. Every read failure here
 * becomes `SubmissionUnknown` carrying the digest, the bytes and the cause.
 *
 * **An answer for another digest is not trusted**, here as on the send side:
 * a `getTransaction` that answers an `Executed` or `ExecutionFailed` for a
 * different transaction is `SubmissionUnknown` naming both digests, and a
 * consuming transaction's answer for a different digest is not
 * `inputConsumed` evidence.
 *
 * Given only a `Digest` there can be no evidence, so an unknown transaction is
 * always `SubmissionUnknown`. Pass the `Signed` bytes (or the
 * `SubmissionUnknown` that carries them) to get the evidence rules.
 *
 * **A terminal answer is journalled** — `Executed`, `Failed` or `NotApplied`
 * replaces the entry — when the journal holds this digest unresolved. A digest
 * the journal has never seen is not written, and `SubmissionUnknown` leaves the
 * entry as it was. To re-send bytes that are still unknown, use
 * {@link resubmit}.
 *
 * Fails with: `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`.
 */
export const reconcile = Effect.fn("Tx.reconcile")(function*(
  input: ReconcileInput
): Effect.fn.Return<Executed, ExecutionFailed | NotApplied | SubmissionUnknown, Sui> {
  const answer = yield* Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(
      restore(Effect.result(reconcileUnjournaled(input))),
      (result) => Effect.as(recordIfHeld(inputOf(input).digest, result), result)
    )
  )
  return yield* Effect.fromResult(answer)
})

/**
 * Writes a terminal reconcile answer over the journal's entry for the digest —
 * **only when the journal holds that digest unresolved**. A `Tx.reconcile` that
 * proved an entry `NotApplied` and left it `Unknown` answered the same question
 * again on every call and kept `onUnresolved: "fail"` refusing to start. A
 * digest the journal has never seen is not written: asking about a
 * transaction is not taking responsibility for it. A `SubmissionUnknown`
 * leaves the entry as it was. Never fails: a journal that cannot be read or
 * written is logged, and the answer stands.
 */
const recordIfHeld = (
  digest: Digest,
  result: Result.Result<Executed, ExecutionFailed | NotApplied | SubmissionUnknown>
): Effect.Effect<void> =>
  Effect.gen(function*() {
    if (result._tag === "Failure" && result.failure._tag === "SubmissionUnknown") return
    const journal = yield* Journal
    const held = yield* journal.get(digest)
    if (held._tag !== "Some" || !isUnresolved(held.value)) return
    const entry = result._tag === "Success"
      ? yield* executedEntry(result.success)
      : result.failure._tag === "ExecutionFailed"
      ? yield* failedEntry(result.failure)
      : yield* notAppliedEntry(result.failure as NotApplied)
    yield* journalSettled(entry)
  }).pipe(
    Effect.catchTag("JournalError", (error) =>
      Effect.logError("the submission journal could not be read; the outcome stands", error)),
    Effect.annotateLogs({ digest })
  )

/** {@link reconcile} without the journal write. */
const reconcileUnjournaled = Effect.fnUntraced(function*(
  input: ReconcileInput
): Effect.fn.Return<Executed, ExecutionFailed | NotApplied | SubmissionUnknown, Sui> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const { digest, signed } = inputOf(input)
  yield* Effect.annotateCurrentSpan({
    "sui.digest": digest,
    // Whether there are bytes to reason about is what decides which evidence
    // rules can run at all, so it belongs on the span beside the digest.
    "sui.evidence": signed === undefined ? "digest" : "signed"
  })
  return yield* recover(sui, config, digest, signed).pipe(
    // The bytes name the sender; a `getTransaction` with the execute include
    // set does not return it.
    Effect.map((executed) => signed === undefined ? executed : withSender(executed, signed.sender)),
    Effect.catchTag("TransportError", (error) =>
      Effect.fail(
        new SubmissionUnknown({
          digest,
          ...(signed === undefined ? {} : { signed }),
          cause: error
        })
      ))
  )
}, (effect) =>
  // Every reconcile answer, on the enclosing span and in
  // `sui_effect_tx_reconcile_total`: the one `Tx.submit` runs, `Tx.reconcile`,
  // `Tx.resubmit` and `Tx.reconcileAll` all come through here.
  effect.pipe(
    Effect.tap(() => reconciled("Executed")),
    Effect.tapError((error) => reconciled(error._tag, error._tag === "NotApplied" ? error.evidence : undefined))
  ))

/** Annotates and counts one reconcile answer. Never fails. */
const reconciled = (
  tag: "Executed" | "ExecutionFailed" | "NotApplied" | "SubmissionUnknown",
  evidence?: NotAppliedEvidence
): Effect.Effect<void> =>
  Effect.annotateCurrentSpan({
    "sui.outcome": Metrics.resultOf(tag),
    ...(evidence === undefined ? {} : { "sui.not_applied.evidence": evidence })
  }).pipe(Effect.andThen(Metrics.increment(Metrics.reconcileResults, Metrics.reconcileAttributes(tag, evidence))))

/** The body of {@link reconcile}, before its read failures become unknown. */
const recover = Effect.fn("Tx.recover")(function*(
  sui: Sui["Service"],
  config: SubmitConfigService,
  digest: Digest,
  signed: Signed | undefined
): Effect.fn.Return<
  Executed,
  ExecutionFailed | NotApplied | SubmissionUnknown | TransportError
> {
  const unknown = (cause: unknown) =>
    new SubmissionUnknown({
      digest,
      // Absent when `reconcile` was given only a digest: there is then nothing
      // to re-send, and saying so is better than inventing empty bytes.
      ...(signed === undefined ? {} : { signed }),
      cause
    })

  if (signed !== undefined) {
    const chain = chainOfSigned(signed)
    if (chain !== undefined && chain !== sui.chainId) {
      return yield* unknown(
        `these bytes were built for chain ${chain} and this Sui is on ${sui.chainId};` +
          " nothing this node says about them is evidence"
      )
    }
  }

  /**
   * An answer about another transaction is no answer about this one: returned,
   * it would settle the caller on a foreign receipt and journal it under the
   * foreign digest, leaving this entry unresolved. It becomes a non-retryable
   * `TransportError`, which the caller of `recover` turns into
   * `SubmissionUnknown`.
   */
  const answeredForAnother = (answered: string) =>
    new TransportError({
      method: "getTransaction",
      retryable: false,
      cause: `the node answered for transaction ${answered}, not the requested ${digest}`
    })

  /** One `getTransaction`, with "the node does not know it" as a value. */
  const lookup = Effect.fnUntraced(function*(): Effect.fn.Return<
    Executed | undefined,
    ExecutionFailed | TransportError
  > {
    const found = yield* Effect.result(sui.getTransaction(digest))
    if (found._tag === "Success") {
      if (found.success.digest !== digest) return yield* answeredForAnother(found.success.digest)
      return found.success
    }
    if (found.failure._tag === "ExecutionFailed" && found.failure.digest !== digest) {
      return yield* answeredForAnother(found.failure.digest)
    }
    if (found.failure._tag !== "TransactionNotFound") return yield* found.failure
    return undefined
  })

  const first = yield* lookup()
  if (first !== undefined) return first

  if (signed === undefined) {
    return yield* unknown("the node does not know this digest and the signed bytes are not available")
  }

  // The expiry rule is ordered and repeated: closed, then missing, then —
  // after a delay — closed and missing again. Anything else proves nothing.
  let expired = false
  if (config.expiryEvidence === "epochThenMiss" && (yield* expiryClosed(sui, config, signed))) {
    const second = yield* lookup()
    if (second !== undefined) return second
    yield* Effect.sleep(config.reconcileRecheck)
    if (yield* expiryClosed(sui, config, signed)) {
      const third = yield* lookup()
      if (third !== undefined) return third
      expired = true
    }
  }

  // Read **before** a closed window is allowed to conclude anything: positive
  // evidence that these bytes applied vetoes "expired". A `getTransaction` miss
  // is only evidence of absence on a node that still holds the window, and a
  // node that pruned it (or a proxy that drops the lookup) misses transactions
  // that did apply — while the live object still names them.
  const evidence = yield* inputEvidence(sui, digest, signed)
  if (evidence._tag === "AppliedByUs") {
    // Object ${objectId} names this very transaction as the one that last
    // mutated it, so it applied; the `getTransaction` above was answered by a
    // node that had not caught up, or no longer holds it. Ask once more for
    // the receipt.
    const again = yield* lookup()
    if (again !== undefined) return again
    return yield* unknown(
      `object ${evidence.objectId} names this transaction as the one that last mutated it,` +
        " so it applied, but the node does not serve it" +
        (expired ? " (its validity window has closed; do not re-send it)" : "")
    )
  }

  let pruned: string | undefined
  if (expired) {
    const history = yield* historyOf(sui, signed)
    if (history._tag !== "Pruned") return yield* new NotApplied({ digest, evidence: "expired" })
    pruned = history.reason
  }

  switch (evidence._tag) {
    case "ConsumedByOther":
      return yield* new NotApplied({ digest, evidence: "inputConsumed" })
    case "Unreadable":
      return yield* unknown(
        `object ${evidence.objectId} has moved on or is gone, and ${evidence.reason},` +
          " so nothing is proven" + (pruned === undefined ? "" : `; ${pruned}`)
      )
    case "NoEvidence":
      return yield* unknown(
        pruned === undefined
          ? "the node does not know this digest and nothing proves it cannot land"
          : `the validity window has closed, but ${pruned}`
      )
  }
})

/**
 * Who a not-yet-built transaction says will pay for gas, and whether it pays
 * from an address balance: `opts.gasOwner` first, then what the recipe set.
 * A `Transaction` whose data cannot be read answers neither, which keeps the
 * old behaviour — `opts.gasOwner` alone, both locks. Never fails.
 */
const gasIntentOf = (
  tx: Transaction,
  gasOwner: SuiAddress | undefined
): { readonly gasOwner: SuiAddress | undefined; readonly addressBalance: boolean } => {
  try {
    const data = tx.getData()
    const set = data.gasData.owner
    const owner = gasOwner ?? (typeof set === "string" && set.length > 0
      ? Option.getOrUndefined(decodeAddress(normalizeSuiAddress(set)))
      : undefined)
    const payment = data.gasData.payment
    return { gasOwner: owner, addressBalance: payment !== null && payment !== undefined && payment.length === 0 }
  } catch {
    return { gasOwner, addressBalance: false }
  }
}

/**
 * The signer for an address the bytes require a second signature from, or a
 * `SigningError` saying which address is missing one.
 */
const assertSponsor = (
  gasOwner: string,
  sponsor: Signer | undefined
): Effect.Effect<Signer, SigningError> => {
  if (sponsor === undefined) {
    return Effect.fail(
      new SigningError({
        cause: `this transaction's gas owner is ${gasOwner}, which is not the sender:` +
          " a sponsored transaction needs that party's signature too. Pass" +
          " Tx.run(recipe, { signer, gasOwner, sponsor }), or build, sign, cosign and" +
          " submit the steps yourself when the two parties cannot both sign here"
      })
    )
  }
  if (normalizeSuiAddress(sponsor.address) !== normalizeSuiAddress(gasOwner)) {
    return Effect.fail(
      new SigningError({
        cause: `the sponsor signs as ${sponsor.address}, but this transaction's gas owner` +
          ` is ${gasOwner}`
      })
    )
  }
  return Effect.succeed(sponsor)
}

/**
 * The one simulate of exactly `built.bytes` that everything before signing
 * shares, and the single place a simulation the build already made of these
 * bytes is reused: `built.simulation`, when `Tx.build` made it in this
 * process ({@link BUILD_SIMULATIONS}) for this digest. Anything else —
 * a `Built` from `Tx.fromBytes`, one decoded from JSON — is simulated here.
 *
 * Fails with: `SimulationFailed`, `BuildError`, `TransportError`.
 */
const simulateBuilt = Effect.fnUntraced(function*(
  built: Built
): Effect.fn.Return<Simulation, SimulationFailed | BuildError | TransportError, Sui> {
  const own = built.simulation
  // The digest is recomputed from the bytes: `built.digest` is a field, and a
  // value spread from a real build with other bytes keeps it.
  if (
    own !== undefined && BUILD_SIMULATIONS.has(own) &&
    own.digest === Option.getOrUndefined(Option.liftThrowable(TransactionDataBuilder.getDigestFromBytes)(built.bytes))
  ) {
    yield* Effect.annotateCurrentSpan({ "sui.simulation": "reused" })
    return own
  }
  const sui = yield* Sui
  return yield* sui.simulate(built.bytes)
})

/**
 * Built bytes and what the lifecycle learned about them before anything is
 * signed: the simulation of exactly those bytes. What `Tx.run`'s `approve` is
 * shown.
 *
 * `built.gas` is the gas the bytes carry (budget, price, payer, payment and
 * where it comes from) and `built.gasOwner` the sponsor, when there is one;
 * `simulation` has `Executed`'s accessors (`created`, `transferred`,
 * `balanceChange`, ...), and `simulation.gasUsedTotal` is the gas it is
 * expected to cost.
 *
 * @since 0.5.0
 */
export interface Prepared {
  readonly built: Built
  readonly simulation: Simulation
}

/**
 * The front half of `Tx.run` after the build, when anything needs the
 * simulation — `opts.simulate` (an `approve` step) or a
 * `SubmitConfig.preflight` — and nothing otherwise, so a run with neither
 * costs no simulate beyond the build's own: **one** simulate of exactly these
 * bytes (reused from the build when it made one, {@link simulateBuilt}), then
 * `preflight(simulation)`. Nothing here signs, takes a lock or sends: `Tx.run`
 * runs it exactly where signing runs, under the lock when the bytes pin.
 *
 * Fails with: `SimulationFailed`, `BuildError`, `TransportError` (the
 * simulate), `PolicyDenied` (preflight).
 */
const frontHalf = Effect.fnUntraced(function*(
  built: Built,
  opts: { readonly simulate: boolean }
): Effect.fn.Return<Prepared | undefined, PolicyDenied | SimulationFailed | BuildError | TransportError, Sui> {
  const config = yield* SubmitConfig
  if (!opts.simulate && config.preflight === undefined) return undefined
  const simulation = yield* simulateBuilt(built)
  if (config.preflight !== undefined) yield* config.preflight(simulation)
  return { built, simulation }
})

/**
 * Build, preflight, sign and submit, under the sender lock wherever two runs
 * could race.
 *
 * Owned objects and gas coins are resolved during build, so two transactions
 * from one address that overlap can pin the same one at the same version and
 * one of them will fail on chain. Under `SubmitConfig.lockSender: "whenPinned"`
 * (the default) `Tx.run` holds the sender lock for **every build**, and on
 * through signing and submission **only when the built bytes pin** an owned or
 * receiving input or carry any gas payment — a gas coin **or a coin
 * reservation**. Bytes that pin nothing — an empty payment (gas from an address
 * balance, drawn at execution), inputs that are pure values, shared objects or
 * withdrawals — are signed and sent with the lock released, so address-balance
 * transactions from one sender run concurrently, serialized only for the length
 * of a build. The span attribute `sui.sender_lock` says which happened
 * (`"held"`, `"build"`; `"none"` under `"never"`). `"always"` holds the lock
 * from build through submit on every run (the rule before 0.4.0), `"never"`
 * takes none. This is the whole reason to prefer `Tx.run` over calling the
 * steps separately.
 *
 * **A coin reservation reserves the payer's whole SUI address balance as of the
 * build.** That is what the resolver gives a recipe that uses `tx.gas` when its
 * payer has an address balance (on an account with no SUI coins, the payment is
 * the reservation alone). Any spend from that balance landing between the build
 * and the send makes the node refuse it at submit (`INVALID_ARGUMENT`, "Invalid
 * withdraw reservation", which escapes as `TransportError`), and one in flight
 * beside it makes one of them execute as `InsufficientFundsForWithdraw`. So such
 * a run holds the lock through submission, and a run whose recipe uses `tx.gas`
 * first waits — holding its locks, before it builds — until no lock-free run is
 * in flight on its payer (the gas owner when it is someone else, else the
 * sender). A lock-free run counts as in flight on its sender and its gas owner
 * from just before it releases the lock until it settles, fails or is
 * interrupted. Residual: a reservation that appears only after the build — an
 * SDK intent such as `tx.coin({ balance })` that fell back to splitting
 * `tx.gas` — holds the lock but did not wait, and a sponsored address-balance
 * run (which takes only its sender's lock) can still start drawing on its
 * sponsor's balance while that sponsor's own `tx.gas` run builds. A flow that
 * must never see either uses `lockSender: "always"`.
 *
 * Lock-free runs can together withdraw more than one balance holds; the node
 * then executes the one that overdraws as a failure (`InsufficientFundsForWithdraw`,
 * no gas charged), which is `ExecutionFailed`. A flow that spends a balance
 * down to zero uses `lockSender: "always"`.
 *
 * The address whose coins may be spent is the **gas owner** when there is one:
 * two sponsored runs for different senders paid by one sponsor are exactly the
 * case that picks the same coin twice. When sender and gas owner differ, both
 * locks are taken, in ascending address order — a fixed order, so two runs that
 * each need the same pair cannot deadlock by taking them the other way round —
 * **except when the recipe pays from an address balance**: an explicit empty
 * payment, which `Tx.sponsored` sets, selects no coin, so the gas owner's lock
 * is not taken and one sponsor serves many senders at once.
 *
 * When `SubmitConfig.preflight` is set it costs one extra simulate, and is
 * where spend limits and target policies refuse a transaction before anything
 * is signed.
 *
 * **A sponsored run needs both signatures.** A transaction whose gas owner is
 * not its sender is signed by *both* parties; one signature is bytes a
 * validator rejects. So when `opts.gasOwner` differs from the signer's address
 * — or when the recipe itself set a different gas owner, which `Tx.sponsored`
 * does — `opts.sponsor` is required and co-signs the same bytes. Without it
 * `Tx.run` fails with `SigningError` naming the address whose signature is
 * missing, before anything is built (the recipe is applied first, so a gas
 * owner it sets is known by then too). Use the
 * explicit lifecycle (`Tx.build`, `Tx.sign`, `Tx.cosign`, `Tx.submit`) when the
 * two parties cannot both sign in one process.
 *
 * **The locks are chosen from the recipe itself.** The recipe is applied to a
 * fresh `Transaction` before any lock is taken, so a gas owner it sets itself
 * (`Tx.sponsored` does) and the gas payment it leaves are known when the locks
 * are chosen — passing the same address as `opts.gasOwner` changes nothing.
 * The recipe runs outside the lock: it only describes commands, and anything
 * it reads from the chain belongs in the resolver, which runs inside.
 *
 * **`onSigned` is the hook between signing and sending.** A program with its
 * own record to keep — a batch row, an outbox, an idempotency key — has to
 * write the digest before the first send, and that used to mean giving up
 * `Tx.run` and reassembling `withSenderLock(build → sign → record → submit)` by
 * hand. Pass `onSigned` instead: it runs inside the sender lock, after the last
 * signature and before `Tx.submit`'s first `executeTransaction`, and failing it
 * fails the run with nothing sent.
 *
 * **`approve` is the person (or the policy) in the loop** (0.5.0). After
 * `preflight`, before the first signature, `approve` is shown the
 * {@link Prepared} transaction — the built bytes and the simulation of exactly
 * those bytes — and refuses by failing with its own error, which is then `Tx.run`'s: nothing is signed,
 * `onSigned` does not run and nothing is journalled. It runs under the lock
 * exactly when signing does. A sponsored run approves too: `built.gasOwner`
 * and `built.gas.owner` name the sponsor.
 *
 * **The `maxEpoch` bound** (0.5.0). A signer with a `maxEpoch` (a zkLogin
 * proof's) — and a sponsor with one — bounds the window the build sets:
 * `Tx.build`'s `maxEpoch` is the earlier of the two, and a bound already below
 * the current epoch fails with `SigningError { reason: "expired" }` before
 * anything resolves.
 *
 * **Sender A, signed by M** (0.6.0). `signer: Signer.alias(A, m)` runs a
 * transaction whose sender is the account A with the signature of M, a member
 * of A's alias set (`0x2::address_alias`) — `m` is any signer, a
 * `Signer.multisig` included. Everything that is keyed on the sender is keyed
 * on **A**: the build's sender, the sender lock (and the in-flight registry),
 * `Built.sender`, the journal's `signed.sender`, `onSigned` and `approve`'s
 * `built.sender`; M appears only in the signature (span attribute
 * `sui.signer_alias`). Before anything is built the run reads A's
 * `AddressAliases` object once and refuses an M it does not list with
 * `PolicyDenied { rule: "alias.signer" }`; a sponsor given as
 * `Signer.alias(gasOwner, key)` is read for the same way. A plain signer
 * costs no such read.
 *
 * Fails with: `BuildError`, `SimulationFailed`, `PolicyDenied` (also
 * `alias.signer`, 0.6.0), `SigningError`,
 * `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, `JournalError`,
 * `TransportError` (from the build reads and an alias read; once bytes are
 * sent, transport failures become `SubmissionUnknown`), and `E` — whatever
 * `approve` fails with.
 */
export const run = Effect.fn("Tx.run")(function*<E = never>(
  recipe: Recipe | Transaction,
  opts: {
    readonly signer: Signer
    readonly gasOwner?: SuiAddress
    /**
     * The gas owner's signer, for a sponsored transaction. Required whenever
     * the bytes name a gas owner that is not the sender.
     */
    readonly sponsor?: Signer
    /**
     * Called with the signed bytes **after every signature is on them and
     * before the first `executeTransaction`**, which is the one moment a
     * consumer's own record has to be written: the digest is final from here
     * on, and anything that happens next may have reached the network.
     *
     * `Tx.submit` already writes its `Signed` journal entry at this point; this
     * is for the record the journal does not hold — a domain row joining the
     * digest to a batch, an outbox, a log line an operator greps. It runs
     * inside the sender lock, so it is ordered with the submission it belongs
     * to.
     *
     * Failing it fails the run **before anything is sent**, which is why its
     * error is a `JournalError`: that is the taxonomy's "the record could not
     * be written and nothing has gone out yet", it is already in `Tx.run`'s
     * union, and it is `not_applied`, so the documented retry idiom is correct.
     * Map your own persistence failure into it
     * (`Effect.mapError((cause) => new JournalError({ cause }))`).
     *
     * @since 0.1.2
     */
    readonly onSigned?: (signed: Signed) => Effect.Effect<void, JournalError>
    /**
     * Shown the {@link Prepared} transaction — the built bytes with their gas,
     * the simulation of exactly those bytes — **after** `preflight` and
     * **before the first signature**.
     * Succeeding approves; failing refuses with the caller's own error (a
     * wallet's `UserRejected`), which `Tx.run` fails with, nothing signed and
     * nothing journalled. It runs where signing runs: under the sender lock
     * when the bytes pin something, after it is released when they do not,
     * so a person taking their time never holds an address-balance account's
     * lock. Giving it always costs the simulate it is shown (the build's own,
     * when the build made one of exactly these bytes).
     *
     * @since 0.5.0
     */
    readonly approve?: (prepared: Prepared) => Effect.Effect<void, E>
  }
): Effect.fn.Return<
  Executed,
  | BuildError
  | SimulationFailed
  | PolicyDenied
  | SigningError
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | JournalError
  | TransportError
  | E,
  Sui
> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const sender = opts.signer.address
  // Applied before any lock is chosen, so what the recipe set — its own gas
  // owner, an address-balance payment — decides which locks the run needs.
  const tx = yield* toTransaction(recipe)
  const intended = gasIntentOf(tx, opts.gasOwner)
  // Normalized on both sides: `0x2` and its 64-character spelling are one
  // address, and comparing them as written took two locks on one account — in
  // whichever order the two spellings happened to sort.
  const payer = intended.gasOwner !== undefined &&
      normalizeSuiAddress(intended.gasOwner) !== normalizeSuiAddress(sender)
    ? intended.gasOwner
    : undefined
  // An address-balance payment selects no coins, so the gas owner has nothing
  // to lock: only its sender's lock serializes the run. The pair is ordered by
  // the **normalized** address, which is what the locks are keyed on: ordered
  // by spelling, an upper-case `0xD…` sorts before `0xa…`, and two runs for
  // one pair could take it in opposite orders and deadlock.
  const byLockKey = (left: SuiAddress, right: SuiAddress): number => {
    const l = normalizeSuiAddress(left)
    const r = normalizeSuiAddress(right)
    return l < r ? -1 : l > r ? 1 : 0
  }
  const locked = payer === undefined || intended.addressBalance
    ? [sender]
    : [sender, payer].sort(byLockKey)

  // Before anything is built: a gas owner with no signer for it can never
  // produce bytes a validator accepts.
  if (payer !== undefined) {
    yield* assertSponsor(payer, opts.sponsor)
  }
  // Nor an alias key its account does not list: one `AddressAliases` read
  // per `Signer.alias`, before the build. The run is keyed on the account —
  // `sender` is `opts.signer.address` — never on the alias.
  yield* requireAliases([opts.signer, payer === undefined ? undefined : opts.sponsor])
  if (opts.signer.alias !== undefined) yield* Effect.annotateCurrentSpan({ "sui.signer_alias": opts.signer.alias })

  // The maxEpoch bound: the earlier of the signer's and the sponsor's, so the
  // window the build sets cannot outlive either signature.
  const sessionBound = [opts.signer.maxEpoch, payer === undefined ? undefined : opts.sponsor?.maxEpoch]
    .filter((bound): bound is bigint => bound !== undefined)
    .reduce<bigint | undefined>((least, bound) => (least === undefined || bound < least ? bound : least), undefined)
  const buildIt = build(tx, {
    sender,
    ...(opts.gasOwner === undefined ? {} : { gasOwner: opts.gasOwner }),
    ...(sessionBound === undefined ? {} : { maxEpoch: sessionBound })
  }).pipe(
    // A bound that has already passed is the signer's failure, not the
    // build's: the `SigningError { reason: "expired" }` the build carries.
    Effect.catchTag("BuildError", (error): Effect.Effect<never, BuildError | SigningError> =>
      error.cause instanceof SigningError ? Effect.fail(error.cause) : Effect.fail(error))
  )
  const approve = opts.approve
  // Everything after the build, which is what `"whenPinned"` runs outside the
  // lock when the bytes pin nothing and pay from an empty payment.
  const finish = (built: Built) =>
    Effect.gen(function*() {
      // One simulate for preflight and the approval, here and nowhere else,
      // so it runs exactly where signing does.
      const prepared = yield* frontHalf(built, { simulate: approve !== undefined })
      // Before the first signature: a refusal leaves nothing signed, and
      // nothing journalled, since `Tx.submit` journals.
      if (approve !== undefined && prepared !== undefined) yield* approve(prepared)
      let signed = yield* sign(built, opts.signer)
      // Read back out of the bytes, so a recipe that set its own gas owner —
      // which `Tx.sponsored` does — is covered as well as the option.
      for (const required of signersOfBytes(built.bytes)) {
        if (required === normalizeSuiAddress(sender)) continue
        const sponsor = yield* assertSponsor(required, opts.sponsor)
        signed = yield* cosign(signed, sponsor)
      }
      // Every signature is on: the digest is final and nothing has been sent.
      if (opts.onSigned !== undefined) yield* opts.onSigned(signed)
      return yield* submit(signed)
    })
  return yield* lockedRun({
    sui,
    policy: config.lockSender,
    locked,
    // A `tx.gas` run's reservation would take the payer's whole balance as of
    // its build, so it waits for the lock-free runs on its payer first.
    drains: usesGasCoin(tx) ? payer ?? sender : undefined,
    build: buildIt,
    keeps: keepsSenderLock,
    inFlightOn: (built) => [sender, ...signersOfBytes(built.bytes)],
    finish
  })
})

/**
 * `Tx.run`'s lock rule, for every run that builds, signs and submits under
 * the sender lock. Internal.
 *
 * Under `"whenPinned"` every build runs under the locks, and `keeps(built)`
 * decides whether they are held on through `finish` (signing, submission);
 * when they are not, the run is registered in flight on `inFlightOn(built)`
 * before the locks are released, so a `drains` run — one whose recipe uses
 * `tx.gas` and so reserves its payer's whole balance — waits for it.
 * `"always"` holds the locks through `finish`, `"never"` takes none. The span
 * attribute `sui.sender_lock` says which happened. Never fails beyond
 * `build`'s and `finish`'s errors.
 */
const lockedRun = <A, E1, E2, R1, R2>(opts: {
  readonly sui: Sui["Service"]
  readonly policy: unknown
  /** The addresses to lock, in the order to take them. */
  readonly locked: ReadonlyArray<SuiAddress>
  /** The payer whose lock-free runs in flight to wait for before building, if any. */
  readonly drains: SuiAddress | undefined
  readonly build: Effect.Effect<Built, E1, R1>
  readonly keeps: (bytes: Uint8Array) => boolean
  readonly inFlightOn: (built: Built) => ReadonlyArray<string>
  readonly finish: (built: Built) => Effect.Effect<A, E2, R2>
}): Effect.Effect<A, E1 | E2, R1 | R2> => {
  const { sui, locked, build: buildIt, finish } = opts
  const withLocks = <B, E, R>(effect: Effect.Effect<B, E, R>): Effect.Effect<B, E, R> =>
    locked.reduceRight<Effect.Effect<B, E, R>>(
      (inner, address) => sui.withSenderLock(address)(inner),
      effect
    )
  switch (lockSenderPolicyOf(opts.policy)) {
    case "never":
      return Effect.andThen(
        Effect.annotateCurrentSpan({ "sui.sender_lock": "none" }),
        Effect.flatMap(buildIt, finish)
      )
    case "always":
      return Effect.andThen(
        Effect.annotateCurrentSpan({ "sui.sender_lock": "held" }),
        withLocks(Effect.flatMap(buildIt, finish))
      )
    case "whenPinned": {
      // Every build under the lock: whether the bytes will pin a coin or an
      // owned object, or carry a coin reservation, is known only once the
      // resolver has chosen. The lock is kept through submission only when
      // they do; bytes with an empty payment and pure, shared and withdrawal
      // inputs cannot race another run's build, so they are signed and sent
      // with the lock released — and registered as in flight, so that a
      // `tx.gas` run, whose reservation would take the whole balance as of its
      // build, waits for them first.
      const registry = inFlightRegistryOf(sui.withSenderLock)
      const drains = opts.drains
      // The scope the in-flight registration lives in: this one, not the one
      // `Sui.withSenderLock` opens around its effect, which closes when the
      // lock is released — exactly when the run starts being in flight.
      return Effect.scoped(Effect.gen(function*() {
        const scope = yield* Effect.scope
        const step = yield* withLocks(Effect.gen(function*() {
          if (drains !== undefined) yield* drainInFlight(registry, drains)
          const built = yield* buildIt
          if (opts.keeps(built.bytes)) {
            return { _tag: "Done" as const, done: yield* finish(built) }
          }
          // Still under the lock, so a drainer holding it cannot miss this run.
          yield* Scope.provide(scope)(registerInFlight(registry, opts.inFlightOn(built)))
          return { _tag: "Built" as const, built }
        }))
        // On the caller's own span: inside the lock the current span is
        // `Sui.withSenderLock`'s.
        yield* Effect.annotateCurrentSpan({ "sui.sender_lock": step._tag === "Done" ? "held" : "build" })
        if (step._tag === "Done") return step.done
        return yield* finish(step.built)
      }))
    }
  }
}

/**
 * Re-sends signed bytes whose outcome is unknown — the **identical** bytes,
 * never a rebuild — and settles them the way {@link submit} does.
 *
 * Safe by construction: the bytes have one digest, and Sui executes a digest at
 * most once, so a re-send can only land the transaction that was already
 * signed, or tell you it already landed. This is the way out of a
 * `SubmissionUnknown` that `reconcile` cannot settle yet — a submission with no
 * owned inputs whose evidence can only be the expiry window, a node that lost
 * the request — without waiting for that window to close.
 *
 * What it does **not** do is send bytes that cannot help:
 *
 * - a digest the journal already holds as **settled** is not sent again:
 *   `Executed` or `Failed` is read back with `reconcile`, and `NotApplied`
 *   fails with that `NotApplied`;
 * - bytes built for another chain than this `Sui`'s are not sent; the
 *   reconcile names both chains;
 * - bytes whose validity window has observably closed are not sent; they are
 *   reconciled, which is where the expiry rule decides.
 *
 * Unlike a first `Tx.submit`, a refusal (`INVALID_ARGUMENT`) on the re-send is
 * **not** taken as "nothing executed": an earlier send of the same bytes may
 * have landed, so the refusal reconciles like any other ambiguous answer.
 *
 * Given a `SubmissionUnknown` that carries no bytes (one that came from
 * reconciling a bare digest), there is nothing to send and this is `reconcile`.
 *
 * Fails with: `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`,
 * `JournalError` (reading the journal, or the `Signed` write before the send),
 * `TransportError` (in the union for `SubmitError`'s sake; a re-send never
 * fails with one).
 *
 * @since 0.4.0
 */
export const resubmit = Effect.fn("Tx.resubmit")(function*(
  input: Signed | SubmissionUnknown
): Effect.fn.Return<Executed, SubmitError, Sui> {
  const { digest, signed } = inputOf(input)
  yield* Effect.annotateCurrentSpan({ "sui.digest": digest })
  if (signed === undefined) return yield* reconcile(digest)
  const journal = yield* Journal
  const held = yield* journal.get(digest)
  if (held._tag === "Some") {
    switch (held.value._tag) {
      case "Executed":
      case "Failed":
        return yield* reconcile(signed)
      case "NotApplied":
        return yield* new NotApplied({ digest, evidence: held.value.evidence })
    }
  }
  return yield* resend(signed)
})

/**
 * The body of {@link resubmit} once the journal has been consulted: the chain
 * and expiry checks, then the send. Shared with `reconcileAll({ resubmit })`.
 */
const resend = Effect.fnUntraced(function*(
  signed: Signed
): Effect.fn.Return<Executed, SubmitError, Sui> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const chain = chainOfSigned(signed)
  const closed = chain !== undefined && chain !== sui.chainId
    ? true
    : yield* expiryClosed(sui, config, signed).pipe(
      // Cannot tell: re-sending identical bytes is safe either way.
      Effect.catchTag("TransportError", () => Effect.succeed(false))
    )
  if (closed) {
    const settled = yield* settle(signed, 1, undefined)
    return settled._tag === "Executed" ? settled.executed : yield* settled.error
  }
  return yield* send(signed, true)
})

/**
 * Settles every unresolved entry in the journal: the explicit startup call a
 * long-lived application makes after building a durable `Journal`.
 *
 * **Only unresolved entries come back.** `Signed` and `Unknown` are the tags
 * that still need an answer; a digest that already settled is not among the
 * journal's unresolved entries and is not in this array. Ask about one of those
 * with `Journal.get(digest)`.
 *
 * Nothing here fails per entry: each one settles to an `Executed`, an
 * `ExecutionFailed`, a `NotApplied` or a `SubmissionUnknown`, in the order the
 * journal listed them, and the journal is updated to match. Every settled entry
 * gets the same evidence rules `Tx.reconcile` applies — the ordered, repeated
 * expiry rule, the chain-identity guard and the versioned consumer check — so a
 * startup never reports a transaction that applied as `NotApplied`, and a
 * recovery read that fails becomes that entry's `SubmissionUnknown` rather than
 * escaping as a `TransportError` the taxonomy would call "not applied".
 *
 * **`{ resubmit: true }` re-sends what is still unknown.** An entry that
 * reconciles to `SubmissionUnknown` is sent again as its identical signed
 * bytes, exactly as {@link resubmit} sends them — not when its validity window
 * has closed or it belongs to another chain — and settles to whatever that
 * send answers. Without it, an entry with no owned inputs can only be
 * `SubmissionUnknown` until its window closes, and a program that reconciles
 * before sending anything new is stuck that long.
 *
 * The whole call fails only if the journal itself cannot be **read**: a write
 * that fails after an entry has been settled is logged and the answer stands,
 * the same rule `Tx.submit` follows.
 *
 * Fails with: `JournalError`.
 */
export const reconcileAll = Effect.fn("Tx.reconcileAll")(function*(
  opts?: {
    /**
     * Re-send, as identical bytes, every entry that is still
     * `SubmissionUnknown` after reconciling. Defaults to `false`.
     *
     * @since 0.4.0
     */
    readonly resubmit?: boolean
  }
): Effect.fn.Return<ReadonlyArray<Reconciled>, JournalError, Sui> {
  const journal = yield* Journal
  const entries = yield* journal.listUnresolved
  return yield* Effect.forEach(
    entries.filter(isUnresolved),
    (entry) => Effect.gen(function*() {
      const settled = yield* settle(entry.signed, entry._tag === "Unknown" ? entry.attempts : 1, undefined)
      if (opts?.resubmit !== true || settled._tag !== "SubmissionUnknown") return settled
      const sent = yield* Effect.result(resend(entry.signed))
      if (sent._tag === "Success") {
        return Reconciled.cases.Executed.make({ _tag: "Executed", executed: sent.success })
      }
      const failure = sent.failure
      switch (failure._tag) {
        case "ExecutionFailed":
          return Reconciled.cases.ExecutionFailed.make({ _tag: "ExecutionFailed", error: failure })
        case "NotApplied":
          return Reconciled.cases.NotApplied.make({ _tag: "NotApplied", error: failure })
        case "SubmissionUnknown":
          return Reconciled.cases.SubmissionUnknown.make({ _tag: "SubmissionUnknown", error: failure })
        default:
          // The `Signed` write before the re-send failed (nothing was sent), or
          // — never on a re-send — a refusal: the entry is as unknown as it was.
          yield* Effect.logWarning(
            `the re-send was not made: ${SuiError.describe(failure)}; the entry stays unknown`
          ).pipe(Effect.annotateLogs({ digest: entry.digest }))
          return settled
      }
    })
  )
})

/**
 * What {@link foldCoins} did: the plan it ran, and one `Executed` per batch, in
 * order.
 *
 * @since 0.4.0
 */
export interface FoldResult {
  readonly plan: FoldPlan
  readonly executed: ReadonlyArray<Executed>
}

/**
 * Folds the signer's coin objects into its address balance: {@link planFold}
 * for `signer.address`, then one {@link run} of {@link fold} per batch, in
 * order — SUI first, paying for its own fold, so a fresh account whose SUI is
 * all coins needs no address balance to start. Afterwards gas comes from the
 * balance, and transactions that pin nothing else and do not use `tx.gas` run
 * without holding the sender lock past their build (one that uses `tx.gas` is
 * paid with a reservation of the whole balance, which holds it).
 *
 * Each batch pins its coins, so it runs under the sender lock. It stops at the
 * first batch that fails, with that failure; the batches before it executed and
 * stay executed. Calling it again re-plans from what is left, so it is safe to
 * repeat. Dust that cannot pay for its own fold is in `plan.skipped`, and an
 * owner with no coins answers an empty plan with nothing executed.
 *
 * **A previewed plan is run as given** (0.5.0). Pass the `plan` a person was
 * shown and it is not re-planned — `coinType` and `maxCoinsPerTransaction` are
 * then ignored — so what runs is exactly what was previewed; a coin in it that
 * has moved since fails that batch's build with `BuildError`, as any pinned
 * input does. A plan for another owner — the plan's or any batch's — is a
 * `BuildError` before anything runs. `approve` is `Tx.run`'s, once per batch,
 * shown the batch beside the prepared transaction: `batch.amount` is what the
 * fold moves from coins into the balance, which the simulation's balance
 * changes alone do not show (they net to the gas).
 *
 * Fails with: `BuildError`, `SimulationFailed`, `PolicyDenied`, `SigningError`,
 * `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, `JournalError`,
 * `TransportError` — exactly {@link run}'s, for the batch that failed — and
 * `E`, whatever `approve` fails with.
 *
 * @since 0.4.0
 */
export const foldCoins = Effect.fn("Tx.foldCoins")(function*<E = never>(opts: {
  readonly signer: Signer
  /** One coin type to fold; every coin type the signer holds coins of when omitted. */
  readonly coinType?: CoinType
  /** At most this many coins per transaction: 1 to 500, 500 by default. */
  readonly maxCoinsPerTransaction?: number
  /**
   * A plan from `Tx.planFold`, run as given rather than re-planned.
   *
   * @since 0.5.0
   */
  readonly plan?: FoldPlan
  /**
   * `Tx.run`'s `approve`, per batch, with the batch it is about to fold.
   *
   * @since 0.5.0
   */
  readonly approve?: (prepared: Prepared, batch: FoldBatch) => Effect.Effect<void, E>
}): Effect.fn.Return<FoldResult, RunError | E, Sui> {
  // Every batch, not only the plan: `fold(batch)` deposits into
  // `batch.owner`, so a plan that names the signer with a batch that names
  // someone else would send the signer's coins to that address balance.
  const signerAddress = normalizeSuiAddress(opts.signer.address)
  const foreign = opts.plan === undefined
    ? undefined
    : [opts.plan.owner, ...opts.plan.batches.map((batch) => batch.owner)]
      .find((owner) => normalizeSuiAddress(owner) !== signerAddress)
  if (foreign !== undefined) {
    return yield* new BuildError({
      message: `this fold plan is for ${foreign}'s coins, and the signer is ${opts.signer.address}`,
      cause: foreign
    })
  }
  const plan = opts.plan ?? (yield* planFold({
    owner: opts.signer.address,
    ...(opts.coinType === undefined ? {} : { coinType: opts.coinType }),
    ...(opts.maxCoinsPerTransaction === undefined ? {} : { maxCoinsPerTransaction: opts.maxCoinsPerTransaction })
  }))
  const approve = opts.approve
  const executed: Array<Executed> = []
  for (const batch of plan.batches) {
    executed.push(
      yield* run(fold(batch), {
        signer: opts.signer,
        ...(approve === undefined ? {} : { approve: (prepared: Prepared) => approve(prepared, batch) })
      })
    )
  }
  return { plan, executed }
})

/**
 * The lifecycle, namespaced the way the spec spells it: `Tx.build`, `Tx.sign`,
 * `Tx.cosign`, `Tx.fromBytes`, `Tx.attach`, `Tx.sponsored`,
 * `Tx.gaslessStablecoinTransfer`, `Tx.sendFunds`, `Tx.planFold`, `Tx.fold`,
 * `Tx.foldCoins`, `Tx.verifySponsored`, `Tx.submit`, `Tx.submitVia`,
 * `Tx.reconcile`, `Tx.resubmit`, `Tx.run`, `Tx.reconcileAll`.
 */
export const Tx = {
  build,
  sign,
  cosign,
  fromBytes,
  attach,
  sponsored,
  gaslessStablecoinTransfer,
  sendFunds,
  planFold,
  fold,
  foldCoins,
  verifySponsored,
  submit,
  submitVia,
  reconcile,
  resubmit,
  run,
  reconcileAll
} as const
