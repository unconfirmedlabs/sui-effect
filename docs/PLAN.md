# Implementation plan (spec-driven)

The spec is `DESIGN.md`. This plan turns it into ordered work packages with acceptance criteria. Nothing here overrides the spec; where they disagree, the spec wins and this file gets fixed.

## Ground rules for every work package

- **Versions.** `effect@4.0.0-rc.112` exact in devDependencies, peer range `>=4.0.0-rc.112 <4.1`. `@mysten/sui@2.30.0` and `@mysten/bcs` as devDependencies, peer `^2.28`. `@effect/platform-bun@4.0.0-rc.112` as a devDependency only (tests and examples). `typescript@5.9.x`, `@types/bun`. Bun `1.4.x`.
- **The effect-ts skill is law.** Its invariants (`Effect.gen` + `Effect.fn`, `Schema.TaggedError` everywhere, `Context.Service` with static layers, Schema at every boundary, `DateTime.now`/`Clock`/`Random` never `Date.now()`/`Math.random()`, `run*` only at edges) apply to every file. Verify names against `node_modules/effect/dist/*.d.ts` and `node_modules/effect/ai-docs/` rather than memory. v3 names are compile errors.
- **SDK names are the source of truth.** Read `node_modules/@mysten/sui/docs/llms-index.md`, then `clients/core.md`, `sdk-building.md`, `clients/executing.md`, `transactions/basics.md`, `plugins.md` before touching the corresponding module. Verify signatures in `node_modules/@mysten/sui/dist/**/*.d.mts`.
- **Repo conventions** (from sibling repos): MIT, `"type": "module"`, `exports` map with `types` and `import`, `files: ["dist", "README.md", "LICENSE"]`, `tsc -p tsconfig.build.json` for `dist/`, `bun test`, `check` script = typecheck + build + test. tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler` (the skill's setting; the SDK ships `.d.mts`, confirm subpath imports resolve), `types: ["bun"]`, `plugins: [{ "name": "@effect/language-service" }]`.
- **No platform dependency in `src/`.** Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `Script.run` uses `process` only.
- **No `Effect.runPromise`/`runSync` inside `src/`** except at the two documented edges: `SuiExtension.fromService`'s Promise facade, and `Script.run`, which is a process entrypoint (spec section 12 requires it to fork the root fiber, interrupt it on a signal, await the `Exit` and exit).
- **Every public function has a JSDoc block that states its error union in words** so `LLMS.md` can be generated from the source.
- **Done means:** `bun run check` is green (typecheck, build, tests), no `any`, no `unknown` in an error channel, no `console.log` in `src/`, and the acceptance list of the work package is met.

## Layout

```
package.json  tsconfig.json  tsconfig.build.json  LICENSE  README.md  LLMS.md  AGENTS.md
src/
  index.ts                 sui-effect          re-exports of domain + SuiCore + Sui + Executed
  tx.ts                    sui-effect/tx
  journal.ts               sui-effect/journal
  extension.ts             sui-effect/extension
  script.ts                sui-effect/script
  testing.ts               sui-effect/testing
  domain/
    errors.ts              taxonomy + ExecutionReason + SuiError helpers
    schemas.ts             SuiAddress, ObjectId, Digest, StructTag, CoinType, Mist, SuiObject, ObjectRef, Owner
    bcs.ts                 SuiSchema.bcs bridge
    executed.ts            Executed class + accessors
    journal-entry.ts       JournalEntry tagged union
  services/
    SuiCore.ts             service, mapSdkError, layerGrpc, layerFromClient, layerConfig
    SuiCoreFake.ts         layerFake (exported via testing.ts)
    Sui.ts                 service, layerNoDeps, layer, layerTest
    Signer.ts              value type + constructors
    SubmitConfig.ts        Context.Reference
    Journal.ts             Context.Reference (memory) + KeyValueStore layer
    Tx.ts                  build, sign, cosign, sponsored, submit, reconcile, run, reconcileAll
    SuiExtension.ts        fromService
    Script.ts              Script service, run, exitCode
test/                      bun test files, one per module, plus type-level tests
examples/
  script-claim.ts          the spec's section 12 script
  extension-template/      copyable extension package skeleton (phase 1)
docs/
  extensions.md            authoring guide (phase 1)
