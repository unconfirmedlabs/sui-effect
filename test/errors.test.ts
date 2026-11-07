/**
 * The error taxonomy: every class round-trips through its schema, the outcome
 * classification, the one-line description, and the helpers that take
 * `unknown`.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Config, ConfigProvider, Effect, Option, Schema } from "effect"
import { TestSchema } from "effect/testing"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
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
  SuiError,
  SuiErrorSchema,
  TransactionNotFound,
  TransportError,
  UnexpectedEffects
} from "../src/domain/errors.ts"
import { KeyError } from "../src/domain/keys.ts"
import {
  Digest,
  ExecutionReason,
  executionReasonOf,
  ObjectId,
  Signature,
  StructTag,
  SuiAddress,
  TransactionEffects
} from "../src/domain/schemas.ts"

const DIGEST = Digest.make("7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn")
const ADDRESS = SuiAddress.make(`0x${"ab".repeat(32)}`)
const OBJECT = ObjectId.make(`0x${"ab".repeat(32)}`)
const PKG = `0x${"0".repeat(59)}b0a2d`

const effects = Schema.decodeUnknownSync(TransactionEffects)({
  version: 2,
  status: { success: false },
  gasUsed: { computationCost: "1000", storageCost: "2000", storageRebate: "500", nonRefundableStorageFee: "5" },
  transactionDigest: DIGEST,
  gasObject: null,
  eventsDigest: null,
  dependencies: [],
  lamportVersion: "7",
  changedObjects: [],
  unchangedConsensusObjects: [],
  auxiliaryDataDigest: null
})

/** A clever error, as the SDK's gRPC parser reports one. */
const cleverAbort = {
  $kind: "MoveAbort",
  message: "MoveAbort in 1st command, 'EEmptyBody': body must not be empty",
  command: 0,
  MoveAbort: {
    abortCode: "13906834513645862914",
    location: { package: PKG, module: "board", functionName: "post", instruction: 7 },
    cleverError: { errorCode: 7, lineNumber: 42, constantName: "EEmptyBody", constantType: "vector<u8>", value: "body must not be empty" }
  }
} as unknown as SuiClientTypes.ExecutionError
const clever = executionReasonOf(cleverAbort)
const signed = { digest: DIGEST, bytes: new Uint8Array([0, 1, 2, 253, 254, 255]), signatures: [Signature.make("sig")], sender: ADDRESS }
const executionFailed = new ExecutionFailed({ digest: DIGEST, reason: clever, command: 0, effects })

/** One instance of every class in the taxonomy, and the outcome it carries. */
const taxonomy = [
  [new TransportError({ method: "getObject", retryable: true, status: "UNAVAILABLE", cause: "x" }), "not_applied"],
  [new ObjectNotFound({ objectId: OBJECT }), "not_applied"],
  [new ObjectDeleted({ objectId: OBJECT }), "not_applied"],
  [new ObjectUnavailable({ objectId: OBJECT }), "not_applied"],
  [new TransactionNotFound({ digest: DIGEST }), "not_applied"],
  [new NetworkMismatch({ expected: "testnet", actual: "mainnet" }), "not_applied"],
  [new DecodeError({ objectId: OBJECT, expectedType: "0x2::sui::SUI", issue: "bad" }), "not_applied"],
  [new SimulationFailed({ reason: clever, message: "aborted" }), "not_applied"],
  [executionFailed, "applied"],
  [new SubmissionUnknown({ digest: DIGEST, signed, cause: "timeout" }), "unknown"],
  [new NotApplied({ digest: DIGEST, evidence: "inputConsumed" }), "not_applied"],
  [new SigningError({ cause: "no key" }), "not_applied"],
  [new BuildError({ message: "no gas", cause: "x" }), "not_applied"],
  [new PolicyDenied({ rule: "spend-limit", message: "too much" }), "not_applied"],
  [new JournalError({ cause: "disk" }), "not_applied"],
  [
    new UnexpectedEffects({
      digest: DIGEST,
      expected: StructTag.make(`0x${"0".repeat(63)}2::coin::Coin<0x${"0".repeat(63)}2::sui::SUI>`),
      found: [OBJECT]
    }),
    "applied"
  ],
  [new GraphQLUnavailable({ method: "query", reason: "no endpoint" }), "not_applied"]
] as const

