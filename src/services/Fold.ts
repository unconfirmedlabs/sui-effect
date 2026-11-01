/**
 * Folding coin objects into the owner's **address balance**, and sending into
 * one: the planning and the recipes. `Tx.foldCoins`, which runs a plan, lives
 * in `Tx.ts` beside `Tx.run`.
 *
 * An address balance has no object version, so a transaction that pays gas
 * from it and draws its funds from it pins nothing: it cannot equivocate a
 * coin, and two of them from one sender do not invalidate each other. Coins
 * arrive anyway — a coin-paying faucet, a transfer, an exchange withdrawal — and
 * folding is how they get into the balance. DESIGN §6.
 *
 * @since 0.4.0
 */
import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions"
import { normalizeStructTag } from "@mysten/sui/utils"
import { Effect, Stream } from "effect"
import { typeMatches } from "../domain/bcs.ts"
import type { TransportError } from "../domain/errors.ts"
import type { Executed, Simulation } from "../domain/executed.ts"
import type { Coin, SuiAddress } from "../domain/schemas.ts"
import { CoinType } from "../domain/schemas.ts"
import type { Recipe } from "./Sui.ts"
import { Sui } from "./Sui.ts"

/**
 * How one fold transaction pays for gas.
 *
 * - `"foldedCoins"`: SUI only. The batch **is** the gas payment and
 *   `0x2::coin::send_funds<SUI>(GasCoin, owner)` deposits the whole gas coin,
 *   so the fold pays for itself and needs no address balance — the bootstrap
 *   for a fresh, coin-funded account.
 * - `"addressBalance"`: the coins are inputs and gas comes from the SUI
 *   address balance (payment `[]`); what a SUI batch too small to cover its
 *   own budget gets when the balance can.
 * - `"auto"`: any other coin type. The payment is left to the resolver, which
 *   pays from the SUI balance when it covers the budget and from SUI coins
 *   otherwise.
 *
 * @since 0.4.0
 */
export type FoldGas = "foldedCoins" | "addressBalance" | "auto"

/**
 * One fold transaction's worth of coins: what {@link fold} turns into a
 * recipe.
 *
 * @since 0.4.0
 */
export interface FoldBatch {
  /** Whose coins these are, and whose address balance receives them. */
  readonly owner: SuiAddress
  /** The coin type, normalized: the `T` of `0x2::coin::Coin<T>`. */
  readonly coinType: CoinType
  /** The coins, largest first, at the versions the plan read. */
  readonly coins: ReadonlyArray<Coin>
  /** Their total, in the coin type's smallest unit. */
  readonly amount: bigint
  readonly gas: FoldGas
}

/**
 * What {@link planFold} answers: the transactions that fold an owner's coins,
 * in the order they must run, and the SUI dust that cannot pay for its own
 * fold.
 *
 * @since 0.4.0
 */
export interface FoldPlan {
  readonly owner: SuiAddress
  /** SUI batches first: their deposits fund the gas of everything after them. */
  readonly batches: ReadonlyArray<FoldBatch>
  /**
   * SUI coins worth less together than the estimated budget of folding them,
   * with no address balance to pay for it either. Folding them would cost more
   * than they hold, or could not be paid for at all.
   */
  readonly skipped: ReadonlyArray<Coin>
}

/**
 * The most coins one fold transaction takes. One `MergeCoins` takes at most
 * 511 arguments (the protocol's `max_arguments` is 512) and a gas payment at
 * most 256 coins, so 500 is one merge and, for SUI, a full payment plus 244
 * merged into it — about 37 KB of object references, well under the 128 KB
 * transaction limit.
 */
const MAX_FOLD_COINS = 500

/** The most coins a gas payment may name (`max_gas_payment_objects`). */
const MAX_GAS_PAYMENT_COINS = 256

/**
 * The estimated gas budget of folding `coins` coins, in gas units before the
 * reference gas price: deliberately above what a node chooses (5,000 units for
 * five coins and 155,000 for 290 on localnet, protocol 139), since a batch that
 * pays for itself must cover the whole budget, not the net charge, which the
 * storage rebates usually make negative.
 */
