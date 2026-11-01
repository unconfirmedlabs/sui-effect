import { describe, expect, test } from "bun:test"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { verifyPersonalMessageSignature } from "@mysten/sui/verify"
import { validateMnemonic } from "@scure/bip39"
import { wordlist } from "@scure/bip39/wordlists/english.js"
import { Effect, Exit, Fiber, Redacted, Scheduler } from "effect"
import { SigningError, SuiError } from "../src/domain/errors.ts"
import { KeyError } from "../src/domain/keys.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { fromRedactedSecret, Signer } from "../src/services/Signer.ts"
import { holdKey, keypairOf, wipeHeldKey } from "../src/services/SignerKeys.ts"

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)
const fail = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromise(Effect.exit(effect))
  if (Exit.isSuccess(exit)) throw new Error("expected a failure")
  const error = exit.cause.reasons[0]
  if (error === undefined || error._tag !== "Fail") throw new Error(`expected a typed failure, got ${String(exit.cause)}`)
  return error.error
}

// The SDK's own test vectors (Ed25519, Secp256r1) and one Secp256k1 phrase.
const ED_PHRASE = "film crazy soon outside stand loop subway crumble thrive popular green nuclear struggle pistol arm wife phrase warfare march wheat nephew ask sunny firm"
const ED_ADDRESS = SuiAddress.make("0xa2d14fad60c56049ecf75246a481934691214ce413e6a8ae2fe6834c173a6133")
const K1_PHRASE = "result crisp session latin must fruit genuine question prevent start coconut brave speak student dismiss"
const K1_ADDRESS = SuiAddress.make("0x7ec1b6df34a4018c377109851af1cf70db6687dd4a880a51f9119af86d855643")
const R1_PHRASE = "act wing dilemma glory episode region allow mad tourist humble muffin oblige"
const R1_ADDRESS = SuiAddress.make("0x4a822457f1970468d38dae8e63fb60eefdaa497d74d781f581ea2d137ec36f3a")

const message = new TextEncoder().encode("hello")

