import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { bcs } from "../src/domain/bcs.ts"
import { CoinType, ObjectId, StructTag, SuiAddress } from "../src/domain/schemas.ts"
import { Sui } from "../src/services/Sui.ts"
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
    expect((batches[0]?.options as { objectIds: Array<string> }).objectIds).toHaveLength(50)
    expect((batches[2]?.options as { objectIds: Array<string> }).objectIds).toHaveLength(20)
  })

  test("getObjects refuses a request with a duplicate id", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui
          .getObjects([ObjectId.make(PADDED("e1")), ObjectId.make(PADDED("e1"))])
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("TransportError")
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

describe("type coverage", () => {
  test("StructTag filters are normalized in streams", () => {
    expect(StructTag.make(ESCROW_TYPE)).toBe(ESCROW_TYPE as never)
  })
})