const foldBudgetUnits = (coins: number): bigint => 10_000n + 1_000n * BigInt(coins)

const SUI = CoinType.SUI

const isSui = (coinType: string): boolean => {
  try {
    return normalizeStructTag(coinType) === SUI
  } catch {
    return false
  }
}

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const chunks: Array<ReadonlyArray<A>> = []
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size))
  return chunks
}

const sumOf = (coins: ReadonlyArray<Coin>): bigint => coins.reduce((total, coin) => total + coin.balance, 0n)

/**
 * Plans the transactions that fold an owner's coin objects into its address
 * balance. Reads only; nothing is built or signed.
 *
 * It reads the owner's coins of `coinType` — or, when `coinType` is omitted, of
 * every coin type the owner holds coins of — the owner's SUI address balance
 * and the reference gas price. Coins are folded largest first, at most
 * `maxCoinsPerTransaction` per transaction (default and maximum
 * {@link MAX_FOLD_COINS}; values outside 1 to 500 are clamped).
 *
 * **SUI pays for its own fold** (`gas: "foldedCoins"`), so an account whose
 * SUI is all coins — a localnet faucet's, say — folds with no address balance
 * at all. A SUI batch worth less than its estimated budget,
 * `referenceGasPrice × (10,000 + 1,000 × coins)` MIST, is paid from the
 * address balance instead (`gas: "addressBalance"`) when the balance projected
 * after the earlier batches covers that estimate, and is `skipped` otherwise.
 * Other coin types fold with `gas: "auto"`, after every SUI batch, so the SUI
 * just folded pays for them.
 *
 * Preview a batch with `Tx.prepare(Tx.fold(batch), { sender })`, nothing
 * signed, and read what it moves with {@link foldMovement}; pass the plan
 * you previewed to `Tx.foldCoins({ plan, approve })` to run exactly it.
 *
 * Fails with: `TransportError`.
 *
 * @since 0.4.0
 */
export const planFold = Effect.fn("Tx.planFold")(function*(opts: {
  readonly owner: SuiAddress
  /** One coin type to fold; every coin type the owner holds coins of when omitted. */
  readonly coinType?: CoinType
  /** At most this many coins per transaction: 1 to 500, 500 by default. */
  readonly maxCoinsPerTransaction?: number
}): Effect.fn.Return<FoldPlan, TransportError, Sui> {
  const sui = yield* Sui
  const owner = opts.owner
  const perTransaction = Math.min(
    MAX_FOLD_COINS,
    Math.max(1, Math.floor(opts.maxCoinsPerTransaction ?? MAX_FOLD_COINS))
  )
  yield* Effect.annotateCurrentSpan({ "sui.owner": owner, "sui.fold.max_coins": perTransaction })

  const coinTypes: ReadonlyArray<CoinType> = opts.coinType !== undefined
    ? [CoinType.normalize(opts.coinType)]
    : (yield* Stream.runCollect(sui.streamBalances(owner)))
      .filter((balance) => balance.coinBalance > 0n)
      .map((balance) => CoinType.normalize(balance.coinType))
  // SUI first: its deposits are what the other folds' gas comes out of.
  const ordered = [...coinTypes.filter(isSui), ...coinTypes.filter((type) => !isSui(type))]

  const [{ referenceGasPrice }, suiBalance] = yield* Effect.all([
    sui.core.getReferenceGasPrice(),
    sui.getBalance(owner)
  ], { concurrency: "unbounded" })
  const gasPrice = BigInt(referenceGasPrice)
  let projected = suiBalance.addressBalance as bigint

  const batches: Array<FoldBatch> = []
  const skipped: Array<Coin> = []
  for (const coinType of ordered) {
    const coins = [...(yield* Stream.runCollect(sui.streamCoins(owner, coinType)))]
      .sort((left, right) => (left.balance > right.balance ? -1 : left.balance < right.balance ? 1 : 0))
    for (const group of chunk(coins, perTransaction)) {
      const amount = sumOf(group)
      if (!isSui(coinType)) {
        batches.push({ owner, coinType, coins: group, amount, gas: "auto" })
        continue
      }
      const estimate = gasPrice * foldBudgetUnits(group.length)
      if (amount >= estimate) {
        batches.push({ owner, coinType, coins: group, amount, gas: "foldedCoins" })
      } else if (projected >= estimate) {
        batches.push({ owner, coinType, coins: group, amount, gas: "addressBalance" })
      } else {
        skipped.push(...group)
        continue
      }
      projected += amount - estimate
    }
  }
  yield* Effect.annotateCurrentSpan({
    "sui.fold.batches": batches.length,
    "sui.fold.skipped": skipped.length
  })
  return { owner, batches, skipped }
})

