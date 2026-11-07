import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Option } from "effect"
import { KeyValueStore } from "effect/persistence"
import { ExecutionReason } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Digest, Signature, SuiAddress } from "../src/domain/schemas.ts"
import { fakeDigest } from "../src/testing.ts"
import { make } from "../src/services/JournalKeyValueStore.ts"

/**
 * The raw contents of a durable journal written by `@unconfirmed/sui-effect`
 * 0.2.2 on `effect@4.0.0-rc.112`: one entry of every lifecycle state plus the
 * unresolved index. The port to `effect@4.0.3` changed the Schema check-ID
 * names and hashes, and none of it may reach the stored bytes: a store written
 * before the upgrade has to read, and be rewritten byte for byte, after it.
 *
 * 0.4.0 dropped the index (the journal lists through `KeyValueStore.keys`), so
 * the `index` key is dead data now: it must not be read, rewritten, or fail
 * anything, and every entry key must still round-trip exactly.
 */
const STORE_FROM_RC112: Record<string, string> = {
  "index": "[\"8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKp\",\"LX3EUdRUBUa3TbsYXLEUdj9J3prXkWXvLYSWyYyc2Jr\"]",
  "entry:8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKp": "{\"_tag\":\"Signed\",\"digest\":\"8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKp\",\"signed\":{\"digest\":\"8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKp\",\"bytes\":\"AQIDAQ==\",\"signatures\":[\"sig\"],\"sender\":\"0xabababababababababababababababababababababababababababababababab\",\"expiration\":{\"$kind\":\"ValidDuring\",\"ValidDuring\":{\"minEpoch\":null,\"maxEpoch\":null,\"minTimestamp\":null,\"maxTimestamp\":\"1700000120000\",\"chain\":\"4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S\",\"nonce\":7}}},\"signedAt\":1700000000000}",
  "entry:CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQzA": "{\"_tag\":\"Executed\",\"digest\":\"CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQzA\",\"checkpoint\":\"88\",\"at\":1700000000000}",
  "entry:GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeW": "{\"_tag\":\"Failed\",\"digest\":\"GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeW\",\"reason\":{\"$kind\":\"Unknown\"},\"at\":1700000000000}",
  "entry:LX3EUdRUBUa3TbsYXLEUdj9J3prXkWXvLYSWyYyc2Jr": "{\"_tag\":\"Unknown\",\"digest\":\"LX3EUdRUBUa3TbsYXLEUdj9J3prXkWXvLYSWyYyc2Jr\",\"signed\":{\"digest\":\"LX3EUdRUBUa3TbsYXLEUdj9J3prXkWXvLYSWyYyc2Jr\",\"bytes\":\"AQIDBA==\",\"signatures\":[\"sig\"],\"sender\":\"0xabababababababababababababababababababababababababababababababab\",\"expiration\":{\"$kind\":\"ValidDuring\",\"ValidDuring\":{\"minEpoch\":null,\"maxEpoch\":null,\"minTimestamp\":null,\"maxTimestamp\":\"1700000120000\",\"chain\":\"4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S\",\"nonce\":7}}},\"lastError\":\"TransportError DEADLINE_EXCEEDED\",\"attempts\":5,\"at\":1700000000000}",
  "entry:QRSsyMWN1yHT9ir42bgNZUNZ4PdEhcSWCrL2AryKpyC": "{\"_tag\":\"NotApplied\",\"digest\":\"QRSsyMWN1yHT9ir42bgNZUNZ4PdEhcSWCrL2AryKpyC\",\"evidence\":\"inputConsumed\",\"at\":1700000000000}"
}

const ENTRY_KEYS = Object.keys(STORE_FROM_RC112).filter((key) => key.startsWith("entry:"))

const DIGESTS = Object.keys(STORE_FROM_RC112)
  .filter((key) => key.startsWith("entry:"))
  .map((key) => Digest.make(key.slice("entry:".length)))

/** The terminal entries of the fixture: the ones a 0.5.0 rewrite marks settled. */
const SETTLED_DIGESTS = [
  "CiDwVBFgWV9E5MvXWoLgnEgn2hK7rJikbvfWavzAQzA",
  "GcdayuLaLyrdmUu324nahyv33G5poQdLUEZ1nEytDeW",
  "QRSsyMWN1yHT9ir42bgNZUNZ4PdEhcSWCrL2AryKpyC"
]

