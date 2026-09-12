import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { TestSchema } from "effect/testing"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  ExecutionReason,
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
  SuiError,
  TransactionNotFound,
  TransportError,
  UnexpectedEffects
} from "../src/domain/errors.ts"
import {
  Balance,
  CoinType,
  Digest,
  Mist,
  ObjectId,
  ObjectRef,
  ObjectType,
  Owner,
  Signature,
  StructTag,
  SuiAddress,
  TransactionEffects,
  Version
} from "../src/domain/schemas.ts"
import * as SuiSchema from "../src/domain/bcs.ts"
import { bcs as suiBcs } from "@mysten/sui/bcs"

const DIGEST = "7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn"
const ADDRESS = `0x${"ab".repeat(32)}`

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(schema)(input)))

const effects = (success: boolean): typeof TransactionEffects.Encoded => ({
  version: 2,
  status: { success },
  gasUsed: {
    computationCost: "1000",
    storageCost: "2000",
    storageRebate: "500",
    nonRefundableStorageFee: "5"
  },
  transactionDigest: DIGEST,
  gasObject: null,
  eventsDigest: null,
  dependencies: [],
  lamportVersion: "7",
  changedObjects: [],
  unchangedConsensusObjects: [],
  auxiliaryDataDigest: null
})

describe("branded schemas", () => {
  test("SuiAddress normalizes on decode", () => {
    const result = decode(SuiAddress, "0x2")
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isSuccess(result)) {
      expect(result.success).toBe(`0x${"0".repeat(63)}2` as SuiAddress)
    }
  })

  test("SuiAddress rejects malformed input with a SchemaError", () => {
    const result = decode(SuiAddress, "0xnothex")
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("SchemaError")
    }
  })

  test("ObjectId normalizes and rejects over-long ids", () => {
    expect(Result.isSuccess(decode(ObjectId, "0x6"))).toBe(true)
    expect(Result.isFailure(decode(ObjectId, `0x${"ab".repeat(33)}`))).toBe(true)
  })

  test("Digest accepts a base58 32-byte digest and rejects a short one", () => {
    expect(Result.isSuccess(decode(Digest, DIGEST))).toBe(true)
    expect(Result.isFailure(decode(Digest, "abc"))).toBe(true)
  })

  test("StructTag and CoinType normalize generic instantiations", () => {
    const tag = decode(StructTag, "0x2::coin::Coin<0x2::sui::SUI>")
    expect(Result.isSuccess(tag)).toBe(true)
    if (Result.isSuccess(tag)) {
      expect(tag.success).toBe(
        `0x${"0".repeat(63)}2::coin::Coin<0x${"0".repeat(63)}2::sui::SUI>` as StructTag
      )
    }
    const coin = decode(CoinType, "0x2::sui::SUI")
    expect(Result.isSuccess(coin)).toBe(true)
    expect(Result.isFailure(decode(CoinType, "not a type"))).toBe(true)
  })

  test("Mist decodes from the SDK's decimal string and rejects negatives", () => {
    const mist = decode(Mist, "1000")
    expect(Result.isSuccess(mist)).toBe(true)
    if (Result.isSuccess(mist)) expect(mist.success).toBe(1000n as Mist)
    expect(Result.isFailure(decode(Mist, "-1"))).toBe(true)
  })

  test("Owner mirrors the SDK's six kinds", () => {
    const shared = decode(Owner, { $kind: "Shared", Shared: { initialSharedVersion: "3" } })
    expect(Result.isSuccess(shared)).toBe(true)
    if (Result.isSuccess(shared)) {
      expect(Owner.guards.Shared(shared.success)).toBe(true)
    }
    for (const owner of [
      { $kind: "AddressOwner", AddressOwner: ADDRESS },
      { $kind: "ObjectOwner", ObjectOwner: ADDRESS },
      { $kind: "Immutable", Immutable: true },
      { $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { startVersion: "1", owner: ADDRESS } },
      { $kind: "Unknown" }
    ]) {
      expect(Result.isSuccess(decode(Owner, owner))).toBe(true)
    }
  })

  test("Balance decodes an SDK balance response", () => {
    const balance = decode(Balance, {
      coinType: "0x2::sui::SUI",
      balance: "10",
      coinBalance: "6",
      addressBalance: "4"
    })
    expect(Result.isSuccess(balance)).toBe(true)
  })
})

