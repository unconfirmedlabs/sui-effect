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
import type { Keypair, Signer as SdkSigner, SignatureScheme } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Effect, type Redacted, Schema } from "effect"
import { SigningError } from "../domain/errors.ts"
import type { KeyError } from "../domain/keys.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"
import {
  derivationPath as derivationPathOf,
  type FromMnemonicOptions,
  type FromSecretKeyOptions,
  generateMnemonic as generateMnemonicOf,
  type KeyScheme,
  keypairFromMnemonic,
  keypairFromSecretKey,
  type MnemonicLength
} from "./SignerKeys.ts"

export type { FromMnemonicOptions, FromSecretKeyOptions, KeyScheme, MnemonicLength }
import { alias, multisig } from "./MultiSigSigner.ts"
import { zkLogin } from "./ZkLoginSigner.ts"

/**
 * The signature schemes a {@link Signer} can carry: the SDK's own
 * `SignatureScheme` from `@mysten/sui/cryptography`, re-exported rather than
 * copied, so a scheme the SDK adds is a scheme a `Signer` can name.
 *
 * It is exactly as wide as the installed SDK: `"MLDSA65"` is a member from
 * `@mysten/sui` 2.36 on and absent before, where the SDK can neither produce
 * nor verify such a signature.
 */
export type { SignatureScheme }

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
  /**
   * The last epoch this credential can sign for, when it is bounded (a
   * zkLogin proof's `maxEpoch`). Absent for a credential that does not expire.
   * `Tx.run` keeps the built bytes' validity window inside it, and a signer
   * whose bound has passed fails with `SigningError { reason: "expired" }`.
   *
   * @since 0.5.0
   */
  readonly maxEpoch?: bigint
  /**
   * The address whose key actually signs, when this signer signs **as**
   * `address` through Sui's address aliases (`0x2::address_alias`): `address`
   * is the account a transaction names as its sender or gas owner, and `alias`
   * a member of that account's alias set. Absent for a signer that signs as
   * itself. `Signer.alias` sets it, and `Tx.run` checks it against the
   * account's `AddressAliases` object before anything is built.
   *
   * @since 0.6.0
   */
  readonly alias?: SuiAddress
}

const decodeSignature = Schema.decodeUnknownEffect(Signature)

const signatureOf = (signature: string): Effect.Effect<Signature, SigningError> =>
  decodeSignature(signature).pipe(
    Effect.mapError((issue) => new SigningError({ cause: `the signer returned a signature this version cannot read: ${issue.message}` }))
  )

/** The members {@link fromSdkSigner} reads, and what it does with each. */
const SDK_SIGNER_MEMBERS = [
  "toSuiAddress",
  "getKeyScheme",
  "signTransaction"
] as const

/**
 * Wraps any `@mysten/sui/cryptography` `Signer`.
 *
 * The SDK's `Signer` is the base class every credential extends: `Keypair` and
 * its four schemes, but also a Ledger signer, a wallet adapter's signer, a KMS
 * signer — anything that can `toSuiAddress`, `getKeyScheme`, `signTransaction`
 * and `signPersonalMessage`. Nothing here needs the secret, so nothing here
 * needs a keypair, and the `Signer` this returns exposes no secret material
 * either.
 *
 * **`toSuiAddress()` and `getKeyScheme()` are read here, synchronously**, and
 * the address and scheme of the returned `Signer` are whatever they answered at
 * this moment: a credential that changes accounts later is a different
 * `Signer`, built again. A test double therefore needs both of those methods,
 * not only `signTransaction` — a double without `getKeyScheme` used to produce
 * `scheme: undefined` and nothing complained until a validator did.
 *
 * **Clear-signing inputs are the SDK signer's own concern.** The Ledger signer
 * takes `signTransaction(bytes, bcsObjects?, resolution?)` and resolves those
 * extra arguments through the client it was constructed with; this passes only
 * the bytes, which is the whole of the base `Signer` contract. A device that
 * needs more than the bytes gets it from its own client, or from
 * {@link remote}.
 *
 * For a credential that is not an SDK `Signer` at all — a remote service, a
 * hardware device behind your own protocol — use {@link remote}, which takes
 * Effects and the address to sign as.
 *
 * **Throws** a `TypeError` naming the missing member when the argument is not
 * an SDK signer — that is a wiring mistake in the caller, not a runtime
 * failure a program recovers from. Otherwise never fails: a bad address or
 * signature surfaces as a `SigningError` from the member that produced it, not
 * from construction.
 */
