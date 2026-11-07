/**
 * `AddressAlias`: Sui's address aliases (`0x2::address_alias`), read from the
 * object and checked before anything is signed.
 *
 * By default an address signs only for itself. Once it calls `enable`, the
 * address owns an `AddressAliases` object — a derived object of the shared
 * `AddressAliasState` (`0xa`) at key `AliasKey(address)` — holding the set of
 * addresses allowed to sign transactions **as** it, starting with `[address]`.
 * From then on a transaction whose sender (or gas owner) is the address is
 * accepted with a signature by any member of the set, and only by a member:
 * an address that removed itself can no longer sign for itself. The set holds
 * 1 to 8 addresses, is edited with `add`, `remove` and `replace_all` (each
 * signed as the address, by any current alias), and cannot be disabled.
 * Validators resolve aliases for a transaction's sender and gas owner only;
 * a personal message is never signed through an alias.
 *
 * Everything here reads the **object**, never transaction history: nodes prune
 * transactions, and a check that depended on one would answer differently on
 * different nodes. DESIGN §21.
 *
 * @since 0.6.0
 */
import type { Transaction } from "@mysten/sui/transactions"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Option } from "effect"
import {
  ADDRESS_ALIAS_STATE_ID,
  ADDRESS_ALIASES_TYPE,
  AddressAliases,
  AddressAliasesBcs,
  aliasesId,
  allows,
  MAX_ALIASES
} from "../domain/address-alias.ts"
import { bcs as bcsSchema } from "../domain/bcs.ts"
import type { DecodeError, ObjectUnavailable } from "../domain/errors.ts"
import { PolicyDenied, TransportError } from "../domain/errors.ts"
import { SuiAddress } from "../domain/schemas.ts"

export { ADDRESS_ALIAS_STATE_ID, ADDRESS_ALIASES_TYPE, AddressAliases, AddressAliasesBcs, aliasesId, allows, MAX_ALIASES }
import type { Recipe } from "./Sui.ts"
import { Sui } from "./Sui.ts"

const aliasesSchema = bcsSchema(AddressAliasesBcs, ADDRESS_ALIASES_TYPE)

/**
 * `address`'s alias set, read from its `AddressAliases` object (the derived
 * id, its type checked against `0x2::address_alias::AddressAliases`): one
 * object read. No object is `NotEnabled`.
 *
 * ```ts
 * const aliases = yield* AddressAlias.getAliases(account)
 * if (aliases._tag === "Enabled") console.log(aliases.aliases)
 * ```
 *
 * Fails with: `ObjectUnavailable` (the node cannot serve the object),
 * `DecodeError` (the object at the derived id is not an `AddressAliases`),
 * `TransportError`.
 *
 * @since 0.6.0
 */
export const getAliases: (
  address: SuiAddress
) => Effect.Effect<AddressAliases, ObjectUnavailable | DecodeError | TransportError, Sui> = Effect.fn(
  "AddressAlias.getAliases"
)(function*(
  address: SuiAddress
): Effect.fn.Return<AddressAliases, ObjectUnavailable | DecodeError | TransportError, Sui> {
  const sui = yield* Sui
  const owner = SuiAddress.normalize(address)
  const found = yield* sui.getObjectOption(aliasesId(owner), { schema: aliasesSchema })
  return Option.match(found, {
    onNone: (): AddressAliases => AddressAliases.cases.NotEnabled.make({ address: owner }),
    onSome: (object): AddressAliases =>
      AddressAliases.cases.Enabled.make({
        address: owner,
        id: object.id,
        version: object.version,
        aliases: object.content.aliases.contents.map((alias) => SuiAddress.normalize(alias))
      })
  })
})

/**
 * {@link getAliases}, with an object the node could not serve or that does
 * not decode folded into the `TransportError` the verifiers already declare:
 * the signer was neither accepted nor refused. Internal (`Tx.attach` uses it).
 *
 * Fails with: `TransportError`.
 */
export const readAliases = (address: SuiAddress): Effect.Effect<AddressAliases, TransportError, Sui> =>
  getAliases(address).pipe(
    Effect.catchTags({
      ObjectUnavailable: (error) => Effect.fail(TransportError.fromUnknown("AddressAlias.getAliases", error, false)),
      DecodeError: (error) => Effect.fail(TransportError.fromUnknown("AddressAlias.getAliases", error, false))
    })
  )

/**
 * Requires that `signer` may sign transactions as `address`, read from
 * `address`'s `AddressAliases` object, and answers the set it read: the check
 * `Tx.run` makes for a `Signer.alias` before anything is built, and `Tx.attach`
 * for a signature by neither the sender nor the gas owner.
 *
 * Refused as `PolicyDenied { rule: "alias.signer" }` when `signer` is neither
 * `address` (with aliases not enabled) nor a member of its alias set — which
 * includes `address` itself once it has removed itself from its own set.
 *
 * ```ts
 * yield* AddressAlias.requireSigner(account, multisigAddress)
 * ```
 *
 * Fails with: `PolicyDenied` (`alias.signer`), `TransportError` (the object
 * could not be read; one the node cannot serve, or that does not decode, is a
 * `TransportError` whose `cause` says so — the signer was neither accepted nor
 * refused).
 *
 * @since 0.6.0
 */
