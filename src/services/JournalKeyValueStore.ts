/**
 * The durable `Journal`, over `KeyValueStore` from `effect/persistence`.
 *
 * It imports `effect/persistence` (`@stability unstable` upstream), as do
 * `Keystore.ts` and the storage adapters, each reachable only through its own
 * subpath (`sui-effect/journal`, `sui-effect/keystore`, `sui-effect/storage`),
 * so the core modules never load it.
 *
 * Building the layer does no network work: it lists the store's unresolved
 * entries and, when asked to, refuses to start while any are unresolved. What
 * to do about them is `Tx.reconcileAll`, which an application calls explicitly.
 *
 * @since 0.1.0
 */
import { Array as Arr, DateTime, Effect, Layer, Option, Schema } from "effect"
import { KeyValueStore } from "effect/persistence"
import { JournalError } from "../domain/errors.ts"
import { isUnresolved, JournalEntry } from "../domain/journal-entry.ts"
import type { Digest } from "../domain/schemas.ts"
import type { JournalService } from "./Journal.ts"
import { Journal } from "./Journal.ts"

/** What a durable journal does about entries left over from a previous run. */
export interface JournalKeyValueStoreOptions {
  /**
   * `"fail"` refuses to build the layer while the store holds unresolved
   * entries, which is what a service that must never silently drop a
   * transaction wants: it forces the operator (or a `Tx.reconcileAll` step
   * ahead of this layer) to settle them first. `"ignore"` builds anyway and
   * leaves them for `Tx.reconcileAll`.
   */
  readonly onUnresolved: "fail" | "ignore"
  /** A prefix for every key, so several journals can share one store. */
  readonly prefix?: string
}

const ENTRY = "entry:"

/**
 * The settled marker: `settled:<digest>` exists only while `entry:<digest>`
 * holds a terminal entry, and its value is that entry's tag. It is a
 * **negative** index — it names what a listing may skip, never what it must
 * read — so a missing marker costs one extra read and a marker can only hide
 * an entry if it is wrong, which the write order below rules out but for
 * one crash window (see {@link make}).
 */
const SETTLED = "settled:"

const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(JournalEntry))
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(JournalEntry))

const journalError = (cause: unknown): JournalError => new JournalError({ cause })

/** How many entries a listing reads at once. */
const READ_CONCURRENCY = 8

/**
 * When an entry last changed state: `signedAt` for `Signed`, `at` for every
 * other case. It is what "oldest first" sorts by, because `keys` comes back in
 * no particular order.
 */
const stampOf = (entry: JournalEntry): number =>
  DateTime.toEpochMillis(entry._tag === "Signed" ? entry.signedAt : entry.at)

const oldestFirst = (a: JournalEntry, b: JournalEntry): number =>
  stampOf(a) - stampOf(b) || (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0)

const viewOf = (
  store: KeyValueStore.KeyValueStore,
  prefix: string | undefined
): KeyValueStore.KeyValueStore => prefix === undefined ? store : KeyValueStore.prefix(store, prefix)

const readEntry = (kv: KeyValueStore.KeyValueStore, digest: string) =>
  kv.get(`${ENTRY}${digest}`).pipe(
    Effect.mapError(journalError),
    Effect.flatMap((raw) =>
      raw === undefined
        // Removed between `keys` and `get`, or a marker whose entry is gone:
        // nothing to report.
        ? Effect.succeed(Option.none<JournalEntry>())
        : decodeEntry(raw).pipe(Effect.mapError(journalError), Effect.map(Option.some))
    )
  )

/** Removes the settled marker if there is one: a read, and a write only when it exists. */
const clearMarker = (kv: KeyValueStore.KeyValueStore, digest: string) =>
  Effect.gen(function*() {
    const key = `${SETTLED}${digest}`
    if (yield* kv.has(key)) yield* kv.remove(key)
  }).pipe(Effect.mapError(journalError))

/** The digests of every entry key and of every settled marker, from one `keys`. */
const listKeys = (kv: KeyValueStore.KeyValueStore) =>
  Effect.map(kv.keys.pipe(Effect.mapError(journalError)), (keys) => {
    const entries: Array<string> = []
    const settled = new Set<string>()
    for (const key of keys) {
      if (key.startsWith(ENTRY)) entries.push(key.slice(ENTRY.length))
      else if (key.startsWith(SETTLED)) settled.add(key.slice(SETTLED.length))
    }
    return { entries, settled }
  })

