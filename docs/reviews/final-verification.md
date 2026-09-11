# Final pre-release verification (independent reviewer, 2026-09-11, after the codex batch)

`bun run check` green (405 pass, 1 skip, template 21 pass). Live probes ran against devnet.

## A. Blockers for v0.1.0

**A1. The package does not typecheck or run on effect rc.113**, which the README and CI claim to test and the peer range admits. rc.113 renamed `Config.nonEmptyString`/`string`/`redacted` to `Config.NonEmptyString`/`String`/`Redacted`. Fails at `src/services/Script.ts:64,66`, `Signer.ts:150,154`, `SuiCore.ts:458-462`, `SuiGraphQL.ts:73-77`; at runtime those are undefined calls, so `Script.layer`, `layerConfig` and `Signer.fromConfig` throw. The peer range `>=4.0.0-rc.112 <4.1` also admits rc.114 and rc.115 (current `rc` tag). Fix: pin the peer to rc.112 and say so, or support both spellings and prove rc.113+ in CI.

**A2. Both CI matrix jobs cannot pass as written.** They run typecheck and tests without `bun run build`; the llms test calls `process.exit(1)` when `dist/index.d.ts` is missing, killing the run. With a build added, `@mysten/sui@2.29.0` passes 405/0.

**A3. Finding 8 is closed only for registrations with identical base configuration.** The base is keyed `read:${chainId ?? ""}` versus `pinned:${chainId}`, so a `warm` registration never shares its base and sender-lock map with a lazy one (probe: warm+lazy peak concurrency 2; lazy with `sui.chainId` plus lazy without, 2). The template's own pair (`Platform.ts` warm, `extension.ts` lazy) is exactly the non-sharing combination, while the docs promise sharing for every registration on a client. Fix: key by the effective chain id whenever known, one base per key per client; fall back to a read key only when no id is known.

## B. Major

**B1. Finding 12 is open on the production transport.** The gRPC resolver captures the client at plugin creation and calls `simulateTransaction` with no abort; `abortableClient` only injects into `client.core.*`. Probe with a real `SuiGrpcClient` over a recording transport: `Tx.build` plus a timeout ends with `TimeoutError` while the transport saw `SimulateTransaction` with no signal. The base resolver (JSON-RPC, GraphQL) does go through `client.core.*`, so the fix works there. DESIGN section 6, AGENTS.md and the `Tx.build` JSDoc state a guarantee the gRPC layer does not have.

**B2. Finding 2's mechanism is wrong on a real network; the outcome is safe but the feature almost never fires.** Sui assigns every output the transaction's Lamport version (`max(input versions) + 1`), so "the consumer of `v` is the object at `v + 1`" only holds when the pinned object was the newest input. Live: a Clock-reading PTB moved the gas coin from version 4 to 6,436,928; `getObjectAtVersion(gas, 5)` is absent; reconcile returned `SubmissionUnknown` although `AppliedByUs` evidence was one read away. Also `inputEvidence` gives up on the first moved reference. The docs must stop claiming the `v+1` rule; walk the live object's `previousTransaction` and its effects' `inputVersion` instead.

**B3. The template's packed-package check does not work outside this repository**: `check-package.ts` resolves `../..` as the repo and symlinks the repo's `node_modules`. A copier's first `bun run check` fails.

**B4. The template hand-builds `TransportError`** (`Escrow.ts:169-170`, `extension-consumer.ts:72`) against the guide's own rule to use `TransportError.fromUnknown`.

**B5. `Tx.build`'s JSDoc still documents the timestamp default** (`Tx.ts:334-339`), contradicting DESIGN and the code, and lands in LLMS.md.

**B6. Nonce range failure tag disagrees three ways**: code fails `TransportError { method: "SubmitConfig.nonce" }`, `SubmitConfig.ts:116` promises `BuildError`, DESIGN says "the build fails". `BuildError` is the honest tag.

## C. Minor and nits

