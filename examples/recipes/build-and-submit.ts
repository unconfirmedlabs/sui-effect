// Build, simulate, sign, journal, submit, reconcile: one call, one sender lock.
import { Effect } from "effect"
import { Mist, type SuiAddress } from "../../src/index.ts"
import { type Signer, SubmitConfig, Tx } from "../../src/tx.ts"

export const pay = (signer: Signer, recipient: SuiAddress, amount: bigint) =>
  // From the sender's address balance into the recipient's: with gas from the
  // balance too, the bytes pin nothing.
  Tx.run(Tx.sendFunds({ amount, recipient }), { signer }).pipe(
    Effect.map((executed) => executed.digest),
    // A ceiling, not a budget: above it the build fails with `PolicyDenied { rule: "maxGasBudget" }`.
    SubmitConfig.with({ maxGasBudget: Mist.make(1_000_000_000n) })
  )