/**
 * Writes the settled marker for `entry`, then reads the entry again and takes
 * the marker back unless that read **confirms** a terminal entry — it found
 * an unresolved one, found none, or failed. The re-read is what keeps a
 * concurrent `put` of an unresolved entry for the same digest (another tab,
 * another extension context, another process) visible: that put clears the
 * marker after its own write, so either it sees this marker and removes it,
 * or this re-read sees its entry. Used by a terminal `put` and by a listing
 * that found a settled entry with no marker.
 *
 * What it cannot cover: a process that dies after the marker write and
 * before the re-read (or whose `remove` fails), while an unresolved `put` of
 * the same digest from another writer landed wholly between the entry write
 * and the marker write. Closing that needs a compare-and-set the
 * `KeyValueStore` interface does not have.
 *
 * Fails with: `JournalError` (the marker write, or the `remove`).
 */
const settleMarker = (kv: KeyValueStore.KeyValueStore, entry: JournalEntry) =>
  Effect.gen(function*() {
    const key = `${SETTLED}${entry.digest}`
    yield* kv.set(key, entry._tag).pipe(Effect.mapError(journalError))
    const confirmed = yield* readEntry(kv, entry.digest).pipe(
      Effect.map((again) => Option.isSome(again) && !isUnresolved(again.value)),
      Effect.orElseSucceed(() => false)
    )
    if (!confirmed) yield* kv.remove(key).pipe(Effect.mapError(journalError))
  })

/**
 * {@link settleMarker} for a settled entry a listing just read without a
 * marker (a store 0.4 wrote, or a crash between a terminal entry and its
 * marker). Best effort: a marker is an optimization, so a failure here fails
 * nothing.
 */
const heal = (kv: KeyValueStore.KeyValueStore, entry: JournalEntry) => settleMarker(kv, entry).pipe(Effect.ignore)

/**
 * The entries that may be unresolved: every entry key without a settled
 * marker, read and decoded. A settled one found here gets its marker, so the
 * next listing skips it.
 */
const readUnmarked = (kv: KeyValueStore.KeyValueStore) =>
  Effect.gen(function*() {
    const { entries, settled } = yield* listKeys(kv)
    const read = yield* Effect.forEach(
      entries.filter((digest) => !settled.has(digest)),
      (digest) =>
        readEntry(kv, digest).pipe(
          Effect.tap((entry) =>
            Option.isSome(entry) && !isUnresolved(entry.value) ? heal(kv, entry.value) : Effect.void
          )
        ),
      { concurrency: READ_CONCURRENCY }
    )
    return Arr.getSomes(read).filter(isUnresolved)
  })

