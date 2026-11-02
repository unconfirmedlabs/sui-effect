/**
 * A `KeyValueStore` over a browser extension's `chrome.storage` area
 * (`chrome.storage.local`, `.session`, or Firefox's `browser.storage.local`),
 * reached structurally in its promise form (Manifest V3).
 *
 * @since 0.5.0
 */
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/persistence"

/**
 * The part of a `chrome.storage` `StorageArea` this adapter calls, in its
 * promise form. `getKeys` (Chrome 130+) is used when present; without it,
 * `keys` is `get(null)`, which reads every value in the area.
 */
export interface ChromeStorageAreaLike {
  get(keys: string | ReadonlyArray<string> | null): Promise<Readonly<Record<string, unknown>>>
  set(items: Readonly<Record<string, unknown>>): Promise<unknown>
  remove(keys: string | ReadonlyArray<string>): Promise<unknown>
  clear(): Promise<unknown>
  getKeys?(): Promise<ReadonlyArray<string>>
}

const failure = (method: string, cause: unknown, key?: string) =>
  new KeyValueStore.KeyValueStoreError({
    method,
    message: `chrome.storage ${method}${key === undefined ? "" : ` ${key}`} failed: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    cause,
    ...(key === undefined ? {} : { key })
  })

/**
 * A `KeyValueStore` over a `chrome.storage` area.
 *
 * The area holds JSON values; this store writes only strings (a `Uint8Array`
 * as base64, through `KeyValueStore.makeStringOnly`) and fails `get` with
 * `KeyValueStoreError` on a key that holds anything else, which only another
 * writer to the same area can have put there. Every operation is one call;
 * `clearPrefix` is one `keys` and one `remove` of the matches.
 *
 * `chrome.storage.local` is the area that survives the browser restarting; it
 * holds 10 MB unless the extension asks for `"unlimitedStorage"`, and it is
 * reachable from the MV3 service worker, where `localStorage` is not. Unlike
 * IndexedDB it is shared by every context of the extension and gives no
 * transactions. `chrome.storage.session` is memory only and lost when the
 * browser closes: not a journal.
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 *
 * @example
 * ```ts
 * import { layerChromeStorage, type ChromeStorageAreaLike } from "@unconfirmed/sui-effect/storage"
 *
 * declare const chrome: { readonly storage: { readonly local: ChromeStorageAreaLike } }
 * const store = layerChromeStorage(chrome.storage.local)
 * ```
 *
 * @since 0.5.0
 */
export const layerChromeStorage = (area: ChromeStorageAreaLike): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.sync(KeyValueStore.KeyValueStore, () => {
    const call = <A>(method: string, key: string | undefined, f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: (cause) => failure(method, cause, key) })
    const listKeys = (): Promise<ReadonlyArray<string>> =>
      area.getKeys !== undefined ? area.getKeys() : area.get(null).then((items) => Object.keys(items))
    const keys = call("keys", undefined, listKeys)
    return KeyValueStore.makeStringOnly({
      get: (key) =>
        Effect.flatMap(call("get", key, () => area.get(key)), (items) => {
          const value = Object.hasOwn(items, key) ? items[key] : undefined
          return value === undefined || typeof value === "string"
            ? Effect.succeed(value)
            : Effect.fail(failure("get", new Error("the stored value is not a string"), key))
        }),
      set: (key, value) => Effect.asVoid(call("set", key, () => area.set({ [key]: value }))),
      remove: (key) => Effect.asVoid(call("remove", key, () => area.remove(key))),
      clear: Effect.asVoid(call("clear", undefined, () => area.clear())),
      clearPrefix: (prefix) =>
        call("clearPrefix", prefix, async () => {
          const matching = (await listKeys()).filter((key) => key.startsWith(prefix))
          if (matching.length > 0) await area.remove(matching)
        }),
      size: Effect.map(keys, (all) => all.length),
      keys
    })
  })