describe("schema round trips", () => {
  /**
   * One encoded fixture per branded schema, the value it decodes to, and what
   * that value encodes back to. The three differ for the schemas that
   * normalize: `0x2` decodes to the padded address and encodes back padded.
   */
  const roundTrips: ReadonlyArray<
    readonly [string, Schema.Codec<any, any>, unknown, unknown, unknown]
  > = [
    ["SuiAddress", SuiAddress, "0x2", `0x${"0".repeat(63)}2`, `0x${"0".repeat(63)}2`],
    ["ObjectId", ObjectId, "0x6", `0x${"0".repeat(63)}6`, `0x${"0".repeat(63)}6`],
    ["Digest", Digest, DIGEST, DIGEST, DIGEST],
    [
      "StructTag",
      StructTag,
      "0x2::coin::Coin<0x2::sui::SUI>",
      `0x${"0".repeat(63)}2::coin::Coin<0x${"0".repeat(63)}2::sui::SUI>`,
      `0x${"0".repeat(63)}2::coin::Coin<0x${"0".repeat(63)}2::sui::SUI>`
    ],
    ["CoinType", CoinType, "0x2::sui::SUI", `0x${"0".repeat(63)}2::sui::SUI`, `0x${"0".repeat(63)}2::sui::SUI`],
    ["Mist", Mist, "42", 42n, "42"],
    ["Version", Version, "7", 7n, "7"],
    [
      "Owner",
      Owner,
      { $kind: "Shared", Shared: { initialSharedVersion: "3" } },
      { $kind: "Shared", Shared: { initialSharedVersion: 3n } },
      { $kind: "Shared", Shared: { initialSharedVersion: "3" } }
    ],
    [
      "ObjectType (struct tag)",
      ObjectType,
      "0x2::escrow::Escrow",
      `0x${"0".repeat(63)}2::escrow::Escrow`,
      `0x${"0".repeat(63)}2::escrow::Escrow`
    ],
    ["ObjectType (package)", ObjectType, "package", "package", "package"]
  ]

  for (const [name, schema, encoded, decoded, reencoded] of roundTrips) {
    test(`${name} decodes and encodes`, async () => {
      const asserts = new TestSchema.Asserts(schema)
      await asserts.decoding().succeed(encoded, decoded)
      await asserts.encoding().succeed(decoded, reencoded)
    })
  }

  test("TransactionEffects decodes an SDK response and encodes back to it", async () => {
    const asserts = new TestSchema.Asserts(TransactionEffects)
    const encoded = effects(true)
    const decoded = decode(TransactionEffects, encoded)
    if (!Result.isSuccess(decoded)) throw new Error("fixture did not decode")
    await asserts.decoding().succeed(encoded, decoded.success)
    await asserts.encoding().succeed(decoded.success, encoded)
  })
})

