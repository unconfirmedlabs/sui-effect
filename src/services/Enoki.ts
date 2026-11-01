/**
 * Enoki, structurally: its zkLogin sessions as `Signer`s, and its sponsored
 * transactions through the journal.
 *
 * Nothing here imports `@mysten/enoki`. The members read are the ones
 * `@mysten/enoki` 1.3.2 declares (`EnokiClient.createSponsoredTransaction`,
 * `EnokiClient.executeSponsoredTransaction`, `EnokiFlow.getSession`,
 * `EnokiFlow.getKeypair`, the `enoki:getSession` wallet feature), so an
 * application passes its own Enoki objects and this subpath loads without
 * Enoki installed.
 *
 * @since 0.5.0
 */
import type { Signer as SdkSigner } from "@mysten/sui/cryptography"
import { Transaction } from "@mysten/sui/transactions"
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { Effect, Schema } from "effect"
import type { Executed } from "../domain/executed.ts"
import { BuildError, PolicyDenied, SigningError, TransportError } from "../domain/errors.ts"
import type { Built } from "../domain/schemas.ts"
import { SuiAddress } from "../domain/schemas.ts"
import type { SignatureScheme } from "@mysten/sui/cryptography"
import { type StandardWallet, type StandardWalletAccount, wallet as walletSigner } from "./AccountSigners.ts"
import type { Signer } from "./Signer.ts"
import { verifySponsored } from "./Sponsored.ts"
import { type Recipe, Sui } from "./Sui.ts"
import { fromBytes, type Signed, submitVia, type SubmitViaError } from "./Tx.ts"
import { checkSessionBound, signatureOfString } from "./ZkLoginSigner.ts"

/**
 * The two `EnokiClient` methods sponsorship uses, as `@mysten/enoki` 1.3.2
 * declares them (the input of `createSponsoredTransaction` narrowed to the
 * `sender` form, plus `jwt`).
 *
 * @since 0.5.0
 */
export interface EnokiClient {
  readonly createSponsoredTransaction: (
    input:
      & { readonly network?: "mainnet" | "testnet" | "devnet"; readonly transactionKindBytes: string }
      & (
        | {
          readonly jwt: string
          readonly sender?: never
          readonly allowedAddresses?: never
          readonly allowedMoveCallTargets?: never
        }
        | {
          readonly sender: string
          readonly allowedAddresses?: Array<string>
          readonly allowedMoveCallTargets?: Array<string>
          readonly jwt?: never
        }
      )
  ) => Promise<{ readonly bytes: string; readonly digest: string }>
  readonly executeSponsoredTransaction: (input: {
    readonly digest: string
    readonly signature: string
  }) => Promise<{ readonly digest: string }>
}

/**
 * The two `EnokiFlow` methods {@link fromFlow} uses. `EnokiFlow` is deprecated
 * in `@mysten/enoki` 1.x in favour of `registerEnokiWallets`, whose wallets
 * {@link fromWallet} reads; both are supported.
 *
 * @since 0.5.0
 */
export interface EnokiFlow {
  readonly getSession: () => Promise<{ readonly maxEpoch: number; readonly expiresAt: number } | null>
  readonly getKeypair: (input?: { readonly network?: "mainnet" | "testnet" | "devnet" }) => Promise<SdkSigner>
}

/**
 * Enoki refused a request: an HTTP 4xx from the Enoki API, or a refusal the
 * caller's `refused` predicate recognised. `refused: true` is the claim that
 * nothing was submitted, which makes the outcome `not_applied`; any other
 * failure of the execute call is ambiguous, is reconciled by `Tx.submitVia`,
 * and only ever surfaces as the `cause` of a `SubmissionUnknown`.
 *
 * @since 0.5.0
 */