/**
 * A journal backed by a `KeyValueStore`.
 *
 * Each entry is one key, `entry:<digest>`, holding the entry as JSON. A
 * terminal entry (`Executed`, `Failed`, `NotApplied`) overwrites the
 * unresolved one and stays, so a later `get` still finds the answer.
 *
 * **A settled marker beside each terminal entry.** `settled:<digest>` (value:
 * the tag) exists only while the entry under that digest is terminal, and
 * `listUnresolved` reads every entry key **except** the marked ones: one
 * `keys` and one `get` per unresolved entry, however many settled ones the
 * store keeps. The marker is a negative index — it says what may be skipped,
 * never what must be read — so the write order is chosen to make a crash cost
 * a spurious read and never a missing entry:
 *
 * - an unresolved `put` (`Signed`, `Unknown`) clears the marker, writes the
 *   entry, and clears the marker again (each clear a `has`, and a `remove`
 *   only when it exists). A crash after the first clear leaves an unmarked
 *   terminal entry, which the next listing reads once and marks.
 * - a terminal `put` writes the entry, then the marker, then reads the entry
 *   back and removes the marker unless the read confirms a terminal entry —
 *   so an unresolved `put` of the same digest from another writer that lands
 *   between the two writes stays listed. A crash between the entry and the
 *   marker leaves an unmarked terminal entry, read once and marked.
 * - a listing that reads an unmarked terminal entry marks it, reads the entry
 *   again and takes the marker back if the entry is no longer terminal — the
 *   other half of the second clear above, so a listing racing a fresh `Signed`
 *   for the same digest cannot leave it hidden. Marker writes during a listing
 *   are best effort and never fail it.
 *
 * Nothing is read-modify-written: two fibers, two layer instances, two
 * processes over one store do not lose each other's entries. Two writers that
 * put the **same** digest at once still race for the entry, and the last
 * `set` wins; that happens when another context's `Tx.reconcileAll` writes
 * `Unknown` (or re-sends) for a `Signed` entry this one is settling. A marker
 * is never left over an unresolved entry by that race, **except** when the
 * settling process dies (or its `remove` fails) between its marker write and
 * its re-read while the other writer's whole `put` landed just before the
 * marker write: then the entry is hidden from listings (never from `get`)
 * until it is written again. Closing that needs a compare-and-set.
 *
 * **A store 0.4 wrote needs no migration.** It has entries and no markers, and
 * an unmarked entry is always read, so the first listing is the 0.4 scan and
 * marks every settled entry it finds; the second reads only the unresolved
 * ones. Rolling back to 0.4 is safe for 0.4: it reads only `entry:` keys and
 * ignores the markers. **Rolling forward again is not, after 0.4 wrote**: a
 * 0.4 process that put an unresolved entry over a digest 0.5 had settled left
 * 0.5's marker in place, so delete every `settled:` key (or drain the journal
 * with `Tx.reconcileAll` on 0.4) before a 0.5 process lists the store again. **Running a 0.4 writer beside this one is not**, in one case: a
 * 0.4 process that writes an unresolved entry over a digest this journal had
 * settled leaves the marker in place, and the entry is hidden from
 * `listUnresolved` (not from `get`). The lifecycle re-signs a settled digest
 * only when the same bytes are submitted again; drain with `Tx.reconcileAll`
 * and stop the 0.4 writers before mixing versions.
 *
 * A store written by 0.3 or earlier also holds an `index` key: dead data here
 * — never read, never rewritten, never an error. **Rolling back to 0.3 is not
 * safe as is.** 0.3 lists unresolved entries only through that index, so a
 * `Signed` or `Unknown` entry this journal wrote is invisible to a 0.3
 * `listUnresolved`, `Tx.reconcileAll` and `onUnresolved: "fail"` (only
 * `Tx.recorded(digest)` finds it), and a 0.3 reader cannot decode a
 * `NotApplied { evidence: "refused" }` entry at all. Before rolling back, or
 * while 0.3 and later processes share a store, drain it with
 * `Tx.reconcileAll()` (or settle the entries by hand) and delete the
 * `"refused"` entries.
 *
 * `keys` is still O(n) in the prefix on every store, and some stores pay for
 * it in values (`chrome.storage` without `getKeys`); {@link pruneSettled} is
 * how a long-lived service keeps n short.
 *
 * Every member fails with `JournalError` and nothing else.
 */
export const make = (
  store: KeyValueStore.KeyValueStore,
  options?: { readonly prefix?: string }
): JournalService => {
  const kv = viewOf(store, options?.prefix)

  return {
    put: Effect.fn("Journal.put")(function*(entry: JournalEntry) {
      const json = yield* encodeEntry(entry).pipe(Effect.mapError(journalError))
      const set = kv.set(`${ENTRY}${entry.digest}`, json).pipe(Effect.mapError(journalError))
      if (isUnresolved(entry)) {
        yield* clearMarker(kv, entry.digest)
        yield* set
        yield* clearMarker(kv, entry.digest)
      } else {
        yield* set
        yield* settleMarker(kv, entry)
      }
    }),
    get: Effect.fn("Journal.get")(function*(digest: Digest) {
      return yield* readEntry(kv, digest)
    }),
    listUnresolved: readUnmarked(kv).pipe(
      Effect.map((entries) => [...entries].sort(oldestFirst)),
      Effect.withSpan("Journal.listUnresolved")
    )
  }
}

