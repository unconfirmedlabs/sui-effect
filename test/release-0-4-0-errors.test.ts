/**
 * 0.4.0 fix round F1: errors and `SuiError.describe`.
 *
 * Every case here is a dogfood finding: a line that hid the reason
 * (`SimulationFailed Unknown`, a bare `SigningError`), printed the packed
 * clever-abort integer, repeated itself, broke onto two lines, or a helper that
 * refused an `unknown` and made every Promise `catch` cast.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Config, ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
  BuildError,
  DecodeError,
  JournalError,
  SigningError,
  SimulationFailed,
  SubmissionUnknown,
  SuiError,
  TransportError
} from "../src/index.ts"
import { ExecutionReason, executionReasonOf } from "../src/domain/schemas.ts"
import { SuiSchema } from "../src/index.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const DIGEST = "11111111111111111111111111111111"
const PKG = PADDED("b0a2d")
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }
const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: 1_700_000_000_000n,
  objects: [{
    objectId: ESCROW_ID,
    type: ESCROW_TYPE,
    version: 3n,
    owner,
    content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
  }],
  coins: [{
    objectId: PADDED("c01"),
    version: "2",
    digest: DIGEST,
    type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
    balance: "1000000000",
    owner,
    previousTransaction: null
  } as unknown as SuiClientTypes.Coin]
}

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory),
      { local: true }
    )
  )

/** What the SDK's gRPC parser hands back for a kind it has no variant for. */
const insufficientCoinBalance = {
  $kind: "Unknown",
  Unknown: null,
  message: "InsufficientCoinBalance in command 1",
  command: 1
} as unknown as SuiClientTypes.ExecutionError

/** A clever error, as the SDK's gRPC parser reports one. */
const cleverAbort = {
  $kind: "MoveAbort",
  message: "MoveAbort in 1st command, 'EEmptyBody': body must not be empty",
  command: 0,
  MoveAbort: {
    abortCode: "13906834513645862914",
    location: { package: PKG, module: "board", functionName: "post", instruction: 7 },
    cleverError: {
      errorCode: 7,
      lineNumber: 42,
      constantName: "EEmptyBody",
      constantType: "vector<u8>",
      value: "body must not be empty"
    }
  }
} as unknown as SuiClientTypes.ExecutionError

const effectsOf = async () => {
  const failed = await run(
    Tx.run(claim, { signer }).pipe(Effect.flip),
    { ...baseScript, execute: [FakeOutcome.failWith(cleverAbort)] }
  )
  if (failed._tag !== "ExecutionFailed") throw new Error(`expected ExecutionFailed, got ${failed._tag}`)
  return failed
}

describe("an Unknown reason keeps the node's sentence (wallet#3, move#1, sponsor#4)", () => {
  test("executionReasonOf keeps message and command on Unknown", () => {
    const reason = executionReasonOf(insufficientCoinBalance)
    expect(reason).toEqual({
      $kind: "Unknown",
      message: "InsufficientCoinBalance in command 1",
      command: 1
    } as never)
  })

  test("a variant this version does not model falls back to Unknown with the sentence", () => {
    const reason = executionReasonOf({
      $kind: "SomethingNew",
      SomethingNew: { x: 1 },
      message: "SomethingNew happened",
      command: 2
    } as unknown as SuiClientTypes.ExecutionError)
    expect(reason.$kind).toBe("Unknown")
    expect(SuiError.describe(new SimulationFailed({ reason, message: "x" }))).toBe(
      "SimulationFailed SomethingNew happened in command 2"
    )
  })

  test("Tx.build's simulation of an insufficient balance names it, once", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.failWith(insufficientCoinBalance)] }
    )
    expect(error._tag).toBe("SimulationFailed")
    if (error._tag !== "SimulationFailed") return
    expect(error.command).toBe(1)
    // "in command 1" is in the node's sentence already and is not repeated.
    expect(SuiError.describe(error)).toBe("SimulationFailed InsufficientCoinBalance in command 1")
  })

  test("an on-chain Unknown reads the same as a simulated one", async () => {
    const error = await run(
      Tx.run(claim, { signer }).pipe(Effect.flip),
      { ...baseScript, execute: [FakeOutcome.failWith(insufficientCoinBalance)] }
    )
    expect(error._tag).toBe("ExecutionFailed")
    expect(SuiError.describe(error)).toBe("ExecutionFailed InsufficientCoinBalance in command 1")
  })

  test("with no sentence on the reason, SimulationFailed.message is the fallback, minus the resolver prefix", () => {
    const error = new SimulationFailed({
      reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }),
      message: "Transaction resolution failed: FunctionNotFound in command 0"
    })
    expect(SuiError.describe(error)).toBe("SimulationFailed FunctionNotFound in command 0")
  })

  test("an Unknown with nothing at all still says Unknown", () => {
    const error = new SimulationFailed({
      reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }),
      message: ""
    })
    expect(SuiError.describe(error)).toBe("SimulationFailed Unknown")
  })

  test("the new fields round-trip through toJson's schema", () => {
    const reason = executionReasonOf(insufficientCoinBalance)
    const json = SuiError.toJson(new SimulationFailed({ reason, message: "m", command: 1 }))
    expect(json["command"]).toBe(1)
    expect(json["reason"]).toEqual({
      $kind: "Unknown",
      message: "InsufficientCoinBalance in command 1",
      command: 1
    })
  })
})

