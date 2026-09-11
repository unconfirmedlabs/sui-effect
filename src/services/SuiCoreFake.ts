/**
 * `SuiCoreFake`: an in-memory `SuiCore` for tests.
 *
 * It holds a map of objects keyed by id with their version and BCS content, the
 * Clock object `0x6`, and scripted outcomes for the methods a transaction
 * lifecycle touches. Anything that is not scripted dies with a message naming
 * the method, so a test never silently passes against a stub.
 *
 * There is no Move execution here and no real BCS validation of a transaction:
 * localnet covers those.
 *
 * @since 0.1.0
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"
import { Inputs, TransactionDataBuilder } from "@mysten/sui/transactions"
import type { TransactionPlugin } from "@mysten/sui/transactions"
import {
  normalizeStructTag,
  normalizeSuiAddress,
  SUI_CLOCK_OBJECT_ID,
  SUI_TYPE_ARG,
  toBase58
} from "@mysten/sui/utils"
import { Context, Effect, Layer } from "effect"
import type { SuiCoreService } from "./SuiCore.ts"
import { DefectMarker, makeFromClient, SuiCore } from "./SuiCore.ts"

/** The BCS layout of `0x2::clock::Clock`. */
export const ClockBcs = bcs.struct("Clock", {
  id: bcs.Address,
  timestamp_ms: bcs.U64
})

/** The Move type of the Clock object. */
export const CLOCK_TYPE = "0x2::clock::Clock"

/** A deterministic base58 32-byte digest, for fixtures. */
export const fakeDigest = (seed: number): string => {
  const bytes = new Uint8Array(32)
  bytes[0] = (seed % 255) + 1
  bytes[31] = 7
  return toBase58(bytes)
}

/** An object the fake serves. */
export interface FakeObject {
  readonly objectId: string
  readonly type: string
  readonly version: bigint
  readonly content: Uint8Array
  readonly digest?: string
  readonly owner?: SuiClientTypes.ObjectOwner
}

/** A created, mutated or deleted object in a scripted execution. */
export interface FakeChange {
  readonly objectId: string
  readonly type: string
  readonly version?: bigint
  readonly owner?: SuiClientTypes.ObjectOwner
  /** `PackageWrite` marks a published package; `AccumulatorWriteV1` an accumulator write. */
  readonly outputState?: SuiClientTypes.ChangedObject["outputState"]
}

/** What a scripted success returns. Everything is optional and defaulted. */
export interface FakeExecution {
  readonly digest?: string
  readonly created?: ReadonlyArray<FakeChange>
  readonly mutated?: ReadonlyArray<FakeChange>
  readonly deleted?: ReadonlyArray<FakeChange>
  readonly events?: ReadonlyArray<SuiClientTypes.Event>
  readonly balanceChanges?: ReadonlyArray<SuiClientTypes.BalanceChange>
  readonly commandResults?: ReadonlyArray<SuiClientTypes.CommandResult>
  readonly gasUsed?: SuiClientTypes.GasCostSummary
  readonly checkpoint?: string
  readonly timestampMs?: number
}

/** One scripted outcome of a call. The last entry of a script repeats forever. */
export type FakeOutcome =
  | { readonly _tag: "succeed"; readonly value: FakeExecution }
  | { readonly _tag: "failWith"; readonly reason: SuiClientTypes.ExecutionError; readonly value: FakeExecution }
  | { readonly _tag: "transportError"; readonly status: string }
  | { readonly _tag: "notFound" }
  | { readonly _tag: "timeoutThen"; readonly found: boolean }

