/**
 * `SubmitConfig`: the knobs of the transaction lifecycle, as a
 * `Context.Reference` so every default is in force with no setup and any of
 * them can be overridden for one fiber.
 *
 * @since 0.1.0
 */
import { Context, Duration, Random, Schedule } from "effect"
import type { Effect } from "effect"
import type { PolicyDenied } from "../domain/errors.ts"
import type { Mist, Simulation } from "../domain/schemas.ts"
import { U32_MAX } from "../domain/schemas.ts"

/** How `Tx.build` sets an expiration when the recipe left one unset. */
export type ExpirationPolicy = "validDuring" | "epoch" | "none"

/**
 * Whether `Tx.reconcile` is allowed to conclude that an expiration window
 * closed on a transaction the node does not know.
 *
 * `"epochThenMiss"` is the default and the only rule that produces
 * `NotApplied { evidence: "expired" }`: the epoch (or timestamp) bound must be
 * observed as passed, then `getTransaction` must miss, then — after
 * `SubmitConfig.reconcileRecheck` — both must hold again. A single observation
 * proves nothing, because a transaction can execute between the lookup and the
 * expiry check, and a node behind a load balancer can serve an epoch from one
 * replica and a transaction index from another.
 *
 * `"never"` disables the rule outright, so an expiration window is never
 * evidence and an unknown transaction stays `SubmissionUnknown`. That is the
 * setting for a deployment behind a mixed-node load balancer, where even the
 * repeated observation can be answered by two different nodes.
 *
 * **Residual risk, even on `"epochThenMiss"`:** a node whose transaction index
 * lags its epoch view can report the new epoch and miss a transaction it has in
 * fact executed, twice in a row. The recheck delay makes that unlikely, not
 * impossible; a deployment that cannot tolerate it sets `"never"` and settles
 * unknown submissions by hand.
 */
export type ExpiryEvidencePolicy = "epochThenMiss" | "never"

