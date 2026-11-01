# Agent guidance

`DESIGN.md` is the specification and wins over everything else (it ships in the
package beside this file); `docs/PLAN.md` is the original work plan, in the
repository only (its version pins are historical; `package.json` is current).
Where this file and the spec disagree, fix this file.

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
- Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `@effect/platform-bun`
  is a devDependency for tests and examples only.
- No `Effect.runPromise` / `runSync` under `src/`, except at the two documented
  edges: the Promise facade of `SuiExtension.fromService`, and `Script.run`,
  which is a process entrypoint and whose whole job is to fork the root fiber,
  await its `Exit` and exit. `Script.report` is the tail of `run` for a CLI that
  owns its process; its one `Effect.runPromise` (`readUnresolved`, reading the
  journal's unresolved entries) sits at that same process edge. `Script.run`
  does not call it: `run` ends in the internal `reportRun`, over the run
  record of the entries its own program wrote.
- No `any`. No `unknown` in an error channel. No `console.log` in `src/`. The
  one `console.warn` is `SuiCore.mapSdkError`'s duplicate-SDK warning, which
  fires at most once per process and is documented where it lives. **Nothing in
  `src/` writes to stderr otherwise** — `test/release-0-1-2.test.ts` captures it
  around a full `Tx.run` on the fake and asserts it is empty.
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
  `getDynamicObjectFieldOption`, whose declared types
  are overload sets `Effect.fn` cannot express; their implementations are still
  `Effect.fn`. Internal helpers that are not a tracing boundary are
  `Effect.fnUntraced` and open no span: the journal entry builders in `Tx.ts`,
  anything that runs once per item (`Sui`'s object decode,
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
  validator. Localnet tests sit behind `SUI_LOCALNET=1`. A test that runs
  `Tx.submit` or `Tx.run` provides `Journal.layerMemory`, because the default
  journal is process-wide.
- Done means `bun run check` (typecheck, build, tests, and the extension
  template's own check) is green. `LLMS.md` is generated — `bun run build &&
  bun run llms` after any public signature, JSDoc or example change, because the
  generator reads the emitted `.d.ts` in `dist/`, and a test fails if it is
  stale. Without `dist/` that test **skips** with a warning rather than
  failing, so a bare `bun test` does not prove `LLMS.md` current; `bun run
  check` builds first. Its head is `docs/llms-head.md`, whose
  `<!-- recipe: path -->` lines quote `examples/recipes/*.ts` and
  `test/recipes/fake.test.ts` verbatim (relative `src/` imports rewritten to the
  package subpaths); `test/recipes.test.ts` runs those recipes on the fake.
  `docs/extensions.md` is generated from `docs/extensions.tpl.md` by
  `bun run docs:extensions`, and its code blocks must stay verbatim copies of
  `examples/extension-template/`.

## The two tiers

| Tier | What it is | When to use it |
|---|---|---|
| `SuiCore` | A 1:1 Effect wrap of `ClientWithCoreApi`. One member per `SuiClientTypes.TransportMethods` key plus `getObject`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction`, `getServiceInfo` (gRPC's `ServiceInfo`, with `lowestAvailableCheckpoint`; `UNIMPLEMENTED` on other transports) and `use`, plus `readPolicy(method)`, the effective read retry `Schedule` for a read made outside the members (optional on the interface so a `Layer.mock` need not supply it). `Include` generics preserved. Every read has a per-attempt `requestTimeout` (30 s by default, `"Infinity"` off, `SUI_RPC_TIMEOUT` under `layerConfig`) that ends in a retryable `DEADLINE_EXCEEDED`, and a `readRetry` schedule option. An SDK caller-argument error (a malformed filter, an unpaginable function filter, `after` with `before`) is a defect, not a `TransportError`. | Reaching a field or method `Sui` does not expose, and inside extension implementations. |
| `Sui` | The opinionated tier over `SuiCore`: fixed include sets, decoded BCS content, `Option` where absence is normal (`getObjectOption`, `getDynamicFieldOption`, `getDynamicObjectFieldOption`, `getCoinMetadataOption`, `resolveNameServiceAddressOption`, `defaultNameServiceNameOption`), chunked and integrity-checked batch reads (`getObjects` per-item `Result`, `getObjectsStrict` first-error-wins; `getObjectsOrFail` was removed in 0.4.0), `Stream` pagination (`streamOwnedObjects`, `streamDynamicFields`, `streamCoins`, `streamBalances`, `streamEvents`, `streamTransactions` — the last yields `Result<Executed, ExecutionFailed>` per entry, and both ledger streams follow `hasNextPage`, not the page's item count, and take `after`/`before`; `streamEventPages`/`streamTransactionPages` yield `ListPage { items, endCursor }` so a consumer commits a cursor with its items; `tailEvents`/`tailTransactions` and their `…Pages` never end, poll (1 s), retry retryable errors from the last cursor, and advance a filtered cursor to the unfiltered head so a pruning node does not strand it, which is sound only against a single sticky node), `getDynamicFieldOption(parent, name, { schema })` decoding the value, `simulate`/`view` over a `Recipe`, `Transaction` or bytes, one sender lock. A transaction stream's `function` filter must be fully qualified (`pkg::module::function`); a `pkg` or `pkg::module` filter is refused up front, and one page of it is `sui.core.listTransactions`. | Almost all application and extension code. |

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

Reads go through `Sui`; writes go through `Tx`. An extension never calls
`SuiCore.executeTransaction` directly. `Sui` exposes the `SuiCore` it was built
over as `sui.core`, which is what lets every `Tx.*` function declare `R = Sui`
and nothing else.

## The lifecycle

| Name | What it is |
|---|---|
| `Signer` | A credential as a **value**, never a service: `{ address, scheme, signTransaction, signPersonalMessage }`. One process may hold two. Secret material never reaches the value, and `Signer.fromConfig` wipes the `Config.Redacted` it read (`Redacted.wipeUnsafe`) once it has decoded it. `SignatureScheme` is the SDK's own type, re-exported, so it is exactly as wide as the installed SDK (`"MLDSA65"` from 2.36). `Signer.fromConfig` builds ML-DSA-65 keys through a dynamic import, because the peer range (`^2.28`) admits SDKs without that subpath. |
| `Tx.build/sign/cosign/fromBytes/attach/sponsored/gaslessStablecoinTransfer/sendFunds/planFold/fold/foldCoins/submit/submitVia/reconcile/resubmit/recorded/run/reconcileAll` | The lifecycle and canonical recipe helpers as functions, each Effect with a closed error union, all `R = Sui`. `gaslessStablecoinTransfer` is the SDK's `tx.balance()` → `balance::send_funds` recipe and leaves eligibility and zero-gas selection to gRPC/GraphQL resolution; `{ requireZeroGas: true }` fails the build unless the resolved price and budget are 0. `fromBytes(bytes)` is a `Built` from bytes somebody else built (chain and expiration read off them; other-chain bytes refused) and `attach(builtOrSigned, signature)` adds a verified signature by the sender or the gas owner — with `cosign` and `submit`, the stateless sponsor. `Built.gasOwner` / `Signed.gasOwner` are read from the bytes, present only when not the sender. `submitVia` is `submit` for a submission somebody else makes; `resubmit(signedOrUnknown)` re-sends identical bytes (refused when the journal says `NotApplied`; reconciles when it says `Executed`/`Failed`, the chain differs or the window has closed), and `reconcileAll({ resubmit: true })` does it for every entry still unknown; `recorded(digest)` reads one journal entry, which is what `reconcileAll` — unresolved entries only — cannot answer. `Tx.run` takes `onSigned`, the hook between the last signature and the first send. **Gas comes from the payer's SUI address balance by default** (coins only when it cannot cover the budget, or the PTB uses `tx.gas`; span attribute `sui.gas_payment`). `planFold({ owner })` reads (coins, balance, gas price) and answers `FoldPlan { batches, skipped }` (≤ 500 coins a batch, SUI first); `fold(batch)` is one batch's recipe — SUI pays for its own fold (`gas: "foldedCoins"`, `coin::send_funds<SUI>(GasCoin)`), so a coin-only account needs nothing first; `foldCoins({ signer })` plans and `run`s every batch (`FoldResult { plan, executed }`); `sendFunds({ coinType?, amount, recipient })` is `balance::send_funds` of a `tx.balance`, the canonical transfer. |
| `Verify` | `Verify.verifyTransactionSignature(bytes, signature, opts?)` and `Verify.verifyPersonalMessageSignature(message, signature, opts?)` on `/tx`: the Effect face of `@mysten/sui/verify`, `R = Sui` (the client a zkLogin or multisig check needs comes from `sui.core`). They answer the signer's public key; with `{ address }` the signature must also be that address's, which is the sponsor's check on a sender before it co-signs. An invalid signature is `SigningError`; a check that could not reach the node is `TransportError`, never a verdict. |
| `SubmitConfig` | A `Context.Reference` holding expiration policy, the optional `validFor` wall-clock bound, the gas-budget ceiling (`maxGasBudget`, refused as `PolicyDenied { rule: "maxGasBudget" }`), `preflight`, the sender lock (`lockSender: LockSenderPolicy` — `"whenPinned"` default: every build, and the submission only when the bytes pin an owned input or gas coin; `"always"`, the pre-0.4.0 rule; `"never"`; `true`/`false` overrides mean `"always"`/`"never"`), `gasPayment: GasPaymentPolicy` (`"preferAddressBalance"` default; `"requireAddressBalance"` pins `[]` before the build and makes coins a `BuildError`), the resubmit schedule, attempts, timeout and expiry margin, plus `expiryEvidence`, `reconcileRecheck`, `awaitVisibility` (which delays every return, `lockSender: "never"` included), `visibilityTimeout` and `nonce`. **`SubmitConfig.with` merges over the config in force**, not over the defaults (before 0.4.0 it reset everything else); `SubmitConfig.layer` still spreads over the defaults. Overrides (`SubmitConfigOverrides`) take `Duration.Input` (`"3 seconds"`). |
| `Journal` | A `Context.Reference` with an in-memory default. `@unconfirmed/sui-effect/journal` swaps in a durable one over `KeyValueStore`; `Tx.reconcileAll()` is the explicit startup call. `layerKeyValueStore`, `makeKeyValueStore` and `pruneSettled(before, { prefix? })` are **module functions of `/journal`**, not statics on `Journal` (`Journal.layerKeyValueStore` does not exist). The durable journal writes one key per entry and lists through `KeyValueStore.keys` (required of every store since effect 4.1), oldest first; there is no index key and no put lock, so several processes over one prefix do not lose each other's entries. `pruneSettled` deletes settled entries older than a cutoff and never an unresolved one. A 0.3 store reads with no migration (its dead `index` key is ignored, left in place and no longer maintained). Rolling back is not safe as is: 0.3 lists unresolved entries only through that index, so a `Signed`/`Unknown` entry 0.4 wrote is invisible to 0.3's `listUnresolved`, `Tx.reconcileAll` and `onUnresolved: "fail"`, and a 0.3 reader cannot decode a `NotApplied { evidence: "refused" }` entry; drain with `Tx.reconcileAll()` on 0.4 and delete the `"refused"` entries before rolling back or sharing a store with 0.3. |
| `Script` | `{ sui, core, signer, network }` plus `Script.run`, `Script.report` and `Script.exitCode`. `ScriptReadOnly` is the signer-less variant, a separate key on purpose. `layerNoDeps`/`layerWithSigner`/`layerReadOnlyNoDeps` read the network from `SuiCore`, not `SUI_NETWORK`. `Script.run` reads `SUI_LOG_LEVEL` (`Config.LogLevel`: `Debug`, `Warn`, … exactly; unset leaves Effect's default) into `References.MinimumLogLevel` for the run, and finds the journal wherever the program provided it (an internal run record Tx's journal hooks write) and reports only this run's entries; `ScriptRunOptions.layer` accepts any error type. Exit codes: `ConfigError`/`SchemaError`/`NetworkMismatch` 2, then a declared integer `exitCode` (1–255; the plain field, else Effect's `[Runtime.errorExitCode]` marker), then `outcome` (5 applied, 3 unknown, 4 not applied), 1 unclassified or a defect, 130 an interrupt with nothing outstanding — **except that while this run left a submission unresolved, a would-be 2, 4 or 130 exits 3** (applied or not), **and otherwise, once this run applied a transaction, it exits 5** and the applied digests are printed with "do not send them again"; 1, 3 and 5 are never rewritten. Every failure is one line through `SuiError.describe`; bytes are printed once. |
| `SuiExtension.fromService` | The Promise face of an Effect service, and (with `Script`) the only place in `src/` allowed to run Effects. Options: `sui` (chain pinning), `warm` (build the runtime synchronously in `register`, which throws **any** layer failure out of `$extend`), `submit` (`SubmitConfigOverrides` for every call) and `journal` (a `JournalService`, e.g. a durable one). The face carries `$ready()`, `$dispose()` and `$reconcileAll()` (reserved names). `Effect<Option<A>>` becomes `Promise<A \| undefined>` (`FaceValue`); stream items are not unwrapped. A synchronous member used before the runtime exists fails with `ExtensionNotReady`, while `Effect` and `Stream` members work cold — a cold call is a callable `Proxy` whose prototype is a `Promise` subclass that is also an `AsyncIterable`, with its rejection pre-handled; applying it (a cold recipe builder's result) throws `ExtensionNotReady` naming the member, `typeof` is `"function"`, and `bun:test` wants `expect(Promise.resolve(cold)).rejects`. A cold value placeholder throws on value-only names (`.length`, `.startsWith`, `toString`, `valueOf`, `toJSON`, …) and on spread, and renders as `<ExtensionNotReady ext.member>`. `PromiseFace` recurses by **type**, so an interface-typed namespace is mapped; the leaves are functions, arrays, `Uint8Array`, `Date`, `Promise`, BCS codecs and anything marked `SuiExtension.Leaf<T>` / `SuiExtension.leaf(value)`. Every registration on one client shares one base `Sui`/`SuiCore` per effective chain id — one chain-id read — reference counted, so `$dispose()` releases it only when the last registration does; a `warm` registration re-warms on the next use after `$dispose()`. **The sender lock is process-wide**: every registration on every client takes the same lock per address. |
| `SuiGraphQL` | A bare tag over the SDK's `SuiGraphQLClient` (`layer`, `layerConfig`, `layerUnavailable`). @unconfirmed/sui-effect wraps no GraphQL API; the tag exists so extensions share one client. `SuiGraphQL.query(run, method?)` hands `run` the Effect's `AbortSignal` as its second argument; pass it as the query's `signal`. |

## Extensions

Downstream SDKs are extensions: one `Context.Service` on `Sui` and `Tx`, layers
that require `Sui` and never build a client, recipe fragments rather than
submissions, signers as parameters, errors that declare an `outcome`, and a
Promise face derived by `SuiExtension.fromService` (whose face has `$dispose()`
and, since 0.4.0, no `dispose` alias, so a service member may be named
`dispose`). `docs/extensions.md` is the
contract and its review checklist; `examples/extension-template/` is the
copyable package every block of that guide is quoted from, and
`bun run check:template` is its own check.

`Tx.submit` journals `Signed` before the first execute, re-sends the identical
bytes (never a rebuild) on a retryable `TransportError` or a timeout, and
reconciles when the retries run out. A `TransportError` never escapes once bytes
may have been sent: it becomes `SubmissionUnknown`, which carries them. **The
one exception is a gRPC `INVALID_ARGUMENT` on the first send**
(`REFUSED_OUTRIGHT` in `Tx.ts`): the node refused the request, nothing executed,
and reconciling would ask whether a never-sent transaction is on chain — a
question a lagging or scripted node can answer yes. That error escapes as
itself, which is why `SubmitError` includes `TransportError`, and the `Signed`
entry is settled as `NotApplied { evidence: "refused" }` so no startup
reconciles it again. **First send only**: after a timeout or a retryable
failure the earlier bytes may have landed, so a later refusal reconciles like
any other ambiguous failure. `Tx.submitVia` settles the same way when the
`send` error declares `outcome: "not_applied"`. `Tx.reconcile` and
`Tx.reconcileAll` never produce a `TransportError` and, since 0.4.0, do not
declare one.
`Tx.resubmit` re-sends bytes that may have been sent before, so the first-send
refusal rule is off for it. A first-send **validator lock conflict** ("already
locked by a different transaction", "rejected as invalid by more than 1/3 of
validators") is reconciled up to three more times, `reconcileRecheck` apart,
before answering, and a `SubmissionUnknown` from a send names the send's own
error ("…; the last send failed with …"). An execute or relay answer for
**another** digest is reconciled, never returned, and so is a `submitVia` reply
without effects or reporting failure. The execute answer is journalled before
an interrupt can land (`uninterruptibleMask`), and an interrupt during the
visibility wait is logged as executed.
`JournalError` escapes only from the `Signed` write, before anything is sent;
after the network has answered, a failed journal write is logged and the answer
stands.

`Tx.build` bounds a transaction to the current epoch and the next and names the
chain, records `sui.chainId` on `Built`/`Signed`, always simulates before
anything is signed (the gRPC resolver simulates whenever it runs; the core
resolver every other transport uses simulates only to choose a budget it was
not given; `sdkSimulates` asks which case applies against the resolving client,
before the build, and `Tx.build` runs one explicit simulate whenever the SDK
will not), and cancels
its in-flight request when interrupted, on **every** transport: the gRPC
resolver's simulate is reached by rebuilding the SDK's own
`GrpcCoreClient.resolveTransactionPlugin` over a client that carries the
signal. It sets no `maxTimestamp`: no Sui network accepts a timestamp
expiration yet (`test/live.devnet.test.ts`, behind `SUI_LIVE=1`, is the proof).
`Tx.build` retries the SDK resolver on a retryable `TransportError` (the read
schedule, five attempts): the resolver's own reads go straight to the SDK,
under none of `SuiCore`'s retries, and nothing has been signed yet. A resolver
**refusal** — gRPC `INVALID_ARGUMENT`/`FAILED_PRECONDITION`/`NOT_FOUND`, or the
SDK resolver's own error ("Insufficient balance") — is a `BuildError` with the
node's message; a remaining `TransportError` is named `"Tx.build"`. A budget over
`maxGasBudget` is `PolicyDenied { rule: "maxGasBudget" }`. An **explicit** empty
gas payment (`Tx.sponsored`, or `gasPayment: "requireAddressBalance"`) is
checked before signing: one `getBalance` read, and `BuildError` when the payer's
SUI address balance is below the budget plus the payer's own SUI withdrawals.
One the resolver chose is not re-read. Empty-payment bytes with no owned input
need a `ValidDuring`/`Validity` expiration (the default), else `BuildError`: a
node refuses them. Empty-payment bytes that name `GasCoin` are a `BuildError`
too: the gas coin is empty, the simulate passes (the node mocks one) and
execution fails charging gas (`InsufficientCoinBalance`); under
`requireAddressBalance`, when an SDK intent fell back to `tx.gas`, the message
names `Tx.foldCoins`. A sponsored recipe uses `tx.coin({ balance, useGasCoin:
false })` / `Tx.sendFunds({ ..., useGasCoin: false })`.
`Tx.run` takes `sponsor?: Signer` and requires it whenever the bytes name a gas
owner that is not the sender; a missing sponsor is a `SigningError` before the
build. **The locks are chosen from the recipe itself**: it is applied to a
fresh `Transaction` before any lock is taken, so a gas owner it sets
(`Tx.sponsored`) is known, and **the gas owner's lock is taken only when gas is
paid with coins** — an empty payment selects no coin, so one sponsor can pay for
many senders concurrently. **The lock is `whenPinned`** (`SubmitConfig.lockSender`
default): every build runs under it, and signing, `onSigned` and submission stay
under it only when the bytes pin an owned/receiving input or carry any gas
payment ref — a gas coin **or a coin reservation**, which reserves the payer's
whole balance as of the build, so a `tx.gas` run also waits, under the lock, for
the lock-free runs in flight on its payer before it builds; otherwise it is
released before signing, so address-balance transactions from one sender run
concurrently (span attribute `sui.sender_lock`: `held`, `build`, `none`).
Lock-free runs can overdraw a balance (budgets count in full) — refused at
submission when the shortfall is already there, else the overdrawing one
executes as `ExecutionFailed` (`InsufficientFundsForWithdraw`, no gas) — so a
spend-to-zero flow sets `"always"`. `Tx.submit` waits for visibility before returning, and so before
releasing a lock it holds.

`NotApplied` needs evidence that is checked twice: `"expired"` is
epoch-or-timestamp closed, then a `getTransaction` miss, then both again after
`SubmitConfig.reconcileRecheck`; `"inputConsumed"` is a **different**
transaction's own effects reporting `inputVersion` equal to the version the
bytes pinned. Reconcile follows the live object's `previousTransaction` — which
names the latest mutation, and is never evidence by itself — to that
transaction and reads `changedObjects[].inputVersion` off it. There is no
`v + 1` rule: Sui stamps every output with the transaction's Lamport version
(`max(input versions) + 1`), so the object "one version on" from a pinned one
usually never existed. `SuiCore.getObjectAtVersion` is still a public primitive;
it is no longer part of the rule. Every pinned reference is tried before the
answer is `SubmissionUnknown`, which is what almost every stuck submission gets.
Coin-reservation refs in `gasData.payment` (address-balance gas) pin no object
version and are skipped. **Positive evidence vetoes expiry**: a pinned object
whose `previousTransaction` is this digest means it applied, and the answer is
`SubmissionUnknown`, never `NotApplied { expired }`. **A pruning node cannot
prove expiry**: on gRPC the rule compares `GetServiceInfo.lowestAvailableCheckpoint`
with the first checkpoint of the window's first epoch and answers
`SubmissionUnknown` when the node has pruned into the window; JSON-RPC and
GraphQL cannot report their history, so behind a pruning node there set
`expiryEvidence: "never"`. `Tx.reconcile` journals its terminal answer for a
digest the journal holds unresolved. The rule is conservative on hot objects: if V consumed
the pinned version and W later consumed V's output, the live object names W,
whose `inputVersion` is not the pinned one, so the answer is `SubmissionUnknown`
rather than `NotApplied` — history is not walked.
Chain identity is compared before any recovery query, and
`reconcile`/`reconcileAll` turn every recovery read failure into
`SubmissionUnknown`.

`SuiCore` retries retryable `TransportError`s on reads only (and `Tx.build`
retries its resolver call on the **same policy**, `core.readPolicy("use")`, so
a layer's `readRetry` governs it and its retries are logged and counted too)
(`Schedule.min([exponential("250 millis"), spaced("10 seconds")])` jittered, five
attempts). Retryable means gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`,
`RESOURCE_EXHAUSTED`, `INTERNAL` or `UNKNOWN`, HTTP 5xx or 429, or a timeout;
`INTERNAL` and `UNKNOWN` are how grpc-web reports that the request never reached
a node at all. `executeTransaction` is never retried at this tier, and the
per-attempt `requestTimeout` does not apply to `executeTransaction`,
`signAndExecuteTransaction`, `waitForTransaction` or `use`. Each read retry is
logged at debug.

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
| `SigningError` / `BuildError` / `PolicyDenied` / `JournalError` / `UnexpectedEffects` | Signing; building (including resolver refusals and an address balance below the budget); preflight policy and the gas ceiling (`rule: "maxGasBudget"`); the journal; and effects that did not contain what was expected. |
| `GraphQLUnavailable` / `ExtensionNotReady` | No usable GraphQL endpoint; a synchronous Promise-face member used before its runtime existed. Both `not_applied`. |

`SuiError.outcome(e)` puts every failure on the axis a wrapper script acts on:
`"applied"` for `ExecutionFailed` and `UnexpectedEffects`, `"unknown"` for `SubmissionUnknown`,
`"not_applied"` for every other tag in the taxonomy, and `"unknown"` for
anything that is neither one of those tags nor declares an `outcome`.
`Script.exitCode` exits 1 for that last case rather than 3. An extension error
may declare its own `outcome`, and should. `SuiError.outcome` also takes `{ phase: "pre-submit" }`, which changes only the
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
(the real `Sui` over the fake `SuiCore`), `layerExtensionTest(layer, script, { extra })`
(an extension's own layer over that, with `SuiGraphQL.layerUnavailable` provided
by default and `extra` for any other dependency the layer requires) and `SuiTest` (`putObject`, `bumpVersion`,
`recordTransaction`, `deleteObject`, `setClock`, `setEpoch`, `scriptExecute`,
`scriptSimulate`, `scriptGetObject`, `scriptGetTransaction`, `setVisibilityDelay`, `calls`,
and `provide(layer)`, which provides a layer with a fresh `Journal.layerMemory`
and `TestClock`, all `{ local: true }`), which is the whole harness
an extension's tests need. `layerTest` puts `testSubmitConfig` in force — a
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
`SimulationFailed`). It records every call so a test can
assert the include set that was sent. It also implements
`resolveTransactionPlugin` and `listCoins`, so `transaction.build({ client })`
against the fake's `client` resolves gas and object inputs from the script with
no network, and it keys transactions by
`TransactionDataBuilder.getDigestFromBytes` of the bytes it was handed — **an
execute outcome scripted with any other digest stops the test with a defect**,
because no node answers one transaction with another's digest. Any
method the script does not cover dies with a message naming it: a test never
silently passes against a stub. Its `client` implements `$extend`, so a derived
Promise face is testable the way a consumer writes it; `listOwnedObjects`
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
