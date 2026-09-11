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
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { normalizeSuiAddress } from "@mysten/sui/utils"

/** The shape `Transaction#setExpiration` accepts, which the SDK does not export. */
type SdkExpiration = NonNullable<Parameters<Transaction["setExpiration"]>[0]>
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Random,
  Schema
} from "effect"
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
import { EXECUTE_INCLUDE, Executed, fromTransactionResult } from "../domain/executed.ts"
import { isUnresolved, JournalEntry } from "../domain/journal-entry.ts"
import {
  Built,
  Digest,
  maxEpochOf,
  maxTimestampMsOf,
  ObjectId,
  type Signature,
  SignedTransaction,
  SuiAddress,
  TransactionExpiration,
  Version
} from "../domain/schemas.ts"
import { Journal } from "./Journal.ts"
import type { Signer } from "./Signer.ts"
import type { SubmitConfigService } from "./SubmitConfig.ts"
import { SubmitConfig } from "./SubmitConfig.ts"
import type { Recipe } from "./Sui.ts"
import { Sui } from "./Sui.ts"

/** A transaction built into bytes, with the expiration the builder settled on. */
export type { Built } from "../domain/schemas.ts"

/** Signed bytes: everything `executeTransaction` needs, plus what `reconcile` needs. */
export type Signed = SignedTransaction
/** The schema of {@link Signed}. */
export const Signed = SignedTransaction

/** What `Tx.reconcile` can be asked about. */
export type ReconcileInput = Digest | Signed | SubmissionUnknown

/**
 * Everything {@link submit} can fail with, as one name.
 *
 * An extension that wraps a submission spells its own errors plus this, rather
 * than repeating four tags that will grow with the taxonomy.
 */
export type SubmitError =
  | ExecutionFailed
  | NotApplied
  | SubmissionUnknown
  | JournalError

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

/** What one entry of `Tx.reconcileAll` settled to. */
export type Reconciled = Executed | ExecutionFailed | NotApplied | SubmissionUnknown

const decodeExpiration = Schema.decodeUnknownOption(TransactionExpiration)
const decodeDigest = Schema.decodeUnknownEffect(Digest)
const decodeVersion = Schema.decodeUnknownOption(Version)
const decodeObjectId = Schema.decodeUnknownOption(ObjectId)

const buildError = (message: string) => (cause: unknown): BuildError =>
  new BuildError({ message, cause })

/** The `u32` nonce a `ValidDuring` expiration carries as its replay guard. */
const MAX_NONCE = 0xffff_ffff

/**
 * The expiration a transaction was built with, read back out of the bytes so
 * that what is recorded is what was signed rather than what was intended.
 */
const expirationOfBytes = (bytes: Uint8Array): TransactionExpiration | undefined => {
  try {
    const data = TransactionDataBuilder.fromBytes(bytes)
    if (data.expiration === null) return undefined
    const decoded = decodeExpiration(data.expiration)
    return decoded._tag === "Some" ? decoded.value : undefined
  } catch {
    return undefined
  }
}

/** The owned object inputs a transaction referenced, with the versions it pinned. */
const ownedInputsOfBytes = (
  bytes: Uint8Array
): ReadonlyArray<{ readonly objectId: string; readonly version: Version }> => {
  try {
    const data = TransactionDataBuilder.fromBytes(bytes)
    const inputs: Array<{ objectId: string; version: Version }> = []
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
  } catch {
    return []
  }
}

/**
 * The gas coins a transaction pinned, which are owned inputs too: a sponsored
 * transaction pays from an address balance and has none, but an ordinary one
 * names its coins in `gasData.payment` rather than in `inputs`, and a coin that
 * has moved on is exactly as good evidence as any other consumed input.
 */
const gasPaymentOfBytes = (
  bytes: Uint8Array
): ReadonlyArray<{ readonly objectId: string; readonly version: Version }> => {
  try {
    const payment = TransactionDataBuilder.fromBytes(bytes).gasData.payment ?? []
    const refs: Array<{ objectId: string; version: Version }> = []
    for (const ref of payment) {
      const version = decodeVersion(String(ref.version))
      if (version._tag === "Some") refs.push({ objectId: ref.objectId, version: version.value })
    }
    return refs
  } catch {
    return []
  }
}

