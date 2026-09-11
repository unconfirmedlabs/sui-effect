/**
 * Branded schemas and the transport-neutral object model.
 *
 * Every schema here decodes from the shape `@mysten/sui` returns, so a raw SDK
 * response can be validated at the boundary with one `Schema.decodeUnknownEffect`
 * call. Names mirror the SDK names they model.
 *
 * @since 0.1.0
 */
import type { SuiClientTypes } from "@mysten/sui/client"
import { Schema, SchemaGetter } from "effect"
import {
  isValidStructTag,
  isValidSuiAddress,
  isValidTransactionDigest,
  normalizeStructTag,
  normalizeSuiAddress
} from "@mysten/sui/utils"

const normalizeStructTagSafe = (value: string): string => {
  try {
    return normalizeStructTag(value)
  } catch {
    return value
  }
}

/**
 * A 32-byte Sui account address, normalized to the padded lowercase `0x` form on
 * decode. Rejects anything `isValidSuiAddress` rejects with a `SchemaError`.
 */
export const SuiAddress = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value: string) => normalizeSuiAddress(value)),
    encode: SchemaGetter.passthrough()
  }),
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidSuiAddress(value) ? undefined : "Expected a 32-byte Sui address"
    )
  ),
  Schema.brand("SuiAddress")
)
export type SuiAddress = typeof SuiAddress.Type

/**
 * A 32-byte object id. Same encoding rules as {@link SuiAddress}; the brand is
 * separate so an address cannot be passed where an object id is expected.
 */
export const ObjectId = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value: string) => normalizeSuiAddress(value)),
    encode: SchemaGetter.passthrough()
  }),
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidSuiAddress(value) ? undefined : "Expected a 32-byte Sui object id"
    )
  ),
  Schema.brand("ObjectId")
)
export type ObjectId = typeof ObjectId.Type

/** A base58 transaction digest. Not normalized; rejected when not 32 bytes. */
export const Digest = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidTransactionDigest(value) ? undefined : "Expected a base58 32-byte transaction digest"
    )
  ),
  Schema.brand("Digest")
)
export type Digest = typeof Digest.Type

/**
 * A fully qualified Move struct tag, normalized with `normalizeStructTag` on
 * decode so `0x2::sui::SUI` and its padded form compare equal.
 */
export const StructTag = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(normalizeStructTagSafe),
    encode: SchemaGetter.passthrough()
  }),
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidStructTag(value) ? undefined : "Expected a fully qualified Move struct tag"
    )
  ),
  Schema.brand("StructTag")
)
export type StructTag = typeof StructTag.Type

/** A coin type: a struct tag used as the type argument of `0x2::coin::Coin`. */
export const CoinType = Schema.String.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(normalizeStructTagSafe),
    encode: SchemaGetter.passthrough()
  }),
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidStructTag(value) ? undefined : "Expected a fully qualified Move coin type"
    )
  ),
  Schema.brand("CoinType")
)
export type CoinType = typeof CoinType.Type

/**
 * The `type` field of an object envelope. Almost always a struct tag, but gRPC
 * reports the literal `package` for a Move package object (`grpc/core.mjs`
 * leaves `objectType` untouched when it has no `::`), and a package is a
 * readable object like any other.
 */
export const ObjectType = Schema.Union([StructTag, Schema.Literal("package")])
export type ObjectType = typeof ObjectType.Type

/** An amount in MIST. Encoded as the decimal string every SDK response uses. */
export const Mist = Schema.BigIntFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Mist")
)
export type Mist = typeof Mist.Type

/** A Move object version. Encoded as the decimal string the SDK returns. */
export const Version = Schema.BigIntFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  Schema.brand("Version")
)
export type Version = typeof Version.Type

/** The network a client is pointed at. Mirrors `SuiClientTypes.Network`. */
export const Network = Schema.String.pipe(Schema.brand("Network"))
export type Network = typeof Network.Type

/** The four networks with a built-in default gRPC endpoint. */
export const KnownNetwork = Schema.Literals(["mainnet", "testnet", "devnet", "localnet"])
export type KnownNetwork = typeof KnownNetwork.Type

/**
 * The genesis checkpoint digest of each public network whose chain identifier
 * is fixed and known. These are the digests observed on the live networks
 * (`getChainIdentifier` returns the genesis checkpoint digest); the SDK ships
 * no such table. `devnet` and `localnet` are regenerated, so they are absent
 * and `Sui.layerNoDeps` records whatever the node reports instead of asserting.
 */
