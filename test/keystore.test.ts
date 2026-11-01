import { describe, expect, test } from "bun:test"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { Effect, Exit, Layer, Redacted } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { SuiError } from "../src/domain/errors.ts"
import { KeystoreError } from "../src/domain/keys.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { DEFAULT_PREFIX, Keystore, MIN_LAYER_ITERATIONS } from "../src/keystore.ts"
import { Signer } from "../src/services/Signer.ts"

const PHRASE = "film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm"
const ADDRESS = SuiAddress.make("0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133")
const password = Redacted.make("correct horse battery staple")
const wrong = Redacted.make("correct horse battery stapler")
const message = new TextEncoder().encode("hello")

/** A keystore over an in-memory store the test can also reach, at test iterations. */
const layer = Layer.effect(Keystore, Keystore.make({ iterations: 1_000 })).pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
)

const run = <A, E>(effect: Effect.Effect<A, E, Keystore | KeyValueStore.KeyValueStore>) =>
  Effect.runPromise(Effect.provide(effect, layer))

const failure = <A, E>(effect: Effect.Effect<A, E, Keystore | KeyValueStore.KeyValueStore>) =>
  run(Effect.flip(effect))

const raw = (address: string) =>
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.get(`${DEFAULT_PREFIX}${address}`))

const put = (address: string, value: string) =>
  Effect.flatMap(KeyValueStore.KeyValueStore, (store) => store.set(`${DEFAULT_PREFIX}${address}`, value))

const verifies = async (signer: { readonly signPersonalMessage: (b: Uint8Array) => Effect.Effect<string, unknown> }, address: string) => {
  const signature = await Effect.runPromise(signer.signPersonalMessage(message))
  expect((await verifyPersonalMessageSignature(message, signature)).toSuiAddress()).toBe(address)
}

describe("Keystore: seal and open", () => {
  test("a mnemonic round-trips: import, list, unlock, sign, export", async () => {
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      const account = yield* keystore.importMnemonic(PHRASE, password, { label: "main" })
      const listed = yield* keystore.list
      const signer = yield* keystore.unlock(account.address, password)
      const mnemonic = yield* keystore.exportMnemonic(account.address, password)
      const secret = yield* keystore.exportSecretKey(account.address, password)
      return { account, listed, signer, mnemonic, secret }
    }))
    expect(result.account).toMatchObject({ address: ADDRESS, scheme: "ED25519", source: "mnemonic", path: "m/44'/784'/0'/0'/0'", label: "main" })
    expect(result.listed.map((account) => account.address)).toEqual([ADDRESS])
    await verifies(result.signer, ADDRESS)
    expect(Redacted.value(result.mnemonic)).toBe(PHRASE)
    expect(Ed25519Keypair.fromSecretKey(Redacted.value(result.secret)).toSuiAddress()).toBe(ADDRESS)
  })

  for (const [scheme, Keypair] of [["ED25519", Ed25519Keypair], ["Secp256k1", Secp256k1Keypair], ["Secp256r1", Secp256r1Keypair]] as const) {
    test(`an imported ${scheme} key round-trips and has no mnemonic`, async () => {
      const keypair = Keypair.generate()
      const bytes = Uint8Array.from(decodeSuiPrivateKey(keypair.getSecretKey()).secretKey)
      const copy = Uint8Array.from(bytes)
      const result = await run(Effect.gen(function*() {
        const keystore = yield* Keystore
        const account = yield* keystore.importSecretKey(bytes, password, { scheme })
        const signer = yield* keystore.unlock(account.address, password)
        const noMnemonic = yield* Effect.flip(keystore.exportMnemonic(account.address, password))
        const secret = yield* keystore.exportSecretKey(account.address, password)
        return { account, signer, noMnemonic, secret }
      }))
      // The caller's buffer is copied, never zeroed or kept.
      expect(bytes).toEqual(copy)
      expect(result.account.source).toBe("secretKey")
      expect(result.account.scheme).toBe(scheme)
      await verifies(result.signer, keypair.toSuiAddress())
      expect(result.noMnemonic.reason).toBe("noMnemonic")
      expect(Redacted.value(result.secret)).toBe(keypair.getSecretKey())
    })
  }

  test("generate answers a phrase that derives the stored account", async () => {
    const { account, mnemonic } = await run(Effect.gen(function*() {
      return yield* (yield* Keystore).generate(password, { words: 24, scheme: "Secp256r1" })
    }))
    expect(Redacted.value(mnemonic).split(" ")).toHaveLength(24)
    const derived = await Effect.runPromise(Signer.fromMnemonic(mnemonic, { scheme: "Secp256r1" }))
    expect(derived.address).toBe(account.address)
  })

  test("the stored record carries no secret in the clear", async () => {
    const stored = await run(Effect.gen(function*() {
      yield* (yield* Keystore).importMnemonic(PHRASE, password)
      return yield* raw(ADDRESS)
    }))
    expect(stored).toBeDefined()
    const record = JSON.parse(stored ?? "{}")
    expect(record).toMatchObject({
      version: 1,
      address: ADDRESS,
      kdf: { name: "PBKDF2-SHA256", iterations: 1_000 },
      cipher: { name: "AES-256-GCM" }
    })
    for (const word of PHRASE.split(" ").filter((word) => word.length > 4)) expect(stored).not.toContain(word)
    expect(stored).not.toContain("suiprivkey")
  })

  test("createdAt comes from the Clock", async () => {
    const account = await Effect.runPromise(Effect.gen(function*() {
      yield* TestClock.setTime(1_700_000_000_000)
      return yield* (yield* Keystore).importMnemonic(PHRASE, password)
    }).pipe(Effect.provide(Layer.merge(Keystore.layerTest, TestClock.layer()))))
    expect(account.createdAt.epochMilliseconds).toBe(1_700_000_000_000)
  })
})

