import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Cause, ConfigProvider, Console, DateTime, Effect, Exit, Layer, Schema } from "effect"
import type { SuiError as SuiErrorType } from "../src/domain/errors.ts"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  ExtensionNotReady,
  GraphQLUnavailable,
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
import { SuiError, SuiErrorSchema } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Journal } from "../src/services/Journal.ts"
import { fakeDigest } from "../src/services/SuiCoreFake.ts"
import { Digest, ExecutionReason, Mist, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { exitCode, readNetwork, Script, ScriptReadOnly } from "../src/services/Script.ts"
import { Signer } from "../src/services/Signer.ts"
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
      new JournalError({ cause: "disk full" })
    ]
    for (const error of notApplied) expect(exitCode(fail(error))).toBe(4)
  })

  test("5 for UnexpectedEffects, which can only come from a transaction that applied", () => {
    // It is built from an `Executed`: the transaction reached the chain and gas
    // was charged, and only the receipt is missing. Exit 4 told a wrapper the
    // opposite — nothing happened, safe to retry.
    expect(
      exitCode(fail(new UnexpectedEffects({ digest: DIGEST, expected: "0x2::a::B", found: [] })))
    ).toBe(5)
  })

  test("4 for a TimeoutError with nothing outstanding in the journal", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.never.pipe(Effect.timeout("1 milli"), Effect.provide(Layer.empty))
    )
    expect(exitCode(exit)).toBe(4)
  })

  test("3 for a TimeoutError when the journal still holds a submission", async () => {
    // An `Effect.timeout` wrapped around a whole submission interrupts it from
    // the outside and never reaches `Tx.submit`'s own mapping, so the bytes may
    // be on the wire. Exit 4 would say "safe to retry" about a transaction
    // nobody has an answer for.
    const exit = await Effect.runPromiseExit(
      Effect.never.pipe(Effect.timeout("1 milli"), Effect.provide(Layer.empty))
    )
    expect(exitCode(exit, { unresolved: 1 })).toBe(3)
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

  test("1, not 3, for a tag this library has never heard of", () => {
    // `SuiError.outcome` answers "unknown" for the same value, and the two are
    // meant to disagree: exit 3 tells a wrapper there is a digest to
    // reconcile, and an unrecognised error is not evidence that anything was
    // ever sent. Extensions are told to declare `outcome` for exactly this.
    class Foreign {
      readonly _tag = "some-sdk/Foreign"
    }
    expect(exitCode(fail(new Foreign()))).toBe(1)
    expect(SuiError.outcome(new Foreign() as never)).toBe("unknown")
  })

  // NB1: `codeOfError` has no per-tag `switch` any more, so the mapping cannot
  // fall behind the taxonomy. This is the proof, over every tag the schema
  // declares rather than a list written here — and the `Missing` alias below
  // stops compiling when a class is added to `SuiErrorSchema` without a
  // fixture, which is exactly the edit that used to go unnoticed.
  test("agrees with SuiError.outcome for every tag in the taxonomy", () => {
    const objectId = SuiAddress.make(ID) as never
    const fixtures = {
      TransportError: new TransportError({ method: "getObject", retryable: true, cause: "down" }),
      ObjectNotFound: new ObjectNotFound({ objectId }),
      ObjectDeleted: new ObjectDeleted({ objectId }),
      ObjectUnavailable: new ObjectUnavailable({ objectId }),
      TransactionNotFound: new TransactionNotFound({ digest: DIGEST }),
      NetworkMismatch: new NetworkMismatch({ expected: "a", actual: "b" }),
      DecodeError: new DecodeError({ issue: "bad bytes" }),
      SimulationFailed: new SimulationFailed({ reason: UNKNOWN_REASON, message: "no" }),
      ExecutionFailed: new ExecutionFailed({ digest: DIGEST, reason: UNKNOWN_REASON, effects }),
      SubmissionUnknown: new SubmissionUnknown({ digest: DIGEST, signed, cause: "timeout" }),
      NotApplied: new NotApplied({ digest: DIGEST, evidence: "expired" }),
      SigningError: new SigningError({ cause: "no key" }),
      BuildError: new BuildError({ message: "no gas", cause: "x" }),
      PolicyDenied: new PolicyDenied({ rule: "spend", message: "too much" }),
      JournalError: new JournalError({ cause: "disk full" }),
      UnexpectedEffects: new UnexpectedEffects({ digest: DIGEST, expected: "0x2::a::B", found: [] }),
      GraphQLUnavailable: new GraphQLUnavailable({ method: "query", reason: "no endpoint" }),
      ExtensionNotReady: new ExtensionNotReady({ extension: "escrow", member: "status" })
    } as const
    // A tag in the taxonomy with no fixture above is a compile error.
    type Missing = Exclude<SuiErrorType["_tag"], keyof typeof fixtures>
    const noMissingFixture = <_T extends never>(): true => true
    expect(noMissingFixture<Missing>()).toBe(true)

    const byOutcome = { applied: 5, unknown: 3, not_applied: 4 } as const
    const tags = Object.keys(SuiErrorSchema.pipe(Schema.toTaggedUnion("_tag")).cases)
    expect(tags.sort()).toEqual(Object.keys(fixtures).sort())

    for (const tag of tags) {
      const error = fixtures[tag as keyof typeof fixtures]
      // `NetworkMismatch` is the one tag off the applied/not-applied axis: it
      // is a configuration problem, and no retry fixes it.
      const expected = tag === "NetworkMismatch" ? 2 : byOutcome[SuiError.outcome(error)]
      expect([tag, exitCode(fail(error))]).toEqual([tag, expected])
    }
  })

  test("2 for a SchemaError, which is a person's input not fitting a schema", async () => {
    const error = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))({ id: 7 }).pipe(Effect.flip)
    )
    expect(exitCode(fail(error))).toBe(2)
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

  test("ScriptReadOnly is the same preset with no signer on it", async () => {
    const readOnly = await Effect.runPromise(
      Effect.provide(
        ScriptReadOnly,
        Script.layerReadOnlyNoDeps.pipe(
          Layer.provideMerge(layerTest({ chainId: CHAIN_ID })),
          // No `SUI_PRIVATE_KEY` at all: a read-only script must build without
          // a credential in the environment.
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "localnet" })))
        ),
        { local: true }
      )
    )
    expect(readOnly.network).toBe("localnet")
    expect(readOnly.sui.chainId).toBe(CHAIN_ID)
    // The service shape has no `signer`: a script written against `Script`
    // cannot silently build over a layer that cannot sign.
    expect("signer" in readOnly).toBe(false)
  })

  test("layerWithSigner uses the credential it was handed, not the environment", async () => {
    const handed = Signer.fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(6)))
    const script = await Effect.runPromise(
      Effect.provide(
        Script,
        Script.layerWithSigner(handed).pipe(
          Layer.provideMerge(layerTest({ chainId: CHAIN_ID })),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({
                SUI_NETWORK: "localnet",
                // Deliberately a different key: it must be ignored.
                SUI_PRIVATE_KEY: keypair.getSecretKey()
              })
            )
          )
        ),
        { local: true }
      )
    )
    expect(script.signer.address).toBe(handed.address)
    expect(script.signer.address).not.toBe(SuiAddress.make(keypair.toSuiAddress()))
  })

  test("the mainnet gate is checked before a client is built", async () => {
    // `Script.layer` and `Script.layerReadOnly` build a real gRPC client and
    // ask it for the chain identifier. Reading the gate inside that layer would
    // check it after the connection it exists to prevent, so it is read first,
    // through `Layer.unwrap`. This test would have to reach the network if it
    // were not.
    const mainnet = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SUI_NETWORK: "mainnet",
        SUI_PRIVATE_KEY: keypair.getSecretKey()
      })
    )
    const signing = await Effect.runPromiseExit(
      Effect.asVoid(Script).pipe(
        Effect.provide(Script.layer, { local: true }),
        Effect.provide(mainnet)
      )
    )
    expect(exitCode(signing)).toBe(2)

    const reading = await Effect.runPromiseExit(
      Effect.asVoid(ScriptReadOnly).pipe(
        Effect.provide(Script.layerReadOnly, { local: true }),
        Effect.provide(mainnet)
      )
    )
    expect(exitCode(reading)).toBe(2)
  }, 5_000)
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

  test("Effect.log lands on stderr and stdout stays clean", async () => {
    // A script's stdout is its answer, and the default Effect logger writes to
    // `console.log`. One `Effect.logInfo` inside a library an extension
    // depends on would otherwise corrupt the output of every script on the
    // platform.
    const stdout: Array<unknown> = []
    const original = console.log
    console.log = (...args: ReadonlyArray<unknown>) => stdout.push(args.join(" "))
    let result
    try {
      result = await runScript(
        Effect.gen(function*() {
          yield* Effect.log("about to claim")
          yield* Effect.logWarning("the gas price moved")
          yield* Console.log("the-answer")
        })
      )
    } finally {
      console.log = original
    }
    expect(result.code).toBe(0)
    expect(stdout).toEqual(["the-answer"])
    expect(result.lines.join("\n")).toContain("about to claim")
    expect(result.lines.join("\n")).toContain("the gas price moved")
  })

  test("an injected signal interrupts the script, runs finalizers and exits 130", async () => {
    const handlers: Array<() => void> = []
    const released: Array<string> = []
    const lines: Array<string> = []
    const codes: Array<number> = []
    const layer = Script.layerNoDeps.pipe(
      Layer.provideMerge(layerTest({ chainId: CHAIN_ID })),
      Layer.provide(env())
    )
    const finished = Script.run(
      Effect.never.pipe(
        Effect.onExit(() => Effect.sync(() => released.push("finalizer"))),
        Effect.ensuring(Effect.sync(() => released.push("ensuring")))
      ),
      {
        layer,
        exit: (code) => codes.push(code),
        stderr: (line) => lines.push(line),
        signals: {
          on: (_name, handler) => handlers.push(handler),
          off: () => undefined
        }
      }
    )
    // The script is parked on `Effect.never`; only the signal can end it.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(handlers).toHaveLength(2)
    handlers[0]!()
    // A second SIGINT is ignored on purpose: the point of the first is to let
    // the finalizers finish.
    handlers[0]!()
    const code = await finished
    expect(code).toBe(130)
    expect(codes).toEqual([130])
    expect(released).toEqual(["finalizer", "ensuring"])
    expect(lines).toContain("interrupted")
  })

  test("a defect prints what the default journal still holds unresolved", async () => {
    // A script killed between signing and the answer otherwise exits with no
    // digest and no bytes, and nobody can account for the transaction. The
    // default journal is process-wide, which is what makes it readable from
    // outside the fiber that wrote to it.
    const digest = Digest.make(fakeDigest(31))
    await Effect.runPromise(
      Effect.flatMap(Journal, (journal) =>
        journal.put(
          JournalEntry.cases.Signed.make({
            _tag: "Signed",
            digest,
            signed: { ...signed, digest },
            signedAt: DateTime.makeUnsafe(0)
          })
        ))
    )
    const result = await runScript(Effect.die(new Error("killed mid-submit")))
    expect(result.code).toBe(1)
    const printed = result.lines.join("\n")
    expect(printed).toContain("killed mid-submit")
    expect(printed).toContain(`unresolved ${digest} (Signed)`)
    expect(printed).toContain("bytes: ")

    // Clean up after ourselves: the default journal outlives this test.
    await Effect.runPromise(
      Effect.flatMap(Journal, (journal) =>
        journal.put(
          JournalEntry.cases.Executed.make({ _tag: "Executed", digest, at: DateTime.makeUnsafe(0) })
        ))
    )
  })
})