const run = <A>(effect: Effect.Effect<A, unknown, KeyValueStore.KeyValueStore>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStore.layerMemory)))

describe("a journal written on effect rc.112", () => {
  test("every entry decodes, the index is ignored, and a rewrite is byte-identical", async () => {
    const rewritten = await run(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        for (const [key, value] of Object.entries(STORE_FROM_RC112)) yield* store.set(key, value)
        const journal = make(store)

        const unresolved = yield* journal.listUnresolved
        expect(unresolved.map((entry) => entry._tag).sort()).toEqual(["Signed", "Unknown"])
        // Listing never touched the old index.
        expect(yield* store.get("index")).toBe(STORE_FROM_RC112["index"])

        const decoded = []
        for (const digest of DIGESTS) {
          const entry = yield* journal.get(digest)
          expect(Option.isSome(entry)).toBe(true)
          if (Option.isSome(entry)) decoded.push(entry.value)
        }
        expect(decoded.map((entry) => entry._tag).sort()).toEqual(
          ["Executed", "Failed", "NotApplied", "Signed", "Unknown"]
        )

        // `local: true`: without it the memoized `layerMemory` hands back the
        // very store the fixture was loaded into.
        const fresh = yield* Effect.provide(KeyValueStore.KeyValueStore, KeyValueStore.layerMemory, {
          local: true
        })
        const target = make(fresh)
        for (const entry of decoded) yield* target.put(entry)
        const out: Record<string, string | undefined> = {}
        for (const key of ENTRY_KEYS) out[key] = yield* fresh.get(key)
        // A rewrite produces the entry keys and a settled marker for each
        // terminal one (0.5.0), and no index.
        expect([...(yield* fresh.keys)].sort()).toEqual(
          [...ENTRY_KEYS, ...SETTLED_DIGESTS.map((digest) => `settled:${digest}`)].sort()
        )
        return out
      })
    )
    expect(rewritten).toEqual(Object.fromEntries(ENTRY_KEYS.map((key) => [key, STORE_FROM_RC112[key]])))
  })

  test("an index key holding garbage fails nothing", async () => {
    const unresolved = await run(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        for (const key of ENTRY_KEYS) yield* store.set(key, STORE_FROM_RC112[key]!)
        yield* store.set("index", "not json at all")
        return yield* make(store).listUnresolved
      })
    )
    expect(unresolved.map((entry) => entry._tag).sort()).toEqual(["Signed", "Unknown"])
  })
})

describe("a journal written by this version", () => {
  test("encodes the five typed entries to the rc.112 bytes", async () => {
    const at = DateTime.makeUnsafe(1_700_000_000_000)
    const d = (n: number) => Digest.make(fakeDigest(n))
    const signed = (n: number) => ({
      digest: d(n),
      bytes: new Uint8Array([1, 2, 3, n]),
      signatures: [Signature.make("sig")],
      sender: SuiAddress.make(`0x${"ab".repeat(32)}`),
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
    })
    const entries: ReadonlyArray<JournalEntry> = [
      JournalEntry.cases.Signed.make({ _tag: "Signed", digest: d(1), signed: signed(1), signedAt: at }),
      JournalEntry.cases.Executed.make({ _tag: "Executed", digest: d(2), checkpoint: 88n, at }),
      JournalEntry.cases.Failed.make({
        _tag: "Failed",
        digest: d(3),
        reason: ExecutionReason.cases.Unknown.make({ $kind: "Unknown" }),
        at
      }),
      JournalEntry.cases.Unknown.make({
        _tag: "Unknown",
        digest: d(4),
        signed: signed(4),
        lastError: "TransportError DEADLINE_EXCEEDED",
        attempts: 5,
        at
      }),
      JournalEntry.cases.NotApplied.make({ _tag: "NotApplied", digest: d(5), evidence: "inputConsumed", at })
    ]
    const written = await run(
      Effect.gen(function*() {
        const store = yield* KeyValueStore.KeyValueStore
        const journal = make(store)
        for (const entry of entries) yield* journal.put(entry)
        const out: Record<string, string | undefined> = {}
        for (const key of ENTRY_KEYS) out[key] = yield* store.get(key)
        expect(yield* store.has("index")).toBe(false)
        return out
      })
    )
    expect(written).toEqual(Object.fromEntries(ENTRY_KEYS.map((key) => [key, STORE_FROM_RC112[key]])))
  })
})