/** Every decision `Tx.build`, `Tx.submit` and `Tx.reconcile` read from context. */
export interface SubmitConfigService {
  /**
   * The expiration `Tx.build` sets when the recipe set none.
   *
   * `"validDuring"` bounds the transaction to the current epoch and the next,
   * and names the chain: it is the only one that both satisfies the validator
   * rule (a transaction must have address-owned inputs *or* an expiration of at
   * most two epochs) and stops bytes signed for one chain from landing on
   * another. It costs one `getCurrentSystemState` read per build.
   * `"epoch"` costs the same read and carries no chain guard. `"none"` leaves
   * the transaction valid forever, which makes
   * `NotApplied { evidence: "expired" }` unreachable.
   */
  readonly expiration: ExpirationPolicy
  /**
   * An **additional** wall-clock bound on a `"validDuring"` expiration, as
   * `maxTimestamp`.
   *
   * Unset by default, because no Sui network accepts one yet: a devnet node on
   * protocol 100 refuses any transaction carrying a timestamp bound with
   * `Feature is not supported: Timestamp-based transaction expiration is not
   * yet supported`, whether or not epochs are set alongside it. Setting this
   * produces bytes the current protocol rejects at build time; it is here so
   * that a network which does support them needs no new API, and so that
   * `Tx.reconcile`'s wall-clock expiry rule has something to read.
   */
  readonly validFor?: Duration.Duration
  /**
   * The largest gas budget `Tx.build` will accept. The budget itself is chosen
   * by the node's simulation during build; this is the ceiling above which
   * building fails with `BuildError` rather than signing an expensive mistake.
   */
  readonly maxGasBudget: Mist
  /**
   * An extra simulate before signing, and the place spend limits and target
   * policies plug in. It fails with `PolicyDenied` and nothing else, so
   * `Tx.run` stays typed.
   */
  readonly preflight?: (simulation: Simulation) => Effect.Effect<void, PolicyDenied>
  /** Whether `Tx.run` holds the sender lock from build through submit. */
  readonly lockSender: boolean
  /**
   * How `Tx.submit` re-sends the identical bytes after a retryable transport
   * failure or a timeout. It never rebuilds, so a retry can only ever land the
   * transaction the caller already signed.
   */
  readonly resubmit: Schedule.Schedule<unknown>
  /** How many times `Tx.submit` sends the bytes in total, the first try included. */
  readonly resubmitAttempts: number
  /**
   * How long one `executeTransaction` may take before `Tx.submit` treats it as
   * a retryable transport failure. A timeout is the case `Tx.submit` exists
   * for: the bytes may well have reached the network.
   */
  readonly executeTimeout: Duration.Duration
  /**
   * How far `chainTime` must pass a transaction's recorded `maxTimestamp`
   * before `Tx.reconcile` is willing to call it `NotApplied`. It covers the
   * skew between the node's clock, the Clock object and the validators.
   *
   * It applies to the wall-clock rule only. The epoch rule needs no margin:
   * an epoch is a consensus fact, not a reading of a clock, so once the
   * current epoch is past a transaction's `maxEpoch` it is simply over.
   */
  readonly expiryMargin: Duration.Duration
  /**
   * Whether a closed expiration window may be evidence at all, and under which
   * rule. See {@link ExpiryEvidencePolicy}. Defaults to `"epochThenMiss"`.
   */
  readonly expiryEvidence: ExpiryEvidencePolicy
  /**
   * How long `Tx.reconcile` waits between the first observation of a closed
   * expiration window and the second one it needs before it will answer
   * `NotApplied { evidence: "expired" }`.
   *
   * It is a `Clock` sleep, so a test drives it with `TestClock` and a test that
   * does not care sets it to zero.
   */
  readonly reconcileRecheck: Duration.Duration
  /**
   * Whether `Tx.submit` waits for a successful execution to become visible to
   * reads before it returns and releases the sender lock. Defaults to `true`.
   */
  readonly awaitVisibility: boolean
  /**
   * How long that wait may take. A wait that times out or fails **never**
   * changes the outcome: the transaction executed, and `Tx.submit` returns the
   * `Executed` it already has after logging the failure.
   */
  readonly visibilityTimeout: Duration.Duration
  /**
   * The nonce `Tx.build` stamps on a default `ValidDuring` expiration, which is
   * what makes two otherwise identical transactions from one address in one
   * epoch different bytes with different digests.
   *
   * The default draws a `u32` from Effect's `Random`, which is process-local
   * and does not survive a restart: independent 32-bit draws collide with
   * probability about 1.16% after ten thousand such transactions. **A collision
   * is not a second execution.** Identical bytes have one digest and one
   * journal key, so the second build is the same transaction as the first; the
   * failure mode is a transaction that cannot be sent again because the first
   * one already occupied its digest, not a duplicated intent.
   *
   * Supply a monotonic allocator when that matters — a counter in the same
   * store the journal uses, an id service, anything that survives a restart:
   * `nonce: Effect.map(counter.next, (n) => n % 4_294_967_296)`. The value must
   * be an integer in `[0, 2^32)`; anything else fails the build with
   * `BuildError`. A journal-backed allocator is deferred (DESIGN §15).
   */
  readonly nonce: Effect.Effect<number>
}

/** The spec's defaults, in force whenever nothing overrides them. */
export const defaults: SubmitConfigService = {
  expiration: "validDuring",
  // The protocol's own maximum gas budget (50 SUI). Lower it to cap spend.
  maxGasBudget: 50_000_000_000n as Mist,
  lockSender: true,
  resubmit: Schedule.min([
    Schedule.exponential("250 millis"),
    Schedule.spaced("30 seconds")
  ]).pipe(Schedule.jittered),
  resubmitAttempts: 5,
  executeTimeout: Duration.seconds(60),
  expiryMargin: Duration.seconds(30),
  expiryEvidence: "epochThenMiss",
  reconcileRecheck: Duration.seconds(2),
  awaitVisibility: true,
  visibilityTimeout: Duration.seconds(15),
  nonce: Random.nextIntBetween(0, U32_MAX)
}

/**
 * The lifecycle settings.
 *
 * Because this is a `Context.Reference` and not a service, it never appears in
 * an `R`: a one-shot script gets the defaults with no wiring, and an
 * application overrides what it cares about with
 * `Effect.provideService(effect, SubmitConfig, { ...SubmitConfig.defaults, validFor: "30 seconds" })`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SubmitConfig } from "@unconfirmed/sui-effect/tx"
 *
 * const strict = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
 *   Effect.provideService(effect, SubmitConfig, {
 *     ...SubmitConfig.defaults,
 *     maxGasBudget: 100_000_000n as typeof SubmitConfig.defaults.maxGasBudget
 *   })
 * ```
 */
export const SubmitConfig = Object.assign(
  Context.Reference<SubmitConfigService>("@unconfirmed/sui-effect/SubmitConfig", {
    defaultValue: () => defaults
  }),
  { defaults }
)
