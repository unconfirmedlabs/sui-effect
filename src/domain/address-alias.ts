/**
 * The pure half of Sui's address aliases (`0x2::address_alias`): the derived
 * id of an address's `AddressAliases` object, its BCS, the decoded set and
 * the membership rule. The reads, the check and the recipes are
 * `services/AddressAlias.ts`.
 *
 * @since 0.6.0
 */
import { bcs } from "@mysten/sui/bcs"
import { deriveObjectID, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { Schema } from "effect"
import { ObjectId, SuiAddress, Version } from "./schemas.ts"

/**
 * The shared `0x2::address_alias::AddressAliasState` (`0xa`) every
 * `AddressAliases` object is derived from.
 *
 * @since 0.6.0
 */
export const ADDRESS_ALIAS_STATE_ID: ObjectId = ObjectId.normalize("0xa")

/**
 * The most aliases one address may have (`MAX_ALIASES` in the Move module).
 *
 * @since 0.6.0
 */
export const MAX_ALIASES = 8

/**
 * `0x2::address_alias::AddressAliases`, the type of the object holding an
 * address's alias set.
 *
 * @since 0.6.0
 */
export const ADDRESS_ALIASES_TYPE = "0x2::address_alias::AddressAliases"

/** `0x2::address_alias::AliasKey`, the derivation key: `AliasKey(address)`. */
const ALIAS_KEY_TYPE = "0x2::address_alias::AliasKey"

/**
 * The BCS of `AddressAliases { id: UID, aliases: VecSet<address> }`.
 *
 * @since 0.6.0
 */
export const AddressAliasesBcs = bcs.struct("AddressAliases", {
  id: bcs.Address,
  aliases: bcs.struct("VecSet", { contents: bcs.vector(bcs.Address) })
})

/**
 * Who may sign transactions as an address, read from its `AddressAliases`
 * object.
 *
 * - `NotEnabled`: there is no such object, so the address signs only for
 *   itself (Sui's default).
 * - `Enabled`: `enable` has run, and exactly the addresses in `aliases` may
 *   sign as `address` — the address itself only while it is in the set.
 *   `version` is the object's version as read.
 *
 * @since 0.6.0
 */
export const AddressAliases = Schema.TaggedUnion({
  /** No `AddressAliases` object: the address signs only for itself. */
  NotEnabled: { address: SuiAddress },
  /** Exactly the addresses in `aliases` may sign as `address`. */
  Enabled: { address: SuiAddress, id: ObjectId, version: Version, aliases: Schema.Array(SuiAddress) }
})
/** @since 0.6.0 */
export type AddressAliases = typeof AddressAliases.Type

/**
 * The id of `address`'s `AddressAliases` object, whether or not it exists yet:
 * the object derived from `0xa` at `AliasKey(address)`.
 *
 * **Throws** when `address` is not a Sui address — a wiring mistake.
 * Otherwise never fails.
 *
 * @since 0.6.0
 */
export const aliasesId = (address: string): ObjectId =>
  ObjectId.normalize(
    deriveObjectID(
      ADDRESS_ALIAS_STATE_ID,
      normalizeStructTag(ALIAS_KEY_TYPE),
      bcs.Address.serialize(normalizeSuiAddress(address)).toBytes()
    )
  )

/**
 * Whether `signer` may sign transactions as the address `aliases` describes:
 * the address itself while aliases are not enabled, else exactly a member of
 * the set. Pure; never fails.
 *
 * @since 0.6.0
 */
export const allows = (aliases: AddressAliases, signer: string): boolean => {
  const candidate = normalizeSuiAddress(signer)
  return aliases._tag === "NotEnabled"
    ? candidate === normalizeSuiAddress(aliases.address)
    : aliases.aliases.some((alias) => normalizeSuiAddress(alias) === candidate)
}
