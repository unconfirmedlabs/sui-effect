/**
 * `@unconfirmed/sui-effect/enoki`: Enoki zkLogin sessions as `Signer`s, and
 * Enoki-sponsored transactions through the journal.
 *
 * Every Enoki type is structural: this subpath imports nothing from
 * `@mysten/enoki`, which is therefore not a dependency of any kind. Pass the
 * application's own `EnokiClient`, `EnokiFlow` or Enoki wallet.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Enoki } from "@unconfirmed/sui-effect/enoki"
 * import { Tx } from "@unconfirmed/sui-effect/tx"
 *
 * const program = Effect.gen(function*() {
 *   const signer = yield* Enoki.fromFlow(flow, { network: "testnet" })
 *   const built = yield* Enoki.sponsor(enokiClient, recipe, { sender: signer.address })
 *   const signed = yield* Tx.sign(built, signer)
 *   return yield* Enoki.execute(enokiClient, signed)
 * })
 * ```
 *
 * @since 0.5.0
 */
export {
  Enoki,
  type EnokiClient,
  EnokiError,
  type EnokiFlow,
  execute,
  fromFlow,
  fromWallet,
  sponsor
} from "./services/Enoki.ts"
