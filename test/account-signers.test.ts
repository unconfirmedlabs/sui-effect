/**
 * 0.5.0 account signers (W3): zkLogin sessions and their store, passkeys,
 * Wallet Standard wallets, the sponsored-bytes check, and Enoki sponsorship
 * through the journal. Every party here is an in-memory stand-in: no prover,
 * no authenticator, no wallet extension, no Enoki API.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair, Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils"
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify"
import { computeZkLoginAddressFromSeed, genAddressSeed, parseZkLoginSignature } from "@mysten/sui/zklogin"
import { Effect, Layer, Option, Redacted } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { SigningError, SuiError } from "../src/domain/errors.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Enoki, type EnokiClient, EnokiError } from "../src/enoki.ts"
import { isUserRejection, type PasskeyProvider } from "../src/services/AccountSigners.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair, Signer } from "../src/services/Signer.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { type SecretSealer, ZkLogin, type ZkLoginSession } from "../src/services/ZkLoginSigner.ts"
import { layerTest } from "../src/testing.ts"
import { verifySponsored } from "../src/tx.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const NOW = 1_700_000_000_000

// ---------------------------------------------------------------------------
// A zkLogin session with no prover: proof points are placeholders, but the
// issuer claim and the address seed are real, so the address derives.
// ---------------------------------------------------------------------------

const ISS = "https://accounts.google.com"
const base64Url = (text: string) =>
  toBase64(new TextEncoder().encode(text)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
// `"iss":"https://accounts.google.com",` is 36 characters: 48 base64 digits, no padding, indexMod4 0.
const issClaim = `"iss":"${ISS}",`
const ADDRESS_SEED = genAddressSeed(BigInt(1234), "sub", "user-1", "client-1").toString()
const proof = {
  proofPoints: { a: ["1", "2", "1"], b: [["1", "0"], ["1", "0"], ["1", "0"]], c: ["1", "2", "1"] },
  issBase64Details: { value: base64Url(issClaim), indexMod4: 0 },
  headerBase64: base64Url("{\"alg\":\"RS256\"}"),
  addressSeed: ADDRESS_SEED
}
const ZK_ADDRESS = SuiAddress.make(computeZkLoginAddressFromSeed(BigInt(ADDRESS_SEED), ISS, false))
const ephemeralSeed = new Uint8Array(32).fill(3)
const ephemeral = Ed25519Keypair.fromSecretKey(ephemeralSeed)
const MAX_EPOCH = 101n

const session: ZkLoginSession = { address: ZK_ADDRESS, maxEpoch: MAX_EPOCH, proof, expiresAt: NOW + 60_000 }

/** Full transaction bytes valid during `[minEpoch, minEpoch + 1]` on CHAIN_ID. */
const bytesFrom = async (sender: string, minEpoch: bigint, gasOwner?: string) => {
  const tx = new Transaction()
  tx.setSender(sender)
  if (gasOwner !== undefined) tx.setGasOwner(gasOwner)
  tx.setGasPayment([])
  tx.setGasBudget(1_000_000)
  tx.setGasPrice(1_000)
  tx.setExpiration({
    ValidDuring: {
      minEpoch: minEpoch.toString(),
      maxEpoch: (minEpoch + 1n).toString(),
      minTimestamp: null,
      maxTimestamp: null,
      chain: CHAIN_ID,
      nonce: 7
    }
  })
  tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
  return tx.build()
}

const runClock = <A, E>(effect: Effect.Effect<A, E, TestClock.TestClock>) =>
  Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      yield* TestClock.setTime(NOW)
      return yield* effect
    }),
    TestClock.layer()
  ))

