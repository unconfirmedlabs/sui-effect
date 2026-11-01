/**
 * Keys the process holds: BIP-39 phrases checked before anything is derived,
 * the standard Sui derivation paths, secret keys copied before a keypair is
 * built over them, and the lockable signer that can drop them again.
 *
 * Internal; the public names are on the `Signer` namespace (`Signer.ts`).
 *
 * **Why every derivation goes through {@link validateMnemonic} first.** The
 * SDK's `deriveKeypair` feeds any string into `mnemonicToSeedSync` and never
 * checks the word list or the checksum, so a mistyped phrase derives a valid,
 * empty account — a person "restores" a wallet and sees a zero balance.
 *
 * **Why the ECDSA keypairs are built over a copy.** `Secp256k1Keypair` and
 * `Secp256r1Keypair` keep a **reference** to the bytes they are given and sign
 * with them, so a caller that zeroes its buffer breaks the keypair, and a
 * caller that mutates it changes the key. `Ed25519Keypair` copies. Here every
 * keypair is built over a buffer this module allocated and nobody else holds,
 * and every intermediate this module owns (decoded Bech32 bytes, the BIP-39
 * seed, the HD nodes) is zeroed once the keypair exists.
 *
 * Nothing here calls `getSecretKey()`: it returns an immutable string that can
 * never be wiped.
 *
 * @since 0.5.0
 */
import type { Keypair, SignatureScheme } from "@mysten/sui/cryptography"
import {
  decodeSuiPrivateKey,
  isValidBIP32Path,
  isValidHardenedPath,
  SUI_PRIVATE_KEY_PREFIX
} from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { HDKey } from "@scure/bip32"
import { entropyToMnemonic, mnemonicToSeed, validateMnemonic as checksumOk } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { Effect, Redacted, Schema } from "effect"
import { SigningError } from "../domain/errors.ts"
import { KeyError } from "../domain/keys.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"
import type { Signer } from "./Signer.ts"

/**
 * The schemes a key at rest can be: the three a BIP-39 phrase derives on the
 * standard Sui paths. (`MLDSA65` has its own path family and is read only by
 * `Signer.fromConfig`; `ZkLogin`, `Passkey` and `MultiSig` hold no secret key.)
 *
 * @since 0.5.0
 */
export type KeyScheme = "ED25519" | "Secp256k1" | "Secp256r1"

/** @internal */
export const KeySchemeSchema = Schema.Literals(["ED25519", "Secp256k1", "Secp256r1"])

const isKeyScheme = (value: string): value is KeyScheme =>
  value === "ED25519" || value === "Secp256k1" || value === "Secp256r1"

/**
 * A {@link Signer} that holds a secret and can drop it.
 *
 * `lock` is **disposal, one way**: it zeroes the secret bytes the signer owns,
 * zeroes the keypair's own copy where the SDK keeps one, and releases the
 * keypair. Afterwards both members fail with `SigningError { reason:
 * "locked" }`; there is no unlock — open the account again (`Keystore.unlock`,
 * `Signer.fromMnemonic`) for a new signer. `lock` is idempotent and never
 * fails. A `lock` racing a signature cannot land mid-signature: the signature
 * either answers by the real key (it was computed before the lock) or fails
 * with `reason: "locked"`.
 *
 * A `LockableSigner` **is** a `Signer`: every function that takes a signer
 * takes this one, and it carries no secret either — the keypair lives in a
 * closure, not on the value.
 *
 * @since 0.5.0
 */
export interface LockableSigner extends Signer {
  /** Drops the secret; every later signature fails with `reason: "locked"`. Never fails. */
  readonly lock: Effect.Effect<void>
  /** Whether {@link lock} has run. Never fails. */
  readonly locked: Effect.Effect<boolean>
}

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

/**
 * The keypair of `scheme` over `secret`, which **this module allocated** and
 * nobody else holds. An ECDSA keypair signs with that very buffer (it keeps
 * the reference), an Ed25519 keypair with its own copy; either way the caller
 * gets back the buffer the keypair depends on, to zero at lock.
 */
const keypairOver = (scheme: KeyScheme, secret: Uint8Array): Keypair => {
  switch (scheme) {
    case "ED25519":
      return Ed25519Keypair.fromSecretKey(secret)
    case "Secp256k1":
      return Secp256k1Keypair.fromSecretKey(secret)
    case "Secp256r1":
      return Secp256r1Keypair.fromSecretKey(secret)
  }
}

/** A keypair and the one buffer of secret bytes this module owns for it. */
export interface HeldKey {
  readonly scheme: KeyScheme
  readonly keypair: Keypair
  readonly secret: Uint8Array
}

/**
 * Builds a keypair over a **copy** of `bytes` (the caller keeps and may zero
 * its own). Throws on bytes that are not a valid key of `scheme`; the copy is
 * zeroed first.
 */
export const holdKey = (scheme: KeyScheme, bytes: Uint8Array): HeldKey => {
  const secret = Uint8Array.from(bytes)
  try {
    return { scheme, keypair: keypairOver(scheme, secret), secret }
  } catch (error) {
    secret.fill(0)
    throw error
  }
}

