/**
 * `Intent`: what a transaction is declared to do, and the record of having
 * checked that it does no more.
 *
 * An intent has two halves, because two different checkers read it. `claims`
 * is for code: exact bounds on what may leave the sender, compared with the
 * simulated effects by {@link checkClaims}, deny by default. `summary` is for a
 * person and for the semantic screen behind `Gate`: one sentence, compared with
 * the same effects rendered as words by {@link describeEffects}. A benign
 * sentence in front of generous claims is caught on the third edge, the claims
 * rendered as words by {@link describeClaims}.
 *
 * Everything here is pure. The simulate, the screen and the policy that turns
 * probabilities into a refusal are `Tx.verify`.
 *
 * @since 0.5.0
 */
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { Schema } from "effect"
import { typeMatches } from "./bcs.ts"
import { Built } from "./built.ts"
import type { Simulation as SimulationClass } from "./executed.ts"
import type { ChangedObject, Owner } from "./schemas.ts"
import { CoinType, ObjectId, SuiAddress } from "./schemas.ts"

/**
 * What the pure checks read off a simulation: its fields, not its accessors,
 * so a `Simulation` passes and so does any value with the same data (one
 * assembled in a test, or spread from a `Simulation` with a field changed).
 */
type Simulation = Pick<SimulationClass, "effects" | "balanceChanges" | "objectTypes" | "gasPaymentMocked">

/**
 * Who wrote the intent. Provenance for the audit record, and nothing else: the
 * checks are the same for all three, because none of them can be verified from
 * here.
 *
 * `"user"` is a person describing their own transaction. `"task"` is the scope
 * a person gave an agent **before** the agent built anything, which is the only
 * form that constrains a prompt-injected agent; an agent describing its own PTB
 * after the fact is `"dapp"` in all but name. `"dapp"` is a third party's
 * description of a transaction it built, which is a claim to check and never
 * evidence.
 *
 * @since 0.5.0
 */
export const IntentAuthor = Schema.Literals(["user", "task", "dapp"])
export type IntentAuthor = typeof IntentAuthor.Type

/**
 * The most of one coin the sender may lose, in base units, gas excluded.
 *
 * @since 0.5.0
 */
export const OutflowClaim = Schema.Struct({
  coinType: CoinType,
  max: Schema.BigIntFromString.pipe(Schema.check(Schema.isGreaterThanOrEqualToBigInt(0n)))
})
export type OutflowClaim = typeof OutflowClaim.Type

/**
 * What the transaction is allowed to do to the sender, deny by default: a coin
 * that is not listed may not decrease, an address that is not listed may not
 * receive anything, and an object that is not listed may not leave.
 *
 * Gas is not an outflow. It is bounded by `SubmitConfig.maxGasBudget`, and
 * counting it would make every claim a guess about the reference gas price.
 *
 * @since 0.5.0
 */
export const IntentClaims = Schema.Struct({
  outflows: Schema.Array(OutflowClaim),
  recipients: Schema.Array(SuiAddress),
  objects: Schema.Array(ObjectId)
})
type IntentClaimsType = typeof IntentClaims.Type
/**
 * The decoded shape of {@link IntentClaims}.
 *
 * @since 0.5.0
 */
export interface IntentClaims extends IntentClaimsType {}

/** One sentence is 280 characters at most; past that it is a document. */
const MAX_SUMMARY = 280

const IntentSchema = Schema.Struct({
  summary: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_SUMMARY)),
  author: IntentAuthor,
  claims: IntentClaims
}).annotate({
  identifier: "Intent",
  description: "What a transaction is declared to do"
})
type IntentType = typeof IntentSchema.Type
/**
 * The decoded shape of {@link Intent}.
 *
 * @since 0.5.0
 */
export interface Intent extends IntentType {}

const Probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/**
 * One rendered line and the probability that the declared summary covers it.
 *
 * @since 0.5.0
 */
export const ScreenedLine = Schema.Struct({ text: Schema.String, inScope: Probability })
export type ScreenedLine = typeof ScreenedLine.Type

/**
 * What a semantic screen answered: probabilities, never a decision. The
 * decision is `Gate`'s thresholds, applied in code by `Tx.verify`.
 *
 * @since 0.5.0
 */
