/**
 * `Gate`: the policy `Tx.verify` applies to a declared intent, and the semantic
 * screen it asks, as a `Context.Reference` so it never appears in an `R`.
 *
 * The default has no screen: the claims are still checked exactly, in code, and
 * the verdict says `Unscreened`. A screen is an opinion in probabilities about
 * sentences; every decision made from it is a threshold here, so the judgment
 * stays in code that a test can drive. `@unconfirmed/sui-effect/gate` provides
 * the screen that asks TypeSafe's Jev.
 *
 * @since 0.5.0
 */
import { Context, Effect, Layer } from "effect"
import type { TransportError } from "../domain/errors.ts"
import type { Intent, Screening } from "../domain/intent.ts"

/**
 * What a screen is shown: the sentence, and both things it is compared with.
 *
 * @since 0.5.0
 */
export interface ScreenRequest {
  readonly intent: Intent
  /** `describeEffects` of the simulation. Never empty. */
  readonly effects: ReadonlyArray<string>
  /** `describeClaims` of the intent. Empty when it claims nothing. */
  readonly claims: ReadonlyArray<string>
}

/**
 * Every decision `Tx.verify` and `Tx.run` read from context about intents.
 *
 * @since 0.5.0
 */
export interface GateService {
  /**
   * The semantic screen. It answers in probabilities and decides nothing.
   *
   * Fails with: `TransportError`, which is what {@link GateService.onUnavailable}
   * is about.
   */
  readonly screen?: (request: ScreenRequest) => Effect.Effect<Screening, TransportError>
  /**
   * Whether `Tx.run` refuses a transaction that declares no intent, with
   * `PolicyDenied { rule: "intent.required" }`, before it builds anything.
   * Off by default; on is the setting for a wallet an agent drives. It binds
   * `Tx.run` only: the explicit lifecycle (`Tx.build`, `Tx.sign`, `Tx.submit`)
   * is not gated, and a caller assembling it calls `Tx.verify` itself.
   */
  readonly requireIntent: boolean
  /**
   * What a screen that could not answer means. `"deny"` refuses the transaction
   * with `PolicyDenied { rule: "gate.unavailable" }`: a gate that was configured
   * and is down is not a gate that passed. `"unscreened"` lets the claims check
   * stand alone and records why on the verdict.
   */
  readonly onUnavailable: "deny" | "unscreened"
  /** An effect line the summary covers with less probability than this is refused. */
  readonly minEffectInScope: number
  /** A claim line the summary has less use for than this is refused. */
  readonly minClaimInScope: number
  /** A summary less specific than this (0 to 2) covers nothing and is refused. */
  readonly minSpecificity: number
  /** A summary more likely than this to be addressing the screen is refused. */
  readonly maxInjection: number
}

/**
 * The defaults, in force whenever nothing overrides them.
 *
 * @since 0.5.0
 */
export const defaults: GateService = {
  requireIntent: false,
  onUnavailable: "deny",
  minEffectInScope: 0.5,
  minClaimInScope: 0.25,
  minSpecificity: 1,
  maxInjection: 0.5
}

const GateRef = Context.Reference<GateService>("@unconfirmed/sui-effect/Gate", {
  defaultValue: () => defaults
})

/**
 * A `Layer` that puts {@link defaults} in force with `overrides` applied.
 *
 * Never fails, requires nothing.
 *
 * @example
 * ```ts
 * import { Gate } from "@unconfirmed/sui-effect/tx"
 *
 * const agentWallet = Gate.layer({ requireIntent: true })
 * ```
 */
const layer = (overrides: Partial<GateService>): Layer.Layer<never> =>
  Layer.sync(GateRef, () => ({ ...defaults, ...overrides }))

/**
 * The gate **already in force** with `overrides` applied, provided to one
 * effect.
 *
 * Like `SubmitConfig.with`, this merges over the current value rather than
 * over {@link defaults}: the screen is a field here, and loosening one
 * threshold for one submission must not silently drop the screen a layer
 * provided.
 *
 * Never fails, requires nothing.
 */
const withOverrides =
  (overrides: Partial<GateService>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.updateService(effect, GateRef, (inForce) => ({ ...inForce, ...overrides }))

/**
 * The intent policy and its screen.
 *
 * Because this is a `Context.Reference`, `Tx.verify` keeps `R = Sui`: with
 * nothing provided the claims are checked and the verdict is `Unscreened`.
 * `Gate.layer(overrides)` spreads {@link defaults}; `Gate.with(overrides)`
 * merges over the gate in force.
 *
 * @since 0.5.0
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Gate } from "@unconfirmed/sui-effect/tx"
 *
 * declare const submission: Effect.Effect<void>
 *
 * const lenient = submission.pipe(Gate.with({ onUnavailable: "unscreened" }))
 * ```
 */
export const Gate = Object.assign(GateRef, {
  defaults,
  layer,
  with: withOverrides
})
