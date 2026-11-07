/**
 * `sui-effect/testing`: a scripted `SuiCore` for tests, the test layer built
 * on it, and the helpers that drive it.
 *
 * The responder answers from a script of plain values: objects with their
 * exact type and BCS bytes, dynamic fields, address balances, the Clock object
 * `0x6`, and, when a test asks for them, the next `executeTransaction` or
 * `simulateTransaction` answers in order. It never executes, applies or
 * validates a transaction: an execute answer is whatever the script says,
 * stamped with the digest of the bytes it was handed. What a transaction does
 * on chain, and what a validator accepts, is proved against a localnet.
 *
 * Anything the script does not answer dies with a message naming the method,
 * so a test never passes against an answer nobody wrote.
 *
 * @since 0.1.0
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, CoreClientOptions, SuiClientTypes } from "@mysten/sui/client"
import { CoreClient, ObjectError, TransactionError } from "@mysten/sui/client"
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc"
import type { TransactionPlugin } from "@mysten/sui/transactions"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { normalizeStructTag, normalizeSuiAddress, SUI_CLOCK_OBJECT_ID, SUI_TYPE_ARG, toBase58 } from "@mysten/sui/utils"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { TestClock } from "effect/testing"
import { typeMatches } from "./domain/bcs.ts"
import type { NetworkMismatch, TransportError } from "./domain/errors.ts"
import { Digest, ExecutionReason } from "./domain/schemas.ts"
import { Journal } from "./services/Journal.ts"
import { SubmitConfig } from "./services/SubmitConfig.ts"
import { Sui } from "./services/Sui.ts"
import type { SuiCoreService } from "./services/SuiCore.ts"
import { DefectMarker, makeFromClient, SuiCore } from "./services/SuiCore.ts"

/** The chain identifier the responder reports when the script names none. */
export const DEFAULT_CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

/** The epoch the responder reports when the script names none. */
export const DEFAULT_EPOCH = 100n

/**
 * A deterministic base58 32-byte digest, for fixtures, already branded as a
 * {@link Digest}. Never fails.
 */
export const fakeDigest = (seed: number): Digest => {
  const bytes = new Uint8Array(32)
  bytes[0] = (seed % 255) + 1
  bytes[31] = 7
  return Digest.make(toBase58(bytes))
}

/** An object the responder serves: its exact Move type and BCS content. */
export interface FakeObject {
  readonly objectId: string
  readonly type: string
  readonly version: bigint
  readonly content: Uint8Array
  readonly digest?: string
  /** Defaults to `AddressOwner` `0x1`. */
  readonly owner?: SuiClientTypes.ObjectOwner
  /** Served when the read includes `previousTransaction`; `null` otherwise. */
  readonly previousTransaction?: string
  /** Served when the read includes `json`; `null` when left out. */
  readonly json?: Record<string, unknown>
  /** Served when the read includes `display`; `null` when left out. */
  readonly display?: SuiClientTypes.Display
}

const CoinBcs = bcs.struct("Coin", { id: bcs.Address, balance: bcs.u64() })

/**
 * A `0x2::coin::Coin<T>` object with real BCS content, owned by `owner`:
 * `listCoins` and `getBalance`'s `coinBalance` read it like any other object.
 * `coinType` defaults to SUI. Never fails.
 */
export const fakeCoin = (options: {
  readonly objectId: string
  readonly owner: string
  readonly balance: bigint
  readonly coinType?: string
  readonly version?: bigint
}): FakeObject => {
  const objectId = normalizeSuiAddress(options.objectId)
  return {
    objectId,
    type: `0x2::coin::Coin<${options.coinType ?? SUI_TYPE_ARG}>`,
    version: options.version ?? 1n,
    owner: { $kind: "AddressOwner", AddressOwner: normalizeSuiAddress(options.owner) },
    content: CoinBcs.serialize({ id: objectId, balance: options.balance }).toBytes()
  }
}

/** An object a scripted answer reports as created, mutated or deleted. */
export interface FakeChange {
  readonly objectId: string
  readonly type: string
  /** The output version; defaults to 2. */
  readonly version?: bigint
  /** The version the transaction took the object at; defaults to `version - 1`, `null` when created. */
  readonly inputVersion?: bigint
  readonly owner?: SuiClientTypes.ObjectOwner
  /** The owner going in; defaults to `owner`. */
  readonly inputOwner?: SuiClientTypes.ObjectOwner
  /** `PackageWrite` marks a published package. */
  readonly outputState?: SuiClientTypes.ChangedObject["outputState"]
}

