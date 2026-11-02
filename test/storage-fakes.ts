/**
 * In-memory stand-ins for the platform stores `@unconfirmed/sui-effect/storage`
 * adapts: the IndexedDB subset `StorageIndexedDb.ts` calls, an AsyncStorage,
 * an MMKV and a `chrome.storage` area. No browser and no React Native ran;
 * these model the behaviour the adapters depend on (asynchronous callbacks,
 * transactions that commit on completion and roll back on abort, structured
 * clone, null for a missing key) and count every call so a test can measure
 * what a listing costs.
 */
import type {
  IndexedDbDatabase,
  IndexedDbFactory,
  IndexedDbObjectStore,
  IndexedDbOpenRequest,
  IndexedDbRequest,
  IndexedDbTransaction
} from "../src/services/StorageIndexedDb.ts"
import type { AsyncStorageLike, MmkvLike } from "../src/services/StorageReactNative.ts"
import type { ChromeStorageAreaLike } from "../src/services/StorageChrome.ts"

/** Every call a stand-in served, by method name. */
export type Calls = Record<string, number>

const count = (calls: Calls, method: string): void => {
  calls[method] = (calls[method] ?? 0) + 1
}

/** Later, on the macrotask queue, the way an engine fires IDB events. */
const later = (f: () => void): void => {
  setTimeout(f, 0)
}

const clone = (value: unknown): unknown => value instanceof Uint8Array ? new Uint8Array(value) : value

class FakeRequest<T> implements IndexedDbRequest<T> {
  result!: T
  error: unknown = null
  onsuccess: ((event: never) => void) | null = null
  onerror: ((event: never) => void) | null = null
  succeed(value: T): void {
    this.result = value
    this.onsuccess?.(undefined as never)
  }
  fail(error: unknown): void {
    this.error = error
    this.onerror?.(undefined as never)
  }
}

class FakeOpenRequest extends FakeRequest<IndexedDbDatabase> implements IndexedDbOpenRequest {
  onupgradeneeded: ((event: never) => void) | null = null
  onblocked: ((event: never) => void) | null = null
}

interface DatabaseState {
  version: number
  stores: Map<string, Map<string, unknown>>
  connections: Set<FakeDatabase>
}

/** A deleted key in a transaction's own writes. */
const TOMBSTONE = Symbol("deleted")

/**
 * One transaction. Reads see the committed data under the transaction's own
 * writes; a readwrite transaction replays its writes onto the committed data
 * when it completes and drops them when it aborts, so two overlapping
 * transactions over different keys both land (as real IndexedDB's scheduling
 * guarantees) and an aborted one leaves nothing behind.
 */
class FakeTransaction implements IndexedDbTransaction {
  error: unknown = null
  oncomplete: ((event: never) => void) | null = null
  onerror: ((event: never) => void) | null = null
  onabort: ((event: never) => void) | null = null
  private readonly writes = new Map<string, unknown>()
  private cleared = false
  private pending = 0
  private finished = false
  private settleScheduled = false

  constructor(
    private readonly committed: Map<string, unknown>,
    private readonly mode: "readonly" | "readwrite",
    private readonly calls: Calls,
    readonly durability: string | undefined
  ) {
    this.scheduleSettle()
  }

  private read(key: string): unknown {
    if (this.writes.has(key)) {
      const value = this.writes.get(key)
      return value === TOMBSTONE ? undefined : value
    }
    return this.cleared ? undefined : this.committed.get(key)
  }

  private keys(): Array<string> {
    const all = new Set(this.cleared ? [] : this.committed.keys())
    for (const [key, value] of this.writes) {
      if (value === TOMBSTONE) all.delete(key)
      else all.add(key)
    }
    return [...all].sort()
  }

  /** Queues one request; it runs on a later macrotask, in order. */
  request<T>(method: string, run: () => T, write = false): FakeRequest<T> {
    count(this.calls, method)
    const request = new FakeRequest<T>()
    if (this.finished) throw new Error("TransactionInactiveError: the transaction has finished")
    if (write && this.mode === "readonly") throw new Error("ReadOnlyError: the transaction is read-only")
    this.pending += 1
    later(() => {
      this.pending -= 1
      if (this.finished) return
      request.succeed(run())
      this.scheduleSettle()
    })
    return request
  }

