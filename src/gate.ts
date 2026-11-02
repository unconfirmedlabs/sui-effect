/**
 * `@unconfirmed/sui-effect/gate`: the Jev screen for `Tx.verify`.
 *
 * Separate from `@unconfirmed/sui-effect/tx` for the reason
 * `@unconfirmed/sui-effect/journal` is (which imports `effect/persistence`):
 * it is the only part of the package that imports `effect/http`
 * (`HttpClient`), and an application whose intents are checked by claims alone
 * should not load it. `Intent`, `Verified`, `Tx.verify` and the `Gate`
 * reference itself are in `@unconfirmed/sui-effect/tx`.
 *
 * The `Gate` re-exported here is the very same reference `@unconfirmed/sui-effect/tx`
 * exports, so what a layer provides and what `Tx.verify` reads are the same key.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { FetchHttpClient } from "effect/http"
 * import { layerJevConfig } from "@unconfirmed/sui-effect/gate"
 *
 * const gate = layerJevConfig({ requireIntent: true }).pipe(
 *   Layer.provide(FetchHttpClient.layer)
 * )
 * ```
 *
 * @since 0.5.0
 */
export type { GateService, ScreenRequest } from "./services/Gate.ts"
export type { JevOptions } from "./services/GateJev.ts"

/** The same `Gate` reference `@unconfirmed/sui-effect/tx` exports, unmodified. */
export { Gate } from "./services/Gate.ts"

/** Jev as the screen: over explicit options, from the environment, or built by hand. */
export { layerJev, layerJevConfig, makeJev } from "./services/GateJev.ts"