/**
 * The recipe for one fold transaction: merge the batch's coins and deposit
 * them into the owner's address balance with `0x2::coin::send_funds<T>`.
 *
 * - `gas: "foldedCoins"` (SUI): the first 256 coins are the gas payment, the
 *   rest are merged into the gas coin, and the gas coin itself is deposited —
 *   no SUI coin is left.
 * - `gas: "addressBalance"`: the coins are merged into the first and it is
 *   deposited; the payment is `[]`, so gas comes from the SUI address balance,
 *   which `Tx.build` checks covers the budget.
 * - `gas: "auto"`: the same, with the payment left to the resolver.
 *
 * The coins are pinned at the versions the plan read (`tx.objectRef`), so a
 * coin that moved since fails the build rather than folding something else.
 *
 * Never fails; the recipe throws for an empty batch, more than 500 coins, or
 * `"foldedCoins"` on a coin type that is not SUI, which `Tx.build` reports as
 * `BuildError`.
 *
 * @since 0.4.0
 */
export const fold = (batch: FoldBatch): Recipe => (tx: Transaction) => {
  if (batch.coins.length === 0) throw new Error("a fold batch has no coins")
  if (batch.coins.length > MAX_FOLD_COINS) {
    throw new Error(`a fold batch takes at most ${MAX_FOLD_COINS} coins, not ${batch.coins.length}`)
  }
  const refs = batch.coins.map((coin) => ({
    objectId: coin.objectId,
    version: coin.version.toString(),
    digest: coin.digest
  }))
  if (batch.gas === "foldedCoins") {
    if (!isSui(batch.coinType)) {
      throw new Error(`only SUI can pay for its own fold, not ${batch.coinType}`)
    }
    tx.setGasPayment(refs.slice(0, MAX_GAS_PAYMENT_COINS))
    const rest = refs.slice(MAX_GAS_PAYMENT_COINS)
    if (rest.length > 0) tx.mergeCoins(tx.gas, rest.map((ref) => tx.objectRef(ref)))
    tx.moveCall({
      target: "0x2::coin::send_funds",
      typeArguments: [batch.coinType],
      arguments: [tx.gas, tx.pure.address(batch.owner)]
    })
    return
  }
  if (batch.gas === "addressBalance") tx.setGasPayment([])
  const [first, ...rest] = refs.map((ref) => tx.objectRef(ref))
  if (first === undefined) throw new Error("a fold batch has no coins")
  if (rest.length > 0) tx.mergeCoins(first, rest)
  tx.moveCall({
    target: "0x2::coin::send_funds",
    typeArguments: [batch.coinType],
    arguments: [first, tx.pure.address(batch.owner)]
  })
}

