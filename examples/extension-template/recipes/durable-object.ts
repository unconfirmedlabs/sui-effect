/**
 * A `KeyValueStore` over Cloudflare Durable Object storage, for the durable
 * journal in `@unconfirmed/sui-effect/journal`.
 *
 * Not part of the extension package (it is outside `src/`, so it is neither
 * built nor shipped): it is the application-side adapter section 18 of
 * `docs/extensions.md` quotes, kept here so that `tsc --noEmit` compiles it and
 * `test/durable-object.test.ts` runs the journal over it.
 *
 * `DurableStorage` is the structural slice of `DurableObjectStorage` (from
 * `@cloudflare/workers-types`) the adapter uses, so the template needs no
 * Workers types to compile it. In a Worker, pass `ctx.storage` and delete the
 * interface.
 */
import { Effect, Layer } from "effect"
import { KeyValueStore } from "effect/persistence"
import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"

export interface DurableStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<boolean>
  deleteAll(): Promise<void>
  list<T>(): Promise<Map<string, T>>
}

const call = <A>(method: string, run: () => Promise<A>, key?: string) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new KeyValueStore.KeyValueStoreError({
        method,
        message: `Durable Object storage ${method} failed`,
        cause,
        ...(key === undefined ? {} : { key })
      })
  })

export const durableStore = (storage: DurableStorage): KeyValueStore.KeyValueStore =>
  KeyValueStore.makeStringOnly({
    get: (key) => call("get", () => storage.get<string>(key), key),
    set: (key, value) => call("set", () => storage.put(key, value), key),
    remove: (key) => Effect.asVoid(call("remove", () => storage.delete(key), key)),
    clear: call("clear", () => storage.deleteAll()),
    size: Effect.map(call("size", () => storage.list()), (map) => map.size),
    keys: Effect.map(call("keys", () => storage.list()), (map) => [...map.keys()])
  })

export const journal = (storage: DurableStorage) =>
  layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
    Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, durableStore(storage)))
  )
