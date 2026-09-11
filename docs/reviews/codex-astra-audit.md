# Codex audit (gpt-6-astra, reasoning xhigh, 2026-09-11)

Run with `codex4 exec` against commit fb0a1b3. Prompt: the audit brief in the repo issue #1. Output verbatim below.

I found publication blockers in transaction recovery and outcome classification. Several reproduce after a transaction has already succeeded.

1. **BLOCKER — Expiration does not prove a transaction never executed.** [Tx.ts:825](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:825)  
   After one `getTransaction` miss, reconciliation returns `NotApplied` when the epoch or timestamp bound has passed. That proves the bytes cannot execute *later*, not that they did not execute earlier. Execution can also occur between the lookup and the expiry check. A caller following the retry contract can repeat an applied intent.  
   **Fix:** Require authoritative historical non-inclusion evidence; otherwise return `SubmissionUnknown`. Amend the specification accordingly.  
   **Verified:** Submitted successfully, scripted a missing lookup, advanced the epoch, and received `NotApplied { evidence: "expired" }`.

2. **BLOCKER — `previousTransaction` identifies the latest mutation, not necessarily the consumer of the pinned version.** [Tx.ts:755](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:755)  
   Transaction T can consume version 3, followed by U consuming version 4. The latest object names U, causing reconciliation of T to report `NotApplied`. The prior review’s fix remains insufficient.  
   **Fix:** Inspect U’s effects and establish that U consumed the exact pinned object version. Otherwise remain unknown.  
   **Verified:** Reproduced successful T → subsequent mutation U → missing T lookup → `NotApplied inputConsumed`. SDK object declarations explicitly describe `previousTransaction` as the last mutation.

3. **BLOCKER — Missing expected effects are classified as “not applied.”** [errors.ts:235](/home/bl/unconfirmedlabs/sui-effect/src/domain/errors.ts:235), [Script.ts:303](/home/bl/unconfirmedlabs/sui-effect/src/services/Script.ts:303)  
   `UnexpectedEffects` comes from an executed transaction, but `SuiError.outcome` returns `"not_applied"` and `Script.exitCode` returns 4. The template explicitly claims the opposite.  
   **Fix:** Classify `UnexpectedEffects` as applied in both mappings, and correct the specification and tests.  
   **Verified:** Successful `Tx.run`, followed by a missing `expectCreated`, produced `"not_applied"` and exit 4.

4. **BLOCKER — Public reconciliation leaks errors that falsely imply non-execution.** [Tx.ts:810](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:810), [Tx.ts:981](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:981)  
   `reconcile` and `reconcileAll` propagate `TransportError` from recovery reads. The taxonomy maps that error to `"not_applied"` and exit 4, although the original submission remains uncertain. `submit` protects its internal reconciliation path; these public paths do not.  
   **Fix:** Convert per-transaction recovery read failures to `SubmissionUnknown`, preserving the digest and signed bytes.  
   **Verified:** After successful submission, a scripted recovery read failure escaped as `TransportError`, `"not_applied"`, exit 4.

5. **BLOCKER — An outer timeout can report exit 4 after sending bytes.** [Script.ts:287](/home/bl/unconfirmedlabs/sui-effect/src/services/Script.ts:287), [Script.ts:526](/home/bl/unconfirmedlabs/sui-effect/src/services/Script.ts:526)  
   `Tx.submit(signed).pipe(Effect.timeout(...))` interrupts the inner submission and produces an outer `TimeoutError`. It bypasses submission’s internal timeout mapping. Script assumes every escaping timeout happened before submission and also omits unresolved-journal diagnostics for typed failures.  
   **Fix:** Remove the unconditional timeout → not-applied mapping. Capture the active journal within the script runtime and report unresolved submissions on typed failure exits too.  
   **Verified:** One execute call occurred, the journal retained `Signed`, and the outer timeout mapped to exit 4.

6. **MAJOR — Reconciliation accepts evidence from the wrong chain.** [Tx.ts:804](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:804)  
   Nothing compares the signed transaction’s chain with `sui.chainId`. A transaction still valid on chain A can be declared expired using chain B’s epoch. The process-wide journal makes mixed-network recovery particularly exposed.  
   **Fix:** Validate chain identity before recovery queries; record network identity for expirations without a chain field and partition recovery accordingly. Preserve an unknown outcome on mismatch.  
   **Verified:** Built on chain A at epoch 1; reconciliation on chain B at epoch 100 returned `NotApplied expired`.