```

## Phase 0 work packages

### WP0 Scaffold
Files: `package.json`, `tsconfig*.json`, `LICENSE`, `.gitignore`, `README.md` (stub), `AGENTS.md`, `bun.lock`, `test/smoke.test.ts`.
Acceptance: `bun install` from the registry; `bun run check` green with one trivial test; `import { Effect } from "effect"` and `import { SuiGrpcClient } from "@mysten/sui/grpc"` both resolve under the tsconfig; language-service plugin listed.

### WP1 Domain: errors and schemas
Files: `src/domain/errors.ts`, `src/domain/schemas.ts`.
Acceptance:
- Every error in spec section 10 exists as `Schema.TaggedError` with the listed fields; `ExecutionReason` is a `Schema.TaggedUnion` with all ten variants; `MoveAbort.abortCode` is `bigint` decoded from the SDK's string.
- `SuiError` type union exported; `SuiError.isRetryable`, `SuiError.outcome`, `SuiError.describe`, `SuiError.toJson` implemented; `describe` output for a Move abort matches the example in the spec.
- Branded schemas normalize on decode (`normalizeSuiAddress`, `normalizeStructTag`) and reject malformed input with a `SchemaError`.
- `TestSchema.Asserts` round-trips every error class and every branded schema in `test/domain.test.ts`.

### WP2 BCS bridge and object model
Files: `src/domain/bcs.ts`, `src/domain/schemas.ts` (SuiObject, ObjectRef, Owner).
Acceptance:
- `SuiSchema.bcs(bcsType, expectedType)` returns `Schema.Codec<T, Uint8Array>`; decoding wrong bytes yields `DecodeError`; a type-tag mismatch on a generic (`Coin<0x2::sui::SUI>` vs `Coin<0x0000…2::sui::SUI>`) is accepted after normalization, a different type is rejected.
- `Owner` is a `Schema.TaggedUnion` mirroring the SDK's six owner kinds.
- Tests decode a real `Coin` object BCS fixture captured from the SDK's `bcs.Object` type.

### WP3 SuiCore
Files: `src/services/SuiCore.ts`, `src/services/SuiCoreFake.ts`, `test/SuiCore.test.ts`, `test/SuiCore.types.test.ts`.
Acceptance:
- Every key of `SuiClientTypes.TransportMethods` is a member; the type test `Exclude<keyof TransportMethods, keyof SuiCore["Service"]>` equals `never` and `getDynamicField`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction` are present too.
- `Include` generics preserved on `getObject`, `getObjects`, `listOwnedObjects`, `getTransaction`, `executeTransaction`, `simulateTransaction`, `waitForTransaction`.
- One `mapSdkError(method, cause)` maps `ObjectError` by `reason`, `TransactionError`, `SimulationError` (with `executionError` parsed into `ExecutionReason`), gRPC `RpcError` by `GrpcStatusCode` into `TransportError { retryable }`, `SuiHTTPStatusError`/`JsonRpcError`, `Cause.TimeoutError`, and anything else into `TransportError { retryable: false }`.
- Every method forwards the AbortSignal into `signal`; a test proves interruption aborts the fake's pending promise.
- Reads retry retryable `TransportError` on the spec schedule; a `TestClock` test proves three attempts then success; `executeTransaction` is proven never retried.
- `use(f)` runs `mapSdkError`.
- `layerGrpc`, `layerFromClient`, `layerConfig` (`SUI_NETWORK` required, `SUI_RPC_URL` optional with a default URL table for mainnet/testnet/devnet/localnet gRPC endpoints; confirm the URLs against `docs/clients/grpc.md`).
- `layerFake(script)`: in-memory objects keyed by id with version and BCS content, scripted outcomes for `simulateTransaction`, `executeTransaction`, `getTransaction` (`succeed(effects)`, `failWith(reason)`, `transportError(status)`, `timeoutThen(found)`), `getChainIdentifier`, `getReferenceGasPrice`, and the Clock object `0x6` returning a scripted timestamp. Unscripted methods die with a clear message.

### WP4 Sui
Files: `src/services/Sui.ts`, `test/Sui.test.ts`.
Acceptance: every member in spec section 3 with the exact error unions; `layerNoDeps` fails with `NetworkMismatch` when the fake reports a different chain id; `getObjects` chunks by 50 and fails with `TransportError` if the response has missing or duplicate ids; `getObjectOption` maps not-found and deleted to `None`; `streamOwnedObjects` and `streamDynamicFields` paginate through the fake with `Stream.paginate` and stop on `hasNextPage: false`; `chainTime` decodes the Clock object; `withSenderLock` serializes two fibers (proven with `TestClock` and a `Deferred`); `view` decodes command result 0 of the last command by default; fixed include sets are asserted by inspecting what the fake received.

### WP5 Executed
Files: `src/domain/executed.ts`, `test/executed.test.ts`.
Acceptance: `Executed` built from a `TransactionResult` with the execute include set; accessors per spec section 4 with the `objectTypes` join; accumulator writes ignored; `expectCreated` fails with `UnexpectedEffects` on zero or many; fixture from a real SDK response shape.

Phase 0 exit: `bun run check` green; `examples/script-claim.ts` typechecks against a stubbed `Tx` (or is deferred to phase 1 if `Tx` is absent, stated in the handoff).

## Phase 1 work packages

