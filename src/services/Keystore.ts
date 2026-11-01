/**
 * `Keystore`: secret keys sealed at rest under a password, one record per
 * account, stored through `KeyValueStore` from `effect/persistence`.
 *
 * Reachable only through `@unconfirmed/sui-effect/keystore`, which (with
 * `/journal`) is the only part of the package that imports
 * `effect/persistence`. Storage is whatever `KeyValueStore` the application
 * provides: `KeyValueStore.layerMemory` in tests, `layerStorage` over
 * `localStorage`, an IndexedDB, AsyncStorage or `chrome.storage.local`
 * adapter in a browser, an app or an extension.
 *
 * **Platform requirement: WebCrypto.** Sealing and opening use
 * `crypto.subtle` (PBKDF2, AES-GCM, SHA-256) and `crypto.getRandomValues`
 * (salt, IV). Every browser, browser extension, Bun and Node ≥ 22 has both;
 * React Native has neither without a polyfill (e.g.
 * `react-native-quick-crypto`). Without them every operation that seals or
 * opens fails with `KeystoreError { reason: "unavailable" }`, never a defect.
 *
 * The format (DESIGN §19) is {@link SealedKey}, version 1:
 *
 * - **KDF**: PBKDF2-HMAC-SHA256, 600 000 iterations by default (OWASP's 2023
 *   figure for PBKDF2-SHA256), 16-byte random salt, 512 bits out. The first
 *   256 bits are the AES key (imported non-extractable); the second 256 are
 *   hashed into `check`, a key-check value that tells a wrong password
 *   (`wrongPassword`) from a record that was altered (`corrupt`) — at the same
 *   brute-force cost as trying the cipher, since both need the full KDF.
 * - **Cipher**: AES-256-GCM, 12-byte random IV per seal, 128-bit tag.
 * - **AAD**: `sui-effect/keystore/v1`, the address, the scheme, the source
 *   and the path, newline-separated. A record copied onto another address, or
 *   whose metadata was edited, does not open.
 * - **Plaintext**: the 32-byte secret key, followed for a mnemonic account by
 *   the normalized phrase in UTF-8. Unlocking reads only the 32 bytes, so the
 *   phrase never becomes a string unless `exportMnemonic` is asked for it.
 *
 * Secrets are never logged, never in an error message and never in a span
 * attribute. Plaintext buffers this module owns are zeroed after use.
 *
 * @since 0.5.0
 */
import { encodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Array as Arr, Context, DateTime, Effect, Layer, Option, Redacted, Result, Schema, Semaphore } from "effect"
import { Base64 } from "effect/encoding"
import { KeyValueStore } from "effect/persistence"
import type { KeyError } from "../domain/keys.ts"
import { KeystoreError } from "../domain/keys.ts"
import { SigningError } from "../domain/errors.ts"
import { SuiAddress } from "../domain/schemas.ts"
import type { SecretSealer } from "./ZkLoginSigner.ts"
import {
  type FromMnemonicOptions,
  type FromSecretKeyOptions,
  generateMnemonic,
  type HeldKey,
  heldFromMnemonic,
  heldFromSecretKey,
  holdKey,
  type KeyScheme,
  KeySchemeSchema,
  lockable,
  type LockableSigner,
  type MnemonicLength,
  wipeHeldKey
} from "./SignerKeys.ts"

/** The format version this release writes and reads. @since 0.5.0 */
export const KEYSTORE_VERSION = 1

/** PBKDF2-SHA256 iterations for a new seal: OWASP's 2023 recommendation. @since 0.5.0 */
export const DEFAULT_ITERATIONS = 600_000

/** The fewest iterations `Keystore.layer` accepts for a new seal. @since 0.5.0 */
export const MIN_LAYER_ITERATIONS = 100_000

/**
 * Outside `[1 000, 10 000 000]` a stored record is refused as `corrupt` (a
 * downgrade, or a denial of service), so no constructor seals outside it.
 */
const MIN_STORED_ITERATIONS = 1_000
const MAX_STORED_ITERATIONS = 10_000_000

/**
 * Throws a `RangeError` unless `iterations` is an integer in
 * `[floor, MAX_STORED_ITERATIONS]`: a count that seals records `open` would
 * refuse is a configuration mistake, caught where the keystore is built.
 */
const checkIterations = (who: string, iterations: number, floor: number): void => {
  if (!Number.isSafeInteger(iterations) || iterations < floor || iterations > MAX_STORED_ITERATIONS) {
    throw new RangeError(
      `${who}: iterations must be an integer in [${floor}, ${MAX_STORED_ITERATIONS}], got ${iterations}`
    )
  }
}

/** The `KeyValueStore` key prefix every record is stored under, by default. @since 0.5.0 */
export const DEFAULT_PREFIX = "sui-effect/keystore/"

const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_BYTES = 16
const SECRET_BYTES = 32
const CHECK_DOMAIN = "sui-effect/keystore/check/v1"
const AAD_DOMAIN = "sui-effect/keystore/v1"

/**
 * One sealed account as stored, version 1. Every byte field is standard
 * base64; `createdAt` is epoch milliseconds from the Effect `Clock`.
 *
 * Only `label` is outside the AAD, so it is the one field that may be edited
 * in place; every other edit makes the record `corrupt`.
 *
 * @since 0.5.0
 */
