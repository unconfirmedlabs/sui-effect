import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { normalizeStructTag, SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import {
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Result,
  Schema,
  SchemaTransformation,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { bcs } from "../src/domain/bcs.ts"
import {
  CoinType,
  KNOWN_CHAIN_IDS,
  ObjectId,
  StructTag,
  SuiAddress
} from "../src/domain/schemas.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, fakeDigest, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { layerTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const ESCROW_TYPE = "0x2::escrow::Escrow"
const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
const Escrow = bcs(EscrowBcs, ESCROW_TYPE)
const U64 = bcs(suiBcs.U64, "u64")

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: ALICE }

const escrow = (suffix: string, amount: string) => ({
  objectId: PADDED(suffix),
  type: ESCROW_TYPE,
  version: 3n,
  owner,
  content: EscrowBcs.serialize({ id: PADDED(suffix), amount }).toBytes()
})

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: 1_700_000_000_000n,
  objects: [escrow("e1", "5"), escrow("e2", "7")]
}

/**
 * A `SuiCore` that answers `getObjects` however the test says, so the response
 * integrity checks can be driven past what the fake is able to produce.
 */
const mockCore = (getObjects: () => Effect.Effect<{ objects: ReadonlyArray<unknown> }>) =>
  Layer.mock(SuiCore, {
    network: "localnet" as never,
    mvr: {} as never,
    getChainIdentifier: () => Effect.succeed({ chainIdentifier: CHAIN_ID }),
    getObjects: getObjects as never
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake>,
  layer = layerTest(baseScript)
) => Effect.runPromise(Effect.provide(effect, layer, { local: true }))

describe("layer build", () => {
  test("reads the chain id once and exposes it", async () => {
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const calls = yield* fake.calls
        return {
          chainId: sui.chainId,
          identifierCalls: calls.filter((call) => call.method === "getChainIdentifier").length
        }
      })
    )
    expect(result.chainId).toBe(CHAIN_ID)
    expect(result.identifierCalls).toBe(1)
  })

  test("asserts the known chain id for mainnet and testnet by default", async () => {
    const good = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(layerTest({ ...baseScript, network: "mainnet", chainId: CHAIN_ID }), {
          local: true
        })
      )
    )
    expect(good).toBe(KNOWN_CHAIN_IDS["mainnet"]!)

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(
          layerTest({ ...baseScript, network: "mainnet", chainId: fakeDigest(99) }),
          { local: true }
        ),
        Effect.flip
      )
    )
    expect(error._tag).toBe("NetworkMismatch")
    if (error._tag === "NetworkMismatch") {
      expect(error.expected).toBe(KNOWN_CHAIN_IDS["mainnet"]!)
      expect(error.actual).toBe(fakeDigest(99))
    }
  })

  test("records the observed chain id for a network with no fixed one", async () => {
    const chainId = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(
          layerTest({ ...baseScript, network: "localnet", chainId: fakeDigest(77) }),
          { local: true }
        )
      )
    )
    expect(chainId).toBe(fakeDigest(77))
  })

  test("an explicit chainId overrides the table", async () => {
    const ok = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(
          Sui.layerNoDepsWith({ chainId: fakeDigest(77) }).pipe(
            Layer.provide(
              SuiCoreFake.layer({ ...baseScript, network: "mainnet", chainId: fakeDigest(77) })
            )
          ),
          { local: true }
        )
      )
    )
    expect(ok).toBe(fakeDigest(77))
  })

  test("fails with NetworkMismatch when the node reports another chain", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(
          Sui.layerNoDepsWith({ chainId: fakeDigest(99) }).pipe(
            Layer.provide(SuiCoreFake.layer(baseScript))
          ),
          { local: true }
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return sui.chainId
      }).pipe(
        Effect.provide(
          Sui.layerNoDepsWith({ chainId: fakeDigest(99) }).pipe(
            Layer.provide(SuiCoreFake.layer(baseScript))
          ),
          { local: true }
        ),
        Effect.flip
      )
    )
    expect(error._tag).toBe("NetworkMismatch")
  })
})

