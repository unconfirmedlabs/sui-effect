import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { TestSchema } from "effect/testing"
import { KeyValueStore } from "effect/unstable/persistence"
import { ExecutionReason } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { layerKeyValueStore, make } from "../src/services/JournalKeyValueStore.ts"

const DIGEST = Digest.make("7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn")
const OTHER = Digest.make("11111111111111111111111111111111")
const SENDER = SuiAddress.make(`0x${"ab".repeat(32)}`)
const AT = DateTime.makeUnsafe(1_700_000_000_000)

const signed = {
  digest: DIGEST,
  bytes: new Uint8Array([1, 2, 3]),
  signatures: [Signature.make("sig")],
  sender: SENDER,
  expiration: {
    $kind: "ValidDuring" as const,
    ValidDuring: {
      minEpoch: null,
      maxEpoch: null,
      minTimestamp: null,
      maxTimestamp: 1_700_000_120_000n,
      chain: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
      nonce: 7
    }
  }
}

const signedEntry = JournalEntry.cases.Signed.make({
  _tag: "Signed",
  digest: DIGEST,
  signed,
  signedAt: AT
})

const executedEntry = JournalEntry.cases.Executed.make({
  _tag: "Executed",
  digest: DIGEST,
  checkpoint: 88n,
  at: AT
})

const failedEntry = JournalEntry.cases.Failed.make({
  _tag: "Failed",
  digest: DIGEST,
  reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }),
  at: AT
})

const unknownEntry = JournalEntry.cases.Unknown.make({
  _tag: "Unknown",
  digest: DIGEST,
  signed,
  lastError: "TransportError executeTransaction DEADLINE_EXCEEDED (retryable)",
  attempts: 5,
  at: AT
})

describe("JournalEntry", () => {
  const entries = [
    ["Signed", signedEntry],
    ["Executed", executedEntry],
    ["Failed", failedEntry],
    ["Unknown", unknownEntry]
  ] as const

  for (const [name, entry] of entries) {
    test(`${name} round-trips through encode and decode`, async () => {
      const asserts = new TestSchema.Asserts(JournalEntry)
      const encoded = Schema.encodeUnknownSync(JournalEntry)(entry)
      await asserts.decoding().succeed(encoded, entry)
      await asserts.encoding().succeed(entry, encoded)
      // Everything in an entry is JSON, so a durable journal can hold it.
      expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded as never)
    })
  }

  test("Signed and Unknown are the unresolved tags", () => {
    expect(JournalEntry.isAnyOf(["Signed", "Unknown"])(signedEntry)).toBe(true)
    expect(JournalEntry.isAnyOf(["Signed", "Unknown"])(executedEntry)).toBe(false)
  })
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("the memory journal", () => {
  test("put, get and listUnresolved", async () => {
    const result = await run(
      Effect.gen(function*() {
        const journal = Journal.makeMemoryUnsafe()
        yield* journal.put(signedEntry)
        yield* journal.put({ ...unknownEntry, digest: OTHER })
        const before = yield* journal.listUnresolved
        yield* journal.put(executedEntry)
        const after = yield* journal.listUnresolved
        const entry = yield* journal.get(DIGEST)
        return { before, after, entry }
      })
    )
    expect(result.before).toHaveLength(2)
    expect(result.after.map((entry) => entry.digest)).toEqual([OTHER])
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) expect(result.entry.value._tag).toBe("Executed")
  })

  test("an unknown digest is None", async () => {
    const entry = await run(Journal.makeMemoryUnsafe().get(OTHER))
    expect(Option.isNone(entry)).toBe(true)
  })
})

describe("the KeyValueStore journal", () => {
  const withStore = <A, E>(
    effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>
  ) => Effect.runPromise(Effect.provide(effect, KeyValueStore.layerMemory, { local: true }))

  test("entries survive as JSON and the index tracks what is unresolved", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store)
        yield* journal.put(signedEntry)
        const unresolved = yield* journal.listUnresolved
        const raw = yield* store.get(`entry:${DIGEST}`)
        yield* journal.put(executedEntry)
        const settled = yield* journal.listUnresolved
        const entry = yield* journal.get(DIGEST)
        return { unresolved, raw, settled, entry }
      })
    )
    expect(result.unresolved).toHaveLength(1)
    expect(result.raw).toContain("Signed")
    expect(result.settled).toHaveLength(0)
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) expect(result.entry.value._tag).toBe("Executed")
  })

  test("a prefix keeps two journals apart in one store", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const mine = make(store, { prefix: "mine:" })
        const yours = make(store, { prefix: "yours:" })
        yield* mine.put(signedEntry)
        return { mine: yield* mine.listUnresolved, yours: yield* yours.listUnresolved }
      })
    )
    expect(result.mine).toHaveLength(1)
    expect(result.yours).toHaveLength(0)
  })

  test("layerKeyValueStore with onUnresolved fail refuses to build over an unsettled journal", async () => {
    const store = KeyValueStore.layerMemory
    const seeded = Layer.effectDiscard(
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* make(kv).put(signedEntry)
      })
    ).pipe(Layer.provideMerge(store))

    const error = await Effect.runPromise(
      Effect.asVoid(Journal).pipe(
        Effect.provide(layerKeyValueStore({ onUnresolved: "fail" }).pipe(Layer.provide(seeded)), {
          local: true
        }),
        Effect.flip
      )
    )
    expect(error._tag).toBe("JournalError")

    const ignored = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal
        return yield* journal.listUnresolved
      }).pipe(
        Effect.provide(
          layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(seeded)),
          { local: true }
        )
      )
    )
    expect(ignored).toHaveLength(1)
  })

  test("building the layer makes no network calls: it only reads the index", async () => {
    const reads: Array<string> = []
    const counting = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        return KeyValueStore.make({
          ...kv,
          get: (key) => {
            reads.push(key)
            return kv.get(key)
          }
        })
      })
    ).pipe(Layer.provide(KeyValueStore.layerMemory))

    await Effect.runPromise(
      Effect.asVoid(Journal).pipe(
        Effect.provide(layerKeyValueStore({ onUnresolved: "fail" }).pipe(Layer.provide(counting)), {
          local: true
        })
      )
    )
    expect(reads).toEqual(["index"])
  })
})
