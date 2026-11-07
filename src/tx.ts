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

/** The credential value type and its constructors. */
export {
  ephemeral,
  fromKeypair,
  fromSdkSigner,
  remote,
  type RemoteSigner,
  Signer,
  type SignatureScheme
} from "./services/Signer.ts"

/** Keys the process holds: a checked mnemonic and an imported secret key. */
export {
  type FromMnemonicOptions,
  fromMnemonic,
  type FromSecretKeyOptions,
  fromSecretKey,
  type KeyScheme,
  type MnemonicLength
} from "./services/Signer.ts"

/** The proof a zkLogin signature carries (`Signer.zkLogin`). */
export { ZkLoginSignatureInputs, type ZkLoginSignerOptions } from "./services/ZkLoginSigner.ts"

/** Signature verification: the Effect face of `@mysten/sui/verify`. */
export {
  Verify,
  type VerifyOptions,
  type VerifyTransactionOptions,
  type VerifyTransactionSignature
} from "./services/Verify.ts"

/** Sui's address aliases (0.6.0): an address's alias set read from its object, the check, and the four recipes. */
export { AddressAlias, AddressAliases } from "./services/AddressAlias.ts"

/** The lifecycle settings, with the spec's defaults in force by default. */
export {
  type ExpirationPolicy,
  type ExpiryEvidencePolicy,
  type GasPaymentPolicy,
  type LockSenderPolicy,
  SubmitConfig,
  type SubmitConfigOverrides,
  type SubmitConfigService
} from "./services/SubmitConfig.ts"

/** The submission journal: an in-memory default, a durable one in `sui-effect/journal`. */
export { Journal, type JournalService } from "./services/Journal.ts"

/** The lifecycle as a serializable union, for what the journal holds. */
export { isUnresolved, JournalEntry, UNRESOLVED_TAGS } from "./domain/journal-entry.ts"

/** Build, sign, cosign, attach, fromBytes, canonical recipe helpers, submit, submitVia, reconcile, resubmit, run, foldCoins, the sender lock. */
export {
  attach,
  build,
  cosign,
  fromBytes,
  gaslessStablecoinTransfer,
  type Built,
  foldCoins,
  type FoldResult,
  type Prepared,
  Reconciled,
  type ReconcileInput,
  type RunError,
  type SubmitError,
  reconcile,
  reconcileAll,
  resubmit,
  run,
  sign,
  Signed,
  sponsored,
  submit,
  type SubmitViaError,
  type SubmitViaReply,
  submitVia,
  Tx,
  withSenderLock
} from "./services/Tx.ts"

/** Folding coins into the address balance, and sending into one. */
export {
  fold,
  type FoldBatch,
  type FoldGas,
  type FoldPlan,
  planFold,
  sendFunds
} from "./services/Fold.ts"

/** The expiration union and the bounds `Tx.reconcile` reasons about. */
export {
  chainOf,
  maxEpochOf,
  maxTimestampMsOf,
  Signature,
  TransactionExpiration
} from "./domain/schemas.ts"


/** The sender's check on sponsored bytes a service assembled. */
export { verifySponsored } from "./services/Sponsored.ts"
