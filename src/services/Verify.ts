/**
 * `Verify`: an Effect face for `@mysten/sui/verify`.
 *
 * A sponsor that co-signs somebody else's transaction, or a backend that
 * accepts a signed login message, has to check a signature it did not make.
 * The SDK's `verifyTransactionSignature` / `verifyPersonalMessageSignature`
 * answer a `PublicKey` or throw, and they throw for two very different
 * reasons: the signature is wrong, or the node a zkLogin or multisig check
 * needed could not be reached. This module keeps those apart, which is the
 * whole point of wrapping it: an invalid signature is a `SigningError`, and a
 * network blip is a `TransportError` — never reported as an invalid signature,
 * and never accepted as a valid one.
 *
 * The client is the `Sui` in context (`sui.core`), because since `@mysten/sui`
 * 2.37 the `client` option is what verifies zkLogin signatures and zkLogin
 * members of a multisig. A plain Ed25519, Secp256k1, Secp256r1, Passkey or
 * ML-DSA-65 signature is checked locally and makes no request.
 *
 * @since 0.4.0
 */
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { PublicKey } from "@mysten/sui/cryptography"
import { parseSerializedSignature } from "@mysten/sui/cryptography"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { publicKeyFromRawBytes } from "@mysten/sui/verify"
import { Effect } from "effect"
import type { PolicyDenied } from "../domain/errors.ts"
import { SigningError, TransportError } from "../domain/errors.ts"
import { SuiAddress } from "../domain/schemas.ts"
import { requireSigner } from "./AddressAlias.ts"
import { Sui } from "./Sui.ts"

/** The options both verifiers take. */
export interface VerifyOptions {
  /**
   * The address the signature must have been produced by. Compared with the
   * address the SDK derives from the signature's public key, which is always
   * the padded, normalized form — so it is typed `SuiAddress`; normalize a
   * shorthand with `SuiAddress.normalize` first.
   */
  readonly address?: SuiAddress
}

/**
 * The options of {@link verifyTransactionSignature}: {@link VerifyOptions},
 * plus whether `address` is checked through its address aliases.
 *
 * @since 0.6.0
 */
export interface VerifyTransactionOptions extends VerifyOptions {
  /**
   * Check `address` the way a validator checks a sender: the signature must be
   * by a member of `address`'s alias set (`0x2::address_alias`), read from its
   * `AddressAliases` object — or by `address` itself while it has not enabled
   * aliases. One object read, made even when the signature is `address`'s own,
   * since an address that removed itself from its set no longer signs for
   * itself. A signer that is neither is `PolicyDenied { rule: "alias.signer" }`.
   * Requires `address`.
   *
   * @since 0.6.0
   */
  readonly checkAddressAliases?: boolean
}

/** The two intents a signature can be made under. */
type Intent = "TransactionData" | "PersonalMessage"

/**
 * The client with the Effect's `AbortSignal` injected into every Core call, so
 * an interrupted zkLogin check cancels its `verifyZkLoginSignature` request.
 * Verification never builds a transaction, so unlike `Tx.build`'s client this
 * needs no resolver plugin: only `core`'s methods take the signal.
 */
const withSignal = (client: ClientWithCoreApi, signal: AbortSignal): ClientWithCoreApi => {
  const core = new Proxy(client.core, {
    get: (target, key) => {
      const value: unknown = Reflect.get(target, key)
      if (typeof key !== "string" || typeof value !== "function") return value
      return (options?: Record<string, unknown>, ...rest: Array<unknown>) =>
        (value as (...args: Array<unknown>) => unknown).call(
          target,
          { ...(options ?? {}), signal: options?.["signal"] ?? signal },
          ...rest
        )
    }
  })
  return new Proxy(client, {
    get: (target, key) => (key === "core" ? core : Reflect.get(target, key))
  })
}

/**
 * The public key a serialized signature carries, and whether checking it needs
 * the network.
 *
 * This is the SDK's own (unexported) `parseSignature` from
 * `dist/verify/verify.mjs`, built from the pieces it exports, so the key is read
 * once and the check below runs once — calling `isValid*` and then `verify*`
 * would send a zkLogin signature to the node twice.
 *
 * A zkLogin public identifier has two encodings (the legacy one pads the
 * address seed differently); given the expected address the SDK picks the one
 * that matches, and refuses when neither does. That refusal is retried without
 * the address, so a zkLogin signature from another account is reported the way
 * every other scheme's is: by the address it was signed as.
 *
 * Throws on a signature that does not parse.
 */
