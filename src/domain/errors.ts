/**
 * The closed error taxonomy. Every failure sui-effect can produce is one of the
 * classes in this file, every one is a `Schema.TaggedError` so it serializes,
 * and the tags are flat: there is no error inheritance to match on.
 *
 * @since 0.1.0
 */
import { Effect, Option, Predicate, Result, Schema, SchemaIssue } from "effect"
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
  status: Schema.optionalKey(Schema.String),
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
  version: Schema.optionalKey(Version)
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
  version: Schema.optionalKey(Version)
}) {
  /** The one actionable line `SuiError.describe` produces for this error. */
  override get message(): string {
    return describe(this)
  }
}

/** The node could not say what happened to the object (`ObjectError.reason: "unknown"`). */
export class ObjectUnavailable extends Schema.TaggedError<ObjectUnavailable>()(
  "ObjectUnavailable",
  { objectId: ObjectId, version: Schema.optionalKey(Version) }
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
  objectId: Schema.optionalKey(ObjectId),
  expectedType: Schema.optionalKey(Schema.String),
  /**
   * The Move type the value actually had, on a `kind: "type"` failure — the
   * other half of the mismatch `expectedType` names. Absent on every other
   * kind, and on a `"type"` failure from a producer that did not know it.
   *
   * @since 0.4.0
   */
  actualType: Schema.optionalKey(Schema.String),
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
 * The **first** issue of a `SchemaError`'s formatted message, which is what
 * {@link DecodeError}'s `issue` has always carried.
 *
 * The producers decode with `{ errors: "all" }` so `issues` can carry every
 * path, and the formatter joins those issues with a newline — which turned
 * `error.message` into a paragraph. `issue` is one sentence for a human and
 * its shape is part of what 0.1.2 shipped, so it is cut back to the first
 * issue's block: the message plus the indented `at [...]` line the formatter
 * puts under it. A single-issue failure has no second block, so it comes
 * through byte for byte. Never fails.
 */
const firstIssue = (message: string): string => {
  const lines = message.split("\n")
  // A continuation line of the same issue is indented; the next issue starts
  // at column zero.
  const next = lines.findIndex((line, index) => index > 0 && !line.startsWith("  "))
  return next === -1 ? message : lines.slice(0, next).join("\n")
}

/**
 * The `DecodeError` payload a failed decode deserves: the first issue as the
 * sentence `issue` has always been, and every issue as `{ path, message }`.
 *
 * `SchemaError.issue` is a tree; the second half is Effect's own
 * Standard-Schema formatter over it, so the paths are the ones every other
 * tool prints. A decode run with `{ errors: "all" }` reports every field
 * rather than the first. Never fails.
 */
export const decodePayload = (error: Schema.SchemaError): {
  readonly issue: string
  readonly issues: ReadonlyArray<
    { readonly path: ReadonlyArray<string | number>; readonly message: string }
  >
} => ({ issue: firstIssue(error.message), issues: decodeIssues(error) })

const decodeIssues = (
  error: Schema.SchemaError
): ReadonlyArray<{ readonly path: ReadonlyArray<string | number>; readonly message: string }> =>
  standardIssues(error.issue).issues.map((issue) => ({
    path: (issue.path ?? []).map((segment) => {
      const key = Predicate.isObject(segment) ? segment["key"] : segment
      return typeof key === "number" ? key : String(key)
    }),
    message: issue.message
  }))

/**
 * Simulation reported an execution failure. No gas was charged.
 *
 * `message` is the SDK's own sentence; `command` is the index of the command
 * that failed, when the node named one — the same field `ExecutionFailed`
 * carries, so the two describe one abort the same way.
 */
export class SimulationFailed extends Schema.TaggedError<SimulationFailed>()("SimulationFailed", {
  reason: ExecutionReason,
  message: Schema.String,
  /** @since 0.4.0 */
  command: Schema.optionalKey(Schema.Finite)
}) {}

/** The transaction was applied on chain and failed. Gas was charged. */
export class ExecutionFailed extends Schema.TaggedError<ExecutionFailed>()("ExecutionFailed", {
  digest: Digest,
  reason: ExecutionReason,
  command: Schema.optionalKey(Schema.Finite),
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
  { digest: Digest, signed: Schema.optionalKey(SignedTransaction), cause: Schema.Defect() }
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

/**
 * `run()`, or `fallback` when it throws.
 *
 * Every helper on {@link SuiError} is documented "Never fails" and takes
 * `unknown`, and a value from outside can throw from anywhere: a getter, a
 * Proxy trap (a revoked Proxy throws from `Array.isArray`), a `toString`, a
 * taxonomy tag on an object without the tag's fields. The helpers read such a
 * value through this, so the worst they answer is a tag-shaped line, `false`,
 * `none` or `"unknown"`, never an exception.
 */
const totally = <A>(run: () => A, fallback: () => A): A => {
  try {
    return run()
  } catch {
    return fallback()
  }
}

const hasOutcome = (error: unknown): error is HasOutcome => totally(() => isHasOutcome(error), () => false)

const tagOf = (error: unknown): string | undefined =>
  totally(() => {
    const tag = Predicate.isObject(error) ? error["_tag"] : undefined
    return typeof tag === "string" ? tag : undefined
  }, () => undefined)

const isRetryable = (error: unknown): boolean =>
  totally(
    () => tagOf(error) === "TransportError" && (error as TransportError).retryable === true,
    () => false
  )

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
 * Takes **any** value — a `SuiError`, an extension's error, a `SchemaError`, a
 * `ConfigError`, whatever a Promise rejected with — so a `catch (e: unknown)`
 * needs no cast.
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
 *
 * Never fails.
 */
const outcome = (
  error: unknown,
  options?: { readonly phase?: OutcomePhase }
): Outcome => {
  if (hasOutcome(error)) {
    const declared = totally((): Outcome | undefined => error.outcome, () => undefined)
    if (declared !== undefined) return declared
  }
  const tag = tagOf(error)
  if (tag === undefined || !TAXONOMY_TAGS.has(tag)) {
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

/** Move constant types whose rendered value reads as itself, not as text. */
const UNQUOTED_CONSTANT_TYPE = /^(u8|u16|u32|u64|u128|u256|bool|address)$/

/**
 * A clever error's value as it reads in a line: quoted when it is text (a
 * `vector<u8>` constant, or one whose type the node did not say), bare when it
 * is a number, a bool or an address.
 */
const formatCleverValue = (value: string, constantType: string | undefined): string =>
  constantType !== undefined && UNQUOTED_CONSTANT_TYPE.test(constantType)
    ? value
    : JSON.stringify(value)

/**
 * The Move abort part of a line.
 *
 * A **clever error** (`#[error] const EEmptyBody: vector<u8> = b"..."`) reads
 * `ECONST "value" (line N)`, plus `code N` when the constant declared one with
 * `#[error(code = N)]`. Its raw `abortCode` is a packed integer that encodes
 * the constant's location and means nothing to a reader, so it is left out. A
 * plain `abort N` reads `code N`, plus `(line N)` when the node knew it.
 */
const describeMoveAbort = (
  value: Extract<ExecutionReason, { readonly $kind: "MoveAbort" }>
): string => {
  const abort = value.MoveAbort
  const clever = abort.cleverError
  const line = clever?.lineNumber === undefined ? "" : ` (line ${clever.lineNumber})`
  if (clever?.constantName !== undefined) {
    const rendered = clever.value === undefined
      ? ""
      : ` ${formatCleverValue(clever.value, clever.constantType)}`
    const code = clever.errorCode === undefined ? "" : ` code ${clever.errorCode}`
    return `MoveAbort${formatTarget(value)} ${clever.constantName}${rendered}${line}${code}`
  }
  return `MoveAbort${formatTarget(value)} code ${abort.abortCode}${line}`
}

/** The prefix the SDK's resolver puts on every simulation it wraps. */
const RESOLUTION_PREFIX = /^Transaction resolution failed:\s*/

/**
 * The sentence an `Unknown` reason is described by: its own `message`, else
 * the carrying error's, minus the resolver's prefix. `undefined` when neither
 * says anything.
 */
const unknownSentence = (
  reason: ExecutionReason,
  fallback: string | undefined
): string | undefined => {
  const own = reason.$kind === "Unknown" ? reason.message : undefined
  for (const candidate of [own, fallback]) {
    if (candidate === undefined) continue
    const trimmed = oneLine(candidate.replace(RESOLUTION_PREFIX, ""))
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

const describeReason = (reason: ExecutionReason, fallback?: string): string =>
  ExecutionReason.match(reason, {
    MoveAbort: describeMoveAbort,
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
    // The SDK reports every kind it has no variant for as `Unknown`, with the
    // real kind only in the sentence: print the sentence, not the word.
    Unknown: (value) => unknownSentence(value, fallback) ?? "Unknown"
  })

/**
 * The reason plus ` in command N`, which `SimulationFailed` and
 * `ExecutionFailed` share so one abort reads the same whether it was caught
 * before or after the send. The command is not repeated when the sentence of
 * an `Unknown` already names it (`"InsufficientCoinBalance in command 0"`).
 */
const describeFailure = (
  reason: ExecutionReason,
  command: number | undefined,
  fallback?: string
): string => {
  const line = describeReason(reason, fallback)
  const at = command ?? (reason.$kind === "Unknown" ? reason.command : undefined)
  if (at === undefined) return line
  const suffix = ` in command ${at}`
  return line.includes(suffix) ? line : `${line}${suffix}`
}

/** The longest cause line `describe` prints before cutting it short. */
const MAX_CAUSE_LENGTH = 1000

/** A string on one line: every run of whitespace, newlines included, is one space. */
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const clip = (text: string): string =>
  text.length <= MAX_CAUSE_LENGTH ? text : `${text.slice(0, MAX_CAUSE_LENGTH - 1)}…`

/**
 * The one line of a `cause` worth printing next to a tag: a tagged error's own
 * `describe` line, an `Error`'s message (after its name, when the name says
 * something — `TypeError: undefined is not an object`), a string as itself.
 * Always one line and never longer than {@link MAX_CAUSE_LENGTH}. `undefined`
 * when there is nothing readable, so `describe` prints nothing rather than
 * `[object Object]`.
 */
const causeLine = (cause: unknown): string | undefined => {
  const line = rawCauseLine(cause)
  if (line === undefined) return undefined
  const flat = oneLine(line)
  return flat.length === 0 ? undefined : clip(flat)
}

/**
 * The objects whose line is being read right now.
 *
 * Reading a foreign error's line reads its `.message`, and an extension error
 * that does what the house classes do — `override get message() { return
 * SuiError.describe(this) }` — calls straight back in; so does a cyclic
 * `cause` chain. A value met again while its own line is being read answers
 * its tag, which is what turns that recursion into a one-line answer instead
 * of a stack overflow.
 */
const READING = new WeakSet<object>()

const rawCauseLine = (cause: unknown): string | undefined => {
  if (cause === undefined || cause === null) return undefined
  if (typeof cause === "string") return cause.length === 0 ? undefined : cause
  if (typeof cause !== "object") return undefined
  if (READING.has(cause)) return tagOf(cause)
  READING.add(cause)
  try {
    return readCauseLine(cause)
  } catch {
    return tagOf(cause)
  } finally {
    READING.delete(cause)
  }
}

const readCauseLine = (cause: object): string | undefined => {
  const tag = tagOf(cause)
  if (tag !== undefined && TAXONOMY_TAGS.has(tag)) return describeTaxonomySafely(cause as SuiError)
  if (tag === "ConfigError") return describeConfigError(cause)
  const message = (cause as { readonly message?: unknown }).message
  if (typeof message === "string" && message.length > 0) {
    // A JS error's name is worth keeping (`TypeError`, `ValiError`); a
    // transport's (`RpcError`, with its status already in the message) and a
    // tagged error's (already its own line) are not.
    const name = cause instanceof Error ? cause.name : undefined
    const plain = name !== undefined && name !== "Error" && tag === undefined &&
      !("code" in cause) && !("status" in cause) && !message.startsWith(name)
    return plain ? `${name}: ${message}` : message
  }
  if (tag !== undefined) return tag
  if (cause instanceof Error && cause.name.length > 0) return cause.name
  return undefined
}

/**
 * The environment variable a config path is read from: the segments joined by
 * `_`, which is how `ConfigProvider.fromEnv` — the provider a script runs
 * under — spells `["TIPJAR", "PACKAGE_ID"]`.
 */
const envName = (path: ReadonlyArray<PropertyKey>): string =>
  path.map((segment) => String(segment)).join("_")

/**
 * Walks a config `SchemaIssue` to its leaves, as `missing NAME` or
 * `NAME: message` items.
 *
 * Under a `ConfigProvider` every leaf value is a string, so an `InvalidType` at
 * a path — `Expected string`, `Expected object` — means **nothing was there**,
 * and a `MissingKey` says so outright. An `Expected object` for a struct is
 * expanded into the struct's own keys, which is what turns
 * `Expected object at ["TIPJAR"]` into `missing TIPJAR_PACKAGE_ID`. Anything
 * else (a filter, an encoding) is a value that was there and was wrong.
 */
const configItems = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  out: Array<string>
): void => {
  switch (issue._tag) {
    case "Pointer":
      return configItems(issue.issue, [...path, ...issue.path], out)
    case "Composite":
    case "AnyOf":
      for (const inner of issue.issues) configItems(inner, path, out)
      return
    case "MissingKey":
      out.push(`missing ${envName(path)}`)
      return
    case "InvalidType": {
      const ast = issue.ast
      if (ast._tag === "Objects" && ast.propertySignatures.length > 0) {
        for (const property of ast.propertySignatures) {
          if (property.type.context?.isOptional === true) continue
          out.push(`missing ${envName([...path, property.name])}`)
        }
        return
      }
      out.push(`missing ${envName(path)}`)
      return
    }
    default: {
      const message = standardIssues(issue).issues.map((item) => item.message).join("; ")
      out.push(`${envName(path)}: ${message.length === 0 ? "invalid" : message}`)
    }
  }
}

/**
 * Effect's `ConfigError` on one line that names the variable: `missing
 * SUI_NETWORK`, `TIPJAR_PACKAGE_ID: Expected a value with a length of at least
 * 3`. Its own `message` is the `SchemaError` rendering, two lines with the path
 * as a JSON array. A `ConfigError` over a provider failure (`SourceError`)
 * keeps that failure's message.
 */
const describeConfigError = (error: object): string => {
  const cause = (error as { readonly cause?: unknown }).cause
  if (Schema.isSchemaError(cause)) {
    const items: Array<string> = []
    configItems(cause.issue, [], items)
    if (items.length > 0) return items.join(", ")
  }
  const line = Predicate.isObject(cause) ? rawCauseLine(cause) : undefined
  return line ?? "the configuration did not load"
}

/** What {@link describe} may be told. */
export interface DescribeOptions {
  /**
   * `false` drops the leading tag, for a caller that prints it in a column of
   * its own (`ExecutionFailed MoveAbort ...` becomes `MoveAbort ...`). Default
   * `true`.
   */
  readonly tag?: boolean
}

/**
 * One actionable line for a failure — **any** failure.
 *
 * It takes `unknown`, the way {@link outcome}, {@link toJson} and
 * {@link isTaxonomy} do, so a Promise `catch` needs no cast. A tag the taxonomy
 * owns gets the taxonomy's wording; Effect's `ConfigError` names the variable
 * (`ConfigError missing SUI_NETWORK`); any other tagged value gets its own
 * `message` after the tag, or the bare tag when there is nothing readable; an
 * `Error` gets its name and message; anything else its `String`. The line is
 * always one line — a cause's newlines are folded — and never `undefined`.
 *
 * What it prints, per tag, is chosen so the line alone says what to do next:
 * a Move abort names its constant, value and line (never the packed clever
 * code), an `Unknown` reason prints the node's sentence
 * (`SimulationFailed InsufficientCoinBalance in command 0`), a `BuildError`,
 * `SigningError`, `JournalError` or `SubmissionUnknown` appends its cause's
 * line, and nothing ever prints transaction bytes.
 *
 * `{ tag: false }` drops the leading tag. Never fails.
 */
const describe = (error: unknown, options?: DescribeOptions): string => {
  const tag = tagOf(error)
  const line = totally(() => describeAny(error, tag), () => tag ?? stringOf(error))
  if (options?.tag !== false || tag === undefined) return line
  if (line === tag) return line
  for (const separator of [": ", " "]) {
    if (line.startsWith(`${tag}${separator}`)) return line.slice(tag.length + separator.length)
  }
  return line
}

/**
 * `String(value)`, for a value whose `toString` may throw or not exist (a
 * null-prototype object): then `Object.prototype.toString`, then
 * `"UnknownError"`.
 */
const stringOf = (value: unknown): string =>
  totally(
    () => oneLine(String(value)),
    () => totally(() => Object.prototype.toString.call(value), () => "UnknownError")
  )

const describeAny = (error: unknown, tag: string | undefined): string => {
  if (tag !== undefined && TAXONOMY_TAGS.has(tag)) return describeTaxonomySafely(error as SuiError)
  if (tag === "ConfigError") {
    if (Predicate.isObject(error) && READING.has(error)) return tag
    READING.add(error as object)
    try {
      return `ConfigError ${oneLine(describeConfigError(error as object))}`
    } finally {
      READING.delete(error as object)
    }
  }
  if (tag !== undefined) {
    const line = causeLine(error)
    return line === undefined || line === tag ? tag : `${tag}: ${line}`
  }
  return causeLine(error) ?? (totally(() => error instanceof Error, () => false)
    ? (error as Error).name
    : stringOf(error))
}

/** ` (cause)`-style tail: `: <line>` when there is a line worth printing. */
const withCause = (head: string, cause: unknown): string => {
  const line = causeLine(cause)
  return line === undefined || head.endsWith(line) ? head : `${head}: ${line}`
}

/**
 * A `SubmissionUnknown`'s line: its digest and its cause, which is where
 * `Tx.submit` folds the last execute failure.
 */
const describeSubmissionUnknown = (error: SubmissionUnknown): string =>
  withCause(`SubmissionUnknown ${error.digest}`, error.cause)

const describeDecodeError = (error: DecodeError): string => {
  if (error.kind === "type" && error.actualType !== undefined) {
    const subject = error.objectId === undefined ? "the value" : `object ${error.objectId}`
    const expected = error.expectedType === undefined ? "" : `, expected ${error.expectedType}`
    return `DecodeError type: ${subject} is ${error.actualType}${expected}`
  }
  return oneLine(`DecodeError ${error.kind} ${error.expectedType ?? ""} ${error.objectId ?? ""} ${error.issue}`)
}

/**
 * {@link describeTaxonomy}, or the bare tag when the value carries a taxonomy
 * tag without the fields the tag promises (`{ _tag: "ExecutionFailed" }`).
 */
const describeTaxonomySafely = (error: SuiError): string =>
  totally(() => describeTaxonomy(error), () => tagOf(error) ?? "UnknownError")

const describeTaxonomy = (error: SuiError): string => {
  switch (error._tag) {
    case "TransportError":
      return withCause(
        `TransportError ${error.method}${error.status === undefined ? "" : ` ${error.status}`}${
          error.retryable ? " (retryable)" : ""
        }`,
        error.cause
      )
    case "ObjectNotFound":
    case "ObjectDeleted":
    case "ObjectUnavailable":
      return `${error._tag} ${error.objectId}`
    case "TransactionNotFound":
      return `TransactionNotFound ${error.digest}`
    case "NetworkMismatch":
      return `NetworkMismatch expected ${error.expected} but the node reported ${error.actual}`
    case "DecodeError":
      return describeDecodeError(error)
    case "SimulationFailed":
      return `SimulationFailed ${describeFailure(error.reason, error.command, error.message)}`
    case "ExecutionFailed":
      return `ExecutionFailed ${describeFailure(error.reason, error.command)}`
    case "SubmissionUnknown":
      return describeSubmissionUnknown(error)
    case "NotApplied":
      return `NotApplied ${error.digest} (${error.evidence})`
    case "SigningError":
      return withCause("SigningError", error.cause)
    case "BuildError":
      return withCause(oneLine(`BuildError ${error.message}`), error.cause)
    case "PolicyDenied":
      return oneLine(`PolicyDenied ${error.rule}: ${error.message}`)
    case "JournalError":
      return withCause("JournalError", error.cause)
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
  return hasOutcome(error) ? { ...json, outcome: error.outcome } : json
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
 * The JSON an operator or a log line gets for a failure — **any** failure.
 *
 * A tag in the taxonomy encodes through {@link SuiErrorSchema}. **Anything
 * else that is a `Schema.TaggedError` encodes through its own schema**, which
 * is how an extension's errors serialize with their fields rather than arriving
 * as a bare `{ _tag, message }`. A value that is neither falls back to that
 * pair: a tagged value keeps its tag, an `Error` uses its `name`, and anything
 * else is `{ _tag: "UnknownError", message: String(value) }`. Takes `unknown`,
 * so a Promise `catch` needs no cast.
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
const toJson = (error: unknown): Record<string, unknown> => {
  const tag = tagOf(error)
  const fallback = (): Record<string, unknown> => ({
    _tag: tag ?? "UnknownError",
    message: tag === undefined ? describe(error) : describe(error, { tag: false })
  })
  if (!totally(() => Predicate.isObject(error), () => true)) return totally(() => toJsonOf(error, tag), fallback)
  const object = error as object
  // A `message` getter that calls `toJson(this)` comes straight back here.
  if (SERIALIZING.has(object)) return { _tag: tag ?? "UnknownError", message: tag ?? "UnknownError" }
  SERIALIZING.add(object)
  try {
    return totally(() => toJsonOf(error, tag), fallback)
  } finally {
    SERIALIZING.delete(object)
  }
}

/** The objects {@link toJson} is serializing right now; see {@link READING}. */
const SERIALIZING = new WeakSet<object>()

const toJsonOf = (error: unknown, tag: string | undefined): Record<string, unknown> => {
  if (tag !== undefined && TAXONOMY_TAGS.has(tag)) {
    const encoded = encode(error)
    if (Result.isSuccess(encoded)) {
      return withMessage(
        withOutcome(error, encoded.success as Record<string, unknown>),
        () => describe(error)
      )
    }
  }
  const own = tag === undefined ? undefined : encodeThroughOwnSchema(error)
  if (own !== undefined) {
    return withMessage(withOutcome(error, own), () => {
      const value = (error as { readonly message?: unknown }).message
      return typeof value === "string" && value.length > 0 ? value : undefined
    })
  }
  if (tag !== undefined) {
    const message = TAXONOMY_TAGS.has(tag) || tag === "ConfigError"
      ? describe(error, { tag: false })
      : causeLine(error) ?? tag
    return withOutcome(error, { _tag: tag, message })
  }
  if (error instanceof Error) {
    return withOutcome(error, { _tag: error.name, message: describe(error) })
  }
  return withOutcome(error, { _tag: "UnknownError", message: describe(error) })
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
  const tag = tagOf(error)
  return tag !== undefined && TAXONOMY_TAGS.has(tag)
}

/**
 * The digest of the transaction a failure refers to, when it has one:
 * `TransactionNotFound`, `ExecutionFailed`, `SubmissionUnknown`, `NotApplied`
 * and `UnexpectedEffects` carry one; every other value, taxonomy or not,
 * answers `undefined`. Takes `unknown`, so it can be pointed at an extension
 * error's `cause` without narrowing first. Never fails.
 *
 * @since 0.4.0
 */
export const digestOf = (error: unknown): Digest | undefined => {
  if (!isTaxonomy(error)) return undefined
  switch (error._tag) {
    case "TransactionNotFound":
    case "ExecutionFailed":
    case "SubmissionUnknown":
    case "NotApplied":
    case "UnexpectedEffects":
      return totally((): Digest | undefined => error.digest, () => undefined)
    default:
      return undefined
  }
}

/**
 * A Move abort, read off a `SimulationFailed` or an `ExecutionFailed` into the
 * fields a caller matches on.
 *
 * - `module`, `function`, `package`: where it aborted, when the node said.
 *   **After an upgrade `package` is the id of the latest version** of the
 *   package, not the one the type was first published under, so match on
 *   `module` and `constant` (or `code`) rather than on `package`.
 * - `code`: the code as the Move source wrote it — `N` in `abort N` and
 *   `assert!(cond, N)`, and the declared `#[error(code = N)]` of a clever
 *   error. For a clever error with no declared code it is the raw
 *   `abortCode`, a packed integer: match on `constant` instead.
 * - `abortCode`: always the raw code the VM reported.
 * - `constant`, `message`, `line`: a clever error's constant name, its
 *   rendered value, and the source line of the abort.
 * - `command`: the index of the command that aborted.
 *
 * @since 0.4.0
 */
export interface MoveAbortInfo {
  readonly package?: string
  readonly module?: string
  readonly function?: string
  readonly code: bigint
  readonly abortCode: bigint
  readonly constant?: string
  readonly message?: string
  readonly line?: number
  readonly command?: number
}

/**
 * The {@link MoveAbortInfo} a failure is, if it is one: `Option.some` for a
 * `SimulationFailed` or an `ExecutionFailed` whose reason is `MoveAbort`,
 * `Option.none` for anything else — any value at all. Never fails.
 *
 * @example
 * ```ts
 * import { SuiError } from "@unconfirmed/sui-effect"
 * import { Option } from "effect"
 *
 * declare const error: unknown
 * const abort = SuiError.moveAbort(error)
 * if (Option.isSome(abort) && abort.value.module === "board") {
 *   console.log(abort.value.constant, abort.value.line)
 * }
 * ```
 *
 * @since 0.4.0
 */
const moveAbort = (error: unknown): Option.Option<MoveAbortInfo> =>
  totally(() => readMoveAbort(error), () => Option.none())

const readMoveAbort = (error: unknown): Option.Option<MoveAbortInfo> => {
  const tag = tagOf(error)
  if (tag !== "SimulationFailed" && tag !== "ExecutionFailed") return Option.none()
  const failure = error as SimulationFailed | ExecutionFailed
  const reason = failure.reason
  if (reason?.$kind !== "MoveAbort") return Option.none()
  const { abortCode, location, cleverError } = reason.MoveAbort
  return Option.some({
    ...(location?.package === undefined ? {} : { package: location.package }),
    ...(location?.module === undefined ? {} : { module: location.module }),
    ...(location?.functionName === undefined ? {} : { function: location.functionName }),
    code: cleverError?.errorCode !== undefined
      ? BigInt(cleverError.errorCode)
      : abortCode,
    abortCode,
    ...(cleverError?.constantName === undefined ? {} : { constant: cleverError.constantName }),
    ...(cleverError?.value === undefined ? {} : { message: cleverError.value }),
    ...(cleverError?.lineNumber === undefined ? {} : { line: cleverError.lineNumber }),
    ...(failure.command === undefined ? {} : { command: failure.command })
  })
}

/**
 * What {@link isMoveAbort} matches on. Every field given must match; none given
 * matches every Move abort. `package` is compared as an address (padding and
 * case do not matter) — but see {@link MoveAbortInfo}: after an upgrade the node
 * names the **latest** package id, so prefer `module` plus `constant` or
 * `code`.
 *
 * @since 0.4.0
 */
export interface MoveAbortMatch {
  readonly package?: string
  readonly module?: string
  readonly function?: string
  readonly constant?: string
  readonly code?: number | bigint
}

const normalizeHex = (value: string): string =>
  value.toLowerCase().replace(/^0x/, "").replace(/^0+/, "")

/**
 * Whether a failure is a Move abort, and — given a {@link MoveAbortMatch} —
 * the one you mean: `SuiError.isMoveAbort(e, { module: "tipjar", constant:
 * "EWrongCap" })`. Narrows to `SimulationFailed | ExecutionFailed`, so the
 * usual next step is mapping it to an extension's own error. Takes any value.
 * Never fails.
 *
 * @example
 * ```ts
 * import { SuiError } from "@unconfirmed/sui-effect"
 *
 * declare const error: unknown
 * if (SuiError.isMoveAbort(error, { module: "board", code: 1 })) {
 *   // error is SimulationFailed | ExecutionFailed
 * }
 * ```
 *
 * @since 0.4.0
 */
const isMoveAbort = (
  error: unknown,
  match?: MoveAbortMatch
): error is SimulationFailed | ExecutionFailed => {
  const found = moveAbort(error)
  if (Option.isNone(found)) return false
  const abort = found.value
  if (match === undefined) return true
  return totally(() => matchesAbort(abort, match), () => false)
}

const matchesAbort = (abort: MoveAbortInfo, match: MoveAbortMatch): boolean => {
  if (
    match.package !== undefined &&
    (abort.package === undefined || normalizeHex(abort.package) !== normalizeHex(match.package))
  ) return false
  if (match.module !== undefined && abort.module !== match.module) return false
  if (match.function !== undefined && abort.function !== match.function) return false
  if (match.constant !== undefined && abort.constant !== match.constant) return false
  if (match.code !== undefined) {
    // `BigInt(1.5)` throws a RangeError: a code that is not an integer matches
    // no abort.
    if (typeof match.code === "number" && !Number.isInteger(match.code)) return false
    if (abort.code !== BigInt(match.code)) return false
  }
  return true
}

/**
 * The helpers every repo hand-rolls: is this worth retrying, did the
 * transaction land, is it even one of ours, what does an operator need to read,
 * what goes in a log, which transaction is it about, and which Move abort was
 * it. Every one takes `unknown`.
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
  toJson,
  digestOf,
  moveAbort,
  isMoveAbort
} as const
