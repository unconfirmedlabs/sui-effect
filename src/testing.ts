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
 * Fails with: `NetworkMismatch`, `TransportError` — both only when the script
 * asks for them.
 */
export const layerTest = (
  script: FakeScript = {}
): Layer.Layer<Sui | SuiCoreFake, NetworkMismatch | TransportError> => {
  const fake = SuiCoreFake.layer(script)
  return Sui.layerNoDepsWith(
    script.chainId === undefined ? {} : { chainId: script.chainId }
  ).pipe(Layer.provideMerge(fake))
}