/**
 * Sends `amount` of a coin type into `recipient`'s **address balance**:
 * `0x2::balance::send_funds<T>(tx.balance({ type, balance: amount }), recipient)`,
 * the canonical transfer on an address-balance account.
 *
 * The amount comes from the sender's address balance when that covers it — a
 * `FundsWithdrawal`, no versioned input at all, so with gas from the balance
 * too the transaction pins nothing. Otherwise it comes from coins: for SUI,
 * split from the gas coin, the SDK's default; for another type, the sender's
 * coins merged and split, the remainder returned to its balance. The recipient
 * receives a balance rather than a coin object it would have to fold.
 * `coinType` defaults to SUI; `amount` is in the type's smallest unit.
 *
 * `useGasCoin` is the SDK's option of that name and only matters for SUI that
 * the balance does not cover. Leave it `true` for the sender's own
 * transactions: `false` makes every SUI coin an input of the PTB, which leaves
 * none to pay gas with on an account whose SUI is all coins (a node refuses gas
 * selection then). Set it `false` under `Tx.sponsored`, where the gas coin
 * belongs to the sponsor.
 *
 * Never fails; the recipe throws only if the SDK rejects an input, which
 * `Tx.build` reports as `BuildError`.
 *
 * @since 0.4.0
 */
export const sendFunds = (opts: {
  readonly coinType?: CoinType
  readonly amount: bigint
  readonly recipient: SuiAddress
  /** Whether SUI the balance does not cover may be split from the gas coin. Default `true`. */
  readonly useGasCoin?: boolean
}): Recipe =>
(tx: Transaction) => {
  const type = opts.coinType ?? SUI
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [type],
    arguments: [
      tx.balance({ type, balance: opts.amount, useGasCoin: opts.useGasCoin ?? true }),
      tx.pure.address(opts.recipient)
    ]
  })
}

/**
 * What one fold moves, read off its simulation (or its execution):
 * `consumed`, the batch's coins the effects delete, with the balances the plan
 * read them at; `fromCoins`, their total; `toAddressBalance`, what the owner's
 * address balance of the coin type gains; and `netChange`, the owner's net
 * balance change, which is all `balanceChanges` reports.
 *
 * @since 0.5.0
 */
export interface FoldMovement {
  readonly owner: SuiAddress
  readonly coinType: CoinType
  /** The batch's coins this fold consumes, at the versions and balances the plan read. */
  readonly consumed: ReadonlyArray<Coin>
  /** The batch's coins the effects do **not** consume. Empty for a fold that does what it says. */
  readonly missing: ReadonlyArray<Coin>
  /** The total of `consumed`, in the coin type's smallest unit. */
  readonly fromCoins: bigint
  /**
   * What the owner's address balance of this coin type gains: `netChange +
   * fromCoins`. For a SUI batch paying for itself, the coins less the net gas
   * (more than the coins when the storage rebates exceed the gas).
   */
  readonly toAddressBalance: bigint
  /** The owner's net balance change for the coin type, coins and balance together. */
  readonly netChange: bigint
  /**
   * Whether `toAddressBalance` is exact: every coin of the batch is consumed,
   * and the owner ends up with no coin object of this type created or
   * mutated, so nothing but the address balance can hold the difference.
   */
  readonly exact: boolean
}

/**
 * The coin → address-balance movement of one fold, which its balance changes
 * do not show: a node nets them per address, so a fold of 1,000 SUI of coins
 * reports only the gas (`+3,939,506` MIST on localnet, protocol 139, for five
 * faucet coins whose storage rebate beat the gas), and the coins' balances are
 * not in the effects at all — the coins are simply deleted, and the deposit is
 * an accumulator write with no amount on it. So the movement is computed from
 * what is known exactly: the batch's coins were pinned at the versions the plan
 * read (`tx.objectRef`), so their balances are the plan's; the effects say
 * which of them were consumed; and the owner's net balance change is the rest.
 *
 * For `simulation` pass `prepared.simulation` (`Tx.prepare(Tx.fold(batch),
 * { sender })`, or what `Tx.foldCoins`' `approve` is shown), or the
 * `Executed` the fold produced. Never fails.
 *
 * @since 0.5.0
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Tx, type Signer } from "@unconfirmed/sui-effect/tx"
 *
 * declare const signer: Signer
 *
 * const program = Effect.gen(function*() {
 *   const plan = yield* Tx.planFold({ owner: signer.address })
 *   return yield* Tx.foldCoins({
 *     signer,
 *     plan,
 *     approve: (prepared, batch) => {
 *       const moved = Tx.foldMovement(batch, prepared.simulation)
 *       return Effect.log(`${moved.consumed.length} coins, +${moved.toAddressBalance} into the balance`)
 *     }
 *   })
 * })
 * ```
 */
