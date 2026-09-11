/**
 * `SuiCore`: a hand-written 1:1 Effect wrap of `ClientWithCoreApi` from
 * `@mysten/sui/client`.
 *
 * Every method of `SuiClientTypes.TransportMethods` is here, none of them
 * optional, with the SDK's `Include` generics preserved so an unrequested field
 * is still statically `undefined`. Every call forwards the Effect's
 * `AbortSignal` into the SDK's `signal` option, so `Effect.timeout` and
 * interruption cancel the request. Every method carries a span named after it.
 *
 * @since 0.1.0
 */
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"
import { isSuiGrpcClient, SuiGrpcClient } from "@mysten/sui/grpc"
import type { TransactionPlugin } from "@mysten/sui/transactions"
import { Config, ConfigProvider, Context, Effect, Layer, Schedule, Schema } from "effect"
import {
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  SimulationFailed,
  TransactionNotFound,
  TransportError
} from "../domain/errors.ts"

import { classifyTransportCause } from "../domain/errors.ts"
import { Digest, executionReasonOf, ExecutionReason, KnownNetwork, ObjectId } from "../domain/schemas.ts"

export { RETRYABLE_GRPC_STATUSES } from "../domain/errors.ts"
export { executionReasonOf } from "../domain/schemas.ts"

const UNKNOWN_REASON = ExecutionReason.cases.Unknown.make({ $kind: "Unknown" })

/** Every failure `mapSdkError` can produce. */
export type SuiCoreError =
  | TransportError
  | ObjectNotFound
  | ObjectDeleted
  | ObjectUnavailable
  | TransactionNotFound
  | SimulationFailed

/** The failures of an object lookup. */
export type ObjectLookupError = ObjectNotFound | ObjectDeleted | ObjectUnavailable | TransportError

/** The failures of a transaction lookup. */
export type TransactionLookupError = TransactionNotFound | TransportError

/** The failures of a simulation. */
export type SimulationLookupError = SimulationFailed | TransportError

const ZERO_OBJECT_ID = ObjectId.make(`0x${"0".repeat(64)}`)
const ZERO_DIGEST = Digest.make("1".repeat(32))

const asObjectId = (value: string | undefined): ObjectId => {
  if (value === undefined) return ZERO_OBJECT_ID
  const decoded = Schema.decodeUnknownOption(ObjectId)(value)
  return decoded._tag === "Some" ? decoded.value : ZERO_OBJECT_ID
}

const asDigest = (value: string): Digest => {
  const decoded = Schema.decodeUnknownOption(Digest)(value)
  return decoded._tag === "Some" ? decoded.value : ZERO_DIGEST
}

/**
 * A thrown value carrying this symbol is a bug in the caller or in a test
 * double, not a transport failure. `mapSdkError` re-throws it so it surfaces as
 * a defect instead of being classified as a `TransportError`.
 */
export const DefectMarker: unique symbol = Symbol.for("sui-effect/DefectMarker")

const rethrowDefects = (cause: unknown): void => {
  if (typeof cause === "object" && cause !== null && DefectMarker in cause) throw cause
}

const transportError = (method: string, cause: unknown): TransportError => {
  rethrowDefects(cause)
  return TransportError.fromUnknown(method, cause)
}

/**
 * The one place an SDK failure becomes a sui-effect failure.
 *
 * `ObjectError` maps by its transport-neutral `reason`, `TransactionError` to
 * `TransactionNotFound`, `SimulationError` to `SimulationFailed` with its
 * `executionError` decoded into an `ExecutionReason`, and everything else
 * (gRPC `RpcError`, `SuiHTTPStatusError`, `JsonRpcError`, `Cause.TimeoutError`,
 * any thrown value at all) to a `TransportError` whose `retryable` says whether
 * a read may try again.
 *
 * Total on every value a transport can throw. The one exception is a value
 * carrying {@link DefectMarker}, which is a bug in the caller or in a test
 * double rather than a transport failure: that is re-thrown so it surfaces as a
 * defect instead of being mislabelled a `TransportError`.
 */
export const mapSdkError = (method: string, cause: unknown): SuiCoreError => {
  rethrowDefects(cause)
  if (cause instanceof ObjectError) {
    const objectId = asObjectId(cause.objectId)
    switch (cause.reason) {
      case "notFound":
        return new ObjectNotFound({ objectId })
      case "deleted":
        return new ObjectDeleted({ objectId })
      default:
        return new ObjectUnavailable({ objectId })
    }
  }
  if (cause instanceof TransactionError) {
    return new TransactionNotFound({ digest: asDigest(cause.digest) })
  }
  if (cause instanceof SimulationError) {
    // The SDK's resolve plugin simulates to choose a gas budget and wraps
    // *whatever went wrong* in a `SimulationError`, transport failures
    // included: a rejected fetch, a gRPC `UNAVAILABLE`, an HTTP 503. Only a
    // wrapper carrying an `executionError` describes a transaction that would
    // abort on chain; the rest are the node being unreachable, and calling
    // those `SimulationFailed` loses both the status and the retryability a
    // caller needs.
    if (cause.executionError === undefined) {
      const transport = transportCauseOf(cause)
      if (transport !== undefined) {
        return new TransportError({
          method,
          retryable: transport.retryable,
          ...(transport.status === undefined ? {} : { status: transport.status }),
          cause: cause.cause ?? cause
        })
      }
    }
    return new SimulationFailed({
      reason:
        cause.executionError === undefined ? UNKNOWN_REASON : executionReasonOf(cause.executionError),
      message: cause.message
    })
  }
  return transportError(method, cause)
}

