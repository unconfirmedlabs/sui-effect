# Agent guidance

`DESIGN.md` is the specification and wins over everything else (it ships in the
package beside this file). Where this file and the spec disagree, fix this
file.

sui-effect is a light Effect v4 wrapper around the official `@mysten/sui` SDK
that makes it safer to use: closed error unions with outcomes, cancellation and
spans on every call, decoded reads, and a crash-safe transaction lifecycle.
0.6.0 removed the wallet core it had grown (intents, account signers, a
keystore, portable storage, Enoki, a script preset, a Promise face for SDK
extensions); do not add any of it back.

## Ground rules

- **Effect v4, stable `4.1.x` (peer `>=4.1.1 <4.2`, developed against `4.1.1`).**
  No release candidate is supported: rc.113 renamed `Config.nonEmptyString`,
  `Config.string` and `Config.redacted` to `Config.NonEmptyString`,
  `Config.String` and `Config.Redacted`, and rc.118 moved `effect/unstable/*` to
  `effect/*`. v3 names
  are compile errors. Never
  write an Effect name from memory: verify it in `node_modules/effect/dist/*.d.ts`.
  For contributors, the maintainers' house skill `effect-ts` (part of their
  agent setup, not shipped in the package) and its review checklist are
  binding.
- **SDK names are the source of truth.** Read
  `node_modules/@mysten/sui/docs/llms-index.md` first, then the version-matched
  page, then confirm the signature in `node_modules/@mysten/sui/dist/**/*.d.mts`.
- Everything that is not public API lives in `src/internal.ts`, which is not in
  the `exports` map. `src/index.ts` is exactly the public surface.
- **Every public name mirrors the SDK name it wraps**, so an agent that knows
  `@mysten/sui` can guess @unconfirmed/sui-effect.
- **The scope is a wrapper.** sui-effect wraps the SDK and makes it safer; it
  is not a wallet, a CLI framework or a plugin system. Application concerns
  (declared intents, account and session management, key storage, sponsorship
  providers, process entrypoints) belong to the application. Before adding a
  member, ask whether the SDK already does it and whether this package already
  has one way to do it; if either, do not add it (DESIGN §0).
- Nothing under `src/` imports `@effect/platform-*`, `bun:*` or `node:*`, and
  nothing names a DOM or other platform type: the package runs in a browser, a
  Worker and Node alike, and WebCrypto is reached through `globalThis.crypto`.
  `@effect/platform-bun` is a devDependency for tests and examples only.
- No `Effect.runPromise` / `runSync` under `src/`: every edge is the caller's.
- No `any`. No `unknown` in an error channel. No `console.log` in `src/`. The
  one `console.warn` is `SuiCore.mapSdkError`'s duplicate-SDK warning, which
  fires at most once per process and is documented where it lives. **Nothing in
  `src/` writes to stderr otherwise on its own** — `test/release-0-1-2.test.ts`
  captures it around a full `Tx.run` on the fake and asserts it is empty.
  Library log lines go through the Effect logger in force, whose default writes
  to **stdout** (`console.log`), so a CLI whose stdout is machine output
  installs a logger of its own. A successful run logs nothing at the default level `Info`:
  the visibility-timeout line is **debug** (0.5.0; a warning broke `--json`
  output on a run whose outcome stood), and warnings and errors are kept for a
  journal read or write that failed, an interrupt during the visibility wait, a tail's
  retry and a re-send that was not made. A new log line on a path that
  succeeds is debug.
- **A branded id from a shorthand spelling** comes from `SuiAddress.normalize`
  / `ObjectId.normalize` (decode, then brand); `.make` validates without
  decoding and is for the padded form only. Neither is for a value that came
  from outside: that goes through `Schema.decodeUnknownEffect` — of
  `SuiAddress` / `ObjectId` for a node or config value (pads; refuses `""`, a
  bare `0x` and non-hex since 0.4.0), of `SuiAddress.Strict` /
  `ObjectId.Strict` for a value a human typed (exactly 64 hex digits, same
  brand). `CoinType.normalize` / `StructTag.normalize` and `CoinType.SUI` are
  the Move-type equivalents; the `Sui` reads that take a type, and
  `Executed.balanceChange`, accept a plain string and normalize it.