describe("reads", () => {
  test("getObject decodes content with the schema", async () => {
    const object = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObject(ObjectId.make(PADDED("e1")), { schema: Escrow })
      })
    )
    expect(object.content.amount).toBe("5")
    expect(object.ref.version).toBe(3n as never)
  })

  test("getObject asks for the fixed include set", async () => {
    const calls = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.getObject(ObjectId.make(PADDED("e1")))
        return yield* fake.calls
      })
    )
    const call = calls.find((entry) => entry.method === "getObject")
    expect(call?.options).toMatchObject({ include: { content: true } })
  })

  test("getObject rejects a schema whose type does not match the object", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObject(ObjectId.make(PADDED("e1")), {
          schema: bcs(EscrowBcs, "0x2::other::Thing")
        }).pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("DecodeError")
  })

  test("getObjectOption maps not found and deleted to None", async () => {
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const missing = yield* sui.getObjectOption(ObjectId.make(PADDED("dead")))
        yield* fake.deleteObject(PADDED("e2"))
        const deleted = yield* sui.getObjectOption(ObjectId.make(PADDED("e2")))
        const present = yield* sui.getObjectOption(ObjectId.make(PADDED("e1")))
        return { missing, deleted, present }
      })
    )
    expect(Option.isNone(result.missing)).toBe(true)
    expect(Option.isNone(result.deleted)).toBe(true)
    expect(Option.isSome(result.present)).toBe(true)
  })

  test("getObjects returns one Result per id, in order", async () => {
    const results = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObjects(
          [PADDED("e1"), PADDED("dead"), PADDED("e2")].map((id) => ObjectId.make(id)),
          { schema: Escrow }
        )
      })
    )
    expect(results).toHaveLength(3)
    expect(Result.isSuccess(results[0]!)).toBe(true)
    expect(Result.isFailure(results[1]!)).toBe(true)
    if (Result.isFailure(results[1]!)) {
      expect(results[1]!.failure._tag).toBe("ObjectNotFound")
    }
    if (Result.isSuccess(results[2]!)) {
      expect(results[2]!.success.content.amount).toBe("7")
    }
  })

  test("getObjects chunks by 50", async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      escrow(`${(index + 16).toString(16)}0`, String(index)))
    const layer = layerTest({ ...baseScript, objects: many })
    const calls = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.getObjects(many.map((object) => ObjectId.make(object.objectId)))
        return yield* fake.calls
      }),
      layer
    )
    const batches = calls.filter((call) => call.method === "getObjects")
    expect(batches).toHaveLength(3)
    expect(
      batches.map((batch) => (batch.options as { objectIds: Array<string> }).objectIds.length)
    ).toEqual([50, 50, 20])
  })

  // NB5: the chunks go out concurrently, bounded by CHUNK_CONCURRENCY (4).
  test("getObjects sends chunks concurrently", async () => {
    const ids = Array.from(
      { length: 120 },
      (_, index) => ObjectId.make(PADDED(`${(index + 16).toString(16)}0`))
    )
    const latch = Effect.runSync(Latch.make(false))
    const arrived: Array<number> = []
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fiber = yield* Effect.forkChild(sui.getObjects(ids))
        // The latch opens only once two chunk calls have been *recorded*, so a
        // sequential implementation deadlocks here rather than passing.
        yield* Latch.await(latch)
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(
          Sui.layerNoDeps.pipe(
            Layer.provide(
              mockCore(() =>
                Effect.suspend(() => {
                  arrived.push(arrived.length)
                  if (arrived.length >= 2) latch.openUnsafe()
                  return Effect.as(Latch.await(latch), { objects: [] as ReadonlyArray<unknown> })
                })
              )
            )
          ),
          { local: true }
        ),
        Effect.flip
      )
    )
    // Two chunk calls were in flight at once before either could answer.
    expect(arrived.length).toBeGreaterThanOrEqual(2)
    // The empty answers then fail the integrity check, which is the point of
    // the next test: the first failure escapes and no partial array does.
    expect(result._tag).toBe("TransportError")
  })

  // NB5: first-failure semantics survive the concurrency. Nothing is asserted
  // about whether chunk 3 was sent — under concurrency it may already be in
  // flight — only that the failure escapes and no partial array comes back.
  test("getObjects fails the whole read on a non-retryable failure in one chunk", async () => {
    const many = Array.from({ length: 120 }, (_, index) =>
      escrow(`${(index + 16).toString(16)}0`, String(index)))
    let call = 0
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObjects(many.map((object) => ObjectId.make(object.objectId)))
      }).pipe(
        Effect.provide(
          Sui.layerNoDeps.pipe(
            Layer.provide(
              mockCore(() =>
                Effect.suspend(() => {
                  call += 1
                  // The second chunk answers for too few objects, which is the
                  // integrity check's non-retryable `TransportError`.
                  return Effect.succeed({
                    objects: call === 2 ? [] : new globalThis.Array(50).fill(undefined)
                  })
                })
              )
            )
          ),
          { local: true }
        ),
        Effect.flip
      )
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag === "TransportError") expect(error.retryable).toBe(false)
  })

  test("getObjects deduplicates the request and answers once per id asked", async () => {
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const results = yield* sui.getObjects([
          ObjectId.make(PADDED("e1")),
          ObjectId.make(PADDED("e2")),
          ObjectId.make(PADDED("e1"))
        ], { schema: Escrow })
        const calls = yield* fake.calls
        const request = calls.find((call) => call.method === "getObjects")
        return { results, requested: (request?.options as { objectIds: Array<string> }).objectIds }
      })
    )
    expect(result.requested).toHaveLength(2)
    expect(result.results).toHaveLength(3)
    expect(Result.isSuccess(result.results[0]!)).toBe(true)
    expect(Result.isSuccess(result.results[2]!)).toBe(true)
    if (Result.isSuccess(result.results[0]!) && Result.isSuccess(result.results[2]!)) {
      expect(result.results[2]!.success.content.amount).toBe(
        result.results[0]!.success.content.amount
      )
    }
  })

  test("getObjects normalizes ids before matching the node's answer", async () => {
    const results = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        // The short spelling of an id the fake stores padded.
        return yield* sui.getObjects(["0xe1" as never, PADDED("e2") as never])
      })
    )
    expect(results).toHaveLength(2)
    expect(Result.isSuccess(results[0]!)).toBe(true)
    expect(Result.isSuccess(results[1]!)).toBe(true)
  })

  test("getObjects fails with TransportError when the node answers for another id", async () => {
    const wrong = mockCore(() =>
      Effect.succeed({
        objects: [{ ...escrow("e2", "7"), version: "3", content: new Uint8Array() }]
      }))
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObjects([ObjectId.make(PADDED("e1"))]).pipe(Effect.flip)
      }).pipe(
        Effect.provide(Sui.layerNoDeps.pipe(Layer.provide(wrong)), { local: true })
      )
    )
    expect(error._tag).toBe("TransportError")
    expect(String(error.cause)).toContain("answered for")
  })

  test("getObjects fails with TransportError when the node answers for too few", async () => {
    const short = mockCore(() => Effect.succeed({ objects: [] }))
    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObjects([ObjectId.make(PADDED("e1"))]).pipe(Effect.flip)
      }).pipe(
        Effect.provide(Sui.layerNoDeps.pipe(Layer.provide(short)), { local: true })
      )
    )
    expect(error._tag).toBe("TransportError")
    expect(String(error.cause)).toContain("answered for 0")
  })

  test("getBalance decodes the balance response", async () => {
    const layer = layerTest({
      ...baseScript,
      balances: [
        { coinType: "0x2::sui::SUI", balance: "10", coinBalance: "6", addressBalance: "4" }
      ]
    })
    const balance = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getBalance(SuiAddress.make(ALICE), CoinType.make("0x2::sui::SUI"))
      }),
      layer
    )
    expect(balance.balance).toBe(10n as never)
  })

  test("chainTime decodes the Clock object", async () => {
    const time = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.chainTime
      })
    )
    expect(DateTime.toEpochMillis(time)).toBe(1_700_000_000_000)
  })

  test("chainTime is never cached", async () => {
    const reads = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.chainTime
        yield* fake.setClock(1_700_000_060_000n)
        const second = yield* sui.chainTime
        const calls = yield* fake.calls
        return {
          second: DateTime.toEpochMillis(second),
          clockReads: calls.filter(
            (call) =>
              call.method === "getObject" &&
              (call.options as { objectId: string }).objectId === SUI_CLOCK_OBJECT_ID
          ).length
        }
      })
    )
    expect(reads.second).toBe(1_700_000_060_000)
    expect(reads.clockReads).toBe(2)
  })

  test("a package object is readable: its type is the literal `package`", async () => {
    const layer = layerTest({
      ...baseScript,
      objects: [
        ...baseScript.objects,
        {
          objectId: PADDED("9ac"),
          type: "package",
          version: 1n,
          owner: { $kind: "Immutable" as const, Immutable: true },
          content: new Uint8Array([1, 2, 3])
        }
      ]
    })
    const object = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObject(ObjectId.make(PADDED("9ac")))
      }),
      layer
    )
    expect(object.type).toBe("package")
    expect(object.ref.type).toBe("package")
    expect(Array.from(object.content)).toEqual([1, 2, 3])
  })

  test("an explicit expectedType overrides what the codec recorded", async () => {
    const bare = bcs(EscrowBcs, "0x2::other::Thing")
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObject(ObjectId.make(PADDED("e1")), { schema: bare, expectedType: ESCROW_TYPE })
          .pipe(Effect.result)
      })
    )
    expect(Result.isSuccess(error)).toBe(true)

    const rejected = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObject(ObjectId.make(PADDED("e1")), {
            schema: Escrow,
            expectedType: "0x2::other::Thing"
          })
          .pipe(Effect.flip)
      })
    )
    expect(rejected._tag).toBe("DecodeError")
  })

  test("a composed codec keeps the type check the bridge recorded", async () => {
    class Wallet extends Schema.Class<Wallet>("Wallet")({
      id: Schema.String,
      amount: Schema.String
    }) {}
    const compose = (codec: typeof Escrow) =>
      codec.pipe(
        Schema.decodeTo(
          Wallet,
          SchemaTransformation.transform({
            decode: (value: { id: string; amount: string }) => new Wallet(value),
            encode: (wallet: Wallet) => ({ id: wallet.id, amount: wallet.amount })
          })
        )
      )
    const ok = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObject(ObjectId.make(PADDED("e1")), { schema: compose(Escrow) })
      })
    )
    expect(ok.content).toBeInstanceOf(Wallet)
    expect(ok.content.amount).toBe("5")

    const rejected = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObject(ObjectId.make(PADDED("e1")), {
            schema: compose(bcs(EscrowBcs, "0x2::other::Thing"))
          })
          .pipe(Effect.flip)
      })
    )
    expect(rejected._tag).toBe("DecodeError")
  })

  test("getDynamicFieldOption is None when the field is missing", async () => {
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getDynamicFieldOption(ObjectId.make(PADDED("e1")), {
          type: "u64",
          bcs: new Uint8Array([1])
        })
      })
    )
    expect(Option.isNone(result)).toBe(true)
  })
})

