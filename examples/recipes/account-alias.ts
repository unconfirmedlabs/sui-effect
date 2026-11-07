// An account whose only alias is a multisig: hand it over once, then every transaction's sender
// is the account and its signature the multisig's.
import type { MultiSigPublicKey } from "@mysten/sui/multisig"
import { Effect } from "effect"
import type { SuiAddress } from "../../src/index.ts"
import { AddressAlias, Signer, Tx } from "../../src/tx.ts"

// Once, signed by the account's own key: `enable` (it returns no object, so the edit is a second
// transaction), then add the multisig and remove the account itself. Its own key then signs nothing.
export const handOver = (account: Signer, multisig: SuiAddress) =>
  Effect.gen(function*() {
    yield* Tx.run(AddressAlias.enable(), { signer: account })
    return yield* Tx.run((tx) => {
      AddressAlias.add({ address: account.address, alias: multisig })(tx)
      AddressAlias.remove({ address: account.address, alias: account.address })(tx)
    }, { signer: account })
  })

// Every transaction after: members in any order (they are combined in the multisig's member
// order), `Signer.alias` to sign AS the account. `Tx.run` reads the account's alias set once and
// refuses a multisig it does not list with `PolicyDenied { rule: "alias.signer" }` before
// building; the sender lock and the journal are the account's.
export const payAs = (
  account: SuiAddress,
  publicKey: MultiSigPublicKey,
  members: ReadonlyArray<Signer>,
  recipient: SuiAddress
) =>
  Effect.gen(function*() {
    const multisig = yield* Signer.multisig(publicKey, members)
    return yield* Tx.run(Tx.sendFunds({ amount: 1_000n, recipient }), { signer: Signer.alias(account, multisig) })
  })
