// Fold an account's coin objects into its address balance once, so later transactions pay gas
// from the balance and pin nothing. SUI pays for its own fold: a coin-only account (a localnet
// faucet's) needs no balance first. Safe to repeat: each call re-plans from what is left.
import { Effect } from "effect"
import { Sui } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

// Reads only: what a fold would do, each batch built and simulated, nothing signed.
export const previewFold = (signer: Signer) =>
  Effect.gen(function*() {
    const sui = yield* Sui
    const plan = yield* Tx.planFold({ owner: signer.address })
    for (const batch of plan.batches) {
      const built = yield* Tx.build(Tx.fold(batch), { sender: signer.address })
      yield* sui.simulate(built.bytes)
    }
    return plan
  })

export const foldAll = (signer: Signer) =>
  Tx.foldCoins({ signer }).pipe(
    Effect.map(({ executed, plan }) => ({
      digests: executed.map((run) => run.digest),
      // SUI dust worth less than the gas of folding it, with no balance to pay for it either.
      dust: plan.skipped.length
    }))
  )