/** Every object reference whose version these bytes pinned, inputs and gas alike. */
const pinnedRefsOfBytes = (
  bytes: Uint8Array
): ReadonlyArray<{ readonly objectId: string; readonly version: Version }> => [
  ...ownedInputsOfBytes(bytes),
  ...gasPaymentOfBytes(bytes)
]

/** The addresses a transaction's bytes will accept a signature from. */
const signersOfBytes = (bytes: Uint8Array): ReadonlyArray<string> => {
  try {
    const data = TransactionDataBuilder.fromBytes(bytes)
    return [data.sender, data.gasData.owner]
      .filter((address): address is string => typeof address === "string" && address.length > 0)
      .map((address) => normalizeSuiAddress(address))
  } catch {
    return []
  }
}

const gasBudgetOfBytes = (bytes: Uint8Array): bigint | undefined => {
  try {
    const budget = TransactionDataBuilder.fromBytes(bytes).gasData.budget
    return budget === null || budget === undefined ? undefined : BigInt(budget)
  } catch {
    return undefined
  }
}

/** A timeout on an execute is a transport failure that may already have landed. */
const timeoutAsTransport = (method: string) => (error: TransportError | Cause.TimeoutError): TransportError =>
  error._tag === "TimeoutError"
    ? new TransportError({
      method,
      retryable: true,
      status: "DEADLINE_EXCEEDED",
      cause: error
    })
    : error

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
 * Building already simulates: on gRPC the SDK's resolve plugin simulates with
 * checks enabled to choose the gas budget, and an execution failure there
 * arrives as `SimulationFailed`. So simulate-before-submit is inherent and
 * costs nothing extra.
 *
 * When the recipe set no expiration, `SubmitConfig.expiration` decides one.
 * The default, `ValidDuring`, bounds the transaction at `chainTime` plus
 * `SubmitConfig.validFor`, names the chain (bytes signed for testnet cannot
 * land on mainnet) and carries a random nonce. The expiration that ends up in
 * the bytes is recorded on the result, because it is what `Tx.reconcile` needs
 * later to prove a transaction can no longer land.
 *
 * `Tx.build` takes no sender lock; `Tx.run` is what holds one from build
 * through submit. Called on its own, two concurrent builds for one address can
 * pick the same gas coin.
 *
 * Fails with: `BuildError` (the recipe threw, an input could not be resolved,
 * or the budget the node chose is over `SubmitConfig.maxGasBudget`),
 * `SimulationFailed` (the transaction would abort on chain),
 * `TransportError`.
 */
export const build = Effect.fn("Tx.build")(function*(
  input: Recipe | Transaction,
  opts: { readonly sender: SuiAddress; readonly gasOwner?: SuiAddress }
): Effect.fn.Return<Built, BuildError | SimulationFailed | TransportError, Sui> {
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

  if (tx.getData().expiration == null) {
    const expiration = yield* defaultExpiration(sui, config)
    if (expiration !== undefined) {
      yield* Effect.try({
        try: () => tx.setExpiration(expiration),
        catch: buildError("the transaction rejected its expiration")
      })
    }
  }

  const bytes = yield* sui.core.use((client) => tx.build({ client })).pipe(
    Effect.catchTag(
      ["ObjectNotFound", "ObjectDeleted", "ObjectUnavailable", "TransactionNotFound"],
      (error) =>
        Effect.fail(
          new BuildError({ message: `an input could not be resolved: ${SuiError.describe(error)}`, cause: error })
        )
    )
  )

  const budget = gasBudgetOfBytes(bytes)
  if (budget !== undefined && budget > config.maxGasBudget) {
    return yield* new BuildError({
      message: `the gas budget ${budget} is over the configured maximum ${config.maxGasBudget}`,
      cause: budget
    })
  }

  const digest = yield* decodeDigest(TransactionDataBuilder.getDigestFromBytes(bytes)).pipe(
    Effect.mapError((issue) =>
      new BuildError({ message: `the built bytes have no readable digest: ${issue.message}`, cause: issue })
    )
  )
  const expiration = expirationOfBytes(bytes)
  return {
    digest,
    bytes,
    sender: opts.sender,
    ...(opts.gasOwner === undefined ? {} : { gasOwner: opts.gasOwner }),
    ...(expiration === undefined ? {} : { expiration })
  }
})

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

