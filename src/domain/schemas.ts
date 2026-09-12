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
import { Effect, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from "effect"
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
 *
 * `SuiAddress.make(value)` is the branding constructor: it **validates without
 * decoding**, so it takes the padded 32-byte spelling and nothing else —
 * `SuiAddress.make("0x1")` throws. `SuiAddress.normalize("0x1")` is the one
 * that accepts every spelling a human writes, because it decodes first.
 */
const SuiAddressSchema = Schema.String.annotate({
  identifier: "SuiAddress",
  description: "A 32-byte Sui account address in the padded lowercase 0x form"
}).pipe(
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

/**
 * A branded {@link SuiAddress} from **any** spelling the SDK accepts: `"0x1"`,
 * an unpadded hex string, a mixed-case one, the padded form itself.
 *
 * This is the caller-facing shorthand, and it exists because `.make` is not it:
 * a brand constructor validates the value it is given and the check is
 * `isValidSuiAddress`, which only the padded 32-byte form passes, so
 * `SuiAddress.make("0x1")` throws while `"0x1"` is what every deployment
 * document, every CLI flag and every human writes. `normalize` runs the
 * schema's own decode — `normalizeSuiAddress` — and then the check.
 *
 * **It throws a `SchemaError`** — `Schema.isSchemaError(error)` is the guard —
 * whose `.issue` is the structured schema issue and whose `.message` is the
 * formatted line, because it is `Schema.decodeSync`. (`.make`, which validates
 * without decoding, throws a plain `Error` with the issue in `cause` instead;
 * the two are not the same shape.) So it is for literals and configuration a
 * caller controls. Anything that arrived from outside goes through
 * `Schema.decodeUnknownEffect(SuiAddress)`, which puts the failure in the error
 * channel where a caller can handle it.
 *
 * @since 0.1.1
 *
 * @example
 * ```ts
 * import { SuiAddress } from "@unconfirmed/sui-effect"
 *
 * const treasury = SuiAddress.normalize("0x2")
 * // "0x0000000000000000000000000000000000000000000000000000000000000002"
 * ```
 */
const normalizeSuiAddressValue: (input: string) => typeof SuiAddressSchema.Type = Schema.decodeSync(
  SuiAddressSchema
)

/** The schema, plus {@link normalizeSuiAddressValue} as `SuiAddress.normalize`. */
export const SuiAddress = Object.assign(SuiAddressSchema, {
  normalize: normalizeSuiAddressValue
})
export type SuiAddress = typeof SuiAddressSchema.Type

/**
 * A 32-byte object id. Same encoding rules as {@link SuiAddress}; the brand is
 * separate so an address cannot be passed where an object id is expected.
 *
 * `ObjectId.make` validates without decoding; `ObjectId.normalize` decodes
 * first and is what takes `"0x6"`.
 */
const ObjectIdSchema = Schema.String.annotate({
  identifier: "ObjectId",
  description: "A 32-byte Sui object id in the padded lowercase 0x form"
}).pipe(
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

/**
 * A branded {@link ObjectId} from any spelling the SDK accepts, decoding first
 * and branding after — the object-id twin of `SuiAddress.normalize`, and the
 * answer to `ObjectId.make("0x6")` throwing.
 *
 * **It throws a `SchemaError`** (`Schema.isSchemaError`), whose `.issue` is the
 * schema issue and whose `.message` is the formatted line, because it is
 * `Schema.decodeSync`; `.make` throws a plain `Error` with the issue in
 * `cause`. So it is for literals and configuration a caller controls; anything
 * from outside goes through `Schema.decodeUnknownEffect(ObjectId)`.
 *
 * @since 0.1.1
 *
 * @example
 * ```ts
 * import { ObjectId } from "@unconfirmed/sui-effect"
 *
 * const clock = ObjectId.normalize("0x6")
 * ```
 */
const normalizeObjectIdValue: (input: string) => typeof ObjectIdSchema.Type = Schema.decodeSync(
  ObjectIdSchema
)

/** The schema, plus {@link normalizeObjectIdValue} as `ObjectId.normalize`. */
export const ObjectId = Object.assign(ObjectIdSchema, { normalize: normalizeObjectIdValue })
export type ObjectId = typeof ObjectIdSchema.Type

/** A base58 transaction digest. Not normalized; rejected when not 32 bytes. */
export const Digest = Schema.String.annotate({
  identifier: "Digest",
  description: "A base58 32-byte transaction digest"
}).pipe(
  Schema.check(
    Schema.makeFilter((value: string) =>
      isValidTransactionDigest(value) ? undefined : "Expected a base58 32-byte transaction digest"
    )
  )
  // Again **after** the check, because a check-only brand reports from the
  // checked node and the annotation on the bare `Schema.String` underneath it
  // does not reach there. The check's own message still wins for a string of
  // the wrong shape; this is only what a non-string is compared against.
).annotate({
  identifier: "Digest",
  description: "A base58 32-byte transaction digest"
}).pipe(Schema.brand("Digest"))
export type Digest = typeof Digest.Type

/**
 * A fully qualified Move struct tag, normalized with `normalizeStructTag` on
 * decode so `0x2::sui::SUI` and its padded form compare equal.
 */
export const StructTag = Schema.String.annotate({
  identifier: "StructTag",
  description: "A fully qualified Move struct tag, normalized"
}).pipe(
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
export const CoinType = Schema.String.annotate({
  identifier: "CoinType",
  description: "A struct tag used as the type argument of 0x2::coin::Coin"
}).pipe(
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
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))
).annotate({
  identifier: "Mist",
  description: "An amount in MIST, encoded as a decimal string"
}).pipe(
  // `Schema.annotateEncoded` is what names the **string** side: the wrong-type
  // failure for a `BigIntFromString` comes from its unannotated string source,
  // not from the bigint node the plain `annotate` reaches.
  Schema.annotateEncoded({
    identifier: "Mist",
    description: "An amount in MIST, encoded as a decimal string"
  }),
  Schema.brand("Mist")
)
export type Mist = typeof Mist.Type

/** A Move object version. Encoded as the decimal string the SDK returns. */
export const Version = Schema.BigIntFromString.pipe(
  Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n))
).annotate({
  identifier: "Version",
  description: "A Move object version, encoded as a decimal string"
}).pipe(
  Schema.annotateEncoded({
    identifier: "Version",
    description: "A Move object version, encoded as a decimal string"
  }),
  Schema.brand("Version")
)
export type Version = typeof Version.Type

