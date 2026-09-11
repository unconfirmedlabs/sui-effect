/**
 * The closed error taxonomy. Every failure sui-effect can produce is one of the
 * classes in this file, every one is a `Schema.TaggedError` so it serializes,
 * and the tags are flat: there is no error inheritance to match on.
 *
 * @since 0.1.0
 */
import { Result, Schema } from "effect"
import {
  Digest,
  ExecutionReason,
  ObjectId,
  SignedTransaction,
  StructTag,
  TransactionEffects,
  Version
} from "./schemas.ts"

export { CleverError, ExecutionReason, MoveLocation } from "./schemas.ts"

/**
 * A request did not reach a usable answer. `retryable` is true for the statuses
 * a read may be retried on: gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`,
 * `RESOURCE_EXHAUSTED`, `INTERNAL` and `UNKNOWN`, HTTP 5xx and 429, and
 * timeouts. `INTERNAL` and `UNKNOWN` are in the set because the grpc-web
 * transport reports a refused connection or a DNS failure as `INTERNAL` and an
 * HTTP 500 as `UNKNOWN`, so without them a node that is merely down is never
 * retried.
 */
export class TransportError extends Schema.TaggedError<TransportError>()("TransportError", {
  method: Schema.String,
  retryable: Schema.Boolean,
  status: Schema.optional(Schema.String),
  cause: Schema.Defect()
}) {}

/** The object does not exist, or has never existed. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  objectId: ObjectId,
  version: Schema.optional(Version)
}) {}

/** The object existed and has been deleted or wrapped. */
export class ObjectDeleted extends Schema.TaggedError<ObjectDeleted>()("ObjectDeleted", {
  objectId: ObjectId,
  version: Schema.optional(Version)
}) {}

/** The node could not say what happened to the object (`ObjectError.reason: "unknown"`). */
export class ObjectUnavailable extends Schema.TaggedError<ObjectUnavailable>()(
  "ObjectUnavailable",
  { objectId: ObjectId, version: Schema.optional(Version) }
) {}

/** No transaction with this digest is known to the node. */
export class TransactionNotFound extends Schema.TaggedError<TransactionNotFound>()(
  "TransactionNotFound",
  { digest: Digest }
) {}

/** The chain identifier the node reported is not the one the layer was built for. */
export class NetworkMismatch extends Schema.TaggedError<NetworkMismatch>()("NetworkMismatch", {
  expected: Schema.String,
  actual: Schema.String
}) {}

/** BCS content or a schema boundary did not decode. */
export class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  objectId: Schema.optional(ObjectId),
  expectedType: Schema.optional(Schema.String),
  issue: Schema.String
}) {}

/** Simulation reported an execution failure. No gas was charged. */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  reason: ExecutionReason,
  message: Schema.String
}) {}

/** The transaction was applied on chain and failed. Gas was charged. */
export class ExecutionFailed extends Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Digest,
  reason: ExecutionReason,
  command: Schema.optional(Schema.Number),
  effects: TransactionEffects
}) {}

/**
 * Bytes may have reached the network and the outcome is unknown. Carries the
 * signed transaction so an operator or a later process can reconcile it.
 */
export class SubmissionUnknown extends Schema.TaggedError<SubmissionUnknown>()(
  "SubmissionUnknown",
  { digest: Digest, signed: SignedTransaction, cause: Schema.Defect() }
) {}

/** The transaction provably cannot have been applied, and never will be. */
export class NotApplied extends Schema.TaggedError<NotApplied>()("NotApplied", {
  digest: Digest,
  evidence: Schema.Literals(["expired", "inputConsumed"])
}) {}

/** A signer refused or failed to produce a signature. */
export class SigningError extends Schema.TaggedError<SigningError>()("SigningError", {
  cause: Schema.Defect()
}) {}

