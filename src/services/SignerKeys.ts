/**
 * Keys the process holds: BIP-39 phrases checked before anything is derived,
 * the standard Sui derivation paths, and secret keys copied before a keypair
 * is built over them.
 *
 * Internal; the public names are on the `Signer` namespace (`Signer.ts`).
 *
 * **Why every derivation goes through {@link validateMnemonic} first.** The
 * SDK's `deriveKeypair` feeds any string into `mnemonicToSeedSync` and never
 * checks the word list or the checksum, so a mistyped phrase derives a valid,
 * empty account — a person "restores" a wallet and sees a zero balance. Once
 * the phrase is checked, the derivation itself is the SDK's
 * (`Ed25519Keypair.deriveKeypair` and its ECDSA siblings).
 *
 * **Why the ECDSA keypairs are built over a copy.** `Secp256k1Keypair` and
 * `Secp256r1Keypair` keep a **reference** to the bytes they are given and sign
 * with them, so a caller that later zeroes or reuses its buffer would change
 * or break the key. Here every keypair is built over a copy nobody else holds.
 *
 * @since 0.5.0
 */
import type { Keypair } from "@mysten/sui/cryptography"
import {
  decodeSuiPrivateKey,
  isValidBIP32Path,
  isValidHardenedPath,
  SUI_PRIVATE_KEY_PREFIX
} from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { entropyToMnemonic, validateMnemonic as checksumOk } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { Effect, Redacted } from "effect"
import { KeyError } from "../domain/keys.ts"

/**
 * The schemes a held key can be: the three a BIP-39 phrase derives on the
 * standard Sui paths. (`ZkLogin`, `Passkey` and `MultiSig` hold no secret key.)
 *
 * @since 0.5.0
 */
export type KeyScheme = "ED25519" | "Secp256k1" | "Secp256r1"

const isKeyScheme = (value: string): value is KeyScheme =>
  value === "ED25519" || value === "Secp256k1" || value === "Secp256r1"

/** Options of `Signer.fromMnemonic`. @since 0.5.0 */
export interface FromMnemonicOptions {
  /** The scheme to derive. Default `"ED25519"`, which is what every Sui wallet derives first. */
  readonly scheme?: KeyScheme
  /**
   * The account index on the scheme's standard path, `[0, 2^31)`. Default 0.
   * Ignored when `path` is given.
   */
  readonly account?: number
  /**
   * An explicit derivation path, checked against the scheme's shape:
   * `m/44'/784'/a'/c'/i'` (Ed25519, every level hardened, SLIP-0010),
   * `m/54'/784'/a'/c/i` (Secp256k1) or `m/74'/784'/a'/c/i` (Secp256r1).
   */
  readonly path?: string
}

/** Options of `Signer.fromSecretKey`. @since 0.5.0 */
export interface FromSecretKeyOptions {
  /**
   * The scheme of a key that carries none: raw bytes or a 64-digit hex seed
   * (default `"ED25519"`). For a Bech32 `suiprivkey1…` the key's own flag
   * decides, and a `scheme` that contradicts it is refused.
   */
  readonly scheme?: KeyScheme
}

/** The BIP-39 word counts: 128 to 256 bits of entropy in 32-bit steps. */
export type MnemonicLength = 12 | 15 | 18 | 21 | 24

const WORD_COUNTS: ReadonlyArray<number> = [12, 15, 18, 21, 24]
const WORDS: ReadonlySet<string> = new Set(wordlist)

const PURPOSE: Record<KeyScheme, number> = { ED25519: 44, Secp256k1: 54, Secp256r1: 74 }

const PATH_SHAPE: Record<KeyScheme, string> = {
  ED25519: "m/44'/784'/{account}'/{change}'/{index}'",
  Secp256k1: "m/54'/784'/{account}'/{change}/{index}",
  Secp256r1: "m/74'/784'/{account}'/{change}/{index}"
}

const keyError = (reason: KeyError["reason"], message: string) => new KeyError({ reason, message })

/**
 * The standard Sui derivation path of `scheme` at account `account`:
 * `m/44'/784'/{a}'/0'/0'` (Ed25519), `m/54'/784'/{a}'/0/0` (Secp256k1),
 * `m/74'/784'/{a}'/0/0` (Secp256r1). Account 0 is each keypair class's
 * `DEFAULT_*_DERIVATION_PATH`, and the one every Sui wallet shows first.
 *
 * **Throws** a `RangeError` when `account` is not an integer in `[0, 2^31)`:
 * that is a wiring mistake, not a runtime failure (`Signer.fromMnemonic`
 * checks its own `account` and fails with `KeyError` instead).
 */
export const derivationPath = (scheme: KeyScheme, account = 0): string => {
  if (!isIndex(account)) {
    throw new RangeError(`Signer.derivationPath: account must be an integer in [0, 2^31), got ${account}`)
  }
  return scheme === "ED25519"
    ? `m/44'/784'/${account}'/0'/0'`
    : `m/${PURPOSE[scheme]}'/784'/${account}'/0/0`
}

const isIndex = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && value < 2 ** 31