  private scheduleSettle(): void {
    if (this.settleScheduled) return
    this.settleScheduled = true
    later(() => {
      this.settleScheduled = false
      if (this.finished || this.pending > 0) return
      this.finished = true
      if (this.cleared) this.committed.clear()
      for (const [key, value] of this.writes) {
        if (value === TOMBSTONE) this.committed.delete(key)
        else this.committed.set(key, value)
      }
      this.oncomplete?.(undefined as never)
    })
  }

  objectStore(_name: string): IndexedDbObjectStore {
    return {
      get: (key) => this.request("get", () => clone(this.read(key))),
      put: (value, key) => this.request("put", () => (this.writes.set(key, clone(value)), key), true),
      delete: (key) => this.request("delete", () => (this.writes.set(key, TOMBSTONE), undefined), true),
      clear: () =>
        this.request("clear", () => {
          this.cleared = true
          this.writes.clear()
          return undefined
        }, true),
      count: () => this.request("count", () => this.keys().length),
      getAllKeys: () => this.request("getAllKeys", () => this.keys())
    }
  }

  abort(): void {
    if (this.finished) throw new Error("InvalidStateError: the transaction has finished")
    this.finished = true
    count(this.calls, "abort")
    later(() => this.onabort?.(undefined as never))
  }
}

class FakeDatabase implements IndexedDbDatabase {
  onversionchange: ((event: never) => void) | null = null
  onclose: ((event: never) => void) | null = null
  closed = false
  readonly transactions: Array<FakeTransaction> = []
  constructor(private readonly state: DatabaseState, private readonly calls: Calls) {}
  get version(): number {
    return this.state.version
  }
  get objectStoreNames() {
    return { contains: (name: string) => this.state.stores.has(name) }
  }
  createObjectStore(name: string): unknown {
    count(this.calls, "createObjectStore")
    this.state.stores.set(name, new Map())
    return {}
  }
  transaction(
    storeName: string,
    mode: "readonly" | "readwrite",
    options?: { readonly durability?: "default" | "strict" | "relaxed" }
  ): IndexedDbTransaction {
    if (this.closed) throw new Error("InvalidStateError: the database connection is closing")
    const store = this.state.stores.get(storeName)
    if (store === undefined) throw new Error(`NotFoundError: no object store ${storeName}`)
    count(this.calls, `transaction:${mode}`)
    const tx = new FakeTransaction(store, mode, this.calls, options?.durability)
    this.transactions.push(tx)
    return tx
  }
  close(): void {
    if (this.closed) return
    this.closed = true
    this.state.connections.delete(this)
  }
}

/** An `IDBFactory` over an in-memory map of databases. */
export const makeFakeIndexedDb = () => {
  const databases = new Map<string, DatabaseState>()
  const calls: Calls = {}
  const connections: Array<FakeDatabase> = []
  const factory: IndexedDbFactory = {
    open: (name, version) => {
      count(calls, "open")
      const request = new FakeOpenRequest()
      later(() => {
        let state = databases.get(name)
        const target = version ?? state?.version ?? 1
        if (state !== undefined && target < state.version) {
          request.fail(new Error("VersionError"))
          return
        }
        const upgrading = state === undefined || target > state.version
        if (state !== undefined && upgrading) {
          for (const other of [...state.connections]) other.onversionchange?.(undefined as never)
          if (state.connections.size > 0) {
            request.onblocked?.(undefined as never)
            return
          }
        }
        if (state === undefined) {
          state = { version: target, stores: new Map(), connections: new Set() }
          databases.set(name, state)
        }
        state.version = target
        const db = new FakeDatabase(state, calls)
        state.connections.add(db)
        connections.push(db)
        request.result = db
        if (upgrading) request.onupgradeneeded?.(undefined as never)
        request.succeed(db)
      })
      return request
    }
  }
  return {
    factory,
    calls,
    databases,
    connections,
    /** The committed contents of one object store. */
    contents: (database: string, store: string): Map<string, unknown> | undefined =>
      databases.get(database)?.stores.get(store),
    /** Creates a database holding other stores only, as another user of the name would. */
    seedForeign: (database: string, store: string) => {
      databases.set(database, {
        version: 3,
        stores: new Map([[store, new Map([["theirs", "kept"]])]]),
        connections: new Set()
      })
    }
  }
}

