import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Layer, Option, Schema } from "effect"
import { TestSchema } from "effect/testing"
import { KeyValueStore } from "effect/persistence"
import { ExecutionReason } from "../src/domain/errors.ts"
import { isUnresolved, JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fakeDigest } from "../src/testing.ts"
import { layerKeyValueStore, make, pruneSettled } from "../src/services/JournalKeyValueStore.ts"

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

  /**
   * BR1 (0.2.0): the optional fields on `SignedTransaction` and on the
   * `Executed` entry became `Schema.optionalKey`. JSON cannot carry an
   * explicit `undefined`, so a line written by 0.1.x is unaffected — this is
   * the proof, written out as the bytes a durable journal holds rather than
   * re-encoded from a fixture.
   */
  test("a journal line persisted by 0.1.x still decodes", () => {
    const persistedSigned = JSON.parse(
      `{"_tag":"Signed","digest":"${DIGEST}","signed":{"digest":"${DIGEST}",` +
        `"bytes":"AQID","signatures":["sig"],"sender":"${SENDER}"},` +
        `"signedAt":1700000000000}`
    )
    const decodedSigned = Schema.decodeUnknownSync(JournalEntry)(persistedSigned)
    if (decodedSigned._tag !== "Signed") throw new Error("expected a Signed entry")
    expect("expiration" in decodedSigned.signed).toBe(false)
    expect("chain" in decodedSigned.signed).toBe(false)

    const persistedExecuted = JSON.parse(
      `{"_tag":"Executed","digest":"${DIGEST}","at":1700000000000}`
    )
    const decodedExecuted = Schema.decodeUnknownSync(JournalEntry)(persistedExecuted)
    expect(decodedExecuted._tag).toBe("Executed")
    expect("checkpoint" in decodedExecuted).toBe(false)

    // And a line that did carry the optional keys still decodes to them.
    const withCheckpoint = JSON.parse(
      `{"_tag":"Executed","digest":"${DIGEST}","checkpoint":"88","at":1700000000000}`
    )
    const decodedCheckpoint = Schema.decodeUnknownSync(JournalEntry)(withCheckpoint)
    expect(decodedCheckpoint._tag === "Executed" && decodedCheckpoint.checkpoint).toBe(88n)
  })

  test("Signed and Unknown are unresolved; NotApplied is terminal", () => {
    expect([signedEntry, unknownEntry, executedEntry, failedEntry, notAppliedEntry].map(isUnresolved)).toEqual([true, true, false, false, false])
  })
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("both journals", () => {
  const journals = [
    ["memory", Effect.sync(() => Journal.makeMemoryUnsafe())],
    ["KeyValueStore", Effect.map(Effect.provide(KeyValueStore.KeyValueStore, KeyValueStore.layerMemory), (store) => make(store))]
  ] as const
  for (const [name, journalOf] of journals) {
    test(`${name}: put and get; Signed and Unknown are listed, a terminal entry (Executed, NotApplied) resolves the digest`, async () => {
      const result = await run(Effect.gen(function*() {
        const journal = yield* journalOf
        yield* journal.put(signedEntry)
        yield* journal.put({ ...unknownEntry, digest: OTHER })
        const before = yield* journal.listUnresolved
        yield* journal.put(executedEntry)
        yield* journal.put({ ...notAppliedEntry, digest: OTHER })
        return { before, after: yield* journal.listUnresolved, entry: yield* journal.get(DIGEST), missing: yield* journal.get(Digest.make(fakeDigest(99))) }
      }))
      expect(result.before.map((entry) => entry._tag).sort()).toEqual(["Signed", "Unknown"])
      expect(result.after).toHaveLength(0)
      expect([Option.map(result.entry, (entry) => entry._tag), Option.isNone(result.missing)]).toEqual([Option.some("Executed"), true])
    })
  }
})

describe("the KeyValueStore journal", () => {
  const withStore = <A, E>(
    effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>
  ) => Effect.runPromise(Effect.provide(effect, KeyValueStore.layerMemory, { local: true }))

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
    // Two `Tx.run`s from different senders overlap all the time. With the 0.3
    // index, `put` was a read-modify-write that needed a lock; now it is one
    // `set` per digest, and four interleaved puts are four entries.
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

  test("building the layer makes no network calls: it lists the store and reads its unresolved entries", async () => {
    const reads: Array<string> = []
    let listed = 0
    const counting = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* make(kv).put(signedEntry)
        yield* make(kv).put({ ...executedEntry, digest: OTHER })
        return KeyValueStore.make({
          ...kv,
          keys: Effect.suspend(() => {
            listed += 1
            return kv.keys
          }),
          get: (key) => {
            reads.push(key)
            return kv.get(key)
          }
        })
      })
    ).pipe(Layer.provide(KeyValueStore.layerMemory))

    await Effect.runPromise(
      Effect.asVoid(Journal).pipe(
        Effect.provide(layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(counting)), {
          local: true
        })
      )
    )
    expect(listed).toBe(1)
    // The settled entry carries its marker, so only the unresolved one is read.
    expect(reads).toEqual([`entry:${DIGEST}`])
  })

  test("a put writes its entry and, when terminal, the settled marker; no index key is ever written", async () => {
    const writes: Array<string> = []
    const recording = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        return KeyValueStore.make({
          ...kv,
          set: (key, value) => {
            writes.push(key)
            return kv.set(key, value)
          }
        })
      })
    ).pipe(Layer.provide(KeyValueStore.layerMemory))

    const keys = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store, { prefix: "p:" })
        yield* journal.put(signedEntry)
        yield* journal.put(executedEntry)
        return yield* store.keys
      }).pipe(Effect.provide(recording, { local: true }))
    )
    expect(writes).toEqual([`p:entry:${DIGEST}`, `p:entry:${DIGEST}`, `p:settled:${DIGEST}`])
    expect([...keys].sort()).toEqual([`p:entry:${DIGEST}`, `p:settled:${DIGEST}`])
  })

  test("listUnresolved is oldest first whatever order keys come back in", async () => {
    const entryAt = (seed: number, millis: number): JournalEntry => {
      const digest = Digest.make(fakeDigest(seed))
      return seed % 2 === 0
        ? JournalEntry.cases.Signed.make({
          _tag: "Signed",
          digest,
          signed: { ...signed, digest },
          signedAt: DateTime.makeUnsafe(millis)
        })
        : JournalEntry.cases.Unknown.make({
          _tag: "Unknown",
          digest,
          signed: { ...signed, digest },
          lastError: "timeout",
          attempts: 1,
          at: DateTime.makeUnsafe(millis)
        })
    }
    const entries = [entryAt(1, 3_000), entryAt(2, 1_000), entryAt(3, 4_000), entryAt(4, 2_000)]
    // A store whose `keys` answers in reverse insertion order: nothing about
    // the listing may depend on what order the store enumerates in.
    const reversed = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        return KeyValueStore.make({ ...kv, keys: Effect.map(kv.keys, (keys) => [...keys].reverse()) })
      })
    ).pipe(Layer.provide(KeyValueStore.layerMemory))

    const listed = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = make(yield* KeyValueStore.KeyValueStore)
        for (const entry of entries) yield* journal.put(entry)
        return yield* journal.listUnresolved
      }).pipe(Effect.provide(reversed, { local: true }))
    )
    expect(listed.map((entry) => entry.digest)).toEqual(
      [2, 4, 1, 3].map((seed) => Digest.make(fakeDigest(seed)))
    )
  })
})

describe("pruneSettled", () => {
  const withStore = <A, E>(
    effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>
  ) => Effect.runPromise(Effect.provide(effect, KeyValueStore.layerMemory, { local: true }))

  const OLD = DateTime.makeUnsafe(1_000)
  const CUTOFF = DateTime.makeUnsafe(2_000)
  const NEW = DateTime.makeUnsafe(3_000)
  const d = (seed: number) => Digest.make(fakeDigest(seed))

  test("deletes settled entries before the cutoff and nothing else", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store)
        yield* journal.put({ ...executedEntry, digest: d(1), at: OLD })
        yield* journal.put({ ...failedEntry, digest: d(2), at: OLD })
        yield* journal.put({ ...notAppliedEntry, digest: d(3), at: OLD })
        yield* journal.put({ ...executedEntry, digest: d(4), at: NEW })
        // Exactly at the cutoff is not "before" it.
        yield* journal.put({ ...executedEntry, digest: d(5), at: CUTOFF })
        // Unresolved entries survive however old they are.
        yield* journal.put({ ...signedEntry, digest: d(6), signed: { ...signed, digest: d(6) }, signedAt: OLD })
        yield* journal.put({ ...unknownEntry, digest: d(7), at: OLD })
        // A 0.3 index key is left alone.
        yield* store.set("index", "[]")
        const pruned = yield* pruneSettled(CUTOFF)
        return { pruned, keys: [...(yield* store.keys)].sort() }
      })
    )
    expect(result.pruned).toBe(3)
    expect(result.keys).toEqual(
      [
        "index",
        ...[4, 5, 6, 7].map((seed) => `entry:${d(seed)}`),
        ...[4, 5].map((seed) => `settled:${d(seed)}`)
      ].sort()
    )
  })

  test("honours the prefix", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        yield* make(store, { prefix: "a:" }).put({ ...executedEntry, digest: d(1), at: OLD })
        yield* make(store, { prefix: "b:" }).put({ ...executedEntry, digest: d(2), at: OLD })
        const pruned = yield* pruneSettled(CUTOFF, { prefix: "a:" })
        return { pruned, keys: yield* store.keys }
      })
    )
    expect(result.pruned).toBe(1)
    expect([...result.keys].sort()).toEqual([`b:entry:${d(2)}`, `b:settled:${d(2)}`])
  })

  test("an entry that does not decode fails the prune and deletes nothing", async () => {
    const result = await withStore(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        yield* make(store).put({ ...executedEntry, digest: d(1), at: OLD })
        yield* store.set(`entry:${d(2)}`, "{not json")
        const error = yield* Effect.flip(pruneSettled(CUTOFF))
        return { error, size: yield* store.size }
      })
    )
    expect(result.error._tag).toBe("JournalError")
    // The decodable entry, its marker, and the bad entry.
    expect(result.size).toBe(3)
  })
})
