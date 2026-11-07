/**
 * Two signers built from other signers: `Signer.multisig`, a weighted multisig
 * over member signers of any scheme, and `Signer.alias`, a signer that signs
 * **as** an address through Sui's address aliases.
 *
 * A Miso-style account is both: an address A whose only alias is a multisig M
 * of passkey, zkLogin, recovery-phrase and watchdog keys. A transaction's
 * sender is A and its signature is M's, which is
 * `Signer.alias(A, yield* Signer.multisig(publicKey, [passkey, phrase]))`.
 * DESIGN §21.
 *
 * @since 0.6.0
 */
import type { MultiSigPublicKey } from "@mysten/sui/multisig"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Schema } from "effect"
import { SigningError } from "../domain/errors.ts"
import { KeyError } from "../domain/keys.ts"
import { Signature, SuiAddress } from "../domain/schemas.ts"
import type { Signer } from "./Signer.ts"

const decodeSignature = Schema.decodeUnknownEffect(Signature)

/** The structural `locked` member a `LockableSigner` carries, when this signer has one. */
const lockedOf = (signer: Signer): Effect.Effect<boolean> | undefined => {
  const locked: unknown = Reflect.get(signer, "locked")
  return Effect.isEffect(locked) ? locked as Effect.Effect<boolean> : undefined
}

/** The earliest of the bounds that exist, or `undefined` when none does. */
const earliest = (bounds: ReadonlyArray<bigint | undefined>): bigint | undefined =>
  bounds.reduce<bigint | undefined>(
    (least, bound) => (bound === undefined ? least : least === undefined || bound < least ? bound : least),
    undefined
  )

const invalid = (message: string): KeyError => new KeyError({ reason: "invalidMultisig", message })

/**
 * A multisig signer over member signers: each signs the same bytes, and the
 * partial signatures are combined into one `MultiSig` signature by the
 * multisig's own public key.
 *
 * **The partial signatures are combined in the multisig's member order.** The
 * SDK's `combinePartialSignatures` keeps the order it is given and sets the
 * bitmap from the keys, and Sui pairs the n-th signature with the n-th set bit
 * of the bitmap, so signatures in any other order are refused on chain — which
 * is what the SDK's own `MultiSigSigner` does when its signers are not passed
 * in member order. Here the signers are sorted by member index when the signer
 * is made, and they sign one after another in that order (a passkey prompt at a
 * time, never two at once).
 *
 * Members may be of any scheme the SDK combines: Ed25519, Secp256k1,
 * Secp256r1, a passkey (`Signer.passkey`), a zkLogin session (`Signer.zkLogin`;
 * its member key is the session's `ZkLoginPublicIdentifier`), a wallet account
 * or a `Signer.remote`. A member is matched by its `address`, the address the
 * member's public key derives — the rule the SDK's `MultiSigSigner` uses — so a
 * zkLogin member must sign as the current (non-legacy) derivation of its
 * identifier. A member's partial signature that the multisig key does not know
 * is a `SigningError` when signing.
 *
 * The signer's `address` is the multisig's address, its scheme `"MultiSig"`,
 * its `maxEpoch` the earliest of its members' (a zkLogin member's session
 * bounds the whole signature), and it carries a structural `locked` that is
 * `true` when any member's is, so `Tx.run` refuses it before building. To sign
 * as an account whose alias the multisig is, wrap it in {@link alias}.
 *
 * ```ts
 * const m = yield* Signer.multisig(publicKey, [passkey, phrase])
 * yield* Tx.run(recipe, { signer: m })
 * ```
 *
 * Fails with: `KeyError` (`invalidMultisig`: a signer whose address is not a
 * member, two signers for one member, or members whose combined weight is
 * below the threshold).
 *
 * @since 0.6.0
 */