describe("streams", () => {
  const field = (index: number): SuiClientTypes.DynamicFieldEntry => ({
    fieldId: PADDED(`d${index.toString(16)}0`),
    type: "0x2::dynamic_field::Field<u64, u64>",
    name: { type: "u64", bcs: new Uint8Array([index]) },
    valueType: "u64",
    $kind: "DynamicField"
  })

  test("streamOwnedObjects paginates until hasNextPage is false", async () => {
    const objects = Array.from({ length: 7 }, (_, index) =>
      escrow(`${(index + 16).toString(16)}0`, String(index)))
    const layer = layerTest({ ...baseScript, objects, pageSize: 3 })
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const items = yield* Stream.runCollect(sui.streamOwnedObjects(SuiAddress.make(ALICE)))
        const calls = yield* fake.calls
        return {
          items: items.length,
          pages: calls.filter((call) => call.method === "listOwnedObjects").length
        }
      }),
      layer
    )
    expect(result.items).toBe(7)
    expect(result.pages).toBe(3)
  })

  test("streamOwnedObjects filters by type and asks for the fixed include set", async () => {
    const objects = [
      escrow("f1", "1"),
      { ...escrow("f2", "2"), type: "0x2::escrow::Receipt" },
      escrow("f3", "3")
    ]
    const layer = layerTest({ ...baseScript, objects })
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const items = yield* Stream.runCollect(
          sui.streamOwnedObjects(SuiAddress.make(ALICE), { type: StructTag.make(ESCROW_TYPE) })
        )
        const calls = yield* fake.calls
        return { items, call: calls.find((call) => call.method === "listOwnedObjects") }
      }),
      layer
    )
    expect(result.items.map((object) => object.id)).toEqual([
      PADDED("f1") as never,
      PADDED("f3") as never
    ])
    expect(result.call?.options).toMatchObject({
      include: { content: true },
      type: ESCROW_TYPE
    })
  })

  test("streamDynamicFields paginates", async () => {
    const layer = layerTest({
      ...baseScript,
      pageSize: 2,
      dynamicFields: { [PADDED("e1")]: [field(1), field(2), field(3), field(4), field(5)] }
    })
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const items = yield* Stream.runCollect(
          sui.streamDynamicFields(ObjectId.make(PADDED("e1")))
        )
        const calls = yield* fake.calls
        return {
          items: items.length,
          pages: calls.filter((call) => call.method === "listDynamicFields").length
        }
      }),
      layer
    )
    expect(result.items).toBe(5)
    expect(result.pages).toBe(3)
  })
})