/** Builders for {@link FakeOutcome}. */
export const FakeOutcome = {
  /** The call succeeds with these effects. */
  succeed: (value: FakeExecution = {}): FakeOutcome => ({ _tag: "succeed", value }),
  /** The call resolves with an on-chain failure (`FailedTransaction`). */
  failWith: (
    reason: SuiClientTypes.ExecutionError,
    value: FakeExecution = {}
  ): FakeOutcome => ({ _tag: "failWith", reason, value }),
  /** The call rejects with a gRPC status, as `RpcError` would. */
  transportError: (status: string): FakeOutcome => ({ _tag: "transportError", status }),
  /** The call rejects the way a missing transaction does. */
  notFound: (): FakeOutcome => ({ _tag: "notFound" }),
  /**
   * The call never settles until the caller's `AbortSignal` fires, then rejects
   * with a `DEADLINE_EXCEEDED`. `found` says whether a later `getTransaction`
   * for the same digest should find the transaction.
   */
  timeoutThen: (found: boolean): FakeOutcome => ({ _tag: "timeoutThen", found })
}

/** Everything the fake serves. Every field is optional. */
export interface FakeScript {
  readonly chainId?: string
  readonly network?: SuiClientTypes.Network
  readonly referenceGasPrice?: bigint
  /** The timestamp the Clock object `0x6` reports, in milliseconds. */
  readonly clockTimestampMs?: bigint
  readonly objects?: ReadonlyArray<FakeObject>
  /**
   * The coins `listCoins` serves and the fake's resolve plugin picks gas
   * payment from. `type` is the full object type, `0x2::coin::Coin<T>`, the
   * way the node reports it.
   */
  readonly coins?: ReadonlyArray<SuiClientTypes.Coin>
  /** The gas budget the resolve plugin sets when a transaction has none. */
  readonly gasBudget?: bigint
  readonly balances?: ReadonlyArray<SuiClientTypes.Balance>
  readonly dynamicFields?: Readonly<Record<string, ReadonlyArray<SuiClientTypes.DynamicFieldEntry>>>
  readonly dynamicFieldValues?: Readonly<Record<string, SuiClientTypes.DynamicFieldValue>>
  /** How many items a list method returns per page. Defaults to 50. */
  readonly pageSize?: number
  readonly simulate?: ReadonlyArray<FakeOutcome>
  readonly execute?: ReadonlyArray<FakeOutcome>
  readonly getTransaction?: ReadonlyArray<FakeOutcome>
}

/** One call the fake received, in order. */
export interface RecordedCall {
  readonly method: string
  readonly options: unknown
}

/** What a test can do to the fake while it runs. */
export interface SuiCoreFakeState {
  /**
   * The SDK client object the fake implements, for the one place a test needs
   * it directly: `transaction.build({ client })`. Its
   * `core.resolveTransactionPlugin()` is the fake's own resolver, so a
   * transaction resolves against the fake's objects, gas price and coins with
   * no network.
   */
  readonly client: ClientWithCoreApi
  /** Every call the fake has received, oldest first. */
  readonly calls: Effect.Effect<ReadonlyArray<RecordedCall>>
  /** How many calls were aborted by interruption or timeout. */
  readonly aborted: Effect.Effect<number>
  /** Inserts or replaces an object. */
  readonly setObject: (object: FakeObject) => Effect.Effect<void>
  /** Removes an object, so a later read reports it deleted. */
  readonly deleteObject: (objectId: string) => Effect.Effect<void>
  /** Moves the Clock object forward or back. */
  readonly setClock: (timestampMs: bigint) => Effect.Effect<void>
  /** Replaces the remaining scripted outcomes of a method. */
  readonly setOutcomes: (
    method: "simulate" | "execute" | "getTransaction",
    outcomes: ReadonlyArray<FakeOutcome>
  ) => Effect.Effect<void>
}

interface Mutable {
  objects: Map<string, FakeObject>
  deleted: Set<string>
  clockTimestampMs: bigint
  calls: Array<RecordedCall>
  aborted: number
  cursors: { simulate: number; execute: number; getTransaction: number }
  scripts: {
    simulate: ReadonlyArray<FakeOutcome>
    execute: ReadonlyArray<FakeOutcome>
    getTransaction: ReadonlyArray<FakeOutcome>
  }
  pendingDigests: Map<string, boolean>
  knownTransactions: Map<string, SettledTransaction>
}

/** What a settled call produced, kept so `getTransaction` can serve it again. */
interface SettledTransaction {
  readonly transaction: SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
  readonly failed: boolean
  readonly commandResults: ReadonlyArray<SuiClientTypes.CommandResult>
}

