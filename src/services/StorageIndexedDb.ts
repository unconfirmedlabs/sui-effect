/**
 * A `KeyValueStore` over IndexedDB: one database, one object store, one
 * transaction per operation.
 *
 * The IndexedDB surface is reached through the structural interfaces below,
 * so neither this package nor its consumers need the DOM library types; a
 * browser's `indexedDB` (window, worker, extension page, MV3 service worker)
 * satisfies them as is.
 *
 * @since 0.5.0
 */
import { Effect, Layer } from "effect"
import * as Base64 from "effect/encoding/Base64"
import { KeyValueStore } from "effect/persistence"

/** The part of an `IDBRequest` this adapter reads. */
export interface IndexedDbRequest<T> {
  readonly result: T
  readonly error: unknown
  onsuccess: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
}

/** The part of an `IDBOpenDBRequest` this adapter reads. */
export interface IndexedDbOpenRequest extends IndexedDbRequest<IndexedDbDatabase> {
  onupgradeneeded: ((event: never) => void) | null
  onblocked: ((event: never) => void) | null
}

/** The part of an `IDBObjectStore` this adapter calls. */
export interface IndexedDbObjectStore {
  get(key: string): IndexedDbRequest<unknown>
  put(value: unknown, key: string): IndexedDbRequest<unknown>
  delete(key: string): IndexedDbRequest<unknown>
  clear(): IndexedDbRequest<unknown>
  count(): IndexedDbRequest<number>
  getAllKeys(): IndexedDbRequest<ReadonlyArray<unknown>>
}

/** The part of an `IDBTransaction` this adapter calls. */
export interface IndexedDbTransaction {
  readonly error: unknown
  objectStore(name: string): IndexedDbObjectStore
  abort(): void
  oncomplete: ((event: never) => void) | null
  onerror: ((event: never) => void) | null
  onabort: ((event: never) => void) | null
}

/** The part of an `IDBDatabase` this adapter calls. */
export interface IndexedDbDatabase {
  readonly version: number
  readonly objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): unknown
  transaction(
    storeName: string,
    mode: "readonly" | "readwrite",
    options?: { readonly durability?: "default" | "strict" | "relaxed" }
  ): IndexedDbTransaction
  close(): void
  onversionchange: ((event: never) => void) | null
  onclose: ((event: never) => void) | null
}

/** The part of an `IDBFactory` (`globalThis.indexedDB`) this adapter calls. */
export interface IndexedDbFactory {
  open(name: string, version?: number): IndexedDbOpenRequest
}

/** Options for {@link layerIndexedDb}. */
export interface IndexedDbOptions {
  /** The factory to open the database with. Defaults to `globalThis.indexedDB`. */
  readonly indexedDB?: IndexedDbFactory
  /** The database name. Defaults to `"sui-effect"`. */
  readonly databaseName?: string
  /** The object store name. Defaults to `"keyvalue"`. */
  readonly storeName?: string
  /**
   * The durability hint every write transaction carries. Defaults to
   * `"strict"`: the journal's `Signed` entry is written before any bytes are
   * sent, and a write that a power loss can undo is not a journal. Browsers
   * that do not know the hint ignore it.
   */
  readonly durability?: "default" | "strict" | "relaxed"
}

const describe = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "name" in cause && typeof cause.name === "string"
    ? `${cause.name}${"message" in cause && typeof cause.message === "string" ? `: ${cause.message}` : ""}`
    : String(cause)

const storeError = (method: string, cause: unknown, key?: string): KeyValueStore.KeyValueStoreError =>
  new KeyValueStore.KeyValueStoreError({
    method,
    message: `IndexedDB ${method}${key === undefined ? "" : ` ${key}`} failed: ${describe(cause)}`,
    cause,
    ...(key === undefined ? {} : { key })
  })

