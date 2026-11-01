/**
 * The zkLogin account signer, its session schema and its session store.
 *
 * A zkLogin credential is a **session**, not a key: an ephemeral keypair the
 * application generated, a zero-knowledge proof (from Enoki or any prover)
 * that binds that keypair to an OpenID identity, and the epoch the proof
 * stops being accepted after (`maxEpoch`). A signature is the ephemeral
 * signature wrapped with the proof (`getZkLoginSignature`), which the node
 * accepts while the current epoch is at most `maxEpoch`.
 *
 * `@mysten/sui/zklogin` is loaded on demand: it carries the Poseidon
 * constants, and an application that never signs with zkLogin should not pay
 * for them in its bundle.
 *
 * @since 0.5.0
 */
import type { Signer as SdkSigner } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Clock, Effect, Option, Redacted, Schema } from "effect"
import type { KeyValueStore } from "effect/persistence"
import { SigningError } from "../domain/errors.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"
import type { Signer } from "./Signer.ts"

/**
 * The proof inputs a zkLogin signature carries: the SDK's
 * `ZkLoginSignatureInputs` from `@mysten/sui/zklogin`, as a schema, so a
 * session can be stored and read back. Exactly what Enoki's
 * `createZkLoginZkp` and `EnokiFlow.getProof` answer.
 *
 * @since 0.5.0
 */
export const ZkLoginSignatureInputs = Schema.Struct({
  proofPoints: Schema.Struct({
    a: Schema.Array(Schema.String),
    b: Schema.Array(Schema.Array(Schema.String)),
    c: Schema.Array(Schema.String)
  }),
  issBase64Details: Schema.Struct({ value: Schema.String, indexMod4: Schema.Int }),
  headerBase64: Schema.String,
  addressSeed: Schema.String
}).annotate({ identifier: "ZkLoginSignatureInputs", description: "zkLogin proof inputs" })
export type ZkLoginSignatureInputs = typeof ZkLoginSignatureInputs.Type

/**
 * The public half of a zkLogin session: everything but the ephemeral secret.
 *
 * - `address` is the zkLogin address. It is checked against the proof (its
 *   address seed and issuer) when a signer is made, legacy and current
 *   derivations both, so a session for another account is refused.
 * - `maxEpoch` is the last epoch the proof is accepted in, the bound the
 *   ephemeral key's nonce committed to.
 * - `expiresAt`, when known, is a wall-clock deadline in milliseconds since
 *   the Unix epoch (Enoki's `ZkLoginSession.expiresAt`). It is a cheap local
 *   approximation of `maxEpoch` the signer checks against `Clock`.
 *
 * Nothing here is secret: the proof is public on chain in every signature the
 * session makes. The JWT is deliberately not part of it — a session that can
 * sign never needs the token again.
 *
 * @since 0.5.0
 */
export const ZkLoginSession = Schema.Struct({
  address: SuiAddress,
  maxEpoch: Schema.BigIntFromString,
  proof: ZkLoginSignatureInputs,
  expiresAt: Schema.optionalKey(Schema.Finite)
}).annotate({ identifier: "ZkLoginSession", description: "The public half of a zkLogin session" })
type ZkLoginSessionType = typeof ZkLoginSession.Type
/** The decoded shape of {@link ZkLoginSession}. @since 0.5.0 */
export interface ZkLoginSession extends ZkLoginSessionType {}

/**
 * What {@link zkLogin} needs: the public session and the ephemeral signer.
 *
 * `ephemeral` is any `@mysten/sui/cryptography` `Signer` — an
 * `Ed25519Keypair`, or a `WebCryptoSigner` over a non-extractable key held in
 * IndexedDB (what Enoki's `experimental_nativeCryptoSigner` stores). It is the
 * key the proof's nonce committed to; that commitment is inside the proof and
 * cannot be checked here, so a wrong ephemeral key produces signatures the node
 * refuses (`INVALID_ARGUMENT`, which `Tx.submit` reports as itself).
 *
 * @since 0.5.0
 */
export interface ZkLoginSignerOptions {
  readonly session: {
    readonly address: string
    readonly maxEpoch: bigint | number | string
    readonly proof: ZkLoginSignatureInputs
    readonly expiresAt?: number
  }
  readonly ephemeral: SdkSigner
}

/** The members of `@mysten/sui/zklogin` this module uses. */
interface ZkLoginModule {
  readonly getZkLoginSignature: (input: {
    readonly inputs: ZkLoginSignatureInputs
    readonly maxEpoch: string
    readonly userSignature: string
  }) => string
  readonly ZkLoginPublicIdentifier: {
    readonly fromProof: (address: string, proof: ZkLoginSignatureInputs) => { toSuiAddress(): string }
  }
}

