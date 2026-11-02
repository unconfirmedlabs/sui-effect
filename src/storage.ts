/**
 * `@unconfirmed/sui-effect/storage`: `KeyValueStore` layers for the platforms
 * a wallet runs on — IndexedDB (browser pages, workers, extension pages and
 * MV3 service workers), React Native's AsyncStorage and MMKV, and a browser
 * extension's `chrome.storage`.
 *
 * Each is a plain `Layer<KeyValueStore>` from `effect/persistence`, so
 * anything written over `KeyValueStore` — the durable journal in
 * `@unconfirmed/sui-effect/journal`, a keystore, a session store — runs on it
 * unchanged. Every platform object is reached through a structural interface
 * exported here: no DOM, React Native or `chrome` types are needed, and
 * nothing is imported from those platforms.
 *
 * `localStorage` is effect's own `KeyValueStore.layerStorage(() => localStorage)`
 * and is not duplicated here. Use it only for small data in a page: it is
 * synchronous (every call blocks the page), capped at about 5 MB per origin,
 * shared by every tab with no transactions, and absent from workers and MV3
 * service workers. A journal or keystore belongs in IndexedDB.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"
 * import { layerIndexedDb } from "@unconfirmed/sui-effect/storage"
 *
 * const journal = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
 *   Layer.provide(layerIndexedDb())
 * )
 * ```
 *
 * @since 0.5.0
 */
export type {
  IndexedDbDatabase,
  IndexedDbFactory,
  IndexedDbObjectStore,
  IndexedDbOpenRequest,
  IndexedDbOptions,
  IndexedDbRequest,
  IndexedDbTransaction
} from "./services/StorageIndexedDb.ts"
export type { ChromeStorageAreaLike } from "./services/StorageChrome.ts"
export type { AsyncStorageLike, MmkvLike } from "./services/StorageReactNative.ts"

/**
 * A `KeyValueStore` over IndexedDB: one database and object store, one
 * transaction per operation, opened on first use.
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 */
export { layerIndexedDb } from "./services/StorageIndexedDb.ts"

/**
 * `KeyValueStore`s over an AsyncStorage-shaped (promise) and an MMKV-shaped
 * (synchronous) React Native store.
 *
 * Never fail to build; every operation fails with `KeyValueStoreError`.
 */
export { layerAsyncStorage, layerMmkv } from "./services/StorageReactNative.ts"

/**
 * A `KeyValueStore` over a `chrome.storage` area (promise form, MV3).
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 */
export { layerChromeStorage } from "./services/StorageChrome.ts"
