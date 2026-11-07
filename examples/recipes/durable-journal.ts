// Submissions that survive a crash: a durable journal, and a sweep of whatever the last run
// left unresolved before anything new is sent.
import { Effect, Layer } from "effect"
import type { KeyValueStore } from "effect/persistence"
import type { SuiAddress } from "../../src/index.ts"
import { layerKeyValueStore } from "../../src/journal.ts"
import { type Signer, Tx } from "../../src/tx.ts"

// In production `KeyValueStore.layerFileSystem("./journal")` over a platform's `FileSystem` and
// `Path` (`BunServices.layer`); in a test `KeyValueStore.layerMemory`.
export const durableJournal = <E>(store: Layer.Layer<KeyValueStore.KeyValueStore, E>) =>
  layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(store))

export const payOnce = (signer: Signer, recipient: SuiAddress, amount: bigint) =>
  Effect.gen(function*() {
    yield* Tx.reconcileAll({ resubmit: true })
    const executed = yield* Tx.run(Tx.sendFunds({ amount, recipient }), { signer })
    return executed.digest
  })
