import { describe, expect, test } from "bun:test"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { ConfigProvider, Effect } from "effect"
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

describe("Signer.fromConfig", () => {
  const cases = [
    ["ED25519", new Ed25519Keypair()],
    ["Secp256k1", new Secp256k1Keypair()],
    ["Secp256r1", new Secp256r1Keypair()]
  ] as const

  for (const [scheme, keypair] of cases) {
    test(`decodes a Bech32 ${scheme} key`, async () => {
      const secret = keypair.getSecretKey()
      expect(decodeSuiPrivateKey(secret).scheme).toBe(scheme)
      const signer = await run(
        Effect.provide(Signer.fromConfig(), withEnv({ SUI_PRIVATE_KEY: secret }))
      )
      expect(signer.scheme).toBe(scheme)
      expect(signer.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
    })
  }

  test("reads the name it is given", async () => {
    const keypair = new Ed25519Keypair()
    const signer = await run(
      Effect.provide(
        Signer.fromConfig("SPONSOR_KEY"),
        withEnv({ SPONSOR_KEY: keypair.getSecretKey() })
      )
    )
    expect(signer.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
  })

  test("a missing variable is a ConfigError", async () => {
    const error = await run(
      Effect.provide(Signer.fromConfig().pipe(Effect.flip), withEnv({}))
    )
    expect(error._tag).toBe("ConfigError")
  })

  test("a key that is not Bech32 is a ConfigError", async () => {
    const error = await run(
      Effect.provide(
        Signer.fromConfig().pipe(Effect.flip),
        withEnv({ SUI_PRIVATE_KEY: "not-a-key" })
      )
    )
    expect(error._tag).toBe("ConfigError")
    expect(error.message).toContain("SUI_PRIVATE_KEY")
  })

  test("a corrupted key leaks nothing: no run of it reaches the message or the JSON", async () => {
    // One character wrong in a real key. The Bech32 decoder's own message is
    // `Invalid checksum in suiprivkey1…` with the whole input in it, and
    // `Script.run` prints the ConfigError's message on stderr, so a typo in a
    // live key would otherwise put a recoverable secret in a log.
    const secret = new Ed25519Keypair().getSecretKey()
    const corrupted = `${secret.slice(0, -1)}${secret.endsWith("q") ? "p" : "q"}`
    expect(corrupted).not.toBe(secret)

    const error = await run(
      Effect.provide(
        Signer.fromConfig().pipe(Effect.flip),
        withEnv({ SUI_PRIVATE_KEY: corrupted })
      )
    )
    expect(error._tag).toBe("ConfigError")

    const printed = `${error.message}\n${JSON.stringify(error)}\n${String(error)}`
    // Nothing longer than eight characters of the input may appear anywhere in
    // what a failure can print. Eight characters of base32 is 40 bits: far too
    // little to reconstruct a key, and short enough that the shared
    // `suiprivkey1` prefix does not trip the check on its own.
    const WINDOW = 9
    const leaked: Array<string> = []
    for (let start = 0; start + WINDOW <= corrupted.length; start += 1) {
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