export const Screening = Schema.Struct({
  effects: Schema.Array(ScreenedLine),
  claims: Schema.Array(ScreenedLine),
  /** 0 names nothing concrete, 1 an action, 2 the action and its assets. */
  specificity: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  /** The probability that the summary is talking to whoever screens it. */
  injection: Probability
})
type ScreeningType = typeof Screening.Type
/**
 * The decoded shape of {@link Screening}.
 *
 * @since 0.5.0
 */
export interface Screening extends ScreeningType {}

/**
 * How far a transaction was checked. The claims always held, or there would be
 * a `PolicyDenied` instead of a verdict; what varies is whether anything read
 * the sentence. `Unscreened` is never silent: it is on the record with a reason.
 *
 * @since 0.5.0
 */
export const Verdict = Schema.TaggedUnion({
  Screened: { screening: Screening },
  Unscreened: { reason: Schema.String }
})
export type Verdict = typeof Verdict.Type

/**
 * A {@link Built} whose simulated effects stayed inside a declared
 * {@link Intent}. Structurally a `Built`, so `Tx.sign` takes it as it is; the
 * brand is what says `Tx.verify` produced it.
 *
 * @since 0.5.0
 */
export const Verified = Schema.Struct({
  ...Built.fields,
  intent: IntentSchema,
  verdict: Verdict
}).annotate({
  identifier: "Verified",
  description: "A built transaction whose simulated effects stayed inside a declared intent"
}).pipe(Schema.brand("Verified"))
type VerifiedType = typeof Verified.Type
/**
 * The decoded shape of {@link Verified}.
 *
 * @since 0.5.0
 */
export interface Verified extends VerifiedType {}

/**
 * Whose transaction it is. Gas spent by whoever pays it is never an outflow.
 *
 * A `Built` is a `Parties` as it is: `sender`, and `gasOwner` only when someone
 * else pays.
 *
 * @since 0.5.0
 */
export interface Parties {
  readonly sender: SuiAddress
  readonly gasOwner?: SuiAddress | undefined
}

/**
 * One way the simulated effects stepped outside the claims.
 *
 * @since 0.5.0
 */
export interface ClaimViolation {
  readonly rule: "outflow" | "recipient" | "object"
  readonly message: string
}

const SUI = normalizeStructTag("0x2::sui::SUI")
const COIN = "0x2::coin::Coin"
const SUI_DECIMALS = 9

const sameCoin = (left: string, right: string): boolean => {
  try {
    return normalizeStructTag(left) === normalizeStructTag(right)
  } catch {
    return left === right
  }
}

const isSui = (coinType: string): boolean => sameCoin(coinType, SUI)

const sameAddress = (left: string, right: string): boolean =>
  normalizeSuiAddress(left) === normalizeSuiAddress(right)

/** The address that holds an object outright, if one does. */
const holderOf = (owner: Owner | null): string | undefined => {
  if (owner === null) return undefined
  switch (owner.$kind) {
    case "AddressOwner":
      return owner.AddressOwner
    case "ConsensusAddressOwner":
      return owner.ConsensusAddressOwner.owner
    default:
      return undefined
  }
}

/**
 * An accumulator write (`outputState: "AccumulatorWriteV1"`) is the node's
 * bookkeeping for an address balance, not an object anybody holds: it has no
 * owner on either side, and the value it moves is already in
 * `balanceChanges`. Every check skips it, as `Executed`'s accessors do.
 */
const isAccumulatorWrite = (change: ChangedObject): boolean => change.outputState === "AccumulatorWriteV1"

/**
 * Net gas, which is what the payer's SUI balance change includes — whether the
 * gas came from coins or from the payer's address balance, because a node's
 * balance changes cover both. Zero when the node mocked the gas payment
 * (`gasPaymentMocked`): nothing of the payer's paid it, so there is nothing to
 * take back out, and taking it out anyway would hide an outflow of that size.
 */
const gasOf = (simulation: Simulation): bigint => {
  if (simulation.gasPaymentMocked) return 0n
  const gas = simulation.effects.gasUsed
  return gas.computationCost + gas.storageCost - gas.storageRebate
}

/** One address's net change in one coin, gas taken back out of the payer's SUI. */
interface NetChange {
  readonly address: SuiAddress
  readonly coinType: CoinType
  readonly amount: bigint
}

/**
 * The balance changes, one per address and coin type, with the gas taken back
 * out of the payer's SUI **once**. Two balance changes for one address and
 * coin type (spellings a node did not normalize) are added together first, so
 * neither a split nor a duplicate can hide an outflow or count the gas twice.
 * Order is the node's, by first appearance. A payer with no SUI change at all
 * (a fully mocked payment) gets none invented.
 */