describe("Keystore: refusals", () => {
  test("a wrong password is KeystoreError wrongPassword, not a defect", async () => {
    const error = await failure(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      return yield* keystore.unlock(ADDRESS, wrong)
    }))
    expect(error).toBeInstanceOf(KeystoreError)
    expect(error._tag).toBe("KeystoreError")
    if (error._tag !== "KeystoreError") return
    expect(error.reason).toBe("wrongPassword")
    expect(SuiError.outcome(error)).toBe("not_applied")
    expect(SuiError.describe(error)).not.toContain("staple")
  })

  test("a record copied onto another address does not open", async () => {
    const other = SuiAddress.make(Ed25519Keypair.generate().toSuiAddress())
    const errors = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const stored = (yield* raw(ADDRESS)) ?? ""
      // Copied verbatim under another key: the record names its own address.
      yield* put(other, stored)
      const moved = yield* Effect.flip(keystore.unlock(other, password))
      // Copied with its address field rewritten: the AAD no longer matches.
      yield* put(other, stored.replace(ADDRESS, other))
      const rewritten = yield* Effect.flip(keystore.unlock(other, password))
      return [moved, rewritten]
    }))
    for (const error of errors) {
      expect(error._tag).toBe("KeystoreError")
      if (error._tag === "KeystoreError") expect(error.reason).toBe("corrupt")
    }
  })

  test("tampered ciphertext, path or scheme is corrupt under the right password", async () => {
    const errors = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const stored = JSON.parse((yield* raw(ADDRESS)) ?? "{}")
      const bytes = Buffer.from(stored.ciphertext, "base64")
      bytes[0] = (bytes[0] ?? 0) ^ 1
      const results = []
      for (const edit of [
        { ...stored, ciphertext: bytes.toString("base64") },
        { ...stored, path: "m/44'/784'/1'/0'/0'" },
        { ...stored, scheme: "Secp256k1" }
      ]) {
        yield* put(ADDRESS, JSON.stringify(edit))
        results.push(yield* Effect.flip(keystore.unlock(ADDRESS, password)))
      }
      // The label is outside the AAD: renaming in place still opens.
      yield* put(ADDRESS, JSON.stringify({ ...stored, label: "renamed" }))
      const relabelled = yield* keystore.unlock(ADDRESS, password)
      return { results, relabelled }
    }))
    for (const error of errors.results) {
      expect(error._tag).toBe("KeystoreError")
      if (error._tag === "KeystoreError") expect(error.reason).toBe("corrupt")
    }
    expect(errors.relabelled.address).toBe(ADDRESS)
  })

  test("a newer format version is unsupported; garbage is corrupt; a downgraded KDF is corrupt", async () => {
    const reasons = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const stored = JSON.parse((yield* raw(ADDRESS)) ?? "{}")
      const out: Array<string> = []
      for (const value of [
        JSON.stringify({ ...stored, version: 2 }),
        "not json",
        JSON.stringify({ ...stored, kdf: { ...stored.kdf, iterations: 1 } })
      ]) {
        yield* put(ADDRESS, value)
        const error = yield* Effect.flip(keystore.unlock(ADDRESS, password))
        out.push(error.reason)
      }
      return out
    }))
    expect(reasons).toEqual(["unsupported", "corrupt", "corrupt"])
  })

  test("an address already stored is exists; a missing one notFound; an empty password invalidPassword", async () => {
    const reasons = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const again = yield* Effect.flip(keystore.importMnemonic(PHRASE, wrong))
      const missing = yield* Effect.flip(keystore.unlock(SuiAddress.make(`0x${"1".repeat(64)}`), password))
      const empty = yield* Effect.flip(keystore.importSecretKey(new Uint8Array(32).fill(9), Redacted.make("")))
      return [again, missing, empty].map((error) => error.reason)
    }))
    expect(reasons).toEqual(["exists", "notFound", "invalidPassword"])
  })

  test("an invalid phrase never reaches the store", async () => {
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      const error = yield* Effect.flip(keystore.importMnemonic(PHRASE.replace("film", "flim"), password))
      return { error, listed: yield* keystore.list }
    }))
    expect(result.error._tag).toBe("KeyError")
    expect(result.listed).toEqual([])
  })

  test("without WebCrypto every seal is KeystoreError unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    // Keep getRandomValues (the key decode does not need it), drop subtle.
    const { getRandomValues } = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", {
      value: { getRandomValues: getRandomValues.bind(globalThis.crypto) },
      configurable: true,
      writable: true
    })
    try {
      const error = await failure(Effect.gen(function*() {
        return yield* (yield* Keystore).importSecretKey(new Uint8Array(32).fill(9), password)
      }))
      expect(error.reason).toBe("unavailable")
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "crypto", original)
    }
  })

  test("Keystore.layer refuses an iteration count below the floor", () => {
    expect(() => Keystore.layer({ iterations: MIN_LAYER_ITERATIONS - 1 })).toThrow(RangeError)
    expect(() => Keystore.layer({ iterations: MIN_LAYER_ITERATIONS })).not.toThrow()
  })
})