describe("the taxonomy", () => {
  test("covers every tag SuiErrorSchema knows", () => {
    expect<ReadonlyArray<string>>(taxonomy.map(([error]) => error._tag).sort()).toEqual(
      Object.keys(SuiErrorSchema.pipe(Schema.toTaggedUnion("_tag")).cases).sort()
    )
  })

  test("every class encodes to JSON and decodes back through its own schema and SuiErrorSchema", async () => {
    for (const [error] of taxonomy) {
      const schema = error.constructor as unknown as Schema.Codec<unknown, unknown>
      const encoded = Schema.encodeUnknownSync(schema)(error)
      expect(() => JSON.stringify(encoded)).not.toThrow()
      const asserts = new TestSchema.Asserts(schema)
      await asserts.encoding().succeed(error, encoded)
      await asserts.decoding().succeed(encoded, error)
      const json = SuiError.toJson(error)
      expect(Schema.decodeUnknownSync(SuiErrorSchema)(json)._tag).toBe(error._tag)
    }
  })

  test("outcome: applied, unknown or not_applied by tag, and the message is never empty", () => {
    for (const [error, outcome] of taxonomy) {
      expect([error._tag, SuiError.outcome(error)]).toEqual([error._tag, outcome])
      expect(SuiError.isTaxonomy(error)).toBe(true)
      const json = SuiError.toJson(error)
      expect([error._tag, json["message"]]).toEqual([error._tag, (error as Error).message])
      expect((error as Error).message.length).toBeGreaterThan(0)
    }
  })

  test("a declared outcome wins; anything unclassified is unknown, or not_applied before a submit", () => {
    class Denied extends Schema.TaggedError<Denied>()("escrow/Denied", { rule: Schema.String }) {
      readonly outcome = "not_applied" as const
      override get message(): string {
        return `escrow denied by ${this.rule}`
      }
    }
    expect(SuiError.outcome(new Denied({ rule: "spend" }))).toBe("not_applied")
    expect(SuiError.toJson(new Denied({ rule: "spend" }))).toMatchObject({
      message: "escrow denied by spend",
      outcome: "not_applied"
    })
    for (const value of [new TypeError("boom"), { _tag: "WhoKnows" }, "plain", 42, null, undefined]) {
      expect(SuiError.outcome(value)).toBe("unknown")
      expect(SuiError.outcome(value, { phase: "pre-submit" })).toBe("not_applied")
      expect(SuiError.isTaxonomy(value)).toBe(false)
      expect(SuiError.isRetryable(value)).toBe(false)
      const line = SuiError.describe(value)
      expect(line.length).toBeGreaterThan(0)
      expect(line).not.toContain("\n")
      expect(typeof SuiError.toJson(value)["_tag"]).toBe("string")
    }
    // The phase never overrides the taxonomy.
    expect(SuiError.outcome(executionFailed, { phase: "pre-submit" })).toBe("applied")
    expect(SuiError.toJson("plain")).toEqual({ _tag: "UnknownError", message: "plain" })
  })

  test("KeyError declares not_applied outside the taxonomy", () => {
    const error = new KeyError({ reason: "invalidMultisig", message: "not a member" })
    expect(SuiError.outcome(error)).toBe("not_applied")
    expect(SuiError.isTaxonomy(error)).toBe(false)
  })

  test("SubmissionUnknown encodes its signed bytes as base64 and describe never prints them", () => {
    const error = new SubmissionUnknown({ digest: DIGEST, signed, cause: "timeout" })
    expect((SuiError.toJson(error) as { signed: { bytes: unknown } }).signed.bytes).toBe("AAEC/f7/")
    const big = new SubmissionUnknown({ digest: DIGEST, signed: { ...signed, bytes: new Uint8Array(4096).fill(7) }, cause: "x" })
    expect(SuiError.describe(big)).not.toContain("BwcH")
  })

  test("isRetryable is true only for a retryable TransportError", () => {
    expect(SuiError.isRetryable(new TransportError({ method: "m", retryable: true, cause: "x" }))).toBe(true)
    expect(SuiError.isRetryable(new TransportError({ method: "m", retryable: false, cause: "x" }))).toBe(false)
  })

  test("an absent optional field has no key in the JSON, and an explicit undefined does not decode", () => {
    const json = SuiError.toJson(new TransportError({ method: "getObject", retryable: true, cause: "x" }))
    expect("status" in json).toBe(false)
    const withKey = { _tag: "TransportError", method: "getObject", retryable: true, status: undefined, cause: "x" }
    expect(Schema.decodeUnknownResult(SuiErrorSchema)(withKey)._tag).toBe("Failure")
  })
})

