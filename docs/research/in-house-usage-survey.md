# In-house Sui SDK usage survey

Surveyed 2026-09-11: `delta` (effect rc.112 + @mysten/sui 2.29), `publish` (2.28), `m2m` (2.30), `onara` (2.27), `hikida` (Move only). Line references are as of that date.

## delta

Research-only PoC scanner (Bun + Effect v4) comparing perps funding/basis between Aftermath (Sui) and Hyperliquid-family venues. **No direct `@mysten/sui` import**; Sui access goes through `aftermath-ts-sdk`. It does not wrap Sui in Effect.

The reusable idea is one labeled wrapper applied uniformly to every external call:

```ts
// src/io.ts:5-12
export const attempt = <A>(label: string, fn: () => Promise<A>) =>
  Effect.tryPromise({ try: fn, catch: (cause) => new Error(`${label}: ${String(cause)}`) })
    .pipe(Effect.timeout("20 seconds"), Effect.retry({ times: 2, schedule: Schedule.exponential("300 millis") }))
```

Per-item failures degrade via `Effect.catch` inside bounded `Effect.forEach` fan-outs (`concurrency: 2-3`). Real `Schema` usage exists for Hyperliquid REST payloads, not Sui objects.

## publish

`@unconfirmed/publish`: SDK + CLI publishing 1-5 Move packages **immutably** in one PTB, using an ephemeral in-memory Ed25519 signer with gas sponsored by Onara. Built around idempotency: every mutation reports `effect: "applied" | "not_applied" | "unknown"`.

- Client: `SuiGrpcClient` from a hardcoded network→URL/chain-id table (`src/config.ts:10-21`, `src/workflow.ts:112,313`).
- PTB: `publish({ modules, dependencies })` then `moveCall('0x2::package::make_immutable', [upgradeCap])`, chained up to 5 pairs (`src/transaction.ts:13-47`). Only moveCall target in the repo.
- Sponsorship: `setSender` / `setGasOwner` / `setGasPayment([])` (`src/workflow.ts:132-134,333-335`); sponsor fills coins server-side.
- Signing: fresh `new Ed25519Keypair()` per run (`src/workflow.ts:125,326`).
- Execution: signed bytes POSTed to Onara `/sponsor` (`src/onara-client.ts:113-136`), `waitForExecution: true` delegates finality.
- Result parsing by hand: `response.$kind === 'Transaction' | 'FailedTransaction'` (`src/result.ts:62-82`); package IDs from `effects.changedObjects` where `outputState === 'PackageWrite' && idOperation === 'Created'` (`src/result.ts:34-40`).
- Errors: one `PublishError` (`src/errors.ts:3-29`) with `code`, `exitCode`, `effect`, `digest?`, `cause?`. **No retries**; reconciliation instead. Sponsorship failures triaged by `OnaraHttpError.txStatus` into `EXECUTION_UNCONFIRMED`/`EXECUTION_UNKNOWN` (effect unknown, exit 3) vs `SPONSORSHIP_DENIED`/`REJECTED` (not applied, safe to retry) (`src/workflow.ts:31-71`). On-chain failure only via `status.success === false`, raw message surfaced, no MoveAbort parsing. CLI derives a `publish status <digest>` recovery command when effect is unknown (`src/cli.ts:71-74`).
- Boilerplate: client construction + network-identity verification duplicated between single and batch paths (`src/workflow.ts:108-123` vs `309-324`); mapping batch package IDs back to source paths by comparing sorted module-name sets (`src/workflow.ts:238-287`).
- Domain: `MutationEffect = 'not_applied' | 'applied' | 'unknown'` (`src/errors.ts:1`).

## m2m

Experimental protocol for autonomous agents transacting over Sui: Agent identity objects, per-job escrow, signed cumulative payment channels, agent-services conversation layer. Move in `move/`, Rust elsewhere; TS client in `scripts/`.

- Client: `SuiGrpcClient` everywhere (`scripts/chain.ts:42`, `scripts/native-chain.ts:66`). `channel-chain.ts:107-145` subclasses `GrpcWebFetchTransport` to add call logging and a test-only RPC deny switch because the SDK has no hooks. `native-chain.ts:30-41` validates the RPC URL against an allow-list before construction.
- PTB: `call()` helper concatenating `${pkg}::module::fn` (`chain.ts:89-91`); gas via `tx.splitCoins(tx.gas, [...])` + `setGasBudgetIfNotSet(50_000_000)`; no sponsorship.
- Signing: `Ed25519Keypair.fromSecretKey` from a JSON file, or `.generate()` for demos.
- Execution: always low-level `tx.build({client})` → `signer.signTransaction(bytes)` → `tx.getDigest({client})` → `client.executeTransaction({transaction, signatures, include:{effects,objectTypes,balanceChanges}})` → `client.waitForTransaction({digest, timeout, include})`.
- Reads: single `getObject({objectId, include:{content:true}})` + hand-parsed BCS; single `getDynamicField`. No pagination, no events. Real `@mysten/suins` via `$extend(suins())` (`native-names.ts:45,89-100`). No MVR.
- **Idempotent, crash-safe submission reimplemented three times** (`chain.ts:92-115`, `native-chain.ts:121-159`, `channel-chain.ts:544-651`): build + sign + digest, journal signed bytes to a file **before** execute, so a retry resends byte-identical bytes rather than rebuilding (avoids equivocation/double spend). `channel-chain.ts` adds `ConfirmedFailure` (definitively rejected vs unknown) and re-queries `getTransaction({digest})` to reconcile (`560-577`, `641-651`). `native-chain.ts:125` wraps execute in a file lock.
- `error instanceof ObjectError && error.code === 'notExists'` **repeated five times** (`chain.ts:85`, `native-chain.ts`, `channel-chain.ts:263`, `native-names.ts:58`, `native-streaming-chain.ts:24`). No abort-code parsing; raw `status.error` stringified.
- Domain: heavy hand-written BCS mirroring Move (`scripts/codec.ts`, `scripts/channel-codec.ts` 443 lines, with signed-message envelopes and strict validators). Every read revalidates `.type` against `${pkg}::module::Name`.