const DEFAULT_GAS: SuiClientTypes.GasCostSummary = {
  computationCost: "1000000",
  storageCost: "2000000",
  storageRebate: "980000",
  nonRefundableStorageFee: "20000"
}

const addressOwner = (address: string): SuiClientTypes.ObjectOwner => ({
  $kind: "AddressOwner",
  AddressOwner: normalizeSuiAddress(address)
})

const clockObject = (timestampMs: bigint): FakeObject => ({
  objectId: SUI_CLOCK_OBJECT_ID,
  type: CLOCK_TYPE,
  version: 1n,
  digest: fakeDigest(6),
  owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
  content: ClockBcs.serialize({
    id: SUI_CLOCK_OBJECT_ID,
    timestamp_ms: timestampMs.toString()
  }).toBytes()
})

const toSdkObject = (object: FakeObject): SuiClientTypes.Object<{ content: true }> =>
  ({
    objectId: normalizeSuiAddress(object.objectId),
    version: object.version.toString(),
    digest: object.digest ?? fakeDigest(Number(object.version % 200n) + 1),
    owner: object.owner ?? addressOwner("0x1"),
    type: object.type,
    content: object.content,
    previousTransaction: undefined,
    objectBcs: undefined,
    json: undefined,
    display: undefined
  }) as SuiClientTypes.Object<{ content: true }>

const changedObject = (
  change: FakeChange,
  kind: "created" | "mutated" | "deleted"
): SuiClientTypes.ChangedObject => ({
  objectId: normalizeSuiAddress(change.objectId),
  inputState: kind === "created" ? "DoesNotExist" : "Exists",
  inputVersion: kind === "created" ? null : ((change.version ?? 2n) - 1n).toString(),
  inputDigest: kind === "created" ? null : fakeDigest(11),
  inputOwner: kind === "created" ? null : (change.owner ?? addressOwner("0x1")),
  outputState:
    change.outputState ?? (kind === "deleted" ? "DoesNotExist" : "ObjectWrite"),
  outputVersion: kind === "deleted" ? null : (change.version ?? 2n).toString(),
  outputDigest: kind === "deleted" ? null : fakeDigest(12),
  outputOwner: kind === "deleted" ? null : (change.owner ?? addressOwner("0x1")),
  idOperation: kind === "created" ? "Created" : kind === "deleted" ? "Deleted" : "None"
})

const executionToTransaction = (
  execution: FakeExecution,
  status: SuiClientTypes.ExecutionStatus,
  digest: string
): SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude> => {
  const changes = [
    ...(execution.created ?? []).map((change) => changedObject(change, "created")),
    ...(execution.mutated ?? []).map((change) => changedObject(change, "mutated")),
    ...(execution.deleted ?? []).map((change) => changedObject(change, "deleted"))
  ]
  const objectTypes: Record<string, string> = {}
  for (const change of [
    ...(execution.created ?? []),
    ...(execution.mutated ?? []),
    ...(execution.deleted ?? [])
  ]) {
    objectTypes[normalizeSuiAddress(change.objectId)] = change.type
  }
  return {
    digest,
    signatures: [],
    epoch: "1",
    timestampMs: execution.timestampMs ?? null,
    checkpoint: execution.checkpoint ?? null,
    status,
    balanceChanges: execution.balanceChanges ?? [],
    effects: {
      bcs: null,
      version: 2,
      status,
      gasUsed: execution.gasUsed ?? DEFAULT_GAS,
      transactionDigest: digest,
      gasObject: null,
      eventsDigest: null,
      dependencies: [],
      lamportVersion: "2",
      changedObjects: changes,
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null
    },
    events: execution.events ?? [],
    objectTypes,
    transaction: undefined,
    bcs: undefined
  } as unknown as SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
}

/** A gRPC-shaped rejection, so `mapSdkError` reads `code` off it. */
const rpcError = (status: string): Error => {
  const error = new Error(`fake transport error: ${status}`)
  Object.assign(error, { code: status, name: "RpcError" })
  return error
}

