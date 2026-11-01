import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option } from "effect"
import { KeyValueStore } from "effect/persistence"
import { Digest, SuiAddress } from "@unconfirmed/sui-effect"
import { Journal } from "@unconfirmed/sui-effect/tx"
import type { DurableStorage } from "../recipes/durable-object.ts"
import { durableStore, journal } from "../recipes/durable-object.ts"

/** An in-memory stand-in for `ctx.storage`, with the same method shapes. */
const memoryStorage = (): DurableStorage & { readonly map: Map<string, unknown> } => {
  const map = new Map<string, unknown>()
  return {
    map,
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: <T>(key: string, value: T) => Promise.resolve(void map.set(key, value)),
    delete: (key: string) => Promise.resolve(map.delete(key)),
    deleteAll: () => Promise.resolve(map.clear()),
    list: <T>() => Promise.resolve(new Map(map) as Map<string, T>)
  }
}

const DIGEST = Digest.make("7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn")

describe("the Durable Object KeyValueStore adapter", () => {
  test("backs the durable journal: a Signed entry is listed, a settled one is not", async () => {
    const storage = memoryStorage()
    const program = Effect.gen(function*() {
      const recorded = yield* Journal
      yield* recorded.put({
        _tag: "Signed",
        digest: DIGEST,
        signed: {
          digest: DIGEST,
          bytes: new Uint8Array([1, 2, 3]),
          signatures: [],
          sender: SuiAddress.make(`0x${"ab".repeat(32)}`)
        },
        signedAt: DateTime.makeUnsafe(0)
      })
      const before = yield* recorded.listUnresolved
      yield* recorded.put({ _tag: "Executed", digest: DIGEST, at: DateTime.makeUnsafe(1) })
      return { before, after: yield* recorded.listUnresolved, entry: yield* recorded.get(DIGEST) }
    })
    const result = await Effect.runPromise(Effect.provide(program, journal(storage)))
    expect(result.before.map((entry) => entry.digest)).toEqual([DIGEST])
    expect(result.after).toHaveLength(0)
    expect(Option.isSome(result.entry) && result.entry.value._tag).toBe("Executed")
    // The entry, and the settled marker a terminal entry carries (0.5.0).
    expect([...storage.map.keys()].sort()).toEqual([`entry:${DIGEST}`, `settled:${DIGEST}`])
  })

  test("a rejected storage call is a KeyValueStoreError, not a defect", async () => {
    const storage: DurableStorage = {
      ...memoryStorage(),
      get: () => Promise.reject(new Error("storage is gone"))
    }
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => kv.get("k")).pipe(
          Effect.provide(Layer.succeed(KeyValueStore.KeyValueStore, durableStore(storage)))
        )
      )
    )
    expect(error._tag).toBe("KeyValueStoreError")
    expect(error.method).toBe("get")
  })
})
