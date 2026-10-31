/**
 * Fix round F3, the `Script` half: the journal a run used is found wherever it
 * was provided (wallet#1), an applied submission never exits 4 (wallet#2), the
 * unresolved report is this run's only (wallet#12), the `NoDeps` layers take
 * the network from the client (wallet#9), a declared `exitCode` is honoured
 * (wallet#10), and a `ConfigError` is one line naming the variable (wallet#11,
 * ext#19).
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Config, ConfigProvider, DateTime, Effect, Layer, Schedule, Schema } from "effect"
import { JournalError, ObjectNotFound, SubmissionUnknown } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, ObjectId, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { exitCode, readNetwork, Script, ScriptReadOnly } from "../src/services/Script.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import type { SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, fakeDigest } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = `${PADDED("2")}::sui::SUI`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: signer.address }

const script = (execute: ReadonlyArray<FakeOutcome>) => ({
  chainId: CHAIN_ID,
  coins: [{
    objectId: ObjectId.normalize("0xc01"),
    version: "1",
    digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
    owner,
    type: `${PADDED("2")}::coin::Coin<${SUI}>`,
    balance: "10000000000"
  }],
  gasBudget: 10_000_000n,
  execute
})

const transfer = (tx: Transaction) => {
  tx.transferObjects([tx.splitCoins(tx.gas, [1])], signer.address)
}

/** A fast lifecycle, so an unanswered execute does not resubmit for seconds. */
const fast = SubmitConfig.with({
  resubmitAttempts: 1,
  resubmit: Schedule.spaced("1 milli"),
  reconcileRecheck: 0
})

