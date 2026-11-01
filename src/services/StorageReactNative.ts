/**
 * `KeyValueStore`s over React Native's two common stores: an
 * AsyncStorage-shaped one (promises) and an MMKV-shaped one (synchronous).
 *
 * Both are structural: nothing here imports React Native or either library.
 * Both are string stores, so they go through `KeyValueStore.makeStringOnly`,
 * and a `Uint8Array` is stored as base64.
 *
 * @since 0.5.0
 */
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/persistence"

/**
 * The part of `@react-native-async-storage/async-storage` (or anything shaped
 * like it) this adapter calls. `clear` is optional; without it, `clear` removes
 * every key one by one.
 */
export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null | undefined>
  setItem(key: string, value: string): Promise<unknown>
  removeItem(key: string): Promise<unknown>
  getAllKeys(): Promise<ReadonlyArray<string>>
  clear?(): Promise<unknown>
}

/** What `react-native-mmkv` 2.x/3.x and 4.x have in common, structurally. */
interface MmkvBase {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  getAllKeys(): ReadonlyArray<string>
  clearAll?(): void
}

/**
 * The part of a `react-native-mmkv` instance this adapter calls: `delete`
 * (2.x/3.x) or `remove` (4.x).
 */
export type MmkvLike =
  | (MmkvBase & { delete(key: string): void })
  | (MmkvBase & { remove(key: string): unknown })

const failure = (store: string, method: string, cause: unknown, key?: string) =>
  new KeyValueStore.KeyValueStoreError({
    method,
    message: `${store} ${method}${key === undefined ? "" : ` ${key}`} failed: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
    cause,
    ...(key === undefined ? {} : { key })
  })

/**
 * A `KeyValueStore` over an AsyncStorage-shaped store.
 *
 * Every operation is one call (`clearPrefix` is `getAllKeys` and a
 * `removeItem` per match; `size` is `getAllKeys`). AsyncStorage has no
 * transactions, so a `set` that resolved is as durable as AsyncStorage makes
 * it, and nothing groups two calls. Android's default backend caps the whole
 * store (6 MB by default) and each value (about 2 MB); a journal or keystore is
 * far below either.
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 *
 * @example
 * ```ts
 * import AsyncStorage from "@react-native-async-storage/async-storage"
 * import { layerAsyncStorage } from "@unconfirmed/sui-effect/storage"
 *
 * const store = layerAsyncStorage(AsyncStorage)
 * ```
 *
 * @since 0.5.0
 */
export const layerAsyncStorage = (storage: AsyncStorageLike): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.sync(KeyValueStore.KeyValueStore, () => {
    const call = <A>(method: string, key: string | undefined, f: () => Promise<A>) =>
      Effect.tryPromise({ try: f, catch: (cause) => failure("AsyncStorage", method, cause, key) })
    const keys = call("keys", undefined, () => storage.getAllKeys())
    const removeAll = (method: string, predicate: (key: string) => boolean) =>
      call(method, undefined, async () => {
        const all = await storage.getAllKeys()
        for (const key of all) if (predicate(key)) await storage.removeItem(key)
      })
    return KeyValueStore.makeStringOnly({
      get: (key) => call("get", key, async () => (await storage.getItem(key)) ?? undefined),
      set: (key, value) => Effect.asVoid(call("set", key, () => storage.setItem(key, value))),
      remove: (key) => Effect.asVoid(call("remove", key, () => storage.removeItem(key))),
      clear: storage.clear === undefined
        ? removeAll("clear", () => true)
        : Effect.asVoid(call("clear", undefined, () => storage.clear!())),
      clearPrefix: (prefix) => removeAll("clearPrefix", (key) => key.startsWith(prefix)),
      size: Effect.map(keys, (all) => all.length),
      keys
    })
  })

/**
 * A `KeyValueStore` over an MMKV-shaped synchronous store.
 *
 * Every operation is one synchronous call, wrapped in `Effect.try`. MMKV
 * writes through a memory map, so a `set` survives the app being killed once
 * it returns; it does not group two writes either.
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 *
 * @example
 * ```ts
 * import { layerMmkv, type MmkvLike } from "@unconfirmed/sui-effect/storage"
 *
 * // `new MMKV({ id })` on react-native-mmkv 2.x/3.x, `createMMKV({ id })` on 4.x.
 * declare const mmkv: MmkvLike
 * const store = layerMmkv(mmkv)
 * ```
 *
 * @since 0.5.0
 */
export const layerMmkv = (mmkv: MmkvLike): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.sync(KeyValueStore.KeyValueStore, () => {
    const call = <A>(method: string, key: string | undefined, f: () => A) =>
      Effect.try({ try: f, catch: (cause) => failure("MMKV", method, cause, key) })
    const removeKey = (key: string): void => {
      if ("remove" in mmkv) mmkv.remove(key)
      else mmkv.delete(key)
    }
    const keys = call("keys", undefined, () => [...mmkv.getAllKeys()])
    return KeyValueStore.makeStringOnly({
      get: (key) => call("get", key, () => mmkv.getString(key)),
      set: (key, value) => call("set", key, () => mmkv.set(key, value)),
      remove: (key) => call("remove", key, () => removeKey(key)),
      clear: call("clear", undefined, () => {
        if (mmkv.clearAll !== undefined) mmkv.clearAll()
        else for (const key of mmkv.getAllKeys()) removeKey(key)
      }),
      clearPrefix: (prefix) =>
        call("clearPrefix", prefix, () => {
          for (const key of mmkv.getAllKeys()) if (key.startsWith(prefix)) removeKey(key)
        }),
      size: Effect.map(keys, (all) => all.length),
      keys
    })
  })
