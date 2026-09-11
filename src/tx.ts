/**
 * `sui-effect/tx`: the transaction lifecycle.
 *
 * `Signer` is a value, not a service, because a process may hold two
 * credentials at once. `Tx` is a set of functions, not an object with state,
 * and every one of them has `R = Sui`. `SubmitConfig` and `Journal` are
 * `Context.Reference`s with working defaults, so the shortest correct program
 * is `Tx.run(recipe, { signer })` with no wiring at all.
 *
 * @since 0.1.0
 */

/** The credential value type and its five constructors. */
export {
  ephemeral,
  fromConfig,
  fromKeypair,
  fromSdkSigner,
  remote,
  type RemoteSigner,
  Signer,
  type SignatureScheme
} from "./services/Signer.ts"

/** The lifecycle settings, with the spec's defaults in force by default. */
export {
  type ExpirationPolicy,
  type ExpiryEvidencePolicy,
  SubmitConfig,
  type SubmitConfigService
} from "./services/SubmitConfig.ts"

/** The submission journal: an in-memory default, a durable one in `sui-effect/journal`. */
export { Journal, type JournalService } from "./services/Journal.ts"

/** The lifecycle as a serializable union, for what the journal holds. */
export { isUnresolved, JournalEntry, UNRESOLVED_TAGS } from "./domain/journal-entry.ts"

/** Build, sign, cosign, sponsor, submit, reconcile, run. */
export {
  build,
  cosign,
  type Built,
  type Reconciled,
  type ReconcileInput,
  type RunError,
  type SubmitError,
  reconcile,
  reconcileAll,
  run,
  sign,
  Signed,
  sponsored,
  submit,
  Tx
} from "./services/Tx.ts"

/** The expiration union and the bounds `Tx.reconcile` reasons about. */
export {
  chainOf,
  maxEpochOf,
  maxTimestampMsOf,
  Signature,
  TransactionExpiration
} from "./domain/schemas.ts"