/**
 * The transport failure a `SimulationError` is carrying, if it is carrying one.
 *
 * `classifyTransportCause` recognises a gRPC `RpcError` by its `code`, an HTTP
 * status error by its numeric `status`, and an abort or timeout by its `name`.
 * A cause it does not recognise — a plain `Error` the resolver threw itself —
 * is not a transport failure and the wrapper stays `SimulationFailed`. The
 * chain is walked one level at a time because grpc-web wraps a rejected fetch
 * once more on its way out. Never fails.
 */
const transportCauseOf = (
  error: { readonly cause?: unknown }
): { readonly status?: string; readonly retryable: boolean } | undefined => {
  let current: unknown = error.cause
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    const classified = classifyTransportCause(current)
    if (classified.status !== undefined) return classified
    if (current instanceof TypeError) {
      // A rejected `fetch` is a bare `TypeError` with no status of any kind;
      // it is still the network, and still worth retrying.
      return { retryable: true }
    }
    current = (current as { readonly cause?: unknown }).cause
  }
  return undefined
}

/** Narrows `mapSdkError` to the union an object lookup declares. */
const objectError = (method: string) => (cause: unknown): ObjectLookupError => {
  const error = mapSdkError(method, cause)
  return error._tag === "TransactionNotFound" || error._tag === "SimulationFailed"
    ? transportError(method, cause)
    : error
}

/** Narrows `mapSdkError` to the union a transaction lookup declares. */
const transactionError = (method: string) => (cause: unknown): TransactionLookupError => {
  const error = mapSdkError(method, cause)
  return error._tag === "TransactionNotFound" || error._tag === "TransportError"
    ? error
    : transportError(method, cause)
}

/** Narrows `mapSdkError` to the union a simulation declares. */
const simulationError = (method: string) => (cause: unknown): SimulationLookupError => {
  const error = mapSdkError(method, cause)
  return error._tag === "SimulationFailed" || error._tag === "TransportError"
    ? error
    : transportError(method, cause)
}

/** Everything else: any failure at all becomes a `TransportError`. */
const onlyTransportError = (method: string) => (cause: unknown): TransportError =>
  transportError(method, cause)

/**
 * The read retry policy from the spec: jittered exponential backoff capped at a
 * ten second gap, at most five attempts, and only while the failure is a
 * retryable `TransportError`.
 */
export const readSchedule = Schedule.min([
  Schedule.exponential("250 millis"),
  Schedule.spaced("10 seconds")
]).pipe(Schedule.jittered)

const MAX_READ_ATTEMPTS = 5

const retryReads = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    schedule: readSchedule,
    times: MAX_READ_ATTEMPTS - 1,
    while: (error: E) =>
      error._tag === "TransportError" && (error as unknown as TransportError).retryable
  })

type ObjectInclude = SuiClientTypes.ObjectInclude
type TransactionInclude = SuiClientTypes.TransactionInclude
type SimulateInclude = SuiClientTypes.SimulateTransactionInclude

/**
 * What a versioned object read found: the object as it was at that exact
 * version, with the digest of the transaction that produced it, or nothing at
 * all with a reason a log can print.
 */
export type VersionedObject =
  | {
    readonly _tag: "Found"
    readonly objectId: string
    readonly version: string
    readonly previousTransaction: string | undefined
  }
  | { readonly _tag: "Absent"; readonly reason: string }

/**
 * The mechanical tier: one member per `SuiClientTypes.TransportMethods` key,
 * plus the four concrete conveniences `CoreClient` adds and the `use` hatch.
 */
export interface SuiCoreService {
  /** The network the underlying client was constructed for. */
  readonly network: SuiClientTypes.Network

  /** Reads a batch of objects. Per-item failures are `Error` values in the result. Fails with: `TransportError`. */
  readonly getObjects: <Include extends ObjectInclude = {}>(
    options: SuiClientTypes.GetObjectsOptions<Include>
  ) => Effect.Effect<SuiClientTypes.GetObjectsResponse<Include>, TransportError>