export class EnokiError extends Schema.TaggedError<EnokiError>()("EnokiError", {
  method: Schema.String,
  status: Schema.optionalKey(Schema.Number),
  code: Schema.optionalKey(Schema.String),
  refused: Schema.Boolean,
  cause: Schema.Defect()
}) {
  /** `not_applied` for a refusal; `unknown` otherwise. */
  get outcome(): "not_applied" | "unknown" {
    return this.refused ? "not_applied" : "unknown"
  }
  override get message(): string {
    const status = this.status === undefined ? "" : ` (${this.status}${this.code === undefined ? "" : ` ${this.code}`})`
    const detail = (this.cause as { readonly message?: unknown } | undefined)?.message
    return `Enoki ${this.refused ? "refused" : "failed"} ${this.method}${status}` +
      (typeof detail === "string" && detail.length > 0 ? `: ${detail}` : "")
  }
}

const statusOf = (cause: unknown): { readonly status?: number; readonly code?: string } => {
  const record = typeof cause === "object" && cause !== null ? cause as Record<string, unknown> : {}
  return {
    ...(typeof record["status"] === "number" ? { status: record["status"] } : {}),
    ...(typeof record["code"] === "string" ? { code: record["code"] } : {})
  }
}

/** An HTTP 4xx that is an answer, not a transport failure: not 408, not 429. */
const isClientRefusal = (cause: unknown): boolean => {
  const { status } = statusOf(cause)
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
}

const enokiError = (method: string, cause: unknown, refused: boolean): EnokiError =>
  new EnokiError({ method, refused, cause, ...statusOf(cause) })

const sessionFailure = (cause: unknown): SigningError => {
  const message = String((cause as { readonly message?: unknown } | undefined)?.message ?? cause)
  return /expired/i.test(message)
    ? new SigningError({ reason: "expired", cause })
    : new SigningError({ reason: "unavailable", cause })
}

const bounded = (
  inner: Pick<Signer, "address" | "scheme" | "signTransaction" | "signPersonalMessage">,
  bound: { readonly maxEpoch: bigint; readonly expiresAt?: number }
): Signer => ({
  address: inner.address,
  scheme: inner.scheme,
  maxEpoch: bound.maxEpoch,
  signTransaction: (bytes) => Effect.andThen(checkSessionBound(bound, bytes), inner.signTransaction(bytes)),
  signPersonalMessage: (bytes) => Effect.andThen(checkSessionBound(bound, undefined), inner.signPersonalMessage(bytes))
})

/**
 * The signed-in `EnokiFlow` session as a `Signer`: `scheme: "ZkLogin"`,
 * `maxEpoch` and the expiry checks of `Signer.zkLogin`, signing with the
 * flow's own `EnokiKeypair` (`getKeypair`, which asks Enoki for the proof the
 * first time and caches it in the flow's store).
 *
 * The keypair and the session are read once, here: a session refreshed or
 * signed out later is a different signer, made again.
 *
 * Fails with: `SigningError` — `reason: "expired"` when the session or its
 * proof has expired, `reason: "unavailable"` when nobody is signed in or the
 * proof could not be fetched.
 *
 * @since 0.5.0
 */