/** The network a client is pointed at. Mirrors `SuiClientTypes.Network`. */
export const Network = Schema.String.annotate({
  identifier: "Network",
  description: "The network a client is pointed at"
}).pipe(Schema.brand("Network"))
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
}).annotate({
  identifier: "ObjectRef",
  description: "Everything the transaction builder needs to consume an object again"
})
type ObjectRefType = typeof ObjectRef.Type
/**
 * The decoded shape of {@link ObjectRef}.
 *
 * Declared as an interface rather than as `typeof ObjectRef.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface ObjectRef extends ObjectRefType {}

/** A coin balance for one coin type. Mirrors `SuiClientTypes.Balance`. */
export const Balance = Schema.Struct({
  coinType: CoinType,
  balance: Mist,
  coinBalance: Mist,
  addressBalance: Mist
}).annotate({
  identifier: "Balance",
  description: "A coin balance for one coin type"
})
type BalanceType = typeof Balance.Type
/**
 * The decoded shape of {@link Balance}.
 *
 * Declared as an interface rather than as `typeof Balance.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface Balance extends BalanceType {}

/** The BCS-encoded name of a dynamic field. Mirrors `SuiClientTypes.DynamicFieldName`. */
export const DynamicFieldName = Schema.Struct({
  type: Schema.String,
  bcs: Schema.Uint8Array
}).annotate({
  identifier: "DynamicFieldName",
  description: "The BCS-encoded name of a dynamic field"
})
type DynamicFieldNameType = typeof DynamicFieldName.Type
/**
 * The decoded shape of {@link DynamicFieldName}.
 *
 * Declared as an interface rather than as `typeof DynamicFieldName.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface DynamicFieldName extends DynamicFieldNameType {}

/** One entry of a dynamic-field listing. Mirrors `SuiClientTypes.DynamicFieldEntry`. */
export const DynamicFieldEntry = Schema.Struct({
  fieldId: ObjectId,
  type: Schema.String,
  name: DynamicFieldName,
  valueType: Schema.String,
  $kind: Schema.Literals(["DynamicField", "DynamicObject"]),
  childId: Schema.optional(ObjectId)
}).annotate({
  identifier: "DynamicFieldEntry",
  description: "One entry of a dynamic-field listing"
})
type DynamicFieldEntryType = typeof DynamicFieldEntry.Type
/**
 * The decoded shape of {@link DynamicFieldEntry}.
 *
 * Declared as an interface rather than as `typeof DynamicFieldEntry.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface DynamicFieldEntry extends DynamicFieldEntryType {}

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
}).annotate({
  identifier: "DynamicField",
  description: "A dynamic field with its value"
})
type DynamicFieldType = typeof DynamicField.Type
/**
 * The decoded shape of {@link DynamicField}.
 *
 * Declared as an interface rather than as `typeof DynamicField.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface DynamicField extends DynamicFieldType {}

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

/**
 * An emitted Move event. Mirrors `SuiClientTypes.Event` with the branded ids
 * this package uses.
 *
 * The decode a caller wants is `SuiSchema.decode(codec, event.bcs)`, which
 * gives a typed value; `json` is the node's own rendering and is **not**
 * something to build on — it is absent on most transports and its shape follows
 * whatever the node feels like. It is kept only when the source carried it,
 * which in practice means a relay or sponsor envelope decoded through
 * `Executed.fromPartial`, where it may be the only form of the event there is.
 */
