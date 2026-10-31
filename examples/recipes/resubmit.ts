// Re-sending a lost submission: the identical signed bytes, never a rebuild. One digest executes
// at most once, so a re-send can only land the transaction already signed, or find it landed.
import { Effect } from "effect"
import type { SuiAddress } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

export const payOrResend = (signer: Signer, recipient: SuiAddress, amount: bigint) =>
  Tx.run((tx) => {
    tx.transferObjects([tx.splitCoins(tx.gas, [amount])], recipient)
  }, { signer }).pipe(
    // `SubmissionUnknown` carries the bytes; `Tx.resubmit` sends them again and settles them.
    Effect.catchTag("SubmissionUnknown", (unknown) => Tx.resubmit(unknown))
  )

// At startup, over a durable journal: reconcile every unresolved entry, and re-send the bytes of
// those still unknown. A settled entry is never sent again.
export const startup = Tx.reconcileAll({ resubmit: true })
