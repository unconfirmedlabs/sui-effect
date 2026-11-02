/**
 * Regressions from the 0.5.0 pre-merge review of the account signers: the
 * wallet's local signature check, the passkey's local check, and Enoki's
 * session readers. Each failed before its fix.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { Transaction } from "@mysten/sui/transactions"
import { toBase64 } from "@mysten/sui/utils"
import { Cause, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { SigningError } from "../src/domain/errors.ts"
import { Enoki } from "../src/enoki.ts"
import type { PasskeyProvider } from "../src/services/AccountSigners.ts"
import { Signer } from "../src/services/Signer.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const NOW = 1_700_000_000_000

/** Full bytes for `sender`: one Move call, address-balance gas, a two-epoch window. */
const bytesFor = (sender: string): Promise<Uint8Array> => {
  const tx = new Transaction()
  tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
  tx.setSender(sender)
  tx.setGasPayment([])
  tx.setGasBudget(1_000_000)
  tx.setGasPrice(1_000)
  tx.setExpiration({
    ValidDuring: { minEpoch: "100", maxEpoch: "101", minTimestamp: null, maxTimestamp: null, chain: CHAIN_ID, nonce: 7 }
  })
  return tx.build()
}

const walletKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11))
const WALLET_ADDRESS = walletKey.toSuiAddress()
const edAccount = { address: WALLET_ADDRESS, publicKey: walletKey.getPublicKey().toRawBytes(), chains: ["sui:testnet"] }

/** A wallet that signs the bytes it was asked to (unchanged) with whatever `signatureFor` answers. */
const walletAnswering = (signatureFor: (bytes: Uint8Array) => Promise<string>) => ({
  name: "Review Wallet",
  features: {
    "sui:signTransaction": {
      version: "2.0.0",
      signTransaction: async (input: { transaction: { toJSON(): Promise<string> } }) => {
        const bytes = await Transaction.from(await input.transaction.toJSON()).build()
        return { bytes: toBase64(bytes), signature: await signatureFor(bytes) }
      }
    }
  }
})

const signWith = (signatureFor: (bytes: Uint8Array) => Promise<string>) =>
  Effect.gen(function*() {
    const bytes = yield* Effect.promise(() => bytesFor(WALLET_ADDRESS))
    const signer = yield* Signer.wallet({ wallet: walletAnswering(signatureFor), account: edAccount, chain: "sui:testnet" })
    return yield* signer.signTransaction(bytes)
  })

describe("Signer.wallet checks the signature for the account's own scheme, not the flag the wallet chose", () => {
  test("an Ed25519 account's wallet answering a zkLogin-flagged signature is refused", async () => {
    const garbage = toBase64(Uint8Array.from([0x05, ...new Uint8Array(64).fill(9)]))
    const error = await Effect.runPromise(Effect.flip(signWith(async () => garbage)))
    expect(error).toBeInstanceOf(SigningError)
  })

  test("an answer that is not base64 is refused", async () => {
    const error = await Effect.runPromise(Effect.flip(signWith(async () => "%%%not-base64%%%")))
    expect(error).toBeInstanceOf(SigningError)
  })

  test("the account's own valid signature still passes", async () => {
    const signature = await Effect.runPromise(
      signWith(async (bytes) => (await walletKey.signTransaction(bytes)).signature)
    )
    expect(typeof signature).toBe("string")
  })
})

/** A software WebAuthn authenticator that signs with `key`, whatever passkey the signer was made for. */
const authenticator = (key: Secp256r1Keypair): PasskeyProvider => {
  const sha256 = async (bytes: Uint8Array) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))
  const der = (compact: Uint8Array) => {
    const int = (bytes: Uint8Array) => {
      let start = 0
      while (start < bytes.length - 1 && bytes[start] === 0) start++
      const trimmed = bytes.slice(start)
      const body = (trimmed[0]! & 0x80) !== 0 ? Uint8Array.from([0, ...trimmed]) : trimmed
      return [0x02, body.length, ...body]
    }
    const sequence = [...int(compact.slice(0, 32)), ...int(compact.slice(32))]
    return Uint8Array.from([0x30, sequence.length, ...sequence])
  }
  return {
    create: () => Promise.reject(new Error("unused")),
    get: async (challenge) => {
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({
        type: "webauthn.get",
        challenge: toBase64(challenge).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
        origin: "https://miso.test"
      }))
      const authenticatorData = new Uint8Array(37).fill(1)
      const compact = await key.sign(Uint8Array.from([...authenticatorData, ...(await sha256(clientDataJSON))]))
      return {
        response: {
          authenticatorData: authenticatorData.slice().buffer,
          clientDataJSON: clientDataJSON.slice().buffer,
          signature: der(compact).slice().buffer
        }
      }
    }
  }
}

describe("Signer.passkey checks its signature locally", () => {
  const stored = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(5))

  test("an authenticator answering with another credential's key is refused", async () => {
    const picked = Secp256r1Keypair.fromSecretKey(new Uint8Array(32).fill(6))
    const result = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Signer.passkey({ publicKey: stored.getPublicKey().toRawBytes(), provider: authenticator(picked) })
      const bytes = yield* Effect.promise(() => bytesFor(signer.address))
      return yield* Effect.result(signer.signTransaction(bytes))
    }))
    expect(result._tag).toBe("Failure")
  })

  test("the stored credential's own signature passes", async () => {
    const result = await Effect.runPromise(Effect.gen(function*() {
      const signer = yield* Signer.passkey({ publicKey: stored.getPublicKey().toRawBytes(), provider: authenticator(stored) })
      const bytes = yield* Effect.promise(() => bytesFor(signer.address))
      return yield* Effect.result(signer.signTransaction(bytes))
    }))
    expect(result._tag).toBe("Success")
  })
})

describe("Enoki's session readers fail typed on a malformed maxEpoch", () => {
  const typedFailure = <A, E>(exit: Exit.Exit<A, E>): boolean =>
    Exit.isFailure(exit) && !Cause.hasDies(exit.cause) && Exit.findErrorOption(exit)._tag === "Some"

  test("fromWallet with a non-integer maxEpoch is a SigningError, not a defect", async () => {
    const wallet = {
      name: "Enoki",
      features: {
        ...walletAnswering(async () => "x").features,
        "enoki:getSession": { version: "1.0.0", getSession: () => Promise.resolve({ maxEpoch: 1.5, expiresAt: NOW + 1_000 }) }
      }
    }
    const exit = await Effect.runPromiseExit(
      Effect.provide(Enoki.fromWallet({ wallet, account: edAccount, chain: "sui:testnet" }), TestClock.layer())
    )
    expect(typedFailure(exit)).toBe(true)
  })

  test("fromFlow with maxEpoch NaN is a SigningError, not a defect", async () => {
    const ephemeral = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
    const flow = {
      getSession: () => Promise.resolve({ maxEpoch: Number.NaN, expiresAt: NOW + 1_000 }),
      getKeypair: () => Promise.resolve(ephemeral)
    }
    const exit = await Effect.runPromiseExit(Effect.provide(Enoki.fromFlow(flow), TestClock.layer()))
    expect(typedFailure(exit)).toBe(true)
  })
})