const requestResult = <T>(request: IndexedDbRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const encoder = new TextEncoder()

/**
 * A `KeyValueStore` backed by IndexedDB.
 *
 * Strings and `Uint8Array`s are stored as themselves (IndexedDB clones both),
 * so `getUint8Array` returns stored bytes unchanged and `get` returns them as
 * base64; a stored string read with `getUint8Array` is its UTF-8 encoding —
 * the semantics of `KeyValueStore.layerMemory`.
 *
 * The database is opened on first use, not when the layer is built, so
 * building never fails; an IndexedDB that cannot be opened (absent, blocked,
 * refused in a private window) fails each operation with
 * `KeyValueStoreError`, `method` naming the operation. The object store is
 * created when missing, by reopening at the next version. A `versionchange`
 * from another tab closes this connection and the next operation reopens it;
 * the layer's scope closes it for good.
 *
 * Each operation is one transaction, and a write resolves when its
 * transaction **completes** (not when its request succeeds), so a write this
 * store reported done is committed. Interrupting an operation aborts its
 * transaction. `clearPrefix` reads every key and deletes the matching ones in
 * the same transaction: IndexedDB's key ranges need `IDBKeyRange`, which is
 * not structural.
 *
 * Never fails to build; every operation fails with `KeyValueStoreError`.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"
 * import { layerIndexedDb } from "@unconfirmed/sui-effect/storage"
 *
 * const journal = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
 *   Layer.provide(layerIndexedDb({ databaseName: "my-wallet" }))
 * )
 * ```
 *
 * @since 0.5.0
 */
export const layerIndexedDb = (
  options?: IndexedDbOptions
): Layer.Layer<KeyValueStore.KeyValueStore> =>
  Layer.effect(
    KeyValueStore.KeyValueStore,
    Effect.gen(function*() {
      const databaseName = options?.databaseName ?? "sui-effect"
      const storeName = options?.storeName ?? "keyvalue"
      const durability = options?.durability ?? "strict"
      const factory = (): IndexedDbFactory => {
        const found = options?.indexedDB ??
          (globalThis as { readonly indexedDB?: IndexedDbFactory }).indexedDB
        if (found === undefined) throw new Error("IndexedDB is not available in this environment")
        return found
      }

      let connection: Promise<IndexedDbDatabase> | undefined
      let closed = false

      const openAt = (version?: number): Promise<IndexedDbDatabase> =>
        new Promise((resolve, reject) => {
          const request = factory().open(databaseName, version)
          request.onupgradeneeded = () => {
            const db = request.result
            if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName)
          }
          request.onblocked = () =>
            reject(new Error(`opening IndexedDB "${databaseName}" is blocked by another connection`))
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })

      const open = async (): Promise<IndexedDbDatabase> => {
        let db = await openAt()
        if (!db.objectStoreNames.contains(storeName)) {
          // The database exists without our store: another user of the name.
          const next = db.version + 1
          db.close()
          db = await openAt(next)
        }
        const forget = () => {
          db.close()
          connection = undefined
        }
        db.onversionchange = forget
        db.onclose = () => {
          connection = undefined
        }
        return db
      }

      const database = (): Promise<IndexedDbDatabase> => {
        if (closed) return Promise.reject(new Error("the IndexedDB store's scope is closed"))
        if (connection === undefined) {
          const opening = open()
          connection = opening
          opening.catch(() => {
            if (connection === opening) connection = undefined
          })
        }
        return connection
      }

      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          closed = true
          const current = connection
          connection = undefined
          if (current !== undefined) await current.then((db) => db.close(), () => undefined)
        })
      )

      /**
       * Runs `body` in one transaction and answers what it produced once the
       * transaction completes. An abort signal aborts the transaction.
       */
      const run = <A>(
        method: string,
        key: string | undefined,
        mode: "readonly" | "readwrite",
        body: (store: IndexedDbObjectStore) => Promise<A>
      ): Effect.Effect<A, KeyValueStore.KeyValueStoreError> =>
        Effect.tryPromise({
          try: async (signal) => {
            const db = await database()
            // Interrupted while the database was opening: never start.
            if (signal.aborted) throw new Error("interrupted before the transaction started")
            const tx = db.transaction(storeName, mode, mode === "readwrite" ? { durability } : {})
            const done = new Promise<void>((resolve, reject) => {
              tx.oncomplete = () => resolve()
              tx.onerror = () => reject(tx.error)
              tx.onabort = () => reject(tx.error ?? new Error("the IndexedDB transaction was aborted"))
            })
            // `done` may reject after `body` already has; that is not unhandled.
            done.catch(() => undefined)
            const abort = () => {
              try {
                tx.abort()
              } catch {
                // Already finished: nothing to abort.
              }
            }
            signal.addEventListener("abort", abort, { once: true })
            try {
              const value = await body(tx.objectStore(storeName)).catch((cause: unknown) => {
                abort()
                throw cause
              })
              await done
              return value
            } finally {
              signal.removeEventListener("abort", abort)
            }
          },
          catch: (cause) => storeError(method, cause, key)
        })

      const readValue = (key: string) =>
        run("get", key, "readonly", (store) => requestResult(store.get(key)))

      const allKeys = (store: IndexedDbObjectStore): Promise<ReadonlyArray<string>> =>
        requestResult(store.getAllKeys()).then((keys) =>
          keys.filter((key): key is string => typeof key === "string")
        )

      const unexpected = (method: string, key: string) =>
        Effect.fail(storeError(method, new Error("the stored value is neither a string nor bytes"), key))

      return KeyValueStore.make({
        get: (key) =>
          Effect.flatMap(readValue(key), (value) =>
            value === undefined
              ? Effect.undefined
              : typeof value === "string"
              ? Effect.succeed(value)
              : value instanceof Uint8Array
              ? Effect.succeed(Base64.encode(value))
              : unexpected("get", key)),
        getUint8Array: (key) =>
          Effect.flatMap(readValue(key), (value) =>
            value === undefined
              ? Effect.undefined
              : typeof value === "string"
              ? Effect.succeed(encoder.encode(value))
              : value instanceof Uint8Array
              ? Effect.succeed(value)
              : unexpected("getUint8Array", key)),
        set: (key, value) =>
          run(
            "set",
            key,
            "readwrite",
            (store) => requestResult(store.put(typeof value === "string" ? value : value.slice(), key)).then(() => undefined)
          ),
        remove: (key) =>
          run("remove", key, "readwrite", (store) => requestResult(store.delete(key)).then(() => undefined)),
        clear: run("clear", undefined, "readwrite", (store) => requestResult(store.clear()).then(() => undefined)),
        clearPrefix: (prefix) =>
          run("clearPrefix", prefix, "readwrite", (store) =>
            new Promise<void>((resolve, reject) => {
              // The deletes are issued from the request's own success
              // callback, never from a promise continuation, so the
              // transaction is still active on every engine.
              const request = store.getAllKeys()
              request.onerror = () => reject(request.error)
              request.onsuccess = () => {
                for (const key of request.result) {
                  if (typeof key === "string" && key.startsWith(prefix)) store.delete(key)
                }
                resolve()
              }
            })),
        size: run("size", undefined, "readonly", (store) => requestResult(store.count())),
        keys: run("keys", undefined, "readonly", allKeys)
      })
    })
  )