describe("simulate and view", () => {
  const simulateLayer = (commandResults: Array<SuiClientTypes.CommandResult>) =>
    layerTest({
      ...baseScript,
      simulate: [FakeOutcome.succeed({ digest: fakeDigest(50), commandResults })]
    })

  test("simulate asks for the fixed include set and decodes the result", async () => {
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const simulation = yield* sui.simulate(() => {})
        const calls = yield* fake.calls
        return { simulation, call: calls.find((call) => call.method === "simulateTransaction") }
      }),
      simulateLayer([])
    )
    expect(result.simulation.digest).toBe(fakeDigest(50) as never)
    expect(result.call?.options).toMatchObject({
      include: {
        effects: true,
        events: true,
        balanceChanges: true,
        objectTypes: true,
        commandResults: true
      },
      checksEnabled: true
    })
  })

  test("simulate decodes a publish, whose object type is the literal `package`", async () => {
    const layer = layerTest({
      ...baseScript,
      simulate: [
        FakeOutcome.succeed({
          digest: fakeDigest(51),
          created: [
            { objectId: PADDED("9ac"), type: "package", version: 1n, outputState: "PackageWrite" }
          ]
        })
      ]
    })
    const simulation = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.simulate(() => {})
      }),
      layer
    )
    expect(simulation.objectTypes[PADDED("9ac")]).toBe("package")
  })

  test("simulate maps an on-chain failure to SimulationFailed", async () => {
    const layer = layerTest({
      ...baseScript,
      simulate: [
        FakeOutcome.failWith({
          message: "MoveAbort",
          command: 0,
          $kind: "MoveAbort",
          MoveAbort: { abortCode: "3" }
        } as SuiClientTypes.ExecutionError)
      ]
    })
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.simulate(() => {}).pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("SimulationFailed")
  })

  test("a recipe that throws becomes a BuildError", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .simulate(() => {
            throw new Error("bad recipe")
          })
          .pipe(Effect.flip)
      }),
      simulateLayer([])
    )
    expect(error._tag).toBe("BuildError")
  })

  test("view decodes return value 0 of the last command and disables checks", async () => {
    const layer = simulateLayer([
      { returnValues: [{ bcs: suiBcs.U64.serialize("1").toBytes() }], mutatedReferences: [] },
      { returnValues: [{ bcs: suiBcs.U64.serialize("42").toBytes() }], mutatedReferences: [] }
    ])
    const result = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        const value = yield* sui.view(() => {}, U64)
        const calls = yield* fake.calls
        return { value, call: calls.find((call) => call.method === "simulateTransaction") }
      }),
      layer
    )
    expect(result.value).toBe("42")
    expect(result.call?.options).toMatchObject({ checksEnabled: false })
  })

  test("view can address an earlier command", async () => {
    const layer = simulateLayer([
      { returnValues: [{ bcs: suiBcs.U64.serialize("1").toBytes() }], mutatedReferences: [] },
      { returnValues: [{ bcs: suiBcs.U64.serialize("42").toBytes() }], mutatedReferences: [] }
    ])
    const value = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.view(() => {}, U64, { command: 0 })
      }),
      layer
    )
    expect(value).toBe("1")
  })

  test("view fails with DecodeError when the command has no such return value", async () => {
    const layer = simulateLayer([{ returnValues: [], mutatedReferences: [] }])
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.view(() => {}, U64).pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("DecodeError")
  })
})

