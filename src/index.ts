/**
 * sui-effect: an opinionated Effect v4 layer over `@mysten/sui`.
 *
 * Two tiers: `SuiCore` mirrors the SDK method for method, `Sui` makes the
 * opinionated decisions. Every public function states its error union in words,
 * every failure is a `Schema.TaggedError`, and every boundary decodes through
 * `Schema`.
 *
 * Everything this module exports is public API. The machinery behind it lives
 * in `sui-effect/internal`, which is not in the package `exports` map.
 *
 * @since 0.1.0
 */

/** The closed error taxonomy and its four helpers. */
export {
  BuildError,
  DecodeError,
  DecodeKind,
  ExecutionFailed,
  ExtensionNotReady,
  GraphQLUnavailable,
  type HasOutcome,
  JournalError,
  NetworkMismatch,
  NotApplied,
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  type Outcome,
  type OutcomePhase,
  PolicyDenied,
  SigningError,
  SimulationFailed,
  SubmissionUnknown,
  SuiError,
  TransactionNotFound,
  TransportError,
  UnexpectedEffects
} from "./domain/errors.ts"

/** Branded schemas and the transport-neutral object model. */
export {
  Balance,
  BalanceChange,
  Built,
  ChangedObject,
  CleverError,
  CoinType,
  CommandResult,
  Digest,
  DynamicField,
  DynamicFieldEntry,
  DynamicFieldName,
  Event,
  ExecutionReason,
  ExecutionStatus,
  GasCostSummary,
  chainOf,
  KNOWN_CHAIN_IDS,
  KnownNetwork,
  maxEpochOf,
  Mist,
  maxTimestampMsOf,
  MoveLocation,
  Network,
  NotAppliedEvidence,
  ObjectEnvelope,
  ObjectId,
  ObjectRef,
  ObjectType,
  Owner,
  Signature,
  SignedTransaction,
  Simulation,
  StructTag,
  SuiAddress,
  type SuiObject,
  TransactionEffects,
  TransactionExpiration,
  UnchangedConsensusObject,
  Version
} from "./domain/schemas.ts"

/** A transaction that reached the chain, with accessors over its effects. */
export {
  type ChangedRef,
  Executed,
  objectRefOf,
  type SdkObjectRef,
  sdkRefOf
} from "./domain/executed.ts"

/** The opinionated tier. */
export {
  type BatchItemError,
  type GetObjectError,
  type Recipe,
  Sui,
  type SuiLayerOptions,
  type SuiService
} from "./services/Sui.ts"

/** The mechanical tier. */
export {
  defaultGrpcUrl,
  type ObjectLookupError,
  type SimulationLookupError,
  SuiCore,
  type SuiCoreError,
  type SuiCoreService,
  type SuiGrpcLayerOptions,
  type TransactionLookupError,
  type VersionedObject
} from "./services/SuiCore.ts"

/** The SDK's GraphQL client as one shared tag. sui-effect wraps no GraphQL API. */
export { SuiGraphQL } from "./services/SuiGraphQL.ts"

/**
 * The BCS bridge, namespaced the way the spec spells it:
 * `SuiSchema.bcs(bcsType, expectedType)`.
 */
export * as SuiSchema from "./domain/sui-schema.ts"