describe("Signer.zkLogin", () => {
  test("signs as the zkLogin address with scheme ZkLogin and the session's maxEpoch", async () => {
    const bytes = await bytesFrom(ZK_ADDRESS, 100n)
    const message = new TextEncoder().encode("hello")
    const { signer, signature, personal } = await runClock(Effect.gen(function*() {
      const signer = yield* Signer.zkLogin({ session, ephemeral })
      const signature = yield* signer.signTransaction(bytes)
      const personal = yield* signer.signPersonalMessage(message)
      return { signer, signature, personal }
    }))
    expect(signer.address).toBe(ZK_ADDRESS)
    expect(signer.scheme).toBe("ZkLogin")
    expect(signer.maxEpoch).toBe(MAX_EPOCH)
    // The wrapped signature carries the proof and maxEpoch, and the ephemeral
    // signature inside it is a valid signature over these very bytes.
    const parsed = parseZkLoginSignature(fromBase64(signature).slice(1))
    expect(parsed.maxEpoch).toBe(MAX_EPOCH.toString())
    expect(parsed.inputs.addressSeed).toBe(ADDRESS_SEED)
    const inner = toBase64(parsed.userSignature)
    expect(await new Ed25519PublicKey(ephemeral.getPublicKey().toRawBytes()).verifyTransaction(bytes, inner)).toBe(true)
    const parsedPersonal = parseZkLoginSignature(fromBase64(personal).slice(1))
    expect(await ephemeral.getPublicKey().verifyPersonalMessage(message, toBase64(parsedPersonal.userSignature)))
      .toBe(true)
  })

  test("bytes that cannot start before an epoch past maxEpoch are expired", async () => {
    const bytes = await bytesFrom(ZK_ADDRESS, MAX_EPOCH + 1n)
    const error = await runClock(Effect.gen(function*() {
      const signer = yield* Signer.zkLogin({ session, ephemeral })
      return yield* Effect.flip(signer.signTransaction(bytes))
    }))
    expect(error._tag).toBe("SigningError")
    expect(error.reason).toBe("expired")
    // The session's last epoch itself is still fine.
    const ok = await runClock(Effect.gen(function*() {
      const signer = yield* Signer.zkLogin({ session, ephemeral })
      return yield* signer.signTransaction(yield* Effect.promise(() => bytesFrom(ZK_ADDRESS, MAX_EPOCH)))
    }))
    expect(ok.length).toBeGreaterThan(0)
  })

  test("past expiresAt the session is expired, at construction and at signing", async () => {
    const atConstruction = await runClock(Effect.gen(function*() {
      yield* TestClock.adjust("2 minutes")
      return yield* Effect.flip(Signer.zkLogin({ session, ephemeral }))
    }))
    expect(atConstruction.reason).toBe("expired")
    const atSigning = await runClock(Effect.gen(function*() {
      const signer = yield* Signer.zkLogin({ session, ephemeral })
      yield* TestClock.adjust("2 minutes")
      return yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1])))
    }))
    expect(atSigning.reason).toBe("expired")
  })

  test("a proof that does not derive the address is refused", async () => {
    const error = await runClock(
      Effect.flip(Signer.zkLogin({ session: { ...session, address: PADDED("1") }, ephemeral }))
    )
    expect(error._tag).toBe("SigningError")
    expect(error.reason).toBeUndefined()
  })
})

