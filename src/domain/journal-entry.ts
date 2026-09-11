/**
 * `JournalEntry`: the transaction lifecycle as a serializable union.
 *
 * This is the only place the lifecycle appears as a union; the abstraction a
 * program uses is the functions in `Tx`. An entry exists so that a process that
 * dies between signing and the answer can find out, when it comes back, what it
 * had already put on the wire.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { Digest, ExecutionReason, SignedTransaction } from "./schemas.ts"

/**
 * One line of the submission journal.
 *
 * `Signed` is written before the first `executeTransaction` and means the bytes
 * may be on the wire. `Executed` and `Failed` are terminal: the network
 * answered. `Unknown` means the answer never arrived and the bytes are kept so
 * `Tx.reconcile` can settle it later.
 */
export const JournalEntry = Schema.TaggedUnion({
  Signed: {
    digest: Digest,
    signed: SignedTransaction,
    signedAt: Schema.DateTimeUtcFromMillis
  },
  Executed: {
    digest: Digest,
    checkpoint: Schema.optional(Schema.BigIntFromString),
    at: Schema.DateTimeUtcFromMillis
  },
  Failed: {
    digest: Digest,
    reason: ExecutionReason,
    at: Schema.DateTimeUtcFromMillis
  },
  Unknown: {
    digest: Digest,
    signed: SignedTransaction,
    lastError: Schema.String,
    attempts: Schema.Number,
    at: Schema.DateTimeUtcFromMillis
  }
})
export type JournalEntry = typeof JournalEntry.Type

/** The tags whose entries still need an answer from the network. */
export const UNRESOLVED_TAGS = ["Signed", "Unknown"] as const

/**
 * Whether this entry is still waiting for an answer, and therefore something
 * `Tx.reconcileAll` has work to do about. Never fails.
 */
export const isUnresolved = JournalEntry.isAnyOf(UNRESOLVED_TAGS)
