// The explicit lifecycle, for two parties: the sender signs, the sponsor pays.
import { Effect } from "effect"
import type { SuiAddress } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

// `Tx.sponsored` sets sender, gas owner and an empty gas payment: gas comes from the sponsor's
// SUI ADDRESS balance, which must cover the budget or `Tx.build` fails with `BuildError` before
// anything is signed. Fund it from a coin with `coin::into_balance` + `balance::send_funds<SUI>`.
export const sponsoredSend = (sender: Signer, sponsor: Signer, recipient: SuiAddress, amount: bigint) =>
  Effect.gen(function*() {
    const parties = { sender: sender.address, gasOwner: sponsor.address }
    const built = yield* Tx.build(Tx.sponsored(parties)(Tx.sendFunds({ amount, recipient })), parties)
    const signed = yield* Tx.cosign(yield* Tx.sign(built, sender), sponsor)
    return yield* Tx.submit(signed)
  })

// Both signers in one process: no `Tx.sponsored`, just a gas owner. Gas comes from the
// sponsor's address balance when it covers the budget and from its coins otherwise, and
// `Tx.run` also takes the sponsor's sender lock when its coins pay.
export const sponsoredRun = (sender: Signer, sponsor: Signer, recipient: SuiAddress, amount: bigint) =>
  Tx.run(Tx.sendFunds({ amount, recipient }), { signer: sender, sponsor, gasOwner: sponsor.address })