describe("ZkLogin.save / load", () => {
  /** A test sealer: XOR with a key byte, bound to the AAD by a prefix. Not a real cipher. */
  const sealer: SecretSealer = {
    seal: (secret, aad) =>
      Effect.sync(() =>
        `${toBase64(aad)}.${toBase64(Redacted.value(secret).map((byte) => byte ^ 0x5a))}`
      ),
    unseal: (sealed, aad) =>
      Effect.suspend(() => {
        const [bound, body] = sealed.split(".")
        if (bound !== toBase64(aad) || body === undefined) {
          return Effect.fail(new SigningError({ reason: "locked", cause: "wrong AAD" }))
        }
        return Effect.succeed(Redacted.make(fromBase64(body).map((byte) => byte ^ 0x5a)))
      })
  }

  const withStore = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore | TestClock.TestClock>) =>
    Effect.runPromise(Effect.provide(
      Effect.gen(function*() {
        yield* TestClock.setTime(NOW)
        return yield* effect
      }),
      Layer.mergeAll(KeyValueStore.layerMemory, TestClock.layer())
    ))

  test("round-trips a session; only the sealed blob of the ephemeral key is written", async () => {
    const { raw, loaded, signature, missing } = await withStore(Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      yield* ZkLogin.save(store, "zk", { session, ephemeralSecretKey: Redacted.make(ephemeralSeed), sealer })
      const raw = yield* store.get("zk")
      const loaded = yield* ZkLogin.load(store, "zk", { sealer })
      const signature = Option.isSome(loaded)
        ? yield* loaded.value.signPersonalMessage(new Uint8Array([9]))
        : undefined
      const missing = yield* ZkLogin.load(store, "nothing", { sealer })
      return { raw, loaded, signature, missing }
    }))
    expect(raw).toBeDefined()
    expect(raw!.includes(toBase64(ephemeralSeed))).toBe(false)
    expect(raw!.includes(ephemeral.getSecretKey())).toBe(false)
    expect(JSON.parse(raw!).session.maxEpoch).toBe("101")
    expect(Option.isSome(loaded) && loaded.value.address).toBe(ZK_ADDRESS)
    expect(Option.isSome(loaded) && loaded.value.maxEpoch).toBe(MAX_EPOCH)
    expect(signature).toBeDefined()
    expect(Option.isNone(missing)).toBe(true)
  })

  test("a blob copied under another account's entry does not unseal", async () => {
    const error = await withStore(Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      yield* ZkLogin.save(store, "zk", { session, ephemeralSecretKey: Redacted.make(ephemeralSeed), sealer })
      const text = JSON.parse((yield* store.get("zk"))!)
      text.session.address = PADDED("1")
      yield* store.set("zk", JSON.stringify(text))
      return yield* Effect.flip(ZkLogin.load(store, "zk", { sealer }))
    }))
    expect(error.reason).toBe("locked")
  })

  test("an expired stored session fails with expired and stays until removed", async () => {
    const { error, after } = await withStore(Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      yield* ZkLogin.save(store, "zk", { session, ephemeralSecretKey: Redacted.make(ephemeralSeed), sealer })
      yield* TestClock.adjust("2 minutes")
      const error = yield* Effect.flip(ZkLogin.load(store, "zk", { sealer }))
      const before = yield* store.has("zk")
      yield* ZkLogin.remove(store, "zk")
      return { error, after: { before, now: yield* store.has("zk") } }
    }))
    expect(error.reason).toBe("expired")
    expect(after).toEqual({ before: true, now: false })
  })

  test("save refuses a secret that is not a 32-byte seed", async () => {
    const error = await withStore(Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      return yield* Effect.flip(
        ZkLogin.save(store, "zk", { session, ephemeralSecretKey: Redacted.make(new Uint8Array(16)), sealer })
      )
    }))
    expect(error._tag).toBe("SigningError")
  })
})

// ---------------------------------------------------------------------------
// Passkey, over a stub authenticator that signs with a P-256 key.
// ---------------------------------------------------------------------------

const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))

/** A compact (r || s) ECDSA signature as DER, which is what WebAuthn answers. */
const derOf = (compact: Uint8Array) => {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0) start++
    const trimmed = bytes.slice(start)
    const body = (trimmed[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...trimmed]) : trimmed
    return [0x02, body.length, ...body]
  }
  const sequence = [...integer(compact.slice(0, 32)), ...integer(compact.slice(32))]
  return Uint8Array.from([0x30, sequence.length, ...sequence])
}

const buffer = (bytes: Uint8Array) => bytes.slice().buffer as ArrayBuffer

const authenticator = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(5))
const PASSKEY_PUBLIC_KEY = authenticator.getPublicKey().toRawBytes()

