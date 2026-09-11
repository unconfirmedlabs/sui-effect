/**
 * The Move layouts this package reads, bridged into `Schema`.
 *
 * `SuiSchema.bcs(layout, type)` is a `Schema.Codec<T, Uint8Array>` that also
 * records the Move type, so `sui.getObject(id, { schema })` checks the object's
 * type tag before it parses a single byte and a mismatch is a `DecodeError`
 * naming both types rather than a confusing parse failure.
 */
import { bcs } from "@mysten/sui/bcs"
import { SuiSchema } from "sui-effect"

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