describe("error classes", () => {
  const moveAbort = ExecutionReason.cases.MoveAbort.make({
    $kind: "MoveAbort",
    MoveAbort: {
      abortCode: 3n,
      location: {
        package: `0x${"0".repeat(62)}ab`,
        module: "escrow",
        functionName: "claim"
      },
      cleverError: { constantName: "EAlreadyClaimed" }
    }
  })

  const built = () => {
    const digest = Digest.make(DIGEST)
    const decoded = decode(TransactionEffects, effects(false))
    if (!Result.isSuccess(decoded)) throw new Error("fixture did not decode")
    return {
      digest,
      effects: decoded.success,
      objectId: ObjectId.make(ADDRESS),
      address: SuiAddress.make(ADDRESS)
    }
  }

  test("every error class round trips through its own schema", async () => {
    const f = built()
    const instances = [
      new TransportError({ method: "getObject", retryable: true, status: "UNAVAILABLE", cause: "x" }),
      new ObjectNotFound({ objectId: f.objectId }),
      new ObjectDeleted({ objectId: f.objectId }),
      new ObjectUnavailable({ objectId: f.objectId }),
      new TransactionNotFound({ digest: f.digest }),
      new NetworkMismatch({ expected: "testnet", actual: "mainnet" }),
      new DecodeError({ issue: "bad bytes" }),
      new SimulationFailed({ reason: moveAbort, message: "aborted" }),
      new ExecutionFailed({ digest: f.digest, reason: moveAbort, command: 1, effects: f.effects }),
      new SubmissionUnknown({
        digest: f.digest,
        signed: {
          digest: f.digest,
          bytes: new Uint8Array([1, 2, 3]),
          signatures: [Signature.make("sig")],
          sender: f.address
        },
        cause: "timeout"
      }),
      new NotApplied({ digest: f.digest, evidence: "expired" }),
      new SigningError({ cause: "no key" }),
      new BuildError({ message: "no gas", cause: "x" }),
      new PolicyDenied({ rule: "spend-limit", message: "too much" }),
      new JournalError({ cause: "disk" }),
      new UnexpectedEffects({
        digest: f.digest,
        expected: StructTag.make("0x2::coin::Coin<0x2::sui::SUI>"),
        found: []
      }),
      new GraphQLUnavailable({ method: "query", reason: "no endpoint" }),
      new ExtensionNotReady({ extension: "miso", member: "tx.purchaseRecord" })
    ]
    expect(instances).toHaveLength(18)
    for (const instance of instances) {
      const json = SuiError.toJson(instance)
      expect(json._tag).toBe(instance._tag)
      expect(typeof SuiError.describe(instance)).toBe("string")
    }
  })

  test("every error class decodes and encodes through TestSchema.Asserts", async () => {
    const f = built()
    const cases: ReadonlyArray<readonly [Schema.Codec<any, any>, unknown]> = [
      [
        TransportError,
        new TransportError({
          method: "getObject",
          retryable: true,
          status: "UNAVAILABLE",
          cause: "x"
        })
      ],
      [ObjectNotFound, new ObjectNotFound({ objectId: f.objectId })],
      [ObjectDeleted, new ObjectDeleted({ objectId: f.objectId, version: 7n as never })],
      [ObjectUnavailable, new ObjectUnavailable({ objectId: f.objectId })],
      [TransactionNotFound, new TransactionNotFound({ digest: f.digest })],
      [NetworkMismatch, new NetworkMismatch({ expected: "a", actual: "b" })],
      [
        DecodeError,
        new DecodeError({ objectId: f.objectId, expectedType: "0x2::sui::SUI", issue: "bad" })
      ],
      [SimulationFailed, new SimulationFailed({ reason: moveAbort, message: "aborted" })],
      [
        ExecutionFailed,
        new ExecutionFailed({ digest: f.digest, reason: moveAbort, command: 1, effects: f.effects })
      ],
      [
        SubmissionUnknown,
        new SubmissionUnknown({
          digest: f.digest,
          signed: {
            digest: f.digest,
            bytes: new Uint8Array([1, 2, 3]),
            signatures: [Signature.make("sig")],
            sender: f.address
          },
          cause: "timeout"
        })
      ],
      [NotApplied, new NotApplied({ digest: f.digest, evidence: "inputConsumed" })],
      [SigningError, new SigningError({ cause: "no key" })],
      [BuildError, new BuildError({ message: "no gas", cause: "x" })],
      [PolicyDenied, new PolicyDenied({ rule: "spend-limit", message: "too much" })],
      [JournalError, new JournalError({ cause: "disk" })],
      [
        UnexpectedEffects,
        new UnexpectedEffects({
          digest: f.digest,
          // `StructTag.make` brands without running the normalizing decode, so
          // the fixture is spelled the way a decode would produce it.
          expected: StructTag.make(
            `0x${"0".repeat(63)}2::coin::Coin<0x${"0".repeat(63)}2::sui::SUI>`
          ),
          found: [f.objectId]
        })
      ],
      [GraphQLUnavailable, new GraphQLUnavailable({ method: "query", reason: "no endpoint" })],
      [
        ExtensionNotReady,
        new ExtensionNotReady({ extension: "miso", member: "tx.purchaseRecord" })
      ]
    ]
    expect(cases).toHaveLength(18)
    for (const [schema, instance] of cases) {
      const asserts = new TestSchema.Asserts(schema)
      const encoded = Schema.encodeUnknownSync(schema)(instance)
      // JSON-safe: nothing here survives as a typed array or a bigint.
      expect(() => JSON.stringify(encoded)).not.toThrow()
      await asserts.encoding().succeed(instance, encoded)
      await asserts.decoding().succeed(encoded, instance)
    }
  })

  test("SubmissionUnknown encodes its signed bytes as base64, and toJson is JSON", () => {
    const f = built()
    const error = new SubmissionUnknown({
      digest: f.digest,
      signed: {
        digest: f.digest,
        bytes: new Uint8Array([0, 1, 2, 253, 254, 255]),
        signatures: [Signature.make("sig")],
        sender: f.address
      },
      cause: "timeout"
    })
    const json = SuiError.toJson(error)
    const signed = (json as { signed: { bytes: unknown } }).signed
    expect(signed.bytes).toBe("AAEC/f7/")
    expect(JSON.parse(JSON.stringify(json))).toMatchObject({ _tag: "SubmissionUnknown" })
    const decoded = decode(SubmissionUnknown, json)
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(Array.from(decoded.success.signed!.bytes)).toEqual([0, 1, 2, 253, 254, 255])
    }
  })

  test("describe renders a Move abort the way the spec shows", () => {
    const f = built()
    const error = new ExecutionFailed({
      digest: f.digest,
      reason: moveAbort,
      command: 1,
      effects: f.effects
    })
    expect(SuiError.describe(error)).toBe(
      `ExecutionFailed MoveAbort 0x${"0".repeat(62)}ab::escrow::claim code 3 (EAlreadyClaimed) in command 1`
    )
  })

  test("outcome puts ExecutionFailed on the applied side", () => {
    const f = built()
    expect(
      SuiError.outcome(
        new ExecutionFailed({ digest: f.digest, reason: moveAbort, effects: f.effects })
      )
    ).toBe("applied")
    expect(
      SuiError.outcome(
        new SubmissionUnknown({
          digest: f.digest,
          signed: {
            digest: f.digest,
            bytes: new Uint8Array(),
            signatures: [],
            sender: f.address
          },
          cause: "x"
        })
      )
    ).toBe("unknown")
    expect(SuiError.outcome(new SigningError({ cause: "x" }))).toBe("not_applied")
  })

  test("outcome honours an extension error that declares one", () => {
    class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {
      readonly outcome = "unknown" as const
    }
    expect(SuiError.outcome(new Denied())).toBe("unknown")
  })

  test("outcome is unknown for a tag that is neither ours nor declares an outcome", () => {
    // "not_applied" would be a claim: it tells the documented retry idiom that
    // nothing happened and the intent is safe to send again. Nothing about an
    // unrecognised tag supports that claim, so the answer is that we do not
    // know. `Script.exitCode` disagrees on purpose and exits 1, because exit 3
    // would claim the opposite — that there is a digest to reconcile.
    class Foreign extends Schema.TaggedError<Foreign>()("some-sdk/Foreign", {}) {}
    expect(SuiError.outcome(new Foreign() as never)).toBe("unknown")
    expect(SuiError.outcome({ _tag: "WhoKnows" } as never)).toBe("unknown")
    expect(SuiError.outcome({} as never)).toBe("unknown")
    // And a declared outcome still wins over the tag rule.
    expect(SuiError.outcome({ _tag: "Foreign", outcome: "applied" } as never)).toBe("applied")
  })

  test("describe prints the cause of a TransportError and a SubmissionUnknown", () => {
    // Without it, every transport failure in a log reads `TransportError
    // getObject UNAVAILABLE` whatever went wrong, and every unknown submission
    // is a bare digest with no hint of why it is unknown.
    expect(
      SuiError.describe(
        new TransportError({
          method: "executeTransaction",
          retryable: false,
          status: "INVALID_ARGUMENT",
          cause: new Error("signature is not valid for sender")
        })
      )
    ).toBe(
      "TransportError executeTransaction INVALID_ARGUMENT: signature is not valid for sender"
    )
    const f = built()
    expect(
      SuiError.describe(
        new SubmissionUnknown({ digest: f.digest, cause: "the node timed out twice" })
      )
    ).toBe(`SubmissionUnknown ${f.digest}: the node timed out twice`)
    // A cause with nothing readable in it adds nothing rather than printing
    // `[object Object]`.
    expect(
      SuiError.describe(new SubmissionUnknown({ digest: f.digest, cause: undefined }))
    ).toBe(`SubmissionUnknown ${f.digest}`)
  })

  test("isRetryable is true only for a retryable TransportError", () => {
    expect(
      SuiError.isRetryable(new TransportError({ method: "getObject", retryable: true, cause: "x" }))
    ).toBe(true)
    expect(
      SuiError.isRetryable(new TransportError({ method: "getObject", retryable: false, cause: "x" }))
    ).toBe(false)
    expect(SuiError.isRetryable(new SigningError({ cause: "x" }))).toBe(false)
  })
})