export const fromSdkSigner = (keypair: SdkSigner): Signer => {
  const missing = SDK_SIGNER_MEMBERS.filter(
    (member) => typeof (keypair as unknown as Record<string, unknown>)?.[member] !== "function"
  )
  if (missing.length > 0) {
    throw new TypeError(
      `Signer.fromSdkSigner: this value is not a @mysten/sui Signer — it has no ${
        missing.join(", no ")
      }. An SDK signer answers toSuiAddress(), getKeyScheme() and signTransaction(bytes);` +
        " for a test double or a credential that is not an SDK signer, use Signer.remote({" +
        " address, scheme, signTransaction })."
    )
  }
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
 * A signer derived from a BIP-39 recovery phrase, **checked first**: the word
 * count (12, 15, 18, 21 or 24), every word in the English list, and the
 * checksum. The SDK's `deriveKeypair` checks none of them, so a phrase with one
 * word wrong derives a valid account nobody has ever funded; here it is a
 * `KeyError { reason: "invalidMnemonic" }` and nothing is derived. The phrase
 * is normalized (trimmed, lowercased, single-spaced) before the check; no
 * BIP-39 passphrase is used, which is what every Sui wallet does.
 *
 * Paths are the standard Sui ones (`Signer.derivationPath`):
 * `m/44'/784'/{account}'/0'/0'` (Ed25519, the default),
 * `m/54'/784'/{account}'/0/0` (Secp256k1), `m/74'/784'/{account}'/0/0`
 * (Secp256r1). An explicit `path` must have its scheme's shape (the SDK's
 * `isValidHardenedPath` / `isValidBIP32Path`, with the scheme's own purpose)
 * and every level below 2^31.
 *
 * Once the phrase is checked the derivation is the SDK's own
 * (`Ed25519Keypair.deriveKeypair` and its ECDSA siblings). A `Redacted`
 * phrase is read, not wiped: it is the caller's.
 *
 * Fails with: `KeyError` (`invalidMnemonic`, `invalidPath`,
 * `unsupportedScheme`). The message names a bad word's position, never a word.
 *
 * @since 0.5.0
 */
export const fromMnemonic: (
  phrase: Redacted.Redacted<string> | string,
  options?: FromMnemonicOptions
) => Effect.Effect<Signer, KeyError> = Effect.fn("Signer.fromMnemonic")(function*(
  phrase: Redacted.Redacted<string> | string,
  options?: FromMnemonicOptions
) {
  return fromKeypair(yield* keypairFromMnemonic(phrase, options))
})

/**
 * A signer over an imported secret key: a Bech32 `suiprivkey1…` (its flag
 * names the scheme — `ED25519`, `Secp256k1`, `Secp256r1` or `MLDSA65`; a
 * contradicting `scheme` option is refused), a 32-byte hex seed (`0x`
 * optional), or 32 raw bytes — the last two read as `options.scheme`, default
 * `ED25519`.
 *
 * Reading a key from the environment is
 * `Config.Redacted("SUI_PRIVATE_KEY").pipe(Effect.flatMap(Signer.fromSecretKey))`.
 *
 * **The bytes are copied before any keypair is built over them.** The SDK's
 * Secp256k1/Secp256r1 keypairs keep a reference to the array they are given,
 * so building over the caller's buffer would let a later write to it change
 * the key. A `Redacted` input is read, not wiped. `MLDSA65Keypair` is
 * imported on demand: its subpath first shipped in `@mysten/sui` 2.36.
 *
 * Fails with: `KeyError` (`invalidSecretKey` — the message is fixed and never
 * quotes the input — or `unsupportedScheme` for `ZkLogin`, `MultiSig`, … and
 * a contradicting `scheme`).
 *
 * @since 0.5.0
 */
export const fromSecretKey: (
  secret: Redacted.Redacted<string> | string | Uint8Array,
  options?: FromSecretKeyOptions
) => Effect.Effect<Signer, KeyError> = Effect.fn("Signer.fromSecretKey")(function*(
  secret: Redacted.Redacted<string> | string | Uint8Array,
  options?: FromSecretKeyOptions
) {
  return fromKeypair(yield* keypairFromSecretKey(secret, options))
})

/**
 * A fresh BIP-39 English recovery phrase, `words` long (default 12: 128 bits
 * of entropy; 24 is 256), redacted.
 *
 * The entropy comes from `crypto.getRandomValues`, **not** Effect's `Random`:
 * `Random` is a seedable, test-controllable PRNG whose purpose is to be
 * reproducible, and a phrase a `TestRandom` could reproduce is a key anyone
 * could.
 *
 * Fails with: `KeyError` (`unavailable` on a platform without
 * `crypto.getRandomValues` — React Native without a polyfill;
 * `invalidMnemonic` for a length BIP-39 does not define).
 *
 * @since 0.5.0
 */
export const generateMnemonic: (
  words?: MnemonicLength
) => Effect.Effect<Redacted.Redacted<string>, KeyError> = Effect.fn("Signer.generateMnemonic")(function*(
  words?: MnemonicLength
) {
  return yield* generateMnemonicOf(words)
})

/**
 * The standard Sui derivation path of `scheme` at `account` (default 0):
 * `m/44'/784'/{a}'/0'/0'` (Ed25519), `m/54'/784'/{a}'/0/0` (Secp256k1),
 * `m/74'/784'/{a}'/0/0` (Secp256r1) — account 0 is the SDK's
 * `DEFAULT_*_DERIVATION_PATH`.
 *
 * **Throws** a `RangeError` when `account` is not an integer in `[0, 2^31)` —
 * a wiring mistake. Otherwise never fails.
 *
 * @since 0.5.0
 */
export const derivationPath = (scheme: KeyScheme, account?: number): string => derivationPathOf(scheme, account)

/**
 * The constructors, namespaced the way the spec spells them:
 * `Signer.fromSdkSigner`, `Signer.fromKeypair`, `Signer.ephemeral`,
 * `Signer.remote`; for keys the process holds `Signer.fromMnemonic`,
 * `Signer.fromSecretKey`, `Signer.generateMnemonic` and
 * `Signer.derivationPath`; `Signer.zkLogin` (a proof and an ephemeral key);
 * and signers made of signers (0.6.0) `Signer.multisig` (a weighted multisig
 * over member signers, combined in member order) and `Signer.alias` (sign as
 * an address through its address aliases). The type `Signer` is the
 * interface above.
 */
export const Signer = {
  fromSdkSigner,
  fromKeypair,
  ephemeral,
  remote,
  fromMnemonic,
  fromSecretKey,
  generateMnemonic,
  derivationPath,
  zkLogin,
  multisig,
  alias
} as const
