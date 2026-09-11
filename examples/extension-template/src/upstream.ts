/**
 * A stand-in for the third-party Promise package an extension wraps.
 *
 * In a real extension this file does not exist: it is an `import` of the
 * upstream SDK (`@some-org/escrow-sdk`), and everything below is its surface.
 * It is here so the guide's "wrapping an upstream Promise package" section has
 * real code to point at: one helper that needs the SDK client object, and one
 * that does not.
 *
 * Note what it is not: it is not exported from `src/index.ts`. Upstream types
 * never reach a consumer of this package; they are narrowed to sui-effect
 * schemas first.
 */
import type { ClientWithCoreApi } from "@mysten/sui/client"

/** What the operator's settlement service answers with. Untyped on purpose: upstream JSON. */
export interface SettlementResponse {
  readonly status: string
  readonly [key: string]: unknown
}

/** The upstream client surface. */
export interface SettlementApi {
  /**
   * Tells the operator that a claim landed. Needs no Sui client: a pure
   * Promise helper, which is the `Effect.tryPromise` case.
   */
  readonly notifyClaim: (
    input: { readonly escrowId: string; readonly digest: string },
    signal?: AbortSignal
  ) => Promise<SettlementResponse>
  /**
   * Reads the fee collector the package was published with. Needs the SDK
   * client object, which is the `SuiCore.use` case.
   */
  readonly resolveFeeCollector: (
    client: ClientWithCoreApi,
    packageId: string,
    signal?: AbortSignal
  ) => Promise<unknown>
}

/** The upstream constructor: a base URL and an API key. */
export const settlementApi = (options: {
  readonly url: string
  readonly apiKey: string
}): SettlementApi => ({
  notifyClaim: async (input, signal) => {
    const response = await fetch(`${options.url}/claims`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify(input),
      ...(signal === undefined ? {} : { signal })
    })
    if (!response.ok) throw new Error(`settlement service answered ${response.status}`)
    return await response.json() as SettlementResponse
  },
  resolveFeeCollector: async (client, packageId, signal) => {
    const { object } = await client.core.getObject({
      objectId: packageId,
      ...(signal === undefined ? {} : { signal })
    })
    const owner = object.owner
    return owner.$kind === "AddressOwner" ? owner.AddressOwner : null
  }
})
