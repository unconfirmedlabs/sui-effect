/**
 * `sui-effect/testing`: the in-memory fake and the test layers built on it.
 *
 * Nothing here touches the network. `Sui.layerTest` is the real `Sui` over the
 * fake `SuiCore`, so a test exercises the production high tier.
 *
 * @since 0.1.0
 */
import { Layer } from "effect"
import type { NetworkMismatch, TransportError } from "./domain/errors.ts"
import { Sui } from "./services/Sui.ts"
import type { FakeScript } from "./services/SuiCoreFake.ts"
import { SuiCoreFake } from "./services/SuiCoreFake.ts"

export * from "./services/SuiCoreFake.ts"

/**
 * The real `Sui` over the fake `SuiCore`, plus the fake's own handle so a test
 * can script outcomes and inspect what the fake received.
 *
 * This is `Sui.layerNoDeps`, the production layer, so the chain-id rules are
 * the production rules: a script whose `network` is `mainnet` or `testnet` must
 * report that network's identifier, and any other network asserts nothing. A
 * test that wants the assertion on a custom network builds
 * `Sui.layerNoDepsWith({ chainId })` over `SuiCoreFake.layer(script)` itself,
 * rather than having the fake compared against its own script.
 *
 * Fails with: `NetworkMismatch`, `TransportError` — both only when the script
 * asks for them.
 */
export const layerTest = (
  script: FakeScript = {}
): Layer.Layer<Sui | SuiCoreFake, NetworkMismatch | TransportError> =>
  Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCoreFake.layer(script)))
