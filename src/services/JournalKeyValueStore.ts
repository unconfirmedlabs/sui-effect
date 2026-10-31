/**
 * The durable `Journal`, over `KeyValueStore` from `effect/persistence`.
 *
 * This is the only file in the package that imports `effect/persistence`
 * (`@stability unstable` upstream), and it is reachable only through the
 * `sui-effect/journal` subpath, so the core modules stay on stable Effect.
 *
 * Building the layer does no network work: it lists the store's entries and,
 * when asked to, refuses to start while any are unresolved. What
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

/**
 * Every entry key under the view, read and decoded, `concurrency` at a time.
 * Anything that is not an entry key — another journal's keys when there is no
 * prefix, or the dead `index` key a 0.3 journal kept — is skipped, never read.
 */
const readAll = (kv: KeyValueStore.KeyValueStore) =>
  Effect.gen(function*() {
    const keys = yield* kv.keys.pipe(Effect.mapError(journalError))
    const read = yield* Effect.forEach(
      keys.filter((key) => key.startsWith(ENTRY)),
      (key) =>
        kv.get(key).pipe(
          Effect.mapError(journalError),
          Effect.flatMap((raw) =>
            raw === undefined
              // Removed between `keys` and `get`: nothing to report.
              ? Effect.succeed(Option.none<JournalEntry>())
              : decodeEntry(raw).pipe(Effect.mapError(journalError), Effect.map(Option.some))
          )
        ),
      { concurrency: READ_CONCURRENCY }
    )
    return Arr.getSomes(read)
  })

/**
 * A journal backed by a `KeyValueStore`.
 *
 * Each entry is one key, `entry:<digest>`, holding the entry as JSON, and a
 * `put` is one `set` of that key. A terminal entry (`Executed`, `Failed`,
 * `NotApplied`) overwrites the unresolved one and stays, so a later `get`
 * still finds the answer.
 *
 * There is no index and no lock. `listUnresolved` enumerates the store with
 * `KeyValueStore.keys`, so the only thing a `put` writes is the entry itself:
 * no read-modify-write, nothing for two writers — two fibers, two layer
 * instances, two processes over one store — to lose between them, and no
 * crash between two writes to order around. Two writers that put the **same**
 * digest at once still race, and the last `set` wins; the lifecycle never does
 * that, because one submission is one fiber.
 *
 * **The cost is a scan.** `listUnresolved` reads every entry under the prefix,
 * terminal ones included (`keys` is O(n) in the prefix, and each entry is one
 * `get`, eight at a time). A journal that keeps every settled entry forever
 * makes startup recovery slower without bound; {@link pruneSettled} is how a
 * long-lived service keeps it short.
 *
 * A store written by 0.3 or earlier also holds an `index` key, and reading
 * such a store needs no migration: the key is dead data here — never read,
 * never rewritten, never an error — left in place and no longer maintained.
 * **Rolling back to 0.3 is therefore not safe as is.** 0.3 lists unresolved
 * entries only through that index, so a `Signed` or `Unknown` entry this
 * journal wrote is invisible to a 0.3 `listUnresolved`, `Tx.reconcileAll` and
 * `onUnresolved: "fail"` (only `Tx.recorded(digest)` finds it), and a 0.3
 * reader cannot decode a `NotApplied { evidence: "refused" }` entry at all.
 * Before rolling back, or while 0.3 and 0.4 processes share a store, drain it
 * with `Tx.reconcileAll()` on 0.4 (or settle the entries by hand) and delete
 * the `"refused"` entries.
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
      yield* kv.set(`${ENTRY}${entry.digest}`, json).pipe(Effect.mapError(journalError))
    }),
    get: Effect.fn("Journal.get")(function*(digest: Digest) {
      const raw = yield* kv.get(`${ENTRY}${digest}`).pipe(Effect.mapError(journalError))
      if (raw === undefined) return Option.none<JournalEntry>()
      const entry = yield* decodeEntry(raw).pipe(Effect.mapError(journalError))
      return Option.some(entry)
    }),
    listUnresolved: readAll(kv).pipe(
      Effect.map((entries) => entries.filter(isUnresolved).sort(oldestFirst)),
      Effect.withSpan("Journal.listUnresolved")
    )
  }
}

/**
 * Deletes every **settled** entry (`Executed`, `Failed`, `NotApplied`) whose
 * answer was recorded strictly before `before`, and answers how many it
 * deleted. `Signed` and `Unknown` entries are never deleted, however old.
 *
 * This is what keeps {@link make}'s scan short in a service that runs for
 * months. After it, `Journal.get` and `Tx.recorded` answer `None` for a pruned
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
  const settled = (yield* readAll(kv)).filter((entry) =>
    !isUnresolved(entry) && stampOf(entry) < cutoff
  )
  yield* Effect.forEach(
    settled,
    (entry) => kv.remove(`${ENTRY}${entry.digest}`).pipe(Effect.mapError(journalError)),
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
