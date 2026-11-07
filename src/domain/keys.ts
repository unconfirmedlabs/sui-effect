/**
 * `KeyError`: a phrase, a secret key, a derivation path or a multisig member
 * set that is not one.
 *
 * It is not in the closed transaction taxonomy, because it cannot happen once
 * anything has been sent: it **declares** `outcome: "not_applied"`, so
 * `SuiError.outcome` places it without a special case.
 *
 * **No message here ever contains secret material.** A BIP-39 failure names
 * the position of a bad word, never the word; a secret-key failure names the
 * spelling it expected, never the input. That is a rule, not a habit: the
 * Bech32 decoder quotes its whole input on a bad checksum, so its message is
 * dropped, never forwarded.
 *
 * @since 0.5.0
 */
import { Schema } from "effect"
import type { Outcome } from "./errors.ts"

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
 * - `invalidMultisig` (0.6.0): `Signer.multisig` was given a signer that is
 *   not a member of the multisig, two signers for one member, or members whose
 *   weights do not reach the threshold.
 *
 * @since 0.5.0
 */
export const KeyErrorReason = Schema.Literals([
  "invalidMnemonic",
  "invalidSecretKey",
  "invalidPath",
  "unsupportedScheme",
  "unavailable",
  "invalidMultisig"
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
