/**
 * The extension service.
 *
 * Everything the authoring guide asks for is in this one file: an interface
 * whose every method returns an `Effect` with a closed error union, reads
 * through `Sui`, writes through `Tx`, a recipe fragment a consumer can compose
 * with other extensions, a submit-on-behalf operation that exists because that
 * is this package's job, and three layers — `layer`, `layerConfig`, `layerTest`.
 */
import {
  Config,
  Context,
  Effect,
  Layer,
  Redacted,
  Schema,
  Stream
} from "effect"
import type { ChangedRef, Recipe, SuiObject, UnexpectedEffects } from "sui-effect"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import {
  DecodeError,
  Digest,
  ObjectId,
  StructTag,
  Sui,
  SuiAddress,
  SuiSchema,
  TransportError
} from "sui-effect"
import type { RunError, Signer } from "sui-effect/tx"
import { Tx } from "sui-effect/tx"
import { EscrowNotFound, EscrowSettlementUnknown, EscrowUnsupportedNetwork } from "./errors.ts"
import { escrowType, EscrowContent, ESCROW_PACKAGE, receiptType } from "./schema.ts"
import type { SettlementApi } from "./upstream.ts"
import { settlementApi } from "./upstream.ts"

/** The decoded content of an escrow object, inferred from the BCS bridge. */
export type EscrowFields = ReturnType<typeof EscrowContent> extends
  Schema.Codec<infer T, Uint8Array> ? T
  : never

/** An escrow object: the envelope `Sui` returns plus its decoded content. */
export type EscrowObject = SuiObject<EscrowFields>

/**
 * Everything `claimFor` can fail with, spelled once because it is long.
 *
 * `RunError` is the union `Tx.run` declares — build, preflight, signing,
 * execution, reconcile and journal failures — so an extension that submits adds
 * its own errors to it instead of repeating a dozen tags that will grow with
 * the taxonomy.
 */
export type ClaimForError =
  | EscrowNotFound
  | EscrowSettlementUnknown
  | DecodeError
  | UnexpectedEffects
  | RunError

/**
 * The escrow package, as an Effect service.
 *
 * No member returns a `Promise`, no member's error channel is `unknown`, and
 * no member takes a signer from the layer: `claimFor` is handed one.
 */
export interface EscrowService {
  /** The package this service calls into. */
  readonly packageId: string
  /**
   * The package the types this service decodes were **first** published in,
   * which is what appears inside every Move type name. It is the same as
   * `packageId` until the package is upgraded.
   */
  readonly typeOrigin: string
  /**
   * The address the package collects fees at, read through the upstream SDK.
   *
   * Fails with: `DecodeError` (the upstream answer was not an address),
   * `TransportError`.
   */
  readonly feeCollector: Effect.Effect<SuiAddress, DecodeError | TransportError>
  /**
   * Reads one escrow object and decodes its content.
   *
   * Fails with: `EscrowNotFound` (no such object, or it was deleted),
   * `DecodeError` (it is not an escrow), `TransportError`.
   */
  readonly get: (id: ObjectId) => Effect.Effect<
    EscrowObject,
    EscrowNotFound | DecodeError | TransportError
  >
  /**
   * The commands that claim one escrow, as a recipe fragment.
   *
   * This is the composable half of the package: a consumer appends it to a
   * transaction that also carries other extensions' fragments and submits once.
   * Never fails; a recipe is synchronous, and `Tx.build` reports a recipe that
   * throws as a `BuildError`.
   */
  readonly claim: (escrow: EscrowObject) => Recipe
  /**
   * Claims one escrow on the signer's behalf and tells the operator about it.
   *
   * The signer is a parameter, never a layer field. The write goes through
   * `Tx.run`, so the journal, the expiration, the sender lock and reconcile all
   * apply.
   *
   * Fails with: `EscrowNotFound`, `DecodeError`, `TransportError`,
   * `BuildError`, `SimulationFailed`, `PolicyDenied`, `SigningError`,
   * `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, `JournalError`,
   * `UnexpectedEffects` (the claim applied but produced no receipt), and
   * `EscrowSettlementUnknown` when the claim is on chain but the operator never
   * confirmed it.
   */
  readonly claimFor: (
    id: ObjectId,
    opts: { readonly signer: Signer }
  ) => Effect.Effect<ChangedRef, ClaimForError>
  /** A namespace, which the Promise face maps recursively. */
  readonly owned: {
    /**
     * Every escrow an address owns, paginated.
     *
     * Fails with: `DecodeError`, `TransportError`.
     */
    readonly stream: (
      owner: SuiAddress
    ) => Stream.Stream<EscrowObject, DecodeError | TransportError>
    /**
     * How many escrows an address owns.
     *
     * Fails with: `DecodeError`, `TransportError`.
     */
    readonly count: (
      owner: SuiAddress
    ) => Effect.Effect<number, DecodeError | TransportError>
  }
}