export const SealedKey = Schema.Struct({
  version: Schema.Literal(1),
  address: SuiAddress,
  scheme: KeySchemeSchema,
  source: Schema.Literals(["mnemonic", "secretKey"]),
  path: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  createdAt: Schema.DateTimeUtcFromMillis,
  kdf: Schema.Struct({
    name: Schema.Literal("PBKDF2-SHA256"),
    iterations: Schema.Int,
    salt: Schema.String
  }),
  cipher: Schema.Struct({
    name: Schema.Literal("AES-256-GCM"),
    iv: Schema.String
  }),
  check: Schema.String,
  ciphertext: Schema.String
})
/** @since 0.5.0 */
export type SealedKey = typeof SealedKey.Type

const SealedKeyJson = Schema.fromJsonString(SealedKey)
const decodeSealed = Schema.decodeUnknownEffect(SealedKeyJson)
const encodeSealed = Schema.encodeEffect(SealedKeyJson)
const decodeVersion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.Number }))
)

/**
 * What the keystore says about an account. Never carries secret material.
 *
 * @since 0.5.0
 */
export interface KeystoreAccount {
  readonly address: SuiAddress
  readonly scheme: KeyScheme
  /** Whether the account was derived from a recovery phrase (exportable) or imported as a key. */
  readonly source: "mnemonic" | "secretKey"
  /** The derivation path, for a mnemonic account. */
  readonly path?: string
  readonly label?: string
  readonly createdAt: DateTime.Utc
}

/** Options of `Keystore.layer` and `Keystore.make`. @since 0.5.0 */
export interface KeystoreOptions {
  /** The `KeyValueStore` key prefix. Default {@link DEFAULT_PREFIX}. */
  readonly prefix?: string
  /**
   * PBKDF2-SHA256 iterations for records sealed from now on (existing records
   * keep their own until `changePassword`). Default {@link DEFAULT_ITERATIONS}.
   * An integer of at most 10 000 000; `Keystore.layer` refuses fewer than
   * {@link MIN_LAYER_ITERATIONS}, `Keystore.make` fewer than 1 000.
   */
  readonly iterations?: number
}

/** The keystore's members. @since 0.5.0 */
export interface KeystoreService {
  /**
   * Every account, oldest first. Reads no secret and needs no password.
   *
   * Fails with: `KeystoreError` (`storage`; `corrupt` or `unsupported` when a
   * record does not decode as a version this release reads).
   */
  readonly list: Effect.Effect<ReadonlyArray<KeystoreAccount>, KeystoreError>
  /**
   * One account's public description.
   *
   * Fails with: `KeystoreError` (`notFound`, `corrupt`, `unsupported`, `storage`).
   */
  readonly account: (address: SuiAddress) => Effect.Effect<KeystoreAccount, KeystoreError>
  /**
   * A fresh recovery phrase (`Signer.generateMnemonic`), its account on the
   * standard path sealed under `password`. Answers the phrase once, redacted,
   * for the person to write down.
   *
   * Fails with: `KeyError` (`unavailable`), `KeystoreError` (`invalidPassword`,
   * `exists`, `unavailable`, `storage`).
   */
  readonly generate: (
    password: Redacted.Redacted<string>,
    options?: FromMnemonicOptions & { readonly words?: MnemonicLength; readonly label?: string }
  ) => Effect.Effect<{ readonly account: KeystoreAccount; readonly mnemonic: Redacted.Redacted<string> }, KeyError | KeystoreError>
  /**
   * Checks a recovery phrase (`Signer.fromMnemonic`'s rules: word list and
   * checksum), derives it and seals the key and the phrase under `password`.
   *
   * Fails with: `KeyError` (`invalidMnemonic`, `invalidPath`,
   * `unsupportedScheme`), `KeystoreError` (`invalidPassword`, `exists`,
   * `unavailable`, `storage`).
   */
  readonly importMnemonic: (
    phrase: Redacted.Redacted<string> | string,
    password: Redacted.Redacted<string>,
    options?: FromMnemonicOptions & { readonly label?: string }
  ) => Effect.Effect<KeystoreAccount, KeyError | KeystoreError>
  /**
   * Seals an imported secret key (`Signer.fromSecretKey`'s spellings) under
   * `password`. The caller's bytes are copied and left as they were.
   *
   * Fails with: `KeyError` (`invalidSecretKey`, `unsupportedScheme`),
   * `KeystoreError` (`invalidPassword`, `exists`, `unavailable`, `storage`).
   */
  readonly importSecretKey: (
    secret: Redacted.Redacted<string> | string | Uint8Array,
    password: Redacted.Redacted<string>,
    options?: FromSecretKeyOptions & { readonly label?: string }
  ) => Effect.Effect<KeystoreAccount, KeyError | KeystoreError>
  /**
   * Opens an account into a {@link LockableSigner}. The caller locks it
   * (`signer.lock`), or acquires it with `Signer.scoped` so the scope does.
   *
   * Fails with: `KeystoreError` (`wrongPassword`, `notFound`, `corrupt`,
   * `unsupported`, `unavailable`, `storage`).
   */
  readonly unlock: (address: SuiAddress, password: Redacted.Redacted<string>) => Effect.Effect<LockableSigner, KeystoreError>
  /**
   * Deletes an account's record. Needs no password: it destroys, it reveals
   * nothing.
   *
   * Fails with: `KeystoreError` (`notFound`, `storage`).
   */
  readonly remove: (address: SuiAddress) => Effect.Effect<void, KeystoreError>
  /**
   * Re-seals one account under a new password, with a fresh salt and IV and
   * the layer's current iteration count. The new record is opened under the
   * new password (one more PBKDF2 derivation) before it is written, so a
   * re-seal that does not open never replaces the stored record; that failure
   * is `corrupt` and leaves the store as it was.
   *
   * Fails with: `KeystoreError` (`wrongPassword`, `invalidPassword`,
   * `notFound`, `corrupt`, `unsupported`, `unavailable`, `storage`).
   */
  readonly changePassword: (
    address: SuiAddress,
    oldPassword: Redacted.Redacted<string>,
    newPassword: Redacted.Redacted<string>
  ) => Effect.Effect<void, KeystoreError>
  /**
   * The recovery phrase of a mnemonic account, redacted.
   *
   * Fails with: `KeystoreError` (`noMnemonic` for an imported key,
   * `wrongPassword`, `notFound`, `corrupt`, `unsupported`, `unavailable`,
   * `storage`).
   */
  readonly exportMnemonic: (
    address: SuiAddress,
    password: Redacted.Redacted<string>
  ) => Effect.Effect<Redacted.Redacted<string>, KeystoreError>
  /**
   * The account's secret key as a Bech32 `suiprivkey1…`, redacted.
   *
   * Fails with: `KeystoreError` (`wrongPassword`, `notFound`, `corrupt`,
   * `unsupported`, `unavailable`, `storage`).
   */
  readonly exportSecretKey: (
    address: SuiAddress,
    password: Redacted.Redacted<string>
  ) => Effect.Effect<Redacted.Redacted<string>, KeystoreError>
}

