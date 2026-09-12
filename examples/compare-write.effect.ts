/**
 * Claims an escrow through `Tx.run`, sui-effect's write path.
 *
 * Compare with `examples/compare-write.sdk.ts`, which does the same thing
 * against the canonical SDK client. Both sign with `SUI_PRIVATE_KEY` and
 * print the created receipt's object id.
 *
 * What `Tx.run` adds over the SDK file: a default expiration bounded to the
 * current epoch, a journal entry written before the first execute so a crash
 * mid-flight leaves a record, resending the identical signed bytes rather
 * than rebuilding on a transient failure, `reconcile` when a submission's
 * outcome is unknown, and a sender lock so two concurrent claims from one
 * address cannot pick the same gas coin. What it costs is the Effect
 * vocabulary below.
 *
 * Run with:
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/compare-write.effect.ts
 */
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "../src/index.ts"
import { Script } from "../src/script.ts"
import { Tx } from "../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)

/**
 * The program itself, exported so a test can run it against the fake. Every
 * failure it can produce is in the generator's inferred error type, with no
 * handling lines anywhere in this file: `ObjectNotFound`, `ObjectDeleted`,
 * `ObjectUnavailable`, `DecodeError`, `TransportError`, `BuildError`,
 * `SimulationFailed`, `SigningError`, `PolicyDenied`, `NotApplied`,
 * `JournalError`, `UnexpectedEffects`, `ExecutionFailed`, `SubmissionUnknown`,
 * plus `ConfigError` and `NetworkMismatch` from the layer.
 */
export const program = Effect.gen(function*() {
  const { signer, sui } = yield* Script
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const executed = yield* Tx.run((tx) => {
    tx.moveCall({
      target: `${PKG}::escrow::claim`,
      arguments: [tx.object(id), tx.pure.u64(escrow.content.amount)]
    })
  }, { signer })
  const receipt = yield* executed.expectCreated(`${PKG}::escrow::Receipt`)
  yield* Console.log(receipt.id)
})

if (import.meta.main) {
  await Script.run(program)
}