export const requireSigner: (
  address: SuiAddress,
  signer: SuiAddress
) => Effect.Effect<AddressAliases, PolicyDenied | TransportError, Sui> = Effect.fn(
  "AddressAlias.requireSigner"
)(function*(
  address: SuiAddress,
  signer: SuiAddress
): Effect.fn.Return<AddressAliases, PolicyDenied | TransportError, Sui> {
  yield* Effect.annotateCurrentSpan({ "sui.alias_account": address, "sui.alias_signer": signer })
  const aliases = yield* readAliases(address)
  if (allows(aliases, signer)) return aliases
  return yield* new PolicyDenied({
    rule: "alias.signer",
    message: aliases._tag === "NotEnabled"
      ? `${signer} cannot sign as ${aliases.address}: that address has not enabled address aliases,` +
        " so only its own key signs for it"
      : `${signer} cannot sign as ${aliases.address}: it is not in that address's alias set` +
        ` (${aliases.aliases.join(", ")})`
  })
})

/** One `0x2::address_alias` entry call: each is its own top-level command. */
const call = (tx: Transaction, fn: string, args: Parameters<Transaction["moveCall"]>[0]["arguments"]): void => {
  tx.moveCall({ target: `0x2::address_alias::${fn}`, ...(args === undefined ? {} : { arguments: args }) })
}

/**
 * `0x2::address_alias::enable`: creates the sender's `AddressAliases` with the
 * set `[sender]`. Signed by the sender's own key; once per address (a second
 * `enable` aborts with `EAliasAlreadyExists`). It does not return the object,
 * so an edit of the new set is a second transaction.
 *
 * Never fails; the recipe it returns throws only if the SDK does, which
 * `Tx.build` reports as `BuildError`.
 *
 * @since 0.6.0
 */
export const enable = (): Recipe => (tx: Transaction) => {
  call(tx, "enable", [tx.object(ADDRESS_ALIAS_STATE_ID)])
}

/**
 * `0x2::address_alias::add`: adds `alias` to `address`'s set. The
 * transaction's sender is `address`, signed by any current alias (aborts with
 * `EAliasAlreadyExists` for a member, `ETooManyAliases` past 8).
 *
 * Never fails; the recipe it returns throws only if the SDK does, which
 * `Tx.build` reports as `BuildError`.
 *
 * @since 0.6.0
 */
export const add = (opts: { readonly address: SuiAddress; readonly alias: SuiAddress }): Recipe =>
(tx: Transaction) => {
  call(tx, "add", [tx.object(aliasesId(opts.address)), tx.pure.address(normalizeSuiAddress(opts.alias))])
}

/**
 * `0x2::address_alias::remove`: removes `alias` from `address`'s set. The
 * transaction's sender is `address`, signed by any current alias (aborts with
 * `ENoSuchAlias` for a non-member, `ECannotRemoveLastAlias` for the last one).
 * Removing `address` itself means its own key no longer signs for it.
 *
 * Never fails; the recipe it returns throws only if the SDK does, which
 * `Tx.build` reports as `BuildError`.
 *
 * @since 0.6.0
 */
export const remove = (opts: { readonly address: SuiAddress; readonly alias: SuiAddress }): Recipe =>
(tx: Transaction) => {
  call(tx, "remove", [tx.object(aliasesId(opts.address)), tx.pure.address(normalizeSuiAddress(opts.alias))])
}

/**
 * `0x2::address_alias::replace_all`: replaces `address`'s set with `aliases`
 * (1 to 8; duplicates collapse). The transaction's sender is `address`, signed
 * by any current alias.
 *
 * Never fails; the recipe it returns throws only if the SDK does, which
 * `Tx.build` reports as `BuildError`.
 *
 * @since 0.6.0
 */
export const replaceAll = (opts: {
  readonly address: SuiAddress
  readonly aliases: ReadonlyArray<SuiAddress>
}): Recipe =>
(tx: Transaction) => {
  call(tx, "replace_all", [
    tx.object(aliasesId(opts.address)),
    tx.pure.vector("address", opts.aliases.map((alias) => normalizeSuiAddress(alias)))
  ])
}

/**
 * Sui's address aliases, named after the Move module `sui::address_alias`:
 * `AddressAlias.getAliases`, `allows` and `requireSigner` read and check an
 * address's set from its object; `enable`, `add`, `remove` and `replaceAll`
 * are the recipes for its four entry functions; `aliasesId` is the derived id.
 * Signing as an address through one of its aliases is `Signer.alias`.
 *
 * @since 0.6.0
 */
export const AddressAlias = {
  ADDRESS_ALIAS_STATE_ID,
  ADDRESS_ALIASES_TYPE,
  MAX_ALIASES,
  AddressAliasesBcs,
  aliasesId,
  getAliases,
  allows,
  requireSigner,
  enable,
  add,
  remove,
  replaceAll
} as const
