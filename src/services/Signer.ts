/**
 * `Signer`: a credential as a value, never a service.
 *
 * One process may legitimately hold two credentials at once (a sponsor signs
 * as itself and verifies the sender's signature), and `R = Signer` cannot say
 * which one a function meant. So a signer is always an explicit parameter, and
 * nothing here ever exposes secret material: a `Signer` is an address, a
 * scheme, and two functions that return signatures.
 *
 * @since 0.1.0
 */
import type { Keypair, Signer as SdkSigner } from "@mysten/sui/cryptography"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { Config, ConfigProvider, Effect, Redacted, Schema } from "effect"
import { SigningError } from "../domain/errors.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"

/** The signature schemes a {@link Signer} built by this module can carry. */
export type SignatureScheme = "ED25519" | "Secp256k1" | "Secp256r1" | "MultiSig" | "ZkLogin" | "Passkey"

/**
 * A credential: who it signs as, how, and the two things it can sign.
 *
 * Both members fail with `SigningError` and nothing else: a signer that has to
 * reach a KMS or a wallet wraps its own transport failure in the `cause`, so a
 * caller's error union does not grow a branch per credential kind.
 */
export interface Signer {
  /** The Sui address this signer signs as. */
  readonly address: SuiAddress
  /** The signature scheme of the credential. */
  readonly scheme: SignatureScheme
  /**
   * Signs transaction bytes with the `TransactionData` intent.
   *
   * Fails with: `SigningError`.
   */
  readonly signTransaction: (bytes: Uint8Array) => Effect.Effect<Signature, SigningError>
  /**
   * Signs a personal message with the `PersonalMessage` intent.
   *
   * Fails with: `SigningError`.
   */
  readonly signPersonalMessage: (bytes: Uint8Array) => Effect.Effect<Signature, SigningError>
}

const decodeSignature = Schema.decodeUnknownEffect(Signature)

const signatureOf = (signature: string): Effect.Effect<Signature, SigningError> =>
  decodeSignature(signature).pipe(
    Effect.mapError((issue) => new SigningError({ cause: `the signer returned a signature this version cannot read: ${issue.message}` }))
  )

/**
 * Wraps any `@mysten/sui/cryptography` `Signer`.
 *
 * The SDK's `Signer` is the base class every credential extends: `Keypair` and
 * its three schemes, but also a Ledger signer, a wallet adapter's signer, a KMS
 * signer — anything that can `toSuiAddress`, `getKeyScheme`, `signTransaction`
 * and `signPersonalMessage`. Nothing here needs the secret, so nothing here
 * needs a keypair, and the `Signer` this returns exposes no secret material
 * either.
 *
 * For a credential that is not an SDK `Signer` at all — a remote service, a
 * hardware device behind your own protocol — use {@link remote}, which takes
 * Effects and the address to sign as.
 *
 * Never fails: a bad address or signature surfaces as a `SigningError` from the
 * member that produced it, not from construction.
 */
