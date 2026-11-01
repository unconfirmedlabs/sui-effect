# Changelog

All notable changes to `@unconfirmed/sui-effect`. The format is one line per
change, newest release first.

## 0.5.0

The wallet core: a transaction can declare what it is for and is refused when
it does more (intents, an optional screen); every flow is prepare → verify →
approve → sign, with `Tx.prepare` for a preview and `Tx.run({ approve })` for a
person's yes; the accounts a wallet signs with — zkLogin and Enoki, passkeys,
Wallet Standard wallets, recovery phrases and imported keys — are `Signer`
values; keys rest sealed in a keystore; the journal and the keystore run over
IndexedDB, React Native storage and `chrome.storage`; and an address's history
includes what it received. No peer dependency changes: `effect` stays
`>=4.1.1 <4.2`, `@mysten/sui` `^2.28` (CI still proves 2.30.0 and 2.38.0).
New direct dependencies `@scure/bip39` and `@scure/bip32`, both `^2.3.0` (the
range every `@mysten/sui` from 2.28 to 2.38 declares, so one copy resolves).
New subpaths `/gate`, `/enoki`, `/keystore` and `/storage`. Six changes break
code or stored data; read "Migrating from 0.4.x" first.

### Changed (breaking)

- **`Simulation` is a `Schema.Class`**, with the fields it had as a
  `Schema.Struct` and `Executed`'s accessors (below). An object literal no
  longer typechecks as a `Simulation`, so a hand-built one — a test's
  `preflight` input, a fixture — breaks; a spread (`{ ...simulation }`) loses
  the methods. Decoding with the schema answers an instance. Why: a preview and
  the receipt it predicts read their effects through one implementation, so
  they cannot disagree about what "created" or "transferred" means.
- **`Built.gas` is required** (`{ budget, price, owner, payment, source }`,
  read back out of the bytes by `Tx.build` and `Tx.fromBytes`). A hand-built
  `Built`, or one decoded with the `Built` schema from JSON a 0.4.0 process
  wrote, fails to typecheck or decode. Why: the fee line of a preview and the
  intent's gas netting need it, and the bytes always carry it. `Built` and
  `Simulation` moved out of `src/domain/schemas.ts` (to `domain/built.ts` and
  `domain/executed.ts`); the package root exports both as before, so only a
  deep import into `dist/domain/schemas.js` breaks.
- **`Balance.balance`, `Balance.coinBalance`, `Balance.addressBalance` and
  `Coin.balance` are `CoinAmount`** (a plain `bigint` in the coin's own
  smallest unit), not `Mist`. They were branded `Mist` for every coin type,
  which claimed a USDC amount was MIST. Code that passes one where a `Mist` is
  required stops compiling.
- **effect/cli's `CliError` exits 2** under `Script.exitCode`, `Script.report`
  and `Script.run` (it was unclassified, exit 1): a parse error is 2, `--help`
  with no errors is 0, and a `UserError` exits as its `cause` would.
  `Script.report` prints no failure line for a `CliError` (effect/cli already
  printed one). A wrapper that remapped CLI exit codes itself now sees them
  remapped twice.
- **The durable journal writes a `settled:<digest>` marker** beside every
  terminal entry, and `listUnresolved` reads only entries without one: one
  `keys` and one read per unresolved entry, instead of reading and decoding
  every entry ever settled (on IndexedDB or `chrome.storage`, one transaction or
  one call per entry). A store 0.4 wrote needs no migration: its first listing
  is the 0.4 scan and marks what it finds settled; `pruneSettled` removes the
  markers with their entries. What breaks: code that reads the store's raw keys
  sees `settled:` keys beside `entry:` keys, and **a 0.4 writer beside a 0.5
  one** can hide an entry — a 0.4 process that writes an unresolved entry over
  a digest 0.5 had settled (the same bytes submitted again) leaves the marker,
  and `listUnresolved` skips it (`get` still finds it). Rolling back to 0.4 is
  safe for 0.4 (it reads only `entry:` keys); **rolling forward again after 0.4
  wrote** hides such an entry the same way, so delete the `settled:` keys first.
  Two contexts over one store (a tab's `Tx.reconcileAll` beside another's
  submission) can hide an entry only if the settling one dies between its
  marker write and its re-read (DESIGN §8).
- **A visibility wait that times out logs at debug, not warning** (wallet
  finding 6). Effect's default logger writes to stdout at minimum level `Info`,
  so the warning landed in the middle of a `--json` CLI's output on a run whose
  outcome stood. The miss is still the `Tx.awaitVisible` span's new
  `sui.visibility` attribute and the visibility-wait metric's `result`. A
  program that relied on seeing the line at the default level no longer does.

### Added

- **Declared intents.** `Intent` (one sentence, `author: "user" | "task" |
  "dapp"`, and exact claims: outflows per coin type, recipients, objects),
  `Tx.verify(built, intent)` answering a branded `Verified`, and `Tx.run({
  intent })`. The claims are checked against the simulated effects in code, deny
  by default; gas is never an outflow, whether a gas coin, a coin reservation or
  the address balance paid it, while an address-balance withdrawal sent to
  someone is one. Every refusal is `PolicyDenied` with a rule
  (`intent.invalid`, `intent.outflow`, `intent.recipient`, `intent.object`,
  `intent.required`, `gate.unavailable`, `intent.injection`, `intent.vague`,
  `intent.effect`, `intent.claim`). The checks are pure and exported:
  `checkClaims`, `describeEffects`, `describeClaims`, and
  `Intent.fromSimulation(simulation, parties, { summary, author })`, the exact
  claims a simulation implies (how a wallet shows a dapp's bytes, then holds
  them to it). DESIGN §17.
- **`Gate`**, a `Context.Reference`: an optional `screen`, the thresholds that
  turn its probabilities into refusals, `requireIntent` (a `Tx.run` or
  `Enoki.run` that declares nothing is refused before the recipe is applied)
  and `onUnavailable` (`"deny"` by default). `Gate.with` merges over the gate in
  force. `Tx.sendAll` passes its `intent` through. `Tx.foldCoins` takes an
  `intent?`; without one, under `requireIntent` each batch declares the fold's
  own claim-free intent (the coins go into the owner's own balance), so any
  batch whose simulation moves value out of the account is refused, and with no
  gate a fold checks no intent and costs no extra simulate. **`@unconfirmed/sui-effect/gate`**: the Jev screen (`layerJev`,
  `layerJevConfig` over `TYPESAFE_API_KEY`, `TYPESAFE_MODEL`,
  `TYPESAFE_BASE_URL`, and `makeJev`) over `effect/http`'s `HttpClient`.
- **`Tx.prepare(input, { sender, gasOwner?, intent?, maxEpoch? })`**: `Tx.run`'s
  front half without the signature — build (a `Built`, e.g. from
  `Tx.fromBytes`, is not rebuilt; its sender must be `sender`, else
  `PolicyDenied { rule: "prepare.sender" }`, and `prepare.gasOwner` likewise),
  one simulate of exactly the bytes, `preflight`, the intent — answering
  `Prepared { built, simulation, verified? }`. No lock, and `Gate.requireIntent`
  does not bind it.
- **`Tx.run({ approve })`**: `approve(prepared): Effect<void, E>` runs after
  `preflight` and the intent and before the first signature, under the sender
  lock exactly when signing is (only when the bytes pin something). Refusing is
  failing with the caller's own error, which `Tx.run`'s union carries as `E`:
  nothing signed, nothing journalled. One simulate serves preflight, the intent
  and approval, and it is the build's own when the build simulated exactly
  these bytes.
- **`Built.gas`** (`BuiltGas`, `GasPaymentRef`, `GasPaymentSource`: budget,
  price, payer, payment refs and `source` — `"addressBalance"`,
  `"coinReservation"` or `"coins"`) and **`Built.simulation`**, present only
  when `Tx.build` simulated exactly the returned bytes (never on gRPC). Neither
  reaches `Signed` or the journal.
- **`Simulation` has `Executed`'s accessors** (`created`, `createdWhere`,
  `mutated`, `deleted`, `wrapped`, `packagesPublished`, `balanceChange`,
  `gasUsedTotal`, `expectCreated`, `eventsOf`, `expectEvent`,
  `expectPublished`), one implementation for both, skipping accumulator writes;
  and both gain **`transferred(type?)`** (`TransferredRef`: objects whose owner
  changed by kind or party, `inputOwner` beside `owner`).
- **`Executed.sender`**, from the bytes on `Tx.submit`, `submitVia`,
  `resubmit`, `reconcile` (given the bytes) and `run`, and from the
  transaction's BCS on `Sui.getTransaction` and the transaction streams.
- **Session bounds.** `Signer.maxEpoch?` (a credential that expires), and
  `Tx.build({ maxEpoch })`, which caps the default window at `min(epoch + 1,
  maxEpoch)` and refuses a bound already past before anything resolves.
  `Tx.run` passes the earlier of the signer's and the sponsor's. `SigningError`
  gains `reason?: "expired" | "locked" | "rejected" | "unavailable"`
  (`SigningFailureReason`, exported from the root).
- **Account signers** (on `/tx`; DESIGN §18): `Signer.zkLogin({ session,
  ephemeral })` (scheme `ZkLogin`, `maxEpoch` set, `SigningError { reason:
  "expired" }` past `expiresAt` or for bytes that start after `maxEpoch`);
  `ZkLogin.save`/`load`/`remove` over a `KeyValueStore`, the ephemeral seed
  written only through a caller's `SecretSealer`, address-bound
  (`ZkLoginSession`, `ZkLoginSignatureInputs`, `ZkLoginStoredSession`);
  `Signer.passkey` and `Signer.createPasskey` over the SDK's `PasskeyKeypair`,
  imported on demand (a cancelled prompt is `reason: "rejected"`);
  `Signer.wallet({ wallet, account, chain })` over a Wallet Standard wallet's
  `sui:signTransaction` 2.0.0 (with the `AbortSignal`; `sui:signTransactionBlock`
  as a fallback) and `sui:signPersonalMessage`, which refuses a wallet that
  answers different bytes and verifies the signature locally. Every Wallet
  Standard, WebAuthn and Enoki type is structural.
- **`verifySponsored(built, { sender, gasOwner?, transactionKind? })`**, flat on
  `/tx` and as `Tx.verifySponsored`: the sender's check on sponsored bytes a
  service assembled — sender, a distinct gas owner, the transaction kind byte
  for byte (`PolicyDenied`, rules `sponsored.*`).
- **`@unconfirmed/sui-effect/enoki`**: `Enoki.fromFlow`, `Enoki.fromWallet`,
  `Enoki.sponsor` (kind bytes → `createSponsoredTransaction` → `Tx.fromBytes` →
  digest check → `verifySponsored`), `Enoki.execute` (`Tx.submitVia` over
  `executeSponsoredTransaction`, so a sponsored submission is journalled and
  reconcilable) and `Enoki.run(client, recipe, { signer, intent?, approve?,
  onSigned? })`, the whole sponsor → prepare → approve → sign → execute under
  `Tx.run`'s lock rule. `EnokiError` declares `outcome` from `refused`.
  `@mysten/enoki` is not a dependency: the client and flow are structural.