7. **MAJOR — Durable journal indexing can lose recovery entries.** [JournalKeyValueStore.ts:95](/home/bl/unconfirmedlabs/sui-effect/src/services/JournalKeyValueStore.ts:95)  
   Terminal writes remove the digest from the index before saving the terminal entry. Failure between writes leaves an old `Signed` entry that startup recovery cannot discover. Additionally, the semaphore protects only one journal instance; two instances sharing a store can overwrite each other’s index updates.  
   **Fix:** Save terminal entries before removing their index membership. Enforce a single writer or use storage-level atomic coordination across instances/processes.  
   **Verified:** Fault injection left `get(digest) = Signed` but zero unresolved entries. Concurrent separate instances retained both records but indexed only one.

8. **MAJOR — Extensions sharing a client do not share sender locks.** [SuiExtension.ts:155](/home/bl/unconfirmedlabs/sui-effect/src/services/SuiExtension.ts:155)  
   Each registration constructs its own `Sui` and lock map. Two different extensions on one client can concurrently select gas for the same sender despite each using `Tx.run`. Registering each extension once does not prevent this.  
   **Fix:** Share the base `Sui`/lock ownership across extensions using the same underlying client, with coordinated lifetime management.  
   **Verified:** Two registrations entered same-sender critical sections simultaneously; maximum concurrency was 2.

9. **MAJOR — `Tx.run({ gasOwner })` cannot complete valid sponsorship.** [Tx.ts:930](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:930)  
   `run` signs only with `opts.signer`, even when the bytes name a different gas owner. Both signatures are required. Existing fake-based sponsorship/locking tests accept a transaction a validator would reject.  
   **Fix:** Accept the sponsor signer or a co-signing operation, or reject distinct gas owners in `run` and direct callers to the explicit lifecycle.  
   **Verified:** Captured a submission containing distinct sender/gas-owner addresses but one signature; checked the installed SDK’s sponsorship documentation.

10. **MAJOR — Releasing the lock after execute does not establish read visibility.** [Tx.ts:609](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:609)  
    Successful execute immediately returns and releases the lock. The installed SDK documents that subsequent reads and dependent transactions may require `waitForTransaction` for indexing. Serialization alone does not prevent the next build from resolving stale object or gas references.  
    **Fix:** Establish visibility before the next build, or maintain an effects-backed version cache. Preserve the known execution outcome if a visibility wait fails.  
    **Verified:** SDK documentation and implementation inspection: execute and indexing wait are distinct operations; this lifecycle performs only execute.

11. **MAJOR — Cold Promise facade calls violate their declared return types.** [SuiExtension.ts:189](/home/bl/unconfirmedlabs/sui-effect/src/services/SuiExtension.ts:189)  
    The lazy callable always returns a Promise. A Stream-returning method therefore initially returns `Promise<AsyncIterable>`, while its type promises `AsyncIterable`. A synchronous recipe factory similarly returns a Promise on first use. Behavior changes after initialization.  
    **Fix:** Provide an initialization contract that makes synchronous members truthful, and support cold Stream methods as actual async iterables.  
    **Verified:** Both cold calls returned Promises; the same methods worked with their declared shapes after warming the runtime.

12. **MAJOR — Build interruption does not cancel SDK resolution.** [Tx.ts:272](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:272)  
    The `core.use` callback discards its signal. SDK 2.30’s `BuildTransactionOptions` has no signal field, and its gRPC resolver invokes simulation without an abort option. An interrupted build leaves the request running after the Effect and its lock have ended.  
    **Fix:** Implement an abort-aware resolver/client adapter or obtain an SDK cancellation hook; adding an unsupported `build({ signal })` option is insufficient.  
    **Verified:** A real SDK client with a controlled fetch received `signal: null`; fetch remained pending after the Effect timeout.

