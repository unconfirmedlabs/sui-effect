// A script whose submissions survive a crash: a durable journal, and a sweep of whatever the
// last run left unresolved before anything new is sent.
import { Effect, Layer } from "effect"
import type { KeyValueStore } from "effect/persistence"
import type { SuiAddress } from "../../src/index.ts"
import { layerKeyValueStore } from "../../src/journal.ts"
import { Script } from "../../src/script.ts"
import { Tx } from "../../src/tx.ts"

// In production `KeyValueStore.layerFileSystem("./journal")` over a platform's `FileSystem` and
// `Path` (`BunServices.layer`); in a test `KeyValueStore.layerMemory`.
export const durableJournal = <E>(store: Layer.Layer<KeyValueStore.KeyValueStore, E>) =>
  layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(store))

export const payOnce = (recipient: SuiAddress, amount: bigint) =>
  Effect.gen(function*() {
    yield* Tx.reconcileAll({ resubmit: true })
    const { signer } = yield* Script
    const executed = yield* Tx.run((tx) => {
      tx.transferObjects([tx.splitCoins(tx.gas, [amount])], recipient)
    }, { signer })
    return executed.digest
  })

// Given in `options.layer`, or provided inside the program with `Effect.provide(durableJournal(store))`:
// `Script.run` finds the journal either way and reports only this run's entries on a failure.
export const main = <E>(store: Layer.Layer<KeyValueStore.KeyValueStore, E>, recipient: SuiAddress) =>
  Script.run(payOnce(recipient, 1_000n), { layer: Layer.merge(Script.layer, durableJournal(store)) })