const keystoreError = (
  reason: KeystoreError["reason"],
  message: string,
  address?: SuiAddress
): KeystoreError => new KeystoreError(address === undefined ? { reason, message } : { reason, message, address })

const storageError = (address: SuiAddress | undefined) => (cause: KeyValueStore.KeyValueStoreError): KeystoreError =>
  new KeystoreError({
    reason: "storage",
    message: `the keystore's KeyValueStore failed (${cause.method})`,
    ...(address === undefined ? {} : { address }),
    cause
  })

/** The two WebCrypto entry points, or `undefined` on a platform without them. */
interface Crypto {
  readonly subtle: SubtleCrypto
  readonly random: (length: number) => Uint8Array<ArrayBuffer>
}

const cryptoOf = (): Crypto | undefined => {
  const crypto: unknown = Reflect.get(globalThis, "crypto")
  if (typeof crypto !== "object" || crypto === null) return undefined
  const subtle: unknown = Reflect.get(crypto, "subtle")
  const getRandomValues: unknown = Reflect.get(crypto, "getRandomValues")
  if (typeof subtle !== "object" || subtle === null || typeof getRandomValues !== "function") return undefined
  return {
    subtle: subtle as SubtleCrypto,
    random: (length) => Reflect.apply(getRandomValues, crypto, [new Uint8Array(length)])
  }
}

const UNAVAILABLE = "this platform has no WebCrypto (crypto.subtle and crypto.getRandomValues); " +
  "the keystore needs both — on React Native install a WebCrypto polyfill"

const requireCrypto = (address?: SuiAddress): Effect.Effect<Crypto, KeystoreError> =>
  Effect.suspend(() => {
    const crypto = cryptoOf()
    return crypto === undefined ? Effect.fail(keystoreError("unavailable", UNAVAILABLE, address)) : Effect.succeed(crypto)
  })

const utf8 = (text: string): Uint8Array<ArrayBuffer> => {
  const encoded = new TextEncoder().encode(text)
  const out = new Uint8Array(encoded.length)
  out.set(encoded)
  encoded.fill(0)
  return out
}

/** The AAD a record is sealed under: everything about it but its label, ciphertext and KDF inputs. */
const aadOf = (meta: {
  readonly address: SuiAddress
  readonly scheme: KeyScheme
  readonly source: "mnemonic" | "secretKey"
  readonly path?: string
}): Uint8Array<ArrayBuffer> => utf8([AAD_DOMAIN, meta.address, meta.scheme, meta.source, meta.path ?? ""].join("\n"))

/** The AES key and the key-check value PBKDF2 derives from a password. */
interface Derived {
  readonly key: CryptoKey
  readonly check: Uint8Array
}

const derive = (
  crypto: Crypto,
  password: Redacted.Redacted<string>,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  address: SuiAddress | undefined
): Effect.Effect<Derived, KeystoreError> =>
  Effect.tryPromise({
    try: async () => {
      const passwordBytes = utf8(Redacted.value(password))
      let bits: Uint8Array<ArrayBuffer> | undefined
      try {
        const base = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"])
        bits = new Uint8Array(
          await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, base, 512)
        )
        const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, ["encrypt", "decrypt"])
        const checkInput = new Uint8Array(CHECK_DOMAIN.length + 32)
        checkInput.set(utf8(CHECK_DOMAIN))
        checkInput.set(bits.subarray(32), CHECK_DOMAIN.length)
        const check = new Uint8Array(await crypto.subtle.digest("SHA-256", checkInput))
        checkInput.fill(0)
        return { key, check }
      } finally {
        passwordBytes.fill(0)
        bits?.fill(0)
      }
    },
    catch: () => keystoreError("unavailable", "this platform's WebCrypto could not derive the keystore key", address)
  })

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

