import { describe, expect, test } from "bun:test"
import { Effect, Result, Schema } from "effect"
import { TestSchema } from "effect/testing"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  ExecutionReason,
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
  Owner,
  StructTag,
  SuiAddress,
  TransactionEffects,
  Version
} from "../src/domain/schemas.ts"

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
  const cases: ReadonlyArray<readonly [string, Schema.Codec<unknown, unknown>]> = [
    ["SuiAddress", SuiAddress as unknown as Schema.Codec<unknown, unknown>],
    ["ObjectId", ObjectId as unknown as Schema.Codec<unknown, unknown>],
    ["Digest", Digest as unknown as Schema.Codec<unknown, unknown>],
    ["StructTag", StructTag as unknown as Schema.Codec<unknown, unknown>],
    ["CoinType", CoinType as unknown as Schema.Codec<unknown, unknown>],
    ["Mist", Mist as unknown as Schema.Codec<unknown, unknown>],
    ["Version", Version as unknown as Schema.Codec<unknown, unknown>],
    ["Owner", Owner as unknown as Schema.Codec<unknown, unknown>],
    ["TransactionEffects", TransactionEffects as unknown as Schema.Codec<unknown, unknown>]
  ]

  for (const [name, schema] of cases) {
    test(`${name} has an asserts harness`, () => {
      expect(new TestSchema.Asserts(schema)).toBeDefined()
    })
  }

  test("SuiAddress round trips through decoding and encoding", async () => {
    const asserts = new TestSchema.Asserts(SuiAddress)
    await asserts.decoding().succeed("0x2", `0x${"0".repeat(63)}2` as SuiAddress)
    await asserts.encoding().succeed(`0x${"0".repeat(63)}2` as SuiAddress, `0x${"0".repeat(63)}2`)
  })

  test("Mist round trips", async () => {
    const asserts = new TestSchema.Asserts(Mist)
    await asserts.decoding().succeed("42", 42n as Mist)
    await asserts.encoding().succeed(42n as Mist, "42")
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
          signatures: ["sig"],
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
      })
    ]
    expect(instances).toHaveLength(16)
    for (const instance of instances) {
      const json = SuiError.toJson(instance)
      expect(json._tag).toBe(instance._tag)
      expect(typeof SuiError.describe(instance)).toBe("string")
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
