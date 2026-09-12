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
 * The durable constructors are module-level functions rather than statics on
 * `Journal`. Attaching them would mean mutating the one shared reference object
 * at import time, which a bundler told `sideEffects: false` is entitled to drop
 * — and which made `Journal` appear twice, with two different shapes, in the
 * generated documentation. The `Journal` re-exported here is the very same
 * reference `sui-effect/tx` exports, so what a layer provides and what
 * `Tx.submit` reads are the same key.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { KeyValueStore } from "effect/unstable/persistence"
 * import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"
 *
 * const layer = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
 *   Layer.provide(KeyValueStore.layerMemory)
 * )
 * ```
 *
 * @since 0.1.0
 */
export type { JournalKeyValueStoreOptions } from "./services/JournalKeyValueStore.ts"
export type { JournalService } from "./services/Journal.ts"

/**
 * The same `Journal` reference `sui-effect/tx` exports, unmodified: importing
 * this module changes nothing about it.
 */
export { Journal } from "./services/Journal.ts"

/**
 * The durable journal as a layer over a `KeyValueStore`.
 *
 * Fails with: `JournalError` when the store cannot be read, and — with
 * `onUnresolved: "fail"` — when the store still holds unsettled entries.
 */
export { layerKeyValueStore } from "./services/JournalKeyValueStore.ts"

/**
 * The same implementation over a `KeyValueStore` you already have, for a
 * process that wires the journal itself. Never fails.
 */
export { make as makeKeyValueStore } from "./services/JournalKeyValueStore.ts"