const decode64 = (field: string, value: string, address: SuiAddress | undefined): Effect.Effect<Uint8Array<ArrayBuffer>, KeystoreError> => {
  const decoded = Base64.decode(value)
  if (Result.isFailure(decoded)) {
    return Effect.fail(keystoreError("corrupt", `the record's ${field} is not base64`, address))
  }
  const out = new Uint8Array(decoded.success.length)
  out.set(decoded.success)
  return Effect.succeed(out)
}

const nonEmpty = (password: Redacted.Redacted<string>, address?: SuiAddress): Effect.Effect<void, KeystoreError> =>
  Redacted.value(password).length === 0
    ? Effect.fail(keystoreError("invalidPassword", "a keystore password cannot be empty", address))
    : Effect.void

type Meta = Pick<SealedKey, "address" | "scheme" | "source" | "path" | "label" | "createdAt">

/** Seals `plaintext` (the caller zeroes its own) into a version-1 record. */
const seal = (
  meta: Meta,
  plaintext: Uint8Array,
  password: Redacted.Redacted<string>,
  iterations: number
): Effect.Effect<SealedKey, KeystoreError> =>
  Effect.gen(function*() {
    yield* nonEmpty(password, meta.address)
    const crypto = yield* requireCrypto(meta.address)
    const salt = crypto.random(SALT_BYTES)
    const iv = crypto.random(IV_BYTES)
    const { check, key } = yield* derive(crypto, password, salt, iterations, meta.address)
    const data = new Uint8Array(plaintext.length)
    data.set(plaintext)
    const ciphertext = yield* Effect.tryPromise({
      try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aadOf(meta), tagLength: 128 }, key, data),
      catch: () => keystoreError("unavailable", "this platform's WebCrypto could not encrypt the record", meta.address)
    }).pipe(Effect.ensuring(Effect.sync(() => data.fill(0))))
    return {
      version: KEYSTORE_VERSION,
      ...meta,
      kdf: { name: "PBKDF2-SHA256", iterations, salt: Base64.encode(salt) },
      cipher: { name: "AES-256-GCM", iv: Base64.encode(iv) },
      check: Base64.encode(check),
      ciphertext: Base64.encode(new Uint8Array(ciphertext))
    } satisfies SealedKey
  })

/**
 * Opens a record. The caller owns, and zeroes, the plaintext. A check-value
 * mismatch is `wrongPassword`; a tag that does not verify under a matching
 * check value is `corrupt` (edited, or moved onto another address).
 */
const open = (record: SealedKey, password: Redacted.Redacted<string>): Effect.Effect<Uint8Array<ArrayBuffer>, KeystoreError> =>
  Effect.gen(function*() {
    const address = record.address
    const iterations = record.kdf.iterations
    if (iterations < MIN_STORED_ITERATIONS || iterations > MAX_STORED_ITERATIONS) {
      return yield* keystoreError(
        "corrupt",
        `the record names ${iterations} PBKDF2 iterations, outside [${MIN_STORED_ITERATIONS}, ${MAX_STORED_ITERATIONS}]`,
        address
      )
    }
    const salt = yield* decode64("salt", record.kdf.salt, address)
    const iv = yield* decode64("iv", record.cipher.iv, address)
    const check = yield* decode64("check", record.check, address)
    const ciphertext = yield* decode64("ciphertext", record.ciphertext, address)
    if (salt.length < SALT_BYTES || iv.length !== IV_BYTES || check.length !== 32 || ciphertext.length < TAG_BYTES + SECRET_BYTES) {
      return yield* keystoreError("corrupt", "the record has a truncated salt, iv, check value or ciphertext", address)
    }
    const crypto = yield* requireCrypto(address)
    const derived = yield* derive(crypto, password, salt, iterations, address)
    if (!sameBytes(derived.check, check)) {
      return yield* keystoreError("wrongPassword", `the password does not open ${address}`, address)
    }
    const plaintext = yield* Effect.tryPromise({
      try: () => crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aadOf(record), tagLength: 128 }, derived.key, ciphertext),
      catch: () =>
        keystoreError(
          "corrupt",
          `the record of ${address} does not verify under its own password: it was edited or moved from another address`,
          address
        )
    })
    const bytes = new Uint8Array(plaintext)
    const expectMnemonic = record.source === "mnemonic"
    if (expectMnemonic ? bytes.length <= SECRET_BYTES : bytes.length !== SECRET_BYTES) {
      bytes.fill(0)
      return yield* keystoreError("corrupt", `the sealed content of ${address} does not match its source`, address)
    }
    return bytes
  })

const accountOf = (record: SealedKey): KeystoreAccount => ({
  address: record.address,
  scheme: record.scheme,
  source: record.source,
  ...(record.path === undefined ? {} : { path: record.path }),
  ...(record.label === undefined ? {} : { label: record.label }),
  createdAt: record.createdAt
})

