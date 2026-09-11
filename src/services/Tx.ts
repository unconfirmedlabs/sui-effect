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

/** The shape `Transaction#setExpiration` accepts, which the SDK does not export. */
type SdkExpiration = NonNullable<Parameters<Transaction["setExpiration"]>[0]>
import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Option,
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
      const now = yield* sui.chainTime
      const nonce = yield* Random.nextIntBetween(0, MAX_NONCE)
      const maxTimestamp = BigInt(DateTime.toEpochMillis(now)) +
        BigInt(Duration.toMillis(config.validFor))
      return {
        ValidDuring: {
          minEpoch: null,
          maxEpoch: null,
          minTimestamp: null,
          maxTimestamp: maxTimestamp.toString(),
          chain: sui.chainId,
          nonce
        }
      }
    }
  }
})

/**
 * Signs built bytes.
 *
 * Fails with: `SigningError`.
 */
export const sign = Effect.fn("Tx.sign")(function*(
  built: Built,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
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
 * Fails with: `SigningError`.
 */
export const cosign = Effect.fn("Tx.cosign")(function*(
  signed: Signed,
  signer: Signer
): Effect.fn.Return<Signed, SigningError> {
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
 * Fails with: `ExecutionFailed` (applied on chain and failed; gas was charged),
 * `NotApplied` (provably never applied), `SubmissionUnknown` (the outcome is
 * not known and the bytes are in the error), `JournalError`.
 */
export const submit = Effect.fn("Tx.submit")(function*(
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
    yield* journalOutcome(yield* executedEntry(result.success))
    return result.success
  }
  const failure = result.failure
  if (failure._tag === "ExecutionFailed") {
    yield* journalOutcome(yield* failedEntry(failure))
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
    yield* journalOutcome(yield* executedEntry(settled.success))
    return settled.success
  }
  const failure = settled.failure
  switch (failure._tag) {
    case "ExecutionFailed":
      yield* journalOutcome(yield* failedEntry(failure))
      return yield* failure
    case "NotApplied":
      yield* journalOutcome(
        yield* unknownEntry(signed, SuiError.describe(failure), attempts)
      )
      return yield* failure
    default: {
      const unknown = failure._tag === "SubmissionUnknown"
        ? failure
        : new SubmissionUnknown({ digest: signed.digest, signed, cause: failure })
      yield* journalOutcome(
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

/**
 * Finds out what happened to a transaction that was sent but never answered
 * for.
 *
 * A transaction the node knows is `Executed`, or `ExecutionFailed` when it
 * applied and aborted. A transaction the node does not know is only ever
 * `NotApplied` on evidence: `"expired"` when `chainTime` has passed the
 * expiration recorded in the signed bytes by more than
 * `SubmitConfig.expiryMargin`, or `"inputConsumed"` when an owned input the
 * transaction pinned has moved on to a later version (or is gone), so those
 * exact bytes can never execute again. Absent evidence the answer is
 * `SubmissionUnknown`, which carries the bytes so a later process, or a person,
 * can settle it.
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

  const bound = maxTimestampMsOf(signed.expiration)
  if (bound !== undefined) {
    const now = yield* sui.chainTime
    const margin = BigInt(Duration.toMillis(config.expiryMargin))
    if (BigInt(DateTime.toEpochMillis(now)) > bound + margin) {
      return yield* new NotApplied({ digest, evidence: "expired" })
    }
  }

  for (const owned of ownedInputsOfBytes(signed.bytes)) {
    const decoded = decodeObjectId(owned.objectId)
    if (decoded._tag !== "Some") continue
    const id = decoded.value
    const current = yield* sui.getObjectOption(id).pipe(
      Effect.catchTag("ObjectUnavailable", () => Effect.succeed(Option.none())),
      Effect.catchTag("DecodeError", (error) =>
        Effect.fail(new TransportError({ method: "getObject", retryable: false, cause: error })))
    )
    if (Option.isNone(current) || current.value.version > owned.version) {
      return yield* new NotApplied({ digest, evidence: "inputConsumed" })
    }
  }

  return yield* unknown("the node does not know this digest and nothing proves it cannot land")
})

/**
 * Build, preflight, sign and submit, with the sender lock held throughout.
 *
 * Gas coins are chosen during build, so two transactions from one address that
 * overlap can pick the same coin and one of them will fail on chain. `Tx.run`
 * holds `sui.withSenderLock(sender)` from build through submit, which is the
 * whole reason to prefer it over calling the steps separately.
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

  return yield* config.lockSender ? sui.withSenderLock(sender)(body) : body
})

/**
 * Settles every unresolved entry in the journal: the explicit startup call a
 * long-lived application makes after building a durable `Journal`.
 *
 * Nothing here fails per entry: each one settles to an `Executed`, an
 * `ExecutionFailed`, a `NotApplied` or a `SubmissionUnknown`, in the order the
 * journal listed them, and the journal is updated to match. The whole call
 * fails only if the journal itself cannot be read or written.
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
      yield* journalOutcome(yield* executedEntry(result.success))
      settled.push(result.success)
      continue
    }
    const failure = result.failure
    switch (failure._tag) {
      case "ExecutionFailed":
        yield* journalOutcome(yield* failedEntry(failure))
        settled.push(failure)
        break
      case "TransportError":
        return yield* failure
      default:
        yield* journalOutcome(
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
