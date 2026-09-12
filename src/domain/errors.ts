/**
 * The closed error taxonomy. Every failure sui-effect can produce is one of the
 * classes in this file, every one is a `Schema.TaggedError` so it serializes,
 * and the tags are flat: there is no error inheritance to match on.
 *
 * @since 0.1.0
 */
import { Effect, Predicate, Result, Schema, SchemaIssue } from "effect"
import {
  Digest,
  ExecutionReason,
  NotAppliedEvidence,
  ObjectId,
  SignedTransaction,
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
}) {
  /**
   * Builds a `TransportError` out of whatever a call threw, classifying the
   * status and the retryability the way `SuiCore` does for the SDK's own
   * failures.
   *
   * This is for an extension that makes its own network calls — an operator
   * HTTP API, a GraphQL endpoint, a sidecar — and wants its failures to sit on
   * the same axis as the library's: `retryable` read off a gRPC status name, an
   * HTTP status number (5xx and 429), or an abort or timeout, and `status`
   * recorded as the node or the transport spelled it. Hand-building the three
   * fields per call site is how they drift.
   *
   * `retryable` may be forced when the caller knows better than the shape of
   * the cause — an idempotent read that is always safe to repeat, a write that
   * never is. Left out, it is inferred, and inferred conservatively: an
   * unrecognisable cause is **not** retryable.
   *
   * Never fails.
   *
   * @example
   * ```ts
   * import { TransportError } from "@unconfirmed/sui-effect"
   * import { Effect } from "effect"
   *
   * const status = Effect.tryPromise({
   *   try: (signal) => fetch("https://operator.example/status", { signal }),
   *   catch: (cause) => TransportError.fromUnknown("operator.status", cause)
   * })
   * ```
   */
  static readonly fromUnknown = (
    method: string,
    cause: unknown,
    retryable?: boolean
  ): TransportError => {
    const classified = classifyTransportCause(cause)
    return new TransportError({
      method,
      retryable: retryable ?? classified.retryable,
      ...(classified.status === undefined ? {} : { status: classified.status }),
      cause
    })
  }

  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * gRPC status names a read may be retried on, plus HTTP 5xx and 429. Timeouts
 * map to `DEADLINE_EXCEEDED` with `retryable: true`.
 *
 * `INTERNAL` and `UNKNOWN` are transport-level failures, not answers from the
 * node: `@protobuf-ts/grpcweb-transport` turns a rejected `fetch` (connection
 * refused, DNS failure) into an `RpcError` with code `INTERNAL`, and its
 * grpc-web format maps HTTP 500 to `UNKNOWN` (503 to `UNAVAILABLE`, 504 to
 * `DEADLINE_EXCEEDED`, 429 to `RESOURCE_EXHAUSTED`). Without them a read
 * against a node that is merely down or restarting is never retried.
 */
export const RETRYABLE_GRPC_STATUSES: ReadonlySet<string> = new Set([
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "INTERNAL",
  "UNKNOWN"
])

const isRetryableHttpStatus = (status: number): boolean => status === 429 || status >= 500

/**
 * The `status` and `retryable` of a thrown value: a timeout or an abort, an
 * HTTP status number, a gRPC status name, or nothing recognisable. Never fails.
 */
export const classifyTransportCause = (
  cause: unknown
): { readonly status?: string; readonly retryable: boolean } => {
  if (typeof cause !== "object" || cause === null) return { retryable: false }
  const record = cause as Record<string, unknown>
  const tag = record["_tag"]
  const name = record["name"]
  if (tag === "TimeoutError" || name === "TimeoutError" || name === "AbortError") {
    return { status: "DEADLINE_EXCEEDED", retryable: true }
  }
  const httpStatus = record["status"]
  if (typeof httpStatus === "number") {
    return { status: String(httpStatus), retryable: isRetryableHttpStatus(httpStatus) }
  }
  const code = record["code"]
  if (typeof code === "string") {
    return { status: code, retryable: RETRYABLE_GRPC_STATUSES.has(code) }
  }
  if (typeof code === "number") return { status: String(code), retryable: false }
  return { retryable: false }
}

/** The object does not exist, or has never existed. */
export class ObjectNotFound extends Schema.TaggedError<ObjectNotFound>()("ObjectNotFound", {
  objectId: ObjectId,
  version: Schema.optional(Version)
}) {
  /**
   * The one actionable line `SuiError.describe` produces for this error.
   *
   * `Schema.TaggedError` gives every class the `Error` constructor and no
   * message of its own, so `error.message` was the empty string — and a
   * consumer that surfaces `.message` (a log line, a UI, another library's
   * error formatter) showed nothing at all. A getter rather than a schema
   * field, so it is always in step with `describe`, costs nothing to
   * construct, and stays out of `SuiError.toJson`'s encoding.
   */
  override get message(): string {
    return describe(this)
  }
}

/** The object existed and has been deleted or wrapped. */
export class ObjectDeleted extends Schema.TaggedError<ObjectDeleted>()("ObjectDeleted", {
  objectId: ObjectId,
  version: Schema.optional(Version)
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/** The node could not say what happened to the object (`ObjectError.reason: "unknown"`). */
export class ObjectUnavailable extends Schema.TaggedError<ObjectUnavailable>()(
  "ObjectUnavailable",
  { objectId: ObjectId, version: Schema.optional(Version) }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/** No transaction with this digest is known to the node. */
export class TransactionNotFound extends Schema.TaggedError<TransactionNotFound>()(
  "TransactionNotFound",
  { digest: Digest }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/** The chain identifier the node reported is not the one the layer was built for. */
export class NetworkMismatch extends Schema.TaggedError<NetworkMismatch>()("NetworkMismatch", {
  expected: Schema.String,
  actual: Schema.String
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * Which of the three things that can go wrong at a decode boundary went wrong.
 *
 * - `"type"`: the object, the field or the event **is not of the expected Move
 *   type**. The bytes were never parsed. This is the one a caller answers with
 *   "that is not one of mine" — a 404 for a foreign object, a `filter` over a
 *   heterogeneous list — and the one it is safe to swallow.
 * - `"bytes"`: the type matched and the **BCS parse failed**, or left trailing
 *   bytes. Either the layout this package was built with is not the layout the
 *   package on chain writes, or the object is corrupt. Never safe to swallow.
 * - `"shape"`: a **domain schema** refused a value that was already parsed or
 *   that came from the node as JSON — a missing field in a node response, a
 *   number that is not a timestamp, a simulation with no such command. A bug
 *   here is in this library, the node, or the caller's expectations.
 *
 * Branch on this, never on {@link DecodeError}'s `issue`: `issue` is a human
 * sentence and its wording changes between releases.
 *
 * @since 0.1.2
 */
export const DecodeKind = Schema.Literals(["type", "bytes", "shape"])
/** The three decode failures {@link DecodeKind} names. */
export type DecodeKind = typeof DecodeKind.Type

/**
 * BCS content or a schema boundary did not decode.
 *
 * `kind` says which of the three (`"type"`, `"bytes"`, `"shape"`) and is what a
 * consumer branches on; `issue` is the sentence for a human and is not stable.
 * It defaults to `"shape"` when neither a constructor nor an encoded value
 * carries one, so an extension that builds a `DecodeError` with no `kind` still
 * compiles and still answers the question conservatively.
 */
export class DecodeError extends Schema.TaggedError<DecodeError>()("DecodeError", {
  objectId: Schema.optional(ObjectId),
  expectedType: Schema.optional(Schema.String),
  /**
   * Which boundary failed. See {@link DecodeKind}.
   *
   * @since 0.1.2
   */
  kind: DecodeKind.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("shape" as const)),
    Schema.withConstructorDefault(Effect.succeed("shape" as const))
  ),
  issue: Schema.String,
  /**
   * Every issue the schema reported, with its path — the structured form of
   * {@link DecodeError.issue}, which is only the first issue's sentence.
   *
   * An operator debugging a relay envelope with three bad fields sees three
   * paths rather than one line, and a UI can render a message per field. The
   * key is absent when the producer had no structured issue to carry (a Move
   * type mismatch, a hand-built `DecodeError`), so `SuiError.toJson` still
   * round-trips for every error that was built without one.
   *
   * `kind` is still the field to branch on; this is for reading.
   *
   * @since 0.1.3
   */
  issues: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        /** The path into the decoded value, as the schema walked it. */
        path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
        /** What the schema said about that path. */
        message: Schema.String
      })
    )
  )
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

const standardIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * Every issue of a `SchemaError`, flattened to `{ path, message }` the way
 * {@link DecodeError.issues} carries them.
 *
 * `SchemaError.issue` is a tree; this is Effect's own Standard-Schema
 * formatter over it, so the paths are the ones every other tool prints. A
 * decode run with `{ errors: "all" }` reports every field rather than the
 * first. Never fails.
 */
export const decodeIssues = (
  error: Schema.SchemaError
): ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly message: string }> =>
  standardIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) => {
      const key = Predicate.isObject(segment) ? segment["key"] : segment
      return typeof key === "number" ? key : String(key)
    }),
    message: issue.message
  }))

