/**
 * `sui-effect/keystore`: secret keys sealed at rest.
 *
 * One record per account under a `KeyValueStore` key prefix, each sealed
 * under its password with PBKDF2-SHA256 and AES-256-GCM, the account's
 * address and metadata bound as additional data (DESIGN §19). `unlock` answers
 * a `LockableSigner`, the same value `Signer.fromMnemonic` and
 * `Signer.fromSecretKey` answer; `Signer.scoped` locks it when a scope closes.
 *
 * Separate from `sui-effect/tx` because it imports `effect/persistence`, and
 * because it needs WebCrypto (`crypto.subtle`, `crypto.getRandomValues`):
 * every browser, extension, Bun and Node has it; React Native needs a
 * polyfill, and without one every seal or open fails with
 * `KeystoreError { reason: "unavailable" }`.
 *
 * @example
 * ```ts
 * import { Effect, Layer, Redacted } from "effect"
 * import { KeyValueStore } from "effect/persistence"
 * import { Keystore } from "@unconfirmed/sui-effect/keystore"
 * import { Signer } from "@unconfirmed/sui-effect/tx"
 *
 * const layer = Keystore.layer().pipe(Layer.provide(KeyValueStore.layerMemory))
 *
 * const program = Effect.scoped(Effect.gen(function*() {
 *   const keystore = yield* Keystore
 *   const password = Redacted.make("correct horse battery staple")
 *   const { account, mnemonic } = yield* keystore.generate(password)
 *   const signer = yield* Signer.scoped(keystore.unlock(account.address, password))
 *   return signer.address
 * }))
 * ```
 *
 * @since 0.5.0
 */
export {
  DEFAULT_ITERATIONS,
  DEFAULT_PREFIX,
  Keystore,
  type KeystoreAccount,
  KEYSTORE_VERSION,
  type KeystoreOptions,
  type KeystoreService,
  MIN_LAYER_ITERATIONS,
  SealedKey
} from "./services/Keystore.ts"

/** The keystore's failure, and the key failure its imports can end in. */
export { KeyError, KeyErrorReason, KeystoreError, KeystoreErrorReason } from "./domain/keys.ts"

/** The signer `unlock` answers. */
export type { LockableSigner } from "./services/SignerKeys.ts"