describe("a Move abort reads the same before and after the send (move#2, move#6)", () => {
  const LINE =
    `MoveAbort ${PKG}::board::post EEmptyBody "body must not be empty" (line 42) code 7 in command 0`

  test("a clever error names its constant, value, line and declared code — never the packed integer", async () => {
    const failed = await effectsOf()
    const line = SuiError.describe(failed)
    expect(line).toBe(`ExecutionFailed ${LINE}`)
    expect(line).not.toContain("13906834513645862914")
  })

  test("SimulationFailed carries command and describes the same abort identically", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.failWith(cleverAbort)] }
    )
    expect(error._tag).toBe("SimulationFailed")
    if (error._tag !== "SimulationFailed") return
    expect(error.command).toBe(0)
    expect(SuiError.describe(error)).toBe(`SimulationFailed ${LINE}`)
    const executed = await effectsOf()
    expect(SuiError.describe(error, { tag: false })).toBe(
      SuiError.describe(executed, { tag: false })
    )
  })

  test("a plain abort reads code N", () => {
    const reason = executionReasonOf({
      $kind: "MoveAbort",
      message: "x",
      MoveAbort: { abortCode: "3", location: { package: PKG, module: "board", functionName: "post" } }
    } as unknown as SuiClientTypes.ExecutionError)
    expect(SuiError.describe(new SimulationFailed({ reason, message: "x", command: 2 }))).toBe(
      `SimulationFailed MoveAbort ${PKG}::board::post code 3 in command 2`
    )
  })

  test("a numeric constant is not quoted", () => {
    const reason = executionReasonOf({
      ...cleverAbort,
      MoveAbort: {
        abortCode: "1",
        cleverError: { constantName: "ELimit", constantType: "u64", value: "100" }
      }
    } as unknown as SuiClientTypes.ExecutionError)
    expect(SuiError.describe(new SimulationFailed({ reason, message: "x" }))).toBe(
      "SimulationFailed MoveAbort ELimit 100"
    )
  })
})

describe("SuiError.moveAbort and isMoveAbort (move#3, ext#13)", () => {
  test("reads the fields a caller matches on", async () => {
    const failed = await effectsOf()
    const abort = SuiError.moveAbort(failed)
    expect(Option.isSome(abort)).toBe(true)
    if (Option.isNone(abort)) return
    expect(abort.value).toEqual({
      package: PKG,
      module: "board",
      function: "post",
      code: 7n,
      abortCode: 13906834513645862914n,
      constant: "EEmptyBody",
      message: "body must not be empty",
      line: 42,
      command: 0
    })
  })

  test("a plain abort's code is its abortCode", () => {
    const reason = executionReasonOf({
      $kind: "MoveAbort",
      message: "x",
      MoveAbort: { abortCode: "3", location: { module: "board" } }
    } as unknown as SuiClientTypes.ExecutionError)
    const abort = SuiError.moveAbort(new SimulationFailed({ reason, message: "x" }))
    expect(Option.getOrThrow(abort)).toEqual({ module: "board", code: 3n, abortCode: 3n })
  })

  test("is none for anything that is not a Move abort", () => {
    expect(Option.isNone(SuiError.moveAbort(new Error("x")))).toBe(true)
    expect(Option.isNone(SuiError.moveAbort(undefined))).toBe(true)
    expect(
      Option.isNone(SuiError.moveAbort(new SimulationFailed({
        reason: executionReasonOf(insufficientCoinBalance),
        message: "x"
      })))
    ).toBe(true)
  })

  test("isMoveAbort matches on module, constant, code and package", async () => {
    const failed: unknown = await effectsOf()
    expect(SuiError.isMoveAbort(failed)).toBe(true)
    expect(SuiError.isMoveAbort(failed, { module: "board", constant: "EEmptyBody" })).toBe(true)
    expect(SuiError.isMoveAbort(failed, { module: "board", code: 7 })).toBe(true)
    expect(SuiError.isMoveAbort(failed, { code: 7n, function: "post" })).toBe(true)
    // Padding and case do not matter for the package.
    expect(SuiError.isMoveAbort(failed, { package: "0xB0A2D" })).toBe(true)
    expect(SuiError.isMoveAbort(failed, { module: "tipjar" })).toBe(false)
    expect(SuiError.isMoveAbort(failed, { constant: "EOther" })).toBe(false)
    expect(SuiError.isMoveAbort(failed, { code: 13906834513645862914n })).toBe(false)
    expect(SuiError.isMoveAbort(new Error("x"), {})).toBe(false)
  })
})