/** Each level of a path below 2^31, which neither SDK regex checks. */
const levelsInRange = (path: string): boolean =>
  path.split("/").slice(1).every((level) => isIndex(Number(level.replace(/'$/, ""))))

const pathFits = (scheme: KeyScheme, path: string): boolean => {
  if (!levelsInRange(path)) return false
  if (scheme === "ED25519") return isValidHardenedPath(path)
  // The SDK's BIP-32 check admits 54 and 74 for either ECDSA scheme; the
  // purpose is what tells them apart, so it must be this scheme's.
  return isValidBIP32Path(path) && path.startsWith(`m/${PURPOSE[scheme]}'/`)
}

/**
 * Normalizes a phrase (trim, lowercase, single spaces) and checks it: a BIP-39
 * word count, every word in the English list, and the checksum. Answers the
 * normalized phrase. The failure names a word's **position**, never the word.
 */
export const validateMnemonic = (phrase: string): Effect.Effect<string, KeyError> =>
  Effect.suspend(() => {
    const words = phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0)
    if (!WORD_COUNTS.includes(words.length)) {
      return Effect.fail(
        keyError("invalidMnemonic", `a recovery phrase has 12, 15, 18, 21 or 24 words; this one has ${words.length}`)
      )
    }
    const unknown = words.findIndex((word) => !WORDS.has(word))
    if (unknown >= 0) {
      return Effect.fail(
        keyError("invalidMnemonic", `word ${unknown + 1} of the recovery phrase is not in the BIP-39 English word list`)
      )
    }
    const normalized = words.join(" ")
    if (!checksumOk(normalized, wordlist)) {
      return Effect.fail(
        keyError("invalidMnemonic", "the recovery phrase fails its BIP-39 checksum: a word is wrong or out of order")
      )
    }
    return Effect.succeed(normalized)
  })

/** The keypair of `scheme` over a **copy** of `bytes`; throws on bytes that are not a key of `scheme`. */
const keypairOver = (scheme: KeyScheme, bytes: Uint8Array): Keypair => {
  const secret = Uint8Array.from(bytes)
  switch (scheme) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(secret)
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(secret)
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(secret)
  }
}

/** `getRandomValues`, or `undefined` on a platform without WebCrypto. */
const randomSource = (): ((array: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>) | undefined => {
  const crypto: unknown = Reflect.get(globalThis, "crypto")
  if (typeof crypto !== "object" || crypto === null) return undefined
  const getRandomValues: unknown = Reflect.get(crypto, "getRandomValues")
  return typeof getRandomValues === "function"
    ? (array) => Reflect.apply(getRandomValues, crypto, [array])
    : undefined
}

/**
 * A fresh BIP-39 English phrase of `words` words from the platform CSPRNG.
 *
 * Fails with: `KeyError` (`unavailable` without `crypto.getRandomValues`;
 * `invalidMnemonic` for a word count BIP-39 does not define).
 */
export const generateMnemonic = (
  words: MnemonicLength = 12
): Effect.Effect<Redacted.Redacted<string>, KeyError> =>
  Effect.suspend(() => {
    if (!WORD_COUNTS.includes(words)) {
      return Effect.fail(keyError("invalidMnemonic", `a recovery phrase has 12, 15, 18, 21 or 24 words, not ${words}`))
    }
    const random = randomSource()
    if (random === undefined) {
      return Effect.fail(
        keyError(
          "unavailable",
          "this platform has no crypto.getRandomValues; install a CSPRNG polyfill (react-native-get-random-values)"
        )
      )
    }
    const entropy = random(new Uint8Array((words / 3) * 4))
    return Effect.succeed(Redacted.make(entropyToMnemonic(entropy, wordlist), { label: "mnemonic" }))
  })

/** The path `options` name for `scheme`, checked. */
const pathOf = (scheme: KeyScheme, options: FromMnemonicOptions | undefined): Effect.Effect<string, KeyError> =>
  Effect.suspend(() => {
    if (options?.path !== undefined) {
      return pathFits(scheme, options.path)
        ? Effect.succeed(options.path)
        : Effect.fail(
          keyError(
            "invalidPath",
            `${options.path} is not a ${scheme} Sui derivation path (${PATH_SHAPE[scheme]}, each level below 2^31)`
          )
        )
    }
    const account = options?.account ?? 0
    return isIndex(account)
      ? Effect.succeed(derivationPath(scheme, account))
      : Effect.fail(keyError("invalidPath", `account must be an integer in [0, 2^31), got ${account}`))
  })

/**
 * `Signer.fromMnemonic`'s body: the phrase checked, then the SDK's own
 * derivation on the checked path.
 *
 * Fails with: `KeyError` (`invalidMnemonic`, `invalidPath`, `unsupportedScheme`).
 */
export const keypairFromMnemonic = (
  phrase: Redacted.Redacted<string> | string,
  options?: FromMnemonicOptions
): Effect.Effect<Keypair, KeyError> =>
  Effect.gen(function*() {
    const scheme = options?.scheme ?? "ED25519"
    if (!isKeyScheme(scheme)) {
      return yield* keyError(
        "unsupportedScheme",
        `a recovery phrase derives ED25519, Secp256k1 or Secp256r1 keys, not ${String(scheme)}`
      )
    }
    const path = yield* pathOf(scheme, options)
    const normalized = yield* validateMnemonic(Redacted.isRedacted(phrase) ? Redacted.value(phrase) : phrase)
    return yield* Effect.try({
      try: (): Keypair => {
        switch (scheme) {
          case "ED25519":
            return Ed25519Keypair.deriveKeypair(normalized, path)
          case "Secp256k1":
            return Secp256k1Keypair.deriveKeypair(normalized, path)
          case "Secp256r1":
            return Secp256r1Keypair.deriveKeypair(normalized, path)
        }
      },
      catch: () => keyError("invalidPath", `could not derive a ${scheme} key on ${path}`)
    })
  })

/** A raw 32-byte secret as hexadecimal, with or without the `0x`. */
const HEX_SEED = /^(?:0x)?([0-9a-fA-F]{64})$/

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * `MLDSA65Keypair` is imported on demand rather than statically: its subpath
 * (`@mysten/sui/keypairs/mldsa65`) first shipped in `@mysten/sui` 2.36, and the
 * peer range still admits 2.28, where a static import would fail to load this
 * whole package. On an SDK that old `decodeSuiPrivateKey` never answers
 * `"MLDSA65"`, so the import is reached only where it exists. The specifier is
 * a variable so the declaration does not have to resolve on an older SDK.
 */
const MLDSA65_MODULE = "@mysten/sui/keypairs/mldsa65"

/** The one member of `@mysten/sui/keypairs/mldsa65` this module uses. */
interface MLDSA65Module {
  readonly MLDSA65Keypair: { readonly fromSecretKey: (secretKey: Uint8Array) => Keypair }
}

const SECRET_SPELLING =
  "a secret key is a Bech32 suiprivkey1… string, 64 hex digits (a 32-byte seed, 0x optional) or 32 raw bytes"

/**
 * `Signer.fromSecretKey`'s body. The keypair is built over a copy; the
 * caller's own `Uint8Array` is left as it was.
 *
 * Fails with: `KeyError` (`invalidSecretKey`, `unsupportedScheme`).
 */
export const keypairFromSecretKey = (
  secret: Redacted.Redacted<string> | string | Uint8Array,
  options?: FromSecretKeyOptions
): Effect.Effect<Keypair, KeyError> =>
  Effect.suspend(() => {
    const requested = options?.scheme
    if (requested !== undefined && !isKeyScheme(requested)) {
      return Effect.fail(
        keyError(
          "unsupportedScheme",
          `this constructor holds ED25519, Secp256k1 or Secp256r1 keys, not ${String(requested)}`
        )
      )
    }
    const build = (scheme: KeyScheme, bytes: Uint8Array): Effect.Effect<Keypair, KeyError> =>
      Effect.try({
        try: () => {
          if (bytes.length !== 32) throw new Error("wrong length")
          return keypairOver(scheme, bytes)
        },
        catch: () => keyError("invalidSecretKey", `the secret key is not a valid ${scheme} secret key`)
      })
    if (secret instanceof Uint8Array) return build(requested ?? "ED25519", secret)
    const text = (Redacted.isRedacted(secret) ? Redacted.value(secret) : secret).trim()
    if (text.toLowerCase().startsWith(SUI_PRIVATE_KEY_PREFIX)) {
      let parsed: { readonly scheme: string; readonly secretKey: Uint8Array }
      try {
        parsed = decodeSuiPrivateKey(text)
      } catch {
        // Never the decoder's message: it quotes the whole key.
        return Effect.fail(
          keyError("invalidSecretKey", "the secret key is not a valid suiprivkey1… Bech32 string (scheme or checksum)")
        )
      }
      const flagged = parsed.scheme
      if (flagged === "MLDSA65" && requested === undefined) {
        const secretKey = Uint8Array.from(parsed.secretKey)
        return Effect.tryPromise({
          try: async () => {
            const module: MLDSA65Module = await import(MLDSA65_MODULE)
            return module.MLDSA65Keypair.fromSecretKey(secretKey)
          },
          catch: () => keyError("invalidSecretKey", "the secret key is not a valid MLDSA65 secret key")
        })
      }
      if (!isKeyScheme(flagged)) {
        return Effect.fail(
          keyError(
            "unsupportedScheme",
            `the secret key is a ${flagged} key; this constructor holds ED25519, Secp256k1, Secp256r1 or MLDSA65 keys`
          )
        )
      }
      if (requested !== undefined && requested !== flagged) {
        return Effect.fail(
          keyError("unsupportedScheme", `the secret key is a ${flagged} key, but ${requested} was requested`)
        )
      }
      return build(flagged, parsed.secretKey)
    }
    const match = HEX_SEED.exec(text)
    if (match === null || match[1] === undefined) return Effect.fail(keyError("invalidSecretKey", SECRET_SPELLING))
    return build(requested ?? "ED25519", hexBytes(match[1]))
  })