/** The expiration `Tx.build` sets when the recipe set none. */
const defaultExpiration = Effect.fn("Tx.defaultExpiration")(function*(
  sui: Sui["Service"],
  config: SubmitConfigService
): Effect.fn.Return<SdkExpiration | undefined, TransportError> {
  switch (config.expiration) {
    case "none":
      return undefined
    case "epoch": {
      const { systemState } = yield* sui.core.getCurrentSystemState()
      return { Epoch: systemState.epoch }
    }
    case "validDuring": {
      const { systemState } = yield* sui.core.getCurrentSystemState()
      const epoch = yield* epochOf(systemState.epoch)
      const nonce = yield* Random.nextIntBetween(0, MAX_NONCE)
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
          maxEpoch: (epoch + 1n).toString(),
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
 * Fails with: `SigningError`.
 */
export const sign = Effect.fn("Tx.sign")(function*(
  built: Built,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
  yield* assertSignerAddress(built.bytes, signer)
  const signature = yield* signer.signTransaction(built.bytes)
  return {
    digest: built.digest,
    bytes: built.bytes,
    signatures: [signature],
    sender: built.sender,
    ...(built.expiration === undefined ? {} : { expiration: built.expiration })
  }
})

/**
 * Adds one more signature to already signed bytes, for a sponsored or
 * multi-party transaction. The bytes are untouched, so both parties sign
 * exactly the same transaction.
 *
 * As in {@link sign}, the co-signer's address must be the sender or the gas
 * owner named in the bytes.
 *
 * Fails with: `SigningError`.
 */
export const cosign = Effect.fn("Tx.cosign")(function*(
  signed: Signed,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
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

const journalSigned = Effect.fn("Tx.journalSigned")(function*(signed: Signed) {
  const journal = yield* Journal
  const now = yield* DateTime.now
  yield* journal.put(
    JournalEntry.cases.Signed.make({ _tag: "Signed", digest: signed.digest, signed, signedAt: now })
  )
})

const journalOutcome = Effect.fn("Tx.journalOutcome")(function*(
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

const executedEntry = Effect.fn("Tx.executedEntry")(function*(executed: Executed) {
  const now = yield* DateTime.now
  return JournalEntry.cases.Executed.make({
    _tag: "Executed",
    digest: executed.digest,
    ...(executed.checkpoint === null ? {} : { checkpoint: executed.checkpoint }),
    at: now
  })
})

const failedEntry = Effect.fn("Tx.failedEntry")(function*(error: ExecutionFailed) {
  const now = yield* DateTime.now
  return JournalEntry.cases.Failed.make({
    _tag: "Failed",
    digest: error.digest,
    reason: error.reason,
    at: now
  })
})

const notAppliedEntry = Effect.fn("Tx.notAppliedEntry")(function*(error: NotApplied) {
  const now = yield* DateTime.now
  return JournalEntry.cases.NotApplied.make({
    _tag: "NotApplied",
    digest: error.digest,
    evidence: error.evidence,
    at: now
  })
})

const unknownEntry = Effect.fn("Tx.unknownEntry")(function*(
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
 * `TransportError` never escapes: once bytes may have been sent, "the network
 * was unreachable" is not an answer a caller can act on, so it becomes
 * `SubmissionUnknown` carrying the signed bytes.
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
 * first send).
 */
export const submit: (signed: Signed) => Effect.Effect<Executed, SubmitError, Sui> = Effect.fn(
  "Tx.submit"
)(function*(
  signed: Signed
): Effect.fn.Return<
  Executed,
  ExecutionFailed | NotApplied | SubmissionUnknown | JournalError,
  Sui
> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  yield* journalSigned(signed)

  let attempts = 0
  const once = Effect.suspend(() => {
    attempts += 1
    return sui.core.executeTransaction({
      transaction: signed.bytes,
      signatures: [...signed.signatures],
      include: EXECUTE_INCLUDE
    }).pipe(
      Effect.timeout(config.executeTimeout),
      Effect.mapError(timeoutAsTransport("executeTransaction"))
    )
  })

  const result = yield* once.pipe(
    Effect.retry({
      schedule: config.resubmit,
      times: Math.max(config.resubmitAttempts - 1, 0),
      while: (error: TransportError) => error.retryable
    }),
    Effect.flatMap(fromTransactionResult),
    Effect.catchTag("DecodeError", (error) =>
      Effect.fail(
        new TransportError({ method: "executeTransaction", retryable: false, cause: error })
      )),
    Effect.result
  )

  if (result._tag === "Success") {
    yield* journalSettled(yield* executedEntry(result.success))
    return result.success
  }
  const failure = result.failure
  if (failure._tag === "ExecutionFailed") {
    yield* journalSettled(yield* failedEntry(failure))
    return yield* failure
  }
  // Bytes may have reached the network: the only honest next step is to ask.
  return yield* reconcileSigned(signed, failure, attempts)
})

/** `reconcile` plus the journal bookkeeping `submit` owes after it. */
const reconcileSigned = Effect.fn("Tx.reconcileSigned")(function*(
  signed: Signed,
  lastError: TransportError,
  attempts: number
): Effect.fn.Return<
  Executed,
  ExecutionFailed | NotApplied | SubmissionUnknown | JournalError,
  Sui
> {
  const settled = yield* Effect.result(reconcile(signed))
  if (settled._tag === "Success") {
    yield* journalSettled(yield* executedEntry(settled.success))
    return settled.success
  }
  const failure = settled.failure
  switch (failure._tag) {
    case "ExecutionFailed":
      yield* journalSettled(yield* failedEntry(failure))
      return yield* failure
    case "NotApplied":
      // Terminal: the transaction was proven never to have applied, so the
      // journal records that rather than leaving an `Unknown` nothing will
      // ever settle.
      yield* journalSettled(yield* notAppliedEntry(failure))
      return yield* failure
    default: {
      const unknown = failure._tag === "SubmissionUnknown"
        ? failure
        : new SubmissionUnknown({ digest: signed.digest, signed, cause: failure })
      yield* journalSettled(
        yield* unknownEntry(signed, SuiError.describe(lastError), attempts)
      )
      return yield* unknown
    }
  }
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
const inputStateOf = Effect.fn("Tx.inputStateOf")(function*(
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
  | { readonly _tag: "Unreadable"; readonly objectId: string }

/**
 * Reads every object the bytes pinned — owned inputs and gas coins alike — and
 * says what their current state proves.
 *
 * A version that has not moved proves nothing and the next reference is tried.
 * A version that has moved (or an object that is gone) is only evidence once
 * the node names the transaction that moved it:
 *
 * - a **different** digest means those exact bytes can never execute again, and
 *   that is the one thing `NotApplied { inputConsumed }` may be built on;
 * - **our own** digest means the transaction applied, whatever the read replica
 *   that answered `getTransaction` thought;
 * - **no readable digest** — a deleted object, a node that does not serve the
 *   field — proves nothing either way, and the honest answer is that the
 *   outcome is unknown.
 *
 * Fails with: `TransportError`.
 */
const inputEvidence = Effect.fn("Tx.inputEvidence")(function*(
  sui: Sui["Service"],
  digest: Digest,
  signed: Signed
): Effect.fn.Return<InputEvidence, TransportError> {
  for (const pinned of pinnedRefsOfBytes(signed.bytes)) {
    const decoded = decodeObjectId(pinned.objectId)
    if (decoded._tag !== "Some") continue
    const state = yield* inputStateOf(sui, decoded.value)
    if (state._tag === "Present" && state.version <= pinned.version) continue
    const previous = state._tag === "Present" ? state.previousTransaction : undefined
    if (previous === undefined) return { _tag: "Unreadable", objectId: decoded.value }
    if (previous === digest) return { _tag: "AppliedByUs", objectId: decoded.value }
    return { _tag: "ConsumedByOther", objectId: decoded.value, by: previous }
  }
  return { _tag: "NoEvidence" }
})

/**
 * Finds out what happened to a transaction that was sent but never answered
 * for.
 *
 * A transaction the node knows is `Executed`, or `ExecutionFailed` when it
 * applied and aborted. A transaction the node does not know is only ever
 * `NotApplied` on evidence:
 *
 * - `"expired"` when the current epoch is past the `maxEpoch` recorded in the
 *   signed bytes, or when `chainTime` has passed a recorded `maxTimestamp` by
 *   more than `SubmitConfig.expiryMargin`. The epoch rule is the one that
 *   fires in practice, because the default expiration is epoch-bounded; it
 *   needs no margin, an epoch being a consensus fact rather than a reading of
 *   a clock, and costs one `getCurrentSystemState` read;
 * - `"inputConsumed"` when an owned input or a gas coin the transaction pinned
 *   has moved on **and the node names a different transaction** as the one that
 *   moved it, so those exact bytes can never execute again.
 *
 * An input that merely advanced is not evidence: the transaction being
 * reconciled is itself the likeliest thing to have advanced it, and calling
 * that `NotApplied` would tell the documented retry idiom to execute the
 * caller's intent a second time. When the node names *our* digest the
 * transaction applied and `getTransaction` is asked again; when it names
 * nothing at all the answer is `SubmissionUnknown`, which carries the bytes so
 * a later process, or a person, can settle it.
 *
 * Given only a `Digest` there can be no evidence, so an unknown transaction is
 * always `SubmissionUnknown`. Pass the `Signed` bytes (or the
 * `SubmissionUnknown` that carries them) to get the evidence rules.
 *
 * Fails with: `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`,
 * `TransportError`.
 */
export const reconcile = Effect.fn("Tx.reconcile")(function*(
  input: ReconcileInput
): Effect.fn.Return<
  Executed,
  ExecutionFailed | NotApplied | SubmissionUnknown | TransportError,
  Sui
> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const { digest, signed } = inputOf(input)

  const found = yield* Effect.result(sui.getTransaction(digest))
  if (found._tag === "Success") return found.success
  if (found.failure._tag !== "TransactionNotFound") return yield* found.failure

  const unknown = (cause: unknown) =>
    new SubmissionUnknown({
      digest,
      // Absent when `reconcile` was given only a digest: there is then nothing
      // to re-send, and saying so is better than inventing empty bytes.
      ...(signed === undefined ? {} : { signed }),
      cause
    })

  if (signed === undefined) {
    return yield* unknown("the node does not know this digest and the signed bytes are not available")
  }

  // Epochs first: they are what the default expiration carries, and unlike a
  // wall clock an epoch is a consensus fact, so no skew margin is needed.
  const lastEpoch = maxEpochOf(signed.expiration)
  if (lastEpoch !== undefined) {
    const { systemState } = yield* sui.core.getCurrentSystemState()
    const epoch = yield* epochOf(systemState.epoch)
    if (epoch > lastEpoch) {
      return yield* new NotApplied({ digest, evidence: "expired" })
    }
  }

  const bound = maxTimestampMsOf(signed.expiration)
  if (bound !== undefined) {
    const now = yield* sui.chainTime
    const margin = BigInt(Duration.toMillis(config.expiryMargin))
    if (BigInt(DateTime.toEpochMillis(now)) > bound + margin) {
      return yield* new NotApplied({ digest, evidence: "expired" })
    }
  }

  const evidence = yield* inputEvidence(sui, digest, signed)
  switch (evidence._tag) {
    case "ConsumedByOther":
      return yield* new NotApplied({ digest, evidence: "inputConsumed" })
    case "AppliedByUs": {
      // The node named this very transaction as the one that last moved the
      // input, so it applied; the `getTransaction` above was answered by a
      // node that had not caught up. Ask once more for the receipt.
      const again = yield* Effect.result(sui.getTransaction(digest))
      if (again._tag === "Success") return again.success
      if (again.failure._tag !== "TransactionNotFound") return yield* again.failure
      return yield* unknown(
        `object ${evidence.objectId} names this transaction as the one that last mutated it,` +
          " so it applied, but the node still does not serve it"
      )
    }
    case "Unreadable":
      return yield* unknown(
        `object ${evidence.objectId} has moved on or is gone, but the node did not say which` +
          " transaction consumed it, so nothing is proven"
      )
    case "NoEvidence":
      return yield* unknown(
        "the node does not know this digest and nothing proves it cannot land"
      )
  }
})

/**
 * Build, preflight, sign and submit, with the sender lock held throughout.
 *
 * Gas coins are chosen during build, so two transactions from one address that
 * overlap can pick the same coin and one of them will fail on chain. `Tx.run`
 * holds the sender lock from build through submit, which is the whole reason to
 * prefer it over calling the steps separately.
 *
 * The address that matters is the one whose coins are being spent, which is the
 * **gas owner** when there is one: two sponsored runs for different senders
 * paid by one sponsor are exactly the case that picks the same coin twice. When
 * sender and gas owner differ, both locks are held, in ascending address order
 * — a fixed order, so two runs that each need the same pair cannot deadlock by
 * taking them the other way round.
 *
 * When `SubmitConfig.preflight` is set it costs one extra simulate, and is
 * where spend limits and target policies refuse a transaction before anything
 * is signed.
 *
 * Fails with: `BuildError`, `SimulationFailed`, `PolicyDenied`, `SigningError`,
 * `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, `JournalError`,
 * `TransportError` (from the build reads; once bytes are sent, transport
 * failures become `SubmissionUnknown`).
 */
export const run = Effect.fn("Tx.run")(function*(
  recipe: Recipe | Transaction,
  opts: { readonly signer: Signer; readonly gasOwner?: SuiAddress }
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
  | TransportError,
  Sui
> {
  const sui = yield* Sui
  const config = yield* SubmitConfig
  const sender = opts.signer.address
  const locked = opts.gasOwner === undefined || opts.gasOwner === sender
    ? [sender]
    : [sender, opts.gasOwner].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))

  const body = Effect.gen(function*() {
    const built = yield* build(recipe, {
      sender,
      ...(opts.gasOwner === undefined ? {} : { gasOwner: opts.gasOwner })
    })
    const preflight = config.preflight
    if (preflight !== undefined) {
      const simulation = yield* sui.simulate(built.bytes)
      yield* preflight(simulation)
    }
    return yield* submit(yield* sign(built, opts.signer))
  })

  return yield* config.lockSender
    ? locked.reduceRight<typeof body>(
      (inner, address) => sui.withSenderLock(address)(inner),
      body
    )
    : body
})

/**
 * Settles every unresolved entry in the journal: the explicit startup call a
 * long-lived application makes after building a durable `Journal`.
 *
 * Nothing here fails per entry: each one settles to an `Executed`, an
 * `ExecutionFailed`, a `NotApplied` or a `SubmissionUnknown`, in the order the
 * journal listed them, and the journal is updated to match. Every settled entry
 * gets the same evidence rules `Tx.reconcile` applies, including the
 * `previousTransaction` guard, so a startup never reports a transaction that
 * applied as `NotApplied`.
 *
 * The whole call fails only if the journal itself cannot be **read**: a write
 * that fails after an entry has been settled is logged and the answer stands,
 * the same rule `Tx.submit` follows.
 *
 * Fails with: `JournalError`, `TransportError`.
 */
export const reconcileAll = Effect.fn("Tx.reconcileAll")(function*(): Effect.fn.Return<
  ReadonlyArray<Reconciled>,
  JournalError | TransportError,
  Sui
> {
  const journal = yield* Journal
  const entries = yield* journal.listUnresolved
  const settled: Array<Reconciled> = []
  for (const entry of entries) {
    if (!isUnresolved(entry)) continue
    const attempts = entry._tag === "Unknown" ? entry.attempts : 1
    const result = yield* Effect.result(reconcile(entry.signed))
    if (result._tag === "Success") {
      yield* journalSettled(yield* executedEntry(result.success))
      settled.push(result.success)
      continue
    }
    const failure = result.failure
    switch (failure._tag) {
      case "ExecutionFailed":
        yield* journalSettled(yield* failedEntry(failure))
        settled.push(failure)
        break
      case "TransportError":
        return yield* failure
      case "NotApplied":
        // Terminal, so the entry leaves the unresolved index: without this a
        // durable journal would hold a proven-dead submission forever and
        // `onUnresolved: "fail"` would refuse to build for the life of it.
        yield* journalSettled(yield* notAppliedEntry(failure))
        settled.push(failure)
        break
      default:
        yield* journalSettled(
          yield* unknownEntry(entry.signed, SuiError.describe(failure), attempts)
        )
        settled.push(failure)
        break
    }
  }
  return settled
})

/**
 * The lifecycle, namespaced the way the spec spells it: `Tx.build`, `Tx.sign`,
 * `Tx.cosign`, `Tx.sponsored`, `Tx.submit`, `Tx.reconcile`, `Tx.run`,
 * `Tx.reconcileAll`.
 */
export const Tx = {
  build,
  sign,
  cosign,
  sponsored,
  submit,
  reconcile,
  run,
  reconcileAll
} as const
