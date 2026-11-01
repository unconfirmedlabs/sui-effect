/**
 * Account signers that are not keys this process holds: a passkey (WebAuthn,
 * the SDK's `PasskeyKeypair`) and an external wallet reached through the Wallet
 * Standard (`sui:signTransaction`, `sui:signPersonalMessage`).
 *
 * Both are `Signer` values like any other. Neither submits anything: the
 * library builds, simulates, journals and sends, and the account only signs the
 * exact bytes it was handed. That is what lets `Tx.submit`'s identical-bytes
 * resend and `Tx.reconcile` work for a wallet's signature exactly as for a key.
 *
 * Every Wallet Standard and WebAuthn type is reached **structurally**: nothing
 * here imports `@mysten/wallet-standard`, `@wallet-standard/*` or a DOM type,
 * so the module loads in a browser, React Native and a browser extension alike.
 *
 * @since 0.5.0
 */
import type { Signer as SdkSigner, SignatureScheme } from "@mysten/sui/cryptography"
import { SIGNATURE_FLAG_TO_SCHEME } from "@mysten/sui/cryptography"
import { Transaction } from "@mysten/sui/transactions"
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { publicKeyFromRawBytes, verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { Effect } from "effect"
import { SigningError } from "../domain/errors.ts"
import { SuiAddress } from "../domain/schemas.ts"
import type { Signer } from "./Signer.ts"
import { signatureOfString } from "./ZkLoginSigner.ts"

/**
 * What a passkey signer asks the authenticator for, structurally: the SDK's
 * `PasskeyProvider` from `@mysten/sui/keypairs/passkey` (its
 * `BrowserPasskeyProvider` is one) without the DOM types it is declared with,
 * so a React Native or extension provider can be typed without a DOM `lib`.
 * `create()` answers the `navigator.credentials.create()` credential (its
 * `rawId` and `response.getPublicKey()`), `get()` the
 * `navigator.credentials.get()` assertion for `challenge`.
 *
 * @since 0.5.0
 */
export interface PasskeyProvider {
  readonly create: () => Promise<{
    readonly rawId: ArrayBuffer
    readonly response: { readonly getPublicKey: () => ArrayBuffer | null }
  }>
  readonly get: (challenge: Uint8Array, credentialId?: Uint8Array) => Promise<{
    readonly response: {
      readonly authenticatorData: ArrayBuffer
      readonly clientDataJSON: ArrayBuffer
      readonly signature: ArrayBuffer
    }
  }>
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined

/**
 * Whether a thrown value is a person saying no, read structurally.
 *
 * WebAuthn rejects a cancelled (or timed-out) prompt with a `DOMException`
 * named `NotAllowedError`. Wallets have no standard rejection error; the ones
 * in use throw an `Error` whose name or message says "rejected", "denied",
 * "cancelled" or "declined", or carry the EIP-1193 code `4001`. Internal;
 * exported for tests.
 */
export const isUserRejection = (cause: unknown): boolean => {
  const record = recordOf(cause)
  if (record === undefined) return typeof cause === "string" && REJECTION.test(cause)
  const name = typeof record["name"] === "string" ? record["name"] : ""
  if (name === "NotAllowedError" || /reject|denied|cancel/i.test(name)) return true
  const code = record["code"]
  if (code === 4001 || code === "4001" || code === "USER_REJECTED" || code === "ACTION_REJECTED") return true
  const message = typeof record["message"] === "string" ? record["message"] : ""
  return REJECTION.test(message)
}

const REJECTION = /\b(?:user )?(?:rejected|denied|cancell?ed|declined)\b/i

const failureOf = (what: string) => (cause: unknown): SigningError =>
  isUserRejection(cause)
    ? new SigningError({ reason: "rejected", cause })
    : new SigningError({ cause: `${what}: ${String(recordOf(cause)?.["message"] ?? cause)}` })

// ---------------------------------------------------------------------------
// Passkey
// ---------------------------------------------------------------------------

/** The members of `@mysten/sui/keypairs/passkey` this module uses. */
interface PasskeyModule {
  readonly PasskeyKeypair: {
    new(publicKey: Uint8Array, provider: PasskeyProvider, credentialId?: Uint8Array): PasskeyKeypairLike
    readonly getPasskeyInstance: (provider: PasskeyProvider) => Promise<PasskeyKeypairLike>
  }
}

interface PasskeyKeypairLike extends SdkSigner {
  readonly getCredentialId?: () => Uint8Array | undefined
}

/**
 * The passkey subpath is imported on first use, by a **literal** specifier:
 * a bundler (esbuild, Rollup/Vite, Metro) follows only a literal `import()`,
 * and one by variable was left as a bare runtime import that a browser, React
 * Native or an extension cannot resolve, so every passkey failed as
 * `unavailable` in a bundled app. The subpath exists in every `@mysten/sui`
 * the peer range admits (2.28 on). It saves little: `/tx` already loads
 * `@mysten/sui/verify`, which pulls in the passkey public key and P-256.
 */
let passkeyModule: Promise<PasskeyModule> | undefined

const loadPasskey = (): Effect.Effect<PasskeyModule, SigningError> =>
  Effect.tryPromise({
    try: () => {
      passkeyModule ??= import("@mysten/sui/keypairs/passkey").then((loaded) => {
        const module = loaded as unknown as PasskeyModule
        if (typeof module?.PasskeyKeypair !== "function") {
          throw new Error("this @mysten/sui has no PasskeyKeypair")
        }
        return module
      })
      return passkeyModule
    },
    catch: (cause) =>
      new SigningError({ reason: "unavailable", cause: `passkeys are not available here: ${String(cause)}` })
  })

const fromPasskeyKeypair = (keypair: SdkSigner): Signer => ({
  address: SuiAddress.make(normalizeSuiAddress(keypair.toSuiAddress())),
  scheme: "Passkey",
  signTransaction: Effect.fn("Signer.passkey.signTransaction")(function*(bytes: Uint8Array) {
    const signed = yield* Effect.tryPromise({
      try: () => keypair.signTransaction(bytes),
      catch: failureOf("the passkey did not sign")
    })
    return yield* signatureOfString(signed.signature)
  }),
  signPersonalMessage: Effect.fn("Signer.passkey.signPersonalMessage")(function*(bytes: Uint8Array) {
    const signed = yield* Effect.tryPromise({
      try: () => keypair.signPersonalMessage(bytes),
      catch: failureOf("the passkey did not sign")
    })
    return yield* signatureOfString(signed.signature)
  })
})

/**
 * A `Signer` over an existing passkey: the SDK's `PasskeyKeypair` with the
 * credential's compressed P-256 public key (33 bytes, which the application
 * stored when the passkey was created) and a provider — the SDK's
 * `BrowserPasskeyProvider` in a browser, or any object with WebAuthn-shaped
 * `create()` and `get(challenge, credentialId?)`, which is how React Native
 * and a test reach it.
 *
 * Every signature is one authenticator prompt. A person cancelling it — a
 * `NotAllowedError`, which is also what a prompt that timed out raises — is
 * `SigningError { reason: "rejected" }`. A passkey does not expire, so
 * `maxEpoch` is absent.
 *
 * `@mysten/sui/keypairs/passkey` is imported on first use.
 *
 * Fails with: `SigningError { reason: "unavailable" }` when the installed SDK
 * has no `PasskeyKeypair`, and no reason when the public key is malformed.
 *
 * @since 0.5.0
 */
export const passkey = Effect.fn("Signer.passkey")(function*(options: {
  readonly publicKey: Uint8Array
  readonly provider: PasskeyProvider
  readonly credentialId?: Uint8Array
}): Effect.fn.Return<Signer, SigningError> {
  const module = yield* loadPasskey()
  const keypair = yield* Effect.try({
    try: () => {
      const keypair = new module.PasskeyKeypair(options.publicKey, options.provider, options.credentialId)
      // Derives the address from the key, which throws on a malformed one.
      keypair.toSuiAddress()
      return keypair
    },
    catch: (cause) => new SigningError({ cause: `not a passkey public key: ${String(cause)}` })
  })
  return fromPasskeyKeypair(keypair)
})

/**
 * Registers a **new** passkey with the provider (`navigator.credentials.create`
 * behind `BrowserPasskeyProvider`) and answers its signer together with what
 * the application must keep to use it again: the public key and, when the
 * provider reports one, the credential id. Lose the public key and the passkey
 * can only be recovered with two signatures (`PasskeyKeypair.signAndRecover`).
 *
 * Fails with: `SigningError` — `reason: "rejected"` when the person cancels the
 * prompt, `reason: "unavailable"` when the installed SDK has no
 * `PasskeyKeypair`, and no reason for any other provider failure.
 *
 * @since 0.5.0
 */
export const createPasskey = Effect.fn("Signer.createPasskey")(function*(
  provider: PasskeyProvider
): Effect.fn.Return<
  { readonly signer: Signer; readonly publicKey: Uint8Array; readonly credentialId?: Uint8Array },
  SigningError
> {
  const module = yield* loadPasskey()
  const keypair = yield* Effect.tryPromise({
    try: () => module.PasskeyKeypair.getPasskeyInstance(provider),
    catch: failureOf("the passkey could not be created")
  })
  const credentialId = keypair.getCredentialId?.()
  return {
    signer: fromPasskeyKeypair(keypair),
    publicKey: keypair.getPublicKey().toRawBytes(),
    ...(credentialId === undefined ? {} : { credentialId })
  }
})

// ---------------------------------------------------------------------------
// Wallet Standard
// ---------------------------------------------------------------------------

/**
 * A Wallet Standard account, structurally: what `@wallet-standard/base`'s
 * `WalletAccount` carries and this module reads.
 *
 * @since 0.5.0
 */
export interface StandardWalletAccount {
  readonly address: string
  readonly publicKey: ArrayLike<number>
  readonly chains: ReadonlyArray<string>
  readonly features?: ReadonlyArray<string>
}

/**
 * A Wallet Standard wallet, structurally: anything with a `features` record.
 * A `Wallet` from `@wallet-standard/base` (or a `WalletWithRequiredFeatures`
 * from `@mysten/wallet-standard`) is one.
 *
 * @since 0.5.0
 */
export interface StandardWallet {
  readonly name?: string
  readonly features: Readonly<Record<string, unknown>>
}

/** `sui:signTransaction` 2.0.0, as `@mysten/wallet-standard` 0.21 declares it. */
interface SignTransactionFeature {
  readonly signTransaction: (input: {
    readonly transaction: { readonly toJSON: () => Promise<string> }
    readonly account: StandardWalletAccount
    readonly chain: string
    readonly signal?: AbortSignal
  }) => Promise<{ readonly bytes: string; readonly signature: string }>
}

/** `sui:signTransactionBlock` 1.0.0 (deprecated by the standard, still shipped by older wallets). */
interface SignTransactionBlockFeature {
  readonly signTransactionBlock: (input: {
    readonly transactionBlock: Transaction
    readonly account: StandardWalletAccount
    readonly chain: string
  }) => Promise<{ readonly transactionBlockBytes: string; readonly signature: string }>
}

/** `sui:signPersonalMessage` 1.x. */
interface SignPersonalMessageFeature {
  readonly signPersonalMessage: (input: {
    readonly message: Uint8Array
    readonly account: StandardWalletAccount
    readonly chain?: string
  }) => Promise<{ readonly bytes: string; readonly signature: string }>
}

const featureOf = <F>(wallet: StandardWallet, name: string, method: string): F | undefined => {
  const feature = recordOf(wallet.features[name])
  return feature !== undefined && typeof feature[method] === "function" ? feature as F : undefined
}

/** The schemes whose address follows from a raw public key, tried in this order. */
const DERIVABLE: ReadonlyArray<SignatureScheme> = ["ED25519", "Secp256k1", "Secp256r1", "Passkey", "ZkLogin"]

const schemeOfAccount = (account: StandardWalletAccount): SignatureScheme | undefined => {
  const publicKey = Uint8Array.from(account.publicKey)
  const address = normalizeSuiAddress(account.address)
  for (const scheme of DERIVABLE) {
    try {
      if (normalizeSuiAddress(publicKeyFromRawBytes(scheme, publicKey).toSuiAddress()) === address) return scheme
    } catch {
      // Not a key of this scheme.
    }
  }
  return undefined
}

/**
 * Checks a wallet's signature locally when that needs no node: every scheme
 * but zkLogin and multisig, whose checks need a client (`Tx.attach` makes
 * those). A signature by another key is refused here rather than by the node.
 */
const checkSignatureOf = (
  verify: (signature: string) => Promise<unknown>,
  signature: string,
  account: string
): Effect.Effect<void, SigningError> => {
  const flag = (() => {
    try {
      return fromBase64(signature)[0]
    } catch {
      return undefined
    }
  })()
  const scheme = flag === undefined ? undefined : (SIGNATURE_FLAG_TO_SCHEME as Record<number, string>)[flag]
  if (scheme === undefined || scheme === "ZkLogin" || scheme === "MultiSig") return Effect.void
  return Effect.tryPromise({
    try: () => verify(signature),
    catch: (cause) =>
      new SigningError({
        cause: `the wallet's signature is not a valid signature by ${account} over these bytes: ${String(cause)}`
      })
  }).pipe(Effect.asVoid)
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

const bytesOf = (base64: string): Uint8Array | undefined => {
  try {
    return fromBase64(base64)
  } catch {
    return undefined
  }
}

/**
 * A `Signer` over one account of a connected Wallet Standard wallet, on one
 * chain (`"sui:mainnet"`, `"sui:testnet"`, ...).
 *
 * Transactions are signed with `sui:signTransaction` (2.0.0), handed the
 * already-built bytes as transaction JSON, and the Effect's `AbortSignal`, so
 * interrupting the signature closes the wallet's request where the wallet
 * honours it. A wallet that offers only the deprecated
 * `sui:signTransactionBlock` is used through that (it takes no signal).
 * Personal messages go through `sui:signPersonalMessage`.
 *
 * **The wallet signs the bytes it was given or nothing.** A wallet answers
 * with the bytes it signed, and may have rebuilt them (another gas price,
 * another budget, another expiration). The journal and the identical-bytes
 * resend depend on the signature being over **exactly** the bytes the library
 * built, so different bytes are a `SigningError`, never a silent substitution.
 * The signature is also checked locally against those bytes and the account's
 * address, for every scheme that needs no node to check (not zkLogin, not
 * multisig).
 *
 * `scheme` is derived from the account's public key — the scheme whose address
 * that key gives is the account's — and can be passed when it cannot be (a
 * multisig account). A person declining in the wallet is
 * `SigningError { reason: "rejected" }` (read structurally: a name or message
 * that says rejected, denied, cancelled or declined, or code `4001`).
 *
 * A wallet that is itself a zkLogin session (an Enoki wallet) does not report
 * its `maxEpoch` through the standard; `Enoki.fromWallet` on
 * `@unconfirmed/sui-effect/enoki` reads it from `enoki:getSession`.
 *
 * Fails with: `SigningError { reason: "unavailable" }` when the wallet has no
 * transaction-signing feature, the account is not on `chain`, or the scheme
 * cannot be derived and was not given.
 *
 * @since 0.5.0
 */
export const wallet = Effect.fn("Signer.wallet")(function*(options: {
  readonly wallet: StandardWallet
  readonly account: StandardWalletAccount
  readonly chain: string
  readonly scheme?: SignatureScheme
}): Effect.fn.Return<Signer, SigningError> {
  const { account, chain } = options
  const name = options.wallet.name ?? "the wallet"
  const v2 = featureOf<SignTransactionFeature>(options.wallet, "sui:signTransaction", "signTransaction")
  const v1 = featureOf<SignTransactionBlockFeature>(options.wallet, "sui:signTransactionBlock", "signTransactionBlock")
  const personal = featureOf<SignPersonalMessageFeature>(options.wallet, "sui:signPersonalMessage", "signPersonalMessage")
  if (v2 === undefined && v1 === undefined) {
    return yield* new SigningError({
      reason: "unavailable",
      cause: `${name} offers neither sui:signTransaction nor sui:signTransactionBlock`
    })
  }
  if (!account.chains.includes(chain)) {
    return yield* new SigningError({
      reason: "unavailable",
      cause: `${name}'s account ${account.address} is not on ${chain} (it is on ${account.chains.join(", ") || "none"})`
    })
  }
  const scheme = options.scheme ?? schemeOfAccount(account)
  if (scheme === undefined) {
    return yield* new SigningError({
      reason: "unavailable",
      cause: `the scheme of ${account.address} cannot be derived from its public key; pass scheme`
    })
  }
  const address = SuiAddress.make(normalizeSuiAddress(account.address))

  const signWithWallet = (bytes: Uint8Array) =>
    v2 !== undefined
      ? Effect.tryPromise({
        try: async (signal) => {
          const json = await Transaction.from(bytes).toJSON()
          const result = await v2.signTransaction({
            transaction: { toJSON: () => Promise.resolve(json) },
            account,
            chain,
            signal
          })
          return { bytes: result.bytes, signature: result.signature }
        },
        catch: failureOf(`${name} did not sign`)
      })
      : Effect.tryPromise({
        try: async () => {
          const result = await v1!.signTransactionBlock({ transactionBlock: Transaction.from(bytes), account, chain })
          return { bytes: result.transactionBlockBytes, signature: result.signature }
        },
        catch: failureOf(`${name} did not sign`)
      })

  return {
    address,
    scheme,
    signTransaction: Effect.fn("Signer.wallet.signTransaction")(function*(bytes: Uint8Array) {
      const result = yield* signWithWallet(bytes)
      const returned = bytesOf(result.bytes)
      if (returned === undefined || !sameBytes(returned, bytes)) {
        return yield* new SigningError({
          cause: `${name} signed different bytes than it was asked to sign; the library owns the transaction,` +
            " so a wallet that rebuilds it (gas, budget, expiration) cannot be used to sign it"
        })
      }
      const signature = yield* signatureOfString(result.signature)
      yield* checkSignatureOf(
        (candidate) => verifyTransactionSignature(bytes, candidate, { address }),
        signature,
        address
      )
      return signature
    }),
    signPersonalMessage: Effect.fn("Signer.wallet.signPersonalMessage")(function*(bytes: Uint8Array) {
      if (personal === undefined) {
        return yield* new SigningError({ reason: "unavailable", cause: `${name} offers no sui:signPersonalMessage` })
      }
      const result = yield* Effect.tryPromise({
        try: () => personal.signPersonalMessage({ message: bytes, account, chain }),
        catch: failureOf(`${name} did not sign`)
      })
      if (result.bytes !== toBase64(bytes)) {
        const returned = bytesOf(result.bytes)
        if (returned === undefined || !sameBytes(returned, bytes)) {
          return yield* new SigningError({ cause: `${name} signed a different message than it was asked to sign` })
        }
      }
      const signature = yield* signatureOfString(result.signature)
      yield* checkSignatureOf(
        (candidate) => verifyPersonalMessageSignature(bytes, candidate, { address }),
        signature,
        address
      )
      return signature
    })
  }
})