13. **MAJOR — Resolver transport failures become execution simulation failures.** [SuiCore.ts:157](/home/bl/unconfirmedlabs/sui-effect/src/services/SuiCore.ts:157)  
    The SDK gRPC resolver wraps RPC failures in `SimulationError`, preserving the RPC error as `cause`. The mapper treats every such wrapper as `SimulationFailed`, losing the transport status and retryability.  
    **Fix:** Recognize wrapped transport causes and map those to `TransportError`; reserve `SimulationFailed` for simulation execution failures.  
    **Verified:** An actual SDK resolver encountering a rejected fetch produced `SimulationFailed` with `Unknown` reason.

14. **MAJOR — Building does not always simulate.** [Tx.ts:226](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:226)  
    The advertised inherent simulate-before-submit guarantee is false for fully resolved transactions. SDK resolution skips its plugin when inputs and gas settings are already supplied. With no configured preflight, `Tx.run` can sign and submit without simulation.  
    **Fix:** Explicitly enforce the promised simulation policy, including fully resolved transactions and alternate transports, and revise the “costs nothing extra” documentation.  
    **Verified:** A fully resolved build succeeded despite a scripted build-simulation failure; confirmed the SDK’s `needsTransactionResolution` early return.

15. **MAJOR — The fake lacks transaction and gas-selection invariants needed by lifecycle tests.** [SuiCoreFake.ts:714](/home/bl/unconfirmedlabs/sui-effect/src/services/SuiCoreFake.ts:714), [SuiCoreFake.ts:848](/home/bl/unconfirmedlabs/sui-effect/src/services/SuiCoreFake.ts:848)  
    Re-executing a known digest reapplies its scripted changes. Gas selection takes every scripted payer coin without excluding object inputs, and coin references remain based on the original script. This cannot meaningfully validate replay idempotency or evolving gas selection.  
    **Fix:** Make known-digest execution idempotent, maintain coin state, exclude input coins, and validate essential gas/signature invariants.  
    **Verified:** Submitting identical signed bytes twice advanced an object from version 3 to 5. SDK documentation explicitly prohibits gas/input overlap.

16. **MAJOR — Random 32-bit nonces can silently merge distinct intended transactions.** [Tx.ts:333](/home/bl/unconfirmedlabs/sui-effect/src/services/Tx.ts:333)  
    Otherwise identical address-balance transactions within the same epoch bounds depend on this nonce for digest uniqueness. Independent random 32-bit values have approximately a 1.16% collision probability after 10,000 such transactions. A collision represents the same transaction and journal key, not another execution.  
    **Fix:** Offer coordinated nonce allocation that survives restarts, with a documented uniqueness scope and exhaustion policy. Amend the default-policy specification.  
    **Verified:** Forced the same random sequence in two independent builds and obtained identical bytes/digests. Installed SDK offline-building documentation requires nonce uniqueness across restarts.

17. **MAJOR — Malformed expiration values cause defects instead of typed decode failures.** [schemas.ts:427](/home/bl/unconfirmedlabs/sui-effect/src/domain/schemas.ts:427)  
    The U64 transformation calls `BigInt(value)` on arbitrary strings and numbers without a failing schema transformation. Invalid persisted expiration data can therefore crash journal decoding outside its declared `JournalError` channel. Integer bounds are also absent.  
    **Fix:** Use checked transformations and enforce unsigned integer ranges, including nonce bounds.  
    **Verified:** Decoding an epoch containing `"not-a-number"` produced a defect, not a `SchemaError`.

18. **MAJOR — Configuring the template’s package ID leaves its codecs and receipt type pointing elsewhere.** [Escrow.ts:187](/home/bl/unconfirmedlabs/sui-effect/examples/extension-template/src/Escrow.ts:187), [Escrow.ts:236](/home/bl/unconfirmedlabs/sui-effect/examples/extension-template/src/Escrow.ts:236)  
    Calls and filters use the configured package ID, while `EscrowContent` and `RECEIPT_TYPE` use the hard-coded package constant. Configuration can make valid reads fail and applied claims report missing receipts.  
    **Fix:** Derive codecs and receipt types from the configured type origin; distinguish an upgrade execution package from type origin explicitly if needed.  
    **Verified:** A correctly encoded object under a non-default configured package failed with `DecodeError`.