/**
 * The SDK keypair's own secret buffer, read structurally. Every keypair class
 * keeps `{ publicKey, secretKey }` in a TypeScript-private `keypair` field;
 * for the ECDSA classes it is the buffer {@link holdKey} passed in, for
 * Ed25519 the copy the constructor made. This is the only reach past the
 * SDK's public surface in the package, it is best effort (an SDK that renames
 * the field leaves its copy to the collector), and `test/keys.test.ts` proves
 * it on the installed SDK.
 */
const sdkSecretOf = (keypair: Keypair): Uint8Array | undefined => {
  const inner: unknown = Reflect.get(keypair, "keypair")
  if (typeof inner !== "object" || inner === null) return undefined
  const secret: unknown = Reflect.get(inner, "secretKey")
  return secret instanceof Uint8Array ? secret : undefined
}

/** Zeroes what a {@link HeldKey} owns, and the SDK's copy where it keeps one. */
export const wipeHeldKey = (held: HeldKey): void => {
  held.secret.fill(0)
  sdkSecretOf(held.keypair)?.fill(0)
}

/**
 * The keypair of a {@link HeldKey}, for a caller that keeps only the keypair
 * (`Signer.fromConfig`). The held buffer is zeroed when it is not the one the
 * keypair signs with — Ed25519, whose constructor copied it — so no orphaned
 * copy of the secret is left for the collector. An ECDSA keypair signs with
 * the held buffer itself, which is therefore kept.
 */
export const keypairOf = (held: HeldKey): Keypair => {
  const own = sdkSecretOf(held.keypair)
  if (own !== undefined && own !== held.secret) held.secret.fill(0)
  return held.keypair
}

const decodeSignature = Schema.decodeUnknownEffect(Signature)

/** The rejection a locked signer's sign thunk answers, told apart from the SDK's own. */
const LOCKED: unique symbol = Symbol("sui-effect/locked")

const lockedError = () =>
  new SigningError({
    cause: "this signer is locked: its secret was dropped; open the account again for a new signer",
    reason: "locked"
  })

/**
 * The {@link LockableSigner} over a held key. The key lives in this closure
 * only; `lock` wipes it and drops the reference.
 */
export const lockable = (held: HeldKey): LockableSigner => {
  let current: HeldKey | undefined = held
  const address = SuiAddress.make(held.keypair.toSuiAddress())
  const scheme: SignatureScheme = held.keypair.getKeyScheme()
  const withKey = (
    sign: (keypair: Keypair) => Promise<{ readonly signature: string }>
  ): Effect.Effect<Signature, SigningError> =>
    Effect.tryPromise({
      // `current` is read and the SDK call started in this one synchronous
      // thunk, so no fiber (no `lock`) can run between them. Every SDK keypair
      // computes its signature synchronously inside the call, before its first
      // `await` (`signWithIntent` hashes, then evaluates `this.sign(digest)`,
      // whose body is one synchronous noble call), so a `lock` lands either
      // before this thunk, and the answer is `locked`, or after the signature
      // by the real key already exists.
      try: () => {
        const key = current
        return key === undefined ? Promise.reject(LOCKED) : sign(key.keypair)
      },
      catch: (cause) => (cause === LOCKED ? lockedError() : new SigningError({ cause }))
    }).pipe(
      Effect.flatMap((result) =>
        decodeSignature(result.signature).pipe(
          Effect.mapError((issue) =>
            new SigningError({ cause: `the signer returned a signature this version cannot read: ${issue.message}` })
          )
        )
      )
    )
  return {
    address,
    scheme,
    signTransaction: Effect.fn("Signer.signTransaction")(function*(bytes: Uint8Array) {
      return yield* withKey((keypair) => keypair.signTransaction(bytes))
    }),
    signPersonalMessage: Effect.fn("Signer.signPersonalMessage")(function*(bytes: Uint8Array) {
      return yield* withKey((keypair) => keypair.signPersonalMessage(bytes))
    }),
    lock: Effect.sync(() => {
      const key = current
      current = undefined
      if (key !== undefined) wipeHeldKey(key)
    }),
    locked: Effect.sync(() => current === undefined)
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
    try {
      return Effect.succeed(Redacted.make(entropyToMnemonic(entropy, wordlist), { label: "mnemonic" }))
    } finally {
      entropy.fill(0)
    }
  })

/**
 * Derives the held key of `scheme` on `path` from a **validated, normalized**
 * phrase. The 64-byte seed and the HD nodes are zeroed before this returns.
 */