- **Keys the process holds** (on `/tx`; DESIGN §19): `Signer.fromMnemonic(phrase,
  { scheme?, account?, path? })`, which checks the BIP-39 word list and checksum
  before deriving (the SDK's `deriveKeypair` checks neither), on the standard
  Sui paths (`Signer.derivationPath`); `Signer.fromSecretKey` (`suiprivkey1…`,
  hex or bytes, copied); `Signer.generateMnemonic` (`crypto.getRandomValues`);
  `Signer.scoped`; `LockableSigner` (`lock`, one-way, then `SigningError {
  reason: "locked" }`; `locked`); `KeyError` (root export; declared
  `not_applied`; `Script.exitCode` 2; names a bad word's position, never the
  word).
- **`@unconfirmed/sui-effect/keystore`**: `Keystore` (`layer`, `layerTest`,
  `make`) — `list`, `account`, `generate`, `importMnemonic`, `importSecretKey`,
  `unlock`, `remove`, `changePassword`, `exportMnemonic`, `exportSecretKey` —
  sealing one `SealedKey` record (version 1) per address over `KeyValueStore`:
  PBKDF2-SHA256 at 600 000 iterations, AES-256-GCM, the address, scheme, source
  and path as AAD, and a key-check value that tells a wrong password from an
  edited record. `KeystoreError` (declared `not_applied`; `Script.exitCode` 2 for
  every reason but `"storage"`, which exits 4). `Keystore.sealer(
  password, { iterations? })` (also flat as `sealer`) is the `SecretSealer` for
  `ZkLogin.save`/`load` in the same format (`SealedSecret`). Needs WebCrypto.
- **`@unconfirmed/sui-effect/storage`**: `layerIndexedDb`, `layerAsyncStorage`,
  `layerMmkv` and `layerChromeStorage`, each a `Layer<KeyValueStore>` over a
  structural platform object (no DOM, React Native or `chrome` types, no
  dependency), failing per operation with `KeyValueStoreError`. DESIGN §20.
- **`Tx.sendAll({ signer, recipient, coinType?, intent?, approve?, onSigned?
  })`** sweeps every coin and the whole address balance of one type into the
  recipient's balance and leaves the sender 0 of it; for SUI the gas is paid
  out of the sweep. Answers `SendAllResult { sweep, executed, received }`
  (`SendAllSweep`).
- **`Tx.foldCoins({ plan, approve })`** runs a previewed `FoldPlan` as given and
  asks `approve(prepared, batch)` per batch; **`Tx.foldMovement(batch,
  simulationOrExecuted)`** (`FoldMovement`) is what a fold moves from coins into
  the balance, which its netted balance changes hide.
- **`{ affectedAddress }`** (`AffectedAddressFilter`) on
  `Sui.streamTransactions`, `streamTransactionPages`, `tailTransactions` and
  `tailTransactionPages`: the gRPC ledger's predicate, so a history includes
  transfers **to** the address. Another transport fails it with a
  non-retryable `TransportError { status: "UNIMPLEMENTED" }`.
- `Script.layerStderrLogger()`, the logger `Script.run` installs, for a CLI
  that owns its process; `ReportOptions.applied`, so `Script.report` answers 5
  after an applied transaction the way `Script.run` does.
- `CoinType.Strict`, for a coin type a person typed; `CoinAmount`.
- Testing: `TestServices` (`Sui | SuiCore | SuiCoreFake`); `FakeObject.json` /
  `.display`, served only when the include set asks; `FakeChange.inputOwner`;
  the fake answers a transaction `bcs` include (the bytes it executed, or a
  minimal transaction naming a scripted `sender`); a scripted `FakeScript.ledger`
  also serves the `affectedAddress` listing.
- The `sui.visibility` span attribute on `Tx.awaitVisible` (`"visible"`,
  `"timeout"`, `"failed"`).

### Changed

- `Sui.getTransaction` and the transaction streams ask for `bcs` beside the
  execute include set, to read the sender (+776 bytes for a `send_funds` on
  localnet; `transaction: true` would cost +2,184 and makes the SDK's gRPC parse
  throw on non-programmable transactions). `SuiCore`'s include types are
  unchanged.
- `Tx.run` and `Enoki.run` refuse a signer or sponsor whose `locked` answers
  `true` with `SigningError { reason: "locked" }` before building, so a locked
  account costs no read and no simulate.
- `checkClaims`, `describeEffects` and `Intent.fromSimulation` accept any value
  with a simulation's fields.
- `Signer.fromConfig` builds Ed25519, Secp256k1 and Secp256r1 keys over a copy
  and zeroes the bytes it decoded.
- `SuiError.describe` prints a `SigningError`'s reason (`SigningError
  (expired) …`).
- The fake: an unscripted `simulate` after a build answers from `buildSimulate`
  when that is scripted; with neither it still dies, now naming
  `SuiTest.scriptSimulate`.
- `LLMS.md`'s export index names the namespace a bare export also lives on.

### Fixed

- Secp256k1 and Secp256r1 signers no longer alias the caller's or the
  decoder's buffer (the SDK's ECDSA keypairs keep a reference to the bytes they
  are built from).
- A program's stdout stays clean under Effect's default logger when a
  visibility wait times out (above).
- Documentation: the default logger writes to stdout; Display v1 renders `null`
  on gRPC (`display_registry::migrate_v1_to_v2`, then `display_registry::share`);
  a localnet prunes within a few dozen checkpoints; how two journal layers share
  one memory `KeyValueStore`.

### Testing

New localnet files, behind `SUI_LOCALNET=1`:

- `test/live.localnet-wallet.test.ts` proves that a validator accepts the
  signatures of `Signer.fromMnemonic` (Ed25519, Secp256k1, Secp256r1; a phrase
  one word off is refused before anything is built), a keystore account
  (import, a 600 000-iteration unlock, run, lock, then a refused run with
  nothing sent), `Signer.passkey` over a software P-256 authenticator and
  `Signer.wallet` over a keypair-backed Wallet Standard wallet (and that a
  wallet answering rebuilt bytes is refused before any send); a sponsored
  transaction from a sender holding no SUI, both through a sponsor backend's
  bytes (`verifySponsored` → `prepare` → `approve` → sign → `attach` →
  `submit`) and through `Tx.run` with a `Signer.remote` sponsor; tampered
  sponsor bytes refused with `PolicyDenied` before signing; a dapp's bytes
  through `Intent.fromSimulation` and `Tx.verify`, and an unclaimed recipient
  refused; the durable journal over the IndexedDB stand-in, a crashed `Signed`
  entry reconciling to `Executed`; and a zkLogin session bound capping the
  window (`maxEpoch` equal to the current epoch builds bytes the node
  simulates; below it is `expired` before the build).
- `test/live.localnet-intent.test.ts`: address-balance gas is not an outflow
  while a withdrawal is (and its receiver a recipient), and `Tx.run({ intent })`
  executes inside its claims and refuses one tighter.
- `test/live.localnet.test.ts` gains `streamTransactions({ affectedAddress })`
  finding an incoming transfer, `Tx.run({ intent, approve })` on
  address-balance gas with one simulate, `Tx.prepare` → `Tx.sign` →
  `Tx.submit` (and for bytes handed over), a previewed fold, and `Tx.sendAll`
  leaving 0 for SUI in coins, in a balance and in both, and for a second coin
  type.
- `test/live.jev.test.ts`, behind `TYPESAFE_LIVE=1` and `TYPESAFE_API_KEY`,
  holds the Jev screen to its default thresholds.

**Not proven**: a zkLogin signature accepted on chain (that needs a prover and
the issuer's keys; signatures are checked structurally and against a fake
chain); a real browser, React Native runtime or extension (the storage adapters
run on in-memory stand-ins, `test/storage-fakes.ts`); a real WebAuthn
authenticator or Wallet Standard extension; the Enoki API (its shapes are
`@mysten/enoki` 1.3.2's, checked for assignability, and its HTTP status
semantics are undocumented); and Jev in `bun run check` (the live file is
opt-in).

### Migrating from 0.4.x

1. A hand-built `Simulation` becomes `new Simulation({ ... })` (same fields), or
   decode one with `Schema.decodeUnknownEffect(Simulation)`. Replace spreads of
   a simulation with the instance itself.
2. Stop writing `Built` by hand: get one from `Tx.build`, `Tx.prepare` or, for
   bytes you hold, `Tx.fromBytes(bytes)`, which fills `gas`. A `Built` stored
   as JSON by 0.4.0 does not decode: keep the bytes and `Tx.fromBytes` them.
   Import `Built` and `Simulation` from the package root, never from
   `dist/domain/schemas.js`.
3. Where a `Balance` or `Coin` amount must be a `Mist` (it is SUI), wrap it:
   `Mist.make(balance.balance)`. Other coin types' amounts were never MIST; drop
   any cast that pretended otherwise.
4. Wrapper scripts and CLIs on effect/cli: a parse error now exits 2 and
   `--help` 0; delete any remapping of `CliError` to those codes, and expect no
   failure line from `Script.report` for it.
5. Durable journals need no migration. Stop every 0.4 writer before a 0.5
   process writes the same store (or drain it with `Tx.reconcileAll()` and keep
   0.4 read-only); code that lists the store's raw keys filters on the
   `entry:` prefix. Rolling back to 0.4 needs nothing; rolling forward again
   after 0.4 wrote to the store needs its `settled:` keys deleted first.
6. A program that wants the visibility-timeout line sets
   `References.MinimumLogLevel` to `Debug`, or reads the `sui.visibility` span
   attribute or the `sui_effect_tx_visibility_wait` metric's `result`.
7. Matchers on `SuiError.describe` text for a `SigningError` that carries a
   reason see `SigningError (expired)` and the like: branch on `reason`.
8. An extension package built from `examples/extension-template` moves its
   `@unconfirmed/sui-effect` peer range to `">=0.5.0 <0.6.0"`.

## 0.4.0

Effect 4.1 and `@mysten/sui` 2.38, gas from the address balance by default
with a sender lock that no longer serializes what pins nothing, coin folding, a
lifecycle that settles refusals in the journal, a journal with no index, and the `Sui` reads the SDK had and this
package did not. Several signatures and one stored shape change; read
"Migrating from 0.3.x" first.

### Changed (breaking)

- **The `effect` peer dependency is now `>=4.1.1 <4.2`.** 4.1.1 is the floor
  because effect 4.1 made `KeyValueStore.keys` part of every store, and the
  durable journal now lists through it (below). `@effect/platform-bun` (a
  devDependency) moves to `4.1.1` with it, `@effect/language-service` to
  `0.87.5`. 0.3.x remains the line for effect 4.0.x.
- **`@mysten/sui` is developed against 2.38.0** (CI proves 2.30.0 and 2.38.0);
  the peer stays `^2.28`. `@mysten/bcs` moves to `2.1.3`, peer `^2.1.3`.
- **`SignatureScheme` is the SDK's own type, re-exported**, so it is exactly as
  wide as the installed SDK and gains `"MLDSA65"` from `@mysten/sui` 2.36. A
  consumer that `switch`es over it exhaustively with `satisfies never` stops
  compiling on 2.36+ until it handles the new member.
- **`Simulation` gains `gasPaymentMocked: boolean`**: `true` when the node
  simulated with a mocked gas coin because the transaction had no gas payment.
  It is the SDK's field (2.35+) when present and derived from
  `effects.gasObject` the way the SDK derives it otherwise, so every SDK in the
  peer range decodes. Code that builds a `Simulation` by hand must add it.
- **`Tx.reconcile` and `Tx.reconcileAll` no longer declare `TransportError`.**
  They never produced it: every recovery read failure already became
  `SubmissionUnknown`. Remove any `catchTag("TransportError", …)` on them.
- **The durable journal (`/journal`) keeps no `index` key and no put lock.**
  `put` is one `set`; `listUnresolved` lists through `KeyValueStore.keys`,
  oldest first by `signedAt`/`at`. **A custom `KeyValueStore` must implement
  `keys`** (effect 4.1 requires it of every store anyway). Listing now reads
  and decodes **every** entry under the prefix, settled ones included, so one
  undecodable entry fails the layer build, `Tx.reconcileAll` and
  `pruneSettled` with `JournalError` (0.3 decoded only the entries its index
  named). A 0.3 store reads with no migration; its `index` key is ignored,
  left in place and no longer maintained, so **rolling back to 0.3 is not
  safe as is**: 0.3 lists only through that index, and a `Signed` or
  `Unknown` entry 0.4 wrote is invisible to a 0.3 `listUnresolved`,
  `Tx.reconcileAll` and `onUnresolved: "fail"` (only `Tx.recorded(digest)`
  finds it). Drain the store with `Tx.reconcileAll()` on 0.4 before rolling
  back, and while 0.3 and 0.4 processes share it.
- **Removed**: `Sui.getObjectsOrFail` (use `getObjectsStrict`, the same
  function), the `ReconciledOutcome` type (use `Reconciled`), and the
  `dispose` alias on `SuiExtension.fromService` faces (use `$dispose()`; a
  service member may now itself be called `dispose`).
- **A refused submission is journalled as terminal.** A gRPC `INVALID_ARGUMENT`
  on the first send, or a `Tx.submitVia` sender error that declares
  `outcome: "not_applied"`, now settles the `Signed` entry as
  `NotApplied { evidence: "refused" }` (a new `NotAppliedEvidence` value)
  instead of leaving it unresolved. **A 0.3 reader cannot decode such an
  entry**: delete them (by hand, or `pruneSettled` with a later cutoff) before a 0.3
  process reads the store, besides draining it (above).
- **A gRPC `INVALID_ARGUMENT` escapes `Tx.submit` as `TransportError` only on
  the first send.** After a timeout or a retryable failure the earlier send may
  have landed, so a later refusal reconciles like any other ambiguous failure
  (usually `SubmissionUnknown`).
- **The fake's resolver mirrors the SDK's core resolver**: its budget simulate
  runs only when the recipe left the budget unset. A test that presets a
  budget now sees `Tx.build`'s explicit simulate (no `resolver: true`) instead
  of a resolver one; call-count assertions on `simulateTransaction` may move.
- **`Tx.build` reports the `maxGasBudget` ceiling as `PolicyDenied { rule:
  "maxGasBudget" }`** with a readable message (it was a `BuildError` whose cause
  was a bare bigint). `Tx.build`'s union gains `PolicyDenied`.
- **`Tx.build` refuses an address-balance gas payment the payer cannot cover.**
  With an empty gas payment (`Tx.sponsored`), one `getBalance` read checks the
  payer's SUI address balance against the budget and fails with `BuildError`
  before anything is signed (it used to sign bytes the validator then refused
  with "Insufficient address balance"). Fake-based tests of sponsored builds
  must script a balance with an `addressBalance`.
- **Resolver refusals are `BuildError`**, with the node's message: gRPC
  `INVALID_ARGUMENT` and `FAILED_PRECONDITION` (an input owned by another
  address, a function that does not exist, gas selection with no coin) and the
  SDK resolver's own errors ("Insufficient balance"), where they used to be a
  `TransportError { method: "use" }`. A remaining `TransportError` from
  `Tx.build` is named `"Tx.build"`.
- **`SubmitConfig.with` merges over the config in force**; it used to spread
  over the defaults, so an inner `with` silently reset an outer one.
  `SubmitConfig.layer` still spreads over the defaults.
- **The Promise face maps `Effect<Option<A>>` to `Promise<A | undefined>`**
  (`FaceValue`, exported from `/extension`). `Stream` items are not unwrapped.
- **A cold face call is a callable `Proxy` over its Promise.** `typeof` is
  `"function"`; `instanceof Promise`, `await` and iteration are unchanged; a cold
  recipe builder's result throws `ExtensionNotReady` (naming the member) when
  applied. In `bun:test` write `expect(Promise.resolve(cold)).rejects`.
- **`SuiAddress` / `ObjectId` decoding refuses `""`, a bare `"0x"`, an
  upper-case `"0X"` prefix and non-hex**; the first two used to decode to the
  zero address and `0X…` to the id. `SuiAddress.normalize` and
  `ObjectId.normalize` run the same decode, so they now **throw** a
  `SchemaError` on those inputs, where 0.3 returned the zero address or
  accepted the `0X` spelling.
- **Exit codes changed, and they are the wrapper contract.** Under
  `Script.run`, once this run applied a transaction (`Executed` or `Failed` for
  bytes it signed) and left nothing unresolved, a failure that would exit 2, 4
  or 130 exits **5**. While an entry of this run is unresolved, **any** would-be
  2, 4 or 130 exits **3**; 0.3 rewrote only a timeout or an interrupt, so a
  not-applied error such as `ObjectNotFound` exited 4. An error that declares
  an integer `exitCode` (1–255), as a plain field or as Effect's
  `[Runtime.errorExitCode]`, now exits with it (after `ConfigError`, before
  `outcome`), so an error that already carried such a field changes code.
  `Script.exitCode` and `Script.report` apply the same rules to the counts they
  are given (`report` has no applied count, so it never answers 5 for one).
- **`Script.run` reads `SUI_LOG_LEVEL`**, which 0.3 ignored, through
  `Config.LogLevel`, and that is case-sensitive: `Debug` works, while `debug`
  is a `ConfigError` and the script exits 2 before its program runs.
- **Every `SuiCore` layer bounds each read attempt at 30 seconds** (the new
  `requestTimeout` default, under "Added"). A read that used to wait as long as
  the node took now fails at 30 s with a retryable `TransportError { status:
  "DEADLINE_EXCEEDED" }` and is retried on the read policy, so a slow but
  answering read can now fail. Execute, `signAndExecuteTransaction`,
  `waitForTransaction` and `use` are not bounded.
- **Interfaces gained required members.** `SuiService` gained fourteen
  (`streamEvents`, `streamEventPages`, `streamTransactions`,
  `streamTransactionPages`, `tailEvents`, `tailEventPages`, `tailTransactions`,
  `tailTransactionPages`, `streamCoins`, `streamBalances`,
  `getCoinMetadataOption`, `getDynamicObjectFieldOption`,
  `resolveNameServiceAddressOption`, `defaultNameServiceNameOption`),
  `SuiCoreService` gained `getServiceInfo` and `ExtensionFace` gained
  `$reconcileAll`. A hand-written implementation of one of them that does not
  spread a real one stops compiling.
- **SDK caller-argument errors are defects**, not `TransportError`: a malformed
  filter, an unpaginable function filter, `after` with `before`. The stream and
  tail transaction readers refuse a `pkg` or `pkg::module` function filter up
  front (the SDK cannot page past its first page).
- **`SuiError.describe` text changed** (matchers on it break; branch on `_tag`):
  an `Unknown` reason prints the node's sentence (`SimulationFailed
  InsufficientCoinBalance in command 0`); a clever abort prints
  `CONST "value" (line N) code E` without the packed abort code, identically for
  `SimulationFailed` and `ExecutionFailed`; `BuildError`, `SigningError` and
  `JournalError` append their cause's line; `DecodeError` kind `"type"` reads
  `object X is T1, expected T2`; a `ConfigError` reads `missing NAME`. Always one
  line, never bytes.
- **Testing**: `fakeDigest` returns a `Digest`; `layerTest` re-sends with no
  delay (`testSubmitConfig`); an execute outcome scripted with a digest other
  than the bytes' own stops the test with a defect; the fake's `getDynamicField`
  compares key types under `typeMatches`; `FakeExecution.events[].json` is
  optional.
- **`SubmitConfig.lockSender` is a `LockSenderPolicy`** (`"whenPinned" |
  "always" | "never"`), not a boolean: `SubmitConfigService.lockSender` and
  `SubmitConfig.defaults.lockSender` change type. Overrides
  (`SubmitConfigOverrides`, `SubmitConfig.with`, `SubmitConfig.layer`, a
  Promise face's `submit`) still accept a boolean: `true` is `"always"`,
  `false` is `"never"`.
- **The sender lock defaults to `"whenPinned"`.** `Tx.run` holds it for every
  build, and through signing, `onSigned` and submission only when the built
  bytes pin an owned or receiving input or carry a gas payment ref (a gas coin,
  or the coin reservation a `tx.gas` user paying from a balance gets: it
  reserves the payer's whole balance as of the build, so such a run also waits,
  under the lock, for the lock-free runs in flight on its payer before it
  builds). Address-balance runs
  from one sender are no longer serialized through submission (on localnet ten
  `Tx.sendFunds` runs took 1,044 ms against 8,069 ms under `"always"`), and a
  sponsored run with no owned input holds no lock past its build. Lock-free
  runs can together overdraw a balance, gas budgets counted in full: a
  shortfall already there at submission is a node refusal (`INVALID_ARGUMENT`,
  journaled `NotApplied { evidence: "refused" }`), one that arises in flight
  executes the overdrawing run as `ExecutionFailed`
  (`InsufficientFundsForWithdraw`, no gas charged).
- **The explicit-empty-payment check counts withdrawals and expirations.** An
  explicit empty gas payment (`Tx.sponsored`, `gasPayment:
  "requireAddressBalance"`) now needs the payer's SUI address balance to cover
  the budget **plus** the SUI the bytes withdraw from it, and empty-payment
  bytes with no owned input need a `ValidDuring`/`Validity` expiration (a node
  refuses them otherwise); either miss is a `BuildError` before signing.
  `Tx.build` no longer re-reads the balance when the resolver itself chose an
  empty payment.
- **Address-balance bytes that use `tx.gas` are a `BuildError`.** With an
  empty payment the gas coin is empty: such bytes used to build (the node
  mocks a gas coin to simulate) and then fail on chain, charging gas
  (`InsufficientCoinBalance in command 0`, verified on localnet). Under
  `requireAddressBalance`, when an SDK intent (`tx.coin` / `tx.balance` for
  SUI) fell back to splitting `tx.gas` because the balance did not cover the
  amount, the message names `Tx.foldCoins`.
- **Testing: the fake's resolver pays from a scripted address balance** when it
  covers the budget plus withdrawals and the PTB does not use `tx.gas`, as the
  SDK's does, so a test that scripted an owner-less balance alongside coins now
  builds with `payment: []`. Executions move balances (gas, withdrawals,
  `send_funds` deposits, consumed coins deleted). A payer with neither coins nor
  a balance fails the build with `BuildError` ("No valid gas coins found for the
  transaction.") instead of building with an empty payment.

### Added

- **`Tx.build` simulates on every transport.** The gRPC resolver simulates
  whenever it runs, but the core resolver every other transport uses
  (JSON-RPC, GraphQL) simulates only to choose a budget it was not given, so a
  recipe that called `tx.setGasBudget(...)` there was resolved and signed
  without ever being shown to execute: a Move abort became a charged
  `ExecutionFailed` instead of a free `SimulationFailed`. `Tx.build` now asks,
  against the resolving client and before the build, whether the SDK will
  simulate, and runs one explicit simulate when it will not.
- **`Tx.build` retries the SDK resolver** on a retryable `TransportError`, on
  `SuiCore`'s effective read policy (`core.readPolicy("use")`: the layer's
  `readRetry` when it was given one, else five attempts), each retry logged at
  debug and counted like a `SuiCore` read. The resolver's own reads went
  straight to the SDK under none of `SuiCore`'s retries; nothing has been
  signed yet.
- **`Signer.fromConfig` builds ML-DSA-65 keys.** `MLDSA65Keypair` is imported
  on demand, because `@mysten/sui/keypairs/mldsa65` first shipped in 2.36 and
  the peer range admits older SDKs, where a static import would not load.
- **`Verify.verifyTransactionSignature` and
  `Verify.verifyPersonalMessageSignature`** on `@unconfirmed/sui-effect/tx`:
  the Effect face of `@mysten/sui/verify`, `R = Sui`, answering the public key.
  With `{ address }` the signature must also be that address's. An invalid
  signature is `SigningError`; a zkLogin or multisig check that could not reach
  the node is `TransportError`, never a verdict.
- **`Sui.streamEvents(filter?, { order? })` and
  `Sui.streamTransactions(filter?, { order? })`** over the SDK's `EventFilter`
  and `TransactionFilter`. Both page on `hasNextPage`, so a scan-limited
  server's empty pages do not end the stream; transactions are
  `Result<Executed, ExecutionFailed>` per entry.
- **`Sui.streamCoins(owner, coinType?)`, `Sui.streamBalances(owner)` and
  `Sui.getCoinMetadataOption(coinType)`.**
- **`Sui.getDynamicObjectFieldOption(parent, name, { schema?, expectedType? })`**,
  which checks the object's type the way `getObject` does.
- **`Sui.resolveNameServiceAddressOption(name)` and
  `Sui.defaultNameServiceNameOption(address)`**; "no name" is `None` on every
  SDK in range (2.33.2 changed it from a thrown `NOT_FOUND` to `name: null`).
- **Schemas `EventEntry`, `Coin`, `CoinMetadata` and `Nonce`; types
  `EventFilter`, `TransactionFilter`, `ListOrder`**, all from the package root.
- **`pruneSettled(before, { prefix? })`** in `@unconfirmed/sui-effect/journal`
  deletes settled entries recorded before a cutoff and answers the count; it
  never deletes a `Signed` or `Unknown` entry.
- **The fake serves the ledger reads**: `listEvents`, `listTransactions`,
  `getDynamicObjectField`, `resolveNameServiceAddress` and
  `defaultNameServiceName`, with `FakeScript.scanLimit`, `FakeScript.names`,
  `FakeExecution.sender` and `FakeExecution.moveCalls`.
- **`Tx.resubmit(signed | SubmissionUnknown)`** re-sends identical bytes
  (refused when the journal says `NotApplied`; reconciles instead when it says
  `Executed`/`Failed`, when the bytes name another chain, or when their window
  has closed), and **`Tx.reconcileAll({ resubmit: true })`** does it for every
  entry still unknown. Both are on `/tx`.
- **`Tx.fromBytes(bytes)`** (a `Built` from someone else's bytes: chain filled
  in, other-chain expirations refused) and **`Tx.attach(builtOrSigned,
  signature)`** (verified; the signer must be the sender or the gas owner; a
  duplicate is a no-op) — the stateless sponsor is `fromBytes → attach → cosign
  → submit`. `Built.gasOwner` is read from the bytes (present only when it is
  not the sender) and `SignedTransaction` gains `gasOwner`.
- `Tx.gaslessStablecoinTransfer({ requireZeroGas: true })` fails the build
  unless the resolved gas price and budget are 0. `sdkRefOf` accepts a `Coin`.
- **`SuiError.digestOf`, `SuiError.moveAbort` (`Option<MoveAbortInfo>`),
  `SuiError.isMoveAbort(e, { package?, module?, function?, constant?, code? })`**
  and `describe(e, { tag: false })`; types `DescribeOptions`, `MoveAbortInfo`,
  `MoveAbortMatch`. `describe`, `outcome`, `toJson` and `isRetryable` accept
  `unknown`, so a Promise `catch` needs no cast. `ExecutionReason`'s `Unknown`
  carries `message` and `command`; `SimulationFailed` gains `command`;
  `DecodeError` gains `actualType`.
- **`Executed.eventsOf(codec, eventType?)`, `Executed.expectEvent(codec,
  eventType?)`** (`UnexpectedEffects | DecodeError`) and
  **`Executed.expectPublished()`** → `{ packageId, package, upgradeCap }` (type
  `Published`). `EXECUTE_INCLUDE`, which `Executed.fromTransactionResult` is
  typed over, is exported.
- **Resumable and tailing ledger streams**: `after`/`before` on `streamEvents`
  and `streamTransactions` (`ListOptions`); `streamEventPages` /
  `streamTransactionPages` yielding `ListPage { items, endCursor }`; and
  `tailEvents` / `tailTransactions` / `tailEventPages` / `tailTransactionPages`,
  which never end, poll (1 s by default), retry a retryable error from the last
  cursor, and advance a filtered cursor to the unfiltered head so a pruning node
  does not strand it (`TailOptions`). That move reads the head and the filtered
  page as two requests and is sound only when both reach one node (or nodes at
  the same height): behind a load-balanced endpoint (the public fullnodes) it
  can skip matches for good, so run a filtered tail whose completeness matters
  against a single, sticky node. A full `eventType` filter is normalized.
- **A per-attempt read `requestTimeout`** (30 s by default — a new default on
  every `SuiCore` layer, see "Changed (breaking)" — `"Infinity"` off,
  `SUI_RPC_TIMEOUT` under `layerConfig`) ending in a retryable
  `DEADLINE_EXCEEDED`, and a `readRetry` schedule option; each read retry is
  logged at debug. `SuiCoreReadOptions` on `layerFromClient`/`makeFromClient`;
  `SuiGrpcLayerOptions` extends it. Not applied to execute,
  `signAndExecuteTransaction`, `waitForTransaction` or `use`.
- **`SuiCore.getServiceInfo`** (`ServiceInfo`, with `lowestAvailableCheckpoint`);
  `UNIMPLEMENTED` on non-gRPC transports.
- **`SuiAddress.Strict` / `ObjectId.Strict`** for user input (exactly 64 hex
  digits, same brand); `CoinType.normalize`, `StructTag.normalize` and
  `CoinType.SUI`. The type arguments of `getBalance`, `streamCoins`,
  `getCoinMetadataOption`, `streamOwnedObjects({ type })` and
  `Executed.balanceChange` accept plain strings.
- `Sui.getDynamicFieldOption(parent, name, { schema, expectedType? })` →
  `Option<DecodedDynamicField<S>>`, and `SuiSchema.name(codec, key)` /
  `SuiSchema.name(layout, type, key)` to build a dynamic-field key from one
  description.
- **Promise-face options for Promise consumers**: `SuiExtensionOptions.submit`
  (`SubmitConfigOverrides`) and `journal` (`JournalService`), and
  `face.$reconcileAll()` (a reserved name). `SubmitConfig` overrides accept
  `Duration.Input` (`SubmitConfigOverrides`, exported from `/tx`).
- **`Script`** (both changes are also breaking; see above): a declared integer
  `exitCode` (1–255) on an error is honoured
  (after `ConfigError`, before `outcome`) — the plain field, or else Effect's
  own `[Runtime.errorExitCode]` marker, so an error written for
  `Runtime.makeRunMain` exits the same under `Script.run`; `Script.run` reads
  `SUI_LOG_LEVEL` (`Config.LogLevel`: `Debug`, `Warn`, … spelled exactly) into
  the run's `References.MinimumLogLevel` — `SUI_LOG_LEVEL=Debug` shows the
  read retries — and a value that is not a level exits 2; `ScriptRunOptions.layer` accepts any
  error type.
- **Testing**: `fakeCoin`, `FakeEvent` (`json` optional),
  `FakeScript.visibilityDelay` (ms or `"never"`) and `SuiTest.setVisibilityDelay`,
  `SuiTest.provide(layer)` (a fresh `Journal.layerMemory` and `TestClock`,
  `{ local: true }`), `testSubmitConfig`,
  `FakeOutcome.transportError(status, message?)` and
  `FakeScript.ledger { lowestAvailableCheckpoint?, firstCheckpoints? }`.
- **`LLMS.md` opens with a "start here" section** (`docs/llms-head.md`): the
  subpath map, thirteen recipes that are tested files, the two tiers and the
  positional-versus-options rule, the error table with outcomes and exit codes,
  `SubmitConfig`'s defaults, ten invariants and an index of every export by
  subpath. The extension template's test suite and manifest are now named by
  path rather than reprinted.
- **Metrics**, through Effect's `Metric` into the registry in context, with
  names and attribute keys that are a public contract (README, "Metrics and
  tracing"): `sui_effect_tx_execute_attempts_total`,
  `sui_effect_tx_submit_total{result}`, `sui_effect_tx_lock_conflicts_total`,
  `sui_effect_tx_reconcile_total{result, evidence}`,
  `sui_effect_tx_visibility_wait{result}`,
  `sui_effect_tx_build_duration{simulated_by}`,
  `sui_effect_tx_build_gas_budget`,
  `sui_effect_core_read_retries_total{method, status}`,
  `sui_effect_core_request_timeouts_total{method}` and
  `sui_effect_sender_lock_wait`. Every attribute value is from a closed set;
  none is a digest, an address, an object id or a coin type.
- **Span attributes**: `sui.outcome`, `sui.refused`, `sui.lock_conflict` and
  `sui.not_applied.evidence` on the submit and reconcile spans;
  `sui.simulated_by`, `sui.gas_budget` and `sui.max_epoch` on `Tx.build`;
  `sui.object_count` and `sui.chunk_count` on `Sui.getObjects` and
  `sui.decode_failures` on each `Sui.getObjectsPage`; `sui.page_count` and
  `sui.caught_up` on a tail's span.
- `SuiCoreService.readPolicy(method)`: the effective read retry `Schedule`
  (the layer's `readRetry`, or the default), for a read made outside the
  members. Optional on the interface, so a `Layer.mock(SuiCore, ...)` need not
  supply it.
- `FakeScript.readOptions` (`SuiCoreReadOptions`) builds the fake's `SuiCore`
  with a custom `readRetry` / `requestTimeout`.
- **Address-balance gas and coin folding.** `Tx.planFold({ owner, coinType?,
  maxCoinsPerTransaction? })` reads an owner's coins, SUI address balance and
  gas price and answers a `FoldPlan` (`batches` of `FoldBatch`, at most 500
  coins each, SUI first; `skipped` dust); `Tx.fold(batch)` is one batch's
  recipe, with `FoldGas` saying how it pays (`"foldedCoins"`: SUI pays for its
  own fold through `coin::send_funds<SUI>(GasCoin)`, so a coin-only account
  needs nothing first; `"addressBalance"`; `"auto"`); `Tx.foldCoins({ signer
  })` plans and runs every batch, answering `FoldResult { plan, executed }`.
  On localnet five 200-SUI faucet coins folded in one transaction to zero
  coins and 1,000,003,939,506 MIST of balance, and 290 coins in one (net gas
  negative). `Tx.sendFunds({ coinType?, amount, recipient, useGasCoin? })` is
  `balance::send_funds` of a `tx.balance`, the canonical transfer into a
  recipient's address balance.
- **`SubmitConfig.gasPayment`** (`GasPaymentPolicy`): `"preferAddressBalance"`
  (the default; the resolver pays from the address balance when it covers the
  budget, coins otherwise) or `"requireAddressBalance"` (the payment is pinned
  to the balance before the build, and coins are a `BuildError` naming
  `Tx.foldCoins`). `LockSenderPolicy` and `GasPaymentPolicy` are exported from
  `/tx`.
- **Span attributes** `sui.gas_payment` on `Tx.build` (`addressBalance`,
  `coinReservation`, `coins`) and `sui.sender_lock` on `Tx.run` (`held`,
  `build`, `none`).
- **Testing: the fake models address balances** per owner and coin type,
  seeded from `FakeScript.balances[].addressBalance`;
  `SuiTest.setAddressBalance(owner, amount, coinType?)` sets one and
  `SuiTest.addressBalance(owner, coinType?)` reads it. Like a node, the fake
  refuses with `INVALID_ARGUMENT` an empty payment, a coin reservation or a
  withdrawal the balance cannot cover and empty-payment bytes with no owned input and no `ValidDuring`
  expiration.
- `test/live.localnet.test.ts`, behind `SUI_LOCALNET=1`: folding a faucet
  account to zero coins, concurrent sends from one sender, a sponsor's balance
  paying for an empty sender, the coin fallback and the `requireAddressBalance`
  refusal, the `ValidDuring` rule, reconcile and resubmit of bytes that pin
  nothing, and 301 SUI coins plus a published coin type folded in two
  transactions.

### Changed

- `Sui.view` accepts a `Recipe`, a `Transaction` or serialized bytes, like
  `Sui.simulate`.
- `SuiGraphQL.query`'s `run` receives the Effect's `AbortSignal` as a second
  argument; pass it as the query's `signal` so `Effect.timeout` and
  interruption cancel the request. One-argument callbacks still compile.
- Every `TransportError` for a node reply that did not decode now carries a
  `DecodeError { kind: "shape", issues }` as its `cause`, not a string.
- Several journal instances or processes over one prefix no longer lose each
  other's entries (the single-writer limitation is gone with the index).
- A store written by 0.3 reads with no migration; its `index` key is ignored,
  left in place and no longer maintained (rolling back is not safe as is: see
  the durable journal under "Changed (breaking)").
- **`Tx.run` takes the gas owner's lock only when gas is paid with coins.**
  An empty payment (address-balance gas, `Tx.sponsored`) selects no coin, so
  one sponsor serves many senders concurrently (twenty concurrent sponsored
  runs went from ~50 s to ~1 s). The recipe is applied before the locks are
  chosen, so a gas owner it sets is known without `opts.gasOwner`, and a
  missing sponsor is a `SigningError` before the build.
- `Tx.reconcile` journals its terminal answer for a digest the journal holds
  unresolved.
- Every Promise-face registration shares **one process-wide sender lock per
  address**, which fixes gas equivocation between a warm and a lazy
  registration, or two clients.
- `Script.run` finds the journal wherever the program provided it and reports
  only this run's entries. The exit-code rules are under "Changed (breaking)":
  after this run applied a transaction it exits 5
  (`ExitCodeOptions.applied`) and prints "N submission(s) of this run applied
  on chain: … do not send them again"; while it left a submission unresolved
  it exits 3 (`ExitCodeOptions.unresolved`) — before, an applied run with an
  unresolved entry that then failed with a not-applied error such as
  `ObjectNotFound` exited 4, and a wrapper's retry re-sent the applied intent.
  Diagnostics are one
  line per failure through `SuiError.describe` (a `ConfigError` names the
  variable), with the bytes printed once. `Script.layerNoDeps`,
  `layerWithSigner` and `layerReadOnlyNoDeps` read the network from `SuiCore`,
  not `SUI_NETWORK`.
- A cold face value placeholder throws `ExtensionNotReady` on value-only names
  (`.length`, `.startsWith`, `toString`, `valueOf`, `toJSON`, …) and on spread,
  and renders as `<ExtensionNotReady ext.member>`.
- A SuiNS lookup answered `UNIMPLEMENTED` (localnet) is `None`. A package
  object's `content` is an empty `Uint8Array`.
- The `awaitVisible` warning is one line, with no stack.
- `DESIGN.md` ships in the package, because the shipped `AGENTS.md` and
  `README.md` cite it; `docs/PLAN.md` and the house skill are named as
  repository-only.
- The extension template's `scripts/check-package.ts` names none of the
  template's exports: it reads every subpath of `package.json`'s `exports`,
  learns each one's names from its `src/` file and requires the packed `dist/`
  to export them, so the documented rename no longer breaks it.
- The extension template's peer on `@unconfirmed/sui-effect` is
  `>=0.4.0 <0.5.0`.
- CI's effect matrix installs `effect` and `@effect/platform-bun` as one pair
  with no fallback, and the README no longer claims TypeScript 7 (`tsgo`)
  consumers are checked: CI typechecks the packed tarball with `tsc` 5.9.3.
- `test/live.devnet.test.ts` (behind `SUI_LIVE=1`) funds through
  `requestSuiFromFaucetV3`, which pays into the address balance, so it also
  exercises address-balance gas.
- Per-item and nested helpers no longer open spans of their own, so a batch
  read or a stream is no longer one span per object: the journal entry
  builders (`Tx.executedEntry` and friends), `Sui.decodeObject`,
  `Sui.simulateRaw`, `Sui.fromSimulationResult`,
  `Executed.fromTransactionResult`, the in-memory journal's `Journal.put` /
  `Journal.get`, and `Tx.inputStateOf`, `Tx.consumedVersionOf`,
  `Tx.currentEpoch` and `Tx.expiryClosed` are gone from traces (the durable
  journal's `Journal.put` / `Journal.get`, `Tx.recover`, `Tx.inputEvidence`,
  `Tx.historyOf` and `Sui.getObjectsPage` remain).
- `Signer.fromConfig` wipes the `Config.Redacted` it read
  (`Redacted.wipeUnsafe`) as soon as the key is decoded, on success and
  failure alike, so a stray reference to it can no longer be unwrapped.
- Property tests with Effect's own `Arbitrary` (`test/properties.test.ts`):
  `SuiError.toJson` round-trips through `SuiErrorSchema` with its tag, outcome
  and a message, and `Script.exitCode` is total (1–255, never 0) over generated
  causes. Derivation cannot satisfy the branded id checks, so it covers the ten
  unbranded taxonomy tags; `JournalEntry` cannot be derived and keeps its
  example tests.

### Fixed

- **`Tx.reconcile` no longer answers `NotApplied { expired }` for a transaction
  that applied.** A pinned object naming the transaction's own digest now vetoes
  expiry, and on gRPC a node that has pruned into the validity window
  (`GetServiceInfo.lowestAvailableCheckpoint` against
  `GetEpoch(minEpoch).firstCheckpoint`) cannot prove a miss; both answer
  `SubmissionUnknown`. JSON-RPC and GraphQL cannot report their history, so the
  old rule stands there; behind a pruning node use `expiryEvidence: "never"`.
- A first-send validator lock conflict ("already locked by a different
  transaction", "rejected as invalid by more than 1/3 of validators") is
  reconciled up to three more times, `reconcileRecheck` apart, before
  answering. A `SubmissionUnknown` from a send names the send's own error
  ("…; the last send failed with …").
- An execute answer is journalled before an interrupt can land
  (`uninterruptibleMask`); an interrupt during the visibility wait is logged as
  executed.
- An execute or relay answer for **another** digest is reconciled instead of
  returned, and a `submitVia` reply without effects, or reporting failure, asks
  the chain (it was a hollow or false `Executed`).
- `LLMS.md` carried its head twice — `String.replace` expanded the "$\`" in
  the `ExtensionFace` summary into everything before the index marker — and now
  prints both halves of a name that is a type and a value (`SuiError`'s
  helpers, `FakeOutcome`'s constructors, `Signer`'s, the `Signed` schema), every
  overload of a function, a schema class's fields by schema name (`Executed`,
  every error with a `get message()`), no private member or its orphaned JSDoc,
  and a renamed export under its exported name (`SuiSchema.decode`,
  `SuiSchema.matchesType`, `makeKeyValueStore`).
- The docs no longer say `bcs.Address()` (it is a value), "passing `gasOwner`
  costs nothing", or that a cold call works with `expect(cold).rejects`.
- A `Signed` entry for a refused submission no longer stays unresolved until
  its epoch window closes.
- Coin-reservation refs in `gasData.payment` (address-balance gas) are no
  longer read as pinned objects during reconcile.
- `Script.run` and `Script.report` no longer reject or skip `exit` when an
  injected `stderr` writer throws.
- The extension guide's Durable Object `KeyValueStore` adapter compiles on
  effect 4.1 (it adds `keys`, drops a stray `Option`, and turns storage
  rejections into `KeyValueStoreError`); it is now a typechecked, tested
  template file, `examples/extension-template/recipes/durable-object.ts`.
- `LLMS.md` shows `SubmitConfig`'s docs and example, prints qualified "Never
  fails; …" sentences whole, has no raw `{@link}` in signature blocks, and no
  summary is cut short at a prose line starting with `@`.
- `examples/script-claim.ts`'s header put `UnexpectedEffects` on exit 4; it
  exits 5 (applied), as `Script.exitCode` and the README always said.
- A failed `Signed` write on a re-send (`Tx.resubmit`, `reconcileAll({
  resubmit })`, a second submit) no longer erases the run's earlier `Unknown`,
  `Executed` or `Failed` record of those bytes, which made `Script.run` exit 4
  instead of 3 or 5.
- `Tx.reconcile` refuses a `getTransaction` answer for another digest (it was
  returned and journalled under the foreign digest; it is now
  `SubmissionUnknown`), and such an answer is never `NotApplied {
  inputConsumed }` evidence.
- The sender lock (`Sui.withSenderLock`, and the Promise face's process-wide
  one) is keyed on the normalized address, so an upper-case `SuiAddress.make`
  spelling of a sender no longer gets a second lock; `Tx.run` takes a
  sender/gas-owner pair in that normalized order too, so two runs for one pair
  spelled differently cannot take it in opposite orders and deadlock.
- `SuiError.describe`, `toJson` and `.message` no longer overflow the stack for
  an extension error whose `message` getter calls `SuiError.describe(this)`, or
  for a cyclic `cause`; every helper documented "Never fails" now is, over a
  null-prototype object, a throwing getter or `toString`, a revoked Proxy and a
  taxonomy tag without its fields, and `isMoveAbort(e, { code: 1.5 })` is
  `false` rather than a `RangeError`.
- The Promise face: awaiting a cold face (`Promise.resolve(face)`, an `async`
  function returning it) settles instead of hanging; `$ready()` and
  `$reconcileAll()` after `$dispose()` on a `warm` registration no longer leak
  a runtime; a cold member's `call`, `apply` and `bind` work as on a function
  (a namespace member by those names still works); and `"prototype" in` a cold
  call no longer throws.

### Migrating from 0.3.x

1. Move to `effect@4.1.1` (and every `@effect/*` package you use at `4.1.1`)
   together, and `@mysten/bcs` to `^2.1.3` (the new peer floor). A custom
   `KeyValueStore` behind the durable journal needs `keys`;
   `KeyValueStore.makeStringOnly` takes it as a sixth member.
2. Replace `getObjectsOrFail` with `getObjectsStrict`, `ReconciledOutcome` with
   `Reconciled`, and `face.dispose()` with `face.$dispose()`.
3. Delete `catchTag("TransportError", …)` around `Tx.reconcile` and
   `Tx.reconcileAll`; the compiler points at each one.
4. Handle `NotApplied { evidence: "refused" }` wherever you `switch` on
   `evidence`, and `"MLDSA65"` wherever you `switch` on `SignatureScheme`.
5. A hand-built `Simulation` needs `gasPaymentMocked`.
6. Pass the `AbortSignal` through in `SuiGraphQL.query` callbacks.
7. Durable journals need no migration to be read by 0.4. Rolling back does: 0.4
   no longer maintains 0.3's `index` key, so a 0.3 process does not see the
   `Signed`/`Unknown` entries 0.4 wrote, and cannot decode a `"refused"` one.
   Before rolling back, or while 0.3 and 0.4 processes share a store, run
   `Tx.reconcileAll()` on 0.4 until nothing is unresolved (or settle the
   entries by hand) and delete the `"refused"` entries. A store holding an
   entry that does not decode now fails the layer build: repair or remove it.
8. Catch the gas ceiling as `PolicyDenied` (`rule: "maxGasBudget"`), not
   `BuildError`; add `PolicyDenied` wherever you handle `Tx.build`'s union.
9. A `catchTag("TransportError", …)` around `Tx.build` that meant "the node
   refused my inputs" now sees `BuildError`; keep the `TransportError` branch
   for real transport failures (`method: "Tx.build"`).
10. A sponsored build with `Tx.sponsored` needs the sponsor's SUI **address
    balance** to cover the budget (deposit with `coin::into_balance` +
    `balance::send_funds<SUI>`), or sponsor with coins: `Tx.run(recipe, {
    signer, gasOwner, sponsor })` without `Tx.sponsored`. On the fake, script a
    balance with an `addressBalance`. Passing `gasOwner` only to get its lock is
    no longer needed.
11. A nested `SubmitConfig.with` now keeps the outer overrides; if you relied on
    it resetting to the defaults, pass those fields explicitly.
12. Promise-face consumers of an `Effect<Option<A>>` member get `A | undefined`:
    replace `Option.isSome(x)` / `x.value` with an `undefined` check. A test of a
    cold call writes `expect(Promise.resolve(cold)).rejects`, and code that
    checked `typeof cold === "object"` sees `"function"`.
13. An address or id decoded from `""`, `"0x"`, a `"0X…"` spelling or non-hex
    is now a decode failure, and `SuiAddress.normalize` / `ObjectId.normalize`
    throw a `SchemaError` on the same inputs: lower-case a `0X` prefix first,
    and guard an empty value before normalizing it. Decode a value a human typed
    with `SuiAddress.Strict` / `ObjectId.Strict`.
14. A `catchTag("TransportError", …)` that handled a malformed filter or a
    `pkg`/`pkg::module` function filter on `streamTransactions` now sees a
    defect: fix the filter (fully qualified `pkg::module::function`, or
    `sui.core.listTransactions` for one page).
15. Replace assertions on `SuiError.describe` text with `_tag` / field checks;
    the wording of aborts, `Unknown` reasons and causes changed.
16. Tests: `fakeDigest` is a `Digest` (drop casts); an execute outcome scripted
    with a digest other than the bytes' own is now a defect — remove the
    `digest` override; `layerTest` re-sends without delay, so a test that
    counted on the production schedule sets `SubmitConfig.with({ resubmit })`.
    The fake's resolver simulates only when the recipe left the budget unset:
    a test that presets a budget and asserted on a `resolver: true`
    `simulateTransaction` call now sees `Tx.build`'s explicit simulate (no
    `resolver` flag) instead; `FakeScript.buildSimulate` answers only the
    resolver's simulate, so script that test's outcome with `simulate`.
17. Wrapper scripts: re-read your exit-code handling. 5 now also follows a
    timeout, an interrupt or a not-applied error once the run applied a
    transaction ("do not send it again"); 3 now follows **any** would-be 2, 4
    or 130 while a submission of the run is unresolved; an error carrying an
    integer `exitCode` field (or `[Runtime.errorExitCode]`) exits with it. Spell
    `SUI_LOG_LEVEL` exactly as `Config.LogLevel` does (`Debug`, not `debug`) or
    leave it unset, or the script exits 2 before it runs.
18. A read that legitimately takes longer than 30 seconds needs a longer
    `requestTimeout`: pass it in `SuiCore.layerGrpc({ ..., requestTimeout })`
    or `layerFromClient(client, { requestTimeout })`, or set
    `SUI_RPC_TIMEOUT` (e.g. `2 minutes`) under `layerConfig` and `Script.layer`;
    `"Infinity"` restores 0.3's unbounded reads.
19. A hand-written `SuiService`, `SuiCoreService` or `ExtensionFace` object
    (not a spread of a real one) must add the new members listed under
    "Changed (breaking)".
20. `lockSender: true` → `"always"` if you relied on serialized submissions
    (a flow that spends a balance down to zero); nothing to do otherwise.
    `false` → `"never"`. Code that reads `SubmitConfigService.lockSender` (or
    `SubmitConfig.defaults.lockSender`) as a boolean compares against the
    policy strings instead.
21. A sponsor or `requireAddressBalance` payer whose balance covered the budget
    but not the SUI the transaction also withdraws now fails `Tx.build`: fund
    the balance for both. With `SubmitConfig.expiration: "epoch"` or `"none"`, or
    a recipe's own non-`ValidDuring` expiration, an address-balance
    transaction with no owned input now fails `Tx.build`: leave `expiration` at
    `"validDuring"`.
    A sponsored (`Tx.sponsored`) or `requireAddressBalance` recipe that uses
    `tx.gas` now fails `Tx.build` instead of failing on chain: replace
    `tx.splitCoins(tx.gas, [amount])` with `tx.coin({ balance: amount,
    useGasCoin: false })` or `Tx.sendFunds({ ..., useGasCoin: false })`.
22. Tests: a fake script with an owner-less `addressBalance` beside coins now
    pays gas from the balance (`payment: []`); add a balance entry with
    `addressBalance: "0"` for the payer to keep coin gas, or update the
    assertion. A test that built for a payer with no coins and no balance now
    gets `BuildError`: script a coin or an `addressBalance` for it.
23. Fold coin-funded accounts once with `Tx.foldCoins({ signer })` (the
    localnet faucet pays coins; the devnet/testnet V3 faucet pays the balance)
    and prefer `Tx.sendFunds` / `tx.coin({ balance })` to
    `tx.splitCoins(tx.gas, ...)`, so transactions pin nothing and stop
    serializing on the sender lock. Optional: unfolded accounts keep working on
    coin gas.

## 0.3.0

### Changed (breaking)

- **The `effect` peer dependency is now `>=4.0.3 <4.1`, the stable 4.0.x line.**
  Release candidates are no longer supported (0.2.x remains the line for
  `effect@4.0.0-rc.112`). `@effect/platform-bun` (a devDependency, used by tests
  and examples only) moves to `4.0.3` with it. `@mysten/sui` and `@mysten/bcs`
  are unchanged. The public API of this package is unchanged: no export was
  added, removed or re-typed. The port is otherwise mechanical, but effect 4.0.x
  itself changes a few observable things, listed under "Observable changes"
  below.
- Internally the port is: `effect/unstable/persistence` to `effect/persistence`
  (the journal's `KeyValueStore`), `SchemaTransformation.transformOrFail` to
  `transformEffect`, `Config.nonEmptyString` / `string` / `redacted` to
  `Config.NonEmptyString` / `String` / `Redacted`, and
  `Encoding.encodeBase64` to `Base64.encode` from `effect/encoding/Base64`.
  The extension template's `peerDependencies` follow (`effect >=4.0.3 <4.1`,
  `@unconfirmed/sui-effect >=0.3.0 <0.4.0`), and CI's `effect-rc-matrix` job is
  now `effect-matrix`, proving `4.0.3`.

### Migrating from 0.2.x

1. Move the whole Effect release train to stable together: `effect@4.0.3` and
   every `@effect/*` package you use at `4.0.3`. A mixed rc and stable install
   fails to resolve `effect/*` module paths. Pin `4.0.x` explicitly; the `rc`
   dist-tag still points at a release candidate.
2. Update your own rc imports and names (the rc.113 renames and the rc.118
   removal of `effect/unstable/*`; see Effect's `MIGRATION.md`). Everything you
   import from `@unconfirmed/sui-effect` keeps its name and signature.
   Extensions that import `KeyValueStore` use `effect/persistence`.
3. Review `partition`/`separate` destructuring in your own code: Effect 4.0.x
   returns `[successes, failures]` (rc: `[failures, successes]`), which does not
   fail to compile when both sides have the same type. sui-effect itself does
   not call them.
4. **Durable journals need no migration.** The journal stores JSON produced by
   `Schema.fromJsonString(JournalEntry)` plus a JSON index, nothing keyed by
   Schema check IDs, hashes or `Hash` values. A store written by 0.2.x on rc.112
   was read and rewritten byte for byte by 0.3.0 on 4.0.3, and the reverse
   (`test/journal-compat.test.ts` pins the rc.112 bytes). Rolling back to 0.2.x
   over a store 0.3.0 wrote works too.
5. Since Effect 4.0.2, `Effect.retry` does not retry a typed failure that is
   accompanied by a defect or an interruption in the same `Cause`; pure defects
   never were retried. (rc.112 retried a `fail` plus a dying finalizer four
   times; 4.0.3 runs it once.) `SubmitConfig`'s `resubmit` schedule, `Sui.layer`'s
   `retry` and the read policy retry only the typed `TransportError`
   (`retryable`), so ordinary use is unaffected; a schedule you pass that relied
   on retrying such a mixed cause now stops at the first attempt.

### Observable changes forced by effect 4.0.x

None of these changes a type or a stored byte; they change text and edge cases.

- **`TimeoutError` has a message.** rc.112's was empty; 4.0.3's is
  `Operation timed out after '<duration>'`. So `SuiError.describe`, the
  `lastError` a journal records for a timed-out submission (`Tx.ts`) and
  `Script`'s printed output change from `...(retryable): TimeoutError` to
  `...(retryable): Operation timed out after '10ms'`. `lastError` is free text,
  so stores written by 0.2.x stay readable and the reverse also holds.
- **`SuiError.outcome` honours an inherited `outcome` property.** Effect 4.0.x
  (effect #8131) makes `Schema.Struct` checks use `key in input`,
  so an error whose class (not just its instance) defines `outcome` is now
  recognised by `SuiError.outcome` (`errors.ts`). That aligns it with
  `Script.exitCode` and the own-property `outcome` check in `Tx.submit`.
- **`ManagedRuntime.dispose` interrupts in-flight calls.** `dispose()` on a
  `SuiExtension` Promise face's runtime now interrupts calls still running
  rather than letting them finish; await your calls before disposing.
- **Output of effect itself improved**, and shows through this package:
  `Cause.pretty` includes stack frames, `SchemaError` renders as JSON,
  tagged unions expose `.tag`, and `toJsonSchemaDocument` emits
  `additionalProperties: true` where it previously omitted it.

## 0.2.2

### Fixed

- **`Sui.getDynamicFieldOption` decodes real node responses again.**
  `SuiClientTypes.DynamicField` declares a top-level `valueType`, but the SDK's
  `getDynamicField` only returns the type under `value.type` (through at least
  `@mysten/sui` 2.34), so every read failed with "Missing key at valueType".
  The decoder now fills `valueType` from `value.type`, and `SuiCoreFake`
  returns the SDK's runtime shape so tests exercise the same path.

## 0.2.1

### Added

- **`Tx.gaslessStablecoinTransfer({ coinType, amount, recipient })`.** The
  recipe uses the Sui SDK's canonical `tx.balance()` →
  `0x2::balance::send_funds<T>` flow. It does not involve a sponsor and does
  not force gas fields: gRPC and GraphQL resolution simulate the transaction,
  consult protocol configuration and set zero gas when the resolved PTB is
  eligible. The helper is also a named export from
  `@unconfirmed/sui-effect/tx`.
- The gasless helper deliberately does not embed today's stablecoin allowlist
  or 0.01 minimum. Both live in protocol configuration, whose per-token
  minimum is in base units; the helper has no trustworthy decimals from which
  to reproduce it. `Tx.build` simulation rejects ineligible types and amounts
  before signing, while applications with verified metadata can validate
  display amounts earlier.

### Fixed

- **Successful simulation decoding now accepts the Mainnet gRPC envelope.** A
  node may omit `Transaction.digest` while returning the digest in
  `Transaction.effects.transactionDigest`. `Sui.simulate` now uses the effects
  digest as a fallback. If both locations are present they must agree; a
  disagreement is a non-retryable `TransportError` rather than effects being
  attributed to the wrong transaction.

## 0.2.0

One breaking change, from the same audit of this package against Effect v4
rc.112's documentation that produced 0.1.3. Nothing else changed: no name was
added or removed, no signature moved, and runtime JSON is byte for byte what
0.1.x produced.

### Breaking

- **Every optional field on a shape this library constructs itself is now
  `Schema.optionalKey` rather than `Schema.optional`.** The rule: a shape
  sui-effect produces uses `optionalKey`, so the key is either absent or
  carries a value its schema accepts; a shape that mirrors the SDK keeps
  `optional`, because an object built by `@mysten/sui` really can carry a key
  set to an explicit `undefined`.

  The fields that changed: `SignedTransaction.expiration`, `SignedTransaction.chain`,
  `Built.gasOwner`, `Built.expiration`, `Built.chain`, `JournalEntry.Executed.checkpoint`,
  `TransportError.status`, `ObjectNotFound.version`, `ObjectDeleted.version`,
  `ObjectUnavailable.version`, `DecodeError.objectId`, `DecodeError.expectedType`,
  `ExecutionFailed.command` and `SubmissionUnknown.signed`.
  (`DecodeError.issues` was already `optionalKey`, from 0.1.3.)

  The fields that deliberately did **not**: `DynamicFieldEntry.childId`,
  `DynamicField.childId`, `Event.json`, every field of `MoveLocation` and
  `CleverError`, and every optional payload field of `ExecutionReason`
  (`MoveAbort.location`/`cleverError`, `PackageUpgradeError.packageId`/`digest`,
  `IndexError.index`/`subresult`, `CoinDenyListError.address`,
  `ObjectIdError.name`). These are decoded straight from the SDK or from gRPC,
  where `undefined` can appear.

  **Why.** Effect's "optional and default keys" page says to use
  `Schema.optionalKey` when a field may be omitted but, when present, must hold
  a value the schema accepts — which is exactly the case for a shape whose only
  producer is this library. `optional` types a field
  `status?: string | undefined` and accepts `{ status: undefined }` at decode;
  `optionalKey` types it `status?: string` and refuses the explicit `undefined`
  at decode and at construction, and under `exactOptionalPropertyTypes` (this
  package's own setting) at compile time as well. The JSON Schema loses a spurious `null`
  branch with it: `Schema.toJsonSchemaDocument(Built)` now renders `chain` as
  `{ "type": "string" }`.

  **The symptom.** A consumer that passes an explicit `undefined` — for
  example `new DecodeError({ objectId: maybeId, issue })` where `maybeId` is
  `string | undefined` — now **throws at construction** (`Schema validation
  failed`), and `Schema.is`/`decodeUnknown` of such an object fail, where
  0.1.x accepted it and kept an `undefined`-valued key. A consumer compiled
  with `exactOptionalPropertyTypes` also gets a compile error, `Type
  'undefined' is not assignable to type 'string'` (or the field's type); one
  without it (the misofm SDKs and services today) sees only the throw, so grep
  before upgrading. A consumer that omits the key, or spreads it conditionally,
  is unaffected.

  **The fix, everywhere:** omit the key instead of setting it to `undefined` —
  `...(version === undefined ? {} : { version })`, which is what
  `TransportError.fromUnknown` and `Executed.refOf` have always done.

  | Consumer | Grep for | Change to |
  |---|---|---|
  | **platform, musicos, partyos** | `new (TransportError\|DecodeError\|ObjectNotFound\|ObjectDeleted\|ObjectUnavailable\|SubmissionUnknown\|ExecutionFailed)\(` and any `Built`/`Signed`/`JournalEntry.Executed` literal, for a field whose value can be `undefined` (platform's `DecodeError` sites are in `src/pressing.ts` and `src/read/wallet.ts`; verified: none passes `undefined` today) | omit the key, or spread it conditionally: `new DecodeError({ ...(objectId === undefined ? {} : { objectId }), issue })` |
  | **platform, musicos, partyos** | `"@unconfirmed/sui-effect": "^0.1.0"` in `peerDependencies` | widen to `>=0.1.0 <0.3.0` (a 0.x caret does not admit 0.2.0; npm consumers get a peer conflict otherwise) and bump the devDependency |
  | **app, api, cli** | `(chain\|expiration\|gasOwner\|checkpoint\|status\|version\|objectId\|expectedType\|command\|signed): undefined` near a sui-effect type, and any relay path that rebuilds a `Built`/`Signed` from wire form | build the object with the keys it actually has (verified: none of the three constructs these shapes today; they go through the SDKs) |

  **Runtime JSON is unaffected.** JSON cannot carry `undefined`, so a journal
  line, a `SuiError.toJson` payload or a relay envelope persisted by 0.1.x
  decodes unchanged — `test/journal.test.ts` asserts it on a literal persisted
  line.

  **For skill maintainers** (the `effect-ts` and extension-authoring skills live
  in another repo): the rule to port is *"a shape the library constructs itself
  uses `Schema.optionalKey`; a shape mirroring an external producer keeps
  `Schema.optional`"*, with conditional spreads at the construction sites.

### Documentation

- `DESIGN.md` §10 states the rule beside the error table whose `?` fields it
  governs, and §9 says what it means for a persisted journal line.
- `docs/extensions.tpl.md` states it for extension authors twice: §2 for an
  error's fields, §3 for a codec's own struct or domain class.
- The extension template's peer range on `@unconfirmed/sui-effect` is
  `>=0.1.0 <0.3.0` rather than `^0.1.0`: a 0.x caret does not span a minor, and
  the only difference between the two surfaces is this rule.

## 0.1.3

Released the same day as 0.2.0. Sixteen ergonomics changes from an audit of this package against
Effect v4 rc.112's own documentation. Nothing was removed and no signature
changed: an extension or an application built against 0.1.2 compiles unchanged.

### Added

- **`SubmitConfig.with(overrides)` and `SubmitConfig.layer(overrides)`.** A `Context.Reference` holds one whole value, so every override used to be `Effect.provideService(effect, SubmitConfig, { ...SubmitConfig.defaults, maxGasBudget })` — with a cast on every branded literal. `run.pipe(SubmitConfig.with({ maxGasBudget: Mist.make(1_000_000_000n) }))` is the same thing in one call, and `SubmitConfig.layer` is the `Layer` form for an application that sets its policy where the runtime is built. `SubmitConfig.defaults` is unchanged.
- **`DecodeError.issues`**: every issue the schema reported, as `{ path, message }`, beside the `issue` sentence. The three producers decode with `{ errors: "all" }`, so a relay envelope with three bad fields reports three paths rather than the first one. `issue` still describes exactly **one** issue — the first — and a failure that only ever had one comes through byte for byte, so anything printing it is unaffected. The `issues` key is absent when the producer had no structured issue to carry, so `SuiError.toJson` round-trips exactly as before. `kind` is still the field to branch on.
- **`SuiError.toJson` always carries a `message`.** Fifteen of the eighteen error classes hold their sentence in an `override get message()`, and a getter is not part of the encoding, so a JSON log line had a human sentence for three tags and nothing for the rest. It is now in the same key for every error — `SuiError.describe` for a taxonomy error, the instance's own `.message` for an extension error — added only when the encoding produced none, and ignored on decode.
- **Span attributes on the calls a trace has to be joined to.** `sui.object_id`, `sui.object_count`, `sui.digest`, `sui.signature_count`, `sui.sender`, `sui.gas_owner`, `sui.signer`, `sui.attempt` and `sui.evidence`, plus a static `sui.network` on every `SuiCore` span. An OTLP trace of a stuck submission can now be searched by digest and by sender without reading the logs.
- **`identifier` and `description` on every reusable schema**, so a failure reads `Expected ObjectId` instead of `Expected string`, a mis-shaped BCS value names its Move type instead of `<Declaration>`, and `Schema.toJsonSchemaDocument(ObjectRef)` produces named `$defs` instead of one anonymous inlined object.

### Changed

- **`Built`, `Signed`, `Simulation`, `ObjectRef`, `ObjectEnvelope`, `Balance`, `DynamicField` and `DynamicFieldEntry` print by name.** They were `typeof Schema.Type` aliases, which TypeScript expands at every use site, so `Tx.build` rendered as forty lines of structure in editor hover and in `LLMS.md`. They are interfaces over the same types now — structurally identical, so nothing breaks — and the `Tx` block of `LLMS.md` is 69 lines instead of 464.
- **`Sui.getObjects` fetches its chunks concurrently**, four at a time. A 500-id read is three round trips instead of ten. Input order, the per-item `Result`s, the integrity checks and first-failure semantics are unchanged.
- **`Script.exitCode` can no longer exit 1 for a real taxonomy error.** Its per-tag `switch` had a `default:` that silently answered "defect", so a tag added to the taxonomy and forgotten there exited 1 instead of 3, 4 or 5. There is no tag list left: the mapping goes through `SuiError.isTaxonomy` and `SuiError.outcome`, which are derived from the error schema. No exit code changed — `NetworkMismatch` is still 2.
- **A `NaN` or an `Infinity` in a JSON number field is a `DecodeError`**, not a value: the seventeen fields that model a JSON number use `Schema.Finite`. The decoded type is still `number`.
- **`SuiAddress.normalize` and `ObjectId.normalize` document what they actually throw**: a `SchemaError` (`Schema.isSchemaError`) carrying `.issue`, because they are `Schema.decodeSync`. `.make` is the one that throws a plain `Error` with the issue in `cause`.
- Internals with no consumer-visible effect: `Encoding.encodeBase64` replaces a hand-rolled base64 helper, `Schema.revealCodec` replaces the two `as unknown as` casts in the BCS bridge, and the runtime type guards go through `Predicate`.

### Documentation

- **Extension authors:** the guide's claim that the halfway shape of a `Schema.decodeTo` into a domain class "must be an explicit interface" was wrong. `typeof Settlement.Encoded` is exactly that shape and compiles; only `typeof Settlement.Type` — the instance side — inverts the transformation. The template drops its hand-written `SettlementParts` for it, so there is one fewer interface per domain class and nothing left to drift.
- **Extension authors:** `outcome: Schema.tag("not_applied")` is documented beside the class-field form as the schema-visible way to declare an outcome — it is encoded without a patch-back, decodable back into an error, and visible to `Schema.is`. The class-field form keeps working and the template still uses it.
- **Extension authors:** every error in the template now defines a real `.message` — a getter over its own fields for two of them, the existing `message` schema field for the third — and the guide says plainly that `SuiError.toJson` emits a `message` key only for an error that has one. `Schema.TaggedError` leaves `.message` empty, so an error that defines neither logs as an empty string.
- The template's `Settlement` class identifier is `"escrow/Settlement"`, following the guide's own `"<package>/<Name>"` rule: an identifier is the class's runtime marker and its JSON-Schema `$ref` key, and two extensions with a `Settlement` class collided.
- README: the `SubmitConfig` override section shows `SubmitConfig.with` / `SubmitConfig.layer`.

## 0.1.2

Two defects from the first three downstream conversions, and the surface they
exposed. Nothing was removed. Two shapes changed: `Tx.reconcileAll` now returns
a tagged union, and `Tx.submit`'s error union gained `TransportError` for the
one case where a node refuses a submission outright.

### Fixed

- **`Tx.submit` no longer reconciles a submission the node refused.** A gRPC `INVALID_ARGUMENT` — malformed bytes, or a sponsored transaction carrying only the sender's signature — is the node answering that it did not execute anything, so it escapes as the `TransportError` it is. Reconciling it asked "is this digest on chain?" about a transaction that was never sent, and a lagging node (or a scripted `getTransaction`) could answer yes: an app's sponsored, under-signed submission was reported as a **successful `Executed`**. `SubmitError` therefore includes `TransportError`; every other transport failure still becomes `SubmissionUnknown`.
- **`SuiCoreFake` refuses an under-signed or wrongly-signed submission the way a validator does**, with an `RpcError` carrying `INVALID_ARGUMENT` rather than a plain `Error` that `mapSdkError` classified as a *retryable* transport failure. It checks the signature count and, when the signatures parse, the addresses they were made by. A sponsored submit against the fake needs `Tx.cosign` (or `Tx.run`'s `sponsor`) first, exactly as it does against a node.
- **The fake's resolver simulate is recorded**, so `SuiTest.calls("simulateTransaction")` sees the simulate that `Tx.build` promises, and it is answered by `FakeScript.buildSimulate` when there is one and by the ordered `simulate` script otherwise — `simulate: [FakeOutcome.failWith(...)]` now surfaces through `Tx.build` and `Tx.run` as `SimulationFailed` instead of vanishing.
- **Nothing in `src/` writes to stderr** (the one documented `console.warn` aside). A test captures stderr around a full `Tx.run` on the fake, with `bigint`s in the script, and asserts it is empty: the reported `console.error("DEBUG …", JSON.stringify(outcomes))` lines are in no published 0.1.1 artefact, but a `JSON.stringify` over a scripted `bigint` throws, and the throw surfaced later as an unrelated `FakeUnimplemented`.
- **Every error class has a real `.message`.** `Schema.TaggedError` leaves it empty, so anything surfacing `error.message` showed nothing; the classes without a `message` schema field now carry `override get message()` returning `SuiError.describe(this)`. It is a getter, so `SuiError.toJson`'s encoding is unchanged.
- **`SuiError.describe` accepts a foreign error** instead of returning `undefined` from an exhaustive `switch` while its signature promised a `string`. An extension's error, or any `{ _tag }`, gets its tag and message.
- **`SuiCoreFake.getBalance` is keyed by owner**, not by coin type alone. A `FakeBalance` may carry an `owner`; one without answers for every owner, which is what a pre-0.1.2 script meant.
- **`FakeOutcome.failWith` accepts sui-effect's decoded `ExecutionReason`** as well as the SDK's wire `ExecutionError`, encoding the first into the second. A fixture in the wrong shape used to decode-fail several calls later, on a different method, after the outcome cursor had already moved; it now throws where the fixture is written, naming both shapes.

### Added

- **`DecodeError.kind`**: `"type"` (the Move type was not the expected one — nothing was parsed, and the one a consumer may answer with a 404), `"bytes"` (the BCS parse failed or left trailing bytes — never safe to swallow), `"shape"` (a domain schema refused a parsed or JSON value). Every producer sets it, `SuiError.describe` prints it, and it defaults to `"shape"`, so an extension constructing a `DecodeError` without one still compiles. Branch on `kind`, never on `issue`.
- **`Tx.reconcileAll` returns a `Schema.TaggedUnion`**: `{ _tag: "Executed", executed }`, `{ _tag: "ExecutionFailed", error }`, `{ _tag: "NotApplied", error }`, `{ _tag: "SubmissionUnknown", error }`. The old bare union — an `Executed` with no discriminator beside three errors that had one — is exported as the deprecated type `ReconciledOutcome`.
- **`Tx.recorded(digest)`**: the journal entry for one digest, as an `Option`. `reconcileAll` returns **only** the entries that were unresolved, and this is how to ask about one that already settled.
- **`Tx.submitVia(signed, send)`**: the submission lifecycle when a relay or a sponsorship service does the sending. Journals `Signed` before calling `send`, calls it exactly once, decodes whatever it answers (an SDK `TransactionResult`, a reduced envelope, a bare digest, or nothing — in which case it asks the chain), reconciles an ambiguous failure with the full evidence rules, and journals the terminal answer. A `send` error whose instance declares `outcome: "not_applied"` fails straight through without a reconcile.
- **`Tx.run`'s `onSigned` hook**: called with the signed bytes after the last signature and before the first `executeTransaction`, inside the sender lock, for the record the journal does not hold. Its failure is a `JournalError` and fails the run with nothing sent.
- **`Executed.fromPartial(envelope)`**: an `Executed` from a reduced relay or sponsor envelope. `changedObjects` entries need only `objectId` and `idOperation`; what the envelope did not say stays `Unknown` rather than being guessed, and the accessors read `Unknown` as "not said" so `created()` and `deleted()` still classify. JSON spellings are accepted (`bcs` as base64 or a byte array, every `u64` as a number or a `bigint`). It cannot invent the `objectTypes` join, so the type-filtered accessors match nothing without it, and `gasUsedTotal` is `0n` for an envelope that reported no gas.
- **`Executed.fromTransactionResult(result)`** is public: the strict constructor, for an SDK `TransactionResult` read with the full include set.
- **`Event.json`**: kept when the source carried one, which in practice means a relay envelope whose events have no BCS. Never populated from a gRPC execute.
- **`SuiError.outcome(error, { phase: "pre-submit" })`** answers `"not_applied"` rather than `"unknown"` for an unclassified error, which is true by construction before anything is sent. The default is `"post-submit"`, the 0.1.1 behaviour. **`SuiError.isTaxonomy(error)`** answers whether an error is one of the tags this package owns.
- **`Sui.getObjectsStrict`**: `getObjectsOrFail` under a name that reads correctly in isolation. The old name stays as a deprecated alias of the same function.
- **`Signer.fromConfig` accepts a 32-byte hex seed** (64 hex characters, `0x` optional, read as Ed25519) as well as a Bech32 `suiprivkey`, so a raw seed from a secret manager no longer needs `fromHex` in application code.
- **`Signer.fromSdkSigner` validates its argument** and throws a `TypeError` naming the missing member. A double without `getKeyScheme` produced `scheme: undefined` and nothing complained until a validator did. Its JSDoc now states that `toSuiAddress()` and `getKeyScheme()` are read at construction, and that clear-signing inputs are the SDK signer's own concern.
- **`SuiLayerOptions.retry`**: a `Schedule` for the one `getChainIdentifier` a `Sui` layer makes. A `ManagedRuntime` memoizes its layer build, failure included, so one unlucky read at boot otherwise poisons a browser tab or a Worker isolate for its whole life.
- **`FakeScript.getObject`** (and `SuiTest.scriptGetObject`): scripted outcomes for a **read**, so a test can inject a transport failure, a miss or a timeout into `getObject`. An absent or exhausted script serves the object map as before.
- **`Script.report(exit, { stderr?, journal? })`**: the diagnostic lines and the unresolved-entry printing `Script.run` does at the end, returning the exit code, for a CLI that owns its own argv parser and process and cannot hand the entrypoint over.
- **`Script.run` prints each unresolved journal entry encoded through the `JournalEntry` schema** — the same JSON a durable journal stores, bytes base64 — beside the two human lines it already printed.

### Documentation

- The extension guide gains three sections: **"Application consumers"** (a module-level `ManagedRuntime` over `Sui.layerNoDepsWith({ chainId })` and `SuiCore.layerFromClient`, HMR disposal, the memoized-failed-build trap, the in-memory journal in a browser, mapping `outcome` onto UI states with the pre-submit caveat, signing with an external cosigner, and a `layerTest`-backed double for an app's own `runSui`), **"Workers and Durable Objects"** (no `process`, `ConfigProvider.fromEnvRecord(env)`, one runtime per isolate, the sender lock not crossing isolates and address-balance gas, DO alarms versus `Schedule` sleeps, and the whole `KeyValueStore.makeStringOnly` adapter over DO storage), and **"Relay and sponsor envelopes"** (`Executed.fromPartial`, what it cannot invent, and `Tx.submitVia`).
- A **"Sponsored by an external service"** recipe in the signers section: build with `Tx.sponsored`, sign, hand over the base64 bytes and the serialized signature, and reconcile by the digest — which a co-signature does not change.
- The testing section gains: `getTransaction` is what a submit test's reconcile reads (script `notFound` unless the test means "this landed"), a sponsored submit needs `Tx.cosign` and should assert the signature count on `SuiTest.calls("executeTransaction")`, which script slot answers the build's simulate, that `layerTest` asserts the built-in chain id for `mainnet` and `testnet`, how to inject a read failure, and why an isolated-consumer fixture in the package `tsconfig`'s `include` typechecks your code against the tarball it last installed.
- Error guidance: tag strings are namespaced by whoever defined them and must be copied from the installed package; `DecodeError.kind` replaces branching on `issue`; a wrapper error must copy the `outcome` and digest of what it wrapped, because `Script.exitCode` honours `outcome` first.
- Migration-table rows for a hand-rolled idempotent submitter, `sui.core.getTransaction` for a transaction that may have failed, a predecessor `ready()` genesis check mapping to `Sui.layerNoDepsWith({ chainId })`, and a removed standalone read export; plus the `.find(... type?.includes(...))`-then-throw grep pattern that `Executed.expectCreated` replaces, and the rule that a consumer-edit table is regenerated from the published `exports` map rather than from facade call sites.
- README: the `INVALID_ARGUMENT` rule, `onSigned`, `submitVia`, the `Reconciled` shape and `Tx.recorded`, `DecodeError.kind`, the error `.message` getter, `outcome`'s phase, relay envelopes and `Executed.events`' exact type, `bigint` at the JSON boundary, the `SubmitConfig` override idiom with `maxGasBudget`'s 50 SUI default and when `lockSender: false` is correct, and a section on applications, Workers and Durable Objects.

## 0.1.1

Seventeen fixes from the first downstream conversion. Nothing in the public API
was removed or renamed: an extension built against 0.1.0 compiles unchanged, and
the type-level workarounds it had to carry are now unnecessary.

### Fixed

- `PromiseFace<S>` recurses into **interface-typed** members, not only those assignable to `Record<string, unknown>`, so an interface-typed namespace (`readonly protocol: ProtocolService`) is mapped in the type the way the runtime has always mapped it — before this the face type said `Effect` where the value was a `Promise`.
- `SuiError.toJson` includes `outcome` when the error instance declares one, including the usual case where it is a class field rather than a schema field, so a log line carries the same axis `SuiError.outcome` and `Script.exitCode` read.
- The placeholder a **cold** member call returns is a real `Promise` subclass implementing `Symbol.asyncIterator`, so `instanceof Promise` holds and `expect(...).rejects` recognises it; its rejection is pre-handled, so a cold call nobody awaits no longer aborts the process with an unhandled `ExtensionNotReady`.
- A `warm` registration re-runs its warm build on the next use after `$dispose()` instead of degrading to a cold registration whose every synchronous member throws `ExtensionNotReady`.
- `mapSdkError` duck-types the SDK's error classes when `instanceof` fails — `reason` plus `objectId` for `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable`, `reason` plus `digest` for `TransactionNotFound`, the name plus `executionError` for `SimulationFailed` — so two copies of `@mysten/sui` in one process no longer turn every one of those tags into `TransportError { status: "notFound" }`, and the first such failure logs one warning naming the real problem.

### Added

- `SuiExtension.Leaf<T>` and `SuiExtension.leaf(value)`: the marker an extension puts on a class-instance member the Promise face must pass through whole rather than recurse into. `Uint8Array`, `Date`, `Promise`, arrays and BCS codecs (`parse` plus `serialize`) are recognised without it.
- `SuiAddress.normalize(input)` and `ObjectId.normalize(input)`: decode-and-brand from any spelling the SDK accepts, which is what `"0x1"` needs and what `.make` (validate without decoding) refuses.
- `SuiSchema.decodeWith(bcsType, expectedType, map)`: a BCS layout plus a throwing mapper into a domain value, as one codec, so an extension stops hand-rolling `Effect.try` around `Schema.decodeUnknownEffect` and losing the `DecodeError`.
- `layerExtensionTest(layer, script, { extra })`: extra dependency layers for an extension whose layer requires more than the client could provide, with `SuiGraphQL.layerUnavailable` merged in by default.
- `FakeScript.coinMetadata`, so `getCoinMetadata` is testable on the harness; an unscripted coin type answers `{ coinMetadata: null }` the way a node does.
- `CHANGELOG.md`, shipped in the package's `files`.

### Documentation

- The extension guide gains: the sanctioned idiom for a standalone function that needs a sibling extension's service, a worked generic-Move-type example on the fake, the `bun install --force` step after re-packing a vendored tarball with an unchanged filename, that `waitForTransaction` outcomes are driven by `FakeScript.getTransaction`, that a `warm` registration throws **any** layer failure synchronously out of `$extend`, and what a cold placeholder is now that it is a real `Promise`.
- `SuiGraphQL`'s JSDoc states that `yield* SuiGraphQL` yields the `SuiGraphQLClient` itself and that the service type is `SuiGraphQL["Service"]`.

## 0.1.0

Initial release: two client tiers (`SuiCore`, `Sui`), a closed error taxonomy,
the transaction lifecycle as functions with typed outcomes (`Tx`), the journal,
the `Script` preset, the BCS bridge and branded schemas, `SuiExtension.fromService`
for the Promise face of an Effect service, `SuiGraphQL` as a bare tag, and the
in-memory fake with its test layers.
