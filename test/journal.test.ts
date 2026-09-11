import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { TestSchema } from "effect/testing"
import { KeyValueStore } from "effect/unstable/persistence"
import { ExecutionReason } from "../src/domain/errors.ts"
import { isUnresolved, JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fakeDigest } from "../src/services/SuiCoreFake.ts"
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

const notAppliedEntry = JournalEntry.cases.NotApplied.make({
  _tag: "NotApplied",
  digest: DIGEST,
  evidence: "inputConsumed",
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
    ["Unknown", unknownEntry],
    ["NotApplied", notAppliedEntry]
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

  test("NotApplied is terminal", () => {
    // It is a variant of its own precisely so it can be terminal: recording a
    // proven-dead submission as `Unknown` would leave it in the unresolved
    // index forever, and `onUnresolved: "fail"` would refuse to build over it.
    expect(isUnresolved(notAppliedEntry)).toBe(false)
    expect(isUnresolved(unknownEntry)).toBe(true)
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

  test("a NotApplied entry resolves the digest and leaves the index", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store)
        yield* journal.put(signedEntry)
        const before = yield* journal.listUnresolved
        yield* journal.put(notAppliedEntry)
        return {
          before,
          after: yield* journal.listUnresolved,
          entry: yield* journal.get(DIGEST)
        }
      })
    )
    expect(result.before).toHaveLength(1)
    expect(result.after).toHaveLength(0)
    // The answer is still readable; only the "still waiting" index drops it.
    expect(Option.isSome(result.entry)).toBe(true)
    if (Option.isSome(result.entry)) expect(result.entry.value._tag).toBe("NotApplied")
  })

  /**
   * A store whose reads and writes yield, the way any real one does.
   *
   * The in-memory store never suspends, so on it a read-modify-write is
   * accidentally atomic and the bug this test is about cannot happen. A file,
   * a socket or a database can always interleave, so the journal has to be
   * correct without that accident.
   */
  const yieldingStore = Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const kv = yield* KeyValueStore.KeyValueStore
      return KeyValueStore.make({
        ...kv,
        get: (key) => Effect.flatMap(Effect.yieldNow, () => kv.get(key)),
        set: (key, value) => Effect.flatMap(Effect.yieldNow, () => kv.set(key, value))
      })
    })
  ).pipe(Layer.provide(KeyValueStore.layerMemory))

  test("four concurrent puts all survive", async () => {
    // `put` is a read-modify-write over a store with no compare-and-set. Two
    // `Tx.run`s from different senders overlap all the time, and without a
    // semaphore held across both writes each one reads the same index, appends
    // its own digest and overwrites the others: four puts, one entry.
    const digests = [1, 2, 3, 4].map((seed) => Digest.make(fakeDigest(seed)))

    const unresolved = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store)
        yield* Effect.forEach(
          digests,
          (digest) => journal.put({ ...signedEntry, digest, signed: { ...signed, digest } }),
          { concurrency: "unbounded" }
        )
        return yield* journal.listUnresolved
      }).pipe(Effect.provide(yieldingStore, { local: true }))
    )
    expect(unresolved.map((entry) => entry.digest).sort()).toEqual([...digests].sort())
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