const abortError = (): Error => {
  const error = new Error("The operation was aborted")
  Object.assign(error, { name: "AbortError", code: "DEADLINE_EXCEEDED" })
  return error
}

/** Thrown, and re-thrown as a defect, when a test reaches an unscripted method. */
export class FakeUnimplemented extends Error {
  readonly [DefectMarker] = true
  constructor(readonly method: string) {
    super(
      `SuiCoreFake: ${method} is not scripted. Add it to the script, or use a narrower test.`
    )
    this.name = "FakeUnimplemented"
  }
}

const unimplemented = (method: string): never => {
  throw new FakeUnimplemented(method)
}

/**
 * The in-memory `SuiCore`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiCoreFake } from "sui-effect/testing"
 *
 * const layer = SuiCoreFake.layer({ chainId: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S" })
 * ```
 */
export class SuiCoreFake extends Context.Service<SuiCoreFake, SuiCoreFakeState>()(
  "sui-effect/testing/SuiCoreFake"
) {
  /**
   * Provides both `SuiCore` (backed by the fake) and `SuiCoreFake` (the handle a
   * test drives it with). Never fails.
   */
  static readonly layer = (script: FakeScript = {}): Layer.Layer<SuiCore | SuiCoreFake> => {
    const fake = Layer.effect(SuiCoreFake, makeState(script))
    const core = Layer.effect(
      SuiCore,
      Effect.gen(function*() {
        const state = yield* SuiCoreFake
        return (state as InternalState).core
      })
    ).pipe(Layer.provide(fake))
    return Layer.merge(fake, core)
  }
}

interface InternalState extends SuiCoreFakeState {
  readonly core: SuiCoreService
}

const makeState = (script: FakeScript): Effect.Effect<InternalState> =>
  Effect.sync(() => {
    const objects = new Map<string, FakeObject>()
    for (const object of script.objects ?? []) {
      objects.set(normalizeSuiAddress(object.objectId), object)
    }
    return makeInternal(script, {
      objects,
      deleted: new Set(),
      clockTimestampMs: script.clockTimestampMs ?? 1_700_000_000_000n,
      calls: [],
      aborted: 0,
      cursors: { simulate: 0, execute: 0, getTransaction: 0 },
      scripts: {
        simulate: script.simulate ?? [],
        execute: script.execute ?? [],
        getTransaction: script.getTransaction ?? []
      },
      pendingDigests: new Map(),
      knownTransactions: new Map()
    })
  })