describe("cause lines (move#5, sponsor#4)", () => {
  test("BuildError appends what the recipe threw, with the error's name", async () => {
    const error = await run(
      Tx.build(() => {
        throw new TypeError("undefined is not an object (evaluating 'coin.objectId')")
      }, { sender: SENDER }).pipe(Effect.flip)
    )
    expect(error._tag).toBe("BuildError")
    expect(SuiError.describe(error)).toMatch(
      /^BuildError .+: TypeError: undefined is not an object \(evaluating 'coin\.objectId'\)$/
    )
  })

  test("BuildError over a TransportError prints the transport's own line", () => {
    const cause = new TransportError({
      method: "Tx.build",
      retryable: false,
      status: "INVALID_ARGUMENT",
      cause: new Error("Object 0xfe57 is owned by account address 0x439d")
    })
    expect(SuiError.describe(new BuildError({ message: "the node refused the inputs", cause }))).toBe(
      "BuildError the node refused the inputs: TransportError Tx.build INVALID_ARGUMENT: Object 0xfe57 is owned by account address 0x439d"
    )
  })

  test("SigningError and JournalError say why", () => {
    expect(SuiError.describe(new SigningError({ cause: "the signature was made by 0xf7e0, not 0xd472" })))
      .toBe("SigningError: the signature was made by 0xf7e0, not 0xd472")
    expect(new JournalError({ cause: new Error("ENOSPC: no space left on device") }).message)
      .toBe("JournalError: ENOSPC: no space left on device")
    expect(SuiError.describe(new SigningError({ cause: undefined }))).toBe("SigningError")
  })

  test("a multi-line cause is folded onto one line", () => {
    const line = SuiError.describe(new JournalError({ cause: new Error("first\n  second\nthird") }))
    expect(line).toBe("JournalError: first second third")
  })
})

describe("SubmissionUnknown stays one readable line (wallet#5, wallet#11)", () => {
  const signed = {
    digest: DIGEST,
    bytes: new Uint8Array(4096).fill(7),
    signatures: ["AAAA"],
    sender: SENDER
  }

  test("a TransportError cause is printed; the bytes never are", () => {
    const error = new SubmissionUnknown({
      digest: DIGEST as never,
      signed: signed as never,
      cause: new TransportError({
        method: "executeTransaction",
        retryable: false,
        status: "FAILED_PRECONDITION",
        cause: new Error(
          "Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable).\nObject already locked by a different transaction: 9jRM"
        )
      })
    })
    const line = SuiError.describe(error)
    expect(line).toBe(
      `SubmissionUnknown ${DIGEST}: TransportError executeTransaction FAILED_PRECONDITION: Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable). Object already locked by a different transaction: 9jRM`
    )
    // 4 KiB of 0x07 in base64 is "BwcH..."; none of it reaches the line.
    expect(line).not.toContain("BwcH")
    expect(line.length).toBeLessThan(400)
  })

  test("the last send's failure is read from the cause, where Tx.submit folds it", () => {
    // `SubmissionUnknown` has no `lastError` field: `Tx.reconcileSigned` puts
    // the last send's line into `cause`, so that is the only place describe
    // reads. A stray `lastError` property is not part of the error.
    const error = Object.assign(
      new SubmissionUnknown({
        digest: DIGEST as never,
        cause:
          "the node does not know this digest; the last send failed with TransportError executeTransaction UNAVAILABLE (retryable): connection reset"
      }),
      { lastError: "ignored" }
    )
    expect(SuiError.describe(error)).toBe(
      `SubmissionUnknown ${DIGEST}: the node does not know this digest; the last send failed with TransportError executeTransaction UNAVAILABLE (retryable): connection reset`
    )
  })
})

