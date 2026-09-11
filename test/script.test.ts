import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Cause, ConfigProvider, Console, Effect, Exit, Layer } from "effect"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  JournalError,
  NetworkMismatch,
  NotApplied,
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  PolicyDenied,
  SigningError,
  SimulationFailed,
  SubmissionUnknown,
  TransactionNotFound,
  TransportError,
  UnexpectedEffects
} from "../src/domain/errors.ts"
import { Digest, ExecutionReason, Mist, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { exitCode, readNetwork, Script } from "../src/services/Script.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const DIGEST = Digest.make("7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn")
const ID = `0x${"ab".repeat(32)}`
const UNKNOWN_REASON = ExecutionReason.cases.Unknown.make({ $kind: "Unknown" })

const effects = {
  version: 2,
  status: { success: false },
  gasUsed: {
    computationCost: Mist.make(1n),
    storageCost: Mist.make(1n),
    storageRebate: Mist.make(1n),
    nonRefundableStorageFee: Mist.make(0n)
  },
  transactionDigest: DIGEST,
  gasObject: null,
  eventsDigest: null,
  dependencies: [],
  lamportVersion: null,
  changedObjects: [],
  unchangedConsensusObjects: [],
  auxiliaryDataDigest: null
} as ExecutionFailed["effects"]

const signed = {
  digest: DIGEST,
  bytes: new Uint8Array([1, 2, 3]),
  signatures: [Signature.make("sig")],
  sender: SuiAddress.make(ID)
}

const fail = <E>(error: E) => Exit.fail(error)

describe("Script.exitCode", () => {
  test("0 for success", () => {
    expect(exitCode(Exit.succeed(1))).toBe(0)
  })

  test("2 for configuration: ConfigError, NetworkMismatch, the mainnet gate", async () => {
    expect(exitCode(fail(new NetworkMismatch({ expected: "a", actual: "b" })))).toBe(2)
    const configError = await Effect.runPromise(
      readNetwork.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
        Effect.flip
      )
    )
    expect(exitCode(fail(configError))).toBe(2)
    const gated = await Effect.runPromise(
      readNetwork.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "mainnet" }))),
        Effect.flip
      )
    )
    expect(exitCode(fail(gated))).toBe(2)
  })

  test("3 for an unknown outcome", () => {
    expect(exitCode(fail(new SubmissionUnknown({ digest: DIGEST, signed, cause: "timeout" })))).toBe(
      3
    )
  })

  test("4 for everything that provably did not apply", () => {
    const notApplied = [
      new SimulationFailed({ reason: UNKNOWN_REASON, message: "no" }),
      new BuildError({ message: "no gas", cause: "x" }),
      new SigningError({ cause: "no key" }),
      new PolicyDenied({ rule: "spend", message: "too much" }),
      new ObjectNotFound({ objectId: SuiAddress.make(ID) as never }),
      new ObjectDeleted({ objectId: SuiAddress.make(ID) as never }),
      new ObjectUnavailable({ objectId: SuiAddress.make(ID) as never }),
      new TransactionNotFound({ digest: DIGEST }),
      new TransportError({ method: "getObject", retryable: true, cause: "down" }),
      new DecodeError({ issue: "bad bytes" }),
      new NotApplied({ digest: DIGEST, evidence: "expired" }),
      new JournalError({ cause: "disk full" }),
      new UnexpectedEffects({ digest: DIGEST, expected: "0x2::a::B", found: [] })
    ]
    for (const error of notApplied) expect(exitCode(fail(error))).toBe(4)
  })

  test("4 for a TimeoutError, which is outside the taxonomy", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.never.pipe(Effect.timeout("1 milli"), Effect.provide(Layer.empty))
    )
    expect(exitCode(exit)).toBe(4)
  })

  test("5 when it applied on chain and failed", () => {
    expect(
      exitCode(fail(new ExecutionFailed({ digest: DIGEST, reason: UNKNOWN_REASON, effects })))
    ).toBe(5)
  })

  test("1 for a defect", () => {
    expect(exitCode(Exit.die(new Error("boom")))).toBe(1)
  })

  test("130 for an interrupt", () => {
    expect(exitCode(Exit.failCause(Cause.interrupt()))).toBe(130)
  })

  test("an extension error's own outcome is honoured", () => {
    class Applied {
      readonly _tag = "SponsorshipCharged"
      readonly outcome = "applied" as const
    }
    class Unknown {
      readonly _tag = "SponsorMaybeSent"
      readonly outcome = "unknown" as const
    }
    class Denied {
      readonly _tag = "SponsorshipDenied"
      readonly outcome = "not_applied" as const
    }
    expect(exitCode(fail(new Applied()))).toBe(5)
    expect(exitCode(fail(new Unknown()))).toBe(3)
    expect(exitCode(fail(new Denied()))).toBe(4)
  })

  test("an error with no tag at all is a defect", () => {
    expect(exitCode(fail("a string"))).toBe(1)
  })
})

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(2))