export const KNOWN_CHAIN_IDS: Readonly<Record<string, string>> = {
  mainnet: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  testnet: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD"
}

/**
 * An object owner. Mirrors `SuiClientTypes.ObjectOwner` exactly, including its
 * `$kind` discriminant, so `Owner.match` and the SDK's own narrowing agree.
 */
export const Owner = Schema.Union([
  Schema.Struct({ $kind: Schema.Literal("AddressOwner"), AddressOwner: SuiAddress }),
  Schema.Struct({ $kind: Schema.Literal("ObjectOwner"), ObjectOwner: ObjectId }),
  Schema.Struct({
    $kind: Schema.Literal("Shared"),
    Shared: Schema.Struct({ initialSharedVersion: Version })
  }),
  Schema.Struct({ $kind: Schema.Literal("Immutable"), Immutable: Schema.Literal(true) }),
  Schema.Struct({
    $kind: Schema.Literal("ConsensusAddressOwner"),
    ConsensusAddressOwner: Schema.Struct({ startVersion: Version, owner: SuiAddress })
  }),
  Schema.Struct({ $kind: Schema.Literal("Unknown") })
]).pipe(Schema.toTaggedUnion("$kind"))
export type Owner = typeof Owner.Type

/**
 * Everything the transaction builder needs to consume an object again, plus the
 * type and owner so a caller can tell a shared object from an owned one.
 */
export const ObjectRef = Schema.Struct({
  id: ObjectId,
  type: ObjectType,
  version: Version,
  digest: Schema.String,
  owner: Owner
})
export type ObjectRef = typeof ObjectRef.Type

/** A coin balance for one coin type. Mirrors `SuiClientTypes.Balance`. */
export const Balance = Schema.Struct({
  coinType: CoinType,
  balance: Mist,
  coinBalance: Mist,
  addressBalance: Mist
})
export type Balance = typeof Balance.Type

/** The BCS-encoded name of a dynamic field. Mirrors `SuiClientTypes.DynamicFieldName`. */
export const DynamicFieldName = Schema.Struct({
  type: Schema.String,
  bcs: Schema.Uint8Array
})
export type DynamicFieldName = typeof DynamicFieldName.Type

/** One entry of a dynamic-field listing. Mirrors `SuiClientTypes.DynamicFieldEntry`. */
export const DynamicFieldEntry = Schema.Struct({
  fieldId: ObjectId,
  type: Schema.String,
  name: DynamicFieldName,
  valueType: Schema.String,
  $kind: Schema.Literals(["DynamicField", "DynamicObject"]),
  childId: Schema.optional(ObjectId)
})
export type DynamicFieldEntry = typeof DynamicFieldEntry.Type

/** A dynamic field with its value. Mirrors `SuiClientTypes.DynamicField`. */
export const DynamicField = Schema.Struct({
  fieldId: ObjectId,
  type: Schema.String,
  name: DynamicFieldName,
  valueType: Schema.String,
  $kind: Schema.Literals(["DynamicField", "DynamicObject"]),
  childId: Schema.optional(ObjectId),
  value: Schema.Struct({ type: Schema.String, bcs: Schema.Uint8Array }),
  version: Version,
  digest: Schema.String
})
export type DynamicField = typeof DynamicField.Type

/** Gas cost breakdown. Mirrors `SuiClientTypes.GasCostSummary`. */
export const GasCostSummary = Schema.Struct({
  computationCost: Mist,
  storageCost: Mist,
  storageRebate: Mist,
  nonRefundableStorageFee: Mist
})
export type GasCostSummary = typeof GasCostSummary.Type

/** One object touched by a transaction. Mirrors `SuiClientTypes.ChangedObject`. */
export const ChangedObject = Schema.Struct({
  objectId: ObjectId,
  inputState: Schema.Literals(["Unknown", "DoesNotExist", "Exists"]),
  inputVersion: Schema.NullOr(Version),
  inputDigest: Schema.NullOr(Schema.String),
  inputOwner: Schema.NullOr(Owner),
  outputState: Schema.Literals([
    "Unknown",
    "DoesNotExist",
    "ObjectWrite",
    "PackageWrite",
    "AccumulatorWriteV1"
  ]),
  outputVersion: Schema.NullOr(Version),
  outputDigest: Schema.NullOr(Schema.String),
  outputOwner: Schema.NullOr(Owner),
  idOperation: Schema.Literals(["Unknown", "None", "Created", "Deleted"])
})
export type ChangedObject = typeof ChangedObject.Type