export const fromFlow = Effect.fn("Enoki.fromFlow")(function*(
  flow: EnokiFlow,
  options?: { readonly network?: "mainnet" | "testnet" | "devnet" }
): Effect.fn.Return<Signer, SigningError> {
  const keypair = yield* Effect.tryPromise({
    try: () => flow.getKeypair(options?.network === undefined ? undefined : { network: options.network }),
    catch: sessionFailure
  })
  const session = yield* Effect.tryPromise({ try: () => flow.getSession(), catch: sessionFailure })
  if (session === null) {
    return yield* new SigningError({ reason: "unavailable", cause: "nobody is signed in to this EnokiFlow" })
  }
  const bound = { maxEpoch: BigInt(session.maxEpoch), expiresAt: session.expiresAt }
  yield* checkSessionBound(bound, undefined)
  return bounded({
    address: SuiAddress.make(normalizeSuiAddress(keypair.toSuiAddress())),
    scheme: "ZkLogin",
    signTransaction: Effect.fn("Enoki.signTransaction")(function*(bytes: Uint8Array) {
      const signed = yield* Effect.tryPromise({
        try: () => keypair.signTransaction(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* signatureOfString(signed.signature)
    }),
    signPersonalMessage: Effect.fn("Enoki.signPersonalMessage")(function*(bytes: Uint8Array) {
      const signed = yield* Effect.tryPromise({
        try: () => keypair.signPersonalMessage(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* signatureOfString(signed.signature)
    })
  }, bound)
})

/**
 * An Enoki wallet (from `registerEnokiWallets`) as a `Signer`: `Signer.wallet`
 * over its Wallet Standard features, plus the session bound its
 * `enoki:getSession` feature reports, so the signer carries `maxEpoch` and
 * refuses after it like `Signer.zkLogin`.
 *
 * Fails with: `SigningError` — everything `Signer.wallet` fails with,
 * `reason: "unavailable"` when the wallet has no `enoki:getSession` or nobody
 * is signed in, and `reason: "expired"` when the session has expired.
 *
 * @since 0.5.0
 */
export const fromWallet = Effect.fn("Enoki.fromWallet")(function*(options: {
  readonly wallet: StandardWallet
  readonly account: StandardWalletAccount
  readonly chain: string
  readonly scheme?: SignatureScheme
}): Effect.fn.Return<Signer, SigningError> {
  const feature = options.wallet.features["enoki:getSession"] as
    | { readonly getSession?: (input?: { readonly network?: string }) => Promise<unknown> }
    | undefined
  const getSession = feature?.getSession
  if (typeof getSession !== "function") {
    return yield* new SigningError({ reason: "unavailable", cause: "this wallet has no enoki:getSession feature" })
  }
  const network = options.chain.split(":")[1]
  const session = yield* Effect.tryPromise({
    try: () => getSession.call(feature, network === undefined ? undefined : { network }),
    catch: sessionFailure
  })
  const record = session as { readonly maxEpoch?: unknown; readonly expiresAt?: unknown } | null
  if (record === null || typeof record !== "object" || typeof record.maxEpoch !== "number") {
    return yield* new SigningError({ reason: "unavailable", cause: "nobody is signed in to this Enoki wallet" })
  }
  const bound = {
    maxEpoch: BigInt(record.maxEpoch),
    ...(typeof record.expiresAt === "number" ? { expiresAt: record.expiresAt } : {})
  }
  yield* checkSessionBound(bound, undefined)
  const inner = yield* walletSigner({ scheme: "ZkLogin", ...options })
  return bounded(inner, bound)
})

/**
 * Asks Enoki to sponsor a transaction, and answers its sponsored bytes as a
 * {@link Built} that has been checked: `Tx.fromBytes` (the chain), Enoki's
 * digest is the digest of its bytes, and `verifySponsored` (on `/tx`) — the sender is
 * `options.sender`, the gas owner is someone else, and the transaction kind is
 * **exactly** the kind that was sent.
 *
 * `transaction` is a recipe, built kind-only against the `Sui` in context (so
 * its object inputs are resolved), or kind bytes already built. Pass `jwt` to
 * let Enoki derive the sender from the session instead (Enoki's `jwt` form);
 * `sender` is still what the bytes are checked against.
 *
 * Then: `Tx.sign(built, signer)` (or `Tx.prepare` first, to simulate the
 * bytes), then {@link execute}.
 *
 * Fails with: `EnokiError` (`refused: true`: Enoki answered 4xx), `TransportError`
 * (Enoki could not be reached, answered 5xx or 429, or answered something
 * unreadable), `BuildError` (the recipe did not build, or the bytes are not a
 * transaction for this chain), `PolicyDenied` (`enoki.digest`,
 * `sponsored.sender`, `sponsored.gasOwner`, `sponsored.kind`).
 *
 * @since 0.5.0
 */
export const sponsor = Effect.fn("Enoki.sponsor")(function*(
  client: EnokiClient,
  transaction: Recipe | Uint8Array,
  options: {
    readonly sender: SuiAddress
    readonly network?: "mainnet" | "testnet" | "devnet"
    readonly jwt?: string
    readonly allowedAddresses?: ReadonlyArray<string>
    readonly allowedMoveCallTargets?: ReadonlyArray<string>
  }
): Effect.fn.Return<Built, EnokiError | TransportError | BuildError | PolicyDenied, Sui> {
  const sui = yield* Sui
  const kind = transaction instanceof Uint8Array ? transaction : yield* sui.core.use(async (client) => {
    const tx = new Transaction()
    transaction(tx)
    tx.setSenderIfNotSet(options.sender)
    return tx.build({ client, onlyTransactionKind: true })
  }).pipe(
    Effect.mapError((cause) =>
      new BuildError({ message: `the transaction kind did not build: ${cause.message}`, cause })
    )
  )
  const method = "Enoki.createSponsoredTransaction"
  const reply = yield* Effect.tryPromise({
    try: () =>
      client.createSponsoredTransaction({
        transactionKindBytes: toBase64(kind),
        ...(options.network === undefined ? {} : { network: options.network }),
        ...(options.jwt !== undefined
          ? { jwt: options.jwt }
          : {
            sender: options.sender,
            ...(options.allowedAddresses === undefined ? {} : { allowedAddresses: [...options.allowedAddresses] }),
            ...(options.allowedMoveCallTargets === undefined
              ? {}
              : { allowedMoveCallTargets: [...options.allowedMoveCallTargets] })
          })
      }),
    catch: (cause) => isClientRefusal(cause) ? enokiError(method, cause, true) : TransportError.fromUnknown(method, cause)
  })
  const bytes = yield* Effect.try({
    try: () => fromBase64(reply.bytes),
    catch: (cause) => TransportError.fromUnknown(method, cause, false)
  })
  const built = yield* fromBytes(bytes)
  if (built.digest !== reply.digest) {
    return yield* new PolicyDenied({
      rule: "enoki.digest",
      message: `Enoki answered digest ${reply.digest} for bytes whose digest is ${built.digest}`
    })
  }
  return yield* verifySponsored(built, { sender: options.sender, transactionKind: kind })
})

/**
 * Executes a sponsored transaction through Enoki's
 * `executeSponsoredTransaction`, **through the journal**: this is
 * `Tx.submitVia(signed, send)`, so the `Signed` entry is written before Enoki
 * is called, Enoki is called once, and its answer — a bare digest, never
 * effects — is settled by asking the chain for the digest of the bytes that
 * were signed. A failure that may have reached the chain is reconciled with the
 * full evidence rules and is `SubmissionUnknown` (carrying the bytes) when the
 * chain cannot say yet; `Tx.reconcileAll()` settles it later.
 *
 * The signature sent is `signed.signatures[0]`, the sender's: Enoki holds the
 * sponsor's.
 *
 * `refused` says which Enoki failures are refusals before anything was
 * submitted, which fail straight through as `EnokiError { refused: true }`
 * and settle the journal entry as `NotApplied { refused }`. The default is an
 * HTTP 401 or 403 (Enoki refused the API key or the session); every other
 * failure — a 400 included, since Enoki submits to a node and does not say
 * whether it got that far — is treated as ambiguous and reconciled.
 *
 * Fails with: `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`,
 * `JournalError` (only from the write before Enoki is called), and
 * `EnokiError` (only `refused: true`).
 *
 * @since 0.5.0
 */
export const execute = Effect.fn("Enoki.execute")(function*(
  client: EnokiClient,
  signed: Signed,
  options?: { readonly refused?: (cause: unknown) => boolean }
): Effect.fn.Return<Executed, SubmitViaError | EnokiError, Sui> {
  const refused = options?.refused ?? ((cause: unknown) => {
    const { status } = statusOf(cause)
    return status === 401 || status === 403
  })
  const method = "Enoki.executeSponsoredTransaction"
  return yield* submitVia(signed, (_bytes, signatures) =>
    Effect.tryPromise({
      try: () => client.executeSponsoredTransaction({ digest: signed.digest, signature: signatures[0] ?? "" }),
      catch: (cause) => enokiError(method, cause, refused(cause))
    }))
})

/**
 * The Enoki helpers, namespaced: `Enoki.fromFlow`, `Enoki.fromWallet`,
 * `Enoki.sponsor`, `Enoki.execute`.
 *
 * @since 0.5.0
 */
export const Enoki = {
  fromFlow,
  fromWallet,
  sponsor,
  execute
} as const