describe("Keystore: lifecycle", () => {
  test("changePassword re-seals: the old password stops working, the new one opens", async () => {
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const before = JSON.parse((yield* raw(ADDRESS)) ?? "{}")
      const refused = yield* Effect.flip(keystore.changePassword(ADDRESS, wrong, wrong))
      yield* keystore.changePassword(ADDRESS, password, wrong)
      const after = JSON.parse((yield* raw(ADDRESS)) ?? "{}")
      const old = yield* Effect.flip(keystore.unlock(ADDRESS, password))
      const signer = yield* keystore.unlock(ADDRESS, wrong)
      const mnemonic = yield* keystore.exportMnemonic(ADDRESS, wrong)
      return { before, after, refused, old, signer, mnemonic }
    }))
    expect(result.refused.reason).toBe("wrongPassword")
    expect(result.old.reason).toBe("wrongPassword")
    expect(result.after.kdf.salt).not.toBe(result.before.kdf.salt)
    expect(result.after.cipher.iv).not.toBe(result.before.cipher.iv)
    expect(result.after.createdAt).toBe(result.before.createdAt)
    await verifies(result.signer, ADDRESS)
    expect(Redacted.value(result.mnemonic)).toBe(PHRASE)
  })

  test("remove deletes the record; a removed account is notFound", async () => {
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      yield* keystore.remove(ADDRESS)
      const again = yield* Effect.flip(keystore.remove(ADDRESS))
      return { listed: yield* keystore.list, again, stored: yield* raw(ADDRESS) }
    }))
    expect(result.listed).toEqual([])
    expect(result.again.reason).toBe("notFound")
    expect(result.stored).toBeUndefined()
  })

  test("an unlocked signer locks, and a scoped one locks with its scope", async () => {
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importMnemonic(PHRASE, password)
      const explicit = yield* keystore.unlock(ADDRESS, password)
      yield* explicit.lock
      const locked = yield* Effect.flip(explicit.signTransaction(message))
      const scoped = yield* Effect.scoped(Signer.scoped(keystore.unlock(ADDRESS, password)))
      return { locked, scoped: yield* scoped.locked }
    }))
    expect(result.locked.reason).toBe("locked")
    expect(result.scoped).toBe(true)
  })

  test("list is oldest first and reads several accounts", async () => {
    const listed = await Effect.runPromise(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* TestClock.setTime(2_000)
      yield* keystore.importSecretKey(new Uint8Array(32).fill(2), password)
      yield* TestClock.setTime(1_000)
      yield* keystore.importSecretKey(new Uint8Array(32).fill(1), password)
      return yield* keystore.list
    }).pipe(Effect.provide(Layer.merge(Keystore.layerTest, TestClock.layer()))))
    expect(listed.map((account) => account.createdAt.epochMilliseconds)).toEqual([1_000, 2_000])
    expect(listed[0]?.address).toBe(SuiAddress.make(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)).toSuiAddress()))
  })

  test("a prefix keeps two keystores apart in one store", async () => {
    const listed = await Effect.runPromise(Effect.gen(function*() {
      const a = yield* Keystore.make({ prefix: "a/", iterations: 1_000 })
      const b = yield* Keystore.make({ prefix: "b/", iterations: 1_000 })
      yield* a.importMnemonic(PHRASE, password)
      return { a: yield* a.list, b: yield* b.list }
    }).pipe(Effect.provide(KeyValueStore.layerMemory)))
    expect(listed.a).toHaveLength(1)
    expect(listed.b).toHaveLength(0)
  })

  test("a failed write leaves a typed storage error", async () => {
    const failing = Layer.succeed(
      KeyValueStore.KeyValueStore,
      KeyValueStore.makeStringOnly({
        get: () => Effect.sync((): string | undefined => undefined),
        set: (key) => Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "disk full" })),
        remove: () => Effect.void,
        clear: Effect.void,
        size: Effect.succeed(0),
        keys: Effect.succeed([])
      })
    )
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      return yield* (yield* Keystore).importMnemonic(PHRASE, password)
    }).pipe(Effect.provide(Layer.effect(Keystore, Keystore.make({ iterations: 1_000 })).pipe(Layer.provide(failing))))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason?._tag).toBe("Fail")
      if (reason?._tag === "Fail") expect(reason.error).toMatchObject({ _tag: "KeystoreError", reason: "storage" })
    }
  })
})

