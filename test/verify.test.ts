import { describe, expect, test } from "bun:test"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { Keypair } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { publicKeyFromRawBytes } from "@mysten/sui/verify"
import { getZkLoginSignature } from "@mysten/sui/zklogin"
import { parseSerializedSignature } from "@mysten/sui/cryptography"
import { Effect, Layer } from "effect"
import type { SigningError, TransportError } from "../src/domain/errors.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Verify } from "../src/tx.ts"
import { layerTest } from "../src/testing.ts"

const bytes = new Uint8Array([10, 20, 30, 40, 50])
const other = new Uint8Array([10, 20, 30, 40, 51])

const run = <A, E>(effect: Effect.Effect<A, E, Sui>) =>
  Effect.runPromise(Effect.provide(effect, layerTest()))

const flip = <A, E>(effect: Effect.Effect<A, E, Sui>) => run(Effect.flip(effect))

const addressOf = (keypair: Keypair) => SuiAddress.make(keypair.toSuiAddress())

describe("Verify.verifyTransactionSignature", () => {
  const cases = [
    ["ED25519", new Ed25519Keypair()],
    ["Secp256k1", new Secp256k1Keypair()],
    ["Secp256r1", new Secp256r1Keypair()]
  ] as const

  for (const [scheme, keypair] of cases) {
    test(`answers the public key of a valid ${scheme} signature`, async () => {
      const signature = await Effect.runPromise(Signer.fromKeypair(keypair).signTransaction(bytes))
      const publicKey = await run(
        Verify.verifyTransactionSignature(bytes, signature, { address: addressOf(keypair) })
      )
      expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress())
      expect(publicKey.toRawBytes()).toEqual(keypair.getPublicKey().toRawBytes())
    })
  }

  // ML-DSA-65 shipped in @mysten/sui 2.36; the SDK matrix also runs 2.30, so
  // the keypair class is imported on demand, as `Signer.fromConfig` does.
  test("answers the public key of a valid MLDSA65 signature", async () => {
    const specifier = "@mysten/sui/keypairs/mldsa65"
    const mod: { MLDSA65Keypair: { generate: () => Keypair } } | undefined = await import(specifier)
      .catch(() => undefined)
    if (mod === undefined) return
    const keypair = mod.MLDSA65Keypair.generate()
    const signature = (await keypair.signTransaction(bytes)).signature
    const publicKey = await run(
      Verify.verifyTransactionSignature(bytes, signature, { address: addressOf(keypair) })
    )
    expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress())
  })

  test("a signature over other bytes is a SigningError", async () => {
    const keypair = new Ed25519Keypair()
    const signature = (await keypair.signTransaction(other)).signature
    const error = await flip(Verify.verifyTransactionSignature(bytes, signature))
    expect(error._tag).toBe("SigningError")
    expect(String((error as SigningError).cause)).toContain("not valid for these transaction bytes")
  })

  test("a signature by another address is a SigningError naming who signed", async () => {
    const keypair = new Ed25519Keypair()
    const expected = addressOf(new Ed25519Keypair())
    const signature = (await keypair.signTransaction(bytes)).signature
    const error = await flip(Verify.verifyTransactionSignature(bytes, signature, { address: expected }))
    expect(error._tag).toBe("SigningError")
    const cause = String((error as SigningError).cause)
    expect(cause).toContain(keypair.toSuiAddress())
    expect(cause).toContain(expected)
  })

  test("a signature that does not parse is a SigningError, not a defect", async () => {
    const error = await flip(Verify.verifyTransactionSignature(bytes, "not base64 at all"))
    expect(error._tag).toBe("SigningError")
    const empty = await flip(Verify.verifyTransactionSignature(bytes, "AA=="))
    expect(empty._tag).toBe("SigningError")
  })

  test("the intents are kept apart: a personal-message signature is not a transaction signature", async () => {
    const keypair = new Ed25519Keypair()
    const signature = (await keypair.signPersonalMessage(bytes)).signature
    const error = await flip(Verify.verifyTransactionSignature(bytes, signature))
    expect(error._tag).toBe("SigningError")
  })

  test("verifies a multisig of plain keys locally, and answers the multisig public key", async () => {
    const first = new Ed25519Keypair()
    const second = new Secp256k1Keypair()
    const multisig = MultiSigPublicKey.fromPublicKeys({
      threshold: 2,
      publicKeys: [
        { publicKey: first.getPublicKey(), weight: 1 },
        { publicKey: second.getPublicKey(), weight: 1 }
      ]
    })
    const signature = multisig.combinePartialSignatures([
      (await first.signTransaction(bytes)).signature,
      (await second.signTransaction(bytes)).signature
    ])
    const address = SuiAddress.make(multisig.toSuiAddress())
    const publicKey = await run(Verify.verifyTransactionSignature(bytes, signature, { address }))
    expect(publicKey.toSuiAddress()).toBe(address)

    const short = multisig.combinePartialSignatures([(await first.signTransaction(bytes)).signature])
    const error = await flip(Verify.verifyTransactionSignature(bytes, short, { address }))
    expect(error._tag).toBe("SigningError")
  })
})