  /** Reads one object. Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`, `TransportError`. */
  readonly getObject: <Include extends ObjectInclude = {}>(
    options: SuiClientTypes.GetObjectOptions<Include>
  ) => Effect.Effect<SuiClientTypes.GetObjectResponse<Include>, ObjectLookupError>

  /** One page of the objects an address owns. Fails with: `TransportError`. */
  readonly listOwnedObjects: <Include extends ObjectInclude = {}>(
    options: SuiClientTypes.ListOwnedObjectsOptions<Include>
  ) => Effect.Effect<SuiClientTypes.ListOwnedObjectsResponse<Include>, TransportError>

  /** One page of the coins an address owns. Fails with: `TransportError`. */
  readonly listCoins: (
    options: SuiClientTypes.ListCoinsOptions
  ) => Effect.Effect<SuiClientTypes.ListCoinsResponse, TransportError>

  /** One page of a parent object's dynamic fields. Fails with: `TransportError`. */
  readonly listDynamicFields: (
    options: SuiClientTypes.ListDynamicFieldsOptions
  ) => Effect.Effect<SuiClientTypes.ListDynamicFieldsResponse, TransportError>

  /** Reads one dynamic field. Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`, `TransportError`. */
  readonly getDynamicField: (
    options: SuiClientTypes.GetDynamicFieldOptions
  ) => Effect.Effect<SuiClientTypes.GetDynamicFieldResponse, ObjectLookupError>

  /** Reads one dynamic object field. Fails with: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`, `TransportError`. */
  readonly getDynamicObjectField: <Include extends ObjectInclude = {}>(
    options: SuiClientTypes.GetDynamicObjectFieldOptions<Include>
  ) => Effect.Effect<SuiClientTypes.GetDynamicObjectFieldResponse<Include>, ObjectLookupError>

  /** The balance of one coin type for one owner. Fails with: `TransportError`. */
  readonly getBalance: (
    options: SuiClientTypes.GetBalanceOptions
  ) => Effect.Effect<SuiClientTypes.GetBalanceResponse, TransportError>

  /** One page of every balance an owner holds. Fails with: `TransportError`. */
  readonly listBalances: (
    options: SuiClientTypes.ListBalancesOptions
  ) => Effect.Effect<SuiClientTypes.ListBalancesResponse, TransportError>

  /** Coin metadata for a coin type. Fails with: `TransportError`. */
  readonly getCoinMetadata: (
    options: SuiClientTypes.GetCoinMetadataOptions
  ) => Effect.Effect<SuiClientTypes.GetCoinMetadataResponse, TransportError>

  /** Reads an executed transaction by digest. Fails with: `TransactionNotFound`, `TransportError`. */
  readonly getTransaction: <Include extends TransactionInclude = {}>(
    options: SuiClientTypes.GetTransactionOptions<Include>
  ) => Effect.Effect<SuiClientTypes.TransactionResult<Include>, TransactionLookupError>

  /** Submits signed bytes. Never retried at this tier. Fails with: `TransportError`. */
  readonly executeTransaction: <Include extends TransactionInclude = {}>(
    options: SuiClientTypes.ExecuteTransactionOptions<Include>
  ) => Effect.Effect<SuiClientTypes.TransactionResult<Include>, TransportError>

  /** Signs and submits in one call. Never retried at this tier. Fails with: `TransportError`. */
  readonly signAndExecuteTransaction: <Include extends TransactionInclude = {}>(
    options: SuiClientTypes.SignAndExecuteTransactionOptions<Include>
  ) => Effect.Effect<SuiClientTypes.TransactionResult<Include>, TransportError>

  /**
   * Reads one object **at a specific version**, for the one question the
   * live-object read cannot answer: which transaction consumed the version a
   * set of bytes pinned.
   *
   * `previousTransaction` on the *current* object names the latest mutation,
   * which is not necessarily the consumer of an older version: T can consume
   * version 3 and U version 4, and the live object then names U. The consumer
   * of version `v` is named by the object at version `v + 1`.
   *
   * The SDK's `GetObjectOptions` carries no version, so this is not a wrap of a
   * Core method: it reaches the transport's own historical read — the gRPC
   * `LedgerService.GetObject` with a `version`, or JSON-RPC
   * `sui_tryGetPastObject` — and answers `Absent` on any transport that has
   * neither, on a version that was pruned, and on an object that never had it.
   * `Absent` is never evidence of anything; a caller that needs proof treats it
   * as "unknown".
   *
   * Fails with: `TransportError`.
   */
  readonly getObjectAtVersion: (
    options: { readonly objectId: string; readonly version: string | bigint }
  ) => Effect.Effect<VersionedObject, TransportError>

  /** Polls until a digest is visible. Fails with: `TransactionNotFound`, `TransportError`. */
  readonly waitForTransaction: <Include extends TransactionInclude = {}>(
    options: SuiClientTypes.WaitForTransactionOptions<Include>
  ) => Effect.Effect<SuiClientTypes.TransactionResult<Include>, TransactionLookupError>

