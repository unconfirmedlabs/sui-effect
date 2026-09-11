/**
 * `sui-effect/journal`: the durable submission journal.
 *
 * Separate from `sui-effect/tx` because it is the only part of the package
 * that imports `effect/unstable/*` (`KeyValueStore`), and an application that
 * does not need durability should not take that dependency.
 *
 * Building the layer does no network work. Settling what a previous run left
 * behind is `Tx.reconcileAll`, which the application calls when it is ready.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { KeyValueStore } from "effect/unstable/persistence"
 * import { Journal } from "sui-effect/journal"
 *
 * const layer = Journal.layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
 *   Layer.provide(KeyValueStore.layerMemory)
 * )
 * ```
 *
 * @since 0.1.0
 */
import { Journal as JournalBase } from "./services/Journal.ts"
import { layerKeyValueStore, make } from "./services/JournalKeyValueStore.ts"

export type { JournalKeyValueStoreOptions } from "./services/JournalKeyValueStore.ts"
export type { JournalService } from "./services/Journal.ts"

/**
 * The same `Journal` reference `sui-effect/tx` exports, with the durable
 * constructors attached. Importing this module adds them to the one reference
 * object, so the key identity — and therefore what `Tx.submit` reads from
 * context — is unchanged.
 */
export const Journal = Object.assign(JournalBase, {
  /**
   * The durable journal as a layer over a `KeyValueStore`.
   *
   * Fails with: `JournalError`.
   */
  layerKeyValueStore,
  /** The same implementation over a store you already have. Never fails. */
  makeKeyValueStore: make
})