- `npm pack` ships `examples/extension-template/dist/**` (36 built files) because `files` lists the directory.
- LLMS.md: "Never fails." printed under `fromService` whose prose says it throws under `warm`; `maxTimestampMsOf` has no JSDoc; `Built`, `chainOf`, `maxEpochOf`, `maxTimestampMsOf`, `Signature`, `TransactionExpiration` render twice; `Executed` prints private members.
- Stale JSDoc landing in LLMS.md: `errors.ts:189-195` (`NotApplied` "previousTransaction"), `schemas.ts:569-576` (`NotAppliedEvidence` "maxTimestamp"), `schemas.ts:503-506`, `errors.ts:325-327` (`HasOutcome` "default to not_applied").
- `Script.ts:417-434` `SUI_ERROR_TAGS` omits `GraphQLUnavailable` and `ExtensionNotReady`.
- `Tx.ts:875` still requests `previousTransaction` on the live read though nothing uses it; `tx.test.ts:784-797` pins that include set.
- `Tx.ts:1347-1362` dead `TransportError` case in `reconcileAll`.
- `Tx.ts:1266` compares `opts.gasOwner === sender` unnormalized for the lock list.
- `awaitVisible` `Effect.catchCause` also turns a defect into a warning.
- A gRPC `NOT_FOUND` from the resolver's simulate becomes `TransportError { method: "use", status: "NOT_FOUND" }` rather than `BuildError` naming the object.
- "Always simulates" is unqualified in AGENTS.md and README; with a base-resolver client and a preset budget a transaction with unresolved inputs resolves without simulating and `willResolve` skips the explicit one.
- Template README says `bun add sui-effect` under dependencies while it is a peer; tsconfig names a plugin absent from devDependencies.
- CI: `bunx tsc` unpinned; `../../$GITHUB_WORKSPACE` path.
- The house skill still says a sync member "is a Promise before the runtime exists".
- Devnet observation: after `waitForTransaction`, the node's simulate may still not resolve a coin created a minute earlier while `getObject` returns it; visibility of a transaction is not visibility of its objects in the resolver path.

## D. Codex findings closure

1 CLOSED (ordered and repeated evidence proven; no ordering produced NotApplied from a single or out-of-order observation). 2 CLOSED for safety, OPEN on the documented mechanism (B2). 3 to 7 CLOSED. 8 PARTIAL (A3). 9 to 11 CLOSED. 12 OPEN on gRPC (B1). 13 to 15 CLOSED. 16 CLOSED (tag nit B6). 17 and 18 CLOSED. 19 CLOSED in-repo, not portable (B3). 20 to 23 CLOSED.

## E. Checked and correct

DESIGN section 6 invariants (never rebuild, identical bytes, `Signed` first, no `TransportError` escapes, journal never changes an answer, signer-address guard, ascending locks, preflight, epoch bounds, strict margin, shared objects excluded, gas coins included); section 7 defaults field for field; section 8 write order and prefix lock; section 12 exit codes, stdout/stderr split, second SIGINT, mainnet gate, journal captured in the runtime; section 13.2 options and semantics; phase 1 section G items still hold; no unstable imports outside `sui-effect/journal`, no platform imports, no `process.env`, `Date.now`, `Math.random`, `console.log`, `any`; `run*` only at the two edges; no v3 names; Effect and SDK names verified; live: the default `ValidDuring` lifecycle executed on devnet six times, epoch-bounded, chain-stamped; generated docs current; tarball complete; LLMS.md fifteen spot checks match. On "never elide": most of the 7,468 lines are `Schema.Struct` combinator dumps; print schemas as decoded types only and dedupe re-exports.

## F. Verdict: NOT YET

Minimal list before tagging: A1, A2, A3, B2 (docs and `inputEvidence`), B1 (implement or reword), B3. B4 to B6 and C can follow in a patch release.

## G. What downstream conversions must know

- Register every extension on a client the same way (all warm or all lazy, same chain id) or accept two sender-lock maps.
- Expect `SubmissionUnknown`, not `NotApplied { inputConsumed }`, for almost every stuck submission whose PTB touched a shared object or an owned object older than the gas coin; plan an operator or `reconcileAll` path.
- Interrupting `Tx.build`/`Tx.run` on a gRPC client does not cancel the in-flight simulate; the sender lock is released while it runs.
- A gRPC `NOT_FOUND` during resolution arrives as `TransportError { status: "NOT_FOUND" }`; devnet's simulate may not resolve a just-created object for a while even after `waitForTransaction`.
- Pin `effect@4.0.0-rc.112` exactly until the `Config` renames are supported.
- Copy `check-package.ts` but rewrite its repo assumptions; `sui-effect` belongs in devDependencies and peerDependencies, not dependencies.
- Use `TransportError.fromUnknown`; `SuiError.describe` does not special-case `GraphQLUnavailable`/`ExtensionNotReady` in `Script.run` output.
- `sdkRefOf` is for address-owned and immutable inputs; shared objects use `tx.sharedObjectRef` with `owner.Shared.initialSharedVersion`.
- Under `Random.withSeed`, `SubmitConfig.nonce` is deterministic; provide `nonce` explicitly in tests that build twice.