/** Mirrors `SuiClientTypes.UnchangedConsensusObject`. */
export const UnchangedConsensusObject = Schema.Struct({
  kind: Schema.Literals([
    "Unknown",
    "ReadOnlyRoot",
    "MutateConsensusStreamEnded",
    "ReadConsensusStreamEnded",
    "Cancelled",
    "PerEpochConfig"
  ]),
  objectId: ObjectId,
  version: Schema.NullOr(Version),
  digest: Schema.NullOr(Schema.String)
})
export type UnchangedConsensusObject = typeof UnchangedConsensusObject.Type

/** A balance delta produced by a transaction. Mirrors `SuiClientTypes.BalanceChange`. */
export const BalanceChange = Schema.Struct({
  coinType: CoinType,
  address: SuiAddress,
  amount: Schema.BigIntFromString
})
export type BalanceChange = typeof BalanceChange.Type

/** An emitted Move event. Mirrors `SuiClientTypes.Event`; `json` is dropped on purpose. */
export const Event = Schema.Struct({
  packageId: ObjectId,
  module: Schema.String,
  sender: SuiAddress,
  eventType: Schema.String,
  bcs: Schema.Uint8Array
})
export type Event = typeof Event.Type

/**
 * Where a Move abort happened. Mirrors `SuiClientTypes.MoveLocation`.
 *
 * `package` stays a plain string because the node may report a location for a
 * package that no longer parses as an object id.
 */
export const MoveLocation = Schema.Struct({
  package: Schema.optional(Schema.String),
  module: Schema.optional(Schema.String),
  function: Schema.optional(Schema.Number),
  functionName: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.Number)
})
export type MoveLocation = typeof MoveLocation.Type

/** A decoded `#[error]` constant. Mirrors `SuiClientTypes.CleverError`. */
export const CleverError = Schema.Struct({
  errorCode: Schema.optional(Schema.Number),
  lineNumber: Schema.optional(Schema.Number),
  constantName: Schema.optional(Schema.String),
  constantType: Schema.optional(Schema.String),
  value: Schema.optional(Schema.String)
})
export type CleverError = typeof CleverError.Type

/**
 * Why a transaction failed on chain or in simulation. Mirrors
 * `SuiClientTypes.ExecutionError` variant for variant, including its `$kind`
 * discriminant, with two differences: `abortCode` is decoded to `bigint`, and
 * the shared `message` and `command` fields live on the error class that
 * carries the reason rather than being repeated in every variant.
 */
