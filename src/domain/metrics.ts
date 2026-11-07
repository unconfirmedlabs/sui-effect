/**
 * The metrics the library records, in one place.
 *
 * The **names and attribute keys are a public contract** (README, "Metrics";
 * `LLMS.md`; AGENTS.md): a dashboard is built on them, so renaming one is a
 * breaking change. The metric objects themselves are not exported from the
 * package — a program reads them through whatever exporter it installs
 * (`Metric.snapshot`, an OpenTelemetry bridge) under the registry in its
 * context, `Metric.MetricRegistry`.
 *
 * **Every attribute value is drawn from a small, closed set** — a tag, an
 * outcome, an evidence kind, a `SuiCore` method name, a transport status. A
 * digest, an address, an object id or a coin type is never an attribute: each
 * distinct value is a separate series, and a series per transaction is a
 * memory leak in the metrics backend.
 *
 * Internal: reached through `src/internal.ts` only, for tests.
 *
 * @since 0.4.0
 */
import { Duration, Effect, Metric } from "effect"
import type { NotAppliedEvidence } from "./schemas.ts"

/**
 * One `executeTransaction` attempt made by `Tx.submit` / `Tx.resubmit` (a
 * resend of the identical bytes counts again). No attributes.
 */
export const executeAttempts = Metric.counter("sui_effect_tx_execute_attempts_total", {
  description: "executeTransaction attempts made by Tx.submit and Tx.resubmit, resends included",
  incremental: true
})

/**
 * How a `Tx.submit` / `Tx.resubmit` ended, by `result`: `executed`,
 * `execution_failed`, `not_applied`, `submission_unknown`, `refused` (the
 * first send's gRPC `INVALID_ARGUMENT`, which escapes as a `TransportError`)
 * or `journal_error` (the `Signed` write failed; nothing was sent).
 */
export const submitResults = Metric.counter("sui_effect_tx_submit_total", {
  description: "Tx.submit and Tx.resubmit results, by result",
  incremental: true
})

/**
 * A send whose failure was a validator lock conflict on a pinned input
 * (`FAILED_PRECONDITION`, "already locked by a different transaction"), which
 * `Tx.submit` then reconciles with rechecks. No attributes.
 */
export const lockConflicts = Metric.counter("sui_effect_tx_lock_conflicts_total", {
  description: "Tx.submit sends that ended in a validator lock conflict on a pinned input",
  incremental: true
})

/**
 * Every reconcile answer — the one `Tx.submit` runs when its retries run out,
 * `Tx.reconcile`, `Tx.resubmit` and `Tx.reconcileAll` alike — by `result`
 * (`executed`, `execution_failed`, `not_applied`, `submission_unknown`) and,
 * for `not_applied`, `evidence` (`expired`, `inputConsumed`, `refused`).
 */
export const reconcileResults = Metric.counter("sui_effect_tx_reconcile_total", {
  description: "Reconcile answers, by result and (for not_applied) evidence",
  incremental: true
})

/**
 * How long `Tx.submit` waited for an executed transaction to become visible to
 * reads, by `result`: `visible`, `timeout` (`SubmitConfig.visibilityTimeout`
 * elapsed) or `failed` (the wait itself failed). Milliseconds.
 */
export const visibilityWait = Metric.timer("sui_effect_tx_visibility_wait", {
  description: "Time Tx.submit waited for an executed transaction to become visible, by result"
})

/**
 * How long a successful `Tx.build` took, by `simulated_by`: `sdk` (the SDK's
 * resolver simulated while building) or `explicit` (it did not, and
 * `Tx.build` ran one simulate itself). Milliseconds.
 */
export const buildDuration = Metric.timer("sui_effect_tx_build_duration", {
  description: "Duration of a successful Tx.build, by who simulated"
})

/** The gas budget, in MIST, of every successful `Tx.build`. No attributes. */
export const buildGasBudget = Metric.histogram("sui_effect_tx_build_gas_budget", {
  description: "Gas budget in MIST of each successful Tx.build",
  // 1 000 000 MIST (0.001 SUI) up by factors of four: the last finite bucket
  // is about 2.6e11 MIST, well past any budget a node will accept.
  boundaries: Metric.exponentialBoundaries({ start: 1_000_000, factor: 4, count: 10 })
})

/**
 * One retry of a retryable read failure by the `SuiCore` read policy — and by
 * `Tx.build`, which retries its resolver on the same policy under method
 * `use` — by `method` (the `SuiCore` method name) and `status` (the
 * `TransportError.status`, or `none`).
 */
export const readRetries = Metric.counter("sui_effect_core_read_retries_total", {
  description: "Retries of retryable read failures, by SuiCore method and transport status",
  incremental: true
})

/**
 * One read attempt abandoned at `SuiCoreReadOptions.requestTimeout`, by
 * `method`.
 */
export const requestTimeouts = Metric.counter("sui_effect_core_request_timeouts_total", {
  description: "Read attempts abandoned at SuiCoreReadOptions.requestTimeout, by method",
  incremental: true
})

/**
 * How long `Tx.withSenderLock` waited for a sender's permit — the time a
 * `Tx.run` spent queued behind another from the same sender. No attributes:
 * the sender is never one. Milliseconds.
 */
export const senderLockWait = Metric.timer("sui_effect_sender_lock_wait", {
  description: "Time spent waiting for a sender's lock in Tx.withSenderLock"
})

/** Adds one to a counter, under the given attributes. Never fails. */
export const increment = (
  counter: Metric.Counter<number>,
  attributes?: Metric.Metric.AttributeSet
): Effect.Effect<void> =>
  Metric.update(attributes === undefined ? counter : Metric.withAttributes(counter, attributes), 1)

/** Records one duration on a timer, under the given attributes. Never fails. */
export const recordDuration = (
  timer: Metric.Histogram<Duration.Duration>,
  duration: Duration.Duration,
  attributes?: Metric.Metric.AttributeSet
): Effect.Effect<void> =>
  Metric.update(attributes === undefined ? timer : Metric.withAttributes(timer, attributes), duration)

/** Records one value on a histogram. Never fails. */
export const observe = (histogram: Metric.Histogram<number>, value: number): Effect.Effect<void> =>
  Metric.update(histogram, value)

/** The `result` attribute value for a reconcile or submit answer's tag. */
export const resultOf = (
  tag: "Executed" | "ExecutionFailed" | "NotApplied" | "SubmissionUnknown" | "TransportError" | "JournalError"
): string => {
  switch (tag) {
    case "Executed":
      return "executed"
    case "ExecutionFailed":
      return "execution_failed"
    case "NotApplied":
      return "not_applied"
    case "SubmissionUnknown":
      return "submission_unknown"
    case "TransportError":
      return "refused"
    case "JournalError":
      return "journal_error"
  }
}

/** The attributes of one reconcile answer. */
export const reconcileAttributes = (
  tag: "Executed" | "ExecutionFailed" | "NotApplied" | "SubmissionUnknown",
  evidence?: NotAppliedEvidence
): Metric.Metric.AttributeSet =>
  evidence === undefined ? { result: resultOf(tag) } : { result: resultOf(tag), evidence }
