/**
 * `@unconfirmed/sui-effect/storage` (0.5.0): the `KeyValueStore` contract on
 * every adapter, the durable journal over each of them, and the settled-marker
 * index the journal lists through.
 *
 * Every platform store here is an in-memory stand-in (`storage-fakes.ts`); no
 * browser, React Native runtime or extension ran.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { TestClock } from "effect/testing"
import { DateTime, Effect, Fiber, Layer, Option } from "effect"
import { KeyValueStore } from "effect/persistence"
import { existsSync } from "node:fs"
import ts from "typescript"
import { ExecutionReason } from "../src/domain/errors.ts"
import { isUnresolved, JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { layerKeyValueStore, make, pruneSettled } from "../src/services/JournalKeyValueStore.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { fakeDigest, FakeOutcome } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest } from "../src/testing.ts"
import { layerChromeStorage, layerAsyncStorage, layerIndexedDb, layerMmkv } from "../src/storage.ts"
import type { IndexedDbFactory } from "../src/storage.ts"
import {
  makeFakeAsyncStorage,
  makeFakeChromeStorage,
  makeFakeIndexedDb,
  makeFakeMmkv
} from "./storage-fakes.ts"

// The DOM's own `IDBFactory` satisfies the structural interface, so a browser
// consumer passes `indexedDB` with no cast. A compile-time check only.
const _domFactory: (factory: IDBFactory) => IndexedDbFactory = (factory) => factory
void _domFactory

type Store = KeyValueStore.KeyValueStore

const withLayer = <A, E>(layer: Layer.Layer<Store>, effect: Effect.Effect<A, E, Store>) =>
  Effect.runPromise(Effect.scoped(Effect.provide(effect, layer, { local: true })))

const ADAPTERS: ReadonlyArray<readonly [string, () => Layer.Layer<Store>]> = [
  ["IndexedDB", () => layerIndexedDb({ indexedDB: makeFakeIndexedDb().factory })],
  ["AsyncStorage", () => layerAsyncStorage(makeFakeAsyncStorage().storage)],
  ["AsyncStorage without clear", () => layerAsyncStorage(makeFakeAsyncStorage({ withClear: false }).storage)],
  ["MMKV (delete)", () => layerMmkv(makeFakeMmkv("delete").mmkv)],
  ["MMKV (remove)", () => layerMmkv(makeFakeMmkv("remove").mmkv)],
  ["chrome.storage", () => layerChromeStorage(makeFakeChromeStorage().area)],
  ["chrome.storage without getKeys", () => layerChromeStorage(makeFakeChromeStorage({ withGetKeys: false }).area)]
]

// ---------------------------------------------------------------------------
// Fixtures

const SENDER = SuiAddress.make(`0x${"ab".repeat(32)}`)
const d = (seed: number) => Digest.make(fakeDigest(seed))
const at = (millis: number) => DateTime.makeUnsafe(millis)

const signedTx = (digest: Digest) => ({
  digest,
  bytes: new Uint8Array([1, 2, 3]),
  signatures: [Signature.make("sig")],
  sender: SENDER
})

const signedEntry = (seed: number, millis = 1_000): JournalEntry =>
  JournalEntry.cases.Signed.make({ _tag: "Signed", digest: d(seed), signed: signedTx(d(seed)), signedAt: at(millis) })

const unknownEntry = (seed: number, millis = 1_000): JournalEntry =>
  JournalEntry.cases.Unknown.make({
    _tag: "Unknown",
    digest: d(seed),
    signed: signedTx(d(seed)),
    lastError: "timeout",
    attempts: 3,
    at: at(millis)
  })

const executedEntry = (seed: number, millis = 1_000): JournalEntry =>
  JournalEntry.cases.Executed.make({ _tag: "Executed", digest: d(seed), checkpoint: 9n, at: at(millis) })

const failedEntry = (seed: number, millis = 1_000): JournalEntry =>
  JournalEntry.cases.Failed.make({
    _tag: "Failed",
    digest: d(seed),
    reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }),
    at: at(millis)
  })

const notAppliedEntry = (seed: number, millis = 1_000): JournalEntry =>
  JournalEntry.cases.NotApplied.make({ _tag: "NotApplied", digest: d(seed), evidence: "expired", at: at(millis) })

// ---------------------------------------------------------------------------

describe("the KeyValueStore contract on every adapter", () => {
  for (const [name, layer] of ADAPTERS) {
    test(name, async () => {
      const result = await withLayer(
        layer(),
        Effect.gen(function*() {
          const kv = yield* KeyValueStore.KeyValueStore
          const missing = yield* kv.get("nope")
          const missingBytes = yield* kv.getUint8Array("nope")
          yield* kv.set("a:1", "one")
          yield* kv.set("a:2", "two")
          yield* kv.set("b:1", "three")
          yield* kv.set("bytes", new Uint8Array([0, 1, 254, 255]))
          const one = yield* kv.get("a:1")
          const bytes = yield* kv.getUint8Array("bytes")
          const bytesAsString = yield* kv.get("bytes")
          // Not valid base64, so every store reads it back as its UTF-8.
          yield* kv.set("text", "héllo!")
          const textBytes = yield* kv.getUint8Array("text")
          const has = [yield* kv.has("a:1"), yield* kv.has("nope")]
          const size = yield* kv.size
          yield* kv.set("a:1", "uno")
          const overwritten = yield* kv.get("a:1")
          const modified = yield* kv.modify("a:2", (value) => `${value}!`)
          yield* kv.remove("b:1")
          yield* kv.remove("never-there")
          const afterRemove = [...(yield* kv.keys)].sort()
          yield* kv.clearPrefix("a:")
          const afterPrefix = [...(yield* kv.keys)].sort()
          const prefixed = KeyValueStore.prefix(kv, "p/")
          yield* prefixed.set("x", "y")
          const prefixedKeys = yield* prefixed.keys
          yield* kv.clear
          return {
            missing,
            missingBytes,
            one,
            bytes: bytes === undefined ? undefined : [...bytes],
            bytesAsString,
            textBytes: textBytes === undefined ? undefined : new TextDecoder().decode(textBytes),
            has,
            size,
            overwritten,
            modified,
            afterRemove,
            afterPrefix,
            prefixedKeys,
            empty: yield* kv.isEmpty
          }
        })
      )
      expect(result).toEqual({
        missing: undefined,
        missingBytes: undefined,
        one: "one",
        bytes: [0, 1, 254, 255],
        bytesAsString: "AAH+/w==",
        textBytes: "héllo!",
        has: [true, false],
        size: 5,
        overwritten: "uno",
        modified: "two!",
        afterRemove: ["a:1", "a:2", "bytes", "text"],
        afterPrefix: ["bytes", "text"],
        prefixedKeys: ["x"],
        empty: true
      })
    })
  }
})

describe("the durable journal over every adapter", () => {
  for (const [name, layer] of ADAPTERS) {
    test(name, async () => {
      const result = await withLayer(
        layer(),
        Effect.gen(function*() {
          const kv = yield* KeyValueStore.KeyValueStore
          const journal = make(kv, { prefix: "j:" })
          yield* journal.put(signedEntry(1, 3_000))
          yield* journal.put(unknownEntry(2, 1_000))
          yield* journal.put(signedEntry(3, 2_000))
          yield* journal.put(executedEntry(3, 2_500))
          yield* journal.put(failedEntry(4, 500))
          yield* journal.put(notAppliedEntry(5, 500))
          const unresolved = yield* journal.listUnresolved
          const three = yield* journal.get(d(3))
          const missing = yield* journal.get(d(9))
          // A second journal under another prefix sees nothing.
          const other = yield* make(kv, { prefix: "k:" }).listUnresolved
          const pruned = yield* pruneSettled(at(1_000), { prefix: "j:" })
          const afterPrune = yield* journal.listUnresolved
          return {
            unresolved: unresolved.map((entry) => entry.digest),
            three: Option.map(three, (entry) => entry._tag),
            missing: Option.isNone(missing),
            other: other.length,
            pruned,
            afterPrune: afterPrune.map((entry) => entry.digest),
            gone: Option.isNone(yield* journal.get(d(4)))
          }
        })
      )
      expect(result).toEqual({
        unresolved: [d(2), d(1)],
        three: Option.some("Executed"),
        missing: true,
        other: 0,
        pruned: 2,
        afterPrune: [d(2), d(1)],
        gone: true
      })
    })

    test(`${name}: layerKeyValueStore with onUnresolved fail refuses an unsettled store`, async () => {
      const store = layer()
      const seeded = Layer.effectDiscard(
        Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => make(kv).put(signedEntry(1)))
      ).pipe(Layer.provideMerge(store))
      const error = await Effect.runPromise(
        Effect.asVoid(Journal).pipe(
          Effect.provide(layerKeyValueStore({ onUnresolved: "fail" }).pipe(Layer.provide(seeded)), { local: true }),
          Effect.flip
        )
      )
      expect(error._tag).toBe("JournalError")
    })
  }
})

// ---------------------------------------------------------------------------

describe("IndexedDB", () => {
  test("creates its object store on first use and writes with strict durability by default", async () => {
    const fake = makeFakeIndexedDb()
    await withLayer(
      layerIndexedDb({ indexedDB: fake.factory, databaseName: "w", storeName: "s" }),
      Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => kv.set("k", "v"))
    )
    expect(fake.contents("w", "s")?.get("k")).toBe("v")
    expect(fake.calls["createObjectStore"]).toBe(1)
    const durabilities = fake.connections.flatMap((db) => db.transactions.map((tx) => tx.durability))
    expect(durabilities).toEqual(["strict"])
    // The layer's scope closed the connection.
    expect(fake.connections.every((db) => db.closed)).toBe(true)
  })

  test("a database that exists without the store is upgraded, and its other stores are kept", async () => {
    const fake = makeFakeIndexedDb()
    fake.seedForeign("shared", "theirs")
    await withLayer(
      layerIndexedDb({ indexedDB: fake.factory, databaseName: "shared", durability: "relaxed" }),
      Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => kv.set("k", "v"))
    )
    expect(fake.databases.get("shared")?.version).toBe(4)
    expect(fake.contents("shared", "theirs")?.get("theirs")).toBe("kept")
    expect(fake.contents("shared", "keyvalue")?.get("k")).toBe("v")
  })

  test("a versionchange from another tab closes the connection and the next operation reopens", async () => {
    const fake = makeFakeIndexedDb()
    const value = await withLayer(
      layerIndexedDb({ indexedDB: fake.factory }),
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set("k", "v")
        // Another tab opens the database at the next version.
        yield* Effect.promise(() =>
          new Promise<void>((resolve, reject) => {
            const request = fake.factory.open("sui-effect", 2)
            request.onsuccess = () => {
              request.result.close()
              resolve()
            }
            request.onerror = () => reject(request.error)
            request.onblocked = () => reject(new Error("blocked"))
          })
        )
        return yield* kv.get("k")
      })
    )
    expect(value).toBe("v")
    expect(fake.calls["open"]).toBe(3)
  })

  test("interrupting a write aborts its transaction, and nothing is committed", async () => {
    const fake = makeFakeIndexedDb()
    const value = await withLayer(
      layerIndexedDb({ indexedDB: fake.factory }),
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set("k", "before")
        const transactions = () => fake.connections.reduce((n, db) => n + db.transactions.length, 0)
        const before = transactions()
        const fiber = yield* Effect.forkChild(kv.set("k", "after"))
        for (let i = 0; i < 100 && transactions() === before; i++) {
          yield* Effect.yieldNow
          yield* Effect.promise(() => Promise.resolve())
        }
        yield* Fiber.interrupt(fiber)
        return yield* kv.get("k")
      })
    )
    expect(value).toBe("before")
    expect(fake.calls["abort"]).toBe(1)
  })

  test("with no IndexedDB at all, building succeeds and every operation is a KeyValueStoreError", async () => {
    const error = await withLayer(
      layerIndexedDb(),
      Effect.flip(Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => kv.get("k")))
    )
    expect(error._tag).toBe("KeyValueStoreError")
    expect(error.method).toBe("get")
    expect(error.message).toContain("IndexedDB is not available")
  })

  test("a value that is neither a string nor bytes fails get", async () => {
    const fake = makeFakeIndexedDb()
    const error = await withLayer(
      layerIndexedDb({ indexedDB: fake.factory }),
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set("k", "v")
        fake.contents("sui-effect", "keyvalue")?.set("k", { not: "a string" })
        return yield* Effect.flip(kv.get("k"))
      })
    )
    expect(error._tag).toBe("KeyValueStoreError")
    expect(error.key).toBe("k")
  })
})

describe("chrome.storage", () => {
  test("stores strings only, bytes as base64, and refuses a foreign non-string value", async () => {
    const fake = makeFakeChromeStorage()
    const result = await withLayer(
      layerChromeStorage(fake.area),
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* kv.set("bytes", new Uint8Array([1, 2, 3]))
        fake.data.set("foreign", JSON.stringify({ an: "object" }))
        return { error: yield* Effect.flip(kv.get("foreign")), raw: fake.data.get("bytes") }
      })
    )
    expect(result.raw).toBe(JSON.stringify("AQID"))
    expect(result.error._tag).toBe("KeyValueStoreError")
  })

  test("keys uses getKeys when the area has it, and get(null) otherwise", async () => {
    const withKeys = makeFakeChromeStorage()
    const without = makeFakeChromeStorage({ withGetKeys: false })
    for (const fake of [withKeys, without]) {
      await withLayer(layerChromeStorage(fake.area), Effect.flatMap(KeyValueStore.KeyValueStore, (kv) => kv.keys))
    }
    expect(withKeys.calls).toEqual({ getKeys: 1 })
    expect(without.calls).toEqual({ "get(null)": 1 })
  })
})

// ---------------------------------------------------------------------------
// The settled-marker index

/** A memory store that counts `get`s and `keys` and can fail chosen writes. */
const instrumented = () => {
  const counts = { get: 0, keys: 0, set: 0, remove: 0 }
  let failWrite: ((method: "set" | "remove", key: string) => boolean) | undefined
  const layer = Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.map(KeyValueStore.KeyValueStore, (kv) =>
      KeyValueStore.make({
        ...kv,
        get: (key) => Effect.suspend(() => (counts.get += 1, kv.get(key))),
        keys: Effect.suspend(() => (counts.keys += 1, kv.keys)),
        set: (key, value) =>
          Effect.suspend(() => {
            counts.set += 1
            return failWrite?.("set", key) === true
              ? Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "set", key, message: "crash" }))
              : kv.set(key, value)
          }),
        remove: (key) =>
          Effect.suspend(() => {
            counts.remove += 1
            return failWrite?.("remove", key) === true
              ? Effect.fail(new KeyValueStore.KeyValueStoreError({ method: "remove", key, message: "crash" }))
              : kv.remove(key)
          })
      }))
  ).pipe(Layer.provide(KeyValueStore.layerMemory))
  return {
    layer,
    counts,
    reset: () => Object.assign(counts, { get: 0, keys: 0, set: 0, remove: 0 }),
    failOn: (f: typeof failWrite) => {
      failWrite = f
    }
  }
}

