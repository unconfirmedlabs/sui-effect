/**
 * The zkLogin signer: signature assembly from an ephemeral key, a proof and
 * the proof's `maxEpoch`.
 *
 * A zkLogin credential is an ephemeral keypair the application generated, a
 * zero-knowledge proof (from any prover) that binds that keypair to an OpenID
 * identity, and the epoch the proof stops being accepted after (`maxEpoch`).
 * A signature is the ephemeral signature wrapped with the proof
 * (`getZkLoginSignature`), which the node accepts while the current epoch is
 * at most `maxEpoch`. Getting the proof — the OAuth flow, the prover, where
 * the ephemeral key is kept between visits — is the application's.
 *
 * `@mysten/sui/zklogin` is loaded on demand: it carries the Poseidon
 * constants, and an application that never signs with zkLogin should not pay
 * for them in its bundle.
 *
 * @since 0.5.0
 */
import type { Signer as SdkSigner } from "@mysten/sui/cryptography"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Schema } from "effect"
import { SigningError } from "../domain/errors.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"
import type { Signer } from "./Signer.ts"

/**
 * The proof inputs a zkLogin signature carries: the SDK's
 * `ZkLoginSignatureInputs` from `@mysten/sui/zklogin`, as a schema, so a
 * proof from a prover's JSON reply can be decoded rather than cast.
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
 * What {@link zkLogin} needs, named as the SDK's `ZkLoginSignerOptions`
 * (`@mysten/sui/zklogin`) names them.
 *
 * - `ephemeralSigner` is any `@mysten/sui/cryptography` `Signer` — an
 *   `Ed25519Keypair`, or a `WebCryptoSigner` over a non-extractable key. It
 *   is the key the proof's nonce committed to; that commitment is inside the
 *   proof and cannot be checked here, so a wrong ephemeral key produces
 *   signatures the node refuses (`INVALID_ARGUMENT`).
 * - `inputs` is the proof (`ZkLoginSignatureInputs`).
 * - `maxEpoch` is the epoch the proof was generated for: the last epoch it is
 *   accepted in.
 * - `address` is the zkLogin address. It is checked against the proof (its
 *   address seed and issuer), legacy and current derivations both, so a proof
 *   for another account is refused; the SDK's `legacyAddress` flag is not
 *   needed.
 *
 * @since 0.6.0
 */
export interface ZkLoginSignerOptions {
  readonly ephemeralSigner: SdkSigner
  readonly inputs: ZkLoginSignatureInputs
  readonly maxEpoch: bigint | number | string
  readonly address: string
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
const signatureOfString = (signature: string): Effect.Effect<Signature, SigningError> =>
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
 * The check a `maxEpoch`-bound signer runs on the bytes before it signs,
 * without I/O: a transaction whose expiration cannot begin before
 * `minEpoch > maxEpoch` can never execute under this proof — the node would
 * refuse the signature in every epoch the bytes are valid in. This is what
 * makes signing after `maxEpoch` cheap to detect: `Tx.build`'s default
 * expiration starts at the current epoch, so once the chain is past
 * `maxEpoch`, every freshly built transaction names a `minEpoch` past it.
 *
 * Fails with: `SigningError { reason: "expired" }`.
 */
const checkMaxEpoch = (maxEpoch: bigint, bytes: Uint8Array): Effect.Effect<void, SigningError> =>
  Effect.suspend(() => {
    const minEpoch = minEpochOf(bytes)
    return minEpoch !== undefined && minEpoch > maxEpoch
      ? Effect.fail(
        new SigningError({
          reason: "expired",
          cause: `these bytes are valid from epoch ${minEpoch}, after the proof's maxEpoch ${maxEpoch};` +
            " the node would refuse the signature: get a new proof"
        })
      )
      : Effect.void
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
 * A `Signer` that assembles zkLogin signatures: `scheme: "ZkLogin"`,
 * `maxEpoch` set.
 *
 * Each signature is the ephemeral signer's signature over the bytes (with the
 * `TransactionData` or `PersonalMessage` intent), wrapped with the proof by the
 * SDK's `getZkLoginSignature` — exactly what the SDK's `ZkLoginSigner` does.
 *
 * **An expired `maxEpoch` is refused.** The signer fails with
 * `SigningError { reason: "expired" }` when the bytes cannot start before an
 * epoch past `maxEpoch`; it never reads the chain. Keeping the validity
 * window of the bytes **inside** `maxEpoch` — so a transaction built in the
 * proof's last epoch cannot outlive it — is the lifecycle's job: `Tx.run`
 * and `Tx.build` clamp their expiration to `signer.maxEpoch`, and refuse a
 * `maxEpoch` already below the current epoch with the same error. A personal
 * message carries no epoch, so it is not checked.
 *
 * Fails with: `SigningError` — `reason: "unavailable"` when
 * `@mysten/sui/zklogin` cannot be loaded, and no reason when `maxEpoch` is not
 * a non-negative integer or the proof does not derive `address`.
 *
 * @since 0.5.0
 */
export const zkLogin = Effect.fn("Signer.zkLogin")(function*(
  options: ZkLoginSignerOptions
): Effect.fn.Return<Signer, SigningError> {
  const { ephemeralSigner, inputs } = options
  const maxEpoch = toBigInt(options.maxEpoch)
  if (maxEpoch === undefined) {
    return yield* new SigningError({ cause: `maxEpoch ${String(options.maxEpoch)} is not a non-negative integer` })
  }
  const module = yield* loadZkLogin()
  const derived = yield* Effect.try({
    // Tries the legacy derivation, then the current one, and throws when
    // neither gives `address`.
    try: () => module.ZkLoginPublicIdentifier.fromProof(options.address, inputs).toSuiAddress(),
    catch: (cause) =>
      new SigningError({
        cause: `the zkLogin proof does not derive ${options.address} (address seed and issuer): ${String(cause)}`
      })
  })
  const address = SuiAddress.make(derived)
  const wrap = (userSignature: string) =>
    Effect.try({
      try: () => module.getZkLoginSignature({ inputs, maxEpoch: maxEpoch.toString(), userSignature }),
      catch: (cause) => new SigningError({ cause })
    }).pipe(Effect.flatMap(signatureOfString))
  return {
    address,
    scheme: "ZkLogin",
    maxEpoch,
    signTransaction: Effect.fn("Signer.zkLogin.signTransaction")(function*(bytes: Uint8Array) {
      yield* checkMaxEpoch(maxEpoch, bytes)
      const signed = yield* Effect.tryPromise({
        try: () => ephemeralSigner.signTransaction(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* wrap(signed.signature)
    }),
    signPersonalMessage: Effect.fn("Signer.zkLogin.signPersonalMessage")(function*(bytes: Uint8Array) {
      const signed = yield* Effect.tryPromise({
        try: () => ephemeralSigner.signPersonalMessage(bytes),
        catch: (cause) => new SigningError({ cause })
      })
      return yield* wrap(signed.signature)
    })
  }
})