/** Simulation reported an execution failure. No gas was charged. */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  reason: ExecutionReason,
  message: Schema.String
}) {}

/** The transaction was applied on chain and failed. Gas was charged. */
export class ExecutionFailed extends Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Digest,
  reason: ExecutionReason,
  command: Schema.optional(Schema.Finite),
  effects: TransactionEffects
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * Bytes may have reached the network and the outcome is unknown. Carries the
 * signed transaction so an operator or a later process can reconcile it.
 */
export class SubmissionUnknown extends Schema.TaggedError<SubmissionUnknown>()(
  "SubmissionUnknown",
  { digest: Digest, signed: Schema.optional(SignedTransaction), cause: Schema.Defect() }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * The transaction provably cannot have been applied, and never will be.
 *
 * `evidence` is why. `"inputConsumed"` is only ever produced when a
 * **different** transaction's own effects report that it took a pinned object
 * at exactly the version these bytes pinned. An owned input that merely moved
 * on, one whose consumer took a later version, and one whose last mutation the
 * node will not name are all `SubmissionUnknown`, not this.
 */
export class NotApplied extends Schema.TaggedError<NotApplied>()("NotApplied", {
  digest: Digest,
  evidence: NotAppliedEvidence
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/** A signer refused or failed to produce a signature. */
export class SigningError extends Schema.TaggedError<SigningError>()("SigningError", {
  cause: Schema.Defect()
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

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
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * The effects of an applied transaction did not contain what the caller
 * expected.
 *
 * Outcome `applied`, and exit 5: this error can only come from an `Executed`,
 * which means the transaction reached the chain and gas was charged. What is
 * missing is a receipt, not the transaction. Classifying it `not_applied`
 * would tell the documented retry idiom to send the caller's intent a second
 * time for a transaction that already ran.
 */
export class UnexpectedEffects extends Schema.TaggedError<UnexpectedEffects>()(
  "UnexpectedEffects",
  { digest: Digest, expected: Schema.String, found: Schema.Array(ObjectId) }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * The GraphQL endpoint an extension needs is not usable: none was configured,
 * or the one that was could not be reached.
 *
 * sui-effect does not wrap the GraphQL API — it owns the {@link SuiGraphQL}
 * *tag*, so two extensions that both read GraphQL share one client rather than
 * opening two. This is the failure the tag's `layerUnavailable` produces, which
 * is what an application provides when it has no endpoint: every call rejects
 * with this instead of the extension discovering a missing dependency at
 * construction. An extension maps it into its own union, or lets it through.
 *
 * Outcome `not_applied`: a read that did not happen changed nothing.
 */
export class GraphQLUnavailable extends Schema.TaggedError<GraphQLUnavailable>()(
  "GraphQLUnavailable",
  { method: Schema.String, reason: Schema.String }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/**
 * A synchronous member of a Promise-faced extension was called before its
 * runtime existed.
 *
 * `SuiExtension.fromService` builds its `ManagedRuntime` on first use, so until
 * something has been awaited there is no service object and no synchronous
 * member to read. Rather than hand back a Promise where the type says a value,
 * the face throws this. Two cures, both in the extension's own hands:
 * `await client.<name>.$ready()` once after registering, or register with
 * `warm`, which builds the runtime inside `register` and makes every member
 * real immediately.
 *
 * Outcome `not_applied`: nothing was sent.
 */
export class ExtensionNotReady extends Schema.TaggedError<ExtensionNotReady>()(
  "ExtensionNotReady",
  { extension: Schema.String, member: Schema.String }
) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

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
  | GraphQLUnavailable
  | ExtensionNotReady

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
  UnexpectedEffects,
  GraphQLUnavailable,
  ExtensionNotReady
])

/**
 * {@link SuiErrorSchema} as a tagged union, which is what makes the tag list
 * derivable: `.cases` is keyed by `_tag`, so nothing has to repeat it.
 *
 * Not exported — `SuiErrorSchema` is the published shape and this is how the
 * library reads its own keys.
 */
const SuiErrorTagged = SuiErrorSchema.pipe(Schema.toTaggedUnion("_tag"))

/**
 * What a failure says about the transaction it came from, on the axis a caller
 * or a wrapper script acts on.
 */
export type Outcome = "applied" | "not_applied" | "unknown"

/**
 * Where in the lifecycle a failure was caught, which is the only thing that
 * can classify an error the taxonomy does not own.
 *
 * `"post-submit"` (the default, and the 0.1.1 behaviour) is "bytes may have
 * gone out": a tag nobody here recognises proves nothing, so the answer is
 * `"unknown"`. `"pre-submit"` is a failure caught while **building, simulating
 * or signing** — an extension's own `PriceTooLow`, a validation error from the
 * caller's code — where nothing has been sent by construction and the honest
 * answer is `"not_applied"`.
 *
 * @since 0.1.2
 */
export type OutcomePhase = "pre-submit" | "post-submit"

/**
 * An extension error may declare its own `outcome`, and `SuiError.outcome` and
 * `Script.run` honour it before anything else.
 *
 * An error that declares none and carries a tag the taxonomy does not own is
 * `"unknown"`, not `"not_applied"`: a tag this library has never heard of says
 * nothing about whether a transaction applied, and `"not_applied"` would tell
 * the documented retry idiom to send again on no evidence at all.
 */
export interface HasOutcome {
  readonly outcome: Outcome
}

const OutcomeSchema = Schema.Literals(["applied", "not_applied", "unknown"])

const isHasOutcome = Schema.is(Schema.Struct({ outcome: OutcomeSchema }))

const hasOutcome = (error: unknown): error is HasOutcome => isHasOutcome(error)

const isRetryable = (error: SuiError): boolean =>
  error._tag === "TransportError" ? error.retryable : false

/**
 * Every tag the taxonomy owns, so a foreign tag can be told from one of ours.
 *
 * Derived from {@link SuiErrorSchema} rather than written out: a hand-kept copy
 * of the tag list is one edit that can be forgotten, and forgetting it here
 * used to mean an error the library defines being classified as somebody
 * else's. Adding a class to the union adds its tag here.
 */
const TAXONOMY_TAGS: ReadonlySet<string> = new Set(
  Object.keys(SuiErrorTagged.cases)
)

/**
 * What a failure says about the transaction it came from.
 *
 * An error that declares its own `outcome` is honoured first, which is how an
 * extension puts its failures on the same axis. Otherwise a tag the taxonomy
 * owns gets the taxonomy's answer, and **anything else is `"unknown"`**: a tag
 * this library has never heard of says nothing about whether a transaction
 * applied, and answering `"not_applied"` for it would tell a retry idiom to
 * send again on no evidence at all. `Script.exitCode` agrees by exiting 1 for
 * an unclassified error rather than 3.
 *
 * **`{ phase: "pre-submit" }` changes that last answer, and only that one.**
 * A failure caught while building, simulating or signing cannot have applied,
 * whoever's error it is, so an unrecognised tag there is `"not_applied"`
 * rather than `"unknown"`. Use it where the code knows nothing has been sent —
 * a `catchAll` around `Tx.build`/`Tx.sign`, an extension's validation — and
 * leave the default everywhere a submission may already be on the wire.
 * {@link isTaxonomy} answers the same question a level lower: is this even one
 * of ours?
 */
const outcome = (
  error: SuiError | HasOutcome,
  options?: { readonly phase?: OutcomePhase }
): Outcome => {
  if (hasOutcome(error)) return error.outcome
  const tag = (error as { readonly _tag?: unknown })._tag
  if (typeof tag !== "string" || !TAXONOMY_TAGS.has(tag)) {
    // Before anything was sent, an unclassifiable failure still means nothing
    // reached the chain; after, it means exactly nothing.
    return options?.phase === "pre-submit" ? "not_applied" : "unknown"
  }
  switch (tag) {
    case "ExecutionFailed":
    // An `UnexpectedEffects` is built from an `Executed`: the transaction
    // applied and gas was charged, and only the receipt is missing.
    case "UnexpectedEffects":
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

/**
 * The one line of a `cause` worth printing next to a tag: an `Error`'s message,
 * a tagged error's own `describe` line, a string as itself. `undefined` when
 * there is nothing readable, so `describe` prints nothing rather than
 * `[object Object]`.
 */
const causeLine = (cause: unknown): string | undefined => {
  if (cause === undefined || cause === null) return undefined
  if (typeof cause === "string") return cause.length === 0 ? undefined : cause
  if (typeof cause !== "object") return undefined
  const message = (cause as { readonly message?: unknown }).message
  if (typeof message === "string" && message.length > 0) return message
  const tag = (cause as { readonly _tag?: unknown })._tag
  if (typeof tag === "string") return tag
  if (cause instanceof Error && cause.name.length > 0) return cause.name
  return undefined
}

/**
 * One actionable line for a failure.
 *
 * **It accepts a foreign error too**, the way {@link outcome} and {@link toJson}
 * do: an extension's own `Schema.TaggedError`, or any object carrying a `_tag`.
 * A tag the taxonomy owns gets the taxonomy's wording; anything else gets its
 * own `message` after the tag, or the bare tag when there is nothing readable —
 * never `undefined`, which is what a `switch` with no default used to return
 * for a foreign tag while the signature promised a `string`. A wrapper script
 * that prints one line per failure should not have to know whose error it is
 * holding.
 */
const describe = (error: SuiError | { readonly _tag: string }): string => {
  if (!TAXONOMY_TAGS.has(error._tag)) {
    const line = causeLine(error)
    return line === undefined || line === error._tag ? error._tag : `${error._tag}: ${line}`
  }
  return describeTaxonomy(error as SuiError)
}

const describeTaxonomy = (error: SuiError): string => {
  switch (error._tag) {
    case "TransportError": {
      const cause = causeLine(error.cause)
      return `TransportError ${error.method}${error.status === undefined ? "" : ` ${error.status}`}${
        error.retryable ? " (retryable)" : ""
      }${cause === undefined ? "" : `: ${cause}`}`
    }
    case "ObjectNotFound":
    case "ObjectDeleted":
    case "ObjectUnavailable":
      return `${error._tag} ${error.objectId}`
    case "TransactionNotFound":
      return `TransactionNotFound ${error.digest}`
    case "NetworkMismatch":
      return `NetworkMismatch expected ${error.expected} but the node reported ${error.actual}`
    case "DecodeError":
      return `DecodeError ${error.kind} ${error.expectedType ?? ""} ${error.objectId ?? ""} ${error.issue}`
        .replace(/\s+/g, " ")
        .trim()
    case "SimulationFailed":
      return `SimulationFailed ${describeReason(error.reason)}`
    case "ExecutionFailed":
      return `ExecutionFailed ${describeReason(error.reason)}${
        error.command === undefined ? "" : ` in command ${error.command}`
      }`
    case "SubmissionUnknown": {
      const cause = causeLine(error.cause)
      return `SubmissionUnknown ${error.digest}${cause === undefined ? "" : `: ${cause}`}`
    }
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
    case "GraphQLUnavailable":
      return `GraphQLUnavailable ${error.method}: ${error.reason}`
    case "ExtensionNotReady":
      return `ExtensionNotReady ${error.extension}.${error.member} was called before the runtime existed: await client.${error.extension}.$ready() first, or register with warm`
  }
}

const encode = Schema.encodeUnknownResult(SuiErrorSchema)

/**
 * One error encoded through **its own** schema.
 *
 * Every `Schema.TaggedError` class is itself a schema, and an instance's
 * `constructor` is that class, so an error the closed taxonomy has never heard
 * of — an extension's `EscrowSettlementUnknown { escrowId, outcome }` — still
 * serializes with its fields instead of collapsing to a tag and a sentence.
 * `undefined` when the value is not a schema-backed error, or when its own
 * schema refuses it. Never fails.
 */
const encodeThroughOwnSchema = (error: unknown): Record<string, unknown> | undefined => {
  const schema = (error as { readonly constructor?: unknown })?.constructor
  if (!Schema.isSchema(schema)) return undefined
  const encoded = Schema.encodeUnknownResult(schema as Schema.Codec<unknown, unknown>)(error)
  if (!Result.isSuccess(encoded)) return undefined
  const value: unknown = encoded.success
  return Predicate.isObject(value) ? value : undefined
}

/**
 * The `outcome` of an error that declares one, when the encoded JSON has lost
 * it.
 *
 * `outcome` is almost always a **class field** on an extension error —
 * `readonly outcome: Outcome = "unknown"` beside a `Schema.TaggedError`'s
 * schema fields — and a class field is not part of the schema, so encoding
 * through the error's own schema drops it. It is also the one field a wrapper
 * script and an operator read first. So it is put back: `toJson` reads the
 * instance, not the schema, and adds `outcome` when the instance has one and
 * the encoding did not produce it. Never fails.
 */
const withOutcome = (
  error: unknown,
  json: Record<string, unknown>
): Record<string, unknown> => {
  if ("outcome" in json) return json
  const value = (error as { readonly outcome?: unknown })?.outcome
  return typeof value === "string" && (value === "applied" || value === "not_applied" ||
      value === "unknown")
    ? { ...json, outcome: value }
    : json
}

/**
 * The human sentence, in the same key for every error.
 *
 * Fifteen of the eighteen taxonomy classes carry `message` as an
 * `override get message()` rather than as a schema field, and a getter stays
 * out of the encoding — so a JSON log line had a sentence for three tags and
 * none for the rest, and an operator had to special-case them. This adds it
 * when the encoding did not produce one. Additive: a decoder ignores the
 * excess key, so every round trip still holds. Never fails.
 */
const withMessage = (
  json: Record<string, unknown>,
  sentence: () => string | undefined
): Record<string, unknown> => {
  if (typeof json["message"] === "string" && json["message"].length > 0) return json
  const value = sentence()
  return value === undefined || value.length === 0 ? json : { ...json, message: value }
}

/**
 * The JSON an operator or a log line gets for a failure.
 *
 * A tag in the taxonomy encodes through {@link SuiErrorSchema}. **Anything
 * else that is a `Schema.TaggedError` encodes through its own schema**, which
 * is how an extension's errors serialize with their fields rather than arriving
 * as a bare `{ _tag, message }`. Only a value that is neither falls back to
 * that.
 *
 * **`outcome` is always there when the error declares one**, including the
 * usual case where it is a class field rather than a schema field: it is read
 * off the instance and added to the encoded object. That is the field a
 * wrapper script acts on, and losing it in the log while `Script.exitCode` saw
 * it was the one inconsistency in the serialization.
 *
 * **`message` is always there too**, for the same reason: fifteen of the
 * eighteen taxonomy classes carry it as a getter, which stays out of the
 * encoding, so a log line had a sentence for three tags and nothing for the
 * rest. A taxonomy error gets {@link describe}; an extension error gets its own
 * `.message` when it is a non-empty string. Added only when the encoding
 * produced none, and ignored on decode, so nothing round-trips differently.
 *
 * Never fails.
 */
const toJson = (error: SuiError | { readonly _tag: string }): Record<string, unknown> => {
  const encoded = encode(error)
  if (Result.isSuccess(encoded)) {
    return withMessage(
      withOutcome(error, encoded.success as Record<string, unknown>),
      () => describe(error as SuiError)
    )
  }
  const own = encodeThroughOwnSchema(error)
  if (own !== undefined) {
    return withMessage(withOutcome(error, own), () => {
      const value = (error as { readonly message?: unknown }).message
      return typeof value === "string" && value.length > 0 ? value : undefined
    })
  }
  const message = TAXONOMY_TAGS.has(error._tag)
    ? describe(error as SuiError)
    : causeLine(error) ?? error._tag
  return withOutcome(error, { _tag: error._tag, message })
}

/**
 * Whether this error is one of the tags the closed taxonomy owns.
 *
 * The question a wrapper asks before trusting {@link outcome}'s default answer,
 * and the one a consumer asks before narrowing to `SuiError`. An extension's
 * own error, a `ConfigError`, a `TypeError` — all `false`. Never fails.
 *
 * @since 0.1.2
 */
const isTaxonomy = (error: unknown): error is SuiError => {
  const tag = (error as { readonly _tag?: unknown })?._tag
  return typeof tag === "string" && TAXONOMY_TAGS.has(tag)
}

/**
 * The helpers every repo hand-rolls: is this worth retrying, did the
 * transaction land, is it even one of ours, what does an operator need to read,
 * and what goes in a log.
 *
 * For *branching* on a failure, the taxonomy is a flat tagged union, so
 * `Effect.catchTags({ ObjectNotFound: ..., TransportError: ... })` in the error
 * channel and `Match.tagsExhaustive` over a `SuiError` value both work and are
 * the two documented consumer idioms; these helpers are for the questions that
 * are the same whatever the tag is.
 */
export const SuiError = {
  isRetryable,
  isTaxonomy,
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