export const Event = Schema.Struct({
  packageId: ObjectId,
  module: Schema.String,
  sender: SuiAddress,
  eventType: Schema.String,
  bcs: Schema.Uint8Array,
  /**
   * The node's own JSON rendering of the event, when whatever produced this
   * carried one. Never populated from a gRPC execute; never to be preferred
   * over `bcs`.
   *
   * @since 0.1.2
   */
  json: Schema.optional(Schema.Unknown)
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
  function: Schema.optional(Schema.Finite),
  functionName: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.Finite)
})
export type MoveLocation = typeof MoveLocation.Type

/** A decoded `#[error]` constant. Mirrors `SuiClientTypes.CleverError`. */
export const CleverError = Schema.Struct({
  errorCode: Schema.optional(Schema.Finite),
  lineNumber: Schema.optional(Schema.Finite),
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
      size: Schema.Finite,
      maxSize: Schema.Finite
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("CommandArgumentError"),
    CommandArgumentError: Schema.Struct({ argument: Schema.Finite, name: Schema.String })
  }),
  Schema.Struct({
    $kind: Schema.Literal("TypeArgumentError"),
    TypeArgumentError: Schema.Struct({ typeArgument: Schema.Finite, name: Schema.String })
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
      index: Schema.optional(Schema.Finite),
      subresult: Schema.optional(Schema.Finite)
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
  version: Schema.Finite,
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
 * A serialized signature, as every SDK signer returns it: the base64 of the
 * flag, signature and public key bytes. Branded so a signature cannot be passed
 * where a digest or an address is expected.
 */
export const Signature = Schema.String.annotate({
  identifier: "Signature",
  description: "A serialized transaction signature"
}).pipe(Schema.check(Schema.isNonEmpty())).annotate({
  identifier: "Signature",
  description: "A serialized transaction signature"
}).pipe(Schema.brand("Signature"))
export type Signature = typeof Signature.Type

/** The largest value a Move `u64` can hold. */
export const U64_MAX = 18_446_744_073_709_551_615n

/** The largest value a Move `u32` can hold, which is the nonce's range. */
export const U32_MAX = 4_294_967_295

const DECIMAL = /^(?:0|[1-9][0-9]*)$/

/**
 * The `bigint` a `u64` field carries, or `undefined` when the value is not one:
 * a string that is not a plain non-negative decimal, a number that is not a
 * safe non-negative integer, or anything at all outside `[0, 2^64)`.
 */
const u64Of = (value: string | number): bigint | undefined => {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return undefined
    return BigInt(value)
  }
  const trimmed = value.trim()
  if (!DECIMAL.test(trimmed)) return undefined
  const parsed = BigInt(trimmed)
  return parsed > U64_MAX ? undefined : parsed
}

/**
 * A `u64` as the SDK's transaction data carries it: a decimal string or, for
 * small values, a number. Decodes to `bigint` and encodes back to a string.
 *
 * The transformation is **checked**: `BigInt("not-a-number")` throws, and a
 * throwing `transform` is a defect, which would take a malformed persisted
 * journal entry straight out of the `JournalError` channel it is supposed to
 * fail in. A value that is not a non-negative integer below `2^64` is a schema
 * issue like any other.
 */
const U64 = Schema.Union([Schema.String, Schema.Finite]).pipe(
  Schema.decodeTo(
    Schema.BigInt,
    SchemaTransformation.transformOrFail<bigint, string | number>({
      decode: (value, options) => {
        const parsed = u64Of(value)
        return parsed === undefined
          ? Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: `${JSON.stringify(value)} is not a u64` },
              value,
              options
            )
          )
          : Effect.succeed(parsed)
      },
      encode: (value, options) =>
        value < 0n || value > U64_MAX
          ? Effect.fail(
            new SchemaIssue.InvalidValue(
              { message: `${value} is outside the u64 range` },
              value,
              options
            )
          )
          : Effect.succeed(value.toString())
    })
  )
)

