// A test on the in-memory fake: the real `Sui` over a scripted `SuiCore`, no network.
import { expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import { Effect, Option } from "effect"
import { ObjectId, Sui, SuiSchema } from "../../src/index.ts"
import { layerTest, SuiTest } from "../../src/testing.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const CounterBcs = bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() })
const Counter = SuiSchema.bcs(CounterBcs, `${PKG}::counter::Counter`)

test("a counter the fake serves decodes, and a missing one is None", async () => {
  const id = ObjectId.normalize("0xc0")
  const content = CounterBcs.serialize({ id, value: 7n }).toBytes()
  const [found, missing] = await Effect.gen(function*() {
    yield* SuiTest.putObject({ objectId: id, type: `${PKG}::counter::Counter`, version: 1n, content })
    const sui = yield* Sui
    return yield* Effect.all([sui.getObject(id, { schema: Counter }), sui.getObjectOption(ObjectId.normalize("0xc1"))])
  }).pipe(Effect.provide(layerTest()), Effect.runPromise)
  expect(found.content.value).toBe("7")
  expect(Option.isNone(missing)).toBe(true)
})
