/**
 * The Move layouts this package reads, bridged into `Schema`.
 *
 * `SuiSchema.bcs(layout, type)` is a `Schema.Codec<T, Uint8Array>` that also
 * records the Move type, so `sui.getObject(id, { schema })` checks the object's
 * type tag before it parses a single byte and a mismatch is a `DecodeError`
 * naming both types rather than a confusing parse failure.
 */
import { bcs } from "@mysten/sui/bcs"
import { DateTime, Effect, Schema, SchemaIssue, SchemaTransformation } from "effect"
import { ObjectId, SuiAddress, SuiSchema } from "sui-effect"

/** The package the template's example type lives in. Replace it with yours. */
export const ESCROW_PACKAGE = "0x0000000000000000000000000000000000000000000000000000000000000002"

/** `escrow::Escrow`, the object this extension reads. */
export const EscrowContent = SuiSchema.bcs(
  bcs.struct("Escrow", {
    id: bcs.Address,
    owner: bcs.Address,
    amount: bcs.u64()
  }),
  `${ESCROW_PACKAGE}::escrow::Escrow`
)

/** The Move type of a claim receipt, which `claimFor` expects to be created. */
export const RECEIPT_TYPE = `${ESCROW_PACKAGE}::escrow::Receipt`

/**
 * The Move layout of `escrow::Settlement`, whose fields are `snake_case`
 * because Move's are.
 */
const SettlementBcs = bcs.struct("Settlement", {
  escrow_id: bcs.Address,
  settled_at_ms: bcs.u64(),
  claimed_by: bcs.Address
})

/**
 * The domain type a consumer of this package sees: `camelCase`, branded ids,
 * a `DateTime` instead of a string of milliseconds.
 *
 * The mapping lives in `Schema.decodeTo`, never in a custom `parse`: the bridge
 * needs a real `BcsType` so it can re-serialize what it parsed and reject
 * trailing bytes, and a domain type is not a BCS layout.
 */
export class Settlement extends Schema.Class<Settlement>("Settlement")({
  escrowId: ObjectId,
  settledAt: Schema.DateTimeUtc,
  claimedBy: SuiAddress
}) {}

/**
 * The halfway shape the transformation produces: the domain field names, before
 * `Settlement`'s own schema brands the ids.
 */
interface SettlementParts {
  readonly escrowId: string
  readonly settledAt: DateTime.Utc
  readonly claimedBy: string
}

/**
 * The composed codec: BCS bytes to `Settlement`, and back.
 *
 * `SuiSchema.bcs(...)` decodes the bytes into the Move shape;
 * `Schema.decodeTo(Settlement, SchemaTransformation.transform({ decode, encode }))`
 * renames the fields, and `Settlement` itself does the rest — branding the ids
 * and checking them. The Move type the bridge recorded survives the
 * composition, so
 * `sui.getObject(id, { schema: SettlementContent })` still checks the object's
 * type tag before parsing a byte.
 *
 * Two details worth copying:
 *
 * - **`decode` produces the target's field shape, not an instance.** `decodeTo`
 *   sits between the source type and the target schema, which is what lets the
 *   target's own checks — the `ObjectId` and `SuiAddress` brands here — run
 *   afterwards.
 * - **`encode` is the inverse mapper and is not optional.** A codec that cannot
 *   encode is one `Schema.encodeUnknownEffect` fails on, and the compiler asks
 *   for it here rather than at the call site.
 * - **A mapping that can fail uses `transformOrFail`.** `transform` is for total
 *   mappings; a body that throws produces a defect, and a byte that was wrong on
 *   the wire deserves a failure.
 *
 * A failure *inside* this transform — an id that is not an address, a timestamp
 * that is not a time — is still a `DecodeError` from `SuiSchema.decode` and
 * `sui.getObject`, with the same fields: the domain mapping is part of the
 * boundary, not a step after it.
 */
export const SettlementContent = SuiSchema.bcs(
  SettlementBcs,
  `${ESCROW_PACKAGE}::escrow::Settlement`
).pipe(
  Schema.decodeTo(
    Settlement,
    SchemaTransformation.transformOrFail<SettlementParts, typeof SettlementBcs.$inferType>({
      decode: (fields, options) =>
        // `transformOrFail`, not `transform`, because one of these mappings can
        // fail: a `u64` of milliseconds is not necessarily a time. A `transform`
        // whose body throws is a **defect**, which is not what a bad byte on the
        // wire should be; failing with a `SchemaIssue` here is what makes it a
        // `DecodeError` like any other.
        Effect.map(
          Effect.fromOption(
            DateTime.make(Number(fields.settled_at_ms)),
            () =>
              new SchemaIssue.InvalidValue(
                { message: `settled_at_ms ${fields.settled_at_ms} is not a time` },
                fields,
                options
              )
          ),
          (settledAt): SettlementParts => ({
            escrowId: fields.escrow_id,
            settledAt,
            claimedBy: fields.claimed_by
          })
        ),
      encode: (settlement) =>
        Effect.succeed({
          escrow_id: settlement.escrowId,
          settled_at_ms: String(DateTime.toEpochMillis(settlement.settledAt)),
          claimed_by: settlement.claimedBy
        })
    })
  )
)