describe("DecodeError kind type (ext#12)", () => {
  test("names the object, the type it is and the type expected, once each", async () => {
    const codec = SuiSchema.bcs(EscrowBcs, ESCROW_TYPE)
    const error = await Effect.runPromise(
      SuiSchema.decode(codec, new Uint8Array(), {
        objectId: ESCROW_ID as never,
        actualType: `${PADDED("2")}::escrow::OwnerCap`
      }).pipe(Effect.flip)
    )
    expect(error.actualType).toBe(`${PADDED("2")}::escrow::OwnerCap`)
    expect(SuiError.describe(error)).toBe(
      `DecodeError type: object ${ESCROW_ID} is ${PADDED("2")}::escrow::OwnerCap, expected ${ESCROW_TYPE}`
    )
  })

  test("a hand-built type error without actualType keeps the old wording", () => {
    const error = new DecodeError({ kind: "type", expectedType: "T", issue: "not one of mine" })
    expect(SuiError.describe(error)).toBe("DecodeError type T not one of mine")
  })
})

describe("the helpers take unknown (ext#11, sponsor#10, ext#7)", () => {
  const schemaError = Schema.decodeUnknownResult(Schema.Struct({ a: Schema.String }))({})

  test("describe, outcome and toJson accept a SchemaError, an Error, a string and nothing", () => {
    expect(schemaError._tag).toBe("Failure")
    if (schemaError._tag !== "Failure") return
    const values: ReadonlyArray<unknown> = [
      schemaError.failure,
      new TypeError("boom"),
      "plain string",
      42,
      null,
      undefined
    ]
    for (const value of values) {
      const line = SuiError.describe(value)
      expect(typeof line).toBe("string")
      expect(line.length).toBeGreaterThan(0)
      expect(line).not.toContain("\n")
      expect(SuiError.outcome(value)).toBe("unknown")
      expect(SuiError.outcome(value, { phase: "pre-submit" })).toBe("not_applied")
      const json = SuiError.toJson(value)
      expect(typeof json["_tag"]).toBe("string")
      expect(typeof json["message"]).toBe("string")
      expect(SuiError.isRetryable(value)).toBe(false)
    }
    expect(SuiError.describe(new TypeError("boom"))).toBe("TypeError: boom")
    expect(SuiError.toJson(new TypeError("boom"))).toEqual({ _tag: "TypeError", message: "TypeError: boom" })
    expect(SuiError.toJson("plain")).toEqual({ _tag: "UnknownError", message: "plain" })
  })

  test("SuiError.digestOf is public and total", async () => {
    const failed = await effectsOf()
    expect(SuiError.digestOf(failed)).toBe(failed.digest)
    expect(SuiError.digestOf(new Error("x"))).toBeUndefined()
    expect(SuiError.digestOf({ _tag: "SubmissionUnknown" })).toBeUndefined()
  })

  test("{ tag: false } drops the leading tag", () => {
    expect(SuiError.describe(new SigningError({ cause: "refused" }), { tag: false })).toBe("refused")
    expect(SuiError.describe({ _tag: "EscrowGone", message: "gone" }, { tag: false })).toBe("gone")
    expect(SuiError.describe(new SigningError({ cause: undefined }), { tag: false })).toBe(
      "SigningError"
    )
  })
})

describe("ConfigError names the variable on one line (wallet#11, ext#19)", () => {
  const configError = (config: Config.Config<unknown>, env: Record<string, string>) =>
    Effect.runPromise(
      config.pipe(
        Effect.flip,
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
      )
    )

  test("a missing variable", async () => {
    const error = await configError(Config.NonEmptyString("SUI_NETWORK"), {})
    expect(SuiError.describe(error)).toBe("ConfigError missing SUI_NETWORK")
    expect(SuiError.toJson(error)).toEqual({ _tag: "ConfigError", message: "missing SUI_NETWORK" })
  })

  test("a missing struct names its keys as env vars", async () => {
    const error = await configError(
      Config.schema(
        Schema.Struct({ PACKAGE_ID: Schema.String, NOTE: Schema.optionalKey(Schema.String) }),
        "TIPJAR"
      ),
      {}
    )
    expect(SuiError.describe(error)).toBe("ConfigError missing TIPJAR_PACKAGE_ID")
  })

  test("one key of a struct missing", async () => {
    const error = await configError(
      Config.schema(Schema.Struct({ PACKAGE_ID: Schema.String, B: Schema.String }), "TIPJAR"),
      { TIPJAR_B: "x" }
    )
    expect(SuiError.describe(error)).toBe("ConfigError missing TIPJAR_PACKAGE_ID")
  })

  test("a value that is there and wrong", async () => {
    const error = await configError(Config.Int("PORT"), { PORT: "abc" })
    const line = SuiError.describe(error)
    expect(line).toMatch(/^ConfigError PORT: /)
    expect(line).not.toContain("\n")
  })
})