/** The held key a record's plaintext names, checked against the record's address and scheme. */
const heldOf = (record: SealedKey, plaintext: Uint8Array): Effect.Effect<HeldKey, KeystoreError> =>
  Effect.suspend(() => {
    let held: HeldKey
    try {
      held = holdKey(record.scheme, plaintext.subarray(0, SECRET_BYTES))
    } catch {
      return Effect.fail(keystoreError("corrupt", `the sealed key of ${record.address} is not a valid ${record.scheme} key`, record.address))
    }
    if (held.keypair.toSuiAddress() !== record.address || held.keypair.getKeyScheme() !== record.scheme) {
      wipeHeldKey(held)
      return Effect.fail(keystoreError("corrupt", `the sealed key of ${record.address} is another address's key`, record.address))
    }
    return Effect.succeed(held)
  })

/**
 * The keystore over the `KeyValueStore` in context, for `Keystore.layer` and
 * for applications that build their own layer. Its floor on `iterations` is
 * 1 000, the fewest a stored record may name (`Keystore.layer`'s is
 * {@link MIN_LAYER_ITERATIONS}); the ceiling is 10 000 000 for both.
 *
 * **Throws** a `RangeError` when `options.iterations` is not an integer in
 * `[1 000, 10 000 000]`: those counts would seal records `unlock` refuses.
 * The effect never fails.
 *
 * @since 0.5.0
 */