/** An event in a scripted answer; `json` is optional. */
export type FakeEvent = Omit<SuiClientTypes.Event, "json"> & {
  readonly json?: SuiClientTypes.Event["json"]
}

/** The effects a scripted execute or simulate answer reports. Every field is optional. */
export interface FakeExecution {
  readonly created?: ReadonlyArray<FakeChange>
  readonly mutated?: ReadonlyArray<FakeChange>
  readonly deleted?: ReadonlyArray<FakeChange>
  readonly events?: ReadonlyArray<FakeEvent>
  readonly balanceChanges?: ReadonlyArray<SuiClientTypes.BalanceChange>
  /** Per-command results of a simulation; a missing array defaults to `[]`. */
  readonly commandResults?: ReadonlyArray<Partial<SuiClientTypes.CommandResult>>
  readonly gasUsed?: SuiClientTypes.GasCostSummary
  readonly checkpoint?: string
  readonly timestampMs?: number
}

/** One scripted answer of `executeTransaction` or `simulateTransaction`. */
export type FakeOutcome =
  | { readonly _tag: "succeed"; readonly value: FakeExecution }
  | { readonly _tag: "failWith"; readonly reason: SuiClientTypes.ExecutionError; readonly value: FakeExecution }
  | { readonly _tag: "transportError"; readonly status: string; readonly message?: string }
  | { readonly _tag: "hang" }

/** The wire `ExecutionError` for a scripted failure, from the SDK's shape or sui-effect's decoded one. */
const executionErrorOf = (
  reason: SuiClientTypes.ExecutionError | ExecutionReason
): SuiClientTypes.ExecutionError => {
  if (typeof (reason as { readonly message?: unknown }).message === "string") {
    return reason as SuiClientTypes.ExecutionError
  }
  return {
    message: `scripted execution failure (${reason.$kind})`,
    ...(Schema.encodeUnknownSync(ExecutionReason)(reason) as object)
  } as SuiClientTypes.ExecutionError
}

/** Builders for {@link FakeOutcome}. */
export const FakeOutcome = {
  /** The transaction succeeds with these effects. */
  succeed: (value: FakeExecution = {}): Extract<FakeOutcome, { readonly _tag: "succeed" }> => ({ _tag: "succeed", value }),
  /**
   * The transaction fails on chain (`FailedTransaction`). `reason` is the
   * SDK's `ExecutionError` or sui-effect's decoded `ExecutionReason`; the
   * second is encoded into the first. Throws on a value that is neither.
   */
  failWith: (
    reason: SuiClientTypes.ExecutionError | ExecutionReason,
    value: FakeExecution = {}
  ): Extract<FakeOutcome, { readonly _tag: "failWith" }> => ({
    _tag: "failWith",
    reason: executionErrorOf(reason),
    value
  }),
  /** The call rejects with this gRPC status, as the SDK's `RpcError` does. */
  transportError: (status: string, message?: string): FakeOutcome =>
    message === undefined ? { _tag: "transportError", status } : { _tag: "transportError", status, message },
  /** The call never answers; it rejects with `DEADLINE_EXCEEDED` once the caller's signal aborts. */
  hang: (): FakeOutcome => ({ _tag: "hang" })
}

/** Everything the responder answers. Every field is optional. */
export interface FakeScript {
  /** Defaults to {@link DEFAULT_CHAIN_ID}. */
  readonly chainId?: string
  /** Defaults to `localnet`. */
  readonly network?: SuiClientTypes.Network
  /** The epoch `getCurrentSystemState` reports; defaults to {@link DEFAULT_EPOCH}. */
  readonly epoch?: bigint
  /** Defaults to 1000. */
  readonly referenceGasPrice?: bigint
  /** The timestamp the Clock object `0x6` reports, in milliseconds; defaults to 0. */
  readonly clockTimestampMs?: bigint
  readonly objects?: ReadonlyArray<FakeObject>
  /** The dynamic fields of each parent, keyed by parent id. */
  readonly dynamicFields?: Readonly<Record<string, ReadonlyArray<SuiClientTypes.DynamicFieldEntry>>>
  /**
   * The value `getDynamicField` serves for an entry of {@link dynamicFields},
   * keyed by the entry's `fieldId`. An entry with none is served with empty
   * bytes. A `DynamicObject` entry's value is the object its `childId` names.
   */
  readonly dynamicFieldValues?: Readonly<Record<string, SuiClientTypes.DynamicFieldValue>>
  /** Address balances; `coinType` defaults to SUI. An owner with none has zero. */
  readonly addressBalances?: ReadonlyArray<{ readonly owner: string; readonly coinType?: string; readonly amount: bigint }>
  /** `simulateTransaction`'s answers, oldest first; the last repeats. */
  readonly simulate?: ReadonlyArray<FakeOutcome>
  /** `executeTransaction`'s answers, oldest first; the last repeats. */
  readonly execute?: ReadonlyArray<FakeOutcome>
}