19. **MAJOR — The copyable extension template cannot produce its advertised package.** [package.json:10](/home/bl/unconfirmedlabs/sui-effect/examples/extension-template/package.json:10)  
    Exports point exclusively into `dist`, but there is no build script and the tsconfig disables emission. The package also remains private. Its own check only typechecks and tests source imports, so it misses this completely.  
    **Fix:** Supply a build configuration/script, document publication setup, and check an installed template tarball.  
    **Verified:** Packing the template produced only `package.json` and `README.md`; neither exported file existed.

20. **MINOR — `ObjectRef` is not directly usable by the SDK builder as documented.** [schemas.ts:175](/home/bl/unconfirmedlabs/sui-effect/src/domain/schemas.ts:175), [executed.ts:59](/home/bl/unconfirmedlabs/sui-effect/src/domain/executed.ts:59)  
    The library returns `id` and bigint `version`; SDK `objectRef` requires `objectId` and string/number `version`. `objectRefOf` does not perform that conversion.  
    **Fix:** Provide an SDK-compatible conversion and document reference handling for shared/receiving objects.  
    **Verified:** A TypeScript probe passing the public reference to `Transaction.objectRef` failed against installed SDK declarations.

21. **MINOR — `deleted()` omits wrapped objects despite promising them.** [executed.ts:175](/home/bl/unconfirmedlabs/sui-effect/src/domain/executed.ts:175)  
    The selector only accepts `idOperation: "Deleted"`. SDK effects represent wrapping with an existing input, nonexistent output, and `idOperation: "None"`.  
    **Fix:** Include that transition or narrow the documented contract and provide a wrapping accessor.  
    **Verified:** Checked the SDK effects converter and supplied its wrapped-object shape; `deleted()` returned an empty array.

22. **MINOR — Explicit `expectedType` is ignored without a schema.** [Sui.ts:304](/home/bl/unconfirmedlabs/sui-effect/src/services/Sui.ts:304)  
    The early return precedes the type check, although the API accepts `{ expectedType }` alone.  
    **Fix:** Apply explicit type validation before returning raw content.  
    **Verified:** Requested a conflicting expected type without a schema and received the object successfully.

23. **MINOR — The template’s test fee collector always fails.** [Escrow.ts:275](/home/bl/unconfirmedlabs/sui-effect/examples/extension-template/src/Escrow.ts:275)  
    `SuiAddress.make("0x1")` validates the decoded representation; it does not normalize the abbreviated address. The resulting rejection becomes `TransportError`. The template tests never exercise this member.  
    **Fix:** Decode the abbreviated address or supply its normalized representation, and test the member.  
    **Verified:** Evaluating `feeCollector` under `Escrow.layerTest()` returned `TransportError`.

**Checked and found correct**

- `bun run check` passed: **291 root tests passed, one live test skipped, and 10 template tests passed**. I did not independently establish live-validator acceptance.
- Submission contains no rebuild path, journals before its first execute, retries identical bytes on retryable transport failures, and preserves network answers when a subsequent journal write returns `JournalError`.
- Within one `Sui` instance, locks cover build through submit; explicitly supplied sender/gas-owner locks use consistent ordering. Clock reads use object `0x6`; default epoch arithmetic is current epoch through current epoch + 1, with no default timestamp bound.
- SuiCore method coverage, SDK names and include generics, direct signal forwarding, object-error reasons, and direct gRPC retry codes checked out. Pagination, batch chunking, normal BCS/type validation, and configured network checks have meaningful coverage.
- No Effect v3 names or forbidden platform imports were found in `src`. Runtime execution stays at the documented edges. Reference-default caching is process-wide and documented. Normal facade rejections preserve tagged-error identity.
- The core tarball’s exports and emitted imports worked in an isolated consumer under Bun and Node. TypeScript consumer checks passed with SDK 2.30 and the declared 2.28 floor. Unstable persistence imports remain isolated from the core subpath.

**Verdict:** **Not publishable as 0.1.0.** Fix findings **1–19** before publication and downstream migrations, with regression tests covering the reproduced failures and an installed-template package check. Several fixes require correcting the specification itself.

All probes were removed. The working tree is clean.