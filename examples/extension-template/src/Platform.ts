/**
 * Composing extensions: one package that builds on another.
 *
 * A platform SDK is rarely one Move package. It is a service per package plus a
 * service on top that consumers actually hold, and the top one exposes the
 * others as namespaces (`client.platform.escrow.get(id)`) rather than making a
 * consumer register three extensions and remember which is which.
 *
 * Two rules make that work, and both are visible below.
 */
import { Context, Effect, Layer } from "effect"
import type { ChangedRef, ObjectId, Sui } from "@unconfirmed/sui-effect"
import { SuiExtension } from "@unconfirmed/sui-effect/extension"
import type { Signer } from "@unconfirmed/sui-effect/tx"
import { Escrow } from "./Escrow.ts"
import type { ClaimForError, EscrowOptions, EscrowService } from "./Escrow.ts"

/** What a consumer of the platform holds. */
export interface PlatformService {
  /**
   * The escrow package's whole surface, as a namespace.
   *
   * It is the dependency service's own object, unchanged: no wrapper methods to
   * keep in step, and the Promise face maps it recursively, so
   * `client.platform.escrow.get(id)` works for a Promise consumer exactly as
   * `platform.escrow.get(id)` does for an Effect one.
   */
  readonly escrow: EscrowService
  /**
   * One operation that spans the packages this platform composes.
   *
   * The error union is the composition's: this package's own errors plus
   * whatever the packages underneath declare. Nothing is swallowed and nothing
   * is widened.
   *
   * Fails with: `EscrowNotFound`, `EscrowSettlementUnknown`, `DecodeError`,
   * `UnexpectedEffects`, and everything `Tx.run` declares.
   */
  readonly claimEverything: (
    ids: ReadonlyArray<ObjectId>,
    opts: { readonly signer: Signer }
  ) => Effect.Effect<ReadonlyArray<ChangedRef>, ClaimForError>
}

/** What the platform needs to build the packages it composes. */
export interface PlatformOptions extends EscrowOptions {}

/** What a `$extend` registration of the platform needs beyond its layer. */
export interface PlatformRegistrationOptions extends PlatformOptions {
  /**
   * The chain identifier the node must be on. Required on `devnet`, `localnet`
   * and any custom network, and **the same id every other registration on this
   * client is given**: the base `Sui` and its sender-lock map are shared per
   * client per chain id.
   */
  readonly chainId?: string
}

const make: Effect.Effect<PlatformService, never, Escrow> = Effect.gen(function*() {
  // The dependency is yielded, not constructed: the layer below provides it.
  const escrow = yield* Escrow
  return {
    escrow,
    claimEverything: Effect.fn("Platform.claimEverything")(function*(
      ids: ReadonlyArray<ObjectId>,
      opts: { readonly signer: Signer }
    ) {
      const claimed: Array<ChangedRef> = []
      for (const id of ids) claimed.push(yield* escrow.claimFor(id, opts))
      return claimed
    })
  }
})

/**
 * The platform service.
 *
 * The identifier is this package's, not the dependency's: two services in one
 * package is exactly the case the "one service per package" rule allows for,
 * because the second one is the composition.
 */
export class Platform extends Context.Service<Platform, PlatformService>()(
  "example-extension/Platform"
) {
  /**
   * The live layer.
   *
   * **`Layer.provide(Escrow.layer(...))` is the point.** `Platform`'s own
   * construction requires `Escrow`; providing it here means the layer this
   * returns requires only `Sui`, which is the bound
   * `SuiExtension.fromService` can satisfy from the consumer's client. An
   * extension's own dependencies are provided inside its layer — the consumer
   * never learns they exist.
   *
   * Never fails.
   */
  static readonly layer = (options: PlatformOptions): Layer.Layer<Platform, never, Sui> =>
    Layer.effect(Platform, make).pipe(Layer.provide(Escrow.layer(options)))

  /**
   * The same composition over the dependency's test layer, which is the real
   * `Escrow` over its in-memory settlement service. Never fails.
   */
  static readonly layerTest = (
    state: { readonly settled?: boolean } = {}
  ): Layer.Layer<Platform, never, Sui> =>
    Layer.effect(Platform, make).pipe(Layer.provide(Escrow.layerTest(state)))
}

/**
 * The registration a Promise consumer passes to `client.$extend(...)`.
 *
 * `warm` is given because the composed surface has synchronous members — the
 * escrow package's `packageId` and its `claim` recipe fragment — and a consumer
 * that reads one the moment it registers should get the value, not a
 * placeholder. Neither layer touches the network at build, which is what `warm`
 * requires.
 *
 * `options.chainId` is threaded through rather than left to the built-in table,
 * so this works on `devnet` and `localnet` too — and so it matches what
 * `escrow(...)` in `extension.ts` is given. Two registrations on one client
 * that name the same chain id share one `Sui`, one transport and one
 * sender-lock map; two that disagree share nothing.
 *
 * ```ts
 * const client = new SuiGrpcClient({ network: "testnet", baseUrl }).$extend(platform(options))
 * const escrow = await client.platform.escrow.get(id)
 * const recipe = client.platform.escrow.claim(escrow)
 * ```
 */
export const platform = (options: PlatformRegistrationOptions) =>
  SuiExtension.fromService(Platform, {
    name: "platform",
    layer: Platform.layer(options),
    warm: options.chainId === undefined ? {} : { chainId: options.chainId }
  })