/** One call the responder received. */
export interface RecordedCall {
  readonly method: string
  readonly options: unknown
}

/** The handle a test drives the responder with. */
export interface ScriptedSuiCoreService {
  /** The `SuiCore` over the responder's client. */
  readonly core: SuiCoreService
  /** The SDK client the responder implements, for `transaction.build({ client })` or `$extend`. */
  readonly client: ClientWithCoreApi
  /** Every call received, oldest first. */
  readonly calls: Effect.Effect<ReadonlyArray<RecordedCall>>
  readonly putObject: (object: FakeObject) => Effect.Effect<void>
  readonly setClock: (timestampMs: bigint) => Effect.Effect<void>
  readonly setAddressBalance: (owner: string, coinType: string, amount: bigint) => Effect.Effect<void>
  readonly setOutcomes: (method: "simulate" | "execute", outcomes: ReadonlyArray<FakeOutcome>) => Effect.Effect<void>
}

/** Thrown, and re-thrown by `SuiCore` as a defect, when a test reaches an unscripted method. */
export class Unscripted extends Error {
  readonly [DefectMarker] = true
  constructor(readonly method: string) {
    super(`ScriptedSuiCore: ${method} is not scripted. Script it, or stub that SuiCore method in the test.`)
    this.name = "Unscripted"
  }
}

const DEFAULT_GAS: SuiClientTypes.GasCostSummary = {
  computationCost: "1000000",
  storageCost: "2000000",
  storageRebate: "980000",
  nonRefundableStorageFee: "20000"
}

const ClockBcs = bcs.struct("Clock", { id: bcs.Address, timestamp_ms: bcs.u64() })

const addressOwner = (address: string): SuiClientTypes.ObjectOwner => ({
  $kind: "AddressOwner",
  AddressOwner: normalizeSuiAddress(address)
})

const sameBytes = (scripted: Uint8Array | undefined, asked: Uint8Array): boolean =>
  scripted === undefined || (scripted.length === asked.length && scripted.every((byte, i) => byte === asked[i]))

const rpcError = (status: string, message?: string): Error =>
  Object.assign(new Error(message ?? `scripted transport error: ${status}`), { code: status, name: "RpcError" })

const untilAborted = (options: unknown): Promise<never> =>
  new Promise<never>((_resolve, reject) => {
    const signal = (options as { readonly signal?: AbortSignal } | undefined)?.signal
    if (signal === undefined) return reject(new Unscripted("a hang with no AbortSignal"))
    const abort = () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
  })

const changedObject = (change: FakeChange, kind: "created" | "mutated" | "deleted"): SuiClientTypes.ChangedObject => {
  const version = change.version ?? 2n
  const owner = change.owner ?? addressOwner("0x1")
  return {
    objectId: normalizeSuiAddress(change.objectId),
    inputState: kind === "created" ? "DoesNotExist" : "Exists",
    inputVersion: kind === "created" ? null : (change.inputVersion ?? version - 1n).toString(),
    inputDigest: kind === "created" ? null : fakeDigest(11),
    inputOwner: kind === "created" ? null : (change.inputOwner ?? owner),
    outputState: change.outputState ?? (kind === "deleted" ? "DoesNotExist" : "ObjectWrite"),
    outputVersion: kind === "deleted" ? null : version.toString(),
    outputDigest: kind === "deleted" ? null : fakeDigest(12),
    outputOwner: kind === "deleted" ? null : owner,
    idOperation: kind === "created" ? "Created" : kind === "deleted" ? "Deleted" : "None"
  }
}

/**
 * The SDK `TransactionResult` a scripted success or failure stands for, for
 * the transaction with this digest. Never fails.
 */