describe("Verify.verifyPersonalMessageSignature", () => {
  test("answers the public key of a valid personal-message signature", async () => {
    const keypair = new Secp256r1Keypair()
    const signature = await Effect.runPromise(Signer.fromKeypair(keypair).signPersonalMessage(bytes))
    const publicKey = await run(
      Verify.verifyPersonalMessageSignature(bytes, signature, { address: addressOf(keypair) })
    )
    expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress())
  })

  test("a transaction signature is not a personal-message signature", async () => {
    const keypair = new Ed25519Keypair()
    const signature = (await keypair.signTransaction(bytes)).signature
    const error = await flip(Verify.verifyPersonalMessageSignature(bytes, signature))
    expect(error._tag).toBe("SigningError")
    expect(String((error as SigningError).cause)).toContain("personal message")
  })
})

/**
 * zkLogin is the scheme whose check goes through the node
 * (`core.verifyZkLoginSignature`), so it is what tells an invalid signature
 * apart from an unreachable node. The proof is never checked here: the stub
 * client's answer is the whole verdict.
 */
describe("Verify through the client: zkLogin", () => {
  const ISS = "https://accounts.google.com"
  const ephemeral = new Ed25519Keypair()

  const zkSignature = async (message: Uint8Array) =>
    getZkLoginSignature({
      inputs: {
        proofPoints: { a: ["1", "2", "3"], b: [["1", "2"], ["3", "4"], ["5", "6"]], c: ["1", "2", "3"] },
        issBase64Details: { value: Buffer.from(`"iss":"${ISS}",`).toString("base64url"), indexMod4: 0 },
        headerBase64: "e30",
        addressSeed: "12345"
      },
      maxEpoch: "10",
      userSignature: (await ephemeral.signTransaction(message)).signature
    })

  const zkAddress = (signature: string): string => {
    const parsed = parseSerializedSignature(signature)
    if (parsed.signatureScheme !== "ZkLogin") throw new Error("not a zkLogin signature")
    return publicKeyFromRawBytes("ZkLogin", parsed.publicKey).toSuiAddress()
  }

  type Seen = { readonly intentScope: string; readonly address: string; readonly signal: unknown }

  const stub = (
    answer: () => Promise<{ success: boolean; errors: Array<string> }>,
    seen: Array<Seen>
  ) => {
    const client = {
      network: "localnet",
      core: {
        verifyZkLoginSignature: (options: { intentScope: string; address: string; signal?: AbortSignal }) => {
          seen.push({ intentScope: options.intentScope, address: options.address, signal: options.signal })
          return answer()
        }
      }
    } as unknown as ClientWithCoreApi
    // The stub answers no chain identifier, so the layer is given one.
    const core = Layer.effect(
      SuiCore,
      Effect.gen(function*() {
                const core = yield* SuiCore
                return {
        ...core,
        getChainIdentifier: () => Effect.succeed({ chainIdentifier: "stub-chain" })
                }
      })
    ).pipe(Layer.provide(SuiCore.layerFromClient(client)))
    return Sui.layerNoDeps.pipe(Layer.provide(core))
  }

  const runOn = <A, E, LE>(layer: Layer.Layer<Sui, LE>, effect: Effect.Effect<A, E, Sui>) =>
    Effect.runPromise(Effect.provide(effect, layer))

  test("the node's yes is a public key, and the request carried the Effect's signal", async () => {
    const seen: Array<Seen> = []
    const signature = await zkSignature(bytes)
    const address = SuiAddress.make(zkAddress(signature))
    const publicKey = await runOn(
      stub(async () => ({ success: true, errors: [] }), seen),
      Verify.verifyTransactionSignature(bytes, signature, { address })
    )
    expect(publicKey.toSuiAddress()).toBe(address)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.intentScope).toBe("TransactionData")
    expect(seen[0]?.address).toBe(address)
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  test("the node's no is a SigningError", async () => {
    const seen: Array<Seen> = []
    const signature = await zkSignature(bytes)
    const error = await runOn(
      stub(async () => ({ success: false, errors: ["bad proof"] }), seen),
      Effect.flip(Verify.verifyPersonalMessageSignature(bytes, signature))
    )
    expect(error._tag).toBe("SigningError")
    expect(seen[0]?.intentScope).toBe("PersonalMessage")
  })

  test("an unreachable node is a TransportError, never a verdict", async () => {
    const seen: Array<Seen> = []
    const signature = await zkSignature(bytes)
    const error = await runOn(
      stub(async () => {
        throw Object.assign(new Error("connection refused"), { code: "UNAVAILABLE" })
      }, seen),
      Effect.flip(Verify.verifyTransactionSignature(bytes, signature))
    )
    expect(error._tag).toBe("TransportError")
    const transport = error as TransportError
    expect(transport.method).toBe("verifyTransactionSignature")
    expect(transport.retryable).toBe(true)
  })

  test("a zkLogin signature by another account names the account that signed", async () => {
    const seen: Array<Seen> = []
    const signature = await zkSignature(bytes)
    const expected = SuiAddress.make(new Ed25519Keypair().toSuiAddress())
    const error = await runOn(
      stub(async () => ({ success: true, errors: [] }), seen),
      Effect.flip(Verify.verifyTransactionSignature(bytes, signature, { address: expected }))
    )
    expect(error._tag).toBe("SigningError")
    expect(String((error as SigningError).cause)).toContain(zkAddress(signature))
  })
})