describe("SuiError.describe", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a clever abort, never the packed code", executionFailed, `ExecutionFailed MoveAbort ${PKG}::board::post EEmptyBody "body must not be empty" (line 42) code 7 in command 0`],
    [
      "a plain abort",
      new SimulationFailed({
        reason: executionReasonOf({ $kind: "MoveAbort", message: "x", MoveAbort: { abortCode: "3", location: { package: PKG, module: "board", functionName: "post" } } } as unknown as SuiClientTypes.ExecutionError),
        message: "x",
        command: 2
      }),
      `SimulationFailed MoveAbort ${PKG}::board::post code 3 in command 2`
    ],
    [
      "an Unknown reason keeps the node's sentence",
      new SimulationFailed({
        reason: executionReasonOf({ $kind: "Unknown", Unknown: null, message: "InsufficientCoinBalance in command 1", command: 1 } as unknown as SuiClientTypes.ExecutionError),
        message: "x"
      }),
      "SimulationFailed InsufficientCoinBalance in command 1"
    ],
    [
      "a TransportError's cause",
      new TransportError({ method: "executeTransaction", retryable: false, status: "INVALID_ARGUMENT", cause: new Error("signature is not valid") }),
      "TransportError executeTransaction INVALID_ARGUMENT: signature is not valid"
    ],
    ["a SubmissionUnknown's cause", new SubmissionUnknown({ digest: DIGEST, cause: "the node timed out" }), `SubmissionUnknown ${DIGEST}: the node timed out`],
    ["nothing for an empty cause", new SubmissionUnknown({ digest: DIGEST, cause: undefined }), `SubmissionUnknown ${DIGEST}`],
    [
      "a BuildError over a TransportError",
      new BuildError({ message: "the node refused the inputs", cause: new TransportError({ method: "Tx.build", retryable: false, status: "INVALID_ARGUMENT", cause: new Error("owned by 0x439d") }) }),
      "BuildError the node refused the inputs: TransportError Tx.build INVALID_ARGUMENT: owned by 0x439d"
    ],
    ["a SigningError's cause", new SigningError({ cause: "made by 0xf7e0" }), "SigningError: made by 0xf7e0"],
    ["a multi-line cause on one line", new JournalError({ cause: new Error("first\n  second\nthird") }), "JournalError: first second third"],
    ["a foreign Error", new TypeError("boom"), "TypeError: boom"]
  ]
  for (const [name, error, line] of cases) {
    test(name, () => expect(SuiError.describe(error)).toBe(line))
  }

  test("{ tag: false } drops the tag, and a simulated abort reads like the executed one", () => {
    const simulated = new SimulationFailed({ reason: clever, message: "x", command: 0 })
    expect(SuiError.describe(simulated, { tag: false })).toBe(SuiError.describe(executionFailed, { tag: false }))
    expect(SuiError.describe(new SigningError({ cause: "refused" }), { tag: false })).toBe("refused")
  })

  test("a DecodeError of kind type names the object, the actual and the expected type", () => {
    const error = new DecodeError({ kind: "type", objectId: OBJECT, expectedType: "0x2::a::B", actualType: "0x2::a::C", issue: "x" })
    expect(SuiError.describe(error)).toBe(`DecodeError type: object ${OBJECT} is 0x2::a::C, expected 0x2::a::B`)
  })

  test("a ConfigError names the variable", async () => {
    const error = await Effect.runPromise(
      Config.NonEmptyString("SUI_NETWORK").pipe(Effect.flip, Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))))
    )
    expect(SuiError.describe(error)).toBe("ConfigError missing SUI_NETWORK")
  })
})