  /** Simulates a transaction. Fails with: `SimulationFailed`, `TransportError`. */
  readonly simulateTransaction: <Include extends SimulateInclude = {}>(
    options: SuiClientTypes.SimulateTransactionOptions<Include>
  ) => Effect.Effect<SuiClientTypes.SimulateTransactionResult<Include>, SimulationLookupError>

  /** One page of transaction history. Fails with: `TransportError`. */
  readonly listTransactions: <Include extends TransactionInclude = {}>(
    options: SuiClientTypes.ListTransactionsOptions<Include>
  ) => Effect.Effect<SuiClientTypes.ListTransactionsResponse<Include>, TransportError>

  /** One page of events. Fails with: `TransportError`. */
  readonly listEvents: (
    options: SuiClientTypes.ListEventsOptions
  ) => Effect.Effect<SuiClientTypes.ListEventsResponse, TransportError>

  /** The current reference gas price. Fails with: `TransportError`. */
  readonly getReferenceGasPrice: (
    options?: SuiClientTypes.GetReferenceGasPriceOptions
  ) => Effect.Effect<SuiClientTypes.GetReferenceGasPriceResponse, TransportError>

  /** The current system state. Fails with: `TransportError`. */
  readonly getCurrentSystemState: (
    options?: SuiClientTypes.GetCurrentSystemStateOptions
  ) => Effect.Effect<SuiClientTypes.GetCurrentSystemStateResponse, TransportError>

  /** The protocol config. Fails with: `TransportError`. */
  readonly getProtocolConfig: (
    options?: SuiClientTypes.GetProtocolConfigOptions
  ) => Effect.Effect<SuiClientTypes.GetProtocolConfigResponse, TransportError>

  /** The genesis checkpoint digest identifying the network. Fails with: `TransportError`. */
  readonly getChainIdentifier: (
    options?: SuiClientTypes.GetChainIdentifierOptions
  ) => Effect.Effect<SuiClientTypes.GetChainIdentifierResponse, TransportError>

  /** Move function metadata. Fails with: `TransportError`. */
  readonly getMoveFunction: (
    options: SuiClientTypes.GetMoveFunctionOptions
  ) => Effect.Effect<SuiClientTypes.GetMoveFunctionResponse, TransportError>

  /** Verifies a zkLogin signature. Fails with: `TransportError`. */
  readonly verifyZkLoginSignature: (
    options: SuiClientTypes.VerifyZkLoginSignatureOptions
  ) => Effect.Effect<SuiClientTypes.ZkLoginVerifyResponse, TransportError>

  /** Resolves a SuiNS name to an address. Fails with: `TransportError`. */
  readonly resolveNameServiceAddress: (
    options: SuiClientTypes.ResolveNameServiceAddressOptions
  ) => Effect.Effect<SuiClientTypes.ResolveNameServiceAddressResponse, TransportError>

  /** The default SuiNS name of an address. Fails with: `TransportError`. */
  readonly defaultNameServiceName: (
    options: SuiClientTypes.DefaultNameServiceNameOptions
  ) => Effect.Effect<SuiClientTypes.DefaultNameServiceNameResponse, TransportError>

  /** Move Registry resolution. Each member fails with: `TransportError`. */
  readonly mvr: {
    readonly resolvePackage: (
      options: SuiClientTypes.MvrResolvePackageOptions
    ) => Effect.Effect<SuiClientTypes.MvrResolvePackageResponse, TransportError>
    readonly resolveType: (
      options: SuiClientTypes.MvrResolveTypeOptions
    ) => Effect.Effect<SuiClientTypes.MvrResolveTypeResponse, TransportError>
    readonly resolve: (
      options: SuiClientTypes.MvrResolveOptions
    ) => Effect.Effect<SuiClientTypes.MvrResolveResponse, TransportError>
  }

  /**
   * The transport's build plugin, which the transaction builder needs to
   * resolve inputs. A pure value constructor, wrapped in an Effect only so the
   * fake can refuse it. Never fails.
   */
  readonly resolveTransactionPlugin: () => Effect.Effect<TransactionPlugin>

  /**
   * The low-level hatch: run one call against the SDK client object with the
   * Effect's `AbortSignal` already forwarded.
   *
   * Fails with the full `mapSdkError` union: `TransportError`, `ObjectNotFound`,
   * `ObjectDeleted`, `ObjectUnavailable`, `TransactionNotFound`,
   * `SimulationFailed`.
   */
  readonly use: <A>(
    run: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>
  ) => Effect.Effect<A, SuiCoreError>
}

/**
 * The mechanical tier over `@mysten/sui`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiCore } from "sui-effect"
 *
 * const chainId = Effect.gen(function*() {
 *   const core = yield* SuiCore
 *   const { chainIdentifier } = yield* core.getChainIdentifier()
 *   return chainIdentifier
 * })
 * ```
 */
