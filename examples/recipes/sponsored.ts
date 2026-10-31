// The explicit lifecycle, for two parties: the sender signs, the sponsor pays.
import { Effect } from "effect"
import type { ObjectId } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

export const sponsoredIncrement = (sender: Signer, sponsor: Signer, counter: ObjectId) =>
  Effect.gen(function*() {
    const parties = { sender: sender.address, gasOwner: sponsor.address }
    // `Tx.sponsored` sets sender, gas owner and an empty gas payment (address balance).
    const recipe = Tx.sponsored(parties)((tx) => {
      tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
    })
    const built = yield* Tx.build(recipe, parties)
    const signed = yield* Tx.cosign(yield* Tx.sign(built, sender), sponsor)
    return yield* Tx.submit(signed)
  })