export const make = (
  options?: KeystoreOptions
): Effect.Effect<KeystoreService, never, KeyValueStore.KeyValueStore> => {
  const iterations = options?.iterations ?? DEFAULT_ITERATIONS
  checkIterations("Keystore.make", iterations, MIN_STORED_ITERATIONS)
  return Effect.gen(function*() {
    const store = KeyValueStore.prefix(yield* KeyValueStore.KeyValueStore, options?.prefix ?? DEFAULT_PREFIX)
    const writes = yield* Semaphore.make(1)

    const read = (address: SuiAddress): Effect.Effect<SealedKey, KeystoreError> =>
      Effect.gen(function*() {
        const raw = yield* store.get(address).pipe(Effect.mapError(storageError(address)))
        if (raw === undefined) return yield* keystoreError("notFound", `no keystore record for ${address}`, address)
        return yield* decodeRecord(raw, address)
      })

    const decodeRecord = (raw: string, key: string): Effect.Effect<SealedKey, KeystoreError> =>
      Effect.gen(function*() {
        const keyAddress = SuiAddress.make(key)
        const version = yield* decodeVersion(raw).pipe(
          Effect.mapError(() => keystoreError("corrupt", `the record under ${key} is not a keystore record`, keyAddress))
        )
        if (version.version !== KEYSTORE_VERSION) {
          return yield* keystoreError(
            "unsupported",
            `the record under ${key} is format version ${version.version}; this release reads version ${KEYSTORE_VERSION}`,
            keyAddress
          )
        }
        const record = yield* decodeSealed(raw).pipe(
          Effect.mapError(() => keystoreError("corrupt", `the record under ${key} does not decode as a version-1 keystore record`, keyAddress))
        )
        if (record.address !== keyAddress) {
          return yield* keystoreError("corrupt", `the record under ${key} names another address: it was moved`, keyAddress)
        }
        return record
      })

    const encode = (record: SealedKey): Effect.Effect<string, KeystoreError> =>
      encodeSealed(record).pipe(
        Effect.mapError(() => keystoreError("corrupt", `the record of ${record.address} does not encode`, record.address))
      )

    const putRaw = (address: SuiAddress, json: string): Effect.Effect<void, KeystoreError> =>
      store.set(address, json).pipe(Effect.mapError(storageError(address)))

    const write = (record: SealedKey): Effect.Effect<void, KeystoreError> =>
      Effect.flatMap(encode(record), (json) => putRaw(record.address, json))

    /** Seals a held key as a new record, refusing an address already stored. */
    const add = (
      held: HeldKey,
      meta: { readonly source: "mnemonic" | "secretKey"; readonly path?: string; readonly label?: string },
      phrase: string | undefined,
      password: Redacted.Redacted<string>
    ): Effect.Effect<KeystoreAccount, KeystoreError> =>
      writes.withPermit(Effect.gen(function*() {
        const address = SuiAddress.make(held.keypair.toSuiAddress())
        const scheme = held.scheme
        yield* nonEmpty(password, address)
        const exists = yield* store.has(address).pipe(Effect.mapError(storageError(address)))
        if (exists) return yield* keystoreError("exists", `${address} is already in the keystore`, address)
        const phraseBytes = phrase === undefined ? new Uint8Array(0) : utf8(phrase)
        const plaintext = new Uint8Array(SECRET_BYTES + phraseBytes.length)
        plaintext.set(held.secret.subarray(0, SECRET_BYTES))
        plaintext.set(phraseBytes, SECRET_BYTES)
        phraseBytes.fill(0)
        const createdAt = yield* DateTime.now
        const record = yield* seal(
          {
            address,
            scheme,
            source: meta.source,
            ...(meta.path === undefined ? {} : { path: meta.path }),
            ...(meta.label === undefined ? {} : { label: meta.label }),
            createdAt
          },
          plaintext,
          password,
          iterations
        ).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
        yield* write(record)
        return accountOf(record)
      })).pipe(Effect.ensuring(Effect.sync(() => wipeHeldKey(held))))

    /** Runs `use` over a record's plaintext, zeroing it afterwards. */
    const withPlaintext = <A>(
      address: SuiAddress,
      password: Redacted.Redacted<string>,
      use: (record: SealedKey, plaintext: Uint8Array<ArrayBuffer>) => Effect.Effect<A, KeystoreError>
    ): Effect.Effect<A, KeystoreError> =>
      Effect.gen(function*() {
        const record = yield* read(address)
        const plaintext = yield* open(record, password)
        return yield* use(record, plaintext).pipe(Effect.ensuring(Effect.sync(() => plaintext.fill(0))))
      })

    const labelled = (label: string | undefined) => (label === undefined ? {} : { label })

    const service: KeystoreService = {
      list: Effect.gen(function*() {
        const keys = yield* store.keys.pipe(Effect.mapError(storageError(undefined)))
        const records = yield* Effect.forEach(
          keys.filter((key) => /^0x[0-9a-f]{64}$/.test(key)),
          (key) =>
            store.get(key).pipe(
              Effect.mapError(storageError(SuiAddress.make(key))),
              // Removed between `keys` and `get`: nothing to list.
              Effect.flatMap((raw) =>
                raw === undefined ? Effect.succeedNone : Effect.map(decodeRecord(raw, key), Option.some)
              )
            ),
          { concurrency: 8 }
        )
        return Arr.getSomes(records)
          .sort((a, b) =>
            DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt) ||
            (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)
          )
          .map(accountOf)
      }).pipe(Effect.withSpan("Keystore.list")),

      account: Effect.fn("Keystore.account")(function*(address: SuiAddress) {
        return accountOf(yield* read(address))
      }),

      generate: Effect.fn("Keystore.generate")(function*(
        password: Redacted.Redacted<string>,
        options?: FromMnemonicOptions & { readonly words?: MnemonicLength; readonly label?: string }
      ) {
        yield* nonEmpty(password)
        const mnemonic = yield* generateMnemonic(options?.words)
        const { held, normalized, path } = yield* heldFromMnemonic(mnemonic, options)
        const account = yield* add(held, { source: "mnemonic", path, ...labelled(options?.label) }, normalized, password)
        return { account, mnemonic }
      }),

      importMnemonic: Effect.fn("Keystore.importMnemonic")(function*(
        phrase: Redacted.Redacted<string> | string,
        password: Redacted.Redacted<string>,
        options?: FromMnemonicOptions & { readonly label?: string }
      ) {
        yield* nonEmpty(password)
        const { held, normalized, path } = yield* heldFromMnemonic(phrase, options)
        return yield* add(held, { source: "mnemonic", path, ...labelled(options?.label) }, normalized, password)
      }),

      importSecretKey: Effect.fn("Keystore.importSecretKey")(function*(
        secret: Redacted.Redacted<string> | string | Uint8Array,
        password: Redacted.Redacted<string>,
        options?: FromSecretKeyOptions & { readonly label?: string }
      ) {
        yield* nonEmpty(password)
        const held = yield* heldFromSecretKey(secret, options)
        return yield* add(held, { source: "secretKey", ...labelled(options?.label) }, undefined, password)
      }),

      unlock: Effect.fn("Keystore.unlock")(function*(address: SuiAddress, password: Redacted.Redacted<string>) {
        return yield* withPlaintext(address, password, (record, plaintext) => Effect.map(heldOf(record, plaintext), lockable))
      }),

      remove: Effect.fn("Keystore.remove")(function*(address: SuiAddress) {
        yield* writes.withPermit(Effect.gen(function*() {
          const exists = yield* store.has(address).pipe(Effect.mapError(storageError(address)))
          if (!exists) return yield* keystoreError("notFound", `no keystore record for ${address}`, address)
          yield* store.remove(address).pipe(Effect.mapError(storageError(address)))
        }))
      }),

      changePassword: Effect.fn("Keystore.changePassword")(function*(
        address: SuiAddress,
        oldPassword: Redacted.Redacted<string>,
        newPassword: Redacted.Redacted<string>
      ) {
        yield* nonEmpty(newPassword, address)
        yield* writes.withPermit(withPlaintext(address, oldPassword, (record, plaintext) =>
          Effect.gen(function*() {
            // Proves the plaintext is the address's key before re-sealing it.
            wipeHeldKey(yield* heldOf(record, plaintext))
            const { check: _check, cipher: _cipher, ciphertext: _ciphertext, kdf: _kdf, version: _version, ...meta } = record
            const json = yield* encode(yield* seal(meta, plaintext, newPassword, iterations))
            // The new record must open, through the path `unlock` takes, before
            // it replaces the old one: a re-seal that does not open would
            // destroy the only copy of the key.
            const unopenable = (cause: KeystoreError) =>
              new KeystoreError({
                reason: "corrupt",
                message: `the re-sealed record of ${address} does not open under the new password; the stored record is unchanged`,
                address,
                cause
              })
            const resealed = yield* decodeRecord(json, address).pipe(Effect.mapError(unopenable))
            const reopened = yield* open(resealed, newPassword).pipe(Effect.mapError(unopenable))
            const same = sameBytes(reopened, plaintext)
            reopened.fill(0)
            if (!same) return yield* unopenable(keystoreError("corrupt", "the re-sealed plaintext differs", address))
            yield* putRaw(address, json)
          })))
      }),

      exportMnemonic: Effect.fn("Keystore.exportMnemonic")(function*(address: SuiAddress, password: Redacted.Redacted<string>) {
        const record = yield* read(address)
        if (record.source !== "mnemonic") {
          return yield* keystoreError("noMnemonic", `${address} was imported as a secret key and has no recovery phrase`, address)
        }
        return yield* withPlaintext(address, password, (_record, plaintext) =>
          Effect.sync(() =>
            Redacted.make(new TextDecoder().decode(plaintext.subarray(SECRET_BYTES)), { label: "mnemonic" })
          ))
      }),

      exportSecretKey: Effect.fn("Keystore.exportSecretKey")(function*(address: SuiAddress, password: Redacted.Redacted<string>) {
        return yield* withPlaintext(address, password, (record, plaintext) =>
          Effect.map(heldOf(record, plaintext), (held) => {
            try {
              return Redacted.make(encodeSuiPrivateKey(held.secret, record.scheme), { label: "secretKey" })
            } finally {
              wipeHeldKey(held)
            }
          }))
      })
    }
    return service
  })
}