export class SuiCore extends Context.Service<SuiCore, SuiCoreService>()("sui-effect/SuiCore") {
  /** Wraps a client the caller already built and configured. */
  static readonly layerFromClient = (client: ClientWithCoreApi): Layer.Layer<SuiCore> =>
    Layer.succeed(SuiCore, makeFromClient(client))

  /** Builds a `SuiGrpcClient` and wraps it. */
  static readonly layerGrpc = (options: SuiGrpcLayerOptions): Layer.Layer<SuiCore> =>
    Layer.sync(SuiCore, () => makeFromClient(makeGrpcClient(options)))

  /**
   * Reads `SUI_NETWORK` (required, no default) and `SUI_RPC_URL` (optional,
   * defaulted from {@link defaultGrpcUrl} for the four known networks).
   *
   * The layer fails with `ConfigError` when `SUI_NETWORK` is missing, or when
   * it names a network with no built-in URL and `SUI_RPC_URL` is not set.
   */
  static readonly layerConfig: Layer.Layer<SuiCore, Config.ConfigError> = Layer.effect(
    SuiCore,
    Effect.gen(function*() {
      const network = yield* Config.nonEmptyString("SUI_NETWORK")
      const baseUrl = yield* Config.nonEmptyString("SUI_RPC_URL").pipe(
        Config.orElse(() => {
          const fallback = defaultGrpcUrl(network)
          return fallback === undefined
            ? Config.fail(
                new ConfigProvider.SourceError({
                  message: `SUI_RPC_URL is required: no built-in gRPC endpoint for network "${network}"`
                })
              ).pipe(Config.map(String))
            : Config.succeed(fallback)
        })
      )
      return makeFromClient(makeGrpcClient({ network, baseUrl }))
    })
  )
}

/** Options for {@link SuiCore.layerGrpc}, mirroring `SuiGrpcClientOptions`. */
export interface SuiGrpcLayerOptions {
  readonly network: SuiClientTypes.Network
  readonly baseUrl: string
  readonly timeout?: number
  readonly mvr?: SuiClientTypes.MvrOptions
}

/**
 * The gRPC endpoint sui-effect uses when `SUI_RPC_URL` is not set. The SDK
 * ships no such table; these are the URLs its own documentation uses.
 * Returns `undefined` for any other network. Never fails.
 */
export const defaultGrpcUrl = (network: string): string | undefined => {
  const decoded = Schema.decodeUnknownOption(KnownNetwork)(network)
  if (decoded._tag !== "Some") return undefined
  switch (decoded.value) {
    case "mainnet":
      return "https://fullnode.mainnet.sui.io:443"
    case "testnet":
      return "https://fullnode.testnet.sui.io:443"
    case "devnet":
      return "https://fullnode.devnet.sui.io:443"
    case "localnet":
      return "http://127.0.0.1:9000"
  }
}

const makeGrpcClient = (options: SuiGrpcLayerOptions): ClientWithCoreApi =>
  new SuiGrpcClient({
    network: options.network,
    baseUrl: options.baseUrl,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.mvr === undefined ? {} : { mvr: options.mvr })
  })

/**
 * The JSON-RPC shape of a historical object read, duck-typed rather than
 * imported: `@mysten/sui/jsonRpc` is a deprecated subpath and pulling it into
 * this module for one optional call would put the whole JSON-RPC client in
 * every bundle. A client that has `tryGetPastObject` answers the question; one
 * that does not, does not.
 */
interface PastObjectCapable {
  readonly tryGetPastObject: (options: {
    readonly id: string
    readonly version: number
    readonly options?: { readonly showPreviousTransaction?: boolean }
    readonly signal?: AbortSignal
  }) => Promise<
    | { readonly status: "VersionFound"; readonly details: { version: string; previousTransaction?: string | null } }
    | { readonly status: string; readonly details: unknown }
  >
}

const hasPastObject = (client: unknown): client is PastObjectCapable =>
  typeof (client as { readonly tryGetPastObject?: unknown }).tryGetPastObject === "function"

const NOT_FOUND_STATUSES: ReadonlySet<string> = new Set(["NOT_FOUND", "5"])

/**
 * One historical object read, on whichever transport the client is.
 *
 * gRPC's `LedgerService.GetObject` takes a `version` and a read mask; JSON-RPC
 * has `sui_tryGetPastObject`. Everything else — a hand-written client, a test
 * double with neither — answers `Absent`, because a transport that cannot read
 * history must not be allowed to look like a transport that read history and
 * found nothing.
 */