- **One Move type rule.** `typeMatches(expected, actual)` (`src/domain/bcs.ts`)
  is the only comparison: a bare expected tag matches every instantiation of the
  generic, a parameterized one is compared in full after normalization. The
  bridge, `expectedType`, `SuiSchema.decode`'s `actualType` and the fake's
  owned-object filter all go through it, and so must anything new.
- **A `TransportError` for your own transport** comes from
  `TransportError.fromUnknown(method, cause, retryable?)`, never from
  hand-building the three fields.
- Every public function carries a JSDoc block that **states its error union in
  words** ("Fails with: `ObjectNotFound`, `TransportError`."), so `LLMS.md` can be
  generated from the source.
- Every dependency is a `Context.Service` with static layers (`layer`,
  `layerNoDeps`, `layerConfig`, a test layer). Every error is a
  `Schema.TaggedError`. Schema decodes at every boundary. Time comes from
  `DateTime`/`Clock`, randomness from `Random`, config from `Config`.
- Every service method is `Effect.fn("Service.method")`, which names its span.
  The only exceptions are `Sui.getObject`, `getObjectOption`, `getObjects`,
  `getObjectsStrict`, `getDynamicFieldOption` and
  `getDynamicObjectFieldOption`, and `Verify.verifyTransactionSignature`
  (0.6.0: `PolicyDenied` only under `checkAddressAliases: true`), whose declared types
  are overload sets `Effect.fn` cannot express; their implementations are still
  `Effect.fn`. Internal helpers that are not a tracing boundary are
  `Effect.fnUntraced` and open no span: the journal entry builders in `Tx.ts`,
  `Tx.run`'s front half (`frontHalf`, `simulateBuilt`), anything that runs once per item (`Sui`'s object decode,
  `Executed.fromTransactionResult`, the in-memory journal's `put`/`get`), the
  nested `simulateRaw`/`fromSimulationResult`, and the reconcile helpers that
  wrap one `SuiCore` call that already has a span (`inputStateOf`,
  `consumedVersionOf`, `currentEpoch`, `expiryClosed`). What such a helper
  learns goes on the enclosing span (`Sui.getObjectsPage` carries
  `sui.decode_failures`). Public members and real boundaries (`Tx.recover`,
  `Tx.inputEvidence`, `Tx.historyOf`, `Sui.getObjectsPage`) keep theirs.
- **Metric names and their attribute keys are a public contract** (README,
  "Metrics"). They live in `src/domain/metrics.ts`, every one prefixed
  `sui_effect_`, and **every attribute value comes from a closed set** (a
  result, an evidence kind, a `SuiCore` method name, a transport status, who
  simulated) — never a digest, an address, an object id or a coin type. A new
  metric is added there, documented in the README table, and tested under a
  fresh `Metric.MetricRegistry`.
- Every SDK call forwards the Effect's `AbortSignal` into the SDK's `signal`
  option, so `Effect.timeout` and interruption cancel the request.
- Tests run on `bun test` with `effect/testing` (`TestClock`, `TestSchema`).
  Tests provide their own layers and never touch the network, with one gated
  exception: `test/live.devnet.test.ts` runs against devnet behind `SUI_LIVE=1`
  and is the only proof that a default-built transaction is accepted by a real
  validator. Localnet tests sit behind `SUI_LOCALNET=1` (`SUI_LOCALNET_URL`,
  `SUI_LOCALNET_FAUCET` override the endpoints). A test that runs
  `Tx.submit` or `Tx.run` provides `Journal.layerMemory`, because the default
  journal is process-wide.
- Done means `bun run check` (typecheck, build, tests) is green. `LLMS.md` is generated — `bun run build &&
  bun run llms` after any public signature, JSDoc or example change, because the
  generator reads the emitted `.d.ts` in `dist/`, and a test fails if it is
  stale. Without `dist/` that test **skips** with a warning rather than
  failing, so a bare `bun test` does not prove `LLMS.md` current; `bun run
  check` builds first. Its head is `docs/llms-head.md`, whose
  `<!-- recipe: path -->` lines quote `examples/recipes/*.ts` and
  `test/recipes/fake.test.ts` verbatim (relative `src/` imports rewritten to the
  package subpaths); `test/recipes.test.ts` runs those recipes on the fake.