describe("TransportError.fromUnknown", () => {
  test("classifies a gRPC status name the way SuiCore does", () => {
    const error = TransportError.fromUnknown("operator.status", { code: "UNAVAILABLE" })
    expect(error.method).toBe("operator.status")
    expect(error.status).toBe("UNAVAILABLE")
    expect(error.retryable).toBe(true)
  })

  test("classifies an HTTP status number, 5xx and 429 retryable", () => {
    expect(TransportError.fromUnknown("x", { status: 503 }).retryable).toBe(true)
    expect(TransportError.fromUnknown("x", { status: 429 }).retryable).toBe(true)
    const notFound = TransportError.fromUnknown("x", { status: 404 })
    expect(notFound.retryable).toBe(false)
    expect(notFound.status).toBe("404")
  })

  test("an abort or a timeout is a retryable DEADLINE_EXCEEDED", () => {
    const aborted = TransportError.fromUnknown("x", new DOMException("aborted", "AbortError"))
    expect(aborted.status).toBe("DEADLINE_EXCEEDED")
    expect(aborted.retryable).toBe(true)
  })

  test("an unrecognisable cause is not retryable, and the caller may override", () => {
    const error = TransportError.fromUnknown("x", new Error("who knows"))
    expect(error.retryable).toBe(false)
    expect(error.status).toBeUndefined()
    expect(TransportError.fromUnknown("x", new Error("who knows"), true).retryable).toBe(true)
    expect(TransportError.fromUnknown("x", { code: "UNAVAILABLE" }, false).retryable).toBe(false)
  })

  test("the cause is kept, so describe has something to print", () => {
    const cause = new Error("connection refused")
    const error = TransportError.fromUnknown("operator.status", cause)
    expect(error.cause).toBe(cause)
    expect(SuiError.describe(error)).toContain("connection refused")
  })
})

