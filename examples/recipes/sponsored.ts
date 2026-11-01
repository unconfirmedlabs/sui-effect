// The explicit lifecycle, for two parties: the sender signs, the sponsor pays.
import { Effect } from "effect"
import type { ObjectId } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

// `Tx.sponsored` sets sender, gas owner and an empty gas payment: gas comes from the sponsor's
// SUI ADDRESS balance, which must cover the budget or `Tx.build` fails with `BuildError` before
// anything is signed. Fund it from a coin with `coin::into_balance` + `balance::send_funds<SUI>`.
export const sponsoredIncrement = (sender: Signer, sponsor: Signer, counter: ObjectId) =>
  Effect.gen(function*() {
    const parties = { sender: sender.address, gasOwner: sponsor.address }
    const recipe = Tx.sponsored(parties)((tx) => {
      tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
    })
    const built = yield* Tx.build(recipe, parties)
    const signed = yield* Tx.cosign(yield* Tx.sign(built, sender), sponsor)
    return yield* Tx.submit(signed)
  })

// The coin-paid alternative, both signers in one process: no `Tx.sponsored`, just a gas owner.
// Gas is the sponsor's coins, so `Tx.run` also takes the sponsor's lock (only when coins pay).
export const coinPaidIncrement = (sender: Signer, sponsor: Signer, counter: ObjectId) =>
  Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
  }, { signer: sender, sponsor, gasOwner: sponsor.address })