const netChangesOf = (simulation: Simulation, parties: Parties): ReadonlyArray<NetChange> => {
  const totals: Array<{ address: SuiAddress; coinType: CoinType; amount: bigint }> = []
  for (const change of simulation.balanceChanges) {
    const known = totals.find((total) =>
      sameAddress(total.address, change.address) && sameCoin(total.coinType, change.coinType)
    )
    if (known === undefined) totals.push({ address: change.address, coinType: change.coinType, amount: change.amount })
    else known.amount += change.amount
  }
  const payer = parties.gasOwner ?? parties.sender
  const gas = gasOf(simulation)
  return totals.map((total) =>
    isSui(total.coinType) && sameAddress(total.address, payer) ? { ...total, amount: total.amount + gas } : total
  )
}

/**
 * Move identifiers are attacker-authored text that ends up in front of the
 * screen, so the address is dropped (hex is noise to it) and the rest is cut
 * short. The charset is already `[A-Za-z0-9_]`, which is what keeps this from
 * being a sentence.
 */
const shortType = (type: string): string => type.replace(/0x[0-9a-fA-F]+::/g, "").slice(0, 96)

/**
 * SUI to three significant figures, `about` when that rounded anything. The
 * screen reads numbers as text: "249.99798 SUI" is, to it, not the "250 SUI" a
 * summary said. The exact comparison already happened, in {@link checkClaims}.
 */
const formatSui = (mist: bigint): string => {
  const exact = Number(mist) / 10 ** SUI_DECIMALS
  const rounded = Number(exact.toPrecision(3))
  const text = rounded.toLocaleString("en-US", { maximumFractionDigits: SUI_DECIMALS, useGrouping: false })
  return rounded === exact ? `${text} SUI` : `about ${text} SUI`
}

/**
 * An amount in words. Only SUI gets a number: a type string carries no
 * trustworthy decimals, and a base-unit count of anything else reads as a
 * quantity it is not.
 */
const amountOf = (coinType: string, amount: bigint): string =>
  isSui(coinType) ? formatSui(amount) : `some ${shortType(coinType)}`

/** A non-coin object the sender held going in. Coins are the balance changes' business. */
const leavesSender = (
  simulation: Simulation,
  parties: Parties,
  change: ChangedObject
): boolean => {
  if (isAccumulatorWrite(change)) return false
  const before = holderOf(change.inputOwner)
  if (before === undefined || !sameAddress(before, parties.sender)) return false
  const type = simulation.objectTypes[change.objectId]
  if (type !== undefined && typeMatches(COIN, type)) return false
  const after = change.outputState === "DoesNotExist" ? undefined : holderOf(change.outputOwner)
  return after === undefined || !sameAddress(after, parties.sender)
}

/** Every address other than the sender that ends up with a coin or an object. */
const receiversOf = (simulation: Simulation, parties: Parties): ReadonlyArray<string> => {
  const found = new Set<string>()
  for (const change of netChangesOf(simulation, parties)) {
    if (sameAddress(change.address, parties.sender)) continue
    if (change.amount > 0n) found.add(normalizeSuiAddress(change.address))
  }
  for (const change of simulation.effects.changedObjects) {
    if (isAccumulatorWrite(change) || change.outputState === "DoesNotExist") continue
    const after = holderOf(change.outputOwner)
    if (after === undefined || sameAddress(after, parties.sender)) continue
    const before = holderOf(change.inputOwner)
    if (before !== undefined && sameAddress(before, after)) continue
    found.add(normalizeSuiAddress(after))
  }
  return [...found]
}

/**
 * What the sender loses, per coin type, net of gas: one entry per coin type
 * whose net balance change for the sender is negative, in the order the node
 * reported them.
 */
const lossesOf = (
  simulation: Simulation,
  parties: Parties
): ReadonlyArray<{ readonly coinType: CoinType; readonly lost: bigint }> =>
  netChangesOf(simulation, parties)
    .filter((change) => sameAddress(change.address, parties.sender) && change.amount < 0n)
    .map((change) => ({ coinType: change.coinType, lost: -change.amount }))