describe("getTransaction", () => {
  test("returns an Executed for a successful transaction", async () => {
    const layer = layerTest({
      ...baseScript,
      getTransaction: [
        FakeOutcome.succeed({
          digest: fakeDigest(31),
          created: [{ objectId: PADDED("4ece"), type: "0x2::escrow::Receipt", version: 9n }]
        })
      ]
    })
    const executed = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getTransaction(fakeDigest(31) as never)
      }),
      layer
    )
    expect(executed.created("0x2::escrow::Receipt")).toHaveLength(1)
  })

  test("getTransaction asks for the fixed execute include set", async () => {
    const layer = layerTest({
      ...baseScript,
      getTransaction: [FakeOutcome.succeed({ digest: fakeDigest(34) })]
    })
    const call = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.getTransaction(fakeDigest(34) as never)
        const calls = yield* fake.calls
        return calls.find((entry) => entry.method === "getTransaction")
      }),
      layer
    )
    expect(call?.options).toMatchObject({
      include: { effects: true, events: true, balanceChanges: true, objectTypes: true }
    })
  })

  test("a historical failure is an ExecutionFailed, not an Executed", async () => {
    const layer = layerTest({
      ...baseScript,
      getTransaction: [
        FakeOutcome.failWith({
          message: "MoveAbort",
          command: 1,
          $kind: "MoveAbort",
          MoveAbort: { abortCode: "3" }
        } as SuiClientTypes.ExecutionError, { digest: fakeDigest(32) })
      ]
    })
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getTransaction(fakeDigest(32) as never).pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("ExecutionFailed")
  })

  test("an unknown digest is a TransactionNotFound", async () => {
    const layer = layerTest({ ...baseScript, getTransaction: [FakeOutcome.notFound()] })
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getTransaction(fakeDigest(33) as never).pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("TransactionNotFound")
  })
})

