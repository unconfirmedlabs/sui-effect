// A stateless sponsor service: handed the sender's bytes and signature, it checks, co-signs and
// submits. The sender built `Tx.build(Tx.sponsored(parties)(recipe), parties)` and sent
// `built.bytes` with the signature `Tx.sign(built, sender)` made.
import { Effect } from "effect"
import { PolicyDenied, Sui } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

export const sponsorBytes = (sponsor: Signer) => (bytes: Uint8Array, senderSignature: string) =>
  Effect.gen(function*() {
    // Sender, gas owner, expiration and chain are read out of the bytes, never taken on trust.
    const built = yield* Tx.fromBytes(bytes)
    if (built.gasOwner !== sponsor.address) {
      return yield* new PolicyDenied({ rule: "sponsor.gasOwner", message: `not paid by ${sponsor.address}` })
    }
    // `fromBytes` simulates nothing: simulate bytes you did not build before paying for them.
    yield* Effect.flatMap(Sui, (sui) => sui.simulate(built.bytes))
    // Verified against the bytes; the signer must be their sender or gas owner.
    const withSender = yield* Tx.attach(built, senderSignature)
    return yield* Tx.submit(yield* Tx.cosign(withSender, sponsor))
  })