/** What {@link Escrow.layer} needs to know. */
export interface EscrowOptions {
  /** The published package id, which is what `moveCall` targets name. */
  readonly packageId: string
  /**
   * The type origin: the package the Move **types** were first published in,
   * which is what appears inside `pkg::escrow::Escrow`.
   *
   * Defaults to `packageId`, which is right until the package is upgraded —
   * an upgrade gives the package a new id for calls and leaves every type name
   * pointing at the original. Set it then, and codecs, owned-object filters and
   * the receipt type keep checking the type that exists.
   */
  readonly typeOrigin?: string
  /** The operator's settlement service. */
  readonly url: string
  /** The extension's own credential — never the consumer's. */
  readonly apiKey: Redacted.Redacted<string>
}

/** The shape of the settlement service's answer, narrowed before it is used. */
const SettlementStatus = Schema.Struct({
  status: Schema.Literals(["settled", "pending"])
})

const decodeSettlement = Schema.decodeUnknownEffect(SettlementStatus)
const decodeAddress = Schema.decodeUnknownEffect(SuiAddress)

const transport = (method: string) => (cause: unknown): TransportError =>
  new TransportError({ method, retryable: false, cause })

const make = (
  options: {
    readonly packageId: string
    readonly typeOrigin?: string
    readonly api: SettlementApi
  }
): Effect.Effect<EscrowService, never, Sui> =>
  Effect.gen(function*() {
    const sui = yield* Sui
    const { api, packageId } = options
    // Every type-shaped value is derived here, from the configured origin, and
    // never from the module-level constant: configuring a package id has to
    // move the codecs with it.
    const typeOrigin = options.typeOrigin ?? packageId
    const content = EscrowContent(typeOrigin)
    const receipt = receiptType(typeOrigin)
    const ownedFilter = StructTag.make(escrowType(typeOrigin))

    // `Sui` carries the `SuiCore` it was built over, so an extension reaches
    // the mechanical tier — and through `use`, the SDK client object an
    // upstream package wants — without adding `SuiCore` to its own
    // requirements.
    const feeCollector = sui.core
      .use((client, signal) => api.resolveFeeCollector(client, packageId, signal))
      .pipe(
        Effect.catchTag(
          ["ObjectNotFound", "ObjectDeleted", "ObjectUnavailable", "TransactionNotFound", "SimulationFailed"],
          (error) => Effect.fail(transport("escrow.feeCollector")(error))
        ),
        // Upstream answered with `unknown`; it becomes a sui-effect schema
        // before anything else in this package sees it. A value that does not
        // decode is a `DecodeError` and stays one: it says which boundary was
        // wrong, where `TransportError` would claim the node was unreachable.
        Effect.flatMap((raw) =>
          decodeAddress(raw).pipe(
            Effect.mapError((issue) =>
              new DecodeError({ expectedType: "SuiAddress", issue: issue.message })
            )
          )
        ),
        Effect.withSpan("Escrow.feeCollector")
      )

    const get = Effect.fn("Escrow.get")(function*(id: ObjectId) {
      return yield* sui.getObject(id, { schema: content }).pipe(
        Effect.catchTag(
          ["ObjectNotFound", "ObjectDeleted"],
          () => Effect.fail(new EscrowNotFound({ escrowId: id }))
        ),
        Effect.catchTag(
          "ObjectUnavailable",
          (error) => Effect.fail(transport("escrow.get")(error))
        )
      )
    })

    const claim = (escrow: EscrowObject): Recipe => (tx) => {
      tx.moveCall({
        target: `${packageId}::escrow::claim`,
        arguments: [tx.object(escrow.id), tx.pure.u64(escrow.content.amount)]
      })
    }

    const notify = Effect.fn("Escrow.notify")(function*(escrowId: ObjectId, digest: Digest) {
      const unknownOutcome = (message: string) =>
        new EscrowSettlementUnknown({ escrowId, digest, message })
      // A pure upstream helper: `Effect.tryPromise` with a mapping function,
      // and the signal forwarded so an interrupted claim cancels the request.
      const response = yield* Effect.tryPromise({
        try: (signal) => api.notifyClaim({ escrowId, digest }, signal),
        catch: (cause) => unknownOutcome(`the settlement service failed: ${String(cause)}`)
      })
      const settlement = yield* decodeSettlement(response).pipe(
        Effect.mapError((issue) =>
          unknownOutcome(`the settlement service answered something unreadable: ${issue.message}`)
        )
      )
      if (settlement.status !== "settled") {
        return yield* unknownOutcome("the settlement service is still holding the claim")
      }
    })

    const claimFor = Effect.fn("Escrow.claimFor")(function*(
      id: ObjectId,
      opts: { readonly signer: Signer }
    ) {
      const escrow = yield* get(id)
      const executed = yield* Tx.run(claim(escrow), { signer: opts.signer })
      // The transaction applied and gas was charged; what is missing is the
      // receipt. That is what `UnexpectedEffects` means, and `outcome` puts it
      // on "applied". Mapping it to `TransportError` would tell a wrapper the
      // opposite — nothing happened, retry — about a claim that ran.
      const created = yield* executed.expectCreated(receipt)
      yield* notify(id, executed.digest)
      return created
    // `Tx.*` requires `Sui`, and the layer has one: providing it here is what
    // keeps every member's requirement channel empty, which is what
    // `SuiExtension.fromService` and every consumer expect.
    }, Effect.provideService(Sui, sui))

    const stream = (owner: SuiAddress) =>
      sui.streamOwnedObjects(owner, { type: ownedFilter }).pipe(
        Stream.mapEffect((object) =>
          // `SuiSchema.decode` is the same decode `sui.getObject({ schema })`
          // does, for the places that already have bytes. Bytes that do not
          // decode are a `DecodeError` naming the object and the type — not a
          // transport failure, which is what a node that could not be reached
          // is.
          SuiSchema.decode(content, object.content, {
            objectId: object.id,
            // The type the object actually has. Give it and `SuiSchema.decode`
            // runs the same tag check `getObject` does, under the same rule: a
            // bare expected tag matches every instantiation of it, a
            // parameterized one is compared in full.
            actualType: object.type
          }).pipe(Effect.map((content): EscrowObject => ({ ...object, content })))
        )
      )

    return {
      packageId,
      typeOrigin,
      feeCollector,
      get,
      claim,
      claimFor,
      owned: {
        stream,
        count: (owner: SuiAddress) => Stream.runCount(stream(owner))
      }
    }
  })