const env = (extra: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnvRecord({
      SUI_NETWORK: "localnet",
      SUI_PRIVATE_KEY: keypair.getSecretKey(),
      ...extra
    })
  )

describe("Script.layer", () => {
  test("reads the network and the signer, and provides Sui", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const script = yield* Script
        return { address: script.signer.address, chainId: script.sui.chainId, network: script.network }
      }).pipe(
        Effect.provide(
          Script.layerNoDeps.pipe(Layer.provideMerge(layerTest({ chainId: CHAIN_ID }))),
          { local: true }
        ),
        Effect.provide(env())
      )
    )
    expect(result.network).toBe("localnet")
    expect(result.chainId).toBe(CHAIN_ID)
    expect(result.address).toBe(SuiAddress.make(keypair.toSuiAddress()))
  })

  test("mainnet is refused unless the gate is set", async () => {
    const denied = await Effect.runPromise(
      readNetwork.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "mainnet" }))
        ),
        Effect.flip
      )
    )
    expect(denied.message).toContain("SUI_ALLOW_MAINNET")

    const allowed = await Effect.runPromise(
      readNetwork.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnvRecord({ SUI_NETWORK: "mainnet", SUI_ALLOW_MAINNET: "1" })
          )
        )
      )
    )
    expect(allowed).toBe("mainnet")
  })

  test("a read-only script has no signer in its type", async () => {
    const network = await Effect.runPromise(
      Effect.map(Sui, (sui) => sui.network).pipe(
        Effect.provide(layerTest({ chainId: CHAIN_ID }), { local: true })
      )
    )
    expect(network).toBe("localnet")
  })
})

describe("Script.run", () => {
  const runScript = <A, E>(
    effect: Effect.Effect<A, E, Script | Sui | SuiCore>,
    script = { chainId: CHAIN_ID }
  ) => {
    const lines: Array<string> = []
    const codes: Array<number> = []
    const signals: Array<string> = []
    const layer = Script.layerNoDeps.pipe(
      Layer.provideMerge(layerTest(script)),
      Layer.provide(env())
    )
    return Script.run(effect, {
      layer,
      exit: (code) => codes.push(code),
      stderr: (line) => lines.push(line),
      signals: { on: (name) => signals.push(name) }
    }).then((code) => ({ code, codes, lines, signals }))
  }

  test("a script that succeeds exits 0 and writes nothing to stderr", async () => {
    const result = await runScript(
      Effect.gen(function*() {
        const script = yield* Script
        yield* Console.log(script.network)
      })
    )
    expect(result.code).toBe(0)
    expect(result.codes).toEqual([0])
    expect(result.lines).toEqual([])
    expect(result.signals).toEqual(["SIGINT", "SIGTERM"])
  })

  test("a failure writes one describe line to stderr and exits with its code", async () => {
    const result = await runScript(
      Effect.fail(new ExecutionFailed({ digest: DIGEST, reason: UNKNOWN_REASON, effects }))
    )
    expect(result.code).toBe(5)
    expect(result.lines[0]).toContain("ExecutionFailed")
    expect(result.lines).toContain(`digest: ${DIGEST}`)
  })

  test("an unknown submission prints the bytes and a reconcile hint", async () => {
    const result = await runScript(
      Effect.fail(new SubmissionUnknown({ digest: DIGEST, signed, cause: "timeout" }))
    )
    expect(result.code).toBe(3)
    expect(result.lines.some((line) => line.startsWith("bytes: "))).toBe(true)
    expect(result.lines.some((line) => line.includes("reconcile"))).toBe(true)
  })

  test("a defect exits 1 and prints the cause", async () => {
    const result = await runScript(Effect.die(new Error("boom")))
    expect(result.code).toBe(1)
    expect(result.lines.join("\n")).toContain("boom")
  })
})
