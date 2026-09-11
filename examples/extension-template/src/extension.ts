/**
 * The Promise face, derived rather than maintained.
 *
 * `SuiExtension.fromService` walks the service interface once: `Effect` members
 * become Promise methods, `Stream` members become `AsyncIterable`s, nested
 * namespaces are mapped recursively, plain values pass through, and a rejection
 * is the same tagged error instance an Effect caller would have caught, so a
 * Promise consumer can still switch on `_tag`.
 *
 * There is no second implementation to keep in step, which is the whole point.
 */
import { SuiExtension } from "sui-effect/extension"
import type { EscrowOptions } from "./Escrow.ts"
import { Escrow } from "./Escrow.ts"

/** What a `$extend` registration needs beyond what the layer does. */
export interface EscrowRegistrationOptions extends EscrowOptions {
  /**
   * The chain identifier the node must be on, as `getChainIdentifier` reports
   * it.
   *
   * **Required on `devnet`, `localnet` and any custom network**, because a
   * `warm` registration takes the chain id rather than asking for it and there
   * is no built-in entry for those; `register` throws without it. On `mainnet`
   * and `testnet` the built-in table answers and this is optional.
   *
   * Give the same id to **every** registration on one client. The base `Sui`,
   * its transport and its sender-lock map are shared per client **per chain
   * id**, so two registrations that disagree get two of everything and two
   * `Tx.run`s for one address stop serializing.
   */
  readonly chainId?: string
}

/**
 * The registration a Promise consumer passes to `client.$extend(...)`.
 *
 * ```ts
 * const client = new SuiGrpcClient({ network: "testnet", baseUrl }).$extend(escrow(options))
 * const info = await client.escrow.get(id)
 * for await (const item of client.escrow.owned.stream(owner)) console.log(item.id)
 * await client.escrow.dispose()
 * ```
 *
 * It is registered `warm`, like `platform` in `Platform.ts`: the service has
 * synchronous members — `packageId`, the `claim` recipe fragment, the codecs —
 * and a consumer that reads one the moment it registers should get the value
 * rather than a placeholder that throws `ExtensionNotReady`. Neither layer
 * touches the network at build, which is what `warm` requires.
 *
 * The runtime is built inside `register`, over `SuiCore.layerFromClient(client)`,
 * a `Sui` pinned to `options.chainId` and `Escrow.layer`, so the extension and
 * the consumer share one transport, one chain identity and one sender-lock map.
 *
 * Throws out of `register` when the network has no built-in chain identifier
 * and `options.chainId` was not given.
 */
export const escrow = (options: EscrowRegistrationOptions) =>
  SuiExtension.fromService(Escrow, {
    name: "escrow",
    layer: Escrow.layer(options),
    warm: options.chainId === undefined ? {} : { chainId: options.chainId }
  })
