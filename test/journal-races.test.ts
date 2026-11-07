/**
 * The durable journal under races and faults: a terminal put racing an
 * unresolved put of the same digest (another tab, another extension context),
 * a listing whose re-read fails after it wrote a marker — both hid a `Signed`
 * entry from `listUnresolved` before they were fixed — and a terminal write
 * that fails.
 */
import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import { KeyValueStore } from "effect/persistence"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { make } from "../src/services/JournalKeyValueStore.ts"
import { fakeDigest } from "../src/testing.ts"

type KV = KeyValueStore.KeyValueStore
const SENDER = SuiAddress.make(`0x${"ab".repeat(32)}`)
const d = (seed: number) => Digest.make(fakeDigest(seed))
const at = (millis: number) => DateTime.makeUnsafe(millis)
const signedTx = (digest: Digest) => ({ digest, bytes: new Uint8Array([1, 2, 3]), signatures: [Signature.make("sig")], sender: SENDER })
const signedEntry = (seed: number): JournalEntry =>
  JournalEntry.cases.Signed.make({ _tag: "Signed", digest: d(seed), signed: signedTx(d(seed)), signedAt: at(1_000) })
const executedEntry = (seed: number): JournalEntry =>
  JournalEntry.cases.Executed.make({ _tag: "Executed", digest: d(seed), checkpoint: 9n, at: at(1_000) })
const memStore = () => {
  const data = new Map<string, string>()
  const kv = KeyValueStore.make({
    get: (k) => Effect.sync(() => data.get(k)),
    getUint8Array: (k) => Effect.sync(() => (data.has(k) ? new TextEncoder().encode(data.get(k)) : undefined)),
    set: (k, v) => Effect.sync(() => void data.set(k, typeof v === "string" ? v : "")),
    remove: (k) => Effect.sync(() => void data.delete(k)),
    clear: Effect.sync(() => data.clear()),
    size: Effect.sync(() => data.size),
    keys: Effect.sync(() => [...data.keys()])
  })
  return { kv, data }
}

type Hook = (phase: "before" | "after", method: string, key: string | undefined) => Effect.Effect<void, KeyValueStore.KeyValueStoreError>
const wrap = (base: KV, on: Hook): KV => {
  const w = <A>(method: string, key: string | undefined, run: Effect.Effect<A, KeyValueStore.KeyValueStoreError>) =>
    Effect.suspend(() => on("before", method, key)).pipe(
      Effect.andThen(run),
      Effect.tap(() => Effect.suspend(() => on("after", method, key)))
    )
  return KeyValueStore.make({
    get: (k) => w("get", k, base.get(k)),
    getUint8Array: (k) => w("getUint8Array", k, base.getUint8Array(k)),
    set: (k, v) => w("set", k, base.set(k, v)),
    remove: (k) => w("remove", k, base.remove(k)),
    clear: w("clear", undefined, base.clear),
    size: w("size", undefined, base.size),
    keys: w("keys", undefined, base.keys)
  })
}
const crash = (method: string) => new KeyValueStore.KeyValueStoreError({ method, message: "crash" })
const tags = (entries: ReadonlyArray<JournalEntry>) => entries.map((entry) => entry.digest)

describe("a terminal put racing an unresolved put of the same digest", () => {
  test("the unresolved put landing between the entry and the marker stays listed", async () => {
    const out = await Effect.runPromise(Effect.gen(function*() {
      const { kv: base } = memStore()
      const other = make(base)
      let fired = false
      const terminal = make(wrap(base, (phase, method, key) => {
        if (!fired && phase === "before" && method === "set" && key === `settled:${d(1)}`) {
          fired = true
          return Effect.orDie(other.put(signedEntry(1)))
        }
        return Effect.void
      }))
      yield* terminal.put(executedEntry(1))
      const stored = yield* make(base).get(d(1))
      return { fired, stored: Option.map(stored, (entry) => entry._tag), listed: tags(yield* make(base).listUnresolved) }
    }))
    expect(out.fired).toBe(true)
    expect(out.stored).toEqual(Option.some("Signed"))
    expect(out.listed).toEqual([d(1)])
  })
})

describe("a listing that marks an unmarked settled entry", () => {
  test("a re-read that fails takes the marker back, so a concurrent Signed stays listed", async () => {
    const out = await Effect.runPromise(Effect.gen(function*() {
      const { kv: base, data } = memStore()
      // An unmarked settled entry, as 0.4 left it (or a crash between entry and marker).
      yield* make(base).put(executedEntry(1))
      data.delete(`settled:${d(1)}`)
      const writer = make(base)
      let stage = 0
      const listing = make(wrap(base, (phase, method, key) => {
        if (stage === 0 && phase === "before" && method === "set" && key === `settled:${d(1)}`) {
          stage = 1
          return Effect.orDie(writer.put(signedEntry(1)))
        }
        if (stage === 1 && phase === "before" && method === "get" && key === `entry:${d(1)}`) {
          stage = 2
          return Effect.fail(crash(method))
        }
        return Effect.void
      }))
      yield* Effect.result(listing.listUnresolved)
      return { stage, listed: tags(yield* make(base).listUnresolved) }
    }))
    expect(out.stage).toBe(2)
    expect(out.listed).toEqual([d(1)])
  })
})

describe("a terminal write that fails", () => {
  test("leaves the Signed entry unresolved for recovery, under its one key", async () => {
    const { kv, data } = memStore()
    let failing = false
    const journal = make(wrap(kv, (phase, method) => failing && phase === "before" && method === "set" ? Effect.fail(crash("set")) : Effect.void))
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      yield* journal.put(signedEntry(2))
      failing = true
      const crashed = yield* Effect.result(journal.put(executedEntry(2)))
      failing = false
      return { crashed, entry: yield* journal.get(d(2)), unresolved: yield* journal.listUnresolved }
    }))
    expect(outcome.crashed._tag).toBe("Failure")
    expect(Option.map(outcome.entry, (entry) => entry._tag)).toEqual(Option.some("Signed"))
    expect(tags(outcome.unresolved)).toEqual([d(2)])
    expect([...data.keys()]).toEqual([`entry:${d(2)}`])
  })
})
