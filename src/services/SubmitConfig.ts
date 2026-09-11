/**
 * `SubmitConfig`: the knobs of the transaction lifecycle, as a
 * `Context.Reference` so every default is in force with no setup and any of
 * them can be overridden for one fiber.
 *
 * @since 0.1.0
 */
import { Context, Duration, Schedule } from "effect"
import type { Effect } from "effect"
import type { PolicyDenied } from "../domain/errors.ts"
import type { Mist, Simulation } from "../domain/schemas.ts"

/** How `Tx.build` sets an expiration when the recipe left one unset. */
export type ExpirationPolicy = "validDuring" | "epoch" | "none"

/** Every decision `Tx.build`, `Tx.submit` and `Tx.reconcile` read from context. */
export interface SubmitConfigService {
  /**
   * The expiration `Tx.build` sets when the recipe set none.
   *
   * `"validDuring"` is a wall-clock bound plus the chain identifier and a
   * random nonce: it is the only one that both bounds the transaction in time
   * and stops bytes signed for one chain from landing on another.
   * `"epoch"` costs one `getCurrentSystemState` read. `"none"` leaves the
   * transaction valid forever, which makes `NotApplied { evidence: "expired" }`
   * unreachable.
   */
  readonly expiration: ExpirationPolicy
  /** How long a `"validDuring"` transaction stays valid after it is built. */
  readonly validFor: Duration.Duration
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
   */
  readonly expiryMargin: Duration.Duration
}

/** The spec's defaults, in force whenever nothing overrides them. */
export const defaults: SubmitConfigService = {
  expiration: "validDuring",
  validFor: Duration.minutes(2),
  // The protocol's own maximum gas budget (50 SUI). Lower it to cap spend.
  maxGasBudget: 50_000_000_000n as Mist,
  lockSender: true,
  resubmit: Schedule.min([
    Schedule.exponential("250 millis"),
    Schedule.spaced("30 seconds")
  ]).pipe(Schedule.jittered),
  resubmitAttempts: 5,
  executeTimeout: Duration.seconds(60),
  expiryMargin: Duration.seconds(30)
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
 * import { SubmitConfig } from "sui-effect/tx"
 *
 * const strict = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
 *   Effect.provideService(effect, SubmitConfig, {
 *     ...SubmitConfig.defaults,
 *     maxGasBudget: 100_000_000n as typeof SubmitConfig.defaults.maxGasBudget
 *   })
 * ```
 */
export const SubmitConfig = Object.assign(
  Context.Reference<SubmitConfigService>("sui-effect/SubmitConfig", {
    defaultValue: () => defaults
  }),
  { defaults }
)
