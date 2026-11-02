/**
 * `Built`: a transaction built into bytes and ready to sign, with what the
 * build learned about it — the expiration, the chain, the gas, and, when the
 * build ran one, the simulation of exactly these bytes.
 *
 * Its own module since 0.5.0 (it was in `schemas.ts`), because it carries a
 * {@link Simulation}, which carries `Executed`'s accessors.
 *
 * @since 0.5.0
 */
import { Schema } from "effect"
import { Simulation } from "./executed.ts"
import { Digest, Mist, ObjectId, SuiAddress, TransactionExpiration, Version } from "./schemas.ts"

/**
 * How built bytes pay for gas, as `Tx.build` reads it back out of them (and
 * as the span attribute `sui.gas_payment` names it):
 *
 * - `"addressBalance"`: an empty payment; gas is drawn from the payer's SUI
 *   address balance at execution, and the bytes pin no gas coin.
 * - `"coinReservation"`: every payment ref is a **coin reservation** — gas
 *   drawn from the balance through a synthetic coin (version `0`), which is
 *   what a `tx.gas` user whose payer has a balance gets. It reserves the
 *   payer's whole balance as read at build time.
 * - `"coins"`: at least one ref is a coin object.
 *
 * @since 0.5.0
 */
export const GasPaymentSource = Schema.Literals(["addressBalance", "coinReservation", "coins"])
export type GasPaymentSource = typeof GasPaymentSource.Type

/**
 * One entry of a transaction's gas payment, as the bytes name it: the SDK's
 * own `{ objectId, version, digest }`. A coin reservation is one of these too
 * (version `0`); {@link BuiltGas.source} says which kind the payment is.
 *
 * @since 0.5.0
 */
export const GasPaymentRef = Schema.Struct({
  objectId: ObjectId,
  version: Version,
  digest: Schema.String
}).annotate({ identifier: "GasPaymentRef", description: "One entry of a transaction's gas payment" })
type GasPaymentRefType = typeof GasPaymentRef.Type
/** The decoded shape of {@link GasPaymentRef}. @since 0.5.0 */
export interface GasPaymentRef extends GasPaymentRefType {}

/**
 * The gas a built transaction carries, read back out of its bytes: `budget`
 * and `price` in MIST, the `owner` who pays (the sender unless it is
 * sponsored), the `payment` refs, and the `source` they amount to.
 *
 * @since 0.5.0
 */
export const BuiltGas = Schema.Struct({
  budget: Mist,
  price: Mist,
  owner: SuiAddress,
  payment: Schema.Array(GasPaymentRef),
  source: GasPaymentSource
}).annotate({ identifier: "BuiltGas", description: "The gas a built transaction carries" })
type BuiltGasType = typeof BuiltGas.Type
/** The decoded shape of {@link BuiltGas}. @since 0.5.0 */
export interface BuiltGas extends BuiltGasType {}

/**
 * A transaction built into bytes and ready to sign, with the expiration the
 * builder settled on recorded so `Tx.reconcile` can decide, later and without
 * the builder, whether the transaction can still land.
 *
 * Every field but `chain` and `simulation` is read back out of `bytes`. Bytes
 * that arrived from somewhere else — a sponsor handed a sender's transaction,
 * a dapp's request — become a `Built` through `Tx.fromBytes`, never by hand: a
 * hand-built value that leaves out `expiration` or `chain` silently disables
 * the expiry rule and the chain guard `Tx.reconcile` depends on.
 *
 * `gas` (0.5.0) is the gas data the bytes carry. `simulation` (0.5.0) is
 * present only when `Tx.build` itself simulated **exactly these bytes** — the
 * explicit simulate it runs when the SDK's resolver did not (a preset budget
 * off gRPC, or nothing to resolve). On gRPC the resolver simulates the
 * transaction before its budget is set, which is a different transaction, so
 * there is no `simulation` there. The lifecycle reuses it (`Tx.run`,
 * `Tx.prepare`, `Tx.verify`) only when it is the very object `Tx.build` made
 * in this process; one that arrived inside a decoded `Built` is simulated
 * again. Neither field is carried into `Signed` or the journal.
 */
export const Built = Schema.Struct({
  digest: Digest,
  bytes: Schema.Uint8ArrayFromBase64,
  sender: SuiAddress,
  /**
   * The address that pays for gas, present only when it is not the sender.
   * Read out of the bytes, so a gas owner a recipe set itself (`Tx.sponsored`
   * does) is recorded as well as one passed to `Tx.build`.
   */
  gasOwner: Schema.optionalKey(SuiAddress),
  expiration: Schema.optionalKey(TransactionExpiration),
  /** The chain identifier `Tx.build` was run against. See `SignedTransaction.chain`. */
  chain: Schema.optionalKey(Schema.String),
  /**
   * The gas data the bytes carry, with where the payment comes from.
   *
   * @since 0.5.0
   */
  gas: BuiltGas,
  /**
   * The build's own simulation of exactly these bytes, when it ran one.
   *
   * @since 0.5.0
   */
  simulation: Schema.optionalKey(Simulation)
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