export const deriveHeldKey = (
  normalized: string,
  scheme: KeyScheme,
  path: string
): Effect.Effect<HeldKey, KeyError> =>
  Effect.tryPromise({
    try: async () => {
      const seed = await mnemonicToSeed(normalized)
      try {
        if (scheme === "ED25519") {
          const derived = Ed25519Keypair.deriveKeypairFromSeed(seed, path)
          const own = sdkSecretOf(derived)
          if (own === undefined) return { scheme, keypair: derived, secret: new Uint8Array(0) }
          // Re-hold over a buffer this module owns, then wipe the derived one.
          const held = holdKey(scheme, own)
          own.fill(0)
          return held
        }
        const root = HDKey.fromMasterSeed(seed)
        const node = root.derive(path)
        // `privateKey` is a copy; both nodes' own copies are wiped below.
        const privateKey = node.privateKey
        try {
          if (privateKey === null) throw new Error("no private key on the derived node")
          return holdKey(scheme, privateKey)
        } finally {
          privateKey?.fill(0)
          node.wipePrivateData()
          root.wipePrivateData()
        }
      } finally {
        seed.fill(0)
      }
    },
    catch: () => keyError("invalidPath", `could not derive a ${scheme} key on ${path}`)
  })

/** The path `options` name for `scheme`, checked. */
export const pathOf = (scheme: KeyScheme, options: FromMnemonicOptions | undefined): Effect.Effect<string, KeyError> =>
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
 * `Signer.fromMnemonic`'s body, answering the held key and what it was
 * derived from, so the keystore can seal the same thing.
 */
export const heldFromMnemonic = (
  phrase: Redacted.Redacted<string> | string,
  options?: FromMnemonicOptions
): Effect.Effect<{ readonly held: HeldKey; readonly normalized: string; readonly path: string; readonly scheme: KeyScheme }, KeyError> =>
  Effect.gen(function*() {
    const scheme = options?.scheme ?? "ED25519"
    if (!isKeyScheme(scheme)) {
      return yield* keyError("unsupportedScheme", `a recovery phrase derives ED25519, Secp256k1 or Secp256r1 keys, not ${String(scheme)}`)
    }
    const path = yield* pathOf(scheme, options)
    const normalized = yield* validateMnemonic(Redacted.isRedacted(phrase) ? Redacted.value(phrase) : phrase)
    const held = yield* deriveHeldKey(normalized, scheme, path)
    return { held, normalized, path, scheme }
  })

/** A raw 32-byte secret as hexadecimal, with or without the `0x`. */
const HEX_SEED = /^(?:0x)?([0-9a-fA-F]{64})$/

const hexBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

const SECRET_SPELLING = "a secret key is a Bech32 suiprivkey1… string, 64 hex digits (a 32-byte seed, 0x optional) or 32 raw bytes"

/**
 * `Signer.fromSecretKey`'s body. Decoded bytes are copied into the held key and
 * zeroed; the caller's own `Uint8Array` is copied and left as it was.
 */
export const heldFromSecretKey = (
  secret: Redacted.Redacted<string> | string | Uint8Array,
  options?: FromSecretKeyOptions
): Effect.Effect<HeldKey, KeyError> =>
  Effect.suspend(() => {
    const requested = options?.scheme
    if (requested !== undefined && !isKeyScheme(requested)) {
      return Effect.fail(keyError("unsupportedScheme", `this constructor holds ED25519, Secp256k1 or Secp256r1 keys, not ${String(requested)}`))
    }
    const build = (scheme: KeyScheme, bytes: Uint8Array, owned: boolean): Effect.Effect<HeldKey, KeyError> =>
      Effect.try({
        try: () => {
          if (bytes.length !== 32) throw new Error("wrong length")
          return holdKey(scheme, bytes)
        },
        catch: () => keyError("invalidSecretKey", `the secret key is not a valid ${scheme} secret key`)
      }).pipe(Effect.ensuring(Effect.sync(() => owned && bytes.fill(0))))
    if (secret instanceof Uint8Array) return build(requested ?? "ED25519", secret, false)
    const text = (Redacted.isRedacted(secret) ? Redacted.value(secret) : secret).trim()
    if (text.toLowerCase().startsWith(SUI_PRIVATE_KEY_PREFIX)) {
      let parsed: { readonly scheme: string; readonly secretKey: Uint8Array }
      try {
        parsed = decodeSuiPrivateKey(text)
      } catch {
        // Never the decoder's message: it quotes the whole key.
        return Effect.fail(keyError("invalidSecretKey", "the secret key is not a valid suiprivkey1… Bech32 string (scheme or checksum)"))
      }
      const flagged = parsed.scheme
      if (!isKeyScheme(flagged)) {
        parsed.secretKey.fill(0)
        return Effect.fail(keyError("unsupportedScheme", `the secret key is a ${flagged} key; this constructor holds ED25519, Secp256k1 or Secp256r1 keys`))
      }
      if (requested !== undefined && requested !== flagged) {
        parsed.secretKey.fill(0)
        return Effect.fail(keyError("unsupportedScheme", `the secret key is a ${flagged} key, but ${requested} was requested`))
      }
      return build(flagged, parsed.secretKey, true)
    }
    const match = HEX_SEED.exec(text)
    if (match === null || match[1] === undefined) return Effect.fail(keyError("invalidSecretKey", SECRET_SPELLING))
    return build(requested ?? "ED25519", hexBytes(match[1]), true)
  })