let zkLoginModule: Promise<ZkLoginModule> | undefined

/** `@mysten/sui/zklogin`, imported once, on first use. */
const loadZkLogin = (): Effect.Effect<ZkLoginModule, SigningError> =>
  Effect.tryPromise({
    try: () => {
      zkLoginModule ??= import("@mysten/sui/zklogin").then((module) => module as unknown as ZkLoginModule)
      return zkLoginModule
    },
    catch: (cause) =>
      new SigningError({ reason: "unavailable", cause: `@mysten/sui/zklogin could not be loaded: ${String(cause)}` })
  })

const decodeSignature = Schema.decodeUnknownEffect(Signature)

/** A signature string, decoded, or the `SigningError` that says it could not be. */
export const signatureOfString = (signature: string): Effect.Effect<Signature, SigningError> =>
  decodeSignature(signature).pipe(
    Effect.mapError((issue) => new SigningError({ cause: `the signer returned a signature this version cannot read: ${issue.message}` }))
  )

/** The `minEpoch` the bytes' expiration names, when it names one. Never throws. */
const minEpochOf = (bytes: Uint8Array): bigint | undefined => {
  try {
    const expiration = TransactionDataBuilder.fromBytes(bytes).expiration
    const bounds = expiration?.ValidDuring ?? (expiration as { readonly Validity?: { readonly minEpoch?: unknown } } | null | undefined)
      ?.Validity
    const minEpoch = bounds?.minEpoch
    return minEpoch === null || minEpoch === undefined ? undefined : BigInt(String(minEpoch))
  } catch {
    return undefined
  }
}

/**
 * The checks every session-bound signer runs before it signs, without I/O.
 *
 * - **Wall clock**: past `expiresAt` (by `Clock`) is `expired`.
 * - **The bytes themselves**: a transaction whose expiration cannot begin
 *   before `minEpoch > maxEpoch` can never execute under this session — the
 *   node would refuse the signature in every epoch the bytes are valid in. This
 *   is what makes signing after `maxEpoch` cheap to detect: `Tx.build`'s
 *   default expiration starts at the current epoch, so once the chain is past
 *   `maxEpoch`, every freshly built transaction names a `minEpoch` past it.
 *
 * Fails with: `SigningError { reason: "expired" }`.
 */
export const checkSessionBound = (
  bound: { readonly maxEpoch: bigint; readonly expiresAt?: number | undefined },
  bytes: Uint8Array | undefined
): Effect.Effect<void, SigningError> =>
  Effect.gen(function*() {
    if (bound.expiresAt !== undefined) {
      const now = yield* Clock.currentTimeMillis
      if (now >= bound.expiresAt) {
        return yield* new SigningError({
          reason: "expired",
          cause: `the zkLogin session expired at ${new Date(bound.expiresAt).toISOString()}; sign in again`
        })
      }
    }
    if (bytes !== undefined) {
      const minEpoch = minEpochOf(bytes)
      if (minEpoch !== undefined && minEpoch > bound.maxEpoch) {
        return yield* new SigningError({
          reason: "expired",
          cause: `these bytes are valid from epoch ${minEpoch}, after the session's maxEpoch ${bound.maxEpoch};` +
            " the node would refuse the signature: sign in again"
        })
      }
    }
  })

const toBigInt = (value: bigint | number | string): bigint | undefined => {
  try {
    const result = BigInt(value)
    return result >= 0n ? result : undefined
  } catch {
    return undefined
  }
}

/**
 * A `Signer` over a zkLogin session: `scheme: "ZkLogin"`, `maxEpoch` set.
 *
 * Each signature is the ephemeral signer's signature over the bytes (with the
 * `TransactionData` or `PersonalMessage` intent), wrapped with the proof by the
 * SDK's `getZkLoginSignature` — exactly what the SDK's `ZkLoginSigner` does.
 *
 * **Expiry is split in two.** The signer refuses with
 * `SigningError { reason: "expired" }` whatever it can tell locally: the
 * session's `expiresAt` has passed (`Clock`), or the bytes cannot start before
 * an epoch past `maxEpoch`. It never reads the chain. Keeping the validity
 * window of the bytes **inside** the session — so a transaction built in the
 * session's last epoch cannot outlive it — is the lifecycle's job: `Tx.run`
 * and `Tx.build` clamp their expiration to `signer.maxEpoch`. A personal
 * message carries no epoch, so for one only `expiresAt` is checked.
 *
 * Fails with: `SigningError` — `reason: "expired"` when the session has
 * already passed `expiresAt`, `reason: "unavailable"` when
 * `@mysten/sui/zklogin` cannot be loaded, and no reason when `maxEpoch` is not
 * a non-negative integer or the proof does not derive `address`.
 *
 * @since 0.5.0
 */