export const ExecutionReason = Schema.Union([
  Schema.Struct({
    $kind: Schema.Literal("MoveAbort"),
    MoveAbort: Schema.Struct({
      abortCode: Schema.BigIntFromString,
      location: Schema.optional(MoveLocation),
      cleverError: Schema.optional(CleverError)
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("SizeError"),
    SizeError: Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      maxSize: Schema.Number
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("CommandArgumentError"),
    CommandArgumentError: Schema.Struct({ argument: Schema.Number, name: Schema.String })
  }),
  Schema.Struct({
    $kind: Schema.Literal("TypeArgumentError"),
    TypeArgumentError: Schema.Struct({ typeArgument: Schema.Number, name: Schema.String })
  }),
  Schema.Struct({
    $kind: Schema.Literal("PackageUpgradeError"),
    PackageUpgradeError: Schema.Struct({
      name: Schema.String,
      packageId: Schema.optional(Schema.String),
      digest: Schema.optional(Schema.String)
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("IndexError"),
    IndexError: Schema.Struct({
      index: Schema.optional(Schema.Number),
      subresult: Schema.optional(Schema.Number)
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("CoinDenyListError"),
    CoinDenyListError: Schema.Struct({
      name: Schema.String,
      coinType: Schema.String,
      address: Schema.optional(Schema.String)
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("CongestedObjects"),
    CongestedObjects: Schema.Struct({
      name: Schema.String,
      objects: Schema.Array(Schema.String)
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("ObjectIdError"),
    ObjectIdError: Schema.Struct({
      name: Schema.optional(Schema.String),
      objectId: Schema.String
    })
  }),
  Schema.Struct({ $kind: Schema.Literal("Unknown") })
]).pipe(Schema.toTaggedUnion("$kind"))
export type ExecutionReason = typeof ExecutionReason.Type

/**
 * Whether a transaction succeeded. Mirrors `SuiClientTypes.ExecutionStatus`
 * minus its `error` payload: the failure detail is carried by `ExecutionFailed`
 * and `SimulationFailed` as an {@link ExecutionReason}, so there is exactly one
 * representation of an on-chain failure.
 */
export const ExecutionStatus = Schema.Struct({ success: Schema.Boolean })
export type ExecutionStatus = typeof ExecutionStatus.Type

/** Transaction effects. Mirrors `SuiClientTypes.TransactionEffects`. */
export const TransactionEffects = Schema.Struct({
  version: Schema.Number,
  status: ExecutionStatus,
  gasUsed: GasCostSummary,
  transactionDigest: Digest,
  gasObject: Schema.NullOr(ChangedObject),
  eventsDigest: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(Schema.String),
  lamportVersion: Schema.NullOr(Version),
  changedObjects: Schema.Array(ChangedObject),
  unchangedConsensusObjects: Schema.Array(UnchangedConsensusObject),
  auxiliaryDataDigest: Schema.NullOr(Schema.String)
})
export type TransactionEffects = typeof TransactionEffects.Type

/**
 * The signed bytes of a transaction, kept so an uncertain submission can be
 * reconciled or re-submitted later without rebuilding.
 *
 * Phase 1 extends this with the full expiration union; `maxTimestampMs` is the
 * one field `Tx.reconcile` needs to decide that a transaction can no longer land.
 *
 * `bytes` encodes as base64, not as a numeric object, so `SuiError.toJson` of a
 * `SubmissionUnknown` is JSON the operator who has to reconcile it can read.
 */
export const SignedTransaction = Schema.Struct({
  digest: Digest,
  bytes: Schema.Uint8ArrayFromBase64,
  signatures: Schema.Array(Schema.String),
  sender: SuiAddress,
  maxTimestampMs: Schema.optional(Schema.BigIntFromString)
})
export type SignedTransaction = typeof SignedTransaction.Type

/**
 * The fixed set of object fields sui-effect always requests: `content`, plus
 * the owner, type, version and digest the SDK returns unconditionally.
 */
export const ObjectEnvelope = Schema.Struct({
  objectId: ObjectId,
  version: Version,
  digest: Schema.String,
  owner: Owner,
  type: ObjectType
})
export type ObjectEnvelope = typeof ObjectEnvelope.Type

/**
 * An object read through `Sui`, with its BCS content already decoded to `S` and
 * a `ref` ready to feed straight back into the transaction builder.
 */
export interface SuiObject<S> {
  readonly id: ObjectId
  readonly version: Version
  readonly digest: string
  readonly type: ObjectType
  readonly owner: Owner
  readonly content: S
  readonly ref: ObjectRef
}

/** Builds a {@link SuiObject} from a decoded envelope and its decoded content. */
export const makeSuiObject = <S>(envelope: ObjectEnvelope, content: S): SuiObject<S> => ({
  id: envelope.objectId,
  version: envelope.version,
  digest: envelope.digest,
  type: envelope.type,
  owner: envelope.owner,
  content,
  ref: {
    id: envelope.objectId,
    type: envelope.type,
    version: envelope.version,
    digest: envelope.digest,
    owner: envelope.owner
  }
})

/** The return values and mutated references of one command. Mirrors `SuiClientTypes.CommandResult`. */
export const CommandResult = Schema.Struct({
  returnValues: Schema.Array(Schema.Struct({ bcs: Schema.Uint8Array })),
  mutatedReferences: Schema.Array(Schema.Struct({ bcs: Schema.Uint8Array }))
})
export type CommandResult = typeof CommandResult.Type

/**
 * The result of a successful simulation, with the fixed include set `Sui` asks
 * for: effects, events, balance changes, object types and command results.
 */
export const Simulation = Schema.Struct({
  digest: Digest,
  effects: TransactionEffects,
  events: Schema.Array(Event),
  balanceChanges: Schema.Array(BalanceChange),
  objectTypes: Schema.Record(Schema.String, Schema.String),
  commandResults: Schema.Array(CommandResult)
})
export type Simulation = typeof Simulation.Type

const UNKNOWN_REASON = ExecutionReason.cases.Unknown.make({ $kind: "Unknown" })

/**
 * Decodes the SDK's `ExecutionError` into an {@link ExecutionReason}, falling
 * back to `Unknown` when the node reports a variant this version does not
 * model. Never fails.
 */
export const executionReasonOf = (error: SuiClientTypes.ExecutionError): ExecutionReason => {
  const decoded = Schema.decodeUnknownOption(ExecutionReason)(error)
  return decoded._tag === "Some" ? decoded.value : UNKNOWN_REASON
}