export const transactionResultOf = (
  digest: string,
  outcome: Extract<FakeOutcome, { readonly value: FakeExecution }>
): SuiClientTypes.TransactionResult<SuiClientTypes.TransactionInclude> => {
  const execution = outcome.value
  const status: SuiClientTypes.ExecutionStatus = outcome._tag === "succeed"
    ? { success: true, error: null }
    : { success: false, error: outcome.reason }
  const changes = (["created", "mutated", "deleted"] as const).flatMap((kind) =>
    (execution[kind] ?? []).map((change) => [change, kind] as const)
  )
  const transaction = {
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
      changedObjects: changes.map(([change, kind]) => changedObject(change, kind)),
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null
    },
    events: execution.events ?? [],
    objectTypes: Object.fromEntries(changes.map(([change]) => [normalizeSuiAddress(change.objectId), change.type])),
    transaction: undefined,
    bcs: undefined
  } as unknown as SuiClientTypes.Transaction<SuiClientTypes.TransactionInclude>
  return status.success
    ? { $kind: "Transaction", Transaction: transaction }
    : { $kind: "FailedTransaction", FailedTransaction: transaction }
}

const systemState = (epoch: bigint, referenceGasPrice: bigint): SuiClientTypes.SystemStateInfo => ({
  systemStateVersion: "2",
  epoch: epoch.toString(),
  protocolVersion: "70",
  referenceGasPrice: referenceGasPrice.toString(),
  epochStartTimestampMs: "0",
  safeMode: false,
  safeModeStorageRewards: "0",
  safeModeComputationRewards: "0",
  safeModeStorageRebates: "0",
  safeModeNonRefundableStorageFee: "0",
  parameters: {
    epochDurationMs: "86400000",
    stakeSubsidyStartEpoch: "0",
    maxValidatorCount: "150",
    minValidatorJoiningStake: "0",
    validatorLowStakeThreshold: "0",
    validatorLowStakeGracePeriod: "7"
  },
  storageFund: { totalObjectStorageRebates: "0", nonRefundableBalance: "0" },
  stakeSubsidy: {
    balance: "0",
    distributionCounter: "0",
    currentDistributionAmount: "0",
    stakeSubsidyPeriodLength: "10",
    stakeSubsidyDecreaseRate: 0
  }
})

const coinTypeOf = (type: string): string | undefined => {
  const match = /^0x0*2::coin::Coin<(.+)>$/.exec(normalizeStructTag(type).replace(/^0x0+2::/, "0x2::"))
  return match?.[1] === undefined ? undefined : normalizeStructTag(match[1])
}

/**
 * The SDK client the responder is: an SDK `CoreClient` whose reads answer from
 * the script. `getObject`, `getDynamicObjectField`, `waitForTransaction` and
 * `$extend` are the SDK's own, over these.
 */
class ScriptedClient extends CoreClient {
  readonly recorded: Array<RecordedCall> = []
  readonly objects = new Map<string, FakeObject>()
  readonly balances = new Map<string, bigint>()
  readonly answered = new Map<string, SuiClientTypes.TransactionResult<SuiClientTypes.TransactionInclude>>()
  clockTimestampMs: bigint
  outcomes: Record<"simulate" | "execute", { list: ReadonlyArray<FakeOutcome>; next: number }>
  private readonly resolver: TransactionPlugin

  constructor(private readonly script: FakeScript) {
    const network = script.network ?? "localnet"
    super({ network } as CoreClientOptions)
    // The SDK's own core resolver — the one every non-gRPC transport uses —
    // so `transaction.build({ client })` resolves gas and inputs against the
    // script the way it would against a node. Constructing the client makes
    // no request.
    this.resolver = new SuiJsonRpcClient({ url: "http://127.0.0.1:1", network }).core.resolveTransactionPlugin()
    for (const object of script.objects ?? []) this.objects.set(normalizeSuiAddress(object.objectId), object)
    for (const entry of script.addressBalances ?? []) this.balances.set(this.key(entry.owner, entry.coinType), entry.amount)
    this.clockTimestampMs = script.clockTimestampMs ?? 0n
    this.outcomes = {
      simulate: { list: script.simulate ?? [], next: 0 },
      execute: { list: script.execute ?? [], next: 0 }
    }
  }

  key(owner: string, coinType: string = SUI_TYPE_ARG): string {
    return `${normalizeSuiAddress(owner)}|${normalizeStructTag(coinType)}`
  }

  private record(method: string, options: unknown): void {
    this.recorded.push({ method, options })
  }

  private object(objectId: string): FakeObject | undefined {
    const id = normalizeSuiAddress(objectId)
    if (id === normalizeSuiAddress(SUI_CLOCK_OBJECT_ID)) {
      return {
        objectId: id,
        type: "0x2::clock::Clock",
        version: 1n,
        owner: { $kind: "Shared", Shared: { initialSharedVersion: "1" } },
        content: ClockBcs.serialize({ id, timestamp_ms: this.clockTimestampMs }).toBytes()
      }
    }
    return this.objects.get(id)
  }