const makeInternal = (script: FakeScript, state: Mutable): InternalState => {
  const pageSize = script.pageSize ?? 50
  const chainId = script.chainId ?? "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

  const record = (method: string, options: unknown): void => {
    state.calls.push({ method, options })
  }

  const next = (key: "simulate" | "execute" | "getTransaction"): FakeOutcome | undefined => {
    const outcomes = state.scripts[key]
    if (outcomes.length === 0) return undefined
    const index = Math.min(state.cursors[key], outcomes.length - 1)
    state.cursors[key] = state.cursors[key] + 1
    return outcomes[index]
  }

  const waitForAbort = (signal: AbortSignal): Promise<never> =>
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        state.aborted += 1
        reject(abortError())
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          state.aborted += 1
          reject(abortError())
        },
        { once: true }
      )
    })

  const lookup = (objectId: string): FakeObject => {
    const id = normalizeSuiAddress(objectId)
    if (id === normalizeSuiAddress(SUI_CLOCK_OBJECT_ID)) {
      return clockObject(state.clockTimestampMs)
    }
    if (state.deleted.has(id)) {
      throw new ObjectError("deleted", `object ${id} was deleted`, {
        reason: "deleted",
        objectId: id
      })
    }
    const object = state.objects.get(id)
    if (object === undefined) {
      throw new ObjectError("notFound", `object ${id} does not exist`, {
        reason: "notFound",
        objectId: id
      })
    }
    return object
  }

  const applyOutcome = async (
    outcome: FakeOutcome,
    method: "simulate" | "execute" | "getTransaction",
    digest: string
  ): Promise<SettledTransaction> => {
    switch (outcome._tag) {
      case "transportError":
        throw rpcError(outcome.status)
      case "notFound":
        throw new TransactionError("notFound", digest)
      case "timeoutThen":
        return unimplemented("timeoutThen is handled before applyOutcome")
      case "failWith": {
        const resolved = outcome.value.digest ?? digest
        if (method === "simulate") {
          throw new SimulationError(`Transaction resolution failed: ${outcome.reason.message}`, {
            executionError: outcome.reason
          })
        }
        return {
          transaction: executionToTransaction(
            outcome.value,
            { success: false, error: outcome.reason },
            resolved
          ),
          failed: true,
          commandResults: outcome.value.commandResults ?? []
        }
      }
      case "succeed": {
        const resolved = outcome.value.digest ?? digest
        if (method === "execute") {
          for (const change of [
            ...(outcome.value.created ?? []),
            ...(outcome.value.mutated ?? [])
          ]) {
            const id = normalizeSuiAddress(change.objectId)
            const existing = state.objects.get(id)
            state.objects.set(id, {
              objectId: id,
              type: change.type,
              version: change.version ?? (existing === undefined ? 2n : existing.version + 1n),
              content: existing?.content ?? new Uint8Array(),
              ...(change.owner === undefined ? {} : { owner: change.owner })
            })
          }
          for (const change of outcome.value.deleted ?? []) {
            const id = normalizeSuiAddress(change.objectId)
            state.objects.delete(id)
            state.deleted.add(id)
          }
        }
        return {
          transaction: executionToTransaction(
            outcome.value,
            { success: true, error: null },
            resolved
          ),
          failed: false,
          commandResults: outcome.value.commandResults ?? []
        }
      }
    }
  }

  const page = <A>(
    items: ReadonlyArray<A>,
    cursor: string | null | undefined,
    limit: number | undefined
  ): { items: ReadonlyArray<A>; hasNextPage: boolean; cursor: string | null } => {
    const start = cursor === null || cursor === undefined ? 0 : Number(cursor)
    const size = limit ?? pageSize
    const slice = items.slice(start, start + size)
    const end = start + slice.length
    const hasNextPage = end < items.length
    return { items: slice, hasNextPage, cursor: hasNextPage ? String(end) : null }
  }

  const signalOf = (options: unknown): AbortSignal | undefined => {
    if (typeof options !== "object" || options === null) return undefined
    const signal = (options as { readonly signal?: unknown }).signal
    return signal instanceof AbortSignal ? signal : undefined
  }

  const pending = async <A>(method: string, options: unknown): Promise<A> => {
    const signal = signalOf(options)
    if (signal === undefined) {
      return unimplemented(`${method} (the fake needs an AbortSignal to model a timeout)`)
    }
    return waitForAbort(signal)
  }

  const METHOD_NAMES = {
    simulate: "simulateTransaction",
    execute: "executeTransaction",
    getTransaction: "getTransaction"
  } as const

  const settle = async (
    method: "simulate" | "execute" | "getTransaction",
    digest: string,
    options: unknown
  ): Promise<SettledTransaction> => {
    const outcome = next(method) ?? unimplemented(METHOD_NAMES[method])
    if (outcome._tag === "timeoutThen") {
      state.pendingDigests.set(digest, outcome.found)
      return pending<never>(method, options)
    }
    return applyOutcome(outcome, method, digest)
  }

  const asResult = (result: SettledTransaction) =>
    result.failed
      ? { $kind: "FailedTransaction", FailedTransaction: result.transaction }
      : { $kind: "Transaction", Transaction: result.transaction }

  const coinsOf = (
    owner: string,
    coinType?: string
  ): ReadonlyArray<SuiClientTypes.Coin> => {
    const address = normalizeSuiAddress(owner)
    const wanted = normalizeStructTag(`0x2::coin::Coin<${coinType ?? SUI_TYPE_ARG}>`)
    return (script.coins ?? []).filter((coin) => {
      if (coin.owner.$kind !== "AddressOwner") return false
      if (normalizeSuiAddress(coin.owner.AddressOwner) !== address) return false
      try {
        return normalizeStructTag(coin.type) === wanted
      } catch {
        return false
      }
    })
  }

  /**
   * The fake's stand-in for the transport's resolve plugin, so
   * `transaction.build({ client })` works with no network.
   *
   * It fills the gas price from the scripted reference gas price, the gas
   * budget from `script.gasBudget` (default 50 MIST-per-unit times the price),
   * gas payment from the scripted coins the payer owns when it is unset (an
   * explicit `[]` is left alone, the way a sponsored transaction wants it), and
   * resolves every `UnresolvedObject` input from the object map, choosing a
   * shared, immutable or owned reference from the stored owner. Everything else
   * — argument normalization, BCS layout, validation — is the SDK's own
   * `TransactionDataBuilder`.
   *
   * It does not run Move, so it cannot resolve an `UnresolvedPure` whose type
   * only the function signature knows: use `tx.pure.u64(...)` and friends.
   */
  const resolvePlugin: TransactionPlugin = async (transactionData, options, next) => {
    if (!options.onlyTransactionKind) {
      if (!transactionData.gasData.price) {
        transactionData.gasData.price = String(script.referenceGasPrice ?? 1000n)
      }
      if (!transactionData.gasData.budget) {
        transactionData.gasData.budget = String(script.gasBudget ?? 50_000_000n)
      }
    }
    transactionData.inputs.forEach((input, index) => {
      const unresolved = input.UnresolvedObject
      if (!unresolved) return
      const id = normalizeSuiAddress(unresolved.objectId)
      const object = lookup(id)
      const owner = object.owner ?? addressOwner("0x1")
      const initialSharedVersion = owner.$kind === "Shared"
        ? owner.Shared.initialSharedVersion
        : owner.$kind === "ConsensusAddressOwner"
        ? owner.ConsensusAddressOwner.startVersion
        : null
      const shared = unresolved.initialSharedVersion ?? initialSharedVersion
      transactionData.inputs[index] = shared
        ? Inputs.SharedObjectRef({
          objectId: id,
          initialSharedVersion: shared,
          mutable: unresolved.mutable ?? true
        })
        : Inputs.ObjectRef({
          objectId: id,
          digest: unresolved.digest ?? toSdkObject(object).digest,
          version: unresolved.version ?? object.version.toString()
        })
    })
    if (!options.onlyTransactionKind && transactionData.gasData.payment == null) {
      const payer = transactionData.gasData.owner ?? transactionData.sender
      const coins = payer === null ? [] : coinsOf(payer)
      transactionData.gasData.payment = coins.map((coin) => ({
        objectId: coin.objectId,
        version: coin.version,
        digest: coin.digest
      }))
    }
    await next()
  }

  /** The digest of the bytes that were handed to us, as the network derives it. */
  const digestOfBytes = (bytes: Uint8Array): string => {
    try {
      return TransactionDataBuilder.getDigestFromBytes(bytes)
    } catch {
      return fakeDigest(state.calls.length + 1)
    }
  }

  const core = {
    getObject: async (options: SuiClientTypes.GetObjectOptions) => {
      record("getObject", options)
      return { object: toSdkObject(lookup(options.objectId)) }
    },
    getObjects: async (options: SuiClientTypes.GetObjectsOptions) => {
      record("getObjects", options)
      return {
        objects: options.objectIds.map((id) => {
          try {
            return toSdkObject(lookup(id))
          } catch (cause) {
            return cause as Error
          }
        })
      }
    },
    listOwnedObjects: async (options: SuiClientTypes.ListOwnedObjectsOptions) => {
      record("listOwnedObjects", options)
      const owner = normalizeSuiAddress(options.owner)
      const owned = [...state.objects.values()].filter((object) => {
        const objectOwner = object.owner ?? addressOwner("0x1")
        if (objectOwner.$kind !== "AddressOwner") return false
        if (normalizeSuiAddress(objectOwner.AddressOwner) !== owner) return false
        return options.type === undefined || object.type === options.type
      })
      const result = page(owned, options.cursor, options.limit)
      return {
        objects: result.items.map(toSdkObject),
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    listCoins: async (options: SuiClientTypes.ListCoinsOptions) => {
      record("listCoins", options)
      const result = page(coinsOf(options.owner, options.coinType), options.cursor, options.limit)
      return {
        objects: result.items as Array<SuiClientTypes.Coin>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    listDynamicFields: async (options: SuiClientTypes.ListDynamicFieldsOptions) => {
      record("listDynamicFields", options)
      const fields = script.dynamicFields?.[normalizeSuiAddress(options.parentId)] ?? []
      const result = page(fields, options.cursor, options.limit)
      return {
        dynamicFields: result.items as Array<SuiClientTypes.DynamicFieldEntry>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    getDynamicField: async (options: SuiClientTypes.GetDynamicFieldOptions) => {
      record("getDynamicField", options)
      const parent = normalizeSuiAddress(options.parentId)
      const entry = (script.dynamicFields?.[parent] ?? []).find(
        (field) => field.name.type === options.name.type
      )
      if (entry === undefined) {
        throw new ObjectError("notFound", "dynamic field not found", {
          reason: "notFound",
          objectId: parent
        })
      }
      const value = script.dynamicFieldValues?.[entry.fieldId] ?? {
        type: entry.valueType,
        bcs: new Uint8Array()
      }
      return {
        dynamicField: {
          ...entry,
          value,
          version: "1",
          digest: fakeDigest(21),
          previousTransaction: null
        } as SuiClientTypes.DynamicField
      }
    },
    getDynamicObjectField: async (options: SuiClientTypes.GetDynamicObjectFieldOptions) => {
      record("getDynamicObjectField", options)
      return unimplemented("getDynamicObjectField")
    },
    getBalance: async (options: SuiClientTypes.GetBalanceOptions) => {
      record("getBalance", options)
      const coinType = options.coinType ?? "0x2::sui::SUI"
      const balance = (script.balances ?? []).find((item) => item.coinType === coinType)
      return {
        balance: balance ?? { coinType, balance: "0", coinBalance: "0", addressBalance: "0" }
      }
    },
    listBalances: async (options: SuiClientTypes.ListBalancesOptions) => {
      record("listBalances", options)
      const result = page(script.balances ?? [], options.cursor, options.limit)
      return {
        balances: result.items as Array<SuiClientTypes.Balance>,
        hasNextPage: result.hasNextPage,
        cursor: result.cursor
      }
    },
    getCoinMetadata: async (options: SuiClientTypes.GetCoinMetadataOptions) => {
      record("getCoinMetadata", options)
      return unimplemented("getCoinMetadata")
    },
    getTransaction: async (options: SuiClientTypes.GetTransactionOptions) => {
      record("getTransaction", options)
      const pending = state.pendingDigests.get(options.digest)
      if (pending === false) throw new TransactionError("notFound", options.digest)
      const known = state.knownTransactions.get(options.digest)
      if (known !== undefined && state.scripts.getTransaction.length === 0) {
        return asResult(known)
      }
      return asResult(await settle("getTransaction", options.digest, options))
    },
    executeTransaction: async (options: SuiClientTypes.ExecuteTransactionOptions) => {
      record("executeTransaction", options)
      const digest = digestOfBytes(options.transaction)
      const settled = await settle("execute", digest, options)
      state.knownTransactions.set(digest, settled)
      return asResult(settled)
    },
    signAndExecuteTransaction: async (
      options: SuiClientTypes.SignAndExecuteTransactionOptions
    ) => {
      record("signAndExecuteTransaction", options)
      return unimplemented("signAndExecuteTransaction")
    },
    waitForTransaction: async (options: SuiClientTypes.WaitForTransactionOptions) => {
      record("waitForTransaction", options)
      const digest = "digest" in options && options.digest !== undefined
        ? options.digest
        : fakeDigest(1)
      const pending = state.pendingDigests.get(digest)
      if (pending === false) throw new TransactionError("notFound", digest)
      const known = state.knownTransactions.get(digest)
      if (known !== undefined && state.scripts.getTransaction.length === 0) {
        return asResult(known)
      }
      return asResult(await settle("getTransaction", digest, options))
    },
    simulateTransaction: async (options: SuiClientTypes.SimulateTransactionOptions) => {
      record("simulateTransaction", options)
      const digest = options.transaction instanceof Uint8Array
        ? digestOfBytes(options.transaction)
        : fakeDigest(state.calls.length + 100)
      const result = await settle("simulate", digest, options)
      return { ...asResult(result), commandResults: result.commandResults }
    },
    listTransactions: async (options: SuiClientTypes.ListTransactionsOptions) => {
      record("listTransactions", options)
      return unimplemented("listTransactions")
    },
    listEvents: async (options: SuiClientTypes.ListEventsOptions) => {
      record("listEvents", options)
      return unimplemented("listEvents")
    },
    getReferenceGasPrice: async (options?: SuiClientTypes.GetReferenceGasPriceOptions) => {
      record("getReferenceGasPrice", options)
      return { referenceGasPrice: (script.referenceGasPrice ?? 1000n).toString() }
    },
    getCurrentSystemState: async (options?: SuiClientTypes.GetCurrentSystemStateOptions) => {
      record("getCurrentSystemState", options)
      return unimplemented("getCurrentSystemState")
    },
    getProtocolConfig: async (options?: SuiClientTypes.GetProtocolConfigOptions) => {
      record("getProtocolConfig", options)
      return unimplemented("getProtocolConfig")
    },
    getChainIdentifier: async (options?: SuiClientTypes.GetChainIdentifierOptions) => {
      record("getChainIdentifier", options)
      return { chainIdentifier: chainId }
    },
    getMoveFunction: async (options: SuiClientTypes.GetMoveFunctionOptions) => {
      record("getMoveFunction", options)
      return unimplemented("getMoveFunction")
    },
    verifyZkLoginSignature: async (options: SuiClientTypes.VerifyZkLoginSignatureOptions) => {
      record("verifyZkLoginSignature", options)
      return unimplemented("verifyZkLoginSignature")
    },
    resolveNameServiceAddress: async (
      options: SuiClientTypes.ResolveNameServiceAddressOptions
    ) => {
      record("resolveNameServiceAddress", options)
      return unimplemented("resolveNameServiceAddress")
    },
    defaultNameServiceName: async (options: SuiClientTypes.DefaultNameServiceNameOptions) => {
      record("defaultNameServiceName", options)
      return unimplemented("defaultNameServiceName")
    },
    mvr: {
      resolvePackage: async (options: SuiClientTypes.MvrResolvePackageOptions) => {
        record("mvr.resolvePackage", options)
        return unimplemented("mvr.resolvePackage")
      },
      resolveType: async (options: SuiClientTypes.MvrResolveTypeOptions) => {
        record("mvr.resolveType", options)
        return unimplemented("mvr.resolveType")
      },
      resolve: async (options: SuiClientTypes.MvrResolveOptions) => {
        record("mvr.resolve", options)
        return unimplemented("mvr.resolve")
      }
    },
    resolveTransactionPlugin: () => resolvePlugin
  }

  const client = {
    network: script.network ?? "localnet",
    cache: undefined,
    core,
    $extend: () => unimplemented("$extend")
  } as unknown as ClientWithCoreApi

  return {
    core: makeFromClient(client),
    client,
    calls: Effect.sync(() => [...state.calls]),
    aborted: Effect.sync(() => state.aborted),
    setObject: (object) =>
      Effect.sync(() => {
        const id = normalizeSuiAddress(object.objectId)
        state.objects.set(id, object)
        state.deleted.delete(id)
      }),
    deleteObject: (objectId) =>
      Effect.sync(() => {
        const id = normalizeSuiAddress(objectId)
        state.objects.delete(id)
        state.deleted.add(id)
      }),
    setClock: (timestampMs) =>
      Effect.sync(() => {
        state.clockTimestampMs = timestampMs
      }),
    setOutcomes: (method, outcomes) =>
      Effect.sync(() => {
        state.scripts = { ...state.scripts, [method]: outcomes }
        state.cursors = { ...state.cursors, [method]: 0 }
      })
  }
}
