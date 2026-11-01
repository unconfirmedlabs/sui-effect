// Publish a package, then upgrade it. `expectPublished()` answers `{ packageId, package, upgradeCap }`
// for both: a publish creates the cap, an upgrade mutates it.
import { Effect } from "effect"
import type { ObjectId } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

// What `sui move build --dump-bytecode-as-base64` prints.
export interface Compiled {
  readonly modules: ReadonlyArray<string>
  readonly dependencies: ReadonlyArray<string>
  readonly digest: ReadonlyArray<number>
}

export const publish = (signer: Signer, compiled: Compiled) =>
  Tx.run((tx) => {
    const upgradeCap = tx.publish({ modules: [...compiled.modules], dependencies: [...compiled.dependencies] })
    // The cap must go somewhere, or the transaction fails with an unused value.
    tx.transferObjects([upgradeCap], signer.address)
  }, { signer }).pipe(Effect.flatMap((executed) => executed.expectPublished()))

// authorize_upgrade → upgrade → commit_upgrade, in one transaction. Policy 0 is `compatible`.
export const upgrade = (signer: Signer, current: ObjectId, upgradeCap: ObjectId, compiled: Compiled) =>
  Tx.run((tx) => {
    const ticket = tx.moveCall({
      target: "0x2::package::authorize_upgrade",
      arguments: [tx.object(upgradeCap), tx.pure.u8(0), tx.pure.vector("u8", [...compiled.digest])]
    })
    const receipt = tx.upgrade({
      modules: [...compiled.modules],
      dependencies: [...compiled.dependencies],
      package: current,
      ticket
    })
    tx.moveCall({ target: "0x2::package::commit_upgrade", arguments: [tx.object(upgradeCap), receipt] })
  }, { signer }).pipe(Effect.flatMap((executed) => executed.expectPublished()))