  private sdkObject(object: FakeObject, include?: SuiClientTypes.ObjectInclude) {
    return {
      objectId: normalizeSuiAddress(object.objectId),
      version: object.version.toString(),
      digest: object.digest ?? fakeDigest(Number(object.version % 200n) + 1),
      owner: object.owner ?? addressOwner("0x1"),
      type: object.type,
      content: include === undefined || include.content === true ? object.content : undefined,
      previousTransaction: include?.previousTransaction === true ? object.previousTransaction ?? null : undefined,
      objectBcs: undefined,
      json: include?.json === true ? object.json ?? null : undefined,
      display: include?.display === true ? object.display ?? null : undefined
    } as unknown as SuiClientTypes.Object<{ content: true }>
  }

  private owned(owner: string): Array<FakeObject> {
    const address = normalizeSuiAddress(owner)
    return [...this.objects.values()].filter((object) => {
      const held = object.owner ?? addressOwner("0x1")
      return held.$kind === "AddressOwner" && normalizeSuiAddress(held.AddressOwner) === address
    })
  }

  private coins(owner: string, coinType: string): Array<SuiClientTypes.Coin> {
    const wanted = normalizeStructTag(coinType)
    return this.owned(owner).flatMap((object) => {
      if (coinTypeOf(object.type) !== wanted) return []
      const sdk = this.sdkObject(object)
      return [{ ...sdk, balance: CoinBcs.parse(object.content).balance } as SuiClientTypes.Coin]
    })
  }

  private balance(owner: string, coinType: string): SuiClientTypes.Balance {
    const addressBalance = this.balances.get(this.key(owner, coinType)) ?? 0n
    const coinBalance = this.coins(owner, coinType).reduce((sum, coin) => sum + BigInt(coin.balance), 0n)
    return {
      coinType: normalizeStructTag(coinType),
      balance: (addressBalance + coinBalance).toString(),
      coinBalance: coinBalance.toString(),
      addressBalance: addressBalance.toString()
    }
  }

  /** The next scripted answer of `method`, as the SDK result for the bytes handed over, and its command results. */
  private async answer(method: "simulate" | "execute", options: SuiClientTypes.SimulateTransactionOptions): Promise<{
    readonly result: SuiClientTypes.TransactionResult<SuiClientTypes.TransactionInclude>
    readonly commandResults: Array<SuiClientTypes.CommandResult>
  }> {
    const script = this.outcomes[method]
    const outcome = script.list[Math.min(script.next, script.list.length - 1)]
    if (outcome === undefined) {
      throw new Unscripted(`${method === "execute" ? "executeTransaction" : "simulateTransaction"} (script \`${method}\`)`)
    }
    script.next += 1
    if (outcome._tag === "transportError") throw rpcError(outcome.status, outcome.message)
    if (outcome._tag === "hang") return untilAborted(options)
    const transaction = options.transaction
    // An unbuilt `Transaction` (what `Sui.simulate` of a recipe sends) has no
    // digest until it is built, and building it here would resolve it; it
    // gets a placeholder.
    const digest: string = transaction instanceof Uint8Array
      ? TransactionDataBuilder.getDigestFromBytes(transaction)
      : fakeDigest(this.recorded.length)
    const commandResults = (outcome.value.commandResults ?? []).map((result) => ({
      returnValues: result.returnValues ?? [],
      mutatedReferences: result.mutatedReferences ?? []
    }))
    return { result: transactionResultOf(digest, outcome), commandResults }
  }

  async getObjects(options: SuiClientTypes.GetObjectsOptions) {
    this.record("getObjects", options)
    return {
      objects: options.objectIds.map((objectId) => {
        const object = this.object(objectId)
        return object === undefined
          ? new ObjectError("notFound", `object ${objectId} is not scripted`, { reason: "notFound", objectId })
          : this.sdkObject(object, options.include)
      })
    } as unknown as SuiClientTypes.GetObjectsResponse<never>
  }

  async listOwnedObjects(options: SuiClientTypes.ListOwnedObjectsOptions) {
    this.record("listOwnedObjects", options)
    const objects = this.owned(options.owner).filter((object) =>
      options.type === undefined || typeMatches(options.type, object.type)
    )
    return {
      objects: objects.map((object) => this.sdkObject(object, options.include)),
      hasNextPage: false,
      cursor: null
    } as unknown as SuiClientTypes.ListOwnedObjectsResponse<never>
  }

  async listCoins(options: SuiClientTypes.ListCoinsOptions) {
    this.record("listCoins", options)
    return { objects: this.coins(options.owner, options.coinType ?? SUI_TYPE_ARG), hasNextPage: false, cursor: null }
  }