/** {@link fast}, and an execute that gives up quickly (indexer#11: a `Duration.Input`). */
const fastTimeout = SubmitConfig.with({
  resubmitAttempts: 1,
  resubmit: Schedule.spaced("1 milli"),
  executeTimeout: "50 millis",
  reconcileRecheck: 0
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Script | Sui | SuiCore>,
  layer: Layer.Layer<Script | Sui | SuiCore, unknown>
) => {
  const lines: Array<string> = []
  return Script.run(effect, {
    layer,
    exit: () => undefined,
    stderr: (line) => lines.push(line),
    signals: { on: () => undefined }
  }).then((code) => ({ code, lines, printed: lines.join("\n") }))
}

const scriptLayer = (execute: ReadonlyArray<FakeOutcome>) =>
  Script.layerWithSigner(signer).pipe(Layer.provideMerge(layerTest(script(execute))))

describe("wallet#1: Script.run finds the journal the program used", () => {
  test("a journal provided *inside* the program: a timeout mid-submit exits 3", async () => {
    const program = Tx.run(transfer, { signer }).pipe(
      fast,
      Effect.timeout("300 millis"),
      Effect.provide(Journal.layerMemory)
    )
    const result = await run(program, scriptLayer([FakeOutcome.timeoutThen(true)]))
    expect(result.code).toBe(3)
    expect(result.printed).toContain("left unresolved")
    expect(result.printed).toMatch(/unresolved \S+ \(Signed\)/)
  })

  test("a journal provided in the run layer: the same", async () => {
    const program = Tx.run(transfer, { signer }).pipe(fast, Effect.timeout("300 millis"))
    const result = await run(
      program,
      Layer.merge(scriptLayer([FakeOutcome.timeoutThen(true)]), Journal.layerMemory)
    )
    expect(result.code).toBe(3)
  })

  test("the run layer may fail with any error; the failure is mapped, not a defect", async () => {
    // What a durable journal's layer looks like to the type checker: it fails
    // with `JournalError` (or a `PlatformError`), which used to need
    // `Layer.orDie` — turning a failed journal open into exit 1.
    const failing: Layer.Layer<never, JournalError> = Layer.effectDiscard(
      Effect.fail(new JournalError({ cause: "the store is read-only" }))
    )
    const result = await run(Effect.void, Layer.merge(scriptLayer([]), failing))
    expect(result.code).toBe(4)
    expect(result.printed).toContain("JournalError")
  })

  test("a defect prints what this run left unresolved", async () => {
    const program = Tx.run(transfer, { signer }).pipe(
      fast,
      Effect.timeout("300 millis"),
      Effect.orDie,
      Effect.provide(Journal.layerMemory)
    )
    const result = await run(program, scriptLayer([FakeOutcome.timeoutThen(true)]))
    expect(result.code).toBe(1)
    expect(result.printed).toMatch(/unresolved \S+ \(Signed\)/)
    expect(result.printed).toContain("entry: ")
  })
})

describe("wallet#12: only this run's entries are reported", () => {
  test("another process's unresolved entry in a shared journal is not listed", async () => {
    const shared = Journal.makeMemoryUnsafe()
    const theirs = Digest.make(fakeDigest(41))
    await Effect.runPromise(
      shared.put(JournalEntry.cases.Signed.make({
        _tag: "Signed",
        digest: theirs,
        signed: {
          digest: theirs,
          bytes: new Uint8Array([1, 2, 3]),
          signatures: [Signature.make("sig")],
          sender: SuiAddress.make(signer.address)
        },
        signedAt: DateTime.makeUnsafe(0)
      }))
    )
    const result = await run(
      Effect.die(new Error("boom")),
      Layer.merge(scriptLayer([]), Layer.succeed(Journal, shared))
    )
    expect(result.code).toBe(1)
    expect(result.printed).not.toContain(theirs)
    expect(result.printed).not.toContain("left unresolved")
  })
})

describe("wallet#2: an applied submission never exits 4", () => {
  test("a failure after this run's transaction applied exits 5, and says which", async () => {
    const program = Effect.gen(function*() {
      yield* Tx.run(transfer, { signer })
      return yield* new ObjectNotFound({ objectId: ObjectId.normalize("0xdead") })
    }).pipe(fast, Effect.provide(Journal.layerMemory))
    const result = await run(program, scriptLayer([FakeOutcome.succeed()]))
    expect(result.code).toBe(5)
    expect(result.printed).toContain("applied on chain")
  })

  test("a timeout after this run's transaction applied exits 5", async () => {
    const program = Effect.gen(function*() {
      yield* Tx.run(transfer, { signer })
      return yield* Effect.never
    }).pipe(fast, Effect.timeout("100 millis"), Effect.provide(Journal.layerMemory))
    const result = await run(program, scriptLayer([FakeOutcome.succeed()]))
    expect(result.code).toBe(5)
  })

  test("the exitCode table: applied turns 2, 4 and 130 into 5, and unresolved still wins", async () => {
    const notApplied = Effect.runSyncExit(
      Effect.fail(new ObjectNotFound({ objectId: ObjectId.normalize("0x1") }))
    )
    expect(exitCode(notApplied)).toBe(4)
    expect(exitCode(notApplied, { applied: 1 })).toBe(5)
    expect(exitCode(notApplied, { applied: 1, unresolved: 1 })).toBe(4)
    const interrupted = await Effect.runPromiseExit(Effect.interrupt)
    expect(exitCode(interrupted, { applied: 1 })).toBe(5)
    expect(exitCode(interrupted, { applied: 1, unresolved: 1 })).toBe(3)
    const defect = Effect.runSyncExit(Effect.die("x"))
    expect(exitCode(defect, { applied: 1 })).toBe(1)
  })
})

describe("wallet#9: the NoDeps layers take the network from the client", () => {
  test("layerWithSigner and layerReadOnlyNoDeps need no SUI_NETWORK", async () => {
    const empty = ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))
    const network = await Effect.runPromise(
      Effect.map(Script, (s) => s.network).pipe(
        Effect.provide(scriptLayer([]).pipe(Layer.provide(empty)), { local: true })
      )
    )
    expect(network).toBe("localnet")
    const readOnly = await Effect.runPromise(
      Effect.map(ScriptReadOnly, (s) => s.network).pipe(
        Effect.provide(
          Script.layerReadOnlyNoDeps.pipe(
            Layer.provide(layerTest({ chainId: CHAIN_ID })),
            Layer.provide(empty)
          ),
          { local: true }
        )
      )
    )
    expect(readOnly).toBe("localnet")
  })

  test("a mainnet client still needs the gate", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.asVoid(Script).pipe(
        Effect.provide(
          Script.layerWithSigner(signer).pipe(
            Layer.provide(layerTest({ chainId: CHAIN_ID, network: "mainnet" })),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
          ),
          { local: true }
        )
      )
    )
    expect(exitCode(exit)).toBe(2)
  })
})