/**
 * Compares the simulated effects with the claims, exactly and in code.
 *
 * Deny by default: a coin the sender loses needs an outflow claim that covers
 * the amount (net of gas), an address that gains a coin or an object needs to
 * be a claimed recipient, and a non-coin object that leaves the sender —
 * transferred, shared, wrapped or deleted — needs to be a claimed object.
 *
 * **Gas is gas wherever it is paid from.** A node's balance changes cover coin
 * objects and address balances alike, so the payer's SUI delta carries the
 * gas whether the payment was a gas coin or the payer's address balance (an
 * empty payment), and it is taken back out either way. Anything else that
 * leaves the sender's address balance — a `balance::send_funds` of a
 * `tx.balance()` withdrawal — is an outflow like any coin transfer, and its
 * receiver a recipient. Accumulator writes are bookkeeping and never an object.
 *
 * Never fails. An empty answer means the claims held.
 *
 * @since 0.5.0
 */
export const checkClaims = (
  intent: Intent,
  simulation: Simulation,
  parties: Parties
): ReadonlyArray<ClaimViolation> => {
  const violations: Array<ClaimViolation> = []
  for (const { coinType, lost } of lossesOf(simulation, parties)) {
    const claim = intent.claims.outflows.find((outflow) => sameCoin(outflow.coinType, coinType))
    if (claim === undefined) {
      violations.push({
        rule: "outflow",
        message: `the sender loses ${lost} of ${coinType}, which the intent does not claim`
      })
    } else if (lost > claim.max) {
      violations.push({
        rule: "outflow",
        message: `the sender loses ${lost} of ${coinType}, over the claimed ${claim.max}`
      })
    }
  }
  for (const receiver of receiversOf(simulation, parties)) {
    if (intent.claims.recipients.some((claimed) => sameAddress(claimed, receiver))) continue
    violations.push({
      rule: "recipient",
      message: `${receiver} receives assets and is not a claimed recipient`
    })
  }
  for (const change of simulation.effects.changedObjects) {
    if (!leavesSender(simulation, parties, change)) continue
    if (intent.claims.objects.some((claimed) => sameAddress(claimed, change.objectId))) continue
    violations.push({
      rule: "object",
      message: `${change.objectId} leaves the sender and is not a claimed object`
    })
  }
  return violations
}

/**
 * The exact claims a simulation implies: every coin the sender loses (net of
 * gas, at exactly the amount lost), every address other than the sender that
 * receives a coin or an object, and every non-coin object that leaves the
 * sender. {@link checkClaims} of the answer against the same simulation and
 * parties is empty by construction.
 *
 * This is how a wallet shows a transaction somebody else built — a dapp's
 * bytes — as claims a person can read and approve, and then holds the bytes it
 * signs to them: render the claims, ask, and pass the answer to `Tx.verify`.
 * The claims describe what was simulated, not what the dapp said, so `author`
 * is normally `"dapp"` and `summary` is the dapp's own sentence, which the
 * screen behind `Gate` (when there is one) compares with the effects. `parties`
 * may be the `Built` itself.
 *
 * Never fails. The summary is not checked here: an empty or over-long one is
 * refused by `Tx.verify` as `PolicyDenied { rule: "intent.invalid" }`.
 *
 * @since 0.5.0
 */
const fromSimulation = (
  simulation: Simulation,
  parties: Parties,
  opts: { readonly summary: string; readonly author: IntentAuthor }
): Intent => {
  const objects: Array<ObjectId> = []
  for (const change of simulation.effects.changedObjects) {
    if (leavesSender(simulation, parties, change)) objects.push(change.objectId)
  }
  return {
    summary: opts.summary,
    author: opts.author,
    claims: {
      outflows: lossesOf(simulation, parties).map(({ coinType, lost }) => ({ coinType, max: lost })),
      recipients: receiversOf(simulation, parties).map((address) => SuiAddress.make(address)),
      objects
    }
  }
}

/**
 * A declared intent: one sentence for the screen, exact claims for the code.
 *
 * `Intent.fromSimulation(simulation: Simulation, parties: Parties, opts: {
 * summary: string; author: IntentAuthor }): Intent` renders a simulation as
 * the exact claims it implies: every coin the sender loses at exactly the
 * amount lost (net of gas), every address other than the sender that receives
 * a coin or an object, every non-coin object that leaves the sender. So
 * `checkClaims(Intent.fromSimulation(s, p, opts), s, p)` is empty. It is how a
 * wallet shows a dapp's bytes as claims a person can approve, then holds what
 * it signs to them with `Tx.verify`; `parties` may be the `Built` itself.
 * Never fails; the summary is checked by `Tx.verify` (`intent.invalid`).
 *
 * @since 0.5.0
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Sui } from "@unconfirmed/sui-effect"
 * import { Intent, Tx } from "@unconfirmed/sui-effect/tx"
 *
 * declare const dappBytes: Uint8Array
 *
 * const review = Effect.gen(function*() {
 *   const sui = yield* Sui
 *   const built = yield* Tx.fromBytes(dappBytes)
 *   const simulation = yield* sui.simulate(built.bytes)
 *   const claims = Intent.fromSimulation(simulation, built, { summary: "Mint one hero.", author: "dapp" })
 *   return yield* Tx.verify(built, claims)
 * })
 * ```
 */
