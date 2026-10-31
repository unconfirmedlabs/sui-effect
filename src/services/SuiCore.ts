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
import { Config, ConfigProvider, Context, Duration, Effect, Layer, Option, Predicate, Schedule, Schema } from "effect"
import {
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  SimulationFailed,
  TransactionNotFound,
  TransportError
} from "../domain/errors.ts"

import { classifyTransportCause } from "../domain/errors.ts"
import * as Metrics from "../domain/metrics.ts"
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
  if (Predicate.hasProperty(cause, DefectMarker)) throw cause
}

/**
 * The messages the SDK throws, before any request is made, when the *caller*
 * passed an argument it cannot act on: a filter with no predicate or two, a
 * malformed function or event filter, a function filter that cannot be
 * paginated, contradictory pagination bounds.
 *
 * Those are bugs in the calling program, not the network: retrying cannot help
 * and a `TransportError` says the wrong thing about where to look. So they are
 * re-thrown and surface as a defect carrying the SDK's own sentence. Matched by
 * message because the SDK throws a plain `Error` for them; a message this list
 * does not know falls back to a `TransportError`, which is what it always was.
 */
const SDK_ARGUMENT_ERRORS: ReadonlyArray<string> = [
  "Paginating transactions filtered by function requires",
  "Invalid function filter",
  "Invalid emitModule filter",
  "Invalid eventType filter",
  "filter must specify exactly one of",
  "Only one of `after` or `before` may be provided",
  "`after` can not be combined with descending",
  "`before` can not be combined with ascending"
]

/** Whether a thrown value is one of the SDK's caller-argument refusals. Never fails. */
const isSdkArgumentError = (cause: unknown): cause is Error =>
  cause instanceof Error &&
  cause.constructor === Error &&
  !Predicate.hasProperty(cause, "code") &&
  SDK_ARGUMENT_ERRORS.some((prefix) => cause.message.includes(prefix))

const transportError = (method: string, cause: unknown): TransportError => {
  rethrowDefects(cause)
  if (isSdkArgumentError(cause)) throw cause
  return TransportError.fromUnknown(method, cause)
}

/**
 * Whether a second copy of `@mysten/sui` has already been reported.
 *
 * One line per process, not one per failure: a duplicated SDK produces the same
 * warning on every read, and a log full of it hides the failure it is about.
 */
let duplicateSdkReported = false

/**
 * Says once, loudly, that the thrown value is one of the SDK's error classes
 * from a **different copy** of `@mysten/sui` than this package's `instanceof`
 * knows about.
 *
 * It is a real misconfiguration — two copies means two `BcsType` classes, two
 * `Transaction` classes and a pile of `instanceof` checks that quietly answer
 * `false` — but it is not a reason to lose the error's own meaning, so the
 * duck-typed classification below runs regardless. `console.warn` rather than
 * `Effect.logWarning` because `mapSdkError` is a total pure function reached
 * from every call site, and the point is that a human sees it at all.
 */
const reportDuplicateSdk = (what: string): void => {
  if (duplicateSdkReported) return
  duplicateSdkReported = true
  console.warn(
    `sui-effect: a ${what} was thrown by a different copy of @mysten/sui than the one ` +
      "sui-effect imports, so `instanceof` failed and the error was classified by shape. " +
      "Deduplicate @mysten/sui (one copy per process): two copies also break BCS codecs, " +
      "Transaction inputs and every other instanceof in the SDK."
  )
}

/** The three transport-neutral reasons an `ObjectError` carries. */
const OBJECT_REASONS: ReadonlySet<string> = new Set(["notFound", "deleted", "unknown"])

/**
 * An `ObjectError` from another copy of the SDK, recognised by shape: the
 * transport-neutral `reason` plus an `objectId` property.
 *
 * Never fails; `undefined` when the value is not one.
 */
const objectErrorLike = (
  cause: unknown
): { readonly reason: string; readonly objectId: string | undefined } | undefined => {
  if (typeof cause !== "object" || cause === null || !("objectId" in cause)) return undefined
  const record = cause as { readonly reason?: unknown; readonly objectId?: unknown }
  if (typeof record.reason !== "string" || !OBJECT_REASONS.has(record.reason)) return undefined
  return {
    reason: record.reason,
    objectId: typeof record.objectId === "string" ? record.objectId : undefined
  }
}

/**
 * A `TransactionError` from another copy of the SDK: `reason: "notFound"` plus
 * a `digest`. Never fails.
 */
const transactionErrorLike = (cause: unknown): { readonly digest: string } | undefined => {
  if (typeof cause !== "object" || cause === null) return undefined
  const record = cause as { readonly reason?: unknown; readonly digest?: unknown }
  if (record.reason !== "notFound" || typeof record.digest !== "string") return undefined
  return { digest: record.digest }
}

