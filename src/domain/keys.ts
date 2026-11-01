/**
 * The two failures of keys at rest: `KeyError` (a phrase, a secret key or a
 * derivation path that is not one) and `KeystoreError` (the sealed keystore).
 *
 * Neither is in the closed transaction taxonomy, because neither can happen
 * once anything has been sent: both **declare** `outcome: "not_applied"`, so
 * `SuiError.outcome` and `Script.exitCode` place them without a special case.
 *
 * **No message here ever contains secret material.** A BIP-39 failure names
 * the position of a bad word, never the word; a secret-key failure names the
 * spelling it expected, never the input; a keystore failure names the address
 * and the reason. That is a rule, not a habit: the Bech32 decoder quotes its
 * whole input on a bad checksum, so its message is dropped, never forwarded.
 *
 * @since 0.5.0
 */
import { Schema } from "effect"
import type { Outcome } from "./errors.ts"
import { SuiAddress } from "./schemas.ts"

/**
 * Why a phrase, a secret key or a path was refused.
 *
 * - `invalidMnemonic`: not 12/15/18/21/24 words, a word outside the BIP-39
 *   English list, or a failed checksum. A mistyped phrase is always this,
 *   never a valid account nobody owns.
 * - `invalidSecretKey`: not a Bech32 `suiprivkey1…`, not 32 bytes (hex or
 *   raw), or not a valid key of its scheme.
 * - `invalidPath`: a derivation path that is not the scheme's Sui path shape,
 *   or an account index outside `[0, 2^31)`.
 * - `unsupportedScheme`: a scheme this constructor does not hold keys for
 *   (only `ED25519`, `Secp256k1` and `Secp256r1` derive from a mnemonic), or a
 *   `scheme` option that contradicts the key's own flag.
 * - `unavailable`: the platform has no `crypto.getRandomValues`, which a fresh
 *   mnemonic needs (React Native without a CSPRNG polyfill).
 *
 * @since 0.5.0
 */
export const KeyErrorReason = Schema.Literals([
  "invalidMnemonic",
  "invalidSecretKey",
  "invalidPath",
  "unsupportedScheme",
  "unavailable"
])
/** @since 0.5.0 */
export type KeyErrorReason = typeof KeyErrorReason.Type

/**
 * A recovery phrase, a secret key or a derivation path was refused. Nothing
 * was derived and nothing was sent: outcome `not_applied`.
 *
 * `message` is a schema field because the sentence comes from the check that
 * failed; it never contains the phrase, a word of it, or the key.
 *
 * @since 0.5.0
 */
export class KeyError extends Schema.TaggedError<KeyError>()("KeyError", {
  reason: KeyErrorReason,
  message: Schema.String
}) {
  /** Nothing was derived or sent. */
  readonly outcome: Outcome = "not_applied"
}

/**
 * Why a keystore operation failed.
 *
 * - `wrongPassword`: the password does not open this account's record (its
 *   key-check value does not match).
 * - `invalidPassword`: a new password is empty.
 * - `notFound`: no record for this address.
 * - `exists`: a record for this address is already stored (`import*`).
 * - `noMnemonic`: `exportMnemonic` of an account imported from a secret key.
 * - `corrupt`: the record does not decode, was moved onto another address, was
 *   edited (the AES-GCM tag over the ciphertext and its bound metadata does not
 *   verify under a password whose check value matched), or holds a key that is
 *   not the address's key.
 * - `unsupported`: the record was written by a newer format version, or names
 *   a KDF or cipher this version does not know.
 * - `unavailable`: the platform has no WebCrypto (`crypto.subtle` or
 *   `crypto.getRandomValues`), which React Native lacks without a polyfill.
 * - `storage`: the `KeyValueStore` failed; `cause` is its error.
 *
 * @since 0.5.0
 */
export const KeystoreErrorReason = Schema.Literals([
  "wrongPassword",
  "invalidPassword",
  "notFound",
  "exists",
  "noMnemonic",
  "corrupt",
  "unsupported",
  "unavailable",
  "storage"
])
/** @since 0.5.0 */
export type KeystoreErrorReason = typeof KeystoreErrorReason.Type

/**
 * A keystore operation failed. Nothing was sent: outcome `not_applied`.
 *
 * A wrong password is this error with `reason: "wrongPassword"`, never a
 * defect. `message` never contains the password or anything sealed.
 *
 * @since 0.5.0
 */
export class KeystoreError extends Schema.TaggedError<KeystoreError>()("KeystoreError", {
  reason: KeystoreErrorReason,
  message: Schema.String,
  address: Schema.optionalKey(SuiAddress),
  cause: Schema.optionalKey(Schema.Defect())
}) {
  /** Nothing was sent. */
  readonly outcome: Outcome = "not_applied"
}
