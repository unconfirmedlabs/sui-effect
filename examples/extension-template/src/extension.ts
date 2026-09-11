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
 * `register(client)` does no work until the first call, and then builds one
 * runtime over `SuiCore.layerFromClient(client)`, `Sui.layerNoDeps` and
 * `Escrow.layer`, so the extension and the consumer share one transport and one
 * chain-identifier check. Never fails.
 */
export const escrow = (options: EscrowOptions) =>
  SuiExtension.fromService(Escrow, { name: "escrow", layer: Escrow.layer(options) })
