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
  fromConfig,
  fromKeypair,
  fromSdkSigner,
  remote,
  type RemoteSigner,
  Signer,
  type SignatureScheme
} from "./services/Signer.ts"

/** Keys the process holds: a checked mnemonic, an imported secret key, and the signer that can drop them. */
export {
  type FromMnemonicOptions,
  fromMnemonic,
  type FromSecretKeyOptions,
  fromSecretKey,
  type KeyScheme,
  type LockableSigner,
  type MnemonicLength
} from "./services/Signer.ts"

/** Signature verification: the Effect face of `@mysten/sui/verify`. */
export { Verify, type VerifyOptions } from "./services/Verify.ts"

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

/** The intent policy and its optional screen; `@unconfirmed/sui-effect/gate` provides Jev. */
export { Gate, type GateService, type ScreenRequest } from "./services/Gate.ts"

/** A declared intent, the record of having checked it, and the pure checks. */
export {
  checkClaims,
  type ClaimViolation,
  describeClaims,
  describeEffects,
  Intent,
  IntentAuthor,
  IntentClaims,
  OutflowClaim,
  type Parties,
  ScreenedLine,
  Screening,
  Verdict,
  Verified
} from "./domain/intent.ts"

/** Build, sign, cosign, attach, fromBytes, canonical recipe helpers, submit, verify, prepare, reconcile, resubmit, run, foldCoins, sendAll. */
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
  prepare,
  Reconciled,
  type ReconcileInput,
  type RunError,
  type SubmitError,
  recorded,
  reconcile,
  reconcileAll,
  resubmit,
  run,
  type SendAllResult,
  sendAll,
  sign,
  Signed,
  sponsored,
  submit,
  type SubmitViaError,
  type SubmitViaReply,
  submitVia,
  Tx,
  verify
} from "./services/Tx.ts"

/** Folding coins into the address balance, and sending into one. */
export {
  fold,
  type FoldBatch,
  type FoldGas,
  foldMovement,
  type FoldMovement,
  type FoldPlan,
  planFold,
  type SendAllSweep,
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

/** Account signers (0.5.0): zkLogin sessions and their store, passkeys, Wallet Standard wallets. */
export {
  type SecretSealer,
  ZkLogin,
  ZkLoginSession,
  ZkLoginSignatureInputs,
  type ZkLoginSignerOptions,
  ZkLoginStoredSession
} from "./services/ZkLoginSigner.ts"
export { type PasskeyProvider, type StandardWallet, type StandardWalletAccount } from "./services/AccountSigners.ts"

/** The sender's check on sponsored bytes a service assembled. */
export { verifySponsored } from "./services/Sponsored.ts"