export const zkLogin = Effect.fn("Signer.zkLogin")(function*(
  options: ZkLoginSignerOptions
): Effect.fn.Return<Signer, SigningError> {
  const { ephemeral, session } = options
  const maxEpoch = toBigInt(session.maxEpoch)
  if (maxEpoch === undefined) {
    return yield* new SigningError({ cause: `maxEpoch ${String(session.maxEpoch)} is not a non-negative integer` })
  }
  const module = yield* loadZkLogin()
  const derived = yield* Effect.try({
    // Tries the legacy derivation, then the current one, and throws when
    // neither gives `address`.
    try: () => module.ZkLoginPublicIdentifier.fromProof(session.address, session.proof).toSuiAddress(),
    catch: (cause) =>
      new SigningError({
        cause: `the zkLogin proof does not derive ${session.address} (address seed and issuer): ${String(cause)}`
      })
  })
  const address = SuiAddress.make(derived)
  const bound = { maxEpoch, expiresAt: session.expiresAt }
  yield* checkSessionBound(bound, undefined)
  const wrap = (userSignature: string) =>
    Effect.try({
      try: () =>
        module.getZkLoginSignature({ inputs: session.proof, maxEpoch: maxEpoch.toString(), userSignature }),
      catch: (cause) => new SigningError({ cause })
    }).pipe(Effect.flatMap(signatureOfString))
  return {
    address,
    scheme: "ZkLogin",
    maxEpoch,
    signTransaction: Effect.fn("Signer.zkLogin.signTransaction")(function*(bytes: Uint8Array) {
      yield* checkSessionBound(bound, bytes)
      const signed = yield* Effect.tryPromise({
        try: () => ephemeral.signTransaction(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* wrap(signed.signature)
    }),
    signPersonalMessage: Effect.fn("Signer.zkLogin.signPersonalMessage")(function*(bytes: Uint8Array) {
      yield* checkSessionBound(bound, undefined)
      const signed = yield* Effect.tryPromise({
        try: () => ephemeral.signPersonalMessage(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* wrap(signed.signature)
    })
  }
})

/**
 * Seals and unseals a secret for storage. **sui-effect ships no sealer**: the
 * keystore that owns the wrapping key (WebCrypto AES-GCM under a key the
 * platform keeps, a passphrase-derived key, the OS keychain) implements this.
 *
 * `aad` is additional authenticated data the sealer must bind the blob to —
 * here, the UTF-8 bytes of the session's address — so a sealed key copied
 * under another account's entry does not unseal. A sealer that returns its
 * input unchanged stores the ephemeral key in plain text; that is a decision
 * the caller makes by writing one, never a default.
 *
 * @since 0.5.0
 */
export interface SecretSealer {
  /** Fails with: `SigningError`. */
  readonly seal: (secret: Redacted.Redacted<Uint8Array>, aad: Uint8Array) => Effect.Effect<string, SigningError>
  /** Fails with: `SigningError` (`reason: "locked"` when the keystore is locked is the convention). */
  readonly unseal: (sealed: string, aad: Uint8Array) => Effect.Effect<Redacted.Redacted<Uint8Array>, SigningError>
}

/**
 * One stored zkLogin session: the public session and the sealed ephemeral
 * secret (an Ed25519 32-byte seed, sealed by a {@link SecretSealer}). The JSON
 * a {@link save} writes under its key.
 *
 * @since 0.5.0
 */
export const ZkLoginStoredSession = Schema.Struct({
  session: ZkLoginSession,
  ephemeral: Schema.Struct({ scheme: Schema.Literal("ED25519"), sealed: Schema.String })
}).annotate({ identifier: "ZkLoginStoredSession", description: "A zkLogin session with its sealed ephemeral key" })
type ZkLoginStoredSessionType = typeof ZkLoginStoredSession.Type
/** The decoded shape of {@link ZkLoginStoredSession}. @since 0.5.0 */
export interface ZkLoginStoredSession extends ZkLoginStoredSessionType {}

const StoredJson = Schema.fromJsonString(ZkLoginStoredSession)
const encodeStored = Schema.encodeEffect(StoredJson)
const decodeStored = Schema.decodeUnknownEffect(StoredJson)

const aadOf = (address: string): Uint8Array => new TextEncoder().encode(address)

const storeError = (what: string) => (cause: unknown) =>
  new SigningError({ reason: "unavailable", cause: `the zkLogin session store could not ${what}: ${String(cause)}` })

/**
 * Persists a zkLogin session under `key` in a `KeyValueStore` (any adapter:
 * IndexedDB, `localStorage`, AsyncStorage, `chrome.storage`).
 *
 * The ephemeral secret is a `Redacted` 32-byte Ed25519 seed and is written
 * **only** as the blob `sealer.seal` returns, bound to the address as AAD; the
 * session itself is public and written as JSON. A session whose ephemeral key
 * is non-extractable (a `WebCryptoSigner`) has no seed to seal: store the
 * `CryptoKeyPair` the platform's way and the {@link ZkLoginSession} with it,
 * then call {@link zkLogin}.
 *
 * Fails with: `SigningError` (the sealer refused, or the store could not be
 * written — `reason: "unavailable"`).
 *
 * @since 0.5.0
 */
export const save = Effect.fn("ZkLogin.save")(function*(
  store: KeyValueStore.KeyValueStore,
  key: string,
  input: {
    readonly session: ZkLoginSession
    readonly ephemeralSecretKey: Redacted.Redacted<Uint8Array>
    readonly sealer: SecretSealer
  }
): Effect.fn.Return<void, SigningError> {
  if (Redacted.value(input.ephemeralSecretKey).length !== 32) {
    return yield* new SigningError({ cause: "the ephemeral secret key must be a 32-byte Ed25519 seed" })
  }
  const sealed = yield* input.sealer.seal(input.ephemeralSecretKey, aadOf(input.session.address))
  const text = yield* encodeStored({ session: input.session, ephemeral: { scheme: "ED25519", sealed } }).pipe(
    Effect.mapError((issue) => new SigningError({ cause: `the zkLogin session does not encode: ${issue.message}` }))
  )
  yield* store.set(key, text).pipe(Effect.mapError(storeError("write it")))
})

/**
 * Reads a zkLogin session {@link save} wrote and makes its signer: unseals the
 * ephemeral key with `sealer`, then {@link zkLogin}. `None` when nothing is
 * stored under `key`.
 *
 * A session past its `expiresAt` is not silently dropped: it fails with
 * `reason: "expired"`, so the application knows to sign in again, and is left
 * in the store for the caller to {@link remove}.
 *
 * Fails with: `SigningError` — `reason: "expired"` (past `expiresAt`),
 * `reason: "unavailable"` (the store could not be read), whatever the
 * sealer's `unseal` fails with, and no reason when the stored value does not
 * decode or its proof does not derive its address.
 *
 * @since 0.5.0
 */
export const load = Effect.fn("ZkLogin.load")(function*(
  store: KeyValueStore.KeyValueStore,
  key: string,
  options: { readonly sealer: SecretSealer }
): Effect.fn.Return<Option.Option<Signer>, SigningError> {
  const text = yield* store.get(key).pipe(Effect.mapError(storeError("read it")))
  if (text === undefined) return Option.none()
  const stored = yield* decodeStored(text).pipe(
    Effect.mapError((issue) => new SigningError({ cause: `the stored zkLogin session does not decode: ${issue.message}` }))
  )
  yield* checkSessionBound(stored.session, undefined)
  const secret = yield* options.sealer.unseal(stored.ephemeral.sealed, aadOf(stored.session.address))
  const ephemeral = yield* Effect.try({
    try: () => Ed25519Keypair.fromSecretKey(Redacted.value(secret)),
    catch: () => new SigningError({ cause: "the unsealed ephemeral key is not a 32-byte Ed25519 seed" })
  }).pipe(
    // The keypair holds what it needs; the `Redacted` is dropped from the
    // registry so a stray reference to it cannot be unwrapped later.
    Effect.ensuring(Effect.sync(() => Redacted.wipeUnsafe(secret)))
  )
  return Option.some(yield* zkLogin({ session: stored.session, ephemeral }))
})

/**
 * Deletes a stored zkLogin session — what signing out does.
 *
 * Fails with: `SigningError { reason: "unavailable" }` (the store could not be
 * written).
 *
 * @since 0.5.0
 */
export const remove = Effect.fn("ZkLogin.remove")(function*(
  store: KeyValueStore.KeyValueStore,
  key: string
): Effect.fn.Return<void, SigningError> {
  yield* store.remove(key).pipe(Effect.mapError(storeError("remove it")))
})

/**
 * The zkLogin session schemas and store, namespaced: `ZkLogin.Session`,
 * `ZkLogin.SignatureInputs`, `ZkLogin.StoredSession`, `ZkLogin.save`,
 * `ZkLogin.load`, `ZkLogin.remove`. The signer itself is `Signer.zkLogin`.
 *
 * @since 0.5.0
 */
export const ZkLogin = {
  Session: ZkLoginSession,
  SignatureInputs: ZkLoginSignatureInputs,
  StoredSession: ZkLoginStoredSession,
  save,
  load,
  remove
} as const