  async getBalance(options: SuiClientTypes.GetBalanceOptions) {
    this.record("getBalance", options)
    return { balance: this.balance(options.owner, options.coinType ?? SUI_TYPE_ARG) }
  }

  async listBalances(options: SuiClientTypes.ListBalancesOptions) {
    this.record("listBalances", options)
    const owner = normalizeSuiAddress(options.owner)
    const types = new Set<string>()
    for (const key of this.balances.keys()) if (key.startsWith(`${owner}|`)) types.add(key.slice(owner.length + 1))
    for (const object of this.owned(owner)) {
      const coinType = coinTypeOf(object.type)
      if (coinType !== undefined) types.add(coinType)
    }
    return { balances: [...types].map((coinType) => this.balance(owner, coinType)), hasNextPage: false, cursor: null }
  }

  async listDynamicFields(options: SuiClientTypes.ListDynamicFieldsOptions) {
    this.record("listDynamicFields", options)
    const fields = this.script.dynamicFields?.[normalizeSuiAddress(options.parentId)] ?? []
    return { dynamicFields: [...fields], hasNextPage: false, cursor: null }
  }

  /** Matches an entry on the key's type (under `typeMatches`) and, when the entry has them, its bytes. */
  override async getDynamicField(options: SuiClientTypes.GetDynamicFieldOptions) {
    this.record("getDynamicField", options)
    const parentId = normalizeSuiAddress(options.parentId)
    const entry = (this.script.dynamicFields?.[parentId] ?? []).find((field) =>
      typeMatches(options.name.type, field.name.type) && sameBytes(field.name.bcs, options.name.bcs)
    )
    if (entry === undefined) {
      throw new ObjectError("notFound", "dynamic field not found", { reason: "notFound", objectId: parentId })
    }
    const value = this.script.dynamicFieldValues?.[entry.fieldId] ?? { type: entry.valueType, bcs: new Uint8Array() }
    const { valueType: _valueType, ...field } = entry
    return {
      dynamicField: { ...field, value, version: "1", digest: fakeDigest(21), previousTransaction: null }
    } as unknown as SuiClientTypes.GetDynamicFieldResponse
  }

  override async getDynamicObjectField(options: SuiClientTypes.GetDynamicObjectFieldOptions) {
    this.record("getDynamicObjectField", options)
    const parentId = normalizeSuiAddress(options.parentId)
    const wrapped = `0x2::dynamic_object_field::Wrapper<${options.name.type}>`
    const entry = (this.script.dynamicFields?.[parentId] ?? []).find((field) =>
      field.$kind === "DynamicObject" &&
      (typeMatches(options.name.type, field.name.type) || typeMatches(wrapped, field.name.type)) &&
      sameBytes(field.name.bcs, options.name.bcs)
    )
    const child = entry?.childId === undefined ? undefined : this.object(entry.childId)
    if (child === undefined) {
      throw new ObjectError("notFound", "dynamic object field not found", { reason: "notFound", objectId: parentId })
    }
    return { object: this.sdkObject(child, options.include) } as unknown as SuiClientTypes.GetDynamicObjectFieldResponse<
      never
    >
  }

  async getTransaction(options: SuiClientTypes.GetTransactionOptions) {
    this.record("getTransaction", options)
    const answered = this.answered.get(options.digest)
    if (answered === undefined) throw new TransactionError("notFound", options.digest)
    return answered as SuiClientTypes.TransactionResult<never>
  }

  async executeTransaction(options: SuiClientTypes.ExecuteTransactionOptions) {
    this.record("executeTransaction", options)
    const { result } = await this.answer("execute", options as SuiClientTypes.SimulateTransactionOptions)
    // Served again by `getTransaction`, which is what `Tx.submit`'s visibility wait reads.
    this.answered.set((result.Transaction ?? result.FailedTransaction).digest, result)
    return result as SuiClientTypes.TransactionResult<never>
  }

  async simulateTransaction(
    options: SuiClientTypes.SimulateTransactionOptions
  ): Promise<SuiClientTypes.SimulateTransactionResult<never>> {
    this.record("simulateTransaction", options)
    const { result, commandResults } = await this.answer("simulate", options)
    return { ...result, commandResults } as unknown as SuiClientTypes.SimulateTransactionResult<never>
  }

  async getReferenceGasPrice(options?: SuiClientTypes.GetReferenceGasPriceOptions) {
    this.record("getReferenceGasPrice", options)
    return { referenceGasPrice: (this.script.referenceGasPrice ?? 1000n).toString() }
  }