const stubProvider = (behaviour: "sign" | "cancel" = "sign"): PasskeyProvider => ({
  create: () => Promise.reject(new Error("not used")),
  get: async (challenge) => {
    if (behaviour === "cancel") {
      // A DOMException is structurally a name and a message.
      throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" })
    }
    const clientDataJSON = new TextEncoder().encode(JSON.stringify({
      type: "webauthn.get",
      challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      origin: "https://miso.test"
    }))
    const authenticatorData = new Uint8Array(37).fill(1)
    const payload = Uint8Array.from([...authenticatorData, ...(await sha256(clientDataJSON))])
    const compact = await authenticator.sign(payload)
    return {
      response: {
        authenticatorData: buffer(authenticatorData),
        clientDataJSON: buffer(clientDataJSON),
        signature: buffer(derOf(compact))
      }
    }
  }
})

describe("Signer.passkey", () => {
  test("signs with the authenticator; the SDK verifies the signature against the passkey address", async () => {
    const bytes = await bytesFrom(PADDED("1"), 100n)
    const { signer, signature } = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Signer.passkey({ publicKey: PASSKEY_PUBLIC_KEY, provider: stubProvider() })
      return { signer, signature: yield* signer.signTransaction(bytes) }
    }))
    expect(signer.scheme).toBe("Passkey")
    expect(signer.maxEpoch).toBeUndefined()
    const key = await verifyTransactionSignature(bytes, signature, { address: signer.address })
    expect(normalizeSuiAddress(key.toSuiAddress())).toBe(signer.address)
  })

  test("a cancelled prompt (NotAllowedError) is reason rejected", async () => {
    const error = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Signer.passkey({ publicKey: PASSKEY_PUBLIC_KEY, provider: stubProvider("cancel") })
      return yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1])))
    }))
    expect(error.reason).toBe("rejected")
  })

  test("a malformed public key is refused at construction", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Signer.passkey({ publicKey: new Uint8Array(5), provider: stubProvider() }))
    )
    expect(error._tag).toBe("SigningError")
  })

  test("createPasskey: a cancelled registration is rejected", async () => {
    const provider: PasskeyProvider = {
      create: () => Promise.reject(Object.assign(new Error("cancelled"), { name: "NotAllowedError" })),
      get: () => Promise.reject(new Error("unused"))
    }
    const error = await Effect.runPromise(Effect.flip(Signer.createPasskey(provider)))
    expect(error.reason).toBe("rejected")
  })
})

// ---------------------------------------------------------------------------
// Wallet Standard, over an in-memory wallet.
// ---------------------------------------------------------------------------

const walletKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11))
const WALLET_ADDRESS = walletKey.toSuiAddress()
const account = {
  address: WALLET_ADDRESS,
  publicKey: walletKey.getPublicKey().toRawBytes(),
  chains: ["sui:testnet"],
  features: ["sui:signTransaction", "sui:signPersonalMessage"]
}

type WalletMode = "honest" | "tamper" | "reject" | "otherKey"

const fakeWallet = (mode: WalletMode, seen: Array<unknown> = []) => ({
  name: "Fake Wallet",
  features: {
    "sui:signTransaction": {
      version: "2.0.0",
      signTransaction: async (input: { transaction: { toJSON(): Promise<string> }; signal?: AbortSignal }) => {
        seen.push(input.signal)
        if (mode === "reject") throw new Error("User rejected the request.")
        const tx = Transaction.from(await input.transaction.toJSON())
        if (mode === "tamper") tx.setGasPrice(2_000)
        const bytes = await tx.build()
        const key = mode === "otherKey" ? Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(12)) : walletKey
        return { bytes: toBase64(bytes), signature: (await key.signTransaction(bytes)).signature }
      }
    },
    "sui:signPersonalMessage": {
      version: "1.1.0",
      signPersonalMessage: async (input: { message: Uint8Array }) => {
        if (mode === "reject") throw Object.assign(new Error("no"), { code: 4001 })
        return walletKey.signPersonalMessage(input.message)
      }
    }
  }
})

const walletSigner = (wallet: ReturnType<typeof fakeWallet> | { name: string; features: Record<string, unknown> }) =>
  Signer.wallet({ wallet, account, chain: "sui:testnet" })

