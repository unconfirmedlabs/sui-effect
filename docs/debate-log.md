# Design debate log (2026-09-11)

Four rounds between the proposer (this session) and an adversarial reviewer agent, both with the research docs and the installed SDK and Effect sources available. Converged with no vetoes. What changed from the first draft and why.

## Round 1: scope and core abstraction

- **Scope cut.** The first draft was five subpaths plus batching, caching, an AI toolkit, subscriptions, an abort registry and a sponsor interface. The in-house survey justifies six things: typed reads, batched `getObjects`, a network guard, a signer from config, sign-once submit with reconcile, and sponsorship combinators. v1 is now the core module, `tx`, a small `script` preset, an optional durable journal, and testing helpers.
- **Object cache and hidden batching cut.** Sui objects are versioned inputs; a cached stale ref is the fastest route to version mismatch. A RequestResolver behind a single `getObject` adds a hidden delay. `getObjects` is the explicit batching primitive.
- **Lifecycle union demoted.** Two of seven states were produced by nothing (`Submitted`, `Drafted`), and on-chain failure was both a success value (`Failed`) and an error (`ExecutionFailed`). Now: on-chain failure is always the error; the union survives only as the journal record schema. `Finalized` renamed `Executed` because `executeTransaction` returns on execution, not checkpoint inclusion.
- **Journal moved out of R.** A `Context.Reference` with a memory default. For scripts, the bytes inside `SubmissionUnknown` are the durable record.
- **Reconcile was unsound without an expiration.** The builder defaults to no expiration for transactions with owned inputs, so "not found after expiry" could never be concluded. Build now sets `ValidDuring` unconditionally when unset.
- **Two client tiers.** `raw` and `use` returning only a transport error dropped users into Promise land the moment they needed one extra field. Now `SuiCore` is a 1:1 wrap preserving `Include` generics and `Sui` is the opinionated tier; `use` stays on `SuiCore` for `$extend` packages and runs the full error mapping.
- **Errors.** Flat tags confirmed. `RpcError` renamed `TransportError` to avoid clashing with the SDK's own `RpcError` export. Timeouts map into `TransportError`. `ObjectUnavailable` added for the SDK's `'unknown'` reason. `SuiError.isRetryable` and `SuiError.outcome` added because every repo hand-rolls them.
- **Recipe-only `Tx.run`.** A mutable `Transaction` instance inside `Effect.retry` rebuilds with stale refs, which is the equivocation the submitter exists to prevent.

## Round 2: expiration, signer, simulation, naming, tests

- **Expiration default** is `ValidDuring { maxTimestamp: chainTime + 2 min, chain, nonce }`. The SDK changelog quotes the validator's replay-protection rule, so `ValidDuring` is live on mainnet. Epoch expiration is an explicit option because an epoch is about a day. Chain time comes from the Clock object `0x6`, never the local clock. The `chain` field is a free network guard.
- **Signer is a value.** onara holds two signers in one process; `R = Signer` cannot say which. Always an explicit parameter; the script preset hands it over as a value.
- **Simulation.** The gRPC resolve plugin already simulates during `build` with checks enabled and throws on execution failure (verified in `grpc/core.mjs`). So `Tx.build` fails with `SimulationFailed` and there is no simulate knob; an optional `preflight` hook costs one extra simulate and is where policy lives.
- **Naming.** `SuiCore` and `Sui`. `SuiClient` collides with the SDK's `SuiClientTypes` and the removed 1.x class that training data remembers.
- **Fake.** `SuiCore.layerFake` over the six methods the submitter and reads touch, so `Sui.layerTest` exercises the real high tier under `TestClock`.
- **High-tier list trimmed.** `streamCoins`, `streamEvents`, `streamTransactions` and subscriptions cut from v1; each is one `SuiCore` call away.

## Round 3: API details and the head-to-head script

- Recipe is synchronous `(tx) => void`; reads happen before it.
- `SuiCore` is hand-written with a single `mapSdkError`, precise per-method unions, no optional methods, and a completeness type test.
- The same script was written against the raw SDK and against sui-effect. The raw version carried eight hazards an agent would not notice (unverified network, no expiration, no timeout or signal, non-null assertions, hand type check, the `objectTypes` join, scheme dispatch, redundant wait) and needed fifteen lines to distinguish not-found from abort. The sui-effect version distinguished them with zero lines. Honest risks: two idioms to learn, `expectCreated` is new API, and recall (the raw SDK is in training data), which is why names mirror the SDK and `LLMS.md` ships with the first release.
- Script preset contract: env names, stdout for data and stderr for diagnostics, exit codes on the applied / not applied / unknown axis, no `--json` at this level.
- `Executed` accessors because created-of-type requires the `objectTypes` join that agents get wrong.
- Deletions: `Submitter` service collapsed into a `SubmitConfig` reference plus `Tx.submit`, `Tx.reconcile`, `Tx.run` so every transaction function has `R = Sui`; `Tx.target` (the builder already validates); `layerGraphQL` from v1; `getReferenceGasPrice` on `SuiCore` only; `TxState` renamed `JournalEntry`.

## Round 4: mechanics and convergence

- Per-sender lock lives in the `Sui` layer as a `PartitionedSemaphore` and spans build through submit, because gas-coin selection happens at build.
- `Script.run` uses a built-in runner with no platform dependency and exports `Script.exitCode` for consumers on `BunRuntime.runMain`.
- Retry after not applied is a documented idiom wrapping the whole block, never an API.
- Four spec items were left to the proposer and decided in `DESIGN.md`: peer floor `@mysten/sui ^2.28`; `Sui.getTransaction` fails with `ExecutionFailed` on historical failures; `view` defaults to result 0 of the last command with explicit overrides; the durable journal layer does no network work at build and `Tx.reconcileAll` is an explicit call.

## After the debate: extensions become first-class (user direction)

The user pointed out that most downstream SDKs will reach Sui through the SDK's `$extend` mechanism, and asked whether `Sui` is still worth having. Conclusion: yes, but its audience is SDK authors, not end consumers. Changes made to the spec:

- New section 13. An extension is a `Context.Service` built on `Sui` and `Tx` with typed errors per method, recipe fragments for transaction composition, and `layer` / `layerConfig` / `layerTest`. Extensions never call `executeTransaction` directly and never hold a consumer signer.
- `SuiExtension.fromService` derives a `$extend` registration backed by a lazy `ManagedRuntime`, so existing Promise consumers keep working. One implementation, two faces.
- Third-party packages (suins, deepbook) get Effect-native variants we maintain, built to the same contract, instead of a generic Promise lift. The generic lift is deferred.
- An extension authoring guide, a template package and a test harness are phase-1 deliverables. The onara SDK rewrite is the proof and moves ahead of the publish port.