const parse = (
  signature: string,
  client: ClientWithCoreApi,
  address: SuiAddress | undefined
): { readonly publicKey: PublicKey; readonly serialized: string; readonly networked: boolean } => {
  const parsed = parseSerializedSignature(signature)
  if (parsed.signatureScheme === "MultiSig") {
    return {
      publicKey: new MultiSigPublicKey(parsed.multisig.multisig_pk, { client }),
      serialized: parsed.serializedSignature,
      networked: true
    }
  }
  if (parsed.signatureScheme === "ZkLogin") {
    let publicKey: PublicKey
    try {
      publicKey = publicKeyFromRawBytes("ZkLogin", parsed.publicKey, { client, ...(address === undefined ? {} : { address }) })
    } catch {
      publicKey = publicKeyFromRawBytes("ZkLogin", parsed.publicKey, { client })
    }
    return { publicKey, serialized: parsed.serializedSignature, networked: true }
  }
  return {
    publicKey: publicKeyFromRawBytes(parsed.signatureScheme, parsed.publicKey),
    serialized: parsed.serializedSignature,
    networked: false
  }
}

/** What one verification produced inside the client call. */
type Outcome =
  | { readonly _tag: "Valid"; readonly publicKey: PublicKey }
  | { readonly _tag: "Invalid"; readonly reason: string }

/**
 * Parses, verifies and checks the address in one client call.
 *
 * The classification is the SDK's own (`isValidSignature`'s contract): a
 * signature that does not parse, or a check that answers `false`, is invalid;
 * a check that **throws** is environmental. A throw is treated as environmental
 * only for zkLogin and multisig, the two schemes whose check can reach the
 * node; a local check that throws (a malformed curve point) is an invalid
 * signature like any other.
 */
const verifyWith = (
  method: string,
  intent: Intent,
  bytes: Uint8Array,
  signature: string,
  options: VerifyOptions,
  requireAddress = true
): Effect.Effect<PublicKey, SigningError | TransportError, Sui> =>
  Effect.gen(function*() {
    const sui = yield* Sui
    const outcome = yield* sui.core
      .use(async (client, signal): Promise<Outcome> => {
        let parsed: ReturnType<typeof parse>
        try {
          parsed = parse(signature, withSignal(client, signal), options.address)
        } catch (cause) {
          return { _tag: "Invalid", reason: `the signature does not parse: ${String(cause)}` }
        }
        let valid: boolean
        try {
          valid = intent === "TransactionData"
            ? await parsed.publicKey.verifyTransaction(bytes, parsed.serialized)
            : await parsed.publicKey.verifyPersonalMessage(bytes, parsed.serialized)
        } catch (cause) {
          // Rejected through `use`, whose `mapSdkError` turns it into a
          // `TransportError` and lets a harness defect through as a defect.
          if (parsed.networked) throw cause
          return { _tag: "Invalid", reason: `the signature could not be checked: ${String(cause)}` }
        }
        if (!valid) {
          return {
            _tag: "Invalid",
            reason: intent === "TransactionData"
              ? "the signature is not valid for these transaction bytes"
              : "the signature is not valid for this personal message"
          }
        }
        if (requireAddress && options.address !== undefined && !parsed.publicKey.verifyAddress(options.address)) {
          return {
            _tag: "Invalid",
            reason: `the signature was made by ${parsed.publicKey.toSuiAddress()}, not ${options.address}`
          }
        }
        return { _tag: "Valid", publicKey: parsed.publicKey }
      })
      .pipe(
        // The callback rejects only on an environmental failure, which `use`
        // maps (naming itself as the method). Whatever tag it chose, it is a
        // transport failure of this verifier, named after it.
        Effect.mapError((error) =>
          error._tag === "TransportError"
            ? TransportError.fromUnknown(method, error.cause, error.retryable)
            : TransportError.fromUnknown(method, error, false)
        )
      )
    if (outcome._tag === "Invalid") return yield* new SigningError({ cause: outcome.reason })
    return outcome.publicKey
  })