const readObjectAtVersion = async (
  client: ClientWithCoreApi,
  objectId: string,
  version: bigint,
  signal: AbortSignal
): Promise<VersionedObject> => {
  if (isSuiGrpcClient(client)) {
    try {
      const { response } = await client.ledgerService.getObject(
        {
          objectId,
          version,
          readMask: { paths: ["object_id", "version", "previous_transaction"] }
        },
        { abort: signal }
      )
      const object = response.object
      if (object === undefined || object.version === undefined) {
        return { _tag: "Absent", reason: `the node served no object ${objectId} at version ${version}` }
      }
      return {
        _tag: "Found",
        objectId,
        version: object.version.toString(),
        previousTransaction: object.previousTransaction ?? undefined
      }
    } catch (cause) {
      const code = (cause as { readonly code?: unknown }).code
      if (typeof code === "string" && NOT_FOUND_STATUSES.has(code)) {
        return { _tag: "Absent", reason: `version ${version} of ${objectId} is not served (pruned or never existed)` }
      }
      throw cause
    }
  }
  if (hasPastObject(client)) {
    const read = await client.tryGetPastObject({
      id: objectId,
      version: Number(version),
      options: { showPreviousTransaction: true },
      signal
    })
    if (read.status !== "VersionFound") {
      return { _tag: "Absent", reason: `sui_tryGetPastObject answered ${read.status} for ${objectId} at version ${version}` }
    }
    const details = read.details as { version: string; previousTransaction?: string | null }
    return {
      _tag: "Found",
      objectId,
      version: String(details.version),
      previousTransaction: details.previousTransaction ?? undefined
    }
  }
  return {
    _tag: "Absent",
    reason: "this transport cannot read an object at a past version"
  }
}

/**
 * Wraps a client object into the service. Exported so `SuiExtension.fromService`
 * and tests can build the same implementation over any `ClientWithCoreApi`.
 */
