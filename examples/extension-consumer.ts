/**
 * Both faces of one extension.
 *
 * The first half is the extension itself, cut down to the smallest thing that
 * is still honest: a service on `Sui` and `Tx`, one read, one recipe fragment,
 * one submit-on-behalf operation, one tagged error that declares its outcome.
 * `examples/extension-template/` is the same shape as a whole package.
 *
 * The second half is the two ways to consume it. An Effect script provides
 * `Escrow.layer` and yields the service. A Promise consumer registers the
 * derived face on an SDK client with `$extend` and never sees Effect at all.
 *
 * Run with:
 *
 * ```bash
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/extension-consumer.ts
 * ```
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { Config, Console, Context, Effect, Layer, Schema } from "effect"
import type { ChangedRef, DecodeError, Recipe, SuiObject, UnexpectedEffects } from "../src/index.ts"
import { ObjectId, type Outcome, SuiSchema, Sui, TransportError } from "../src/index.ts"
import { SuiExtension } from "../src/extension.ts"
import { Script } from "../src/script.ts"
import type { RunError, Signer } from "../src/tx.ts"
import { Tx } from "../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

const EscrowContent = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, owner: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)

type EscrowObject = SuiObject<typeof EscrowContent extends Schema.Codec<infer T, Uint8Array> ? T : never>

/** The extension's own failure, with the outcome a script's exit code uses. */
export class EscrowNotFound extends Schema.TaggedError<EscrowNotFound>()(
  "escrow/EscrowNotFound",
  { escrowId: ObjectId }
) {
  readonly outcome: Outcome = "not_applied"
}

/** The extension: reads through `Sui`, writes through `Tx`, signer as a parameter. */
export class Escrow extends Context.Service<Escrow, {
  readonly get: (
    id: ObjectId
  ) => Effect.Effect<EscrowObject, EscrowNotFound | DecodeError | TransportError>
  readonly claim: (escrow: EscrowObject) => Recipe
  readonly claimFor: (
    id: ObjectId,
    opts: { readonly signer: Signer }
  ) => Effect.Effect<
    ChangedRef,
    EscrowNotFound | DecodeError | TransportError | UnexpectedEffects | RunError
  >
}>()("example/Escrow") {
  static readonly layer: Layer.Layer<Escrow, never, Sui> = Layer.effect(
    Escrow,
    Effect.gen(function*() {
      const sui = yield* Sui

      const get = Effect.fn("Escrow.get")(function*(id: ObjectId) {
        return yield* sui.getObject(id, { schema: EscrowContent }).pipe(
          Effect.catchTag(
            ["ObjectNotFound", "ObjectDeleted"],
            () => Effect.fail(new EscrowNotFound({ escrowId: id }))
          ),
          // `TransportError.fromUnknown`, never the constructor: it classifies
          // the cause — gRPC status, HTTP status, abort — instead of guessing
          // `retryable: false` and dropping it.
          Effect.catchTag("ObjectUnavailable", (cause) =>
            Effect.fail(TransportError.fromUnknown("escrow.get", cause)))
        )
      })

      const claim = (escrow: EscrowObject): Recipe => (tx) => {
        tx.moveCall({
          target: `${PKG}::escrow::claim`,
          arguments: [tx.object(escrow.id), tx.pure.u64(escrow.content.amount)]
        })
      }

      const claimFor = Effect.fn("Escrow.claimFor")(function*(
        id: ObjectId,
        opts: { readonly signer: Signer }
      ) {
        const escrow = yield* get(id)
        const executed = yield* Tx.run(claim(escrow), { signer: opts.signer })
        // The claim is on chain and gas was charged; only the receipt is
        // missing. `UnexpectedEffects` says exactly that, and `outcome` puts it
        // on "applied". Mapping it to `TransportError` would say the opposite —
        // "not applied, safe to retry" — about a transaction that ran.
        return yield* executed.expectCreated(`${PKG}::escrow::Receipt`)
        // `Tx.*` requires `Sui`; providing the one the layer already has is
        // what keeps the service's own members free of requirements.
      }, Effect.provideService(Sui, sui))

      return { get, claim, claimFor }
    })
  )
}

/** The derived Promise face, for a consumer that has an SDK client and no Effect. */
export const escrow = () =>
  SuiExtension.fromService(Escrow, { name: "escrow", layer: Escrow.layer })

/**
 * The Effect consumer: a script that provides the extension's layer and yields
 * the service. `Script` brings `Sui` and `SuiCore`, which is everything
 * `Escrow.layer` requires.
 */
export const program = Effect.gen(function*() {
  const { signer } = yield* Script
  const service = yield* Escrow
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  const receipt = yield* service.claimFor(id, { signer })
  yield* Console.log(receipt.id)
})

/**
 * The Promise consumer, unchanged from what a dapp-kit user writes today: one
 * `$extend`, then plain `await`s. A rejection is the same tagged error
 * instance, so `error._tag === "escrow/EscrowNotFound"` still narrows.
 */
export const readWithPromises = async (
  client: ClientWithCoreApi,
  id: string
): Promise<bigint> => {
  // `fromService` is generic in the registration name, so `extended.escrow` is
  // a property of the extended client's type: no cast, and no `| undefined`
  // under `noUncheckedIndexedAccess`.
  const api = client.$extend(escrow()).escrow
  try {
    const found = await api.get(ObjectId.make(id))
    return BigInt(found.content.amount)
  } finally {
    await api.dispose()
  }
}

if (import.meta.main) {
  await Script.run(program.pipe(Effect.provide(Escrow.layer)))
}