describe("exit codes for key and keystore refusals (0.5.0)", () => {
  test("input a person must fix exits 2; a store failure exits 4", async () => {
    const { Script } = await import("../src/services/Script.ts")
    const { KeyError } = await import("../src/domain/keys.ts")
    const code = (error: unknown) => Script.exitCode(Exit.fail(error))
    expect(code(new KeyError({ reason: "invalidMnemonic", message: "word 3 is not in the list" }))).toBe(2)
    for (const reason of ["wrongPassword", "invalidPassword", "notFound", "exists", "noMnemonic", "corrupt", "unsupported", "unavailable"] as const) {
      expect(code(new KeystoreError({ reason, message: reason }))).toBe(2)
    }
    expect(code(new KeystoreError({ reason: "storage", message: "the store failed" }))).toBe(4)
    // The getter stays out of the encoding and does not change the outcome.
    expect(SuiError.outcome(new KeystoreError({ reason: "wrongPassword", message: "no" }))).toBe("not_applied")
    expect(Object.keys(SuiError.toJson(new KeystoreError({ reason: "wrongPassword", message: "no" })))).not.toContain("exitCode")
  })
})

describe("Keystore: iteration bounds agree between seal and open (0.5.0)", () => {
  test("every constructor refuses a count open would refuse, or that is not an integer", () => {
    for (const iterations of [999, 1_500.5, 10_000_001, Number.NaN]) {
      expect(() => Keystore.make({ iterations })).toThrow(RangeError)
    }
    for (const iterations of [10_000_001, 600_000.5]) {
      expect(() => Keystore.layer({ iterations })).toThrow(RangeError)
    }
    expect(() => Keystore.make({ iterations: 1_000 })).not.toThrow()
    expect(() => Keystore.make({ iterations: 10_000_000 })).not.toThrow()
    expect(() => Keystore.layer({ iterations: 10_000_000 })).not.toThrow()
  })

  test("changePassword never replaces a working record with one that does not open", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    const real = globalThis.crypto
    const result = await run(Effect.gen(function*() {
      const keystore = yield* Keystore
      yield* keystore.importSecretKey(new Uint8Array(32).fill(9), password)
      const address = (yield* keystore.list)[0]?.address ?? ADDRESS
      const before = yield* raw(address)
      // A WebCrypto whose encrypt output does not verify: the re-seal is broken.
      const subtle = {
        importKey: real.subtle.importKey.bind(real.subtle),
        deriveBits: real.subtle.deriveBits.bind(real.subtle),
        digest: real.subtle.digest.bind(real.subtle),
        decrypt: real.subtle.decrypt.bind(real.subtle),
        encrypt: async (...args: Parameters<SubtleCrypto["encrypt"]>) => {
          const out = new Uint8Array(await real.subtle.encrypt(...args))
          out[0] = (out[0] ?? 0) ^ 1
          return out.buffer
        }
      }
      Object.defineProperty(globalThis, "crypto", {
        value: { subtle, getRandomValues: real.getRandomValues.bind(real) },
        configurable: true,
        writable: true
      })
      const refused = yield* Effect.flip(keystore.changePassword(address, password, wrong)).pipe(
        Effect.ensuring(Effect.sync(() => {
          if (original !== undefined) Object.defineProperty(globalThis, "crypto", original)
        }))
      )
      const after = yield* raw(address)
      const signer = yield* keystore.unlock(address, password)
      return { refused, before, after, signer, address }
    }))
    expect(result.refused._tag).toBe("KeystoreError")
    expect(result.after).toBe(result.before)
    await verifies(result.signer, result.address)
  })
})