/**
 * A `SimulationError` from another copy of the SDK: an `Error` named
 * `SimulationError`, whose `executionError` is the part that matters. Never
 * fails.
 */
const simulationErrorLike = (
  cause: unknown
): {
  readonly executionError: SuiClientTypes.ExecutionError | undefined
  readonly message: string
  readonly cause: unknown
} | undefined => {
  if (!(cause instanceof Error) || cause.name !== "SimulationError") return undefined
  // Another copy's `executionError` is the same wire shape; `executionReasonOf`
  // decodes it and answers `UNKNOWN_REASON` for anything that is not.
  const record = cause as unknown as {
    readonly executionError?: SuiClientTypes.ExecutionError
    readonly cause?: unknown
  }
  return { executionError: record.executionError, message: cause.message, cause: record.cause }
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
 *
 * **`instanceof` is not the only test.** Two copies of `@mysten/sui` in one
 * process — a vendored tarball beside an installed range, a `link:` to a
 * checkout — means the class this module imported is not the class the
 * transport threw, and every `instanceof` here answers `false`. That used to
 * turn a missing object into `TransportError { status: "notFound" }` instead of
 * `ObjectNotFound`, silently. So each class has a duck-typed fallback — a
 * `reason` plus an `objectId` for an object error, a `reason` plus a `digest`
 * for a transaction error, the name plus `executionError` for a simulation
 * error — and the first time one of them fires the process gets a single
 * warning naming the real problem, because two copies of the SDK break far
 * more than this function.
 */
export const mapSdkError = (method: string, cause: unknown): SuiCoreError => {
  rethrowDefects(cause)
  // Each class is recognised by `instanceof` first and by its shape second;
  // only the shape path means a second copy of the SDK, so only it warns.
  const object = cause instanceof ObjectError ? cause : fromCopy("ObjectError", objectErrorLike(cause))
  if (object !== undefined) {
    const objectId = asObjectId(object.objectId)
    switch (object.reason) {
      case "notFound":
        return new ObjectNotFound({ objectId })
      case "deleted":
        return new ObjectDeleted({ objectId })
      default:
        return new ObjectUnavailable({ objectId })
    }
  }
  const transaction = cause instanceof TransactionError
    ? cause
    : fromCopy("TransactionError", transactionErrorLike(cause))
  if (transaction !== undefined) {
    return new TransactionNotFound({ digest: asDigest(transaction.digest) })
  }
  const simulation = cause instanceof SimulationError
    ? cause
    : fromCopy("SimulationError", simulationErrorLike(cause))
  if (simulation !== undefined) {
    // The SDK's resolve plugin simulates to choose a gas budget and wraps
    // *whatever went wrong* in a `SimulationError`, transport failures
    // included: a rejected fetch, a gRPC `UNAVAILABLE`, an HTTP 503. Only a
    // wrapper carrying an `executionError` describes a transaction that would
    // abort on chain; the rest are the node being unreachable, and calling
    // those `SimulationFailed` loses both the status and the retryability a
    // caller needs.
    if (simulation.executionError === undefined) {
      const transport = transportCauseOf(simulation)
      if (transport !== undefined) {
        return new TransportError({
          method,
          retryable: transport.retryable,
          ...(transport.status === undefined ? {} : { status: transport.status }),
          cause: simulation.cause ?? cause
        })
      }
    }
    return new SimulationFailed({
      reason: simulation.executionError === undefined
        ? UNKNOWN_REASON
        : executionReasonOf(simulation.executionError),
      message: simulation.message,
      ...(simulation.executionError?.command === undefined
        ? {}
        : { command: simulation.executionError.command })
    })
  }
  return transportError(method, cause)
}

/**
 * An SDK class recognised by shape rather than by `instanceof`, which means a
 * second copy of the SDK is loaded: warn once, and answer the value unchanged.
 * Never fails.
 */
const fromCopy = <A>(what: string, found: A | undefined): A | undefined => {
  if (found !== undefined) reportDuplicateSdk(what)
  return found
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

/** How long one read attempt may take when the layer does not say: thirty seconds. */
export const DEFAULT_REQUEST_TIMEOUT: Duration.Duration = Duration.seconds(30)

const isRetryableRead = (error: unknown): boolean =>
  Predicate.hasProperty(error, "_tag") &&
  error._tag === "TransportError" &&
  (error as TransportError).retryable

/**
 * The retry policy one read runs under: `custom` when the layer was given one
 * (it decides delays and when to stop), otherwise {@link readSchedule} for at
 * most five attempts — and in both cases only while the failure is a retryable
 * `TransportError`. Every retry is logged at debug level with the method, the
 * attempt and the failure, so a slow read is visible instead of silent.
 */
const readPolicy = (
  method: string,
  custom: Schedule.Schedule<unknown, unknown> | undefined
): Schedule.Schedule<unknown, unknown> =>
  Schedule.while(
    custom ?? readSchedule,
    ({ attempt, input }) =>
      isRetryableRead(input) && (custom !== undefined || attempt <= MAX_READ_ATTEMPTS - 1)
  ).pipe(
    Schedule.tap(({ attempt, input }) =>
      Effect.logDebug(`SuiCore.${method}: retrying a retryable read failure`).pipe(
        Effect.annotateLogs({
          "sui.method": method,
          "sui.attempt": attempt,
          "sui.error": input instanceof Error ? input.message : String(input)
        }),
        Effect.andThen(Metrics.increment(Metrics.readRetries, { method, status: statusOf(input) }))
      )
    )
  )

/** The `status` attribute of a retried failure: its transport status, or `none`. */
const statusOf = (input: unknown): string =>
  Predicate.hasProperty(input, "status") && typeof input.status === "string" ? input.status : "none"

/**
 * The default read policy for `method`: what `SuiCoreService.readPolicy`
 * answers on a layer built without `readRetry`, and what to use when a
 * hand-built mock has no `readPolicy`. Internal.
 */
export const defaultReadPolicy = (method: string): Schedule.Schedule<unknown, unknown> =>
  readPolicy(method, undefined)

/**
 * How the read tier behaves: the per-attempt request timeout and the retry
 * schedule. Every field is optional; the defaults are the spec's.
 *
 * @since 0.4.0
 */
export interface SuiCoreReadOptions {
  /**
   * How long **one attempt** of a read may take before it is abandoned — its
   * request cancelled through the `AbortSignal` — and counted as a retryable
   * `TransportError { status: "DEADLINE_EXCEEDED" }`, which the retry policy
   * then retries like any other. Defaults to thirty seconds; `"Infinity"`
   * turns it off.
   *
   * This is what stops a node that accepts the connection and never answers
   * from hanging a program forever, the layer's own `getChainIdentifier`
   * included. It is not the gRPC client's `timeout`, which only sets a
   * `grpc-timeout` header the server may ignore. It does not apply to
   * `executeTransaction` and `signAndExecuteTransaction` (`Tx.submit` has its
   * own `SubmitConfig.executeTimeout`), `waitForTransaction` (which takes its
   * own `timeout`) or `use`.
   */
  readonly requestTimeout?: Duration.Input
  /**
   * The schedule a read is retried on, replacing the default (jittered
   * exponential from 250 ms, capped at 10 s, five attempts in all). It sees
   * every failure but is only consulted while the failure is a retryable
   * `TransportError`; it decides the delays and when to stop, so give it a
   * limit (`Schedule.recurs`, `Schedule.during`) unless retrying forever is
   * meant.
   */
  readonly readRetry?: Schedule.Schedule<unknown, unknown>
}

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
 * What a node says about itself: the chain, where its ledger head is, and — the
 * part a reconciler or an indexer needs — how far back its history reaches.
 * Mirrors gRPC `LedgerService.GetServiceInfo`; every field is optional because
 * the proto's are.
 *
 * @since 0.4.0
 */
export interface ServiceInfo {
  /** The chain identifier (genesis checkpoint digest). */
  readonly chainId?: string
  /** The chain's human name (`mainnet`, `testnet`, …). */
  readonly chain?: string
  /** The current epoch. */
  readonly epoch?: bigint
  /** The latest checkpoint the node has executed. */
  readonly checkpointHeight?: bigint
  /** That checkpoint's timestamp, in milliseconds since the epoch. */
  readonly timestampMs?: number
  /**
   * The oldest checkpoint whose data (transactions, events) the node still
   * serves. A pruning node moves this forward: a transaction older than it
   * answers `NOT_FOUND`, and a cursor older than it answers `OUT_OF_RANGE`.
   */
  readonly lowestAvailableCheckpoint?: bigint
  /** The oldest checkpoint whose object versions the node still serves. */
  readonly lowestAvailableCheckpointObjects?: bigint
  /** The node's software version. */
  readonly server?: string
}

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
   * version 3 and U version 4, and the live object then names U. Sui assigns
   * outputs the transaction's Lamport version, so the consumer of version `v`
   * is *not* generally the object at `v + 1`; `Tx.reconcile` identifies it by
   * walking the live object's `previousTransaction` and its effects'
   * `inputVersion` instead. This read stays public as a primitive for callers
   * that know a specific historical version exists.
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

  /**
   * What the node says about itself, including the lowest checkpoint it still
   * serves — which is how a caller tells a pruned history from a missing
   * transaction. Not a `TransportMethods` member: it reaches gRPC
   * `LedgerService.GetServiceInfo` directly (or a client's own
   * `getServiceInfo`, which is how a test double provides it).
   *
   * Fails with: `TransportError` — `status: "UNIMPLEMENTED"`, not retryable,
   * on a transport that has no such call.
   *
   * @since 0.4.0
   */
  readonly getServiceInfo: () => Effect.Effect<ServiceInfo, TransportError>

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

  /**
   * The retry schedule this client's reads run under, for a read made outside
   * its members — `Tx.build` retries the SDK resolver's own reads on it. It is
   * `SuiCoreReadOptions.readRetry` when the layer was given one and the
   * default otherwise (jittered exponential from 250 ms, capped at 10 s, five
   * attempts in all); in both cases it only continues while the failure is a
   * retryable `TransportError`, and every retry is logged at debug level and
   * counted in `sui_effect_core_read_retries_total` under `method`.
   *
   * Use it as `Effect.retry(effect, core.readPolicy("myRead"))`. Optional
   * only so a hand-built `Layer.mock(SuiCore, ...)` need not supply it; every
   * layer this package builds has it, and `Tx.build` falls back to the
   * default policy when it is absent.
   *
   * @since 0.4.0
   */
  readonly readPolicy?: (method: string) => Schedule.Schedule<unknown, unknown>
}

/**
 * The mechanical tier over `@mysten/sui`.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiCore } from "@unconfirmed/sui-effect"
 *
 * const chainId = Effect.gen(function*() {
 *   const core = yield* SuiCore
 *   const { chainIdentifier } = yield* core.getChainIdentifier()
 *   return chainIdentifier
 * })
 * ```
 */
export class SuiCore extends Context.Service<SuiCore, SuiCoreService>()("@unconfirmed/sui-effect/SuiCore") {
  /**
   * Wraps a client the caller already built and configured; `options` sets the
   * read tier's request timeout and retry schedule. Never fails.
   */
  static readonly layerFromClient = (
    client: ClientWithCoreApi,
    options?: SuiCoreReadOptions
  ): Layer.Layer<SuiCore> => Layer.succeed(SuiCore, makeFromClient(client, options))

  /** Builds a `SuiGrpcClient` and wraps it. Never fails. */
  static readonly layerGrpc = (options: SuiGrpcLayerOptions): Layer.Layer<SuiCore> =>
    Layer.sync(SuiCore, () => makeFromClient(makeGrpcClient(options), options))

  /**
   * Reads `SUI_NETWORK` (required, no default), `SUI_RPC_URL` (optional,
   * defaulted from {@link defaultGrpcUrl} for the four known networks) and
   * `SUI_RPC_TIMEOUT` (optional, a duration such as `30 seconds` or
   * `Infinity`; the per-attempt `requestTimeout`, thirty seconds when unset).
   *
   * Fails with: `ConfigError` (the layer) when `SUI_NETWORK` is missing, when
   * it names a network with no built-in URL and `SUI_RPC_URL` is not set, or
   * when `SUI_RPC_TIMEOUT` is not a duration.
   */
  static readonly layerConfig: Layer.Layer<SuiCore, Config.ConfigError> = Layer.effect(
    SuiCore,
    Effect.gen(function*() {
      const network = yield* Config.NonEmptyString("SUI_NETWORK")
      const baseUrl = yield* Config.NonEmptyString("SUI_RPC_URL").pipe(
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
      const requestTimeout = yield* Config.option(Config.Duration("SUI_RPC_TIMEOUT"))
      const options: SuiGrpcLayerOptions = {
        network,
        baseUrl,
        ...(Option.isSome(requestTimeout) ? { requestTimeout: requestTimeout.value } : {})
      }
      return makeFromClient(makeGrpcClient(options), options)
    })
  )
}

/**
 * Options for {@link SuiCore.layerGrpc}: `SuiGrpcClientOptions`, plus the read
 * tier's {@link SuiCoreReadOptions}.
 */
export interface SuiGrpcLayerOptions extends SuiCoreReadOptions {
  readonly network: SuiClientTypes.Network
  readonly baseUrl: string
  /**
   * The SDK's own `timeout`, in milliseconds: a `grpc-timeout` header on each
   * call, which a server is free to ignore. To bound how long a read can
   * actually take, use `requestTimeout`.
   */
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

/** The gRPC service-info call, duck-typed so it compiles against every SDK in the peer range. */
interface ServiceInfoCapable {
  readonly getServiceInfo: (
    input: object,
    options: { readonly abort: AbortSignal }
  ) => PromiseLike<{
    readonly response: {
      readonly chainId?: string
      readonly chain?: string
      readonly epoch?: bigint
      readonly checkpointHeight?: bigint
      readonly timestamp?: { readonly seconds: bigint; readonly nanos: number }
      readonly lowestAvailableCheckpoint?: bigint
      readonly lowestAvailableCheckpointObjects?: bigint
      readonly server?: string
    }
  }>
}

const serviceOf = (client: ClientWithCoreApi): ServiceInfoCapable | undefined => {
  const ledger = (client as { readonly ledgerService?: unknown }).ledgerService
  return typeof (ledger as { readonly getServiceInfo?: unknown } | undefined)?.getServiceInfo === "function"
    ? ledger as ServiceInfoCapable
    : undefined
}

/** A client's own `getServiceInfo(signal)`: how a test double answers. */
interface DirectServiceInfo {
  readonly getServiceInfo: (options: { readonly signal: AbortSignal }) => Promise<ServiceInfo>
}

const hasDirectServiceInfo = (client: unknown): client is DirectServiceInfo =>
  typeof (client as { readonly getServiceInfo?: unknown }).getServiceInfo === "function"

const readServiceInfo = async (client: ClientWithCoreApi, signal: AbortSignal): Promise<ServiceInfo> => {
  const ledger = serviceOf(client)
  if (ledger !== undefined) {
    const { response } = await ledger.getServiceInfo({}, { abort: signal })
    const ts = response.timestamp
    return {
      ...(response.chainId === undefined ? {} : { chainId: response.chainId }),
      ...(response.chain === undefined ? {} : { chain: response.chain }),
      ...(response.epoch === undefined ? {} : { epoch: response.epoch }),
      ...(response.checkpointHeight === undefined ? {} : { checkpointHeight: response.checkpointHeight }),
      ...(ts === undefined ? {} : { timestampMs: Number(ts.seconds) * 1000 + Math.floor(ts.nanos / 1e6) }),
      ...(response.lowestAvailableCheckpoint === undefined
        ? {}
        : { lowestAvailableCheckpoint: response.lowestAvailableCheckpoint }),
      ...(response.lowestAvailableCheckpointObjects === undefined
        ? {}
        : { lowestAvailableCheckpointObjects: response.lowestAvailableCheckpointObjects }),
      ...(response.server === undefined ? {} : { server: response.server })
    }
  }
  if (hasDirectServiceInfo(client)) return client.getServiceInfo({ signal })
  throw new ServiceInfoUnimplemented()
}

/** Thrown by {@link readServiceInfo} on a transport with no service-info call. */
class ServiceInfoUnimplemented extends Error {
  constructor() {
    super("this transport has no GetServiceInfo call")
  }
}

/**
 * Wraps a client object into the service. Exported so `SuiExtension.fromService`
 * and tests can build the same implementation over any `ClientWithCoreApi`.
 */
export const makeFromClient = (
  client: ClientWithCoreApi,
  options?: SuiCoreReadOptions
): SuiCoreService => {
  const requestTimeout = Duration.fromInputUnsafe(options?.requestTimeout ?? DEFAULT_REQUEST_TIMEOUT)
  const bounded = Duration.isFinite(requestTimeout)
  const readRetry = options?.readRetry

  /**
   * One attempt, bounded by the request timeout. Interrupting the attempt
   * aborts its `AbortSignal`, so the SDK request is cancelled rather than left
   * running; the timeout itself is a retryable `TransportError`.
   */
  const attempt = <A, E>(method: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E | TransportError> =>
    bounded
      ? Effect.timeoutOrElse(effect, {
        duration: requestTimeout,
        orElse: () =>
          Metrics.increment(Metrics.requestTimeouts, { method }).pipe(
            Effect.andThen(Effect.fail(
              new TransportError({
                method,
                retryable: true,
                status: "DEADLINE_EXCEEDED",
                cause: `no answer within ${Duration.format(requestTimeout)} (requestTimeout)`
              })
            ))
          )
      })
      : effect

  /** A read: bounded attempts, retried under the read policy. */
  const retryReads = <A, E>(method: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E | TransportError> =>
    Effect.retry(attempt(method, effect), readPolicy(method, readRetry))

  // Every member below is an `Effect.fn("SuiCore.<method>")`, so the span is
  // named after the method and `call` does not add one of its own.
  const call = <A, E>(
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
  ): Effect.Effect<A, E | TransportError> => retryReads(method, call(run, onError))

  /**
   * A read with no request timeout, for the one read that is a wait by
   * design: `waitForTransaction` polls for up to its own `timeout`.
   */
  const readUnbounded = <A, E extends { readonly _tag: string }>(
    method: string,
    run: (core: ClientWithCoreApi["core"], signal: AbortSignal) => Promise<A>,
    onError: (cause: unknown) => E
  ): Effect.Effect<A, E> => Effect.retry(call(run, onError), readPolicy(method, readRetry))

  /**
   * The attribute every span this client makes carries, known at construction.
   *
   * A trace that crosses two networks — a mainnet read beside a testnet
   * submission in one process — is otherwise indistinguishable in the span
   * names, which are the same on both.
   */
  const spanOptions = { attributes: { "sui.network": client.network } } as const

  return {
    network: client.network,
    getObjects: Effect.fn("SuiCore.getObjects", spanOptions)(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetObjectsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetObjectsResponse<Include>, TransportError> {
      yield* Effect.annotateCurrentSpan({ "sui.object_count": options.objectIds.length })
      return yield* read(
        "getObjects",
        (core, signal) => core.getObjects({ ...options, signal }),
        onlyTransportError("getObjects")
      )
    }),
    getObject: Effect.fn("SuiCore.getObject", spanOptions)(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetObjectOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetObjectResponse<Include>, ObjectLookupError> {
      yield* Effect.annotateCurrentSpan({ "sui.object_id": options.objectId })
      return yield* read(
        "getObject",
        (core, signal) => core.getObject({ ...options, signal }),
        objectError("getObject")
      )
    }),
    listOwnedObjects: Effect.fn("SuiCore.listOwnedObjects", spanOptions)(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.ListOwnedObjectsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.ListOwnedObjectsResponse<Include>, TransportError> {
      return yield* read(
        "listOwnedObjects",
        (core, signal) => core.listOwnedObjects({ ...options, signal }),
        onlyTransportError("listOwnedObjects")
      )
    }),
    listCoins: Effect.fn("SuiCore.listCoins", spanOptions)(function*(
      options: SuiClientTypes.ListCoinsOptions
    ): Effect.fn.Return<SuiClientTypes.ListCoinsResponse, TransportError> {
      return yield* read(
        "listCoins",
        (core, signal) => core.listCoins({ ...options, signal }),
        onlyTransportError("listCoins")
      )
    }),
    listDynamicFields: Effect.fn("SuiCore.listDynamicFields", spanOptions)(function*(
      options: SuiClientTypes.ListDynamicFieldsOptions
    ): Effect.fn.Return<SuiClientTypes.ListDynamicFieldsResponse, TransportError> {
      return yield* read(
        "listDynamicFields",
        (core, signal) => core.listDynamicFields({ ...options, signal }),
        onlyTransportError("listDynamicFields")
      )
    }),
    getDynamicField: Effect.fn("SuiCore.getDynamicField", spanOptions)(function*(
      options: SuiClientTypes.GetDynamicFieldOptions
    ): Effect.fn.Return<SuiClientTypes.GetDynamicFieldResponse, ObjectLookupError> {
      yield* Effect.annotateCurrentSpan({ "sui.object_id": options.parentId })
      return yield* read(
        "getDynamicField",
        (core, signal) => core.getDynamicField({ ...options, signal }),
        objectError("getDynamicField")
      )
    }),
    getDynamicObjectField: Effect.fn("SuiCore.getDynamicObjectField", spanOptions)(function*<Include extends ObjectInclude = {}>(
      options: SuiClientTypes.GetDynamicObjectFieldOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.GetDynamicObjectFieldResponse<Include>, ObjectLookupError> {
      return yield* read(
        "getDynamicObjectField",
        (core, signal) => core.getDynamicObjectField({ ...options, signal }),
        objectError("getDynamicObjectField")
      )
    }),
    getBalance: Effect.fn("SuiCore.getBalance", spanOptions)(function*(
      options: SuiClientTypes.GetBalanceOptions
    ): Effect.fn.Return<SuiClientTypes.GetBalanceResponse, TransportError> {
      return yield* read(
        "getBalance",
        (core, signal) => core.getBalance({ ...options, signal }),
        onlyTransportError("getBalance")
      )
    }),
    listBalances: Effect.fn("SuiCore.listBalances", spanOptions)(function*(
      options: SuiClientTypes.ListBalancesOptions
    ): Effect.fn.Return<SuiClientTypes.ListBalancesResponse, TransportError> {
      return yield* read(
        "listBalances",
        (core, signal) => core.listBalances({ ...options, signal }),
        onlyTransportError("listBalances")
      )
    }),
    getCoinMetadata: Effect.fn("SuiCore.getCoinMetadata", spanOptions)(function*(
      options: SuiClientTypes.GetCoinMetadataOptions
    ): Effect.fn.Return<SuiClientTypes.GetCoinMetadataResponse, TransportError> {
      return yield* read(
        "getCoinMetadata",
        (core, signal) => core.getCoinMetadata({ ...options, signal }),
        onlyTransportError("getCoinMetadata")
      )
    }),
    getTransaction: Effect.fn("SuiCore.getTransaction", spanOptions)(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.GetTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransactionLookupError> {
      yield* Effect.annotateCurrentSpan({ "sui.digest": options.digest })
      return yield* read(
        "getTransaction",
        (core, signal) => core.getTransaction({ ...options, signal }),
        transactionError("getTransaction")
      )
    }),
    executeTransaction: Effect.fn("SuiCore.executeTransaction", spanOptions)(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.ExecuteTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransportError> {
      yield* Effect.annotateCurrentSpan({ "sui.signature_count": options.signatures.length })
      return yield* call(
        (core, signal) => core.executeTransaction({ ...options, signal }),
        onlyTransportError("executeTransaction")
      )
    }),
    signAndExecuteTransaction: Effect.fn("SuiCore.signAndExecuteTransaction", spanOptions)(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.SignAndExecuteTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransportError> {
      return yield* call(
        (core, signal) => core.signAndExecuteTransaction({ ...options, signal }),
        onlyTransportError("signAndExecuteTransaction")
      )
    }),
    getObjectAtVersion: Effect.fn("SuiCore.getObjectAtVersion", spanOptions)(function*(
      options: { readonly objectId: string; readonly version: string | bigint }
    ): Effect.fn.Return<VersionedObject, TransportError> {
      return yield* retryReads(
        "getObjectAtVersion",
        Effect.tryPromise({
          try: (signal) =>
            readObjectAtVersion(client, options.objectId, BigInt(options.version), signal),
          catch: onlyTransportError("getObjectAtVersion")
        })
      )
    }),
    getServiceInfo: Effect.fn("SuiCore.getServiceInfo", spanOptions)(function*(): Effect.fn.Return<
      ServiceInfo,
      TransportError
    > {
      return yield* retryReads(
        "getServiceInfo",
        Effect.tryPromise({
          try: (signal) => readServiceInfo(client, signal),
          catch: (cause) =>
            cause instanceof ServiceInfoUnimplemented
              ? new TransportError({
                method: "getServiceInfo",
                retryable: false,
                status: "UNIMPLEMENTED",
                cause: cause.message
              })
              : transportError("getServiceInfo", cause)
        })
      )
    }),
    waitForTransaction: Effect.fn("SuiCore.waitForTransaction", spanOptions)(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.WaitForTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.TransactionResult<Include>, TransactionLookupError> {
      yield* Effect.annotateCurrentSpan({ "sui.digest": options.digest })
      return yield* readUnbounded(
        "waitForTransaction",
        (core, signal) => core.waitForTransaction({ ...options, signal }),
        transactionError("waitForTransaction")
      )
    }),
    simulateTransaction: Effect.fn("SuiCore.simulateTransaction", spanOptions)(function*<Include extends SimulateInclude = {}>(
      options: SuiClientTypes.SimulateTransactionOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.SimulateTransactionResult<Include>, SimulationLookupError> {
      return yield* read(
        "simulateTransaction",
        (core, signal) => core.simulateTransaction({ ...options, signal }),
        simulationError("simulateTransaction")
      )
    }),
    listTransactions: Effect.fn("SuiCore.listTransactions", spanOptions)(function*<Include extends TransactionInclude = {}>(
      options: SuiClientTypes.ListTransactionsOptions<Include>
    ): Effect.fn.Return<SuiClientTypes.ListTransactionsResponse<Include>, TransportError> {
      return yield* read(
        "listTransactions",
        (core, signal) => core.listTransactions({ ...options, signal }),
        onlyTransportError("listTransactions")
      )
    }),
    listEvents: Effect.fn("SuiCore.listEvents", spanOptions)(function*(
      options: SuiClientTypes.ListEventsOptions
    ): Effect.fn.Return<SuiClientTypes.ListEventsResponse, TransportError> {
      return yield* read(
        "listEvents",
        (core, signal) => core.listEvents({ ...options, signal }),
        onlyTransportError("listEvents")
      )
    }),
    getReferenceGasPrice: Effect.fn("SuiCore.getReferenceGasPrice", spanOptions)(function*(
      options?: SuiClientTypes.GetReferenceGasPriceOptions
    ): Effect.fn.Return<SuiClientTypes.GetReferenceGasPriceResponse, TransportError> {
      return yield* read(
        "getReferenceGasPrice",
        (core, signal) => core.getReferenceGasPrice({ ...options, signal }),
        onlyTransportError("getReferenceGasPrice")
      )
    }),
    getCurrentSystemState: Effect.fn("SuiCore.getCurrentSystemState", spanOptions)(function*(
      options?: SuiClientTypes.GetCurrentSystemStateOptions
    ): Effect.fn.Return<SuiClientTypes.GetCurrentSystemStateResponse, TransportError> {
      return yield* read(
        "getCurrentSystemState",
        (core, signal) => core.getCurrentSystemState({ ...options, signal }),
        onlyTransportError("getCurrentSystemState")
      )
    }),
    getProtocolConfig: Effect.fn("SuiCore.getProtocolConfig", spanOptions)(function*(
      options?: SuiClientTypes.GetProtocolConfigOptions
    ): Effect.fn.Return<SuiClientTypes.GetProtocolConfigResponse, TransportError> {
      return yield* read(
        "getProtocolConfig",
        (core, signal) => core.getProtocolConfig({ ...options, signal }),
        onlyTransportError("getProtocolConfig")
      )
    }),
    getChainIdentifier: Effect.fn("SuiCore.getChainIdentifier", spanOptions)(function*(
      options?: SuiClientTypes.GetChainIdentifierOptions
    ): Effect.fn.Return<SuiClientTypes.GetChainIdentifierResponse, TransportError> {
      return yield* read(
        "getChainIdentifier",
        (core, signal) => core.getChainIdentifier({ ...options, signal }),
        onlyTransportError("getChainIdentifier")
      )
    }),
    getMoveFunction: Effect.fn("SuiCore.getMoveFunction", spanOptions)(function*(
      options: SuiClientTypes.GetMoveFunctionOptions
    ): Effect.fn.Return<SuiClientTypes.GetMoveFunctionResponse, TransportError> {
      return yield* read(
        "getMoveFunction",
        (core, signal) => core.getMoveFunction({ ...options, signal }),
        onlyTransportError("getMoveFunction")
      )
    }),
    verifyZkLoginSignature: Effect.fn("SuiCore.verifyZkLoginSignature", spanOptions)(function*(
      options: SuiClientTypes.VerifyZkLoginSignatureOptions
    ): Effect.fn.Return<SuiClientTypes.ZkLoginVerifyResponse, TransportError> {
      return yield* read(
        "verifyZkLoginSignature",
        (core, signal) => core.verifyZkLoginSignature({ ...options, signal }),
        onlyTransportError("verifyZkLoginSignature")
      )
    }),
    resolveNameServiceAddress: Effect.fn("SuiCore.resolveNameServiceAddress", spanOptions)(function*(
      options: SuiClientTypes.ResolveNameServiceAddressOptions
    ): Effect.fn.Return<SuiClientTypes.ResolveNameServiceAddressResponse, TransportError> {
      return yield* read(
        "resolveNameServiceAddress",
        (core, signal) => core.resolveNameServiceAddress({ ...options, signal }),
        onlyTransportError("resolveNameServiceAddress")
      )
    }),
    defaultNameServiceName: Effect.fn("SuiCore.defaultNameServiceName", spanOptions)(function*(
      options: SuiClientTypes.DefaultNameServiceNameOptions
    ): Effect.fn.Return<SuiClientTypes.DefaultNameServiceNameResponse, TransportError> {
      return yield* read(
        "defaultNameServiceName",
        (core, signal) => core.defaultNameServiceName({ ...options, signal }),
        onlyTransportError("defaultNameServiceName")
      )
    }),
    mvr: {
      resolvePackage: Effect.fn("SuiCore.mvr.resolvePackage", spanOptions)(function*(
        options: SuiClientTypes.MvrResolvePackageOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolvePackageResponse, TransportError> {
        return yield* read(
          "mvr.resolvePackage",
          (core, signal) => core.mvr.resolvePackage({ ...options, signal }),
          onlyTransportError("mvr.resolvePackage")
        )
      }),
      resolveType: Effect.fn("SuiCore.mvr.resolveType", spanOptions)(function*(
        options: SuiClientTypes.MvrResolveTypeOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolveTypeResponse, TransportError> {
        return yield* read(
          "mvr.resolveType",
          (core, signal) => core.mvr.resolveType({ ...options, signal }),
          onlyTransportError("mvr.resolveType")
        )
      }),
      resolve: Effect.fn("SuiCore.mvr.resolve", spanOptions)(function*(
        options: SuiClientTypes.MvrResolveOptions
      ): Effect.fn.Return<SuiClientTypes.MvrResolveResponse, TransportError> {
        return yield* read(
          "mvr.resolve",
          (core, signal) => core.mvr.resolve({ ...options, signal }),
          onlyTransportError("mvr.resolve")
        )
      })
    },
    resolveTransactionPlugin: Effect.fn("SuiCore.resolveTransactionPlugin", spanOptions)(
      function*(): Effect.fn.Return<TransactionPlugin> {
        return yield* Effect.sync(() => client.core.resolveTransactionPlugin())
      }
    ),
    use: Effect.fn("SuiCore.use", spanOptions)(function*<A>(
      run: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>
    ): Effect.fn.Return<A, SuiCoreError> {
      return yield* Effect.tryPromise({
        try: (signal) => run(client, signal),
        catch: (cause) => mapSdkError("use", cause)
      })
    }),
    readPolicy: (method) => readPolicy(method, readRetry)
  }
}
