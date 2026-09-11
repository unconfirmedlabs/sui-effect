/**
 * The durable `Journal`, over `KeyValueStore` from `effect/unstable/persistence`.
 *
 * This is the only file in the package that imports `effect/unstable/*`, and it
 * is reachable only through the `sui-effect/journal` subpath, so the core
 * modules stay on stable Effect.
 *
 * Building the layer does no network work: it reads the index of unresolved
 * entries and, when asked to, refuses to start while any are outstanding. What
 * to do about them is `Tx.reconcileAll`, which an application calls explicitly.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Option, Schema, Semaphore } from "effect"
import { KeyValueStore } from "effect/unstable/persistence"
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
const INDEX = "index"

const Index = Schema.Array(Schema.String)

const decodeIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(Index))
const encodeIndex = Schema.encodeEffect(Schema.fromJsonString(Index))
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(JournalEntry))
const encodeEntry = Schema.encodeEffect(Schema.fromJsonString(JournalEntry))

const journalError = (cause: unknown): JournalError => new JournalError({ cause })

/**
 * The `put` semaphores, one per key prefix, at **module** level.
 *
 * Two `make` calls over the same store and prefix — two layer instances in one
 * process, a test that builds the journal twice — used to get a semaphore each
 * and could interleave their index read-modify-writes, losing one of the two
 * digests. Keying the permit by prefix rather than by instance is what makes
 * the serialization a property of the store's keyspace instead of a property of
 * whoever happened to build the journal.
 *
 * **This is in-process only, and that is a documented limitation.** Two
 * processes over one store (two pods, a script beside the service) still race:
 * `KeyValueStore` offers no compare-and-set, so there is nothing to build a
 * cross-process lock on. Run one writer per store prefix. A storage-level lock
 * is deferred (DESIGN §8, §15).
 */
const PUT_LOCKS = new Map<string, Semaphore.Semaphore>()

const putLock = (prefix: string): Semaphore.Semaphore => {
  const existing = PUT_LOCKS.get(prefix)
  if (existing !== undefined) return existing
  const created = Semaphore.makeUnsafe(1)
  PUT_LOCKS.set(prefix, created)
  return created
}

/**
 * A journal backed by a `KeyValueStore`.
 *
 * The store has no key enumeration, so the journal keeps its own index: one
 * key holding the digests of the entries that are still unresolved, rewritten
 * whenever an entry is put. A terminal entry (`Executed`, `Failed`,
 * `NotApplied`) drops its digest from the index and keeps the entry itself, so
 * a later `get` still finds the answer.
 *
 * `put` is serialized by a semaphore of one permit held across **both** writes,
 * because the index write is a read-modify-write over a store that offers no
 * compare-and-set: two concurrent `Tx.run`s from different senders would
 * otherwise each read the same index, each append their own digest, and the
 * second write would drop the first. The semaphore is keyed by the store prefix
 * at module level, so two journals built over one prefix share it.
 *
 * **The order of the two writes depends on which way a crash between them is
 * survivable:**
 *
 * - an **unresolved** entry (`Signed`, `Unknown`) writes the **index first**, so
 *   a crash leaves a digest whose entry is missing — `listUnresolved` skips it —
 *   rather than an entry nothing points at;
 * - a **terminal** entry (`Executed`, `Failed`, `NotApplied`) writes the
 *   **entry first** and only then drops the digest from the index, so a crash
 *   leaves the digest still indexed with its terminal answer already stored:
 *   `listUnresolved` reads the entry, sees it is resolved, and skips it. Doing
 *   it the other way round is how a settled transaction reverted to the stale
 *   `Signed` entry that startup recovery could no longer find.
 *
 * Every member fails with `JournalError` and nothing else.
 */
export const make = (
  store: KeyValueStore.KeyValueStore,
  options?: { readonly prefix?: string }
): JournalService => {
  const kv = options?.prefix === undefined
    ? store
    : KeyValueStore.prefix(store, options.prefix)

  const readIndex = Effect.gen(function*() {
    const raw = yield* kv.get(INDEX).pipe(Effect.mapError(journalError))
    if (raw === undefined) return [] as ReadonlyArray<string>
    return yield* decodeIndex(raw).pipe(Effect.mapError(journalError))
  })

  const writeIndex = (digests: ReadonlyArray<string>) =>
    encodeIndex(digests).pipe(
      Effect.mapError(journalError),
      Effect.flatMap((json) => kv.set(INDEX, json).pipe(Effect.mapError(journalError)))
    )

  const get = Effect.fn("Journal.get")(function*(digest: Digest) {
    const raw = yield* kv.get(`${ENTRY}${digest}`).pipe(Effect.mapError(journalError))
    if (raw === undefined) return Option.none<JournalEntry>()
    const entry = yield* decodeEntry(raw).pipe(Effect.mapError(journalError))
    return Option.some(entry)
  })

  // One permit per store prefix, held across the index read-modify-write and
  // the entry write.
  const writes = putLock(options?.prefix ?? "")

  return {
    put: Effect.fn("Journal.put")(function*(entry: JournalEntry) {
      yield* Semaphore.withPermits(writes, 1)(
        Effect.gen(function*() {
          const json = yield* encodeEntry(entry).pipe(Effect.mapError(journalError))
          const writeEntry = kv.set(`${ENTRY}${entry.digest}`, json).pipe(
            Effect.mapError(journalError)
          )
          const index = yield* readIndex
          const without = index.filter((digest) => digest !== entry.digest)
          if (isUnresolved(entry)) {
            yield* writeIndex([...without, entry.digest])
            yield* writeEntry
            return
          }
          // Terminal: the answer is durable before the digest stops being
          // indexed, so a crash in between can only leave a resolved entry
          // still listed, which `listUnresolved` filters out.
          yield* writeEntry
          if (without.length !== index.length) yield* writeIndex(without)
        })
      )
    }),
    get,
    listUnresolved: Effect.gen(function*() {
      const index = yield* readIndex
      const entries: Array<JournalEntry> = []
      for (const digest of index) {
        const entry = yield* get(digest as Digest)
        if (Option.isSome(entry) && isUnresolved(entry.value)) entries.push(entry.value)
      }
      return entries
    }).pipe(Effect.withSpan("Journal.listUnresolved"))
  }
}

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