const SEALER_AAD_DOMAIN = "sui-effect/keystore/sealer/v1"

/**
 * One secret sealed by {@link sealer}, as the string `seal` answers: the
 * keystore's KDF and cipher parameters and its key-check value, version 1.
 * Every byte field is standard base64.
 *
 * @since 0.5.0
 */
export const SealedSecret = Schema.Struct({
  version: Schema.Literal(1),
  kdf: Schema.Struct({ name: Schema.Literal("PBKDF2-SHA256"), iterations: Schema.Int, salt: Schema.String }),
  cipher: Schema.Struct({ name: Schema.Literal("AES-256-GCM"), iv: Schema.String }),
  check: Schema.String,
  ciphertext: Schema.String
})
/** @since 0.5.0 */
export type SealedSecret = typeof SealedSecret.Type

const SealedSecretJson = Schema.fromJsonString(SealedSecret)
const decodeSealedSecret = Schema.decodeUnknownEffect(SealedSecretJson)
const encodeSealedSecret = Schema.encodeEffect(SealedSecretJson)

/** The AAD a sealed secret is bound to: the sealer's domain, then the caller's bytes. */
const sealerAad = (aad: Uint8Array): Uint8Array<ArrayBuffer> => {
  const domain = utf8(`${SEALER_AAD_DOMAIN}\n`)
  const out = new Uint8Array(domain.length + aad.length)
  out.set(domain)
  out.set(aad, domain.length)
  return out
}

/** A keystore failure as the `SigningError` a `SecretSealer` speaks. */
const asSigningError = (error: KeystoreError): SigningError =>
  error.reason === "wrongPassword"
    ? new SigningError({ reason: "locked", cause: error })
    : error.reason === "unavailable"
    ? new SigningError({ reason: "unavailable", cause: error })
    : new SigningError({ cause: error })

/**
 * A `SecretSealer` (what `ZkLogin.save` and `ZkLogin.load` take) in the
 * keystore's format: PBKDF2-HMAC-SHA256 over `password` (600 000 iterations
 * by default, 16-byte random salt, 512 bits: the AES key and the key-check
 * value), AES-256-GCM with a fresh 12-byte IV per seal, and as AAD
 * `sui-effect/keystore/sealer/v1`, a newline, then the caller's `aad` — for
 * a zkLogin session, its address — so a blob copied under another account's
 * entry does not unseal. The blob is {@link SealedSecret} as JSON.
 *
 * The password is held by the sealer for as long as the sealer lives: make
 * one when the person unlocks and drop it when they lock. Each `seal` and
 * `unseal` costs one PBKDF2 derivation.
 *
 * **Throws** a `RangeError` when `options.iterations` is not an integer from
 * {@link MIN_LAYER_ITERATIONS} to 10 000 000, `Keystore.layer`'s bounds
 * (`unseal` refuses a blob naming more than 10 000 000). Its members
 * fail with: `SigningError` — `reason: "locked"` for a wrong password,
 * `reason: "unavailable"` without WebCrypto, and no reason for an empty
 * password, an empty secret or a blob that was edited, moved or is not one.
 *
 * @since 0.5.0
 *
 * @example
 * ```ts
 * import { Effect, Redacted } from "effect"
 * import { KeyValueStore } from "effect/persistence"
 * import { Keystore } from "@unconfirmed/sui-effect/keystore"
 * import { ZkLogin, type ZkLoginSession } from "@unconfirmed/sui-effect/tx"
 *
 * declare const session: ZkLoginSession
 * declare const ephemeralSecretKey: Redacted.Redacted<Uint8Array>
 *
 * const program = Effect.gen(function*() {
 *   const store = yield* KeyValueStore.KeyValueStore
 *   const sealer = Keystore.sealer(Redacted.make("correct horse battery staple"))
 *   yield* ZkLogin.save(store, "zklogin", { session, ephemeralSecretKey, sealer })
 *   return yield* ZkLogin.load(store, "zklogin", { sealer })
 * })
 * ```
 */