/**
 * NB3: `identifier` and `description` on the reusable schemas.
 *
 * The annotation has to sit on the node that *reports* — the string underneath
 * the brand — because annotating after `Schema.check` targets the last check
 * instead, which is the trap the docs warn about.
 */
describe("schema annotations", () => {
  test("a non-string reports the identifier, not `Expected string`", () => {
    const result = Schema.decodeUnknownResult(ObjectId)(5)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("Expected ObjectId")
    }
    // The filter message still wins for a string of the wrong shape.
    const badString = Schema.decodeUnknownResult(ObjectId)("zz")
    expect(badString._tag).toBe("Failure")
    if (badString._tag === "Failure") {
      expect(String(badString.failure)).toContain("Expected a 32-byte Sui object id")
    }
  })

  test("a BCS bridge names its Move type instead of `<Declaration>`", () => {
    const layout = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.u64() })
    const type = `0x${"0".repeat(63)}2::escrow::Escrow`
    const result = Schema.decodeUnknownResult(SuiSchema.bcs(layout, type))(
      new Uint8Array([1, 2, 3])
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(String(result.failure)).toContain("escrow::Escrow")
      expect(String(result.failure)).not.toContain("<Declaration>")
    }
  })

  test("a JSON Schema document names its definitions", () => {
    const document = JSON.stringify(Schema.toJsonSchemaDocument(ObjectRef))
    expect(document).toContain("\"ObjectRef\"")
    expect(document).toContain("\"ObjectId\"")
    expect(document).toContain("\"StructTag\"")
  })
})
