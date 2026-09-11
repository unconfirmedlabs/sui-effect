/**
 * `Journal`: what this process has put on the wire.
 *
 * A `Context.Reference` with an in-memory default, so `Journal` never appears
 * in an `R` and a one-shot script works with zero setup. For a script the
 * durable record is the signed bytes inside `SubmissionUnknown`, which
 * `SuiError.describe` prints; a long-lived application replaces the default
 * with the `KeyValueStore` journal in `sui-effect/journal`.
 *
 * @since 0.1.0
 */
import { Context, Effect, Layer, Option } from "effect"
import type { JournalError } from "../domain/errors.ts"
import { isUnresolved, JournalEntry } from "../domain/journal-entry.ts"
import type { Digest } from "../domain/schemas.ts"

/** Reading and writing the submission journal. */
export interface JournalService {
  /**
   * Records one entry, replacing any earlier entry for the same digest.
   *
   * Fails with: `JournalError`.
   */
  readonly put: (entry: JournalEntry) => Effect.Effect<void, JournalError>
  /**
   * The entry for a digest, if this journal has one.
   *
   * Fails with: `JournalError`.
   */
  readonly get: (digest: Digest) => Effect.Effect<Option.Option<JournalEntry>, JournalError>
  /**
   * Every entry still waiting for an answer (`Signed` and `Unknown`), oldest
   * first. `Tx.reconcileAll` is what a startup does with it.
   *
   * Fails with: `JournalError`.
   */
  readonly listUnresolved: Effect.Effect<ReadonlyArray<JournalEntry>, JournalError>
}

/**
 * An in-memory journal over a `Map`. Survives nothing; enough for a one-shot
 * script, a test, and any program whose crash recovery is a human reading
 * `SubmissionUnknown`.
 */
export const makeMemoryUnsafe = (): JournalService => {
  const entries = new Map<string, JournalEntry>()
  return {
    put: Effect.fn("Journal.put")(function*(entry: JournalEntry) {
      yield* Effect.sync(() => {
        entries.delete(entry.digest)
        entries.set(entry.digest, entry)
      })
    }),
    get: Effect.fn("Journal.get")(function*(digest: Digest) {
      return yield* Effect.sync(() => Option.fromNullishOr(entries.get(digest)))
    }),
    listUnresolved: Effect.sync(() => [...entries.values()].filter(isUnresolved)).pipe(
      Effect.withSpan("Journal.listUnresolved")
    )
  }
}

/** The reference itself; {@link Journal} is it with the constructors attached. */
const JournalRef = Context.Reference<JournalService>("sui-effect/Journal", {
  defaultValue: makeMemoryUnsafe
})

/**
 * The submission journal.
 *
 * Being a `Context.Reference`, it is never in an `R`: `Tx.submit` reads it from
 * context and finds the in-memory default unless something provided another.
 *
 * **The default is process-wide.** A `Context.Reference`'s default value is
 * computed once and cached on the reference itself, so every fiber that does
 * not provide one shares a single `Map` for the life of the process. That is
 * what makes a one-shot script work with zero wiring, and it is also why a
 * test that runs `Tx.submit` or `Tx.run` should provide
 * {@link Journal.layerMemory}: without it, entries from one test are visible to
 * the next, and `listUnresolved` returns other tests' submissions.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Journal } from "sui-effect/tx"
 *
 * const entries = Effect.gen(function*() {
 *   const journal = yield* Journal
 *   return yield* journal.listUnresolved
 * })
 * ```
 */
export const Journal = Object.assign(JournalRef, {
  /** A fresh in-memory journal, for a test or a process that wants its own. */
  layerMemory: Layer.sync(JournalRef, makeMemoryUnsafe),
  /** The in-memory implementation, for building one directly. */
  makeMemoryUnsafe
})

export { JournalEntry }