describe("withSenderLock", () => {
  test("serializes two fibers on the same sender", async () => {
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const gate = yield* Deferred.make<void>()
      const order: Array<string> = []
      const lock = sui.withSenderLock(SuiAddress.make(ALICE))
      const first = yield* Effect.forkChild(
        lock(
          Effect.gen(function*() {
            order.push("first-in")
            yield* Deferred.await(gate)
            yield* Effect.sleep("1 second")
            order.push("first-out")
          })
        )
      )
      yield* TestClock.adjust("1 milli")
      const second = yield* Effect.forkChild(
        lock(
          Effect.sync(() => {
            order.push("second")
          })
        )
      )
      yield* TestClock.adjust("1 milli")
      yield* Deferred.succeed(gate, undefined)
      yield* TestClock.adjust("2 seconds")
      yield* Fiber.await(first)
      yield* Fiber.await(second)
      return order
    })
    const order = await Effect.runPromise(
      Effect.provide(program, Layer.merge(layerTest(baseScript), TestClock.layer()), {
        local: true
      })
    )
    expect(order).toEqual(["first-in", "first-out", "second"])
  })

  test("does not serialize two different senders", async () => {
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const gate = yield* Deferred.make<void>()
      const order: Array<string> = []
      const first = yield* Effect.forkChild(
        sui.withSenderLock(SuiAddress.make(ALICE))(
          Effect.gen(function*() {
            yield* Deferred.await(gate)
            order.push("alice")
          })
        )
      )
      yield* TestClock.adjust("1 milli")
      const second = yield* Effect.forkChild(
        sui.withSenderLock(SuiAddress.make(PADDED("b0b")))(
          Effect.sync(() => {
            order.push("bob")
          })
        )
      )
      yield* TestClock.adjust("1 milli")
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.await(first)
      yield* Fiber.await(second)
      return order
    })
    const order = await Effect.runPromise(
      Effect.provide(program, Layer.merge(layerTest(baseScript), TestClock.layer()), {
        local: true
      })
    )
    expect(order).toEqual(["bob", "alice"])
  })
})


