# Phase 0 verification (independent reviewer, 2026-09-11)

`bun run check` green (typecheck, build, 100 tests). Probes run against installed `effect@4.0.0-rc.112`, `@mysten/sui@2.30.0`, `@protobuf-ts/grpcweb-transport`.

## Adjudication of the implementer's fifteen deviations

1. `@mysten/bcs` peer `^2.1.0`: ACCEPT (SDK's own dep is `^2.1.1`; match that floor).
2. `NetworkMismatch` only via `layerNoDepsWith({ chainId })`: AMEND SPEC but keep the check on by default. Ship a `KNOWN_CHAIN_IDS` table for mainnet (`4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`) and testnet (`69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD`), assert by default when `core.network` is one of them, allow `chainId` override for devnet/localnet/custom.
3. `$kind` discriminants via `toTaggedUnion("$kind")`: ACCEPT, amend spec wording.
4. `TransactionEffects.status = { success }`: ACCEPT.
5. `ExecutionReason` in schemas.ts re-exported from errors.ts: ACCEPT.
6. `getDynamicField`/`getDynamicObjectField` declare the object-error union: ACCEPT, amend spec (base client rethrows `ObjectError`, `client/core.mjs:48`).
7. `SuiCoreFake.layer` plus `layerTest` in `sui-effect/testing`: ACCEPT, amend spec.
8. `resolveTransactionPlugin` returns `Effect`: ACCEPT (but see F1).
9. Arrow functions plus `Effect.withSpan` instead of `Effect.fn` "because generics are erased": REJECT the reason, ACCEPT the spans. Probe: `Effect.fn("f")(function*<S>(id, opts: { schema: Codec<S, Uint8Array> }) {...})` keeps `S` in rc.112. What `Effect.fn` cannot express is the overloads on `Sui.getObject/getObjectOption/getObjects`. Every non-overloaded member should be `Effect.fn`; fix the comment.
10. `Ref<Map<address, Semaphore>>` instead of `PartitionedSemaphore`: ACCEPT (verified: shared pool with per-key fairness).
11. `UnexpectedEffects.found` as refs array: ACCEPT, amend spec.
12. `gasUsedTotal: bigint`: ACCEPT, amend spec; extend to `balanceChange` (A1).
13. `examples/script-claim.ts` deferred: ACCEPT.
14. No `prepare: effect-language-service patch`: ACCEPT for Phase 0; SHOULD add in Phase 1.
15. `DefectMarker` and BCS round-trip length check: ACCEPT (`U64.parse([5,0,0,0,0,0,0,0,9,9])` returns 5 without the check). `DefectMarker` must not be exported from the main index.

## A. Spec deviations not in the list

1. `Executed.balanceChange` returns `bigint`; spec says `Mist`, but `Mist` is non-negative and deltas are signed. AMEND SPEC to `bigint`.
2. `Executed.packagesPublished()` returns `ObjectId[]`; spec section 4 says every accessor returns full refs (`executed.ts:123`).
3. `Sui.getObjects` fails with `TransportError` on a duplicate id in the request (`Sui.ts:325-331`); spec says integrity is checked on the response. Dedupe the request instead.
4. No `Effect.fn` anywhere in `src/` (spans present via `withSpan`).
5. `Sui.layerNoDeps` asserts nothing by default (see 2).

## B. Skill invariants and v3 names

- No v3 names, no `Date.now`/`Math.random`/`process.env`/`console.log`/`run*` in `src/`. `return yield*` used consistently. Schema at every boundary.
- `Effect.gen` returned from plain arrows (skill forbids; use `Effect.fn`): `Sui.ts:259` `decodeObject`, `:308` `getObjects`, `:441` `toSimulation`, `:557` `withSenderLock`, `executed.ts:192` `fromTransactionResult`.
- `SuiCoreCall` (`SuiCore.ts:207-212`) declares `Effect<A, unknown>`; exported and unused. Delete.
- `Schema.declare((_u): _u is T => true)` at `bcs.ts:41` is an always-true guard. `hasOutcome` (`errors.ts:180`) is hand-rolled; `Schema.is` would do.
- Retry schedule verified correct: 20 scripted `UNAVAILABLE` gives 1 attempt before `TestClock.adjust`, 5 after, then failure; consults the Clock; `jittered` uses `Random`.

## C. SDK misuse

1. Package objects cannot be read through `Sui`: gRPC sets `type` to the literal `package` (`grpc/core.mjs:82`), and `ObjectEnvelope.type: StructTag` (`schemas.ts:416`) rejects it, so `Sui.getObject(pkgId)` fails with a boundary `TransportError`.
2. `Simulation.objectTypes: Record<String, StructTag>` (`schemas.ts:467`) vs `Executed.objectTypes: Record<String, String>`; simulating a publish decodes `package` and fails. Make it `String`.
3. Retryable set too narrow: `grpc-web-transport.js:107-110` turns a fetch rejection (connection refused, DNS) into `RpcError` code `INTERNAL`; `grpc-web-format.js:296-320` maps HTTP 500 to `UNKNOWN`, 503 to `UNAVAILABLE`, 504 to `DEADLINE_EXCEEDED`, 429 to `RESOURCE_EXHAUSTED`. With `RETRYABLE_GRPC_STATUSES` (`SuiCore.ts:68-72`) a node that is down is never retried.
4. `ObjectDeleted` is unreachable on gRPC (only `jsonRpc/core.mjs:34` sets `reason: "deleted"`); docs imply otherwise.
5. `mapSdkError`'s `Cause.TimeoutError` branch (`SuiCore.ts:81`) is unreachable from `tryPromise`; `Effect.timeout` puts `TimeoutError` in `E` outside the taxonomy, so `SuiError.isRetryable` does not know about timeouts. Matters for `Tx.submit`.
6. `Sui.getObjects` re-chunks by 50 although gRPC already does (harmless).
7. `Sui.simulate(recipe)` with no sender: the SDK substitutes `0x0`; with checks enabled a real node likely rejects with a non-retryable `TransportError` rather than `SimulationFailed`. Unverified on a node; `view` (checks disabled) is fine.
8. Verified correct: signal forwarded on every call including `mvr.*` and `use`; gRPC options; `TransportMethods` completeness; error constructor shapes; `$kind` handling; `Owner` six kinds; effects fields; gRPC URL table matches `docs/index.md:52-55`; `dist/` imports rewritten to `.js`.

## D. Acceptance criteria not meaningfully tested

- WP1 `TestSchema.Asserts` round-trips: `test/domain.test.ts:151-152` only asserts the object is defined; real round-trips exist only for `SuiAddress` and `Mist`; error classes are only encoded. Not met.
- WP2 Coin fixture is hand-built with the correct layout; acceptable.
- WP3 Include generics: only `getObject` type-tested.
- WP3 `mapSdkError`: no test for the `INTERNAL`/`UNKNOWN` cases in C3.
- WP4 integrity: only request-duplicate tested; no missing or mismatched response test (the fake cannot produce one).
- WP4 include sets: asserted for `getObject` and `simulate`, not `getTransaction` or streams.
- WP4 `streamOwnedObjects` `type` filter untested; `Sui.test.ts:567` tests nothing about streams.
- WP5 `expectCreated` on many: untested.
- Verified meaningful: retry three then success, execute never retried, interruption aborts the fake, `NetworkMismatch`, `getObjectOption` None mapping, chunking, `view` default, `chainTime` never cached, `withSenderLock` under `TestClock`, `describe` Move-abort format, `outcome`.

## E. Misleading to an agent

1. `Sui.layerNoDeps` JSDoc says "Fails with: `TransportError`" (`Sui.ts:676`) but the type is `NetworkMismatch | TransportError` and it never asserts.
2. `examples/read-escrow.ts:6` lists `NetworkMismatch`; with `Sui.layerConfig` it cannot occur.
3. `README.md:40` and `DESIGN.md` section 12 use `bcs.u64` (a function) where `bcs.u64()` is needed.
4. `mapSdkError` JSDoc says total but it throws on `DefectMarker`.
5. `src/index.ts` exports internals: `mapSdkError`, `DefectMarker`, `makeFromClient`, `readSchedule`, `OBJECT_INCLUDE`, `SIMULATE_INCLUDE`, `EXECUTE_INCLUDE`, `fromTransactionResult`, `makeSuiObject`, `executionReasonOf`, `digestOf`, `SuiErrorSchema`, `SuiSchema.decodeContent/typeMatches/expectedTypeOf`. Move to an `internal` module.
6. `Executed.refOf` fabricates `version: 0n`, `digest: ""`, `owner: Unknown` (`executed.ts:64-70`) and silently drops changes missing from `objectTypes`; `expectCreated` fabricates `expected: "0x2::sui::SUI"` when the type string is invalid (`:164`).
7. `SuiError.toJson` is not JSON-safe: `SubmissionUnknown.signed.bytes` encodes as `{"0":1,...}`. Use a base64 codec for `SignedTransaction.bytes` (`schemas.ts:400`).
8. Fake error text `${method}Transaction` yields "getTransactionTransaction" (`SuiCoreFake.ts:502`).
9. `Sui.ts:200` inline `import("../domain/errors.ts").ExecutionFailed`.
10. `ObjectDeleted`/timeout docs vs reality (C4, C5). `layerTest(script)` with `script.chainId` compares the fake against itself.

## F. Risks for Phase 1

1. The fake cannot build a transaction: `resolveTransactionPlugin`, `$extend`, `listCoins` die. `Tx.build` needs a resolve plugin backed by the fake's object map, reference gas price, coins, and scripted simulate.
2. Fake digests are not derived from bytes (`SuiCoreFake.ts:624`); `timeoutThen(found: true)` followed by `Tx.reconcile(TransactionDataBuilder.getDigestFromBytes(bytes))` never finds the transaction.
3. `expectedTypeOf` is lost after composition: `SuiSchema.bcs(...).pipe(Schema.decodeTo(DomainClass, ...))` loses the annotation, so the type-tag check silently disappears for exactly the recommended pattern. Walk the AST for the annotation or accept an explicit `expectedType` in `getObject` opts.
4. `Cause.TimeoutError` sits outside the taxonomy; `Tx.submit` and `Script.exitCode` must handle it explicitly.
5. C1/C2 block the publish dogfood.
6. C3: `Tx.submit` will not resubmit while a node is briefly unreachable.
7. misofm requirements: (1) `SuiSchema.bcs` requires a `BcsType` (needs `serialize` for the length check; codegen output is `BcsType`, state it); (2) `createdWhere(predicate)` absent; (3) covered by A1; (4) in place; (5) nothing blocks; (6) `makeFromClient` helps.
8. `withSenderLock` semaphores never evicted.
9. `Sui.getObjects` compares ids un-normalized (`Sui.ts:346`).

## G. Fix list

MUST before Phase 1: F1, F2, C2, C1, F3, deviation 2 default table, E7, WP1 real round-trips.

SHOULD during Phase 1: C3, deviation 9 and B `Effect.fn` conversion, A2, A3, E5 internal module and delete `SuiCoreCall`, D gaps, E1-E4 and E8-E10, `prepare` script, spec amendments (3, 6, 7, 11, 12 plus A1, `bcs.u64()` typo).

NICE: F8, F9, C6, `hasOutcome` via `Schema.is`, `ObjectNotFound.version` never populated.