export const foldMovement = (batch: FoldBatch, effects: Simulation | Executed): FoldMovement => {
  const gone = new Set(effects.deleted().map((ref) => ref.id as string))
  const consumed = batch.coins.filter((coin) => gone.has(coin.objectId))
  const missing = batch.coins.filter((coin) => !gone.has(coin.objectId))
  const fromCoins = sumOf(consumed)
  const netChange = effects.balanceChange(batch.owner, batch.coinType)
  const coinOfType = `0x2::coin::Coin<${batch.coinType}>`
  const ownsCoin = (ref: { readonly type?: string; readonly owner?: { readonly $kind: string; readonly AddressOwner?: string } }) =>
    ref.type !== undefined && typeMatches(coinOfType, ref.type) &&
    ref.owner?.$kind === "AddressOwner" && ref.owner.AddressOwner === batch.owner
  const kept = [...effects.created(), ...effects.mutated()].some(ownsCoin)
  return {
    owner: batch.owner,
    coinType: batch.coinType,
    consumed,
    missing,
    fromCoins,
    toAddressBalance: netChange + fromCoins,
    netChange,
    exact: missing.length === 0 && !kept
  }
}

/**
 * What one {@link sendAll} sweep takes: the coins and the address balance of
 * one coin type, as read just before the build, and how the transaction pays
 * for gas. What `Tx.sendAll`'s `approve` is shown beside the prepared
 * transaction, and what its answer reports.
 *
 * - `"coinReservation"` (SUI): gas is a reservation of the **whole** SUI
 *   address balance, the coins are merged into that gas coin, and the gas
 *   coin is deposited — what is left after gas is the recipient's.
 * - `"coins"` (SUI): the coins are the gas payment (the first 256; the rest
 *   are merged into the gas coin), the address balance is redeemed into a
 *   coin and merged into it, and the gas coin is deposited.
 * - `"auto"` (any other coin type): the coins are merged and deposited, the
 *   balance is withdrawn and deposited, and SUI pays the gas, from wherever
 *   the resolver finds it.
 *
 * @since 0.5.0
 */
export interface SendAllSweep {
  readonly owner: SuiAddress
  readonly recipient: SuiAddress
  /** The coin type, normalized. */
  readonly coinType: CoinType
  /** The coin objects swept, largest first, at the versions read. */
  readonly coins: ReadonlyArray<Coin>
  /** The owner's address balance of the coin type as read: all of it is swept. */
  readonly addressBalance: bigint
  /** `coins` plus `addressBalance`, before gas. */
  readonly amount: bigint
  readonly gas: "coinReservation" | "coins" | "auto"
}

/** The most coin objects one sweep takes: the fold's limit, for the same reasons. */
export const MAX_SWEEP_COINS = MAX_FOLD_COINS

/**
 * Reads what a sweep of `coinType` from `owner` takes and chooses its gas
 * shape. SUI pays from whichever of the two holds more: the address balance
 * (a coin reservation of all of it, which covers the budget unless the whole
 * account is about as small as one) or the coins (the gas payment). Never
 * builds anything.
 *
 * Fails with: `TransportError`.
 */