/** An AsyncStorage over a `Map`: promises, `null` for a missing key. */
export const makeFakeAsyncStorage = (options?: { readonly withClear?: boolean }) => {
  const data = new Map<string, string>()
  const calls: Calls = {}
  const tick = () => new Promise<void>((resolve) => later(resolve))
  const storage: AsyncStorageLike = {
    getItem: async (key) => (count(calls, "getItem"), await tick(), data.get(key) ?? null),
    setItem: async (key, value) => {
      count(calls, "setItem")
      await tick()
      if (typeof value !== "string") throw new Error("AsyncStorage stores strings only")
      data.set(key, value)
    },
    removeItem: async (key) => (count(calls, "removeItem"), await tick(), void data.delete(key)),
    getAllKeys: async () => (count(calls, "getAllKeys"), await tick(), [...data.keys()]),
    ...(options?.withClear === false ? {} : {
      clear: async () => (count(calls, "clear"), await tick(), data.clear())
    })
  }
  return { storage, data, calls }
}

/** An MMKV over a `Map`; `api` picks the 2.x/3.x `delete` or the 4.x `remove`. */
export const makeFakeMmkv = (api: "delete" | "remove" = "delete") => {
  const data = new Map<string, string>()
  const calls: Calls = {}
  const base = {
    getString: (key: string) => (count(calls, "getString"), data.get(key)),
    set: (key: string, value: string) => (count(calls, "set"), void data.set(key, value)),
    getAllKeys: () => (count(calls, "getAllKeys"), [...data.keys()]),
    clearAll: () => (count(calls, "clearAll"), data.clear())
  }
  const mmkv: MmkvLike = api === "delete"
    ? { ...base, delete: (key: string) => (count(calls, "delete"), void data.delete(key)) }
    : { ...base, remove: (key: string) => (count(calls, "remove"), data.delete(key)) }
  return { mmkv, data, calls }
}

/**
 * A `chrome.storage` area over a `Map`, with the JSON round trip the real one
 * does on every value. `getKeys` is present unless `withGetKeys` is false, the
 * way it is absent before Chrome 130.
 */
export const makeFakeChromeStorage = (options?: { readonly withGetKeys?: boolean }) => {
  const data = new Map<string, string>()
  const calls: Calls = {}
  const tick = () => new Promise<void>((resolve) => later(resolve))
  const pick = (keys: string | ReadonlyArray<string> | null): Record<string, unknown> => {
    const wanted = keys === null ? [...data.keys()] : typeof keys === "string" ? [keys] : keys
    const out: Record<string, unknown> = {}
    for (const key of wanted) {
      const json = data.get(key)
      if (json !== undefined) out[key] = JSON.parse(json)
    }
    return out
  }
  const area: ChromeStorageAreaLike = {
    get: async (keys) => (count(calls, keys === null ? "get(null)" : "get"), await tick(), pick(keys)),
    set: async (items) => {
      count(calls, "set")
      await tick()
      for (const [key, value] of Object.entries(items)) data.set(key, JSON.stringify(value))
    },
    remove: async (keys) => {
      count(calls, "remove")
      await tick()
      for (const key of typeof keys === "string" ? [keys] : keys) data.delete(key)
    },
    clear: async () => (count(calls, "clear"), await tick(), data.clear()),
    ...(options?.withGetKeys === false ? {} : {
      getKeys: async () => (count(calls, "getKeys"), await tick(), [...data.keys()])
    })
  }
  return { area, data, calls }
}