/**
 * What this release knows about a network: the package it was published to,
 * and the operator that settles for it.
 */
export interface EscrowDeployment {
  readonly packageId: string
  readonly url: string
}

/**
 * The deployments this release bundles.
 *
 * Every extension over a Move package has one of these, because a package id is
 * per network and a consumer should not have to carry a table of them. Replace
 * the ids with yours.
 */
export const DEPLOYMENTS: Readonly<Record<string, EscrowDeployment>> = {
  testnet: { packageId: ESCROW_PACKAGE, url: "https://settlement.testnet.example" },
  mainnet: { packageId: ESCROW_PACKAGE, url: "https://settlement.example" }
}

/** The in-memory settlement service `layerTest` runs against. */
const fakeApi = (settled: boolean): SettlementApi => ({
  notifyClaim: async () => ({ status: settled ? "settled" : "pending" }),
  // `SuiAddress.make` validates, it does not normalize: `"0x1"` is not a
  // 32-byte address and `make` throws, which the `use` boundary then reports as
  // a `TransportError` from a fake that never touched a network. Normalize
  // first — or write the padded form out — whenever a literal address becomes a
  // branded one.
  resolveFeeCollector: async () => SuiAddress.make(normalizeSuiAddress("0x1"))
})

/**
 * The escrow extension.
 *
 * The identifier is `"<package>/<Name>"` and never changes after publication:
 * it is the runtime key every copy of this module agrees on.
 */