export const Intent = Object.assign(IntentSchema, { fromSimulation })

const LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * The simulated effects as sentences a semantic screen can read: addresses
 * become labels, types lose their package ids, and only SUI carries a number.
 * What it cannot say reliably it does not say.
 *
 * Never fails. Always answers with at least one line.
 *
 * @since 0.5.0
 */
export const describeEffects = (
  simulation: Simulation,
  parties: Parties
): ReadonlyArray<string> => {
  const labels = new Map<string, string>()
  const labelOf = (address: string): string => {
    const key = normalizeSuiAddress(address)
    const known = labels.get(key)
    if (known !== undefined) return known
    const label = `recipient ${LABELS[labels.size % LABELS.length]}`
    labels.set(key, label)
    return label
  }
  const lines: Array<string> = []
  for (const change of netChangesOf(simulation, parties)) {
    const amount = change.amount
    if (amount === 0n) continue
    if (sameAddress(change.address, parties.sender)) {
      lines.push(
        amount < 0n
          ? `The sender spends ${amountOf(change.coinType, -amount)}.`
          : `The sender receives ${amountOf(change.coinType, amount)}.`
      )
    } else if (amount > 0n) {
      lines.push(
        `Another address (${labelOf(change.address)}) receives ${amountOf(change.coinType, amount)}.`
      )
    }
  }
  for (const change of simulation.effects.changedObjects) {
    if (isAccumulatorWrite(change)) continue
    if (change.outputState === "PackageWrite") {
      lines.push("A Move package is published or upgraded.")
      continue
    }
    const type = simulation.objectTypes[change.objectId]
    if (type !== undefined && typeMatches(COIN, type)) continue
    const named = type === undefined ? "An object" : `An object of type ${shortType(type)}`
    if (leavesSender(simulation, parties, change)) {
      const after = change.outputState === "DoesNotExist" ? undefined : change.outputOwner
      const holder = holderOf(after ?? null)
      lines.push(
        holder !== undefined
          ? `${named} owned by the sender is transferred to another address (${labelOf(holder)}).`
          : after?.$kind === "Shared"
          ? `${named} owned by the sender becomes a shared object.`
          : after?.$kind === "ObjectOwner"
          ? `${named} moves from the sender's wallet into another object, such as a kiosk, vault or escrow.`
          : `${named} owned by the sender is wrapped or deleted.`
      )
      continue
    }
    if (change.idOperation !== "Created") continue
    const holder = holderOf(change.outputOwner)
    if (holder === undefined) continue
    lines.push(
      sameAddress(holder, parties.sender)
        ? `The sender receives a new object${type === undefined ? "" : ` of type ${shortType(type)}`}.`
        : `${named} is created for another address (${labelOf(holder)}).`
    )
  }
  return lines.length === 0
    ? ["The transaction changes no balances and moves no objects owned by the sender."]
    : lines
}

/**
 * The claims as sentences, for the edge between the summary and the claims: a
 * harmless sentence must not sit in front of permissions it has no use for.
 *
 * Never fails. Answers with no lines when the intent claims nothing.
 *
 * @since 0.5.0
 */
export const describeClaims = (intent: Intent): ReadonlyArray<string> => [
  ...intent.claims.outflows.map((outflow) =>
    `The sender may spend up to ${amountOf(outflow.coinType, outflow.max)}.`
  ),
  ...(intent.claims.recipients.length === 0
    ? []
    : [
      intent.claims.recipients.length === 1
        ? "One other address may receive assets from the sender."
        : `${intent.claims.recipients.length} other addresses may receive assets from the sender.`
    ]),
  ...(intent.claims.objects.length === 0
    ? []
    : [
      intent.claims.objects.length === 1
        ? "One object the sender owns may leave the sender."
        : `${intent.claims.objects.length} objects the sender owns may leave the sender.`
    ])
]