export const multisig: (
  publicKey: MultiSigPublicKey,
  signers: ReadonlyArray<Signer>
) => Effect.Effect<Signer, KeyError> = Effect.fn("Signer.multisig")(function*(
  publicKey: MultiSigPublicKey,
  signers: ReadonlyArray<Signer>
): Effect.fn.Return<Signer, KeyError> {
  const members = publicKey.getPublicKeys().map((member, index) => ({
    index,
    weight: member.weight,
    address: normalizeSuiAddress(member.publicKey.toSuiAddress())
  }))
  const chosen: Array<{ readonly index: number; readonly weight: number; readonly signer: Signer }> = []
  for (const signer of signers) {
    const address = normalizeSuiAddress(signer.address)
    const member = members.find((candidate) => candidate.address === address)
    if (member === undefined) {
      return yield* invalid(
        `${signer.address} is not a member of the multisig ${publicKey.toSuiAddress()}` +
          ` (members: ${members.map((m) => m.address).join(", ")})`
      )
    }
    if (chosen.some((entry) => entry.index === member.index)) {
      return yield* invalid(`two signers were given for the multisig member ${address}`)
    }
    chosen.push({ index: member.index, weight: member.weight, signer })
  }
  const weight = chosen.reduce((sum, entry) => sum + entry.weight, 0)
  const threshold = publicKey.getThreshold()
  if (weight < threshold) {
    return yield* invalid(
      `these signers weigh ${weight} together and the multisig's threshold is ${threshold}`
    )
  }
  // Member order, once: the order the bitmap is read in.
  const ordered = [...chosen].sort((left, right) => left.index - right.index).map((entry) => entry.signer)
  const address = SuiAddress.make(normalizeSuiAddress(publicKey.toSuiAddress()))

  const combine = (partial: ReadonlyArray<Signature>): Effect.Effect<Signature, SigningError> =>
    Effect.try({
      try: () => publicKey.combinePartialSignatures([...partial]),
      catch: (cause) =>
        new SigningError({ cause: `the multisig ${address} could not combine its members' signatures: ${String(cause)}` })
    }).pipe(
      Effect.flatMap((combined) =>
        decodeSignature(combined).pipe(
          Effect.mapError((issue) => new SigningError({ cause: `the combined multisig signature does not decode: ${issue.message}` }))
        )
      )
    )

  const lockedMembers = ordered.map(lockedOf).filter((locked): locked is Effect.Effect<boolean> => locked !== undefined)
  const maxEpoch = earliest(ordered.map((signer) => signer.maxEpoch))
  const signer: Signer = {
    address,
    scheme: "MultiSig",
    ...(maxEpoch === undefined ? {} : { maxEpoch }),
    signTransaction: Effect.fn("Signer.multisig.signTransaction")(function*(bytes: Uint8Array) {
      // One member after another, in member order: a person sees one prompt
      // at a time, and the partial signatures come out in the bitmap's order.
      const partial = yield* Effect.forEach(ordered, (member) => member.signTransaction(bytes))
      return yield* combine(partial)
    }),
    signPersonalMessage: Effect.fn("Signer.multisig.signPersonalMessage")(function*(bytes: Uint8Array) {
      const partial = yield* Effect.forEach(ordered, (member) => member.signPersonalMessage(bytes))
      return yield* combine(partial)
    })
  }
  if (lockedMembers.length === 0) return signer
  return Object.assign(signer, {
    locked: Effect.map(Effect.all(lockedMembers), (states) => states.some((locked) => locked))
  })
})

/**
 * A signer that signs transactions **as** `address` with `signer`'s key, for
 * an address whose alias set (`0x2::address_alias`) includes `signer.address`:
 * "sender A, signed by M".
 *
 * The answer's `address` is `address` — so `Tx.run`'s sender, the sender lock,
 * the journal's `sender` and every check against the bytes are the account's —
 * and its `alias` is the address whose key actually signs (`signer.alias` when
 * `signer` is itself an alias signer, else `signer.address`). The scheme and
 * `maxEpoch` are `signer`'s, and a structural `locked` is carried over.
 *
 * **That the alias may sign is checked against the chain, not here**: this
 * constructor makes no read. `Tx.run` reads `address`'s `AddressAliases`
 * object before anything is built and refuses a signer that is not in the set
 * with `PolicyDenied { rule: "alias.signer" }`; `Tx.sign` and `Tx.cosign` (no
 * `Sui`) compare only `address` with the bytes. Use
 * `AddressAlias.requireSigner(address, signer.address)` to check it yourself.
 *
 * **Transactions only.** Validators resolve aliases for a transaction's sender
 * and gas owner; a personal message signed by the alias is the alias's own and
 * verifies as it, never as `address`. So `signPersonalMessage` fails with
 * `SigningError { reason: "unavailable" }`; sign the message with `signer`
 * itself.
 *
 * Given a `signer` whose address already is `address`, answers `signer`
 * unchanged: an address is its own alias until it removes itself.
 *
 * ```ts
 * const m = yield* Signer.multisig(publicKey, [passkey, phrase])
 * yield* Tx.run(recipe, { signer: Signer.alias(account, m) })
 * ```
 *
 * Never fails.
 *
 * @since 0.6.0
 */
export const alias = (address: SuiAddress, signer: Signer): Signer => {
  const account = SuiAddress.make(normalizeSuiAddress(address))
  if (normalizeSuiAddress(signer.address) === account && signer.alias === undefined) return signer
  const key = SuiAddress.make(normalizeSuiAddress(signer.alias ?? signer.address))
  const aliased: Signer = {
    address: account,
    alias: key,
    scheme: signer.scheme,
    ...(signer.maxEpoch === undefined ? {} : { maxEpoch: signer.maxEpoch }),
    signTransaction: (bytes) => signer.signTransaction(bytes),
    signPersonalMessage: () =>
      Effect.fail(
        new SigningError({
          reason: "unavailable",
          cause: `${key} signs as ${account} through an address alias, which covers transactions only:` +
            " a personal message signed by the alias verifies as the alias. Sign it with the alias's own signer"
        })
      )
  }
  const locked = lockedOf(signer)
  return locked === undefined ? aliased : Object.assign(aliased, { locked })
}