describe("Signer.wallet", () => {
  test("signs the exact bytes, passes the AbortSignal, derives the scheme from the public key", async () => {
    const bytes = await bytesFrom(WALLET_ADDRESS, 100n)
    const seen: Array<unknown> = []
    const { signer, signature, personal } = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* walletSigner(fakeWallet("honest", seen))
      const signature = yield* signer.signTransaction(bytes)
      const personal = yield* signer.signPersonalMessage(new Uint8Array([1, 2]))
      return { signer, signature, personal }
    }))
    expect(signer.scheme).toBe("ED25519")
    expect(signer.address).toBe(SuiAddress.make(normalizeSuiAddress(WALLET_ADDRESS)))
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    await verifyTransactionSignature(bytes, signature, { address: WALLET_ADDRESS })
    await verifyPersonalMessageSignature(new Uint8Array([1, 2]), personal, { address: WALLET_ADDRESS })
  })

  test("a wallet that returns different bytes is refused", async () => {
    const bytes = await bytesFrom(WALLET_ADDRESS, 100n)
    const error = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* walletSigner(fakeWallet("tamper"))
      return yield* Effect.flip(signer.signTransaction(bytes))
    }))
    expect(error._tag).toBe("SigningError")
    expect(String(error.cause)).toContain("different bytes")
  })

  test("a signature by another key is refused locally", async () => {
    const bytes = await bytesFrom(WALLET_ADDRESS, 100n)
    const error = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* walletSigner(fakeWallet("otherKey"))
      return yield* Effect.flip(signer.signTransaction(bytes))
    }))
    expect(error._tag).toBe("SigningError")
    expect(String(error.cause)).toContain("not a valid signature")
  })

  test("a person declining is reason rejected, for transactions and personal messages", async () => {
    const bytes = await bytesFrom(WALLET_ADDRESS, 100n)
    const [tx, message] = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* walletSigner(fakeWallet("reject"))
      return [
        yield* Effect.flip(signer.signTransaction(bytes)),
        yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1])))
      ] as const
    }))
    expect(tx.reason).toBe("rejected")
    expect(message.reason).toBe("rejected")
  })

  test("falls back to sui:signTransactionBlock", async () => {
    const bytes = await bytesFrom(WALLET_ADDRESS, 100n)
    const legacy = {
      name: "Legacy",
      features: {
        "sui:signTransactionBlock": {
          version: "1.0.0",
          signTransactionBlock: async (input: { transactionBlock: Transaction }) => {
            const built = await input.transactionBlock.build()
            return { transactionBlockBytes: toBase64(built), signature: (await walletKey.signTransaction(built)).signature }
          }
        }
      }
    }
    const signature = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* walletSigner(legacy)
      return yield* signer.signTransaction(bytes)
    }))
    await verifyTransactionSignature(bytes, signature, { address: WALLET_ADDRESS })
  })

  test("refuses a wallet without signing features, and an account not on the chain", async () => {
    const none = await Effect.runPromise(Effect.flip(walletSigner({ name: "Empty", features: {} })))
    expect(none.reason).toBe("unavailable")
    const offChain = await Effect.runPromise(
      Effect.flip(Signer.wallet({ wallet: fakeWallet("honest"), account, chain: "sui:mainnet" }))
    )
    expect(offChain.reason).toBe("unavailable")
    const noPersonal = await Effect.runPromise(Effect.gen(function*() {
      const wallet = fakeWallet("honest")
      const signer = yield* walletSigner({ name: "NoMsg", features: { "sui:signTransaction": wallet.features["sui:signTransaction"] } })
      return yield* Effect.flip(signer.signPersonalMessage(new Uint8Array([1])))
    }))
    expect(noPersonal.reason).toBe("unavailable")
  })

  test("isUserRejection reads rejections structurally", () => {
    expect(isUserRejection(Object.assign(new Error("x"), { name: "NotAllowedError" }))).toBe(true)
    expect(isUserRejection({ code: 4001 })).toBe(true)
    expect(isUserRejection(new Error("Request cancelled by user"))).toBe(true)
    expect(isUserRejection(new Error("network down"))).toBe(false)
    expect(isUserRejection(undefined)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Sponsorship: the sender's check, Enoki through the journal, and an own sponsor.
// ---------------------------------------------------------------------------

const sponsorKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(21))
const SPONSOR = SuiAddress.make(sponsorKey.toSuiAddress())
const ping = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
}

/** What a sponsor does with kind bytes: sender, gas owner, address-balance gas, expiration. */
const sponsorBytes = async (kind: Uint8Array, sender: string, tamper = false) => {
  const tx = Transaction.fromKind(kind)
  if (tamper) tx.moveCall({ target: `${PADDED("2")}::demo::drain`, arguments: [] })
  tx.setSender(sender)
  tx.setGasOwner(SPONSOR)
  tx.setGasPayment([])
  tx.setGasBudget(1_000_000)
  tx.setGasPrice(1_000)
  tx.setExpiration({
    ValidDuring: { minEpoch: "100", maxEpoch: "101", minTimestamp: null, maxTimestamp: null, chain: CHAIN_ID, nonce: 1 }
  })
  return tx.build()
}

const kindOf = (recipe: (tx: Transaction) => void) => {
  const tx = new Transaction()
  recipe(tx)
  return tx.build({ onlyTransactionKind: true })
}

interface FakeEnoki extends EnokiClient {
  readonly executed: Array<{ digest: string; signature: string }>
}

const fakeEnoki = (options: { tamper?: boolean; executeFails?: unknown; createFails?: unknown } = {}): FakeEnoki => {
  const executed: Array<{ digest: string; signature: string }> = []
  return {
    executed,
    createSponsoredTransaction: async (input) => {
      if (options.createFails !== undefined) throw options.createFails
      const bytes = await sponsorBytes(fromBase64(input.transactionKindBytes), input.sender!, options.tamper)
      return { bytes: toBase64(bytes), digest: TransactionDataBuilder.getDigestFromBytes(bytes) }
    },
    executeSponsoredTransaction: async (input) => {
      executed.push(input)
      if (options.executeFails !== undefined) throw options.executeFails
      return { digest: input.digest }
    }
  }
}

const runSui = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = {}
) =>
  Effect.runPromise(Effect.provide(
    Effect.gen(function*() {
      yield* TestClock.setTime(NOW)
      return yield* effect
    }),
    Layer.mergeAll(layerTest({ chainId: CHAIN_ID, ...script }), TestClock.layer(), Journal.layerMemory),
    { local: true }
  ))

class EnokiHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`enoki ${status}`)
  }
}

describe("verifySponsored", () => {
  test("refuses another sender, unsponsored bytes, another sponsor and another kind", async () => {
    const kind = await kindOf(ping)
    const results = await runSui(Effect.gen(function*() {
      const sponsored = yield* Tx.fromBytes(yield* Effect.promise(() => sponsorBytes(kind, ZK_ADDRESS)))
      const own = yield* Tx.fromBytes(yield* Effect.promise(() => bytesFrom(ZK_ADDRESS, 100n)))
      const tampered = yield* Tx.fromBytes(yield* Effect.promise(() => sponsorBytes(kind, ZK_ADDRESS, true)))
      return yield* Effect.all([
        Effect.flip(verifySponsored(sponsored, { sender: PADDED("1") })),
        Effect.flip(verifySponsored(own, { sender: ZK_ADDRESS })),
        Effect.flip(verifySponsored(sponsored, { sender: ZK_ADDRESS, gasOwner: PADDED("1") })),
        Effect.flip(verifySponsored(tampered, { sender: ZK_ADDRESS, transactionKind: kind })),
        verifySponsored(sponsored, { sender: ZK_ADDRESS, gasOwner: SPONSOR, transactionKind: kind })
      ])
    }))
    expect(results.slice(0, 4).map((error) => (error as { rule: string }).rule)).toEqual([
      "sponsored.sender",
      "sponsored.gasOwner",
      "sponsored.gasOwner",
      "sponsored.kind"
    ])
    expect((results[4] as { gasOwner?: string }).gasOwner).toBe(SPONSOR)
  })
})