const NullableU64 = Schema.NullOr(U64)

/**
 * The replay-guard nonce a `ValidDuring` or `Validity` expiration carries. It
 * is a `u32` on the wire, so anything outside `[0, 2^32)` is a schema issue
 * rather than bytes the validator will reject later.
 */
const Nonce = Schema.Finite.pipe(
  Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: U32_MAX }))
)

/**
 * When a transaction stops being valid. Mirrors the SDK's
 * `TransactionExpiration` enum variant for variant, including its `$kind`
 * discriminant, so our narrowing and `TransactionDataBuilder`'s agree.
 *
 * `ValidDuring` is what `Tx.build` sets by default, bounded by **epochs**:
 * `maxTimestamp` is `null` unless `SubmitConfig.validFor` asks for one, because
 * no Sui network accepts a timestamp expiration yet. Its `chain` is a replay
 * guard, so bytes signed for testnet cannot land on mainnet.
 */
export const TransactionExpiration = Schema.Union([
  Schema.Struct({ $kind: Schema.Literal("None"), None: Schema.Literal(true) }),
  Schema.Struct({ $kind: Schema.Literal("Epoch"), Epoch: U64 }),
  Schema.Struct({
    $kind: Schema.Literal("ValidDuring"),
    ValidDuring: Schema.Struct({
      minEpoch: NullableU64,
      maxEpoch: NullableU64,
      minTimestamp: NullableU64,
      maxTimestamp: NullableU64,
      chain: Schema.String,
      nonce: Nonce
    })
  }),
  Schema.Struct({
    $kind: Schema.Literal("Validity"),
    Validity: Schema.Struct({
      allowedProposers: Schema.NullOr(
        Schema.Struct({ epoch: U64, proposers: Schema.Array(Schema.Finite) })
      ),
      minEpoch: NullableU64,
      maxEpoch: NullableU64,
      minTimestamp: NullableU64,
      maxTimestamp: NullableU64,
      chain: Schema.String,
      nonce: Nonce
    })
  })
]).pipe(Schema.toTaggedUnion("$kind"))
export type TransactionExpiration = typeof TransactionExpiration.Type

/**
 * The signed bytes of a transaction, kept so an uncertain submission can be
 * reconciled or re-submitted later without rebuilding.
 *
 * The expiration the transaction was built with rides along, because it is what
 * `Tx.reconcile` needs to decide that a transaction can no longer land.
 *
 * `bytes` encodes as base64, not as a numeric object, so `SuiError.toJson` of a
 * `SubmissionUnknown` is JSON the operator who has to reconcile it can read.
 */
export const SignedTransaction = Schema.Struct({
  digest: Digest,
  bytes: Schema.Uint8ArrayFromBase64,
  signatures: Schema.Array(Signature),
  sender: SuiAddress,
  expiration: Schema.optional(TransactionExpiration),
  /**
   * The chain identifier the bytes were built against, recorded by `Tx.build`
   * so `Tx.reconcile` can refuse to reason about a transaction with a node on
   * another chain.
   *
   * A `ValidDuring` or `Validity` expiration already names its chain, and that
   * is what is compared when it is there. This field is what an `Epoch` or
   * `None` expiration — which name no chain at all — leaves behind instead, so
   * a process-wide journal holding submissions from two networks cannot settle
   * one of them against the other's epoch.
   */
  chain: Schema.optional(Schema.String)
}).annotate({
  identifier: "SignedTransaction",
  description: "The signed bytes of a transaction, with what reconciling needs"
})
type SignedTransactionType = typeof SignedTransaction.Type
/**
 * The decoded shape of {@link SignedTransaction}.
 *
 * Declared as an interface rather than as `typeof SignedTransaction.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface SignedTransaction extends SignedTransactionType {}

/**
 * Why a transaction provably never applied, and never will.
 *
 * `"expired"`: the expiration window was observed closed — the current epoch
 * past the recorded `maxEpoch`, or `chainTime` past a recorded `maxTimestamp`
 * by more than `SubmitConfig.expiryMargin` — around a `getTransaction` miss,
 * twice. `"inputConsumed"`: a **different** transaction's own effects report
 * that it took an object these bytes pinned at exactly the version they pinned.
 *
 * Shared by `NotApplied` and by the journal entry that records it, so the two
 * cannot drift.
 */
