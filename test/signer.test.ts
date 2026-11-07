import { describe, expect, test } from "bun:test"
import type { Keypair, PublicKey, SignatureScheme } from "@mysten/sui/cryptography"
import { decodeSuiPrivateKey, Signer as SdkSigner } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Config, ConfigProvider, Effect } from "effect"
import { SigningError } from "../src/domain/errors.ts"
import { Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Signer } from "../src/services/Signer.ts"

const bytes = new Uint8Array([1, 2, 3, 4])

const withEnv = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("Signer.fromKeypair", () => {
  test("carries the address and scheme and signs transactions", async () => {
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
    const signer = Signer.fromKeypair(keypair)
    expect(signer.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
    expect(signer.scheme).toBe("ED25519")
    const signature = await run(signer.signTransaction(bytes))
    const expected = (await keypair.signTransaction(bytes)).signature
    expect(signature).toBe(Signature.make(expected))
  })

  test("signs personal messages", async () => {
    const signer = Signer.fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(4)))
    const signature = await run(signer.signPersonalMessage(bytes))
    expect(signature.length).toBeGreaterThan(0)
  })

  test("exposes no secret material", () => {
    const signer = Signer.fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(5)))
    expect(Object.keys(signer).sort()).toEqual([
      "address",
      "scheme",
      "signPersonalMessage",
      "signTransaction"
    ])
    expect(JSON.stringify(signer)).not.toContain("suiprivkey")
  })
})

describe("Signer.fromSecretKey over a configured key", () => {
  // ML-DSA-65 shipped in @mysten/sui 2.36; the peer range still admits 2.28 and
  // the SDK matrix runs 2.30, so the keypair class is imported on demand here
  // exactly as `Signer.fromSecretKey` does.
  test("decodes a Bech32 MLDSA65 key", async () => {
    const specifier = "@mysten/sui/keypairs/mldsa65"
    const mod: { MLDSA65Keypair: { generate: () => Keypair } } | undefined = await import(specifier)
      .catch(() => undefined)
    if (mod === undefined) return
    const keypair = mod.MLDSA65Keypair.generate()
    const secret = keypair.getSecretKey()
    // Widened to `string`: on an SDK before 2.36 `SignatureScheme` has no
    // `"MLDSA65"`, and the SDK matrix typechecks this file against 2.30.
    expect<string>(decodeSuiPrivateKey(secret).scheme).toBe("MLDSA65")
    const signer = await run(Signer.fromSecretKey(secret))
    expect<string>(signer.scheme).toBe("MLDSA65")
    expect(signer.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
  })

  test("reads SUI_PRIVATE_KEY through Config.Redacted", async () => {
    const keypair = new Ed25519Keypair()
    const signer = await run(
      Effect.provide(
        Config.Redacted("SUI_PRIVATE_KEY").pipe(Effect.flatMap(Signer.fromSecretKey)),
        withEnv({ SUI_PRIVATE_KEY: keypair.getSecretKey() })
      )
    )
    expect(signer.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
  })

  test("a corrupted key leaks nothing: no run of it reaches the message or the JSON", async () => {
    // One character wrong in a real key. The Bech32 decoder's own message is
    // `Invalid checksum in suiprivkey1…` with the whole input in it, so a typo
    // in a live key would otherwise put a recoverable secret in a log.
    const secret = new Ed25519Keypair().getSecretKey()
    const corrupted = `${secret.slice(0, -1)}${secret.endsWith("q") ? "p" : "q"}`
    expect(corrupted).not.toBe(secret)

    const error = await run(Signer.fromSecretKey(corrupted).pipe(Effect.flip))
    expect(error._tag).toBe("KeyError")

    const printed = `${error.message}\n${JSON.stringify(error)}\n${String(error)}`
    // Nothing longer than eight characters of the input may appear anywhere in
    // what a failure can print, past the shared `suiprivkey1` prefix (which the
    // fixed message names). Eight characters of base32 is 40 bits: far too
    // little to reconstruct a key.
    const WINDOW = 9
    const leaked: Array<string> = []
    for (let start = "suiprivkey1".length; start + WINDOW <= corrupted.length; start += 1) {
      const run = corrupted.slice(start, start + WINDOW)
      if (printed.includes(run)) leaked.push(run)
    }
    expect(leaked).toEqual([])
    expect(error.message).toContain("Bech32")
  })
})

describe("Signer.ephemeral", () => {
  test("is a fresh key every time, from the SDK's CSPRNG rather than Effect's Random", async () => {
    const first = await run(Signer.ephemeral)
    const second = await run(Signer.ephemeral)
    expect(first.address).not.toBe(second.address)
    expect(first.scheme).toBe("ED25519")
  })
})

describe("Signer.remote", () => {
  test("decodes what the remote returned", async () => {
    const address = SuiAddress.make(`0x${"ab".repeat(32)}`)
    const signer = Signer.remote({
      address,
      scheme: "Secp256k1",
      signTransaction: () => Effect.succeed("AQID")
    })
    expect(await run(signer.signTransaction(bytes))).toBe(Signature.make("AQID"))
  })

  test("a remote that cannot sign personal messages says so", async () => {
    const signer = Signer.remote({
      address: SuiAddress.make(`0x${"cd".repeat(32)}`),
      scheme: "ED25519",
      signTransaction: () => Effect.succeed("AQID")
    })
    const error = await run(signer.signPersonalMessage(bytes).pipe(Effect.flip))
    expect(error).toBeInstanceOf(SigningError)
  })

  test("a remote failure stays a SigningError", async () => {
    const signer = Signer.remote({
      address: SuiAddress.make(`0x${"ef".repeat(32)}`),
      scheme: "ED25519",
      signTransaction: () => Effect.fail(new SigningError({ cause: "kms refused" }))
    })
    const error = await run(signer.signTransaction(bytes).pipe(Effect.flip))
    expect(error._tag).toBe("SigningError")
  })
})

describe("Signer.fromSdkSigner", () => {
  /**
   * A minimal SDK `Signer` that is not a `Keypair`: what a Ledger transport, a
   * wallet adapter or a KMS credential looks like from here.
   */
  class DeviceSigner extends SdkSigner {
    constructor(private readonly inner: Ed25519Keypair) {
      super()
    }
    override async sign(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
      return this.inner.sign(data)
    }
    override getKeyScheme(): SignatureScheme {
      return this.inner.getKeyScheme()
    }
    override getPublicKey(): PublicKey {
      return this.inner.getPublicKey()
    }
  }

  test("wraps any SDK Signer, not only a Keypair", async () => {
    const inner = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9))
    const device = new DeviceSigner(inner)
    expect(device).not.toBeInstanceOf(Ed25519Keypair)
    const signer = Signer.fromSdkSigner(device)
    expect(signer.address).toBe(SuiAddress.make(inner.toSuiAddress()))
    expect(signer.scheme).toBe("ED25519")
    const signature = await run(signer.signTransaction(bytes))
    expect(signature).toBe(Signature.make((await inner.signTransaction(bytes)).signature))
    const personal = await run(signer.signPersonalMessage(bytes))
    expect(personal).toBe(Signature.make((await inner.signPersonalMessage(bytes)).signature))
  })

  test("fromKeypair is the same function under its old name", () => {
    const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(4))
    expect(Signer.fromKeypair(keypair).address).toBe(Signer.fromSdkSigner(keypair).address)
  })
})