describe("Enoki sponsorship through the journal", () => {
  test("sponsor → zkLogin sign → execute is journalled and settled from the chain", async () => {
    const enoki = fakeEnoki()
    const { executed, entry, built, signed } = await runSui(
      Effect.gen(function*() {
        const signer = yield* Signer.zkLogin({ session, ephemeral })
        const built = yield* Enoki.sponsor(enoki, ping, { sender: signer.address })
        const signed = yield* Tx.sign(built, signer)
        const executed = yield* Enoki.execute(enoki, signed)
        const entry = yield* (yield* Journal).get(signed.digest)
        return { executed, entry, built, signed }
      }),
      { getTransaction: [FakeOutcome.succeed()] }
    )
    expect(built.sender).toBe(ZK_ADDRESS)
    expect(built.gasOwner).toBe(SPONSOR)
    expect(executed.digest).toBe(signed.digest)
    // Enoki got the digest and the sender's (zkLogin) signature, once.
    expect(enoki.executed).toEqual([{ digest: signed.digest, signature: signed.signatures[0]! }])
    expect(Option.isSome(entry) && entry.value._tag).toBe("Executed")
  })

  test("Enoki answering different bytes than the kind it was sent is refused before signing", async () => {
    const error = await runSui(
      Effect.flip(Enoki.sponsor(fakeEnoki({ tamper: true }), ping, { sender: ZK_ADDRESS }))
    )
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag === "PolicyDenied") expect(error.rule).toBe("sponsored.kind")
  })

  test("create: a 4xx is EnokiError { refused }, a 5xx is a retryable TransportError", async () => {
    const refused = await runSui(
      Effect.flip(Enoki.sponsor(fakeEnoki({ createFails: new EnokiHttpError(400, "invalid") }), ping, {
        sender: ZK_ADDRESS
      }))
    )
    expect(refused._tag).toBe("EnokiError")
    if (refused._tag === "EnokiError") {
      expect(refused.refused).toBe(true)
      expect(SuiError.outcome(refused)).toBe("not_applied")
      expect(refused.message).toContain("400")
    }
    const down = await runSui(
      Effect.flip(Enoki.sponsor(fakeEnoki({ createFails: new EnokiHttpError(503, "down") }), ping, {
        sender: ZK_ADDRESS
      }))
    )
    expect(down._tag).toBe("TransportError")
    if (down._tag === "TransportError") expect(down.retryable).toBe(true)
  })

  test("execute: a 403 is a refusal and settles NotApplied { refused }", async () => {
    const enoki = fakeEnoki({ executeFails: new EnokiHttpError(403, "forbidden") })
    const { error, entry } = await runSui(Effect.gen(function*() {
      const signer = yield* Signer.zkLogin({ session, ephemeral })
      const signed = yield* Tx.sign(yield* Enoki.sponsor(enoki, ping, { sender: signer.address }), signer)
      const error = yield* Effect.flip(Enoki.execute(enoki, signed))
      return { error, entry: yield* (yield* Journal).get(signed.digest) }
    }))
    expect(error._tag).toBe("EnokiError")
    expect(error instanceof EnokiError && error.refused).toBe(true)
    expect(Option.isSome(entry) && entry.value._tag).toBe("NotApplied")
  })

  test("execute: any other failure may have reached the chain and is reconciled", async () => {
    const enoki = fakeEnoki({ executeFails: new EnokiHttpError(400, "bad") })
    const { error, entry } = await runSui(
      Effect.gen(function*() {
        const signer = yield* Signer.zkLogin({ session, ephemeral })
        const signed = yield* Tx.sign(yield* Enoki.sponsor(enoki, ping, { sender: signer.address }), signer)
        const error = yield* Effect.flip(Enoki.execute(enoki, signed))
        return { error, entry: yield* (yield* Journal).get(signed.digest) }
      }),
      { getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.outcome(error)).toBe("unknown")
    expect(Option.isSome(entry) && entry.value._tag).toBe("Unknown")
  })

  test("own sponsor: sponsored bytes + sponsor signature → attach → cosign as sender → submit", async () => {
    const kind = await kindOf(ping)
    const { executed, signed } = await runSui(
      Effect.gen(function*() {
        const sender = yield* Signer.zkLogin({ session, ephemeral })
        // The backend: assembles the sponsored bytes and signs as gas owner.
        const bytes = yield* Effect.promise(() => sponsorBytes(kind, sender.address))
        const sponsorSignature = (yield* Effect.promise(() => sponsorKey.signTransaction(bytes))).signature
        // The app: reads the bytes back, checks them, attaches, signs, submits.
        const built = yield* verifySponsored(yield* Tx.fromBytes(bytes), {
          sender: sender.address,
          gasOwner: SPONSOR,
          transactionKind: kind
        })
        const withSponsor = yield* Tx.attach(built, sponsorSignature)
        const signed = yield* Tx.cosign(withSponsor, sender)
        return { executed: yield* Tx.submit(signed), signed }
      }),
      {
        execute: [FakeOutcome.succeed()],
        balances: [{
          owner: SPONSOR,
          coinType: "0x2::sui::SUI",
          balance: "1000000000",
          coinBalance: "0",
          addressBalance: "1000000000"
        }]
      }
    )
    expect(signed.signatures).toHaveLength(2)
    expect(executed.digest).toBe(signed.digest)
  })
})