  async getCurrentSystemState(options?: SuiClientTypes.GetCurrentSystemStateOptions) {
    this.record("getCurrentSystemState", options)
    return { systemState: systemState(this.script.epoch ?? DEFAULT_EPOCH, this.script.referenceGasPrice ?? 1000n) }
  }

  async getChainIdentifier(options?: SuiClientTypes.GetChainIdentifierOptions) {
    this.record("getChainIdentifier", options)
    return { chainIdentifier: this.script.chainId ?? DEFAULT_CHAIN_ID }
  }

  resolveTransactionPlugin(): TransactionPlugin {
    return this.resolver
  }

  private unscripted(method: string, options: unknown): Promise<never> {
    this.record(method, options)
    return Promise.reject(new Unscripted(method))
  }

  // Not part of a script: a test that needs one stubs that `SuiCore` method.
  getCoinMetadata = (o: unknown): Promise<never> => this.unscripted("getCoinMetadata", o)
  getProtocolConfig = (o?: unknown): Promise<never> => this.unscripted("getProtocolConfig", o)
  listTransactions = (o: unknown): Promise<never> => this.unscripted("listTransactions", o)
  listEvents = (o: unknown): Promise<never> => this.unscripted("listEvents", o)
  verifyZkLoginSignature = (o: unknown): Promise<never> => this.unscripted("verifyZkLoginSignature", o)
  getMoveFunction = (o: unknown): Promise<never> => this.unscripted("getMoveFunction", o)
  defaultNameServiceName = (o: unknown): Promise<never> => this.unscripted("defaultNameServiceName", o)
  resolveNameServiceAddress = (o: unknown): Promise<never> => this.unscripted("resolveNameServiceAddress", o)
}

/**
 * The scripted `SuiCore`: `SuiCore.layerFromClient` over an SDK `CoreClient`
 * whose reads answer from a {@link FakeScript}, so the production `SuiCore`
 * (error mapping, read retries, request timeouts, spans) runs over it.
 *
 * It serves objects with their exact type and bytes (`getObject`,
 * `getObjects`, `listOwnedObjects` with a `typeMatches` type filter), coins
 * as the `Coin<T>` objects among them (`listCoins`, and `getBalance`'s
 * `coinBalance`), dynamic fields matched on the key's type and bytes, address
 * balances, the Clock object `0x6`, a fixed chain id, epoch and reference gas
 * price, and the scripted `executeTransaction` / `simulateTransaction`
 * answers in order, each stamped with the digest of the bytes it was handed.
 * `getTransaction` serves an execute answer it gave by that digest. A build
 * runs the SDK's own core resolver over these reads (a Move call whose object
 * inputs need `getMoveFunction` is not scripted). Every other method dies
 * naming itself.
 *
 * @since 0.6.0
 */
export class ScriptedSuiCore extends Context.Service<ScriptedSuiCore, ScriptedSuiCoreService>()(
  "@unconfirmed/sui-effect/testing/ScriptedSuiCore"
) {
  /** The handle over a fresh responder for `script`. Never fails. */
  static readonly make = (script: FakeScript = {}): Effect.Effect<ScriptedSuiCoreService> =>
    Effect.sync(() => {
      const client = new ScriptedClient(script)
      return {
        core: makeFromClient(client as unknown as ClientWithCoreApi),
        client: client as unknown as ClientWithCoreApi,
        calls: Effect.sync(() => [...client.recorded]),
        putObject: (object) => Effect.sync(() => void client.objects.set(normalizeSuiAddress(object.objectId), object)),
        setClock: (timestampMs) =>
          Effect.sync(() => {
            client.clockTimestampMs = timestampMs
          }),
        setAddressBalance: (owner, coinType, amount) =>
          Effect.sync(() => void client.balances.set(client.key(owner, coinType), amount)),
        setOutcomes: (method, outcomes) =>
          Effect.sync(() => {
            client.outcomes = { ...client.outcomes, [method]: { list: outcomes, next: 0 } }
          })
      }
    })

  /** Provides `SuiCore` over the responder and the handle that drives it. Never fails. */
  static readonly layer = (script: FakeScript = {}): Layer.Layer<SuiCore | ScriptedSuiCore> => {
    const handle = Layer.effect(ScriptedSuiCore, ScriptedSuiCore.make(script))
    return Layer.merge(handle, Layer.effect(SuiCore, Effect.map(ScriptedSuiCore, (h) => h.core)).pipe(Layer.provide(handle)))
  }
}