/** Writes `entries` the way 0.4.0 did: one `entry:` key each, no marker. */
const writeAs040 = (kv: Store, entries: ReadonlyArray<JournalEntry>) =>
  Effect.gen(function*() {
    const journal = make(kv)
    for (const entry of entries) {
      yield* journal.put(entry)
      yield* kv.remove(`settled:${entry.digest}`)
    }
  })

describe("the settled-marker index", () => {
  test("a journal 0.4.0 wrote reads correctly, is marked by the first listing, and the second reads only the unresolved", async () => {
    const N = 40
    const M = 3
    const store = instrumented()
    const result = await withLayer(
      store.layer,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        const settled = Array.from({ length: N }, (_, i) =>
          i % 3 === 0 ? executedEntry(100 + i) : i % 3 === 1 ? failedEntry(100 + i) : notAppliedEntry(100 + i))
        const unresolved = [signedEntry(1, 1), unknownEntry(2, 2), signedEntry(3, 3)]
        yield* writeAs040(kv, [...settled, ...unresolved])
        expect((yield* kv.keys).some((key) => key.startsWith("settled:"))).toBe(false)

        const journal = make(kv)
        store.reset()
        const first = yield* journal.listUnresolved
        const firstCost = { ...store.counts }
        store.reset()
        const second = yield* journal.listUnresolved
        const secondCost = { ...store.counts }
        const marked = (yield* kv.keys).filter((key) => key.startsWith("settled:")).length
        return { first, second, firstCost, secondCost, marked }
      })
    )
    expect(result.first.map((entry) => entry.digest)).toEqual([d(1), d(2), d(3)])
    expect(result.second.map((entry) => entry.digest)).toEqual([d(1), d(2), d(3)])
    // First listing: the 0.4 scan (N + M reads), plus one re-read per settled
    // entry it marks (N), and N marker writes.
    expect(result.firstCost).toEqual({ get: 2 * N + M, keys: 1, set: N, remove: 0 })
    // Second listing: one `keys` and one read per unresolved entry, nothing else.
    expect(result.secondCost).toEqual({ get: M, keys: 1, set: 0, remove: 0 })
    expect(result.marked).toBe(N)
  })

  test("a store this version wrote lists N settled + M unresolved in one keys and M reads", async () => {
    for (const [N, M] of [[0, 0], [10, 0], [0, 5], [200, 4]] as const) {
      const store = instrumented()
      const cost = await withLayer(
        store.layer,
        Effect.gen(function*() {
          const journal = make(yield* KeyValueStore.KeyValueStore)
          for (let i = 0; i < N; i++) yield* journal.put(signedEntry(1_000 + i))
          for (let i = 0; i < N; i++) yield* journal.put(executedEntry(1_000 + i))
          for (let i = 0; i < M; i++) yield* journal.put(signedEntry(i))
          store.reset()
          const listed = yield* journal.listUnresolved
          expect(listed).toHaveLength(M)
          return { ...store.counts }
        })
      )
      expect(cost).toEqual({ get: M, keys: 1, set: 0, remove: 0 })
    }
  })

  test("on the IndexedDB stand-in, a listing is one getAllKeys and one get per unresolved entry", async () => {
    const fake = makeFakeIndexedDb()
    const N = 100
    const M = 2
    await withLayer(
      layerIndexedDb({ indexedDB: fake.factory }),
      Effect.gen(function*() {
        const journal = make(yield* KeyValueStore.KeyValueStore)
        for (let i = 0; i < N; i++) yield* journal.put(executedEntry(1_000 + i))
        for (let i = 0; i < M; i++) yield* journal.put(unknownEntry(i))
        for (const key of Object.keys(fake.calls)) delete fake.calls[key]
        expect(yield* journal.listUnresolved).toHaveLength(M)
      })
    )
    expect(fake.calls).toEqual({ "transaction:readonly": 1 + M, getAllKeys: 1, get: M })
  })

  test("a put's write cost: terminal is entry then marker; unresolved is clear, entry, clear", async () => {
    const store = instrumented()
    const writes: Array<string> = []
    const recording = Layer.effect(
      KeyValueStore.KeyValueStore,
      Effect.map(KeyValueStore.KeyValueStore, (kv) =>
        KeyValueStore.make({
          ...kv,
          set: (key, value) => Effect.suspend(() => (writes.push(`set ${key}`), kv.set(key, value))),
          remove: (key) => Effect.suspend(() => (writes.push(`remove ${key}`), kv.remove(key)))
        }))
    ).pipe(Layer.provide(store.layer))
    await withLayer(
      recording,
      Effect.gen(function*() {
        const journal = make(yield* KeyValueStore.KeyValueStore)
        yield* journal.put(signedEntry(1))
        yield* journal.put(executedEntry(1))
        // A resubmission of settled bytes puts a fresh Signed over the marker.
        yield* journal.put(signedEntry(1))
      })
    )
    const D = d(1)
    expect(writes).toEqual([
      `set entry:${D}`,
      `set entry:${D}`,
      `set settled:${D}`,
      `remove settled:${D}`,
      `set entry:${D}`
    ])
  })

  /**
   * A crash at any write of any put — modelled as that write failing and
   * nothing after it running — never hides an unresolved entry: whatever the
   * store holds under `entry:<digest>` afterwards, if it is unresolved,
   * `listUnresolved` returns it.
   */
  test("a crash at any write of a put never hides an unresolved entry", async () => {
    const scenarios: ReadonlyArray<readonly [string, ReadonlyArray<JournalEntry>, JournalEntry]> = [
      ["terminal over nothing", [], executedEntry(1)],
      ["terminal over Signed", [signedEntry(1)], executedEntry(1)],
      ["Signed over settled", [signedEntry(1), notAppliedEntry(1)], signedEntry(1)],
      ["Unknown over Signed", [signedEntry(1)], unknownEntry(1)],
      ["Signed over nothing", [], signedEntry(1)]
    ]
    let cases = 0
    for (const [name, before, put] of scenarios) {
      for (let crashAt = 0; crashAt < 4; crashAt++) {
        const store = instrumented()
        const outcome = await withLayer(
          store.layer,
          Effect.gen(function*() {
            const kv = yield* KeyValueStore.KeyValueStore
            const journal = make(kv)
            for (const entry of before) yield* journal.put(entry)
            let writes = 0
            let crashed = false
            store.failOn(() => {
              if (crashed) return true
              crashed = writes++ === crashAt
              return crashed
            })
            const failed = Option.isSome(Option.getFailure(yield* Effect.result(journal.put(put))))
            store.failOn(undefined)
            // A fresh journal over the same store: the process came back.
            const stored = yield* make(kv).get(put.digest)
            const listed = yield* make(kv).listUnresolved
            return { failed, stored, listed }
          })
        )
        if (Option.isSome(outcome.stored) && isUnresolved(outcome.stored.value)) {
          expect({ name, crashAt, listed: outcome.listed.map((entry) => entry.digest) }).toEqual({
            name,
            crashAt,
            listed: [put.digest]
          })
        } else {
          expect({ name, crashAt, listed: outcome.listed.length }).toEqual({ name, crashAt, listed: 0 })
        }
        cases += 1
      }
    }
    expect(cases).toBe(20)
  })

  /**
   * A listing that marks an unmarked settled entry can race a fresh `Signed`
   * put of the same digest. Both orders of the put against the marker write
   * leave the `Signed` entry listed.
   */
  for (const order of ["before", "after"] as const) {
    test(`a listing's marker write racing a Signed put (${order} the marker) never hides it`, async () => {
      const listed = await Effect.runPromise(
        Effect.gen(function*() {
          const base = yield* KeyValueStore.KeyValueStore
          let journal: ReturnType<typeof make> | undefined
          let raced = false
          const racing = KeyValueStore.make({
            ...base,
            set: (key, value) =>
              Effect.gen(function*() {
                const race = !raced && journal !== undefined && key === `settled:${d(1)}`
                if (race) raced = true
                if (race && order === "before") yield* journal!.put(signedEntry(1))
                yield* base.set(key, value)
                if (race && order === "after") yield* journal!.put(signedEntry(1)).pipe(Effect.orDie)
              }).pipe(Effect.orDie)
          })
          // A settled entry with no marker, as 0.4.0 left it.
          yield* writeAs040(base, [executedEntry(1)])
          journal = make(racing)
          yield* journal.listUnresolved
          expect(raced).toBe(true)
          return yield* make(base).listUnresolved
        }).pipe(Effect.provide(KeyValueStore.layerMemory, { local: true }))
      )
      expect(listed.map((entry) => entry.digest)).toEqual([d(1)])
    })
  }

  test("a marker whose entry is gone is skipped by a listing and swept by pruneSettled", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* make(kv).put(executedEntry(1))
        yield* kv.remove(`entry:${d(1)}`) // a 0.4.0 prune
        const listed = yield* make(kv).listUnresolved
        const pruned = yield* pruneSettled(at(0))
        return { listed: listed.length, pruned, keys: yield* kv.keys }
      }).pipe(Effect.provide(KeyValueStore.layerMemory, { local: true }))
    )
    expect(result).toEqual({ listed: 0, pruned: 0, keys: [] })
  })

  test("a marker write that fails during a listing fails nothing", async () => {
    const store = instrumented()
    const listed = await withLayer(
      store.layer,
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        yield* writeAs040(kv, [executedEntry(1), signedEntry(2)])
        store.failOn((method, key) => method === "set" && key.startsWith("settled:"))
        return yield* make(kv).listUnresolved
      })
    )
    expect(listed.map((entry) => entry.digest)).toEqual([d(2)])
  })

  test("rolling back: a 0.4.0-style scan of entry: keys ignores the markers", async () => {
    const tags = await Effect.runPromise(
      Effect.gen(function*() {
        const kv = yield* KeyValueStore.KeyValueStore
        const journal = make(kv)
        yield* journal.put(signedEntry(1))
        yield* journal.put(executedEntry(2))
        const keys = yield* kv.keys
        // What 0.4.0's `readAll` reads: `entry:` keys only.
        return keys.filter((key) => key.startsWith("entry:")).length
      }).pipe(Effect.provide(KeyValueStore.layerMemory, { local: true }))
    )
    expect(tags).toBe(2)
  })
})

