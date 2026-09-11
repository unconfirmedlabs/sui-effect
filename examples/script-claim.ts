/**
 * The spec's section 12 script: read an escrow object, claim it, print the
 * receipt's id.
 *
 * Run with:
 *
 * ```bash
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/script-claim.ts
 * ```
 *
 * Every failure this program can produce is in the generator's inferred error
 * type, and each one has its own exit code with zero handling lines here:
 * `ConfigError` and `NetworkMismatch` exit 2, `ObjectNotFound`,
 * `ObjectDeleted`, `ObjectUnavailable`, `DecodeError`, `TransportError`,
 * `BuildError`, `SimulationFailed`, `SigningError`, `PolicyDenied`,
 * `NotApplied`, `JournalError` and `UnexpectedEffects` exit 4,
 * `ExecutionFailed` exits 5, and `SubmissionUnknown` exits 3 with the signed
 * bytes on stderr so the submission can be reconciled.
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

/** The script itself, exported so a test can run it against the fake. */
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