describe("Move aborts", () => {
  test("moveAbort reads the fields a caller matches on; none for anything else", () => {
    expect(Option.getOrThrow(SuiError.moveAbort(executionFailed))).toEqual({
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
    expect(Option.isNone(SuiError.moveAbort(new Error("x")))).toBe(true)
    expect(Option.isNone(SuiError.moveAbort(new SimulationFailed({ reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }), message: "x" })))).toBe(true)
  })

  test("isMoveAbort matches on module, constant, declared code and a normalized package", () => {
    const matches: ReadonlyArray<readonly [Parameters<typeof SuiError.isMoveAbort>[1], boolean]> = [
      [{ module: "board", constant: "EEmptyBody" }, true],
      [{ module: "board", code: 7 }, true],
      [{ code: 7n, function: "post" }, true],
      [{ package: "0xB0A2D" }, true],
      [{ module: "tipjar" }, false],
      [{ code: 13906834513645862914n }, false],
      [{ code: 1.5 }, false]
    ]
    for (const [filter, expected] of matches) expect([filter, SuiError.isMoveAbort(executionFailed, filter)]).toEqual([filter, expected])
    expect(SuiError.isMoveAbort(new Error("x"), {})).toBe(false)
  })

  test("digestOf is total", () => {
    expect(SuiError.digestOf(executionFailed)).toBe(DIGEST)
    expect(SuiError.digestOf(new Error("x"))).toBeUndefined()
  })
})

describe("TransportError.fromUnknown", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string | undefined, boolean]> = [
    ["a gRPC transport status", { code: "UNAVAILABLE" }, "UNAVAILABLE", true],
    ["a node's answer", { code: "INVALID_ARGUMENT" }, "INVALID_ARGUMENT", false],
    ["INTERNAL, a refused fetch under grpc-web", { code: "INTERNAL" }, "INTERNAL", true],
    ["HTTP 503", { status: 503 }, "503", true],
    ["HTTP 429", { status: 429 }, "429", true],
    ["HTTP 404", { status: 404 }, "404", false],
    ["an abort", new DOMException("aborted", "AbortError"), "DEADLINE_EXCEEDED", true],
    ["anything else", new Error("who knows"), undefined, false]
  ]
  for (const [name, cause, status, retryable] of cases) {
    test(name, () => {
      const error = TransportError.fromUnknown("m", cause)
      expect([error.status, error.retryable]).toEqual([status, retryable])
      expect(error.cause).toBe(cause)
    })
  }

  test("the caller may override retryability", () => {
    expect(TransportError.fromUnknown("m", new Error("x"), true).retryable).toBe(true)
    expect(TransportError.fromUnknown("m", { code: "UNAVAILABLE" }, false).retryable).toBe(false)
  })
})

describe("the helpers never loop or throw", () => {
  const total = (error: unknown) => {
    const line = SuiError.describe(error)
    const json = JSON.stringify(SuiError.toJson(error))
    return [typeof line, typeof json, typeof (error as Error).message]
  }

  test("an extension error whose message getter calls describe or toJson terminates", () => {
    class EscrowDenied extends Schema.TaggedError<EscrowDenied>()("escrow/Denied", { rule: Schema.String }) {
      readonly outcome = "not_applied" as const
      override get message(): string {
        return SuiError.describe(this)
      }
    }
    class Logged extends Schema.TaggedError<Logged>()("escrow/Logged", {}) {
      override get message(): string {
        return JSON.stringify(SuiError.toJson(this))
      }
    }
    expect(SuiError.toJson(new EscrowDenied({ rule: "spend" }))).toEqual({ _tag: "escrow/Denied", rule: "spend", outcome: "not_applied", message: "escrow/Denied" })
    expect(SuiError.describe(new SigningError({ cause: new EscrowDenied({ rule: "spend" }) }))).toBe("SigningError: escrow/Denied")
    expect(total(new Logged())).toEqual(["string", "string", "string"])
  })

  test("a cyclic cause and a bigint cause", () => {
    const cause: Record<string, unknown> = { a: 1 }
    cause["self"] = cause
    expect(total(new SubmissionUnknown({ digest: DIGEST, cause }))).toEqual(["string", "string", "string"])
    expect(total(new TransportError({ method: "m", retryable: false, cause: { n: 1n } }))).toEqual(["string", "string", "string"])
  })
})
