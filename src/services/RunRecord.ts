/**
 * `RunRecord`: what one run of a script put in its journal, wherever that
 * journal was provided.
 *
 * `Script.run` decides a timeout, an interrupt and the "left unresolved" lines
 * from the journal entries the program wrote. Reading a `Journal` from outside
 * the program cannot find them when the program provided its own journal
 * inside itself (`program.pipe(Effect.provide(journalLayer))`), and reading a
 * shared durable journal finds other processes' entries too. So `Tx` reports
 * every entry it writes to this reference as well as to the journal, and
 * `Script.run` provides one for the length of the run. Outside a run the
 * reference is `undefined` and reporting is a no-op.
 *
 * Internal: not part of the public surface.
 *
 * @since 0.4.0
 */
import { Context, Effect } from "effect"
import type { JournalEntry } from "../domain/journal-entry.ts"

/** The entries one run wrote, latest entry per digest. */
export interface RunRecordService {
  /** Notes an entry the run is about to write. Never fails. */
  readonly record: (entry: JournalEntry) => void
  /**
   * Withdraws a `Signed` entry whose write failed, so a submission that was
   * never sent is not reported as outstanding: the record for that digest goes
   * back to exactly what it was before that `Signed` — the earlier latest
   * entry and `signedHere` membership, or nothing when there was none. A
   * digest the run already holds as `Unknown`, `Executed` or `Failed` (a
   * re-send of the same bytes) keeps that entry. Never fails.
   */
  readonly forget: (digest: string) => void
  /** The latest entry per digest, in the order the digests first appeared. */
  readonly entries: () => ReadonlyArray<JournalEntry>
  /** The digests this run signed and journalled itself. */
  readonly signedHere: () => ReadonlySet<string>
}

/** A fresh, empty record. Never fails. */
export const makeRunRecord = (): RunRecordService => {
  const latest = new Map<string, JournalEntry>()
  const signed = new Set<string>()
  // What each digest's record was just before its latest `Signed`, so a failed
  // write can put it back rather than erase an earlier, still-true entry.
  const beforeSigned = new Map<string, { readonly entry: JournalEntry | undefined; readonly signed: boolean }>()
  return {
    record: (entry) => {
      if (entry._tag === "Signed") {
        beforeSigned.set(entry.digest, { entry: latest.get(entry.digest), signed: signed.has(entry.digest) })
        signed.add(entry.digest)
      }
      latest.set(entry.digest, entry)
    },
    forget: (digest) => {
      const before = beforeSigned.get(digest)
      beforeSigned.delete(digest)
      if (before?.entry === undefined) latest.delete(digest)
      else latest.set(digest, before.entry)
      if (before?.signed === true) signed.add(digest)
      else signed.delete(digest)
    },
    entries: () => [...latest.values()],
    signedHere: () => signed
  }
}

/** The reference `Tx` reports to. `undefined` outside `Script.run`. */
export const RunRecord = Context.Reference<RunRecordService | undefined>(
  "@unconfirmed/sui-effect/internal/RunRecord",
  { defaultValue: () => undefined }
)

/** Reports one entry to the run record in force, if any. Never fails. */
export const recordEntry = (entry: JournalEntry): Effect.Effect<void> =>
  Effect.flatMap(RunRecord, (run) => Effect.sync(() => run?.record(entry)))

/** Withdraws a `Signed` entry whose write failed. Never fails. */
export const forgetEntry = (digest: string): Effect.Effect<void> =>
  Effect.flatMap(RunRecord, (run) => Effect.sync(() => run?.forget(digest)))