/**
 * Deletes every **settled** entry (`Executed`, `Failed`, `NotApplied`) whose
 * answer was recorded strictly before `before`, and answers how many it
 * deleted. `Signed` and `Unknown` entries are never deleted, however old.
 *
 * `listUnresolved` reads only unmarked entries, but `keys` still enumerates
 * every one, and some stores pay for that in values; this is what keeps the
 * store short in a service that runs for months. It reads every entry itself
 * (it deletes nothing on the strength of a marker alone), removes each pruned
 * entry's marker before the entry, and removes markers whose entry is gone.
 * After it, `Journal.get` and `Tx.recorded` answer `None` for a pruned
 * digest, so choose `before` older than anything you still look up by digest —
 * and older than any bytes you might still hand to `Tx.submit` again, because a
 * resubmission puts a fresh `Signed` entry that a concurrent prune of the same
 * digest could delete. `Tx.build` bounds a transaction to two epochs, so a
 * cutoff of a few days is far outside that window.
 *
 * It reads the same `KeyValueStore` the journal layer was built over; pass the
 * same `prefix`. The dead `index` key a 0.3 journal kept is not touched.
 *
 * Fails with: `JournalError`, when the store cannot be listed, read or
 * written, or holds an entry that does not decode (nothing is deleted on the
 * strength of an entry it could not read).
 *
 * @example
 * ```ts
 * import { DateTime, Effect } from "effect"
 * import { pruneSettled } from "@unconfirmed/sui-effect/journal"
 *
 * const prune = Effect.gen(function*() {
 *   const now = yield* DateTime.now
 *   return yield* pruneSettled(DateTime.subtractDuration(now, "7 days"))
 * })
 * ```
 */
export const pruneSettled = Effect.fn("Journal.pruneSettled")(function*(
  before: DateTime.DateTime,
  options?: { readonly prefix?: string }
) {
  const kv = viewOf(yield* KeyValueStore.KeyValueStore, options?.prefix)
  const cutoff = DateTime.toEpochMillis(before)
  // Every entry key, read and decoded; markers, other journals' keys and a
  // 0.3 `index` key are never read.
  const { entries, settled: markers } = yield* listKeys(kv)
  const read = Arr.getSomes(
    yield* Effect.forEach(entries, (digest) => readEntry(kv, digest), { concurrency: READ_CONCURRENCY })
  )
  const settled = read.filter((entry) => !isUnresolved(entry) && stampOf(entry) < cutoff)
  // The marker first: removing one can only make a listing read more, so a
  // crash between the two leaves an unmarked settled entry, read once later.
  yield* Effect.forEach(
    settled,
    (entry) =>
      Effect.andThen(
        kv.remove(`${SETTLED}${entry.digest}`),
        kv.remove(`${ENTRY}${entry.digest}`)
      ).pipe(Effect.mapError(journalError)),
    { concurrency: READ_CONCURRENCY, discard: true }
  )
  // Markers whose entry is gone (a 0.4 prune of a store this journal marked).
  const present = new Set(entries)
  yield* Effect.forEach(
    [...markers].filter((digest) => !present.has(digest)),
    (digest) => kv.remove(`${SETTLED}${digest}`).pipe(Effect.mapError(journalError)),
    { concurrency: READ_CONCURRENCY, discard: true }
  )
  return settled.length
})

/**
 * The durable journal as a layer.
 *
 * Fails with: `JournalError` when the store cannot be read, and — with
 * `onUnresolved: "fail"` — when the store still holds entries no one has
 * settled.
 */
export const layerKeyValueStore = (
  options: JournalKeyValueStoreOptions
): Layer.Layer<never, JournalError, KeyValueStore.KeyValueStore> =>
  Layer.effect(
    Journal,
    Effect.gen(function*() {
      const store = yield* KeyValueStore.KeyValueStore
      const journal = make(
        store,
        options.prefix === undefined ? {} : { prefix: options.prefix }
      )
      const unresolved = yield* journal.listUnresolved
      if (options.onUnresolved === "fail" && unresolved.length > 0) {
        return yield* new JournalError({
          cause:
            `the journal holds ${unresolved.length} unresolved submission(s): ${
              unresolved.map((entry) => entry.digest).join(", ")
            }. Settle them with Tx.reconcileAll, or build the layer with { onUnresolved: "ignore" }.`
        })
      }
      return journal
    })
  )