describe("Enoki session signers", () => {
  const flow = (sessionValue: { maxEpoch: number; expiresAt: number } | null, fails?: Error) => ({
    getSession: () => Promise.resolve(sessionValue),
    getKeypair: () => fails === undefined ? Promise.resolve(ephemeral) : Promise.reject(fails)
  })

  test("fromFlow carries maxEpoch and the session's expiry", async () => {
    const bytes = await bytesFrom(ephemeral.toSuiAddress(), 102n)
    const { signer, error } = await runClock(Effect.gen(function*() {
      const signer = yield* Enoki.fromFlow(flow({ maxEpoch: 101, expiresAt: NOW + 1_000 }))
      return { signer, error: yield* Effect.flip(signer.signTransaction(bytes)) }
    }))
    expect(signer.scheme).toBe("ZkLogin")
    expect(signer.maxEpoch).toBe(101n)
    expect(error.reason).toBe("expired")
  })

  test("fromFlow: nobody signed in is unavailable, an expired proof is expired", async () => {
    const none = await runClock(Effect.flip(Enoki.fromFlow(flow(null))))
    expect(none.reason).toBe("unavailable")
    const stale = await runClock(
      Effect.flip(Enoki.fromFlow(flow({ maxEpoch: 1, expiresAt: NOW + 1 }, new Error("Stored proof is expired."))))
    )
    expect(stale.reason).toBe("expired")
  })

  test("fromWallet reads the bound from enoki:getSession", async () => {
    const wallet = fakeWallet("honest")
    const enokiWallet = {
      name: "Enoki",
      features: {
        ...wallet.features,
        "enoki:getSession": {
          version: "1.0.0",
          getSession: () => Promise.resolve({ maxEpoch: 101, expiresAt: NOW + 1_000, randomness: "1" })
        }
      }
    }
    const signer = await runClock(Enoki.fromWallet({ wallet: enokiWallet, account, chain: "sui:testnet" }))
    expect(signer.maxEpoch).toBe(101n)
    expect(signer.scheme).toBe("ZkLogin")
    const missing = await runClock(Effect.flip(Enoki.fromWallet({ wallet, account, chain: "sui:testnet" })))
    expect(missing.reason).toBe("unavailable")
  })
})

describe("account signers are Signer values", () => {
  test("an ordinary keypair signer is unchanged (no maxEpoch)", () => {
    expect(fromKeypair(walletKey).maxEpoch).toBeUndefined()
  })
})