describe("generic Move types", () => {
  const GENERIC = "0xc0de::composition::Composition"
  const INSTANTIATED = `${GENERIC}<0x5ha4e::share::Share>`.replace("0x5ha4e", PADDED("5aae"))
  const CompositionBcs = suiBcs.struct("Composition", { id: suiBcs.Address })
  const Composition = bcs(CompositionBcs, GENERIC)

  const instantiated = (suffix: string) => ({
    objectId: PADDED(suffix),
    type: INSTANTIATED,
    version: 1n,
    owner,
    content: CompositionBcs.serialize({ id: PADDED(suffix) }).toBytes()
  })

  const layer = layerTest({ ...baseScript, objects: [instantiated("c1"), instantiated("c2")] })

  test("a codec built for the bare tag decodes an instantiation", async () => {
    const object = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObject(ObjectId.make(PADDED("c1")), { schema: Composition })
      }),
      layer
    )
    expect(object.content.id).toBe(PADDED("c1"))
    // The object keeps the type it actually has, instantiation and all.
    expect(object.type).toBe(normalizeStructTag(INSTANTIATED) as never)
  })

  test("an expectedType with type arguments is still compared in full", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObject(ObjectId.make(PADDED("c1")), {
            schema: Composition,
            expectedType: `${GENERIC}<0x2::sui::SUI>`
          })
          .pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("DecodeError")
  })

  test("streamOwnedObjects filters a bare tag against every instantiation", async () => {
    const items = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* Stream.runCollect(
          sui.streamOwnedObjects(SuiAddress.make(ALICE), { type: StructTag.make(GENERIC) })
        )
      }),
      layer
    )
    expect(items.length).toBe(2)
  })

  test("streamOwnedObjects with a tag nothing instantiates sees nothing", async () => {
    const items = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* Stream.runCollect(
          sui.streamOwnedObjects(SuiAddress.make(ALICE), {
            type: StructTag.make("0xc0de::composition::Draft")
          })
        )
      }),
      layer
    )
    expect(items.length).toBe(0)
  })
})

describe("getObjectsOrFail", () => {
  test("returns the objects in the order of the ids", async () => {
    const objects = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getObjectsOrFail(
          [ObjectId.make(PADDED("e2")), ObjectId.make(PADDED("e1"))],
          { schema: Escrow }
        )
      })
    )
    expect(objects.map((object) => object.content.amount)).toEqual(["7", "5"])
  })

  test("fails with the first item error instead of a Result", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObjectsOrFail([ObjectId.make(PADDED("e1")), ObjectId.make(PADDED("404"))])
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("ObjectNotFound")
  })
})

describe("view and simulate senders", () => {
  const simulateOnly = (commandResults: Array<SuiClientTypes.CommandResult>) =>
    layerTest({
      ...baseScript,
      simulate: [FakeOutcome.succeed({ digest: fakeDigest(60), commandResults })]
    })

  test("view takes a bare BcsType, with no invented type tag", async () => {
    const value = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.view(() => {}, suiBcs.Address)
      }),
      simulateOnly([
        { returnValues: [{ bcs: suiBcs.Address.serialize(ALICE).toBytes() }], mutatedReferences: [] }
      ])
    )
    expect(value).toBe(ALICE)
  })

  test("view sets the sender it was given", async () => {
    const call = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.view(() => {}, suiBcs.U64, { sender: SuiAddress.make(ALICE) })
        const calls = yield* fake.calls
        return calls.find((call) => call.method === "simulateTransaction")
      }),
      simulateOnly([
        { returnValues: [{ bcs: suiBcs.U64.serialize("1").toBytes() }], mutatedReferences: [] }
      ])
    )
    const options = call?.options as { readonly transaction: { getData: () => { sender: string } } }
    expect(options.transaction.getData().sender).toBe(ALICE)
  })

  test("a recipe's own sender wins over opts.sender", async () => {
    const call = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fake = yield* SuiCoreFake
        yield* sui.simulate((tx) => tx.setSender(PADDED("b0b")), {
          sender: SuiAddress.make(ALICE)
        })
        const calls = yield* fake.calls
        return calls.find((call) => call.method === "simulateTransaction")
      }),
      simulateOnly([])
    )
    const options = call?.options as { readonly transaction: { getData: () => { sender: string } } }
    expect(options.transaction.getData().sender).toBe(PADDED("b0b"))
  })
})