export class Escrow extends Context.Service<Escrow, EscrowService>()(
  "example-extension/Escrow"
) {
  /**
   * The live layer. It requires `Sui` and nothing else — it never builds a
   * client of its own — which is exactly what `SuiExtension.fromService` can
   * satisfy from the client `$extend` was called on. Never fails.
   */
  static readonly layer = (options: EscrowOptions): Layer.Layer<Escrow, never, Sui> =>
    Layer.effect(
      Escrow,
      make({
        packageId: options.packageId,
        ...(options.typeOrigin === undefined ? {} : { typeOrigin: options.typeOrigin }),
        api: settlementApi({ url: options.url, apiKey: Redacted.value(options.apiKey) })
      })
    )

  /**
   * The same layer from the environment: `ESCROW_PACKAGE_ID`, `ESCROW_URL` and
   * `ESCROW_API_KEY`, which is `Config.redacted` because it is a secret.
   *
   * Fails with: `ConfigError`.
   */
  static readonly layerConfig: Layer.Layer<Escrow, Config.ConfigError, Sui> = Layer.unwrap(
    Effect.gen(function*() {
      const options = yield* Config.all({
        packageId: Config.nonEmptyString("PACKAGE_ID").pipe(
          Config.withDefault(ESCROW_PACKAGE)
        ),
        url: Config.nonEmptyString("URL"),
        apiKey: Config.redacted("API_KEY")
      }).pipe(Config.nested("ESCROW"))
      return Escrow.layer(options)
    })
  )

  /**
   * The layer for whatever network the client is already on, from the table
   * this release bundles.
   *
   * This is the shape every extension over a Move package wants: the consumer
   * has already chosen a network by building a client, and the package id
   * follows from it. `Layer.unwrap` is what lets the layer *read* `Sui` before
   * deciding which layer to be, and the network that has no entry is a typed
   * failure rather than an `undefined` that surfaces as a Move abort three
   * calls later.
   *
   * `layerConfig` still earns its place beside this one when configuration
   * carries something the table cannot: the operator URL of a private
   * deployment, a credential, a package id under test. When the only
   * configuration *is* the package id, this layer is the one to ship and
   * `layerConfig` is the override.
   *
   * Fails with: `EscrowUnsupportedNetwork`.
   */
  static readonly layerBundled = (
    options: { readonly apiKey: Redacted.Redacted<string> }
  ): Layer.Layer<Escrow, EscrowUnsupportedNetwork, Sui> =>
    Layer.unwrap(
      Effect.gen(function*() {
        const sui = yield* Sui
        const deployment = DEPLOYMENTS[sui.network]
        if (deployment === undefined) {
          return yield* new EscrowUnsupportedNetwork({ network: sui.network })
        }
        return Escrow.layer({ ...deployment, apiKey: options.apiKey })
      })
    )

  /**
   * The test layer: the real service over an in-memory settlement service, so
   * an extension test drives the production code path and never opens a socket.
   * Compose it with `layerExtensionTest` from `sui-effect/testing`. Never fails.
   */
  static readonly layerTest = (
    state: { readonly settled?: boolean } = {}
  ): Layer.Layer<Escrow, never, Sui> =>
    Layer.effect(
      Escrow,
      make({ packageId: ESCROW_PACKAGE, api: fakeApi(state.settled ?? true) })
    )
}