/** The transaction could not be built into bytes. */
export class BuildError extends Schema.TaggedError<BuildError>()("BuildError", {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

/** A preflight policy refused the transaction before it was signed. */
export class PolicyDenied extends Schema.TaggedError<PolicyDenied>()("PolicyDenied", {
  rule: Schema.String,
  message: Schema.String
}) {}

/** The submission journal could not be read or written. */
export class JournalError extends Schema.TaggedError<JournalError>()("JournalError", {
  cause: Schema.Defect()
}) {}

/** The effects of an applied transaction did not contain what the caller expected. */
export class UnexpectedEffects extends Schema.TaggedError<UnexpectedEffects>()(
  "UnexpectedEffects",
  { digest: Digest, expected: StructTag, found: Schema.Array(ObjectId) }
) {}

/** Every failure sui-effect can produce. */
export type SuiError =
  | TransportError
  | ObjectNotFound
  | ObjectDeleted
  | ObjectUnavailable
  | TransactionNotFound
  | NetworkMismatch
  | DecodeError
  | SimulationFailed
  | ExecutionFailed
  | SubmissionUnknown
  | NotApplied
  | SigningError
  | BuildError
  | PolicyDenied
  | JournalError
  | UnexpectedEffects

/** The schema of the whole taxonomy, used for serialization. */
export const SuiErrorSchema = Schema.Union([
  TransportError,
  ObjectNotFound,
  ObjectDeleted,
  ObjectUnavailable,
  TransactionNotFound,
  NetworkMismatch,
  DecodeError,
  SimulationFailed,
  ExecutionFailed,
  SubmissionUnknown,
  NotApplied,
  SigningError,
  BuildError,
  PolicyDenied,
  JournalError,
  UnexpectedEffects
])

/**
 * What a failure says about the transaction it came from, on the axis a caller
 * or a wrapper script acts on.
 */
export type Outcome = "applied" | "not_applied" | "unknown"

/**
 * An extension error may declare its own outcome; `SuiError.outcome` and
 * `Script.run` honour it and default to `"not_applied"`.
 */
export interface HasOutcome {
  readonly outcome: Outcome
}

const OutcomeSchema = Schema.Literals(["applied", "not_applied", "unknown"])

const isHasOutcome = Schema.is(Schema.Struct({ outcome: OutcomeSchema }))

const hasOutcome = (error: unknown): error is HasOutcome => isHasOutcome(error)

const isRetryable = (error: SuiError): boolean =>
  error._tag === "TransportError" ? error.retryable : false

const outcome = (error: SuiError | HasOutcome): Outcome => {
  if (hasOutcome(error)) return error.outcome
  switch ((error as SuiError)._tag) {
    case "ExecutionFailed":
      return "applied"
    case "SubmissionUnknown":
      return "unknown"
    default:
      return "not_applied"
  }
}

const formatTarget = (reason: ExecutionReason): string => {
  if (reason.$kind !== "MoveAbort") return ""
  const location = reason.MoveAbort.location
  if (location === undefined) return ""
  const parts = [location.package, location.module, location.functionName].filter(
    (part): part is string => part !== undefined
  )
  return parts.length === 0 ? "" : ` ${parts.join("::")}`
}

const describeReason = (reason: ExecutionReason): string =>
  ExecutionReason.match(reason, {
    MoveAbort: (value) => {
      const clever = value.MoveAbort.cleverError?.constantName
      const suffix = clever === undefined ? "" : ` (${clever})`
      return `MoveAbort${formatTarget(value)} code ${value.MoveAbort.abortCode}${suffix}`
    },
    SizeError: (value) =>
      `SizeError ${value.SizeError.name} ${value.SizeError.size} of ${value.SizeError.maxSize}`,
    CommandArgumentError: (value) =>
      `CommandArgumentError ${value.CommandArgumentError.name} at argument ${value.CommandArgumentError.argument}`,
    TypeArgumentError: (value) =>
      `TypeArgumentError ${value.TypeArgumentError.name} at type argument ${value.TypeArgumentError.typeArgument}`,
    PackageUpgradeError: (value) => `PackageUpgradeError ${value.PackageUpgradeError.name}`,
    IndexError: (value) => `IndexError index ${value.IndexError.index ?? "?"}`,
    CoinDenyListError: (value) =>
      `CoinDenyListError ${value.CoinDenyListError.name} for ${value.CoinDenyListError.coinType}`,
    CongestedObjects: (value) =>
      `CongestedObjects ${value.CongestedObjects.objects.join(", ")}`,
    ObjectIdError: (value) =>
      `ObjectIdError ${value.ObjectIdError.name ?? ""} ${value.ObjectIdError.objectId}`.trim(),
    Unknown: () => "Unknown"
  })

const describe = (error: SuiError): string => {
  switch (error._tag) {
    case "TransportError":
      return `TransportError ${error.method}${error.status === undefined ? "" : ` ${error.status}`}${
        error.retryable ? " (retryable)" : ""
      }`
    case "ObjectNotFound":
    case "ObjectDeleted":
    case "ObjectUnavailable":
      return `${error._tag} ${error.objectId}`
    case "TransactionNotFound":
      return `TransactionNotFound ${error.digest}`
    case "NetworkMismatch":
      return `NetworkMismatch expected ${error.expected} but the node reported ${error.actual}`
    case "DecodeError":
      return `DecodeError ${error.expectedType ?? ""} ${error.objectId ?? ""} ${error.issue}`
        .replace(/\s+/g, " ")
        .trim()
    case "SimulationFailed":
      return `SimulationFailed ${describeReason(error.reason)}`
    case "ExecutionFailed":
      return `ExecutionFailed ${describeReason(error.reason)}${
        error.command === undefined ? "" : ` in command ${error.command}`
      }`
    case "SubmissionUnknown":
      return `SubmissionUnknown ${error.digest}`
    case "NotApplied":
      return `NotApplied ${error.digest} (${error.evidence})`
    case "SigningError":
      return "SigningError"
    case "BuildError":
      return `BuildError ${error.message}`
    case "PolicyDenied":
      return `PolicyDenied ${error.rule}: ${error.message}`
    case "JournalError":
      return "JournalError"
    case "UnexpectedEffects":
      return `UnexpectedEffects ${error.digest} expected ${error.expected} but found ${error.found.length}`
  }
}

const encode = Schema.encodeUnknownResult(SuiErrorSchema)

const toJson = (error: SuiError): Record<string, unknown> => {
  const encoded = encode(error)
  return Result.isSuccess(encoded)
    ? (encoded.success as Record<string, unknown>)
    : { _tag: error._tag, message: describe(error) }
}

/**
 * The four helpers every repo hand-rolls: is this worth retrying, did the
 * transaction land, what does an operator need to read, and what goes in a log.
 */
export const SuiError = {
  isRetryable,
  outcome,
  describe,
  toJson
} as const

/** The digest of the transaction a failure refers to, when it has one. */
export const digestOf = (error: SuiError): Digest | undefined => {
  switch (error._tag) {
    case "TransactionNotFound":
    case "ExecutionFailed":
    case "SubmissionUnknown":
    case "NotApplied":
    case "UnexpectedEffects":
      return error.digest
    default:
      return undefined
  }
}