export const fromSdkSigner = (keypair: SdkSigner): Signer => {
  const address = keypair.toSuiAddress()
  return {
    // `toSuiAddress` returns the normalized form the SDK derived from the
    // public key, so this never throws; the members still decode what the
    // keypair hands back.
    address: SuiAddress.make(address),
    scheme: keypair.getKeyScheme(),
    signTransaction: Effect.fn("Signer.signTransaction")(function*(bytes: Uint8Array) {
      const result = yield* Effect.tryPromise({
        try: () => keypair.signTransaction(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* signatureOf(result.signature)
    }),
    signPersonalMessage: Effect.fn("Signer.signPersonalMessage")(function*(bytes: Uint8Array) {
      const result = yield* Effect.tryPromise({
        try: () => keypair.signPersonalMessage(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* signatureOf(result.signature)
    })
  }
}

/**
 * {@link fromSdkSigner} under the name the spec gave it when a keypair was the
 * only thing it took. A `Keypair` **is** an SDK `Signer`, so this is a thin
 * alias kept for callers who hold one. Never fails.
 */
export const fromKeypair = (keypair: Keypair): Signer => fromSdkSigner(keypair)

/** Builds the keypair class the scheme flag of a Bech32 secret key names. */
const keypairOf = (parsed: { scheme: string; secretKey: Uint8Array }): Keypair | undefined => {
  switch (parsed.scheme) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(parsed.secretKey)
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(parsed.secretKey)
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(parsed.secretKey)
    default:
      return undefined
  }
}

/**
 * The only text a failure of {@link fromConfig} ever carries.
 *
 * It is fixed, and neither the key nor the thrown message is in it. The Bech32
 * decoder reports a bad checksum as `Invalid checksum in suiprivkey1…` with the
 * **whole input**, so a one-character typo in a live key would otherwise print
 * a recoverable secret on stderr the moment `Script.run` describes the failure.
 * There is nothing a caller can do with the decoder's wording that this
 * sentence does not already tell them, so it is dropped rather than redacted:
 * a `cause` on the error would serialize through `SuiError.toJson` too.
 */
const KEY_ERROR = "is not a Bech32 Sui private key (scheme or checksum), " +
  "or names a scheme with no keypair class (MultiSig, ZkLogin, Passkey — use Signer.remote for those)"

/**
 * Reads a Bech32 `suiprivkey1…` secret key from configuration and builds the
 * signer for whichever of the three schemes its flag names.
 *
 * The key is read with `Config.redacted`, and the decoded bytes never leave
 * this function. Neither does anything derived from them: the failure carries
 * one fixed sentence and no `cause`, because the decoder's own message quotes
 * the input it rejected.
 *
 * Fails with: `ConfigError` when the variable is missing, is not a Bech32 Sui
 * private key, or names a scheme that has no keypair class (`MultiSig`,
 * `ZkLogin`, `Passkey` — use {@link remote} for those).
 */
export const fromConfig = (
  name = "SUI_PRIVATE_KEY"
): Effect.Effect<Signer, Config.ConfigError> =>
  Config.redacted(name).pipe(
    Effect.flatMap((redacted) =>
      Effect.try({
        try: () => {
          const parsed = decodeSuiPrivateKey(Redacted.value(redacted))
          const keypair = keypairOf(parsed)
          if (keypair === undefined) {
            throw new Error("unsupported key scheme")
          }
          return fromKeypair(keypair)
        },
        // No `cause`: it would carry the decoder's message, and the decoder's
        // message carries the key.
        catch: () =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({ message: `${name} ${KEY_ERROR}` })
          )
      })
    )
  )

/**
 * A fresh Ed25519 credential that exists only for this process. For tests,
 * localnet and throwaway addresses.
 *
 * This is the one place sui-effect does not take randomness from Effect's
 * `Random`: key generation must come from a cryptographically secure source,
 * and `Random` is a seeded, test-controllable PRNG whose whole purpose is to be
 * reproducible. `new Ed25519Keypair()` uses the SDK's CSPRNG (`@noble/curves`
 * over `crypto.getRandomValues`). A `TestClock`-style deterministic key would
 * be a security bug, not a convenience.
 *
 * Never fails.
 */
export const ephemeral: Effect.Effect<Signer> = Effect.sync(() =>
  fromKeypair(new Ed25519Keypair())
)

/**
 * What {@link remote} needs to know about a credential it does not hold.
 *
 * `address` is not optional and is not derived: a remote signer **must report
 * the address it signs as**. `Tx.sign` and `Tx.cosign` compare it with the
 * transaction's sender and gas owner and refuse a mismatch, which is the only
 * thing standing between a misconfigured KMS key and an `INVALID_ARGUMENT`
 * rejection that `Tx.submit` can only report as `SubmissionUnknown`.
 */
export interface RemoteSigner {
  readonly address: SuiAddress
  readonly scheme: SignatureScheme
  readonly signTransaction: (bytes: Uint8Array) => Effect.Effect<string, SigningError>
  readonly signPersonalMessage?: (bytes: Uint8Array) => Effect.Effect<string, SigningError>
}

/**
 * Builds a signer around something that signs elsewhere: a KMS, a wallet, a
 * hardware device, another process.
 *
 * The returned signer decodes whatever the remote produced, so a malformed
 * signature is a `SigningError` rather than a surprise at execution. When
 * `signPersonalMessage` is not given, asking for one fails with `SigningError`
 * instead of pretending. Never fails.
 */
export const remote = (signer: RemoteSigner): Signer => ({
  address: signer.address,
  scheme: signer.scheme,
  signTransaction: Effect.fn("Signer.remote.signTransaction")(function*(bytes: Uint8Array) {
    return yield* signatureOf(yield* signer.signTransaction(bytes))
  }),
  signPersonalMessage: Effect.fn("Signer.remote.signPersonalMessage")(function*(bytes: Uint8Array) {
    const sign = signer.signPersonalMessage
    if (sign === undefined) {
      return yield* new SigningError({ cause: "this remote signer cannot sign personal messages" })
    }
    return yield* signatureOf(yield* sign(bytes))
  })
})

/**
 * The constructors, namespaced the way the spec spells them:
 * `Signer.fromSdkSigner`, `Signer.fromKeypair`, `Signer.fromConfig`,
 * `Signer.ephemeral`, `Signer.remote`. The type `Signer` is the interface above.
 */
export const Signer = {
  fromSdkSigner,
  fromKeypair,
  fromConfig,
  ephemeral,
  remote
} as const