export const readSweep = Effect.fnUntraced(function*(opts: {
  readonly owner: SuiAddress
  readonly recipient: SuiAddress
  readonly coinType: CoinType
}): Effect.fn.Return<SendAllSweep, TransportError, Sui> {
  const sui = yield* Sui
  const coinType = CoinType.normalize(opts.coinType)
  const [coins, balance] = yield* Effect.all([
    Stream.runCollect(sui.streamCoins(opts.owner, coinType)),
    sui.getBalance(opts.owner, coinType)
  ], { concurrency: "unbounded" })
  const sorted = [...coins].sort((left, right) =>
    left.balance > right.balance ? -1 : left.balance < right.balance ? 1 : 0
  )
  const fromCoins = sumOf(sorted)
  const addressBalance = balance.addressBalance as bigint
  const gas = !isSui(coinType) ? "auto" : sorted.length === 0 || addressBalance >= fromCoins ? "coinReservation" : "coins"
  return {
    owner: opts.owner,
    recipient: opts.recipient,
    coinType,
    coins: sorted,
    addressBalance,
    amount: fromCoins + addressBalance,
    gas
  }
})

/**
 * The recipe of one sweep: everything in {@link SendAllSweep} into the
 * recipient's **address balance**, with `0x2::coin::send_funds<T>` (and, for
 * the balance of a non-SUI type, `0x2::balance::send_funds<T>` of
 * `0x2::balance::redeem_funds<T>` of a `FundsWithdrawal` of all of it). The
 * coins are pinned at the versions read (`tx.objectRef`).
 *
 * Never fails; the recipe throws for a sweep of nothing or of more than
 * {@link MAX_SWEEP_COINS} coins, which `Tx.build` reports as `BuildError`.
 */
export const sweep = (plan: SendAllSweep): Recipe => (tx: Transaction) => {
  if (plan.coins.length > MAX_SWEEP_COINS) {
    throw new Error(
      `a sweep takes at most ${MAX_SWEEP_COINS} coin objects, and ${plan.owner} holds ${plan.coins.length}` +
        ` of ${plan.coinType}: fold them into the address balance first (Tx.foldCoins), then sweep`
    )
  }
  if (plan.amount === 0n) throw new Error(`${plan.owner} holds no ${plan.coinType} to send`)
  const refs = plan.coins.map((coin) => ({
    objectId: coin.objectId,
    version: coin.version.toString(),
    digest: coin.digest
  }))
  const recipient = tx.pure.address(plan.recipient)
  const withdraw = () =>
    tx.withdrawal({ amount: plan.addressBalance, type: plan.coinType })
  switch (plan.gas) {
    case "coinReservation": {
      // The payment is left to the resolver, which — the recipe uses the gas
      // coin and the payer has an address balance — makes it a reservation of
      // all of that balance; every coin is an input, so none is added to it.
      if (refs.length > 0) tx.mergeCoins(tx.gas, refs.map((ref) => tx.objectRef(ref)))
      break
    }
    case "coins": {
      tx.setGasPayment(refs.slice(0, MAX_GAS_PAYMENT_COINS))
      const rest: Array<TransactionObjectArgument> = refs.slice(MAX_GAS_PAYMENT_COINS).map((ref) => tx.objectRef(ref))
      if (plan.addressBalance > 0n) {
        rest.push(tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [plan.coinType], arguments: [withdraw()] }))
      }
      if (rest.length > 0) tx.mergeCoins(tx.gas, rest)
      break
    }
    case "auto": {
      const [first, ...rest] = refs.map((ref) => tx.objectRef(ref))
      if (first !== undefined) {
        if (rest.length > 0) tx.mergeCoins(first, rest)
        tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: [plan.coinType], arguments: [first, recipient] })
      }
      if (plan.addressBalance > 0n) {
        tx.moveCall({
          target: "0x2::balance::send_funds",
          typeArguments: [plan.coinType],
          arguments: [
            tx.moveCall({ target: "0x2::balance::redeem_funds", typeArguments: [plan.coinType], arguments: [withdraw()] }),
            recipient
          ]
        })
      }
      return
    }
  }
  // SUI: the gas coin is everything, and what gas leaves of it is deposited.
  tx.moveCall({ target: "0x2::coin::send_funds", typeArguments: [plan.coinType], arguments: [tx.gas, recipient] })
}