/**
 * Verifies a signature over transaction bytes, made under the
 * `TransactionData` intent, and answers the public key that made it — the SDK's
 * `verifyTransactionSignature`, with the client taken from `Sui`.
 *
 * With `address`, the signature must also have been produced by that address:
 * what a sponsor checks before it co-signs a sender's bytes. A multisig or
 * zkLogin signature is checked through the node; every other scheme locally.
 *
 * With `address` and **`checkAddressAliases: true`** (0.6.0), the signature
 * must instead be one a validator accepts for a transaction whose sender is
 * `address`: by a member of `address`'s alias set (`0x2::address_alias`), read
 * from its `AddressAliases` object, or by `address` itself while it has not
 * enabled aliases. The answer is then the alias's key (a multisig's, say), and
 * a valid signature by anyone else is `PolicyDenied { rule: "alias.signer" }`.
 *
 * ```ts
 * const publicKey = yield* Verify.verifyTransactionSignature(bytes, senderSignature, {
 *   address: sender
 * })
 * const aliasKey = yield* Verify.verifyTransactionSignature(bytes, multisigSignature, {
 *   address: account,
 *   checkAddressAliases: true
 * })
 * ```
 *
 * Fails with: `SigningError` (the signature does not parse, is not valid for
 * these bytes, or — without `checkAddressAliases` — was made by another
 * address), `PolicyDenied` (with `checkAddressAliases`: `alias.signer`, the
 * signer is neither `address` nor one of its aliases), `TransportError` (a
 * zkLogin or multisig check, or the alias read, could not reach a usable
 * answer — the signature was neither accepted nor refused).
 */
export const verifyTransactionSignature: VerifyTransactionSignature = Effect.fn("Verify.verifyTransactionSignature")(
  function*(
    bytes: Uint8Array,
    signature: string,
    options: VerifyTransactionOptions = {}
  ): Effect.fn.Return<PublicKey, SigningError | PolicyDenied | TransportError, Sui> {
    const aliased = options.checkAddressAliases === true && options.address !== undefined
    const publicKey = yield* verifyWith(
      "verifyTransactionSignature",
      "TransactionData",
      bytes,
      signature,
      options,
      !aliased
    )
    if (aliased) yield* requireSigner(options.address!, SuiAddress.normalize(publicKey.toSuiAddress()))
    return publicKey
  }
) as VerifyTransactionSignature

/**
 * The overloads of {@link verifyTransactionSignature}: `PolicyDenied` is in
 * the union exactly when `checkAddressAliases: true` is. Pass the literal; a
 * `boolean` variable matches neither.
 *
 * @since 0.6.0
 */
export type VerifyTransactionSignature = {
  (
    bytes: Uint8Array,
    signature: string,
    options: VerifyTransactionOptions & { readonly address: SuiAddress; readonly checkAddressAliases: true }
  ): Effect.Effect<PublicKey, SigningError | PolicyDenied | TransportError, Sui>
  (
    bytes: Uint8Array,
    signature: string,
    options?: VerifyOptions & { readonly checkAddressAliases?: false }
  ): Effect.Effect<PublicKey, SigningError | TransportError, Sui>
}

/**
 * Verifies a signature over a personal message, made under the
 * `PersonalMessage` intent, and answers the public key that made it — the
 * SDK's `verifyPersonalMessageSignature`, with the client taken from `Sui`.
 *
 * With `address`, the signature must also have been produced by that address:
 * what a "sign in with Sui" backend checks.
 *
 * Fails with: `SigningError` (the signature does not parse, is not valid for
 * this message, or was made by another address), `TransportError` (a zkLogin or
 * multisig check could not reach a usable answer).
 */
export const verifyPersonalMessageSignature = Effect.fn("Verify.verifyPersonalMessageSignature")(function*(
  message: Uint8Array,
  signature: string,
  options: VerifyOptions = {}
): Effect.fn.Return<PublicKey, SigningError | TransportError, Sui> {
  return yield* verifyWith("verifyPersonalMessageSignature", "PersonalMessage", message, signature, options)
})

/**
 * Signature verification, namespaced the way the SDK spells it:
 * `Verify.verifyTransactionSignature` (alias-aware with
 * `checkAddressAliases`, 0.6.0), `Verify.verifyPersonalMessageSignature`.
 * Both have `R = Sui`.
 */
export const Verify = {
  verifyTransactionSignature,
  verifyPersonalMessageSignature
} as const