describe("wallet#10: a declared exitCode is honoured", () => {
  class BadInput extends Schema.TaggedError<BadInput>()("BadInput", {
    input: Schema.String
  }) {
    readonly outcome = "not_applied" as const
    readonly exitCode = 2
  }

  test("a script's own input error exits 2, not 4", async () => {
    const result = await run(Effect.fail(new BadInput({ input: "" })), scriptLayer([]))
    expect(result.code).toBe(2)
  })

  test("zero, fractions and out-of-range codes are ignored", () => {
    for (const declared of [0, 1.5, 256, -1]) {
      const exit = Effect.runSyncExit(
        Effect.fail({ _tag: "Odd", outcome: "not_applied", exitCode: declared })
      )
      expect(exitCode(exit)).toBe(4)
    }
  })
})

describe("wallet#11, ext#19: diagnostics are one line per failure", () => {
  const configLayer = (env: Record<string, string>, read: Effect.Effect<unknown, Config.ConfigError>) =>
    Layer.merge(scriptLayer([]), Layer.effectDiscard(read)).pipe(
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))
    )

  test("a missing variable is `missing NAME`", async () => {
    const result = await run(Effect.void, configLayer({}, readNetwork))
    expect(result.code).toBe(2)
    expect(result.lines).toEqual(["ConfigError missing SUI_NETWORK"])
  })

  test("a nested path is named the way the environment spells it", async () => {
    const result = await run(
      Effect.void,
      configLayer({}, Config.String("PACKAGE_ID").pipe(Config.nested("TIPJAR")))
    )
    expect(result.lines).toEqual(["ConfigError missing TIPJAR_PACKAGE_ID"])
  })

  test("a value that does not fit names the variable and the expectation, on one line", async () => {
    const result = await run(
      Effect.void,
      configLayer(
        { N: "abc" },
        Config.Number("N")
      )
    )
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toStartWith("ConfigError N: Expected")
    expect(result.lines[0]).not.toContain("\n")
  })

  test("the mainnet gate is its message", async () => {
    const result = await run(Effect.void, configLayer({ SUI_NETWORK: "mainnet" }, readNetwork))
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0]).toContain("SUI_ALLOW_MAINNET=1")
  })

  test("a SubmissionUnknown's bytes are printed once, in its entry", async () => {
    const program = Effect.gen(function*() {
      const error = yield* Tx.run(transfer, { signer }).pipe(fastTimeout, Effect.flip)
      return yield* (error._tag === "SubmissionUnknown" ? Effect.fail(error) : Effect.die(error))
    }).pipe(Effect.provide(Journal.layerMemory))
    const result = await run(program, scriptLayer([FakeOutcome.timeoutThen(false)]))
    expect(result.code).toBe(3)
    // The bytes once: in the `entry:` line, not in a `bytes:` line as well.
    expect(result.lines.filter((line) => line.startsWith("bytes: "))).toHaveLength(0)
    expect(result.lines.filter((line) => line.startsWith("entry: "))).toHaveLength(1)
    // The type is used, so the import is not dead weight.
    expect(SubmissionUnknown).toBeDefined()
  })
})