describe("Signer.fromMnemonic", () => {
  const vectors = [
    ["ED25519", ED_PHRASE, ED_ADDRESS, Ed25519Keypair] as const,
    ["Secp256k1", K1_PHRASE, K1_ADDRESS, Secp256k1Keypair] as const,
    ["Secp256r1", R1_PHRASE, R1_ADDRESS, Secp256r1Keypair] as const
  ]

  for (const [scheme, phrase, address, Keypair] of vectors) {
    test(`derives the SDK's ${scheme} account on the standard path`, async () => {
      const signer = await run(Signer.fromMnemonic(phrase, { scheme }))
      expect(signer.address).toBe(address)
      expect(signer.scheme).toBe(scheme)
      expect<string>(signer.address).toBe(Keypair.deriveKeypair(phrase).toSuiAddress())
      // A signature from it verifies as that address's.
      const signature = await run(signer.signPersonalMessage(message))
      const publicKey = await verifyPersonalMessageSignature(message, signature)
      expect(publicKey.toSuiAddress()).toBe(address)
    })

    test(`${scheme} account 3 is the SDK's derivation on path index 3`, async () => {
      const path = Signer.derivationPath(scheme, 3)
      const signer = await run(Signer.fromMnemonic(Redacted.make(phrase), { scheme, account: 3 }))
      expect<string>(signer.address).toBe(Keypair.deriveKeypair(phrase, path).toSuiAddress())
      const explicit = await run(Signer.fromMnemonic(phrase, { scheme, path }))
      expect(explicit.address).toBe(signer.address)
    })
  }

  test("the standard paths are the SDK's defaults", () => {
    expect(Signer.derivationPath("ED25519")).toBe("m/44'/784'/0'/0'/0'")
    expect(Signer.derivationPath("Secp256k1", 7)).toBe("m/54'/784'/7'/0/0")
    expect(Signer.derivationPath("Secp256r1", 2)).toBe("m/74'/784'/2'/0/0")
    expect(() => Signer.derivationPath("ED25519", -1)).toThrow(RangeError)
    expect(() => Signer.derivationPath("ED25519", 2 ** 31)).toThrow(RangeError)
  })

  test("normalizes spacing and case before checking", async () => {
    const messy = `  ${ED_PHRASE.toUpperCase().split(" ").join("   \n")}  `
    const signer = await run(Signer.fromMnemonic(messy))
    expect(signer.address).toBe(ED_ADDRESS)
  })

  test("a phrase one word off is refused, never derived", async () => {
    const words = ED_PHRASE.split(" ")
    // Swap the last word for another list word that breaks the checksum.
    const other = wordlist.find((word) => {
      const candidate = [...words.slice(0, -1), word].join(" ")
      return word !== words.at(-1) && !validateMnemonic(candidate, wordlist)
    })
    if (other === undefined) throw new Error("no checksum-breaking word found")
    const typo = [...words.slice(0, -1), other].join(" ")
    // The SDK derives it without complaint: this is the bug being guarded.
    expect(Ed25519Keypair.deriveKeypair(typo).toSuiAddress()).toMatch(/^0x[0-9a-f]{64}$/)
    const error = await fail(Signer.fromMnemonic(typo))
    expect(error).toBeInstanceOf(KeyError)
    expect(error.reason).toBe("invalidMnemonic")
    expect(error.message).toContain("checksum")
    expect(error.message).not.toContain(other)
    expect(SuiError.outcome(error)).toBe("not_applied")
  })

  test("a word outside the list is named by position, never by the word", async () => {
    const words = ED_PHRASE.split(" ")
    words[4] = "notaword"
    const error = await fail(Signer.fromMnemonic(words.join(" ")))
    expect(error.reason).toBe("invalidMnemonic")
    expect(error.message).toContain("word 5")
    expect(error.message).not.toContain("notaword")
    expect(SuiError.describe(error)).not.toContain("notaword")
  })

  test("a wrong word count, a bad path and a bad account are typed failures", async () => {
    expect((await fail(Signer.fromMnemonic("abandon abandon abandon"))).reason).toBe("invalidMnemonic")
    expect((await fail(Signer.fromMnemonic(ED_PHRASE, { path: "m/54'/784'/0'/0/0" }))).reason).toBe("invalidPath")
    expect((await fail(Signer.fromMnemonic(ED_PHRASE, { scheme: "Secp256k1", path: "m/74'/784'/0'/0/0" }))).reason)
      .toBe("invalidPath")
    expect((await fail(Signer.fromMnemonic(ED_PHRASE, { path: "m/44'/784'/4294967296'/0'/0'" }))).reason)
      .toBe("invalidPath")
    expect((await fail(Signer.fromMnemonic(ED_PHRASE, { account: 1.5 }))).reason).toBe("invalidPath")
  })
})

describe("Signer.generateMnemonic", () => {
  test("answers a valid, redacted phrase of the requested length", async () => {
    for (const words of [12, 24] as const) {
      const phrase = await run(Signer.generateMnemonic(words))
      expect(String(phrase)).not.toContain(" ")
      const text = Redacted.value(phrase)
      expect(text.split(" ")).toHaveLength(words)
      expect(validateMnemonic(text, wordlist)).toBe(true)
      await run(Signer.fromMnemonic(phrase))
    }
    const a = Redacted.value(await run(Signer.generateMnemonic()))
    const b = Redacted.value(await run(Signer.generateMnemonic()))
    expect(a).not.toBe(b)
  })

  test("without crypto.getRandomValues it fails with KeyError unavailable, not a defect", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true })
    try {
      const error = await fail(Signer.generateMnemonic())
      expect(error.reason).toBe("unavailable")
    } finally {
      if (original !== undefined) Object.defineProperty(globalThis, "crypto", original)
    }
  })
})