export const makeFromClient = (client: ClientWithCoreApi): SuiCoreService => {
  // Every member below is an `Effect.fn("SuiCore.<method>")`, so the span is
  // named after the method and `call` does not add one of its own.
  const call = <A, E>(
    _method: string,
    run: (core: ClientWithCoreApi["core"], signal: AbortSignal) => Promise<A>,
    onError: (cause: unknown) => E
  ): Effect.Effect<A, E> =>
    Effect.tryPromise({
      try: (signal) => run(client.core, signal),
      catch: onError
    })

  const read = <A, E extends { readonly _tag: string }>(
    method: string,
    run: (core: ClientWithCoreApi["core"], signal: AbortSignal) => Promise<A>,
    onError: (cause: unknown) => E
  ): Effect.Effect<A, E> => retryReads(call(method, run, onError))

  return {
    network: client.network,
    getObjects: Effect.fn("SuiCore.getObjects")(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetObjectsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetObjectsResponse<Include>, TransportError> {
      return yield* read(
        "getObjects",
        (core, signal) => core.getObjects({ ...options, signal }),
        onlyTransportError("getObjects")
      )
    }),
    getObject: Effect.fn("SuiCore.getObject")(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetObjectOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetObjectResponse<Include>, ObjectLookupError> {
      return yield* read(
        "getObject",
        (core, signal) => core.getObject({ ...options, signal }),
        objectError("getObject")
      )
    }),
    listOwnedObjects: Effect.fn("SuiCore.listOwnedObjects")(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.ListOwnedObjectsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.ListOwnedObjectsResponse<Include>, TransportError> {
      return yield* read(
        "listOwnedObjects",
        (core, signal) => core.listOwnedObjects({ ...options, signal }),
        onlyTransportError("listOwnedObjects")
      )
    }),
    listCoins: Effect.fn("SuiCore.listCoins")(function*(
      options: SuiClientTypes.ListCoinsOptions
    ): Effect.fn.Return<SuiClientTypes.ListCoinsResponse, TransportError> {
      return yield* read(
        "listCoins",
        (core, signal) => core.listCoins({ ...options, signal }),
        onlyTransportError("listCoins")
      )
    }),
    listDynamicFields: Effect.fn("SuiCore.listDynamicFields")(function*(
      options: SuiClientTypes.ListDynamicFieldsOptions
    ): Effect.fn.Return<SuiClientTypes.ListDynamicFieldsResponse, TransportError> {
      return yield* read(
        "listDynamicFields",
        (core, signal) => core.listDynamicFields({ ...options, signal }),
        onlyTransportError("listDynamicFields")
      )
    }),
    getDynamicField: Effect.fn("SuiCore.getDynamicField")(function*(
      options: SuiClientTypes.GetDynamicFieldOptions
    ): Effect.fn.Return<SuiClientTypes.GetDynamicFieldResponse, ObjectLookupError> {
      return yield* read(
        "getDynamicField",
        (core, signal) => core.getDynamicField({ ...options, signal }),
        objectError("getDynamicField")
      )
    }),
    getDynamicObjectField: Effect.fn("SuiCore.getDynamicObjectField")(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetDynamicObjectFieldOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetDynamicObjectFieldResponse<Include>, ObjectLookupError> {
      return yield* read(
        "getDynamicObjectField",
        (core, signal) => core.getDynamicObjectField({ ...options, signal }),
        objectError("getDynamicObjectField")
      )
    }),
    getBalance: Effect.fn("SuiCore.getBalance")(function*(
      options: SuiClientTypes.GetBalanceOptions
    ): Effect.fn.Return<SuiClientTypes.GetBalanceResponse, TransportError> {
      return yield* read(
        "getBalance",
        (core, signal) => core.getBalance({ ...options, signal }),
        onlyTransportError("getBalance")
      )
    }),
    listBalances: Effect.fn("SuiCore.listBalances")(function*(
      options: SuiClientTypes.ListBalancesOptions
    ): Effect.fn.Return<SuiClientTypes.ListBalancesResponse, TransportError> {
      return yield* read(
        "listBalances",
        (core, signal) => core.listBalances({ ...options, signal }),
        onlyTransportError("listBalances")
      )
    }),
    getCoinMetadata: Effect.fn("SuiCore.getCoinMetadata")(function*(
      options: SuiClientTypes.GetCoinMetadataOptions
    ): Effect.fn.Return<SuiClientTypes.GetCoinMetadataResponse, TransportError> {
      return yield* read(
        "getCoinMetadata",
        (core, signal) => core.getCoinMetadata({ ...options, signal }),
        onlyTransportError("getCoinMetadata")
      )
    }),
    getTransaction: Effect.fn("SuiCore.getTransaction")(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.GetTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransactionLookupError> {
      return yield* read(
        "getTransaction",
        (core, signal) => core.getTransaction({ ...options, signal }),
        transactionError("getTransaction")
      )
    }),
    executeTransaction: Effect.fn("SuiCore.executeTransaction")(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.ExecuteTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransportError> {
      return yield* call(
        "executeTransaction",
        (core, signal) => core.executeTransaction({ ...options, signal }),
        onlyTransportError("executeTransaction")
      )
    }),
    signAndExecuteTransaction: Effect.fn("SuiCore.signAndExecuteTransaction")(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.SignAndExecuteTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransportError> {
      return yield* call(
        "signAndExecuteTransaction",
        (core, signal) => core.signAndExecuteTransaction({ ...options, signal }),
        onlyTransportError("signAndExecuteTransaction")
      )
    }),
    getObjectAtVersion: Effect.fn("SuiCore.getObjectAtVersion")(function*(
      options: { readonly objectId: string; readonly version: string | bigint }
    ): Effect.fn.Return<VersionedObject, TransportError> {
      return yield* retryReads(
        Effect.tryPromise({
          try: (signal) =>
            readObjectAtVersion(client, options.objectId, BigInt(options.version), signal),
          catch: onlyTransportError("getObjectAtVersion")
        })
      )
    }),
    waitForTransaction: Effect.fn("SuiCore.waitForTransaction")(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.WaitForTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransactionLookupError> {
      return yield* read(
        "waitForTransaction",
        (core, signal) => core.waitForTransaction({ ...options, signal }),
        transactionError("waitForTransaction")
      )
    }),
    simulateTransaction: Effect.fn("SuiCore.simulateTransaction")(function*<Include extends SimulateInclude = {}>(
      options: SuiClientTypes.SimulateTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.SimulateTransactionResult<Include>, SimulationLookupError> {
      return yield* read(
        "simulateTransaction",
        (core, signal) => core.simulateTransaction({ ...options, signal }),
        simulationError("simulateTransaction")
      )
    }),
    listTransactions: Effect.fn("SuiCore.listTransactions")(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.ListTransactionsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.ListTransactionsResponse<Include>, TransportError> {
      return yield* read(
        "listTransactions",
        (core, signal) => core.listTransactions({ ...options, signal }),
        onlyTransportError("listTransactions")
      )
    }),
    listEvents: Effect.fn("SuiCore.listEvents")(function*(
      options: SuiClientTypes.ListEventsOptions
    ): Effect.fn.Return<SuiClientTypes.ListEventsResponse, TransportError> {
      return yield* read(
        "listEvents",
        (core, signal) => core.listEvents({ ...options, signal }),
        onlyTransportError("listEvents")
      )
    }),
    getReferenceGasPrice: Effect.fn("SuiCore.getReferenceGasPrice")(function*(
      options?: SuiClientTypes.GetReferenceGasPriceOptions
    ): Effect.fn.Return<SuiClientTypes.GetReferenceGasPriceResponse, TransportError> {
      return yield* read(
        "getReferenceGasPrice",
        (core, signal) => core.getReferenceGasPrice({ ...options, signal }),
        onlyTransportError("getReferenceGasPrice")
      )
    }),
    getCurrentSystemState: Effect.fn("SuiCore.getCurrentSystemState")(function*(
      options?: SuiClientTypes.GetCurrentSystemStateOptions
    ): Effect.fn.Return<SuiClientTypes.GetCurrentSystemStateResponse, TransportError> {
      return yield* read(
        "getCurrentSystemState",
        (core, signal) => core.getCurrentSystemState({ ...options, signal }),
        onlyTransportError("getCurrentSystemState")
      )
    }),
    getProtocolConfig: Effect.fn("SuiCore.getProtocolConfig")(function*(
      options?: SuiClientTypes.GetProtocolConfigOptions
    ): Effect.fn.Return<SuiClientTypes.GetProtocolConfigResponse, TransportError> {
      return yield* read(
        "getProtocolConfig",
        (core, signal) => core.getProtocolConfig({ ...options, signal }),
        onlyTransportError("getProtocolConfig")
      )
    }),
    getChainIdentifier: Effect.fn("SuiCore.getChainIdentifier")(function*(
      options?: SuiClientTypes.GetChainIdentifierOptions
    ): Effect.fn.Return<SuiClientTypes.GetChainIdentifierResponse, TransportError> {
      return yield* read(
        "getChainIdentifier",
        (core, signal) => core.getChainIdentifier({ ...options, signal }),
        onlyTransportError("getChainIdentifier")
      )
    }),
    getMoveFunction: Effect.fn("SuiCore.getMoveFunction")(function*(
      options: SuiClientTypes.GetMoveFunctionOptions
    ): Effect.fn.Return<SuiClientTypes.GetMoveFunctionResponse, TransportError> {
      return yield* read(
        "getMoveFunction",
        (core, signal) => core.getMoveFunction({ ...options, signal }),
        onlyTransportError("getMoveFunction")
      )
    }),
    verifyZkLoginSignature: Effect.fn("SuiCore.verifyZkLoginSignature")(function*(
      options: SuiClientTypes.VerifyZkLoginSignatureOptions
    ): Effect.fn.Return<SuiClientTypes.ZkLoginVerifyResponse, TransportError> {
      return yield* read(
        "verifyZkLoginSignature",
        (core, signal) => core.verifyZkLoginSignature({ ...options, signal }),
        onlyTransportError("verifyZkLoginSignature")
      )
    }),
    resolveNameServiceAddress: Effect.fn("SuiCore.resolveNameServiceAddress")(function*(
      options: SuiClientTypes.ResolveNameServiceAddressOptions
    ): Effect.fn.Return<SuiClientTypes.ResolveNameServiceAddressResponse, TransportError> {
      return yield* read(
        "resolveNameServiceAddress",
        (core, signal) => core.resolveNameServiceAddress({ ...options, signal }),
        onlyTransportError("resolveNameServiceAddress")
      )
    }),
    defaultNameServiceName: Effect.fn("SuiCore.defaultNameServiceName")(function*(
      options: SuiClientTypes.DefaultNameServiceNameOptions
    ): Effect.fn.Return<SuiClientTypes.DefaultNameServiceNameResponse, TransportError> {
      return yield* read(
        "defaultNameServiceName",
        (core, signal) => core.defaultNameServiceName({ ...options, signal }),
        onlyTransportError("defaultNameServiceName")
      )
    }),
    mvr: {
      resolvePackage: Effect.fn("SuiCore.mvr.resolvePackage")(function*(
        options: SuiClientTypes.MvrResolvePackageOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolvePackageResponse, TransportError> {
        return yield* read(
          "mvr.resolvePackage",
          (core, signal) => core.mvr.resolvePackage({ ...options, signal }),
          onlyTransportError("mvr.resolvePackage")
        )
      }),
      resolveType: Effect.fn("SuiCore.mvr.resolveType")(function*(
        options: SuiClientTypes.MvrResolveTypeOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolveTypeResponse, TransportError> {
        return yield* read(
          "mvr.resolveType",
          (core, signal) => core.mvr.resolveType({ ...options, signal }),
          onlyTransportError("mvr.resolveType")
        )
      }),
      resolve: Effect.fn("SuiCore.mvr.resolve")(function*(
        options: SuiClientTypes.MvrResolveOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolveResponse, TransportError> {
        return yield* read(
          "mvr.resolve",
          (core, signal) => core.mvr.resolve({ ...options, signal }),
          onlyTransportError("mvr.resolve")
        )
      })
    },
    resolveTransactionPlugin: Effect.fn("SuiCore.resolveTransactionPlugin")(
      function*(): Effect.fn.Return<TransactionPlugin> {
        return yield* Effect.sync(() => client.core.resolveTransactionPlugin())
      }
    ),
    use: Effect.fn("SuiCore.use")(function*<A>(
      run: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>
    ): Effect.fn.Return<A, SuiCoreError> {
      return yield* Effect.tryPromise({
        try: (signal) => run(client, signal),
        catch: (cause) => mapSdkError("use", cause)
      })
    })
  }
}
