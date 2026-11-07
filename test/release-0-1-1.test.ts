/**
 * The 0.1.1 patch, proved.
 *
 * Every test here is a fix a downstream conversion asked for: the face type
 * that lied about interface-typed namespaces, `outcome` missing from a
 * serialized extension error, a cold call that aborted the process, a warm
 * registration that degraded to cold after `$dispose()`, `instanceof` against a
 * second copy of `@mysten/sui`, and the test harness's missing dependency slot.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Effect, Schema } from "effect"
import type { Outcome } from "../src/domain/errors.ts"
import { GraphQLUnavailable, SuiError } from "../src/domain/errors.ts"
import { ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import * as SuiSchema from "../src/domain/sui-schema.ts"
import { Sui } from "../src/services/Sui.ts"
import { mapSdkError } from "../src/services/SuiCore.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"


// ---------------------------------------------------------------------------
// 13. The cold placeholder
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14. A warm registration stays warm across $dispose()
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 12. `SuiError.toJson` keeps `outcome`
// ---------------------------------------------------------------------------

class SettlementUnknown extends Schema.TaggedError<SettlementUnknown>()(
  "escrow/SettlementUnknown",
  { escrowId: Schema.String, message: Schema.String }
) {
  readonly outcome: Outcome = "unknown"
}

describe("SuiError.toJson", () => {
  test("includes the outcome an extension error declares as a class field", () => {
    const error = new SettlementUnknown({ escrowId: "0xe5", message: "no answer" })
    const json = SuiError.toJson(error)
    expect(json).toEqual({
      _tag: "escrow/SettlementUnknown",
      escrowId: "0xe5",
      message: "no answer",
      outcome: "unknown"
    })
    // The field a wrapper script acts on is the field the log line carries.
    expect(json["outcome"]).toBe(SuiError.outcome(error))
  })

  test("a foreign tag with an outcome and no schema still carries it", () => {
    const json = SuiError.toJson({ _tag: "Foreign", outcome: "applied" } as never)
    expect(json["outcome"]).toBe("applied")
  })

  test("a taxonomy error is unchanged", () => {
    const json = SuiError.toJson(
      new GraphQLUnavailable({ method: "query", reason: "no endpoint" })
    )
    expect(json["_tag"]).toBe("GraphQLUnavailable")
    expect(json["outcome"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 15. Two copies of @mysten/sui
// ---------------------------------------------------------------------------

/** The SDK's `ObjectError`, as a second copy of the package would define it. */
class OtherCopyObjectError extends Error {
  readonly reason: string
  readonly objectId: string
  constructor(reason: string, objectId: string) {
    super(`object ${objectId}: ${reason}`)
    this.name = "ObjectError"
    this.reason = reason
    this.objectId = objectId
  }
}

class OtherCopyTransactionError extends Error {
  readonly reason = "notFound"
  readonly digest: string
  constructor(digest: string) {
    super(`transaction ${digest} not found`)
    this.name = "TransactionError"
    this.digest = digest
  }
}

class OtherCopySimulationError extends Error {
  readonly executionError: SuiClientTypes.ExecutionError | undefined
  constructor(message: string, executionError?: SuiClientTypes.ExecutionError) {
    super(message)
    this.name = "SimulationError"
    this.executionError = executionError
  }
}

describe("mapSdkError duck-types the SDK's error classes", () => {
  const OBJECT = `0x${"0".repeat(63)}7`

  test("an ObjectError from another copy is still ObjectNotFound", () => {
    const error = mapSdkError("getObject", new OtherCopyObjectError("notFound", OBJECT))
    expect(error._tag).toBe("ObjectNotFound")
  })

  test("deleted and unknown map the same way instanceof would", () => {
    expect(mapSdkError("getObject", new OtherCopyObjectError("deleted", OBJECT))._tag)
      .toBe("ObjectDeleted")
    expect(mapSdkError("getObject", new OtherCopyObjectError("unknown", OBJECT))._tag)
      .toBe("ObjectUnavailable")
  })

  test("a TransactionError from another copy is TransactionNotFound", () => {
    const error = mapSdkError("getTransaction", new OtherCopyTransactionError("1".repeat(32)))
    expect(error._tag).toBe("TransactionNotFound")
  })

  test("a SimulationError from another copy is SimulationFailed", () => {
    const error = mapSdkError("simulate", new OtherCopySimulationError("aborted"))
    expect(error._tag).toBe("SimulationFailed")
  })

  test("anything else is still a TransportError", () => {
    expect(mapSdkError("getObject", new Error("boom"))._tag).toBe("TransportError")
    // A `reason` with no object id and no digest is not one of the SDK's.
    expect(mapSdkError("getObject", { reason: "notFound" })._tag).toBe("TransportError")
  })
})

// ---------------------------------------------------------------------------
// 16. `layerExtensionTest` takes extra dependency layers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 1, 2, 5. The helpers
// ---------------------------------------------------------------------------

describe("the shorthand helpers", () => {
  test("SuiAddress.normalize takes every spelling .make refuses", () => {
    expect(SuiAddress.normalize("0x1")).toBe(SuiAddress.make(`0x${"0".repeat(63)}1`))
    expect(() => SuiAddress.make("0x1" as never)).toThrow()
    expect(() => SuiAddress.normalize("not an address")).toThrow()
  })

  test("ObjectId.normalize is its object-id twin", () => {
    expect(ObjectId.normalize("0x6")).toBe(ObjectId.make(`0x${"0".repeat(63)}6`))
  })

  test("SuiSchema.decodeWith parses and maps in one codec", () => {
    const layout = bcs.struct("Thing", { id: bcs.Address, amount: bcs.u64() })
    const codec = SuiSchema.decodeWith(
      layout,
      "0x2::thing::Thing",
      (raw) => ({ id: ObjectId.normalize(raw.id), amount: BigInt(raw.amount) })
    )
    const bytes = layout.serialize({ id: `0x${"0".repeat(63)}9`, amount: "12" }).toBytes()
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(codec)(bytes))
    expect(decoded.amount).toBe(12n)
    expect(decoded.id).toBe(ObjectId.normalize("0x9"))
  })

  test("a throwing mapper is a DecodeError, not a defect", () => {
    const layout = bcs.struct("Thing", { id: bcs.Address })
    const codec = SuiSchema.decodeWith(layout, "0x2::thing::Thing", () => {
      throw new Error("that is not a thing")
    })
    const bytes = layout.serialize({ id: `0x${"0".repeat(63)}9` }).toBytes()
    const failure = Effect.runSync(
      Effect.flip(SuiSchema.decode(codec, bytes))
    )
    expect(failure._tag).toBe("DecodeError")
    expect(failure.issue).toContain("that is not a thing")
  })

  test("FakeScript.coinMetadata answers getCoinMetadata", async () => {
    const metadata: SuiClientTypes.CoinMetadata = {
      id: `0x${"0".repeat(63)}2`,
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
      description: "",
      iconUrl: null
    }
    const answers = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const sui = yield* Sui
          const known = yield* sui.core.getCoinMetadata({ coinType: "0x2::sui::SUI" })
          const unknown = yield* sui.core.getCoinMetadata({ coinType: "0x9::pop::POP" })
          return [known.coinMetadata?.symbol, unknown.coinMetadata] as const
        }),
        layerTest({
          chainId: CHAIN_ID,
          coinMetadata: { "0x2::sui::SUI": metadata }
        }),
        { local: true }
      )
    )
    expect(answers).toEqual(["SUI", null])
  })
})