## onara

Gas-sponsorship policy engine. Clients build and sign; Onara verifies the sender signature, verifies address-owned inputs are sender-controlled, evaluates allow/deny policy against move-call shape, simulates, co-signs as gas owner, submits via gRPC. `api/` (Cloudflare Workers + Bun), `sdk/` (published client, `$extend()`-able).

- Client: single `SuiGrpcClient`, env-driven (`api/src/core/runtime.ts:79`). SDK types against structural `ClientWithCoreApi`.
- PTB: `sdk/src/client.ts:90-123` sets `setSender`/`setGasOwner`/`setGasPayment([])` (comment: forces address-balance-only gas so sponsor coins can't be used) then `build({client})`. Policy inspects `commands.filter(c => c.$kind === 'MoveCall')` (`api/src/sponsorship-analysis.ts:48-50`).
- Signing: sponsor key from `SUI_PRIVATE_KEY` (Bech32) via `decodeSuiPrivateKey`, dispatched by scheme (`api/src/sponsor-key.ts:7-19`); sender signature verified with `isValidTransactionSignature` (`api/src/sender-signature.ts:26-29`).
- Execution: `grpcClient.core.executeTransaction({transaction, signatures:[sender,sponsor], include:{effects,events}, signal})` (`api/src/execution.ts:61-66`).
- Reads: batched `getObjects({objectIds, signal})` chunked by 50 with `Promise.all`, then integrity-checked (no dupes/missing/unexpected) (`api/src/input-authorization.ts:56-59`). `getCurrentSystemState`, `getChainIdentifier` pinned at startup, `defaultNameServiceName`, `simulateTransaction({include:{effects}, signal})` never skipped.
- **Most disciplined error handling:** `stage()` helper (`sponsorship-service.ts:133-160`) races each op against a per-request deadline via `p-timeout`, converting to `SponsorshipFailure('request-timeout')`. Each stage re-throws as a closed `SponsorshipFailureKind` union mapped to HTTP status (`349-392`). `p-retry` sparse (`retries: 1`, no backoff) with the same `AbortSignal` (`sponsorship-analysis.ts:56-108`, `execution.ts:58-68`; note: sign once, retry submission with the same signature is safe for KMS signers). Manual `remainingMs = deadline - Date.now()` threading (`sponsorship-analysis.ts:75-77`, `execution.ts:54`). Simulation failure via `$kind === 'FailedTransaction'` + defensive `simulationErrorMessage()` (`189-200`), no abort-code extraction.
- Domain: Zod `z.discriminatedUnion` for the policy domain (`api/src/policy.ts:62-175+`); typed error classes (`InvalidSenderSignatureError`, `OwnedInputAuthorizationError`, `GasBudgetExceededError`, `SponsorshipFailure`).

## hikida

119-line audited Move library wrapping transfer-to-object receiving and address-level funds accumulation, meant to be `use`d by other Move modules (no `entry` functions). Current version has **zero module-defined abort codes** (total API); a previous, still-deployed immutable generation had `ENoCoinsToReceive = 0`, `ENoValueToRedeem = 1`. Abort decoding must be keyed by package version. `settled_balance_value` lags by up to one commit and is always zero under `sui move test`.

## Cross-repo synthesis: top 10 things sui-effect should provide

1. **One uniform call wrapper**: timeout + typed error + label + span for every SDK call (delta `attempt()`, onara `stage()`, m2m ad hoc).
2. **Idempotent, crash-safe submission**: sign once, persist signed bytes + digest, retries resubmit identical bytes, never rebuild (m2m ×3, publish via `effect: unknown`).
3. **Three-valued execution outcome**: applied / not applied / unknown, with a built-in reconcile-by-digest (`publish` `MutationEffect`, m2m `ConfirmedFailure`).
4. **Execute-and-wait as one Effect** with native timeout/interruption instead of manual deadline threading (onara) and `waitForTransaction` everywhere.
5. **Object-not-found as a typed error / Option**, not `instanceof ObjectError && code === 'notExists'` (five copies in m2m).
6. **Batched, integrity-checked multi-object reads** (onara chunk-by-50 + validate).
7. **Stream-based pagination** for dynamic fields, events, coins, owned objects (none paginate today; all will need it).
8. **Structured MoveAbort taxonomy** with package-version-aware code registries (every repo surfaces raw strings; hikida shows why version matters).
9. **Sponsorship combinators** (`setSender`/`setGasOwner`/`setGasPayment([])` with the documented security reasoning) and a `Sponsor` interface (publish, onara).
10. **Network-identity guardrails at client construction**: explicit `Network` + `getChainIdentifier()` verification, fail fast with a typed error (m2m, publish).

Honorable mentions: hand-rolled BCS structs mirroring Move (m2m) that a Schema/BCS bridge or ABI codegen would reduce; `${pkg}::module::fn` string targets everywhere; no MVR usage anywhere (low priority), SuiNS is used (m2m).
