# Implementation plan (spec-driven)

The spec is `DESIGN.md`. This plan turns it into ordered work packages with acceptance criteria. Nothing here overrides the spec; where they disagree, the spec wins and this file gets fixed.

## Ground rules for every work package

- **Versions.** `effect@4.0.0-rc.112` exact in devDependencies, peer range `>=4.0.0-rc.112 <4.1`. `@mysten/sui@2.30.0` and `@mysten/bcs` as devDependencies, peer `^2.28`. `@effect/platform-bun@4.0.0-rc.112` as a devDependency only (tests and examples). `typescript@5.9.x`, `@types/bun`. Bun `1.4.x`.
- **The effect-ts skill is law.** Its invariants (`Effect.gen` + `Effect.fn`, `Schema.TaggedError` everywhere, `Context.Service` with static layers, Schema at every boundary, `DateTime.now`/`Clock`/`Random` never `Date.now()`/`Math.random()`, `run*` only at edges) apply to every file. Verify names against `node_modules/effect/dist/*.d.ts` and `node_modules/effect/ai-docs/` rather than memory. v3 names are compile errors.
- **SDK names are the source of truth.** Read `node_modules/@mysten/sui/docs/llms-index.md`, then `clients/core.md`, `sdk-building.md`, `clients/executing.md`, `transactions/basics.md`, `plugins.md` before touching the corresponding module. Verify signatures in `node_modules/@mysten/sui/dist/**/*.d.mts`.
- **Repo conventions** (from sibling repos): MIT, `"type": "module"`, `exports` map with `types` and `import`, `files: ["dist", "README.md", "LICENSE"]`, `tsc -p tsconfig.build.json` for `dist/`, `bun test`, `check` script = typecheck + build + test. tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler` (the skill's setting; the SDK ships `.d.mts`, confirm subpath imports resolve), `types: ["bun"]`, `plugins: [{ "name": "@effect/language-service" }]`.
- **No platform dependency in `src/`.** Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `Script.run` uses `process` only.
- **No `Effect.runPromise`/`runSync` inside `src/`** except inside `SuiExtension.fromService`'s Promise facade, which is a documented edge.
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
