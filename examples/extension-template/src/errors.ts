/**
 * The extension's own failures.
 *
 * Two rules from the authoring guide are visible here. Every error is a
 * `Schema.TaggedError`, so it serializes into a log line, an RPC response or a
 * journal entry the same way sui-effect's own errors do. And every one of them
 * declares an `outcome`, which is the axis a wrapper script acts on:
 * `SuiError.outcome` and `Script.exitCode` read that field, and an extension
 * error that does not declare one is "unclassified" and exits 1.
 *
 * The tags are prefixed with the package name because `EscrowNotFound` is a
 * name two packages could plausibly both want.
 *
 * And every one of them has a real `.message`. `Schema.TaggedError` leaves it
 * empty, so an error that supplies neither an `override get message()` nor a
 * `message` schema field surfaces an empty string everywhere a consumer
 * catches it, and `SuiError.toJson` emits no `message` key at all. The getter
 * is the usual answer — it stays out of the encoding, so it costs nothing at
 * the constructor — and a `message` schema field is for the case where the
 * sentence comes from somewhere else, as `EscrowSettlementUnknown`'s does.
 */
import { Schema } from "effect"
import { Digest, type Outcome, ObjectId } from "@unconfirmed/sui-effect"

/**
 * No escrow object with this id, or it is not an escrow at all.
 *
 * Nothing was submitted, so the outcome is `not_applied` and a wrapper may
 * retry with a different id.
 */
export class EscrowNotFound extends Schema.TaggedError<EscrowNotFound>()(
  "escrow/EscrowNotFound",
  { escrowId: ObjectId }
) {
  readonly outcome: Outcome = "not_applied"

  /**
   * `Schema.TaggedError` leaves `.message` empty, so anything surfacing
   * `error.message` — a log line, a `catch` in a consumer's UI,
   * `SuiError.toJson` — shows nothing unless the class supplies one. This is
   * the idiom sui-effect's own errors use, and the reason every error here has
   * one: define a getter over the fields, never a `message` schema field you
   * then have to pass to every constructor.
   */
  override get message(): string {
    return `no escrow ${this.escrowId}`
  }
}

/**
 * The claim is on chain, but the operator's settlement service never confirmed
 * it, so the escrow's off-chain state and its on-chain state may disagree.
 *
 * This is the case the `outcome` field exists for: the transaction applied, the
 * operation as a whole did not finish, and the only safe next step is to
 * reconcile rather than to retry. A script that fails with this exits 3.
 *
 * Its `message` is a **schema field** rather than a getter, because the
 * sentence comes from the settlement service rather than from these fields.
 * Either way `.message` is a real string and `SuiError.toJson` carries it.
 */
export class EscrowSettlementUnknown extends Schema.TaggedError<EscrowSettlementUnknown>()(
  "escrow/EscrowSettlementUnknown",
  { escrowId: ObjectId, digest: Digest, message: Schema.String }
) {
  readonly outcome: Outcome = "unknown"
}

/**
 * This release bundles no deployment for the network the client is on.
 *
 * The typed failure of `Escrow.layerBundled`: a layer that picks its package id
 * from `sui.network` has exactly one way to fail, and a caller that can run on
 * an unknown network wants to see it in the type rather than in a log line.
 *
 * Nothing was submitted — nothing was even built — so the outcome is
 * `not_applied`. A predecessor library's `DeploymentError` becomes this: your
 * own tag, prefixed with your package name, declaring its outcome.
 */
export class EscrowUnsupportedNetwork extends Schema.TaggedError<EscrowUnsupportedNetwork>()(
  "escrow/EscrowUnsupportedNetwork",
  { network: Schema.String }
) {
  readonly outcome: Outcome = "not_applied"

  /** See {@link EscrowNotFound.message}: a getter, not a schema field. */
  override get message(): string {
    return `this release bundles no escrow deployment for ${this.network}`
  }
}
