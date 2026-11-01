// Build, simulate, sign, journal, submit, reconcile: one call, one sender lock.
import { Effect } from "effect"
import { Mist, type SuiAddress } from "../../src/index.ts"
import { type Signer, SubmitConfig, Tx } from "../../src/tx.ts"

export const pay = (signer: Signer, recipient: SuiAddress, amount: bigint) =>
  // Into the recipient's address balance, out of the sender's when it covers
  // the amount: with gas from the balance too, the bytes pin nothing.
  Tx.run(Tx.sendFunds({ amount, recipient }), { signer }).pipe(
    Effect.map((executed) => executed.digest),
    // A ceiling, not a budget: above it the build fails with `PolicyDenied { rule: "maxGasBudget" }`.
    SubmitConfig.with({ maxGasBudget: Mist.make(1_000_000_000n) })
  )