describe("Keystore: derived key material is zeroed (0.5.0)", () => {
  test("the AES key half of the PBKDF2 output is zeroed once the key is imported", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    const real = globalThis.crypto
    const aesKeyData: Array<Uint8Array> = []
    const subtle = {
      importKey: (...args: Parameters<SubtleCrypto["importKey"]>) => {
        const [format, data, algorithm] = args
        if (format === "raw" && algorithm === "AES-GCM" && data instanceof Uint8Array) aesKeyData.push(data)
        return real.subtle.importKey(...args)
      },
      deriveBits: real.subtle.deriveBits.bind(real.subtle),
      digest: real.subtle.digest.bind(real.subtle),
      decrypt: real.subtle.decrypt.bind(real.subtle),
      encrypt: real.subtle.encrypt.bind(real.subtle)
    }
    Object.defineProperty(globalThis, "crypto", {
      value: { subtle, getRandomValues: real.getRandomValues.bind(real) },
      configurable: true,
      writable: true
    })
    try {
      await run(Effect.gen(function*() {
        const keystore = yield* Keystore
        const account = yield* keystore.importSecretKey(new Uint8Array(32).fill(9), password)
        yield* keystore.unlock(account.address, password)
      }))
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "crypto", original)
    }
    expect(aesKeyData).toHaveLength(2)
    for (const data of aesKeyData) expect(data.every((byte) => byte === 0)).toBe(true)
  })
})