export const NotAppliedEvidence = Schema.Literals(["expired", "inputConsumed"])
export type NotAppliedEvidence = typeof NotAppliedEvidence.Type

/**
 * A transaction built into bytes and ready to sign, with the expiration the
 * builder settled on recorded so `Tx.reconcile` can decide, later and without
 * the builder, whether the transaction can still land.
 */
export const Built = Schema.Struct({
  digest: Digest,
  bytes: Schema.Uint8ArrayFromBase64,
  sender: SuiAddress,
  gasOwner: Schema.optional(SuiAddress),
  expiration: Schema.optional(TransactionExpiration),
  /** The chain identifier `Tx.build` was run against. See `SignedTransaction.chain`. */
  chain: Schema.optional(Schema.String)
}).annotate({
  identifier: "Built",
  description: "A transaction built into bytes and ready to sign"
})
type BuiltType = typeof Built.Type
/**
 * The decoded shape of {@link Built}.
 *
 * Declared as an interface rather than as `typeof Built.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface Built extends BuiltType {}

/**
 * The last epoch in which a transaction can still be applied, or `undefined`
 * when its expiration sets no such bound (`None`, or a `ValidDuring` with no
 * `maxEpoch`).
 *
 * An `Epoch` expiration is that epoch: the SDK's `Epoch` variant means "valid
 * until the end of this epoch", so it is its own upper bound.
 *
 * This is the bound that matters in practice. Epochs are what the default
 * expiration carries and what the validator rule is written in, and unlike a
 * wall clock an epoch is a consensus fact, so `Tx.reconcile` needs no skew
 * margin to reason about it. Never fails.
 */
export const maxEpochOf = (
  expiration: TransactionExpiration | undefined
): bigint | undefined => {
  if (expiration === undefined) return undefined
  switch (expiration.$kind) {
    case "Epoch":
      return expiration.Epoch
    case "ValidDuring":
      return expiration.ValidDuring.maxEpoch ?? undefined
    case "Validity":
      return expiration.Validity.maxEpoch ?? undefined
    default:
      return undefined
  }
}

/**
 * The wall-clock bound after which a transaction can no longer be applied, in
 * milliseconds, or `undefined` when its expiration sets no such bound — which
 * is `None`, `Epoch`, and the default `ValidDuring`, whose `maxTimestamp` is
 * `null` unless `SubmitConfig.validFor` asks for one.
 *
 * `Tx.reconcile` compares it against `chainTime` with
 * `SubmitConfig.expiryMargin` for skew, which the epoch bound needs none of.
 * Never fails.
 */
export const maxTimestampMsOf = (
  expiration: TransactionExpiration | undefined
): bigint | undefined => {
  if (expiration === undefined) return undefined
  switch (expiration.$kind) {
    case "ValidDuring":
      return expiration.ValidDuring.maxTimestamp ?? undefined
    case "Validity":
      return expiration.Validity.maxTimestamp ?? undefined
    default:
      return undefined
  }
}

/**
 * The chain identifier an expiration names, or `undefined` for the variants
 * that name none (`None`, `Epoch`).
 *
 * This is the first half of the chain-identity guard `Tx.reconcile` applies
 * before it asks a node anything: bytes built for one chain must not be
 * declared expired by another chain's epoch. The second half is
 * `SignedTransaction.chain`, which `Tx.build` records for the variants that
 * carry no chain of their own. Never fails.
 */
export const chainOf = (
  expiration: TransactionExpiration | undefined
): string | undefined => {
  if (expiration === undefined) return undefined
  switch (expiration.$kind) {
    case "ValidDuring":
      return expiration.ValidDuring.chain
    case "Validity":
      return expiration.Validity.chain
    default:
      return undefined
  }
}

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
}).annotate({
  identifier: "ObjectEnvelope",
  description: "The fixed set of object fields sui-effect always requests"
})
type ObjectEnvelopeType = typeof ObjectEnvelope.Type
/**
 * The decoded shape of {@link ObjectEnvelope}.
 *
 * Declared as an interface rather than as `typeof ObjectEnvelope.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface ObjectEnvelope extends ObjectEnvelopeType {}

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
}).annotate({
  identifier: "Simulation",
  description: "The result of a successful simulation"
})
type SimulationType = typeof Simulation.Type
/**
 * The decoded shape of {@link Simulation}.
 *
 * Declared as an interface rather than as `typeof Simulation.Type` so the name
 * survives into `.d.ts`, editor hover and `LLMS.md` instead of being expanded
 * into its structure. Structurally identical to the type alias it replaces.
 */
export interface Simulation extends SimulationType {}

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