## The two read tiers

| Tier | What it is | When to use it |
|---|---|---|
| `SuiCore` | A 1:1 Effect wrap of `ClientWithCoreApi`. One member per `SuiClientTypes.TransportMethods` key plus `getObject`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction`, `getServiceInfo` (gRPC's `ServiceInfo`, with `lowestAvailableCheckpoint`; `UNIMPLEMENTED` on other transports) and `use`, plus `readPolicy(method)`, the effective read retry `Schedule` for a read made outside the members (optional on the interface so a `Layer.mock` need not supply it). `Include` generics preserved. Every read has a per-attempt `requestTimeout` (30 s by default, `"Infinity"` off, `SUI_RPC_TIMEOUT` under `layerConfig`) that ends in a retryable `DEADLINE_EXCEEDED`, and a `readRetry` schedule option. An SDK caller-argument error (a malformed filter, an unpaginable function filter, `after` with `before`) is a defect, not a `TransportError`. | Reaching a field or method `Sui` does not expose, and paging with your own cursor (`listEvents`, `listTransactions`). |
| `Sui` | The convenience tier over `SuiCore`: fixed include sets, decoded BCS content, `Option` where absence is normal (`getObjectOption`, `getDynamicFieldOption`, `getDynamicObjectFieldOption`, `getCoinMetadataOption`, `resolveNameServiceAddressOption`, `defaultNameServiceNameOption`), chunked and integrity-checked batch reads (`getObjects` per-item `Result`, `getObjectsStrict` first-error-wins; `getObjectsOrFail` was removed in 0.4.0), `Stream` pagination (`streamOwnedObjects`, `streamDynamicFields`, `streamCoins`, `streamBalances`, `streamEvents`, `streamTransactions` — the last yields `Result<Executed, ExecutionFailed>` per entry, and both ledger streams follow `hasNextPage`, not the page's item count, and take `after`/`before`; `tailEvents`/`tailTransactions` never end, poll (1 s), retry retryable errors from the last cursor, and advance a filtered cursor to the unfiltered head so a pruning node does not strand it, which is sound only against a single sticky node), `getDynamicFieldOption(parent, name, { schema })` decoding the value, `simulate`/`view` over a `Recipe`, `Transaction` or bytes. The `…Pages` streams were removed in 0.6.0: a reader that commits its cursor pages with `sui.core.list…`. A transaction stream's `function` filter must be fully qualified (`pkg::module::function`); a `pkg` or `pkg::module` filter is refused up front, and one page of it is `sui.core.listTransactions`. The transaction streams also take `{ affectedAddress }` (0.5.0, `AffectedAddressFilter`): the gRPC ledger's predicate, incoming transfers included, digests listed then each read with `getTransaction`; any other transport fails it with a non-retryable `TransportError { status: "UNIMPLEMENTED" }`, never a sender-only answer. `Balance`/`Coin` amounts are `CoinAmount` (plain `bigint`, the coin's own unit; `Mist` only for gas), and `CoinType.Strict` decodes a coin type a person typed. | Almost all application code. |

**`Sui` members are positional; `SuiCore` members take the SDK's options
object.** `sui.getObject(id, { schema })`, `sui.getBalance(owner, coinType)`,
but `core.getObject({ objectId, include })`. An agent that knows the SDK writes
`sui.getObject({ objectId })` first; it does not typecheck.

**The SDK's `listX` is `Sui.streamX`**: `listOwnedObjects` → `streamOwnedObjects`,
`listCoins` → `streamCoins`, `listBalances` → `streamBalances`,
`listDynamicFields` → `streamDynamicFields`, `listEvents` → `streamEvents` (and
`tailEvents`), `listTransactions` → `streamTransactions` (and
`tailTransactions`). `SuiSchema.name(codec, key)` builds a dynamic-field key
from one description of its type and bytes.

Reads go through `Sui`; writes go through `Tx`. Nothing calls
`SuiCore.executeTransaction` directly. `Sui` exposes the `SuiCore` it was built
over as `sui.core`, which is what lets every `Tx.*` function declare `R = Sui`
and nothing else.

## The lifecycle

| Name | What it is |
|---|---|
| `Signer` | A credential as a **value**, never a service: `{ address, scheme, maxEpoch?, alias?, signTransaction, signPersonalMessage }` (`maxEpoch`: the last epoch a bounded credential — a zkLogin proof — signs for; `alias`, 0.6.0: the key's address when the signer signs as `address` through its alias set). One process may hold two. It **only signs**: build, simulate, approval, journal and submission are `Tx`'s. A refusal says why when it knows: `SigningError.reason` is `"expired"`, `"rejected"` or `"unavailable"` (`SigningFailureReason`). Secret material never reaches the value. `SignatureScheme` is the SDK's own type, re-exported. Constructors: `fromSdkSigner` (any SDK signer, the SDK's `PasskeyKeypair` included), `fromKeypair`, `ephemeral`, `remote` (KMS, HSM, another process), `fromSecretKey` (Bech32 of any scheme — `MLDSA65` through a dynamic import, because the peer range admits SDKs without that subpath — a hex seed or bytes, **copied before building**: the SDK's ECDSA keypairs alias the caller's buffer), `fromMnemonic` (the BIP-39 word list and checksum checked **before** the SDK's `deriveKeypair`, which checks neither; standard paths from `derivationPath`), `generateMnemonic` (`crypto.getRandomValues`, never `Random`), `zkLogin({ address, ephemeralSigner, inputs, maxEpoch })` (the SDK's option names; signature assembly only, refusing bytes whose `minEpoch` is past `maxEpoch`), `multisig`, `alias`. A refused key is `KeyError` (declared `not_applied`), never quoting the input. There is no lockable or wiping signer and no session store (removed in 0.6.0). |
| `Tx.build/sign/cosign/fromBytes/attach/sponsored/gaslessStablecoinTransfer/sendFunds/planFold/fold/foldCoins/verifySponsored/submit/submitVia/reconcile/resubmit/run/reconcileAll/withSenderLock` | The lifecycle and canonical recipe helpers as functions, each Effect with a closed error union, all `R = Sui`. `Tx.build` always simulates before anything is signed: when the SDK's resolver will not, it runs one explicit simulate. `gaslessStablecoinTransfer` is the SDK's `tx.balance()` → `balance::send_funds` recipe and leaves eligibility and zero-gas selection to gRPC/GraphQL resolution; `{ requireZeroGas: true }` fails the build unless the resolved price and budget are 0. `fromBytes(bytes)` is a `Built` from bytes somebody else built (chain and expiration read off them; other-chain bytes refused) and `attach(builtOrSigned, signature)` adds a verified signature by the sender or the gas owner (or an alias of either: `PolicyDenied { rule: "alias.signer" }` otherwise) — with `cosign` and `submit`, the stateless sponsor. `verifySponsored(built, { sender, gasOwner?, transactionKind? })` (also flat on `/tx`) is the sender's check on sponsored bytes (`PolicyDenied`, rules `sponsored.*`). `submitVia` is `submit` for a submission somebody else makes; `resubmit(signedOrUnknown)` re-sends identical bytes, and `reconcileAll({ resubmit: true })` does it for every entry still unknown; `Journal.get(digest)` reads one entry (0.6.0 removed `Tx.recorded`). `Tx.run` takes `onSigned` (between the last signature and the first send) and `approve(prepared)` (after `preflight`, before the first signature, under the lock exactly when signing is; refusing is the caller's `E`, nothing signed or journalled); `Prepared` is `{ built, simulation }` and there is no public `Tx.prepare`. **Gas comes from the payer's SUI address balance by default** (span attribute `sui.gas_payment`). `sendFunds({ coinType?, amount, recipient })` is a `FundsWithdrawal` → `balance::redeem_funds` → `balance::send_funds`, **address balances only**; `planFold`/`fold`/`foldCoins({ signer, plan?, approve? })` move coins into the balance, SUI paying for its own fold. `withSenderLock(address)(effect)` is the sender lock `Tx.run` takes (0.6.0; was `Sui.withSenderLock`): one reference-counted semaphore per normalized address per `SuiCore`. `Signer.maxEpoch` (and the sponsor's) caps the default window via `Tx.build`'s `maxEpoch`; a passed one is `SigningError { reason: "expired" }` before anything resolves. |
| `Built` / `Simulation` / `Executed` | `Built.gas { budget, price, owner, payment, source }` is read from the bytes by `build` and `fromBytes` and is required; `Built.simulation` exists only when `Tx.build` simulated exactly the returned bytes (never on gRPC), and is reused only when `Tx.build` made it in this process for the digest of these bytes. Neither reaches `Signed`. `Simulation` is a `Schema.Class` sharing **one** accessor implementation with `Executed` (`created`, `createdWhere`, `mutated`, `deleted`, `wrapped`, `transferred`, `packagesPublished`, `balanceChange`, `gasUsedTotal`, `expect*`, `eventsOf`), all skipping `AccumulatorWriteV1`; `Executed.sender` is filled from the bytes. DESIGN §4, §6. |
| `Verify` | `Verify.verifyTransactionSignature(bytes, signature, opts?)` and `Verify.verifyPersonalMessageSignature(message, signature, opts?)`: the Effect face of `@mysten/sui/verify`, `R = Sui`. They answer the signer's public key; with `{ address }` the signature must also be that address's. An invalid signature is `SigningError`; a check that could not reach the node is `TransportError`, never a verdict. `{ address, checkAddressAliases: true }` (transactions only) is a validator's sender check: always one read of the `AddressAliases` object, else `PolicyDenied { rule: "alias.signer" }`. |
| Address aliases (0.6.0) | `AddressAlias` on `/tx` (`src/services/AddressAlias.ts`; the pure half — `aliasesId`, the BCS, `AddressAliases`, `allows` — is `src/domain/address-alias.ts`, which the fake imports): `aliasesId(address)`, `getAliases(address)` → `AddressAliases` (`NotEnabled` / `Enabled { id, version, aliases }`), `requireSigner(address, signer)`, and the recipes `enable`, `add`, `remove`, `replaceAll`. Always the **object**, never transaction history. `Signer.alias(A, signer)` signs **as** A; everything keyed on the sender — build, sender lock, in-flight registry, `Built.sender`, the journal's `signed.sender` — is A's. `Tx.run` reads the set once per alias signer (or alias sponsor) before the build; a plain signer costs no read. `Tx.sign`/`cosign` stay offline. `Signer.multisig(publicKey, signers)` combines **in member order** (the SDK keeps the order it is given and validators pair the n-th signature with the n-th bitmap bit). DESIGN §14. |
| `SubmitConfig` | A `Context.Reference`: expiration policy, the optional `validFor`, the gas-budget ceiling (`maxGasBudget`), `preflight`, the sender lock (`lockSender`: `"whenPinned"` default, `"always"`, `"never"`), `gasPayment` (`"preferAddressBalance"` default, `"requireAddressBalance"`), the resubmit schedule, attempts, timeout and expiry margin, `expiryEvidence`, `reconcileRecheck`, `awaitVisibility`, `visibilityTimeout` and `nonce`. **`SubmitConfig.with` merges over the config in force**; `SubmitConfig.layer` spreads over the defaults. Overrides take `Duration.Input`. |
| `Journal` | A `Context.Reference` with an in-memory default (`put`, `get`, `listUnresolved`). `@unconfirmed/sui-effect/journal` swaps in a durable one over any `KeyValueStore`: `layerKeyValueStore`, `makeKeyValueStore` and `pruneSettled(before, { prefix? })` are **module functions**, not statics on `Journal`. One key per entry, listed through `KeyValueStore.keys`; a terminal entry carries a `settled:<digest>` marker so a listing reads only unmarked entries. The marker's write order is the invariant (DESIGN §8). `Tx.reconcileAll()` is the explicit startup call. |
| `SuiGraphQL` | A bare tag over the SDK's `SuiGraphQLClient` (`layer`, `layerConfig`, `layerUnavailable`). sui-effect wraps no GraphQL API. `SuiGraphQL.query(run, method?)` hands `run` the Effect's `AbortSignal`. |

## The error taxonomy

Every failure is one flat tag; there is no error inheritance.

| Tag | Means |
|---|---|
| `TransportError` | The request did not reach a usable answer. `retryable` says whether a read may try again. A node reply that did not decode is a `TransportError` whose `cause` is a `DecodeError { kind: "shape", issues }`. |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | The three `ObjectError.reason` values. |
| `TransactionNotFound` | No transaction with that digest is known. |
| `NetworkMismatch` | The node is on another chain than the layer was built for. |
| `DecodeError` | BCS content or a schema boundary did not decode. `kind` is `"type"` (tag mismatch, nothing parsed; `actualType` says what it was), `"bytes"` (BCS parse or trailing bytes) or `"shape"` (a domain schema). Every producer sets it; consumers branch on it, never on `issue`. |
| `SimulationFailed` | Simulation reported an execution failure. No gas charged. Carries `command` when the node named one. |
| `ExecutionFailed` | Applied on chain and failed. Gas charged (none for `InsufficientFundsForWithdraw`, an overdrawn balance). |
| `SubmissionUnknown` | Bytes may have been sent; the outcome is unknown. Carries the signed bytes, unless it came from reconciling a bare digest. |
| `NotApplied` | Provably never applied. `expired`: the expiry window was observed closed and the transaction missing, twice, `reconcileRecheck` apart. `inputConsumed`: a **different** transaction's own effects report `inputVersion` equal to the version the bytes pinned. `refused`: the node refused the first send outright (`INVALID_ARGUMENT`), or a `submitVia` sender error declared `not_applied`. An input that merely moved on is not evidence. |
| `SigningError` / `BuildError` / `PolicyDenied` / `JournalError` / `UnexpectedEffects` | Signing (with `reason?`, 0.5.0); building (including resolver refusals and an address balance below the budget); preflight policy, the gas ceiling (`rule: "maxGasBudget"`) and a signer outside an address's alias set (`rule: "alias.signer"`, 0.6.0); the journal; and effects that did not contain what was expected. |
| `GraphQLUnavailable` | No usable GraphQL endpoint. `not_applied`. |

`KeyError` sits outside the taxonomy and **declares** `outcome:
"not_applied"`: a refused phrase, secret key or path, or a multisig signer set
(`invalidMultisig`).

`SuiError.outcome(e)` puts every failure on the axis a caller acts on:
`"applied"` for `ExecutionFailed` and `UnexpectedEffects`, `"unknown"` for `SubmissionUnknown`,
`"not_applied"` for every other tag in the taxonomy, and `"unknown"` for
anything that is neither one of those tags nor declares an `outcome`. An error
of your own may declare its own `outcome`, and should. `SuiError.outcome` also takes `{ phase: "pre-submit" }`, which changes only the
unclassified answer (`"not_applied"` instead of `"unknown"`, true by
construction before a send). `SuiError.isRetryable`, `SuiError.isTaxonomy`,
`SuiError.describe` (one actionable line, and total over foreign errors;
`{ tag: false }` drops the tag), `SuiError.toJson`, `SuiError.digestOf`,
`SuiError.moveAbort` (`Option<MoveAbortInfo>`) and
`SuiError.isMoveAbort(e, { package?, module?, function?, constant?, code? })`
round it out — every one takes `unknown`. After an upgrade an abort's
`package` is the **latest** package id. `describe` prints an `Unknown` reason's
node sentence (`ExecutionReason.Unknown` carries `message` and `command`), a
clever abort as `CONST "value" (line N)` and never the packed code, a
`BuildError`/`SigningError`/`JournalError`/`SubmissionUnknown`'s cause, and a
`ConfigError` as `missing NAME`; it never prints bytes. **Every error class without a `message` schema
field carries `override get message()` returning `describe(this)`**, so
`.message` is never empty; it is a getter, so it stays out of the encoding — and `toJson` adds `outcome` from the instance
when the error declares one, which is almost always a class field rather than a
schema field.

## Testing

`@unconfirmed/sui-effect/testing` ships `SuiCoreFake.layer(script)`, `layerTest(script)`
(the real `Sui` over the fake `SuiCore`; a service built on `Sui` composes
`MyService.layer.pipe(Layer.provideMerge(layerTest(script)))`) and `SuiTest` (`putObject`, `bumpVersion`,
`recordTransaction`, `deleteObject`, `setClock`, `setEpoch`, `scriptExecute`,
`scriptSimulate`, `scriptGetObject`, `scriptGetTransaction`, `setVisibilityDelay`, `calls`,
and `provide(layer)`, which provides a layer with a fresh `Journal.layerMemory`
and `TestClock`, all `{ local: true }`), which is the whole harness. `layerTest` puts `testSubmitConfig` in force — a
resubmit schedule with no delay — so a re-send test does not sleep on the real
clock; a `SubmitConfig.with` inside the test wins. Fixtures: `fakeDigest(n)` is
a branded `Digest`, `fakeCoin({ objectId, owner, balance, … })` a coin with no
cast, and a `FakeEvent`'s `json` is optional. Call recording is reached through `SuiTest.calls`,
not off the fake handle. The fake serves in-memory objects with
BCS content, the Clock object `0x6`, and scripted outcomes
(`FakeOutcome.succeed`, `failWith` — which takes the SDK's wire `ExecutionError`
**or** sui-effect's decoded `ExecutionReason`, encoding the second and throwing
on anything else — `transportError`, `notFound`, `timeoutThen`)
(`transportError(status, message?)` carries the node's message) for simulate, execute, `getObject` (read-failure injection), `getTransaction` —
which is also what drives every
`waitForTransaction` outcome (an executed transaction is visible at once unless
`FakeScript.visibilityDelay`, in `TestClock` milliseconds or `"never"`, holds
the wait) — `coinMetadata`, and the resolver's budget simulation
(`buildSimulate`, which is how a test makes `Tx.build` fail with
`SimulationFailed`, and which since 0.5.0 also answers a later simulate when
`simulate` is not scripted; with neither, that simulate dies naming
`SuiTest.scriptSimulate`). A scripted `FakeScript.ledger` (`{}` is enough) also
serves the gRPC ledger's `affectedAddress` listing from the fake's history.
`TestServices` names what `layerTest` provides. Two journal layers share one
memory store when the store is built once and handed over as a value
(`Layer.succeed(KeyValueStore.KeyValueStore, store)`; the tag is itself the
Effect — it has no `.asEffect()`). It records every call so a test can
assert the include set that was sent, and serves an object's `json` and
`display` (`FakeObject.json` / `.display`, `null` when unset) only when the
include set asks for them (0.5.0), and a transaction's `bcs` include as the
bytes it executed (or, for one scripted by digest with a `sender`, a minimal
transaction naming it), which is how `Executed.sender` is read on the fake;
`FakeChange.inputOwner` scripts an input's owner for `transferred()`. It also implements
`resolveTransactionPlugin` and `listCoins`, so `transaction.build({ client })`
against the fake's `client` resolves gas and object inputs from the script with
no network, and it keys transactions by
`TransactionDataBuilder.getDigestFromBytes` of the bytes it was handed — **an
execute outcome scripted with any other digest stops the test with a defect**,
because no node answers one transaction with another's digest. Any
method the script does not cover dies with a message naming it: a test never
silently passes against a stub. Its `client` implements `$extend`, so an SDK client
extension runs on it as on a real client; `listOwnedObjects`
filters through `typeMatches` rather than string equality, and `getDynamicField`
matches an entry on **both** `name.type` (under `typeMatches`) and `name.bcs` — an entry scripted
without `bcs` still matches any key of its type, so two same-typed keys on one
parent can be told apart and a test can prove which key bytes a lookup used.
`FakeScript.transactions` (and `SuiTest.recordTransaction`) answers
`getTransaction` **by digest**, before the ordered script, which is what a
`NotApplied { inputConsumed }` test needs: the rule reads
`changedObjects[].inputVersion` off the consuming transaction, and
`FakeChange.inputVersion` is how a test says which version that was.
`listTransactions` and `listEvents` page through the fake's **ledger** — the
transactions scripted by digest, then each one recorded or executed as it
lands — filtering on the sender and Move calls read off the bytes (or
`FakeExecution.sender` / `moveCalls` for one scripted by digest);
`FakeScript.scanLimit` bounds how many ledger items one request examines, so a
test can prove a consumer paginates on `hasNextPage` rather than the item
count. `getDynamicObjectField` serves a `$kind: "DynamicObject"` entry's
child from the object map, and `FakeScript.names` answers
`resolveNameServiceAddress` and `defaultNameServiceName`.
`FakeScript.ledger { lowestAvailableCheckpoint?, firstCheckpoints? }` serves
the client's `ledgerService` (`GetServiceInfo`, `GetEpoch`) for reconcile's
pruning guard; unscripted, the client has none, like a JSON-RPC transport. A
read the fake never answers (a `timeoutThen` on a read) ends in `SuiCore`'s
30 s per-attempt `requestTimeout` — a retryable `DEADLINE_EXCEEDED`, then the
read retries — once a test advances `TestClock` past it; a test that means
"hangs until interrupted" interrupts sooner. `FakeScript.readOptions`
(`SuiCoreReadOptions`: `requestTimeout`, `readRetry`) builds the fake's
`SuiCore` the way a layer's options would, so a custom read policy — and
`Tx.build`'s resolver retry under it — is testable on the fake. A scripted
`commandResults` entry may give either array; the missing one defaults to `[]`
rather than failing a `Simulation` decode.

**The fake models address alias sets** (0.6.0): `FakeScript.addressAliases`,
`SuiTest.setAddressAliases(address, aliases | undefined)` and
`SuiTest.addressAliases(address)` over an `AddressAliases` object at the derived
id; `0xa` is served as the shared `AddressAliasState`; a successful execution
follows `0x2::address_alias::enable`/`add`/`remove`/`replace_all` (no Move
aborts); and the signature check resolves aliases for the sender and gas owner —
a required address with a set is covered only by a member, a multisig signature
counts as its multisig's address (zkLogin still stands the address check down).
No signature is verified cryptographically: member order is proved by `Verify`
locally and by `test/live.localnet-alias.test.ts` on a validator.

The fake enforces the invariants the lifecycle depends on: a known digest
executes idempotently, gas selection excludes object inputs, the coin set
evolves (deleted, mutated with `FakeChange.balance`, gas-bumped, created), a
submission whose signatures do not cover the addresses the bytes name — by count
**and** by the addresses recovered from the signatures — is refused the way a
validator refuses it (an `RpcError` carrying `INVALID_ARGUMENT`, so `Tx.submit`
fails fast instead of reconciling into a scripted success), and a
version history is served through `tryGetPastObject`, which is what
`SuiCore.getObjectAtVersion` reads. The resolver mirrors the SDK's core
resolver: its budget simulate runs only when the budget is unset, is recorded
as a `simulateTransaction` call (`resolver: true`) and answered by
`FakeScript.buildSimulate` when there is one and by the ordered `simulate`
script otherwise, so "building always simulates" is observable on the harness.
`getBalance` and `listBalances` are keyed by owner and coin type; a `FakeBalance`
with no `owner` answers for everyone, and an unscripted owner gets zero — so a
sponsored (empty-payment) build on the fake needs a balance whose
`addressBalance` covers the budget, or `Tx.build` fails with `BuildError`.
**The fake models address balances** (since 0.4.0): one per owner and coin type,
seeded from `FakeScript.balances[].addressBalance`, set with
`SuiTest.setAddressBalance(owner, amount, coinType?)`, read with
`SuiTest.addressBalance(owner, coinType?)`. Its resolver mirrors the SDK's
`setGasPayment`: `[]` when `tx.gas` is unused and the payer's SUI balance covers
budget plus withdrawals (so an owner-less `addressBalance` seed beside coins
means balance gas; script `addressBalance: "0"` for the payer to keep coin gas),
a coin-reservation ref ahead of the coins for a `tx.gas` user with a balance,
coins otherwise, and with neither it throws the SDK's "No valid gas coins found
for the transaction." (`BuildError`). Executions charge net gas to the balance,
debit `FundsWithdrawal`s, follow `coin::send_funds`/`balance::send_funds`
deposits and delete consumed coins; like a node it refuses (`INVALID_ARGUMENT`)
an empty payment or withdrawal the balance cannot cover and empty-payment bytes
with no owned input and no `ValidDuring` expiration.