export const sealer = (
  password: Redacted.Redacted<string>,
  options?: { readonly iterations?: number }
): SecretSealer => {
  const iterations = options?.iterations ?? DEFAULT_ITERATIONS
  checkIterations("Keystore.sealer", iterations, MIN_LAYER_ITERATIONS)
  return {
    seal: Effect.fn("Keystore.seal")(function*(secret: Redacted.Redacted<Uint8Array>, aad: Uint8Array) {
      return yield* Effect.gen(function*() {
        yield* nonEmpty(password)
        const plaintext = Redacted.value(secret)
        if (plaintext.length === 0) {
          return yield* keystoreError("corrupt", "there is no secret to seal: it is empty")
        }
        const crypto = yield* requireCrypto()
        const salt = crypto.random(SALT_BYTES)
        const iv = crypto.random(IV_BYTES)
        const { check, key } = yield* derive(crypto, password, salt, iterations, undefined)
        const data = new Uint8Array(plaintext.length)
        data.set(plaintext)
        const ciphertext = yield* Effect.tryPromise({
          try: () => crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: sealerAad(aad), tagLength: 128 }, key, data),
          catch: () => keystoreError("unavailable", "this platform's WebCrypto could not encrypt the secret")
        }).pipe(Effect.ensuring(Effect.sync(() => data.fill(0))))
        return yield* encodeSealedSecret({
          version: KEYSTORE_VERSION,
          kdf: { name: "PBKDF2-SHA256", iterations, salt: Base64.encode(salt) },
          cipher: { name: "AES-256-GCM", iv: Base64.encode(iv) },
          check: Base64.encode(check),
          ciphertext: Base64.encode(new Uint8Array(ciphertext))
        }).pipe(Effect.orDie)
      }).pipe(Effect.mapError(asSigningError))
    }),
    unseal: Effect.fn("Keystore.unseal")(function*(sealed: string, aad: Uint8Array) {
      return yield* Effect.gen(function*() {
        const record = yield* decodeSealedSecret(sealed).pipe(
          Effect.mapError(() => keystoreError("corrupt", "this is not a secret Keystore.sealer sealed"))
        )
        const stored = record.kdf.iterations
        if (stored < MIN_STORED_ITERATIONS || stored > MAX_STORED_ITERATIONS) {
          return yield* keystoreError(
            "corrupt",
            `the sealed secret names ${stored} PBKDF2 iterations, outside [${MIN_STORED_ITERATIONS}, ${MAX_STORED_ITERATIONS}]`
          )
        }
        const salt = yield* decode64("salt", record.kdf.salt, undefined)
        const iv = yield* decode64("iv", record.cipher.iv, undefined)
        const check = yield* decode64("check", record.check, undefined)
        const ciphertext = yield* decode64("ciphertext", record.ciphertext, undefined)
        if (salt.length < SALT_BYTES || iv.length !== IV_BYTES || check.length !== 32 || ciphertext.length <= TAG_BYTES) {
          return yield* keystoreError("corrupt", "the sealed secret has a truncated salt, iv, check value or ciphertext")
        }
        const crypto = yield* requireCrypto()
        const derived = yield* derive(crypto, password, salt, stored, undefined)
        if (!sameBytes(derived.check, check)) {
          return yield* keystoreError("wrongPassword", "the password does not unseal this secret")
        }
        const plaintext = yield* Effect.tryPromise({
          try: () =>
            crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: sealerAad(aad), tagLength: 128 }, derived.key, ciphertext),
          catch: () =>
            keystoreError("corrupt", "the sealed secret does not verify under its own password: it was edited or moved from another entry")
        })
        return Redacted.make(new Uint8Array(plaintext), { label: "secret" })
      }).pipe(Effect.mapError(asSigningError))
    })
  }
}

/**
 * The sealed keystore: `Keystore.layer(options?)` over a `KeyValueStore`,
 * `Keystore.layerTest` in memory for tests.
 *
 * @since 0.5.0
 */
export class Keystore extends Context.Service<Keystore, KeystoreService>()(
  "@unconfirmed/sui-effect/Keystore"
) {
  /**
   * The service over the `KeyValueStore` in context, for an application that
   * builds its own layer. **Throws** a `RangeError` for `iterations` that is
   * not an integer in `[1 000, 10 000 000]`; the effect never fails.
   */
  static readonly make = make

  /** See {@link sealer}: a `SecretSealer` (for `ZkLogin.save`/`load`) in the keystore's format. */
  static readonly sealer = sealer

  /**
   * The keystore over the `KeyValueStore` in context. Builds without reading
   * anything.
   *
   * **Throws** a `RangeError` when `options.iterations` is not an integer from
   * {@link MIN_LAYER_ITERATIONS} to 10 000 000 — fewer would make every
   * record cheap to brute-force, more would seal records `unlock` refuses.
   * Otherwise never fails.
   */
  static readonly layer = (
    options?: KeystoreOptions
  ): Layer.Layer<Keystore, never, KeyValueStore.KeyValueStore> => {
    checkIterations("Keystore.layer", options?.iterations ?? DEFAULT_ITERATIONS, MIN_LAYER_ITERATIONS)
    return Layer.effect(Keystore, make(options))
  }

  /**
   * An in-memory keystore (`KeyValueStore.layerMemory`) sealing with 1 000
   * PBKDF2 iterations, so a test does not spend seconds per seal. **Not for
   * production**: those records are cheap to brute-force. Never fails.
   */
  static readonly layerTest: Layer.Layer<Keystore> = Layer.effect(Keystore, make({ iterations: 1_000 })).pipe(
    Layer.provide(KeyValueStore.layerMemory)
  )
}
