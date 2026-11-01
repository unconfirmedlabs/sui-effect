/**
 * `Keystore.sealer` (0.5.0, DESIGN §19): the keystore's PBKDF2 / AES-GCM
 * format as the `SecretSealer` `ZkLogin.save` and `ZkLogin.load` take, round
 * tripped over `KeyValueStore.layerMemory` and over the IndexedDB stand-in.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { fromBase64, toBase64 } from "@mysten/sui/utils"
import { computeZkLoginAddressFromSeed, genAddressSeed } from "@mysten/sui/zklogin"
import { Effect, Layer, Option, Redacted } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Keystore, MIN_LAYER_ITERATIONS, SealedSecret, sealer } from "../src/keystore.ts"
import { layerIndexedDb } from "../src/storage.ts"
import { ZkLogin, type ZkLoginSession } from "../src/services/ZkLoginSigner.ts"
import { makeFakeIndexedDb } from "./storage-fakes.ts"

const NOW = 1_700_000_000_000
const ISS = "https://accounts.google.com"
const base64Url = (text: string) =>
  toBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
const ADDRESS_SEED = genAddressSeed(BigInt(1234), "sub", "user-1", "client-1").toString()
const proof = {
  proofPoints: { a: ["1", "2", "1"], b: [["1", "0"], ["1", "0"], ["1", "0"]], c: ["1", "2", "1"] },
  issBase64Details: { value: base64Url(`"iss":"${ISS}",`), indexMod4: 0 },
  headerBase64: base64Url("{\"alg\":\"RS256\"}"),
  addressSeed: ADDRESS_SEED
}
const ZK_ADDRESS = SuiAddress.make(computeZkLoginAddressFromSeed(BigInt(ADDRESS_SEED), ISS, false))
const ephemeralSeed = new Uint8Array(32).fill(7)
const ephemeral = Ed25519Keypair.fromSecretKey(ephemeralSeed)
const session: ZkLoginSession = { address: ZK_ADDRESS, maxEpoch: 101n, proof, expiresAt: NOW + 60_000 }

const PASSWORD = Redacted.make("correct horse battery staple")
// The floor `Keystore.layer` enforces, so the suite does not spend seconds per seal.
const keyed = sealer(PASSWORD, { iterations: MIN_LAYER_ITERATIONS })

const withStore = <A, E>(
  store: Layer.Layer<KeyValueStore.KeyValueStore>,
  effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore | TestClock.TestClock>
) =>
  Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      yield* TestClock.setTime(NOW)
      return yield* effect
    }),
    Layer.mergeAll(store, TestClock.layer()),
    { local: true }
  ))

const stores: ReadonlyArray<readonly [string, () => Layer.Layer<KeyValueStore.KeyValueStore>]> = [
  ["KeyValueStore.layerMemory", () => KeyValueStore.layerMemory],
  ["the IndexedDB stand-in", () => layerIndexedDb({ indexedDB: makeFakeIndexedDb().factory })]
]

describe("Keystore.sealer as the zkLogin SecretSealer", () => {
  for (const [name, store] of stores) {
    test(`save → load round-trips a session over ${name}, writing only the sealed blob`, async () => {
      const { raw, loaded, signature } = await withStore(store(), Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* ZkLogin.save(kv, "zk", { session, ephemeralSecretKey: Redacted.make(ephemeralSeed), sealer: keyed })
        const raw = yield* kv.get("zk")
        const loaded = yield* ZkLogin.load(kv, "zk", { sealer: keyed })
        const signature = Option.isSome(loaded) ? yield* loaded.value.signPersonalMessage(new Uint8Array([1])) : undefined
        return { raw, loaded, signature }
      }))
      expect(raw).toBeDefined()
      expect(raw!.includes(toBase64(ephemeralSeed))).toBe(false)
      expect(raw!.includes(ephemeral.getSecretKey())).toBe(false)
      const blob = JSON.parse(JSON.parse(raw!).ephemeral.sealed) as SealedSecret
      expect(blob.version).toBe(1)
      expect(blob.kdf).toMatchObject({ name: "PBKDF2-SHA256", iterations: MIN_LAYER_ITERATIONS })
      expect(fromBase64(blob.kdf.salt)).toHaveLength(16)
      expect(blob.cipher.name).toBe("AES-256-GCM")
      expect(fromBase64(blob.cipher.iv)).toHaveLength(12)
      // 32 bytes of seed and a 16-byte tag.
      expect(fromBase64(blob.ciphertext)).toHaveLength(48)
      expect(Option.isSome(loaded) && loaded.value.address).toBe(ZK_ADDRESS)
      expect(signature).toBeDefined()
    })
  }

  test("a wrong password is SigningError { reason: locked }", async () => {
    const error = await withStore(KeyValueStore.layerMemory, Effect.gen(function*() {
      const kv = yield* KeyValueStore.KeyValueStore
      yield* ZkLogin.save(kv, "zk", { session, ephemeralSecretKey: Redacted.make(ephemeralSeed), sealer: keyed })
      return yield* Effect.flip(ZkLogin.load(kv, "zk", {
        sealer: sealer(Redacted.make("not it"), { iterations: MIN_LAYER_ITERATIONS })
      }))
    }))
    expect(error._tag).toBe("SigningError")
    expect(error.reason).toBe("locked")
  })

  test("the address is the AAD: a blob under another address does not unseal", async () => {
    const other = SuiAddress.make(`0x${"ab".repeat(32)}`)
    const { error, again } = await Effect.runPromise(Effect.gen(function*() {
      const blob = yield* keyed.seal(Redacted.make(ephemeralSeed), new TextEncoder().encode(ZK_ADDRESS))
      const error = yield* Effect.flip(keyed.unseal(blob, new TextEncoder().encode(other)))
      const again = yield* keyed.unseal(blob, new TextEncoder().encode(ZK_ADDRESS))
      return { error, again }
    }))
    expect(error._tag).toBe("SigningError")
    expect(error.reason).toBeUndefined()
    expect(error.message).toContain("moved")
    expect(Redacted.value(again)).toEqual(ephemeralSeed)
  })

  test("two seals of one secret differ (fresh salt and IV); an edited blob is refused", async () => {
    const aad = new TextEncoder().encode(ZK_ADDRESS)
    const { first, second, edited } = await Effect.runPromise(Effect.gen(function*() {
      const first = yield* keyed.seal(Redacted.make(ephemeralSeed), aad)
      const second = yield* keyed.seal(Redacted.make(ephemeralSeed), aad)
      const parsed = JSON.parse(first) as SealedSecret
      const bytes = fromBase64(parsed.ciphertext)
      bytes[0] = bytes[0]! ^ 1
      const edited = yield* Effect.flip(keyed.unseal(JSON.stringify({ ...parsed, ciphertext: toBase64(bytes) }), aad))
      return { first, second, edited }
    }))
    expect(first).not.toBe(second)
    expect(edited.reason).toBeUndefined()
    const junk = await Effect.runPromise(Effect.flip(keyed.unseal("not a blob", aad)))
    expect(junk._tag).toBe("SigningError")
  })

  test("is Keystore.sealer, and refuses fewer iterations than Keystore.layer", () => {
    expect(Keystore.sealer).toBe(sealer)
    expect(() => sealer(PASSWORD, { iterations: 1_000 })).toThrow(RangeError)
  })

  test("refuses more iterations than unseal accepts, so it never seals an unopenable blob", () => {
    expect(() => sealer(PASSWORD, { iterations: 10_000_001 })).toThrow(RangeError)
    expect(() => sealer(PASSWORD, { iterations: 10_000_000 })).not.toThrow()
  })
})