describe("Signer.fromSecretKey", () => {
  const cases = [
    ["ED25519", Ed25519Keypair] as const,
    ["Secp256k1", Secp256k1Keypair] as const,
    ["Secp256r1", Secp256r1Keypair] as const
  ]

  for (const [scheme, Keypair] of cases) {
    test(`reads a Bech32 ${scheme} key, a hex seed and raw bytes`, async () => {
      const keypair = Keypair.generate()
      const bech32 = keypair.getSecretKey()
      const bytes = decodeSuiPrivateKey(bech32).secretKey
      const hex = Buffer.from(bytes).toString("hex")
      const fromBech32 = await run(Signer.fromSecretKey(Redacted.make(bech32)))
      const fromHex = await run(Signer.fromSecretKey(`0x${hex}`, { scheme }))
      const fromBytes = await run(Signer.fromSecretKey(bytes, { scheme }))
      for (const signer of [fromBech32, fromHex, fromBytes]) {
        expect<string>(signer.address).toBe(keypair.toSuiAddress())
        expect(signer.scheme).toBe(scheme)
      }
    })

    test(`copies the caller's ${scheme} bytes before building the keypair`, async () => {
      const keypair = Keypair.generate()
      const bytes = Uint8Array.from(decodeSuiPrivateKey(keypair.getSecretKey()).secretKey)
      const signer = await run(Signer.fromSecretKey(bytes, { scheme }))
      // The caller zeroes (or reuses) its buffer: the signer is unaffected.
      bytes.fill(0)
      const signature = await run(signer.signPersonalMessage(message))
      const publicKey = await verifyPersonalMessageSignature(message, signature)
      expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress())
    })
  }

  test("the SDK's ECDSA keypairs alias the caller's buffer, which is why the copy exists", () => {
    const bytes = Uint8Array.from(decodeSuiPrivateKey(Secp256k1Keypair.generate().getSecretKey()).secretKey)
    const direct = Secp256k1Keypair.fromSecretKey(bytes)
    const before = direct.getSecretKey()
    bytes[0] = (bytes[0] ?? 0) ^ 1
    expect(direct.getSecretKey()).not.toBe(before)
  })

  test("a bad key is a fixed message that never quotes the input", async () => {
    const key = Ed25519Keypair.generate().getSecretKey()
    const typo = `${key.slice(0, -3)}${key.at(-3) === "q" ? "p" : "q"}${key.slice(-2)}`
    const error = await fail(Signer.fromSecretKey(typo))
    expect(error.reason).toBe("invalidSecretKey")
    expect(error.message).not.toContain(typo.slice(12, 40))
    expect(JSON.stringify(SuiError.toJson(error))).not.toContain(typo.slice(12, 40))
    expect((await fail(Signer.fromSecretKey("hello"))).reason).toBe("invalidSecretKey")
    expect((await fail(Signer.fromSecretKey(new Uint8Array(31)))).reason).toBe("invalidSecretKey")
  })

  test("a scheme that contradicts the key's flag, or one with no mnemonic keypair, is refused", async () => {
    const key = Ed25519Keypair.generate().getSecretKey()
    expect((await fail(Signer.fromSecretKey(key, { scheme: "Secp256k1" }))).reason).toBe("unsupportedScheme")
  })
})

describe("LockableSigner", () => {
  test("lock drops the secret: signatures fail with SigningError locked", async () => {
    const signer = await run(Signer.fromMnemonic(ED_PHRASE))
    expect(await run(signer.locked)).toBe(false)
    await run(signer.signTransaction(message))
    await run(signer.lock)
    await run(signer.lock) // idempotent
    expect(await run(signer.locked)).toBe(true)
    for (const sign of [signer.signTransaction, signer.signPersonalMessage]) {
      const error = await fail(sign(message))
      expect(error).toBeInstanceOf(SigningError)
      expect(error.reason).toBe("locked")
      expect(SuiError.outcome(error)).toBe("not_applied")
    }
    // The address stays readable: a locked account is still an account.
    expect(signer.address).toBe(ED_ADDRESS)
  })

  for (const scheme of ["ED25519", "Secp256k1", "Secp256r1"] as const) {
    test(`wiping a held ${scheme} key zeroes both the owned buffer and the SDK keypair's copy`, () => {
      const seed = new Uint8Array(32).fill(7)
      const held = holdKey(scheme, seed)
      expect(seed.every((byte) => byte === 7)).toBe(true)
      wipeHeldKey(held)
      expect(held.secret.every((byte) => byte === 0)).toBe(true)
      // The SDK's own buffer (reached the same structural way the wipe does).
      const inner = Reflect.get(Reflect.get(held.keypair, "keypair"), "secretKey") as Uint8Array
      expect(inner.every((byte) => byte === 0)).toBe(true)
    })
  }

  for (const scheme of ["ED25519", "Secp256k1", "Secp256r1"] as const) {
    test(`a ${scheme} lock racing a signature answers the real key's signature or locked, nothing else`, async () => {
      const seed = new Uint8Array(32).fill(9)
      const expected = holdKey(scheme, seed).keypair.toSuiAddress()
      // Every interleaving the scheduler can produce: yield before the lock 0..n times.
      for (const yields of [0, 1, 2, 3, 4, 5, 6, 8]) {
        const exit = await Effect.runPromise(Effect.gen(function*() {
          const signer = yield* Signer.fromSecretKey(Uint8Array.from(seed), { scheme })
          const fiber = yield* Effect.forkChild(Effect.exit(signer.signPersonalMessage(message)))
          for (let i = 0; i < yields; i++) yield* Effect.yieldNow
          yield* signer.lock
          return yield* Fiber.join(fiber)
        }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 5)))
        if (Exit.isSuccess(exit)) {
          const publicKey = await verifyPersonalMessageSignature(message, exit.value)
          expect(publicKey.toSuiAddress()).toBe(expected)
        } else {
          const reason = exit.cause.reasons[0]
          expect(reason?._tag).toBe("Fail")
          if (reason?._tag === "Fail") {
            expect(reason.error).toBeInstanceOf(SigningError)
            expect(reason.error.reason).toBe("locked")
          }
        }
      }
    })
  }

  test("Signer.scoped locks when the scope closes, on success and failure", async () => {
    const kept = await run(Effect.scoped(Signer.scoped(Signer.fromMnemonic(ED_PHRASE))))
    expect(await run(kept.locked)).toBe(true)
    let held: { readonly locked: Effect.Effect<boolean> } | undefined
    const exit = await Effect.runPromise(Effect.exit(Effect.scoped(Effect.gen(function*() {
      held = yield* Signer.scoped(Signer.fromMnemonic(ED_PHRASE))
      return yield* Effect.fail("boom")
    }))))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(held === undefined ? false : await run(held.locked)).toBe(true)
  })

  test("carries no secret material on the value", async () => {
    const signer = await run(Signer.fromMnemonic(ED_PHRASE))
    expect(Object.keys(signer).sort()).toEqual([
      "address",
      "lock",
      "locked",
      "scheme",
      "signPersonalMessage",
      "signTransaction"
    ])
    expect(JSON.stringify(signer)).not.toContain("suiprivkey")
  })
})

describe("Signer.fromConfig copies before it builds", () => {
  test("a Secp256k1 key read from config is not aliased to the decoded buffer", async () => {
    const keypair = Secp256k1Keypair.generate()
    const signer = await run(fromRedactedSecret(Redacted.make(keypair.getSecretKey()), "KEY"))
    const signature = await run(signer.signPersonalMessage(message))
    const publicKey = await verifyPersonalMessageSignature(message, signature)
    expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress())
  })
})

describe("keypairOf keeps no orphaned copy of the secret (0.5.0)", () => {
  for (const scheme of ["ED25519", "Secp256k1", "Secp256r1"] as const) {
    test(`${scheme}: the held buffer is zeroed unless the keypair signs with it`, async () => {
      const held = holdKey(scheme, new Uint8Array(32).fill(9))
      const keypair = keypairOf(held)
      const sdkOwn = Reflect.get(Reflect.get(keypair, "keypair"), "secretKey")
      if (sdkOwn === held.secret) {
        expect(held.secret.some((byte) => byte !== 0)).toBe(true)
      } else {
        expect(held.secret.every((byte) => byte === 0)).toBe(true)
      }
      // Ed25519 copies, so its held buffer is the orphan this zeroes.
      if (scheme === "ED25519") expect(sdkOwn).not.toBe(held.secret)
      const { signature } = await keypair.signPersonalMessage(message)
      expect((await verifyPersonalMessageSignature(message, signature)).toSuiAddress()).toBe(keypair.toSuiAddress())
    })
  }
})