### WP6 Signer, SubmitConfig, Journal, JournalEntry
Acceptance: `Signer.fromKeypair`, `fromConfig` (Bech32 via `decodeSuiPrivateKey`, all three schemes, `Config.redacted`), `ephemeral` (uses Effect `Random`? No: keypair generation must use the SDK's CSPRNG; document why this is the one place `Random` is not used), `remote`; secret never on the value. `SubmitConfig` reference with spec defaults. `Journal` reference with a memory implementation; `JournalEntry` union round-trips through `TestSchema.Asserts`.

### WP7 Tx
Acceptance per spec section 6: `build` sets default `ValidDuring` from `chainTime` + `validFor` with `chain` and a `Random` nonce only when unset, maps `SimulationError` to `SimulationFailed`, records the expiration on `Built`; `sign`/`cosign`; `sponsored` recipe transformer; `submit` journals before execute, retries identical bytes on retryable errors and timeouts, never rebuilds, runs `reconcile` on exhaustion, never lets `TransportError` escape; `reconcile` returns `Executed`, `ExecutionFailed`, `NotApplied { evidence }` only after the recorded bound or an advanced input version, else `SubmissionUnknown`; `run` holds the sender lock from build through submit and calls `preflight`; `reconcileAll`. Tests under `TestClock` with the fake: happy path, on-chain failure, transport error then found, timeout then not found before bound (Unknown), timeout then not found after bound (NotApplied expired), input version advanced (NotApplied inputConsumed), preflight denial, two concurrent runs from one sender serialized.

### WP8 SuiExtension.fromService
Acceptance: given a `Context.Service` class and a layer requiring `Sui`, returns a `SuiClientRegistration` whose `register(client)` lazily builds a `ManagedRuntime` over `SuiCore.layerFromClient(client)`, `Sui.layerNoDeps` and the extension layer; Effect members become Promise methods, Stream members become AsyncIterables, values pass through; rejections are the original tagged error instances; `dispose()` exposed. Test with a small in-test extension against the fake client.

### WP9 Script preset
Acceptance per spec section 12: `Script` service, `layer`, `layerReadOnly`, env handling with the mainnet gate, `run` with signal handlers and finalizers, `exitCode` mapping including extension errors declaring `outcome`; stdout/stderr split; tests drive `exitCode` over every error class and a `Script.run` test runs a script against the fake without exiting the test process (inject `exit` and `signals` for tests).

### WP10 Extension authoring guide, template, harness
Files: `docs/extensions.md`, `examples/extension-template/` (own `package.json`, one service with two methods, one recipe fragment, errors with `outcome`, `layer`/`layerConfig`/`layerTest`, `fromService` export, tests on the harness), `src/testing.ts` harness helpers.
Acceptance: the template typechecks and its tests pass from its own directory; the guide covers every item in spec section 13.4 including the upstream-wrapping section; a review checklist is included; the guide's code blocks are copied from the template so they cannot drift.

### WP11 LLMS.md, README, examples
Acceptance: `LLMS.md` generated by a script (`scripts/llms.ts`) from JSDoc plus `examples/`, covering every public export with its error union; README with install, the script example, the two tiers, the extension story, and the tested rc matrix; `examples/script-claim.ts` typechecks and runs against the fake in a test.

Phase 1 exit: `bun run check` green; the onara rewrite is a separate repo task and is not part of this plan.

## Verification protocol

After each phase an independent reviewer (Fable) reads `DESIGN.md`, this plan, and the code, and reports: spec deviations, skill-invariant violations, v3 Effect names, SDK misuse (checked against `dist/*.d.mts`), untested acceptance criteria, and anything that would mislead an agent reading the code. Findings are fixed before the next phase starts.

## Phase 1 addendum (written after Phase 0 landed)

Facts and requirements discovered after Phase 0 that Phase 1 must honour. The verifier's Phase 0 findings are appended below this section when available.

- **Chain identifiers.** Done in the Phase 0 fix pass: `KNOWN_CHAIN_IDS` in `src/domain/schemas.ts`, asserted by default from `core.network`, overridable with `layerNoDepsWith({ chainId })`.
- **Predecessor compatibility.** `docs/research/misofm-effect.md` lists six requirements: the BCS bridge accepts any `{ parse(bytes) }` codec; `Executed.created(type)` matches normalized tags and `createdWhere(predicate)` exists; `balanceChange` and gas use `bigint`; `getObjects` per-item `Result` is deliberate; `Tx.run` replaces sign-and-execute plus wait; `SuiExtension.fromService` handles nested service objects.
- **Fake gaps for Tx.** Done in the Phase 0 fix pass: the fake implements `resolveTransactionPlugin` (gas price, gas budget, gas payment from scripted coins, object inputs from the object map) and `listCoins`, and keys pending and known transactions by `TransactionDataBuilder.getDigestFromBytes`. `SuiCoreFake`'s handle exposes `client` for `transaction.build({ client })`.
- **Expiration schema.** `SignedTransaction` carries only `maxTimestampMs`; add the full `TransactionExpiration` union (`None | Epoch | ValidDuring | Validity`) to schemas.ts and use it on `Built`, `Signed` and `JournalEntry.Signed`.
- **Extension registry shape in the wild.** `@misofm/platform`'s registration constructs a class with dozens of methods and nested namespaces (`client.miso.protocol`, `client.miso.party`). `fromService` must map nested plain objects of Effect members recursively, and Streams to AsyncIterables.

### Phase 0 verification

`docs/reviews/phase0-verification.md` is the independent reviewer's Phase 0 report. Every MUST and SHOULD in its section G, and every spec amendment it lists, was applied before Phase 1 started; the items it left open are F4 (`Cause.TimeoutError` outside the taxonomy, for `Tx.submit` and `Script.exitCode`), F7's `createdWhere(predicate)`, F8 (sender-lock semaphores are never evicted), E6 (`Executed.refOf` fabricates a version, digest and owner for a change with no `objectTypes` entry) and C4/C5/C6.

## Phase 1 notes (written after WP6 to WP9 landed)

What WP10 (guide, template, harness) and WP11 (`LLMS.md`, README, examples) must
know, and what a later phase inherits.

### Shapes WP10's guide and template must mirror

- **An extension layer requires `Sui | SuiCore`.** `SuiExtension.fromService`
  builds `SuiCore.layerFromClient(client)` then `Sui.layerNoDeps` under the
  extension's own layer, so the template's `layer` may require either tier and
  nothing else. Requiring `HttpClient` as well (the onara case) means the
  template has to provide it inside its own layer before handing it to
  `fromService`.
- **`Sui` exposes `core`.** `Tx.*` declares `R = Sui` only because `SuiService`
  now carries the `SuiCore` service it was built over (`sui.core.use(...)` is
  how `Tx.build` reaches `transaction.build({ client })`, and
  `sui.core.executeTransaction` is how `Tx.submit` sends). The guide's rule is
  unchanged — an extension calls `Tx`, never `executeTransaction` — but the
  reason it *can* now is visible in the type.
- **The Promise face is a proxy.** Before the first call, a member is a
  callable, async-iterable placeholder; after it, the mapped value. The guide
  should say that a Promise consumer reads plain values (`client.x.network`)
  after its first `await`, and that a `dispose()` is available for shutdown.
- **`Script.layerReadOnly` provides `ScriptReadOnly`, a second service key.**
  A script is written against one or the other; they are not interchangeable,
  which is the point.
- **`Script.run` takes `{ layer, exit, stderr, signals, signalNames }`.** The
  template's tests should use `layer: Script.layerNoDeps.pipe(Layer.provideMerge(layerTest(script)), Layer.provide(env))`
  and an injected `exit`, as `test/example-script-claim.test.ts` does.
- **The extension harness WP10 owes** is thin: `layerTest(script)` already
  provides `Sui | SuiCore | SuiCoreFake`, which is everything an extension's
  layer needs. What is missing is a documented recipe, not code.

### Deviations from DESIGN.md applied in phase 1 (the spec has been amended)

1. `SuiService.core` added (section 3).
2. `Executed`'s accessors return `ChangedRef` with optional `type`, `version`,
   `digest` and `owner` instead of a fabricated `ObjectRef`; `objectRefOf(ref)`
   upgrades one when every field is present; `createdWhere(predicate)` added
   (section 4). `UnexpectedEffects.expected` is a plain string.
3. `Tx.submit` and `Tx.run` carry `NotApplied`; `Tx.run` also carries
   `TransportError`; `Tx.reconcile` takes `Digest | Signed | SubmissionUnknown`
   (section 6).
4. `SubmitConfig` gains `resubmitAttempts`, `executeTimeout` and `expiryMargin`
   (section 7).
5. `SubmissionUnknown.signed` is optional — a bare-digest reconcile has no bytes
   (section 10).
6. `JournalEntry.Signed` nests a `SignedTransaction` rather than repeating its
   fields, every variant carries `at`, and `lastError` is the `describe` line
   (section 9).
7. A `Context.Reference`'s layer is `Layer<never, ...>` in v4, so
   `layerKeyValueStore` from `sui-effect/journal` is typed that way (section 8).
8. `Signature` is a new branded schema (section 11).

### Still open, and what a later phase inherits

- ~~**`SubmitConfig.expiration: "epoch"`** has no test.~~ Closed: the fake
  serves `getCurrentSystemState` (`FakeScript.epoch`, `SuiTest.setEpoch`), and
  both the `"epoch"` policy and the epoch bounds of the default `"validDuring"`
  are tested.
- **`Tx.build` simulating** is only reachable in tests through the fake's new
  `buildSimulate` script slot; the real path is the transport's own resolver.
  Localnet is what proves the production path.
- **The default memory `Journal` is process-wide.** A `Context.Reference`
  computes its default once and caches it on the reference, so every fiber in a
  process shares one in-memory journal unless something provides
  `Journal.layerMemory`. Tests must provide it to stay isolated.
- **`waitForCheckpoint`, the events stream and the abort registry** are still
  phase 2, untouched.
- **Localnet integration tests** (`SUI_LOCALNET=1`) are still unwritten; they
  are what would prove the resolver's simulate, the gas-budget ceiling and
  `NotApplied { evidence: "inputConsumed" }` against a real node.
  `test/live.devnet.test.ts` (behind `SUI_LIVE=1`) now covers the part that
  could not wait: a faucet-funded `Tx.run` and a shared-object-only `Tx.build`
  against devnet, which is how the timestamp-expiration finding below was
  made.

## Phase 1 notes (written after the verification review of 2026-09-11)

`docs/reviews/phase1-verification.md` is the review; this records what its fix
list changed and the one thing it could not have known.

- **A live node refuses timestamp expiration.** The reviewer's A5 asked for
  `minEpoch`/`maxEpoch` *alongside* `maxTimestamp`. Devnet (protocol 100,
  epoch 91) refuses any transaction carrying a timestamp bound at all:
  `Feature is not supported: Timestamp-based transaction expiration is not yet
  supported`, with or without epochs. So the default `ValidDuring` is
  epoch-bounded and carries no `maxTimestamp`; `SubmitConfig.validFor` became
  optional and unset, and is the opt-in for the day a network supports one.
  `Tx.reconcile` gained the epoch rule for `NotApplied { expired }`, which is
  now the one that fires in practice. DESIGN.md sections 6 and 7 say so.
- **`NotApplied { inputConsumed }` needs a consuming digest** (A1), and
  `JournalEntry` gained a terminal `NotApplied` variant (B1) so a durable
  journal can resolve one.
- **The journal never changes an answer** (A2): `JournalError` escapes only
  from the `Signed` write, before anything is sent.
- **`SuiSchema.decode`** is public, for extensions that hold bytes.
- **`Script.layerReadOnlyNoDeps`** was added so `ScriptReadOnly` is testable
  against the fake without a network, the same role `layerNoDeps` plays for
  `Script`.

## Phase 1 notes (written after WP10 and WP11 landed)

### What shipped

- `docs/extensions.md`, generated from `docs/extensions.tpl.md` by
  `bun run docs:extensions`. Every code block is a verbatim slice of
  `examples/extension-template/`, and `test/extensions-guide.test.ts` fails if
  the two drift or if a block is unmarked.
- `examples/extension-template/`, a copyable package with its own
  `package.json`, `tsconfig.json`, `README.md` and check. Inside this repository
  it resolves `sui-effect` through a `paths` block rather than an install, so
  there is exactly one copy of `effect` in play; the README says what to change
  when it is copied out. `bun run check:template` runs it, and `bun run check`
  includes it.
- The extension harness in `src/testing.ts`: `layerExtensionTest(layer, script)`
  and `SuiTest` (`putObject`, `bumpVersion`, `deleteObject`, `setClock`,
  `scriptExecute`, `scriptSimulate`, `scriptGetTransaction`, `calls`).
- `LLMS.md`, generated by `bun scripts/llms.ts` from the emitted `dist/*.d.ts`
  through the TypeScript compiler API plus the JSDoc error sentences, followed
  by every example and the template. `test/llms.test.ts` fails when it is stale.
  It ships in `files`, along with `AGENTS.md` and `docs/extensions.md`.
- `README.md` rewritten; `test/examples.test.ts` asserts its script example is
  the text of `examples/script-claim.ts`.
- `examples/extension-consumer.ts`, showing an extension consumed from a script
  and from a Promise consumer through `$extend`. Every example now has a test
  against the fake, and `examples/read-escrow.ts` imports its platform runtime
  lazily so a test can import it.

### Public API added in WP10 and WP11

Additive only; no existing signature changed.

1. `sui-effect/tx` exports `RunError` and `SubmitError`, the unions `Tx.run` and
   `Tx.submit` already declared. Without them every extension that submits
   repeats a dozen tags that grow with the taxonomy.
2. `sui-effect/testing` exports `layerExtensionTest` and `SuiTest`.
3. `SuiCoreFakeState` gains `readObject`, which is what a helper that changes an
   object relative to its current state needs.
4. The fake's client implements `$extend`, so a derived Promise face can be
   tested the way a consumer writes it.

### Known gaps, for a later phase

- **No public equivalent of `decodeContent`.** An extension that decodes bytes
  it did not get from `sui.getObject` — anything off `streamOwnedObjects`, a
  dynamic field value, a command result it read itself — has to call
  `Schema.decodeUnknownEffect(codec)` and map `SchemaError` to `DecodeError` by
  hand. The template does exactly that. Either export a
  `SuiSchema.decode(codec, bytes, ctx?)` or add an optional `schema` to
  `streamOwnedObjects` and `getDynamicFieldOption`.
- **`Script.exitCode` and `SuiError.outcome` disagree about an undeclared
  extension error.** `SuiError.outcome` defaults to `"not_applied"`; the exit
  code of a tag it has never seen is 1 ("defect or unclassified"), per spec
  section 12. The guide resolves it by requiring every extension error to
  declare `outcome`, but the two defaults should be reconciled in the spec.
- **`noUncheckedIndexedAccess` versus the SDK's `$extend`.** The registered
  property comes back as possibly `undefined` because the SDK types it through
  an indexed access. Consumers have to name it once; nothing on our side can fix
  it.

## Scoping fixes (2026-09-11)

Applied from four independent conversion scoping reviews (effect, partyos,
musicos, platform), consolidated as items 1 to 20. One line each: what changed
and why. Everything here is additive except where noted.

### Library

1. **One Move type rule.** `typeMatches` now parses both tags with
   `parseStructTag`: a bare expected tag matches every instantiation
   (`pkg::m::Composition` accepts `Composition<Share>`), a parameterized one is
   compared in full. Four of musicos's seven object types are generic per
   instance, so exact-tag matching made the bridge unusable for them. The rule is
   applied in the bridge, in `expectedType`, in `SuiSchema.decode` (new
   `actualType` context field) and in the fake's owned-object filter, which was
   stricter than a node. DESIGN §11.
2. **`SuiSchema.bcs(codec, expectedType?)` and `Sui.view` over a bare codec.** A
   Move return value has no struct tag, so `view(recipe, bcs.Address())` now
   takes a `BcsType` directly and the expected type is optional. `view` and
   `simulate` gained `opts.sender` (`setSenderIfNotSet`, so a recipe's own sender
   wins; the SDK's zero-address default otherwise).
3. **The Promise face stops lying about synchronous members.** `fromService`
   gained `warm`, which builds the runtime synchronously inside `register` (over
   `Sui.layerNoDepsPinned`, so no chain-id round trip); the face gained
   `$ready()` and `$dispose()` (`dispose` kept as an alias); and a synchronous
   member used before the runtime exists now fails with `ExtensionNotReady`
   instead of returning a `Promise` the type does not mention. Type tests pin
   that `PromiseFace` keeps sync members sync and plain values plain.
4. **`fromService` chain pinning.** `options.sui?: SuiLayerOptions` is routed to
   `Sui.layerNoDepsWith`, and the real layer bound (`Layer<Self, E, Sui | SuiCore>`,
   own dependencies provided inside) is documented rather than folklore.
5. **`PromiseFace` and non-plain objects.** The runtime maps plain-prototype
   objects only, and the type agrees because a class or interface type is not
   assignable to `Record<string, unknown>`; both are now documented and tested
   with a `BcsType` member, which survives untouched.
6. **`Signer.fromSdkSigner(signer)`** accepts any `@mysten/sui/cryptography`
   `Signer` — Ledger, wallet adapters, KMS — and `fromKeypair` is a thin alias.
   Nothing in the wrapper ever needed the secret.
7. **`SuiGraphQL`** is a bare tag over the SDK's `SuiGraphQLClient`, exported
   from the core subpath, with `layer`, `layerConfig` (`SUI_GRAPHQL_URL` plus
   `SUI_NETWORK`) and `layerUnavailable`, whose client rejects every call with
   the new `GraphQLUnavailable`. musicos and platform both read GraphQL; one tag
   beats two. sui-effect still wraps no GraphQL API. DESIGN §13.5.
8. **`TransportError.fromUnknown(method, cause, retryable?)`** classifies status
   and retryability the way `SuiCore` does, so an extension wrapping its own HTTP
   calls does not hand-build the fields. The classifier moved to
   `src/domain/errors.ts` and `SuiCore` now uses it.
9. **`Sui.getObjectsOrFail(ids, opts)`** beside `getObjects`, for the hard batch
   read; the soft `Result` idioms are written down in the guide.
10. **Version `0.1.0`**, and the README states the tested SDK matrix; CI gained a
    `@mysten/sui` 2.29.0 / 2.30.0 job, because consumers pin 2.29.0 exactly.

### Docs

11. Codec wording fixed everywhere: the bridge needs a `BcsType` (codegen's
    `MoveStruct` / `MoveEnum` / `MoveTuple` qualify), a bare `{ parse }` is
    refused because the bridge re-serializes, and domain mapping goes in
    `Schema.decodeTo`. `docs/research/misofm-effect.md` requirement 1 is retired
    rather than left contradicting DESIGN §11.
12. A worked `Schema.decodeTo` block with snake_case-to-camelCase mapping, in the
    template (`SettlementContent`) and quoted by the guide, including the note
    that a failure inside the domain transform is still a `DecodeError` — and
    that a fallible mapping uses `transformOrFail`, since a throwing `transform`
    is a defect.
13. New guide sections: composing extensions (a real `Platform` service in the
    template that nests `Escrow` and provides its layer internally), converting
    an existing facade, a layer that picks a bundled deployment from
    `sui.network` (`Escrow.layerBundled` with `Layer.unwrap` and
    `EscrowUnsupportedNetwork`), and how to depend on sui-effect before a
    release.
14. Guide clarifications: fragments may return builder arguments and `Recipe` is
    the top-level draft type; a degenerate `layerTest = layer(fixedDeployment)`
    is expected; domain absence as `Option`/`null` through `getObjectOption` is
    blessed; `layerExtensionTest` composed with the extension's own fake; the
    scoped identifier `"@misofm/partyos/Partyos"`; the `$ready` / `warm` rule;
    and the executor row.
15. The migration table gained the rows the reviews found missing: the
    `client.core.x` reach-through, `new Transaction(); recipe(tx)`, branded ids at
    the boundary, the two dynamic-field idioms, `DeploymentError` and
    `GraphQLUnavailable`, async consumer thunks hoisting their `await`, and
    `TransportError.fromUnknown`.
16. `docs/research/misofm-effect.md`: the GraphQL sentence now says musicos uses
    it too, and the call-site counts state their method and their tree date.
17. DESIGN: §3 says `layerTest` lives in `sui-effect/testing` and documents
    `layerNoDepsPinned`; §13.2 documents the `fromService` options and the
    synchronous-member rule; §13.5 is the `SuiGraphQL` service; §10 gained the two
    new error rows.
18. The LLMS generator prints brand aliases by name, prints every `Tx` member,
    and never elides struct fields (`DynamicFieldEntry.name.type` / `.bcs` are
    what an extension needs). `LLMS.md` and `docs/extensions.md` regenerated;
    the staleness tests still pass.

### Packaging

19. `examples/extension-template/` ships in `files`, so an npm consumer can copy
    it; `@mysten/bcs` is named in the template's `peerDependencies` and in the
    guide, because a second copy of it means a second `BcsType` class.
20. README and guide: consumers on TypeScript 7 (`tsgo`) are supported, and
    `prepare: effect-language-service patch` is library-only.

Deferred, recorded, not done here: `Tx.runEffect` with an effectful recipe, and
a GraphQL-backed `SuiCore` layer.

## Codex audit fixes (2026-09-11)

Applied from `docs/reviews/codex-astra-audit.md` (gpt-6-astra, reasoning xhigh)
and the adjudicated fix plan. Findings 1 to 23, one line each. Every finding has
a regression test reproducing the audit's own scenario against the fake, in
`test/codex-audit.test.ts` unless noted; DESIGN §§2, 4, 6, 7, 8, 10, 12, 13, 14,
15 are amended to match.

1. **Expiry is no longer proof on its own.** `NotApplied { evidence: "expired" }`
   now needs the window observed closed, a `getTransaction` miss, and — after
   `SubmitConfig.reconcileRecheck` (2s, through the `Clock`) — both again.
   `SubmitConfig.expiryEvidence: "never"` disables it. Residual risk (a node
   whose index lags its epoch view) documented in DESIGN §6 and the JSDoc.
2. **The consumer of a pinned version, not the latest mutation.** Reconcile reads
   the object **at version `v + 1`** through the new
   `SuiCore.getObjectAtVersion` (gRPC `LedgerService.GetObject` with a version,
   JSON-RPC `sui_tryGetPastObject`, `Absent` on anything else) and never uses the
   live object's `previousTransaction` as evidence.
3. **`UnexpectedEffects` is `applied`.** `SuiError.outcome` returns `"applied"`
   and `Script.exitCode` returns 5; the guide's claim and the tests were wrong
   the other way.
4. **`Tx.reconcile` and `Tx.reconcileAll` leak no `TransportError`.** Every
   recovery read failure becomes `SubmissionUnknown { digest, signed?, cause }`;
   in `reconcileAll` it settles that entry instead of aborting the call. The tag
   stays in both signatures.
5. **An outer timeout no longer claims "not applied".** The unconditional
   `TimeoutError → 4` mapping is gone: `Script.exitCode(exit, { unresolved })`
   exits 3 for a timeout or an interrupt when the journal still holds a
   submission. `Script.run` captures the journal **inside** the script runtime
   and prints unresolved entries on every non-zero exit, typed failures included.
6. **Chain identity before any recovery query.** `Tx.build` records
   `sui.chainId` on `Built` and `Signed` (new `chain?` field, for the `Epoch` and
   `None` variants that name no chain); reconcile compares it and answers
   `SubmissionUnknown` naming both chains on a mismatch.
7. **Durable journal write order.** Terminal entries are saved **before** the
   digest leaves the index (unresolved ones still index first); the `put`
   semaphore is module-level per store prefix, so two instances in one process
   share it. Multi-process locking is DEFERRED and documented as a limitation
   (DESIGN §8, §15).
8. **One base per client in `SuiExtension.fromService`.** `Sui` + `SuiCore` are
   memoized per client and per base configuration through a shared
   `Layer.MemoMap`, so every registration shares one chain-id read and one
   sender-lock map; Effect reference counts it, so `$dispose()` releases the base
   only when the last registration does. Extension layers stay per registration.
9. **`Tx.run({ signer, gasOwner, sponsor })`.** The sponsor co-signs; a gas owner
   with no sponsor is a `SigningError` before the build, and again from the
   addresses read out of the built bytes (which catches `Tx.sponsored`). The fake
   now refuses a submission carrying fewer signatures than the bytes name
   signers, so the old tests would have failed.
10. **Visibility before the lock is released.** After a successful execute
    `Tx.submit` calls `SuiCore.waitForTransaction({ digest })`, bounded by
    `SubmitConfig.visibilityTimeout` (15s) and switchable with
    `awaitVisibility`. A failed wait is logged and never changes the outcome.
11. **The cold Promise face tells the truth.** A cold call returns a value that
    is a thenable **and** an async iterable, so a `Stream` member is a real
    `AsyncIterable` before the runtime exists and an `Effect` member is still a
    Promise; synchronous members keep failing with `ExtensionNotReady` until
    `$ready()` or `warm`.
12. **An interrupted build cancels its request.** `Tx.build` hands the SDK a
    proxy client whose `core` methods inject the Effect's `AbortSignal` and whose
    `resolveTransactionPlugin` is delegated untouched. The fake's resolver now
    reads the gas price through that client, which is how a test observes it.
13. **Resolver transport failures are transport failures.** `mapSdkError` walks a
    `SimulationError`'s cause chain: a gRPC status, an HTTP status, an abort or a
    bare `fetch` `TypeError` becomes a `TransportError` with that retryability;
    only an `executionError` (or no transport cause) stays `SimulationFailed`.
14. **Building always simulates.** `Tx.build` mirrors the SDK's
    `needsTransactionResolution` and, for an already-resolved transaction, runs
    one explicit `simulateTransaction` with checks enabled. DESIGN §6 now says
    "costs nothing extra when the SDK had to resolve; one call otherwise".
15. **Fake invariants.** Known-digest execution is idempotent, gas selection
    excludes object inputs, the coin set evolves (deleted / mutated with the new
    `FakeChange.balance` / gas-bumped / created), a submission with too few
    signatures is refused, and a version history is served through
    `tryGetPastObject` so `getObjectAtVersion` works against the fake.
16. **`SubmitConfig.nonce: Effect<number>`**, defaulting to a `u32` from
    `Random`, checked to be in range at build. Collision semantics (the same
    transaction and journal key, not a second execution) documented; a
    journal-backed allocator is DEFERRED, recorded in DESIGN §15.
17. **Checked `u64`.** The expiration transformation fails with a schema issue on
    a non-numeric string, a non-integer number and anything outside `[0, 2^64)`;
    the nonce is bounded to `u32`. Malformed persisted data is a `JournalError`,
    not a defect.
18. **Template codecs follow the configured package.** `EscrowContent(typeOrigin)`,
    `escrowType`, `receiptType` and `SettlementContent(typeOrigin)` are functions;
    `EscrowOptions.typeOrigin` distinguishes an upgraded execution package from
    the type origin. Tested in `examples/extension-template/test/escrow.test.ts`.
19. **The template can produce its package.** `tsconfig.build.json`, a `build`
    script, `private` removed (publishing documented in its README), and
    `scripts/check-package.ts`, which packs the tarball, unpacks it into a
    throwaway consumer and imports it. Wired into `bun run check:template`.
20. **`sdkRefOf(ref)`** returns `{ objectId, version: string, digest }` for
    `tx.objectRef`; shared and receiving references documented (DESIGN §4).
21. **`deleted()` includes wrapped objects** (input exists, no output,
    `idOperation: "None"`), and `wrapped()` returns just those.
22. **`getObject`'s explicit `expectedType` applies without a schema**, through
    the same `typeMatches` rule.
23. **The template's test fee collector** normalizes `0x1` instead of throwing
    inside `SuiAddress.make`, and the member is tested.

**Public surface added:** `SuiCore.getObjectAtVersion` and `VersionedObject`;
`sdkRefOf` / `SdkObjectRef`; `Executed#wrapped()`; `chainOf`; `SignedTransaction.chain`
and `Built.chain`; `SubmitConfig.expiryEvidence`, `reconcileRecheck`,
`awaitVisibility`, `visibilityTimeout`, `nonce` and the `ExpiryEvidencePolicy`
type; `Tx.run`'s `sponsor` option; `Script.exitCode`'s `ExitCodeOptions`;
`FakeChange.balance`. Nothing was removed.