// ---------------------------------------------------------------------------

describe("Tx.run over a journal on IndexedDB", () => {
  const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
  const ESCROW_ID = PADDED("e1")
  const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
  const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
  const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: signer.address }
  const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
  const script = {
    chainId: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
    clockTimestampMs: 1_700_000_000_000n,
    objects: [{
      objectId: ESCROW_ID,
      type: ESCROW_TYPE,
      version: 3n,
      owner,
      content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
    }],
    coins: [{
      objectId: PADDED("c01"),
      version: "2",
      digest: "11111111111111111111111111111111",
      type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
      balance: "1000000000",
      owner,
      previousTransaction: null
    } as unknown as SuiClientTypes.Coin],
    execute: [FakeOutcome.succeed({ mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }] })]
  }
  const claim = (tx: Transaction) => {
    tx.moveCall({ target: `${PADDED("2")}::escrow::claim`, arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)] })
  }

  test("the lifecycle journals Signed then Executed, and the settled entry is marked", async () => {
    const fake = makeFakeIndexedDb()
    const store = layerIndexedDb({ indexedDB: fake.factory })
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const done = yield* Tx.run(claim, { signer })
        const recorded = yield* Tx.recorded(done.digest)
        const journal = yield* Journal
        return { digest: done.digest, recorded, unresolved: yield* journal.listUnresolved }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest(script),
            TestClock.layer(),
            layerKeyValueStore({ onUnresolved: "fail" }).pipe(Layer.provide(store))
          ),
          { local: true }
        )
      )
    )
    expect(Option.map(result.recorded, (entry) => entry._tag)).toEqual(Option.some("Executed"))
    expect(result.unresolved).toHaveLength(0)
    const keys = [...(fake.contents("sui-effect", "keyvalue")?.keys() ?? [])].sort()
    expect(keys).toEqual([`entry:${result.digest}`, `settled:${result.digest}`])
  })
})

// ---------------------------------------------------------------------------

/**
 * The emitted declarations of the storage subpath name no DOM, React Native or
 * `chrome` type: checked by compiling `dist/storage.d.ts` against `lib:
 * ["esnext"]` (no DOM) and reporting any diagnostic in this package's own
 * storage declarations. Skips without a build, like `llms.test.ts`.
 */
describe("the storage declarations need no DOM types", () => {
  const entry = "dist/storage.d.ts"
  // A whole TypeScript program over effect's declarations: seconds, not milliseconds.
  test.skipIf(!existsSync(entry))("dist/storage.d.ts compiles without lib.dom", () => {
    const program = ts.createProgram([entry], {
      lib: ["lib.esnext.d.ts"],
      types: [],
      noEmit: true,
      strict: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext
    })
    const own = (name: string) => /dist\/(storage|services\/Storage\w+)\.d\.ts$/.test(name)
    // Not vacuous: all four declaration files are in the program.
    expect(program.getSourceFiles().filter((file) => own(file.fileName))).toHaveLength(4)
    const ours = ts.getPreEmitDiagnostics(program).filter((diagnostic) =>
      diagnostic.file !== undefined && own(diagnostic.file.fileName)
    )
    expect(ours.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([])
  }, 120_000)
})