/**
 * The lifecycle settings every test layer puts in force: `SubmitConfig.defaults`
 * with a re-send schedule that does not wait, so a test that drives a
 * `SubmissionUnknown` does not sleep on the real clock. A test that is about
 * the schedule sets it with `SubmitConfig.with`.
 *
 * @since 0.4.0
 */
export const testSubmitConfig: Partial<typeof SubmitConfig.defaults> = {
  resubmit: Schedule.forever
}

/**
 * What {@link layerTest} provides: `Sui`, `SuiCore` and the responder's
 * handle.
 *
 * @since 0.5.0
 */
export type TestServices = Sui | SuiCore | ScriptedSuiCore

/**
 * The real `Sui` over the scripted `SuiCore`, with {@link testSubmitConfig} in
 * force. A service built on `Sui` tests over
 * `MyService.layer.pipe(Layer.provideMerge(layerTest(script)))`. It provides no
 * journal: a test that submits provides `Journal.layerMemory`, or runs through
 * {@link SuiTest.provide}.
 *
 * Fails with: `NetworkMismatch` (a `mainnet` or `testnet` script whose chain
 * id is not that network's), `TransportError`.
 */
export const layerTest = (script: FakeScript = {}): Layer.Layer<TestServices, NetworkMismatch | TransportError> =>
  Sui.layerNoDeps.pipe(
    Layer.provideMerge(ScriptedSuiCore.layer(script)),
    Layer.provideMerge(SubmitConfig.layer(testSubmitConfig))
  )

const withHandle = <A>(f: (handle: ScriptedSuiCoreService) => Effect.Effect<A>) =>
  Effect.flatMap(ScriptedSuiCore, f)

/**
 * The helpers that drive the responder from inside an Effect. Every member but
 * `provide` requires `ScriptedSuiCore`, which {@link layerTest} provides.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { layerTest, SuiTest } from "@unconfirmed/sui-effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* SuiTest.setClock(2_000n)
 *   return (yield* SuiTest.calls("getObject")).length
 * }).pipe(Effect.provide(layerTest()))
 * ```
 */
export const SuiTest = {
  /** Inserts or replaces an object. Never fails. */
  putObject: (object: FakeObject): Effect.Effect<void, never, ScriptedSuiCore> =>
    withHandle((h) => h.putObject(object)),
  /** Sets the timestamp the Clock object `0x6` reports, which `Sui.chainTime` reads. Never fails. */
  setClock: (timestampMs: bigint): Effect.Effect<void, never, ScriptedSuiCore> => withHandle((h) => h.setClock(timestampMs)),
  /** Sets `owner`'s address balance of `coinType` (default SUI). Never fails. */
  setAddressBalance: (
    owner: string,
    amount: bigint,
    coinType: string = SUI_TYPE_ARG
  ): Effect.Effect<void, never, ScriptedSuiCore> => withHandle((h) => h.setAddressBalance(owner, coinType, amount)),
  /** Replaces the remaining `executeTransaction` answers. Never fails. */
  scriptExecute: (outcomes: ReadonlyArray<FakeOutcome>): Effect.Effect<void, never, ScriptedSuiCore> =>
    withHandle((h) => h.setOutcomes("execute", outcomes)),
  /** Replaces the remaining `simulateTransaction` answers. Never fails. */
  scriptSimulate: (outcomes: ReadonlyArray<FakeOutcome>): Effect.Effect<void, never, ScriptedSuiCore> =>
    withHandle((h) => h.setOutcomes("simulate", outcomes)),
  /** Every call received, oldest first, optionally of one method. Never fails. */
  calls: (method?: string): Effect.Effect<ReadonlyArray<RecordedCall>, never, ScriptedSuiCore> =>
    withHandle((h) =>
      Effect.map(h.calls, (calls) => method === undefined ? calls : calls.filter((call) => call.method === method))
    ),
  /**
   * Provides `layer` plus a fresh `Journal.layerMemory` and `TestClock`,
   * built locally (`{ local: true }`), so nothing is shared with another test.
   *
   * Fails with: whatever the program and the layer fail with.
   */
  provide:
    <ROut, E>(layer: Layer.Layer<ROut, E>) =>
    <A, E2, R>(effect: Effect.Effect<A, E2, R>): Effect.Effect<A, E | E2, Exclude<R, ROut | TestClock.TestClock>> =>
      Effect.provide(
        effect,
        Layer.mergeAll(layer, Layer.sync(Journal, Journal.makeMemoryUnsafe), TestClock.layer()),
        { local: true }
      )
} as const
