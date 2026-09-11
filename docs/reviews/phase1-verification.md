# Phase 1 verification (independent reviewer, 2026-09-11)

`bun run check` green: typecheck, build, 241 root tests, 10 template tests. Probes run against installed `effect@4.0.0-rc.112` and `@mysten/sui@2.30.0`.

## A. Blockers

**A1. `Tx.reconcile` can return `NotApplied { inputConsumed }` for a transaction that applied, and the documented retry idiom then executes the intent twice.** `Tx.ts:574-586` treats "owned input version advanced or gone" as proof the bytes can never land, but cannot tell whether the version advanced because this transaction consumed it. Path: execute times out; `getTransaction` on a lagging node says not found; `getObjectOption` on a current node shows version+1; `NotApplied inputConsumed`; outcome `not_applied`; the spec's retry idiom submits a second transaction. Same hole in `reconcileAll`. Fix: after finding an advanced input, fetch it with `previousTransaction` included through `SuiCore.getObject`; if `previousTransaction === digest` the transaction applied (re-query `getTransaction`, else `SubmissionUnknown`); only a different consuming digest is evidence. Amend DESIGN.md section 6.

**A2. A `JournalError` after the network has answered is reported as `not_applied`.** `Tx.ts:456-458` (execute succeeded) and `:480-488` (reconcile found it): a failing `journalOutcome` makes `submit` fail with `JournalError`, outcome `not_applied`, exit 4 "safe to retry", although gas was charged. Reachable with any real `KeyValueStore`. Fix: once the answer is known, a journal write failure must not change the outcome (log it, or return the result and attach the journal failure).

**A3. The durable journal drops `Signed` entries under concurrent `put`.** `JournalKeyValueStore.ts:87-93` does entry-set then an unsynchronized index read-modify-write; four concurrent puts leave `listUnresolved` with one entry. Two `Tx.run`s from different senders reproduce it. Fix: a `Semaphore(1)` around `put`, and write the index before the entry.

**A4. `Signer.fromConfig` leaks the secret into `ConfigError.message`, which `Script.run` prints to stderr.** `Signer.ts:129-135` interpolates `String(cause)`; bech32 throws `Invalid checksum in suiprivkey1...` with the full input, so one wrong character prints a recoverable key. The JSDoc claim "never reaches a log line" is false. Fix: never include cause text; say "not a Bech32 Sui private key (scheme or checksum)" and keep `cause` off the error.

**A5. The default `ValidDuring` is timestamp-only (`Tx.ts:274-289`, `minEpoch: null, maxEpoch: null`) and is set before `tx.build`, so the SDK's own epoch-bounded expiration is never applied.** The SDK's core resolver skips its simulate-only override and its `setExpiration` for payment-less transactions when an expiration is already set; its own default is `minEpoch: epoch, maxEpoch: epoch + 1`. The validator rule: "Transactions must either have address-owned inputs, or a ValidDuring expiration with at most two epochs of validity". Consequences on a real node: every build of a PTB with no address-owned object inputs, and every `Tx.sponsored` transaction (`setGasPayment([])`), is likely rejected. Fix: set `minEpoch: epoch, maxEpoch: epoch + 1` alongside `maxTimestamp` (one `getCurrentSystemState` read), amend DESIGN.md sections 6 and 7, and prove on localnet before 0.1.0. The `maxTimestamp` unit (ms) is asserted by a test but not verifiable from the installed SDK.

## B. Major

- **B1.** `NotApplied` is journaled as `Unknown` (`Tx.ts:489-493`, `:680-685`); `JournalEntry` has no terminal variant for it, so the durable journal never resolves it and `onUnresolved: "fail"` refuses to build forever. Add a `NotApplied { digest, evidence, at }` variant (spec section 9).
- **B2.** `Script.run` sends the logger to stdout; the spec promises stdout carries only the script's data. Provide a stderr-bound logger inside `run`.
- **B3.** `Tx.run` locks the sender only while gas selection happens for `gasOwner` (`Tx.ts:214`, `:626`, `:641`). Lock `gasOwner ?? sender` (or both).
- **B4.** `fromService` types the registration name as `string` (`SuiExtension.ts:48`, `:113-117`), which is why `client.escrow` is `T | undefined` under `noUncheckedIndexedAccess`. Make it generic in `const Name extends string`, then delete the cast advice in `docs/extensions.md` and `examples/extension-consumer.ts`.
- **B5.** The template teaches an outcome lie: `Escrow.ts:216` maps `UnexpectedEffects` (transaction applied, receipt missing) to `TransportError` (outcome `not_applied`); `examples/extension-consumer.ts:86-89` does the same. `Escrow.ts:165`, `:230` map decode failures to `TransportError`, so the declared `DecodeError` never occurs. The guide copies these blocks.
- **B6.** Diagnostics drop the cause: `describe(TransportError)` prints only the method; `describe(SubmissionUnknown)` prints only the digest. Print the cause message for both.
- **B7.** A non-retryable `executeTransaction` rejection (`INVALID_ARGUMENT`, wrong signer) becomes `SubmissionUnknown`, exit 3, and an `Unknown` journal entry. `Tx.sign` never checks `signer.address` against `sender` or `gasOwner`. Check the address in `sign` and `cosign`.
- **B8.** Interrupt mid-submit loses the record for scripts: `Signed` sits only in the memory journal and `Script.run` exits 130 with no digest or bytes. Print the default journal's unresolved entries on interrupt and defect exits.
- **B9.** `Script.exitCode` and `SuiError.outcome` disagree on an undeclared extension error (`not_applied` versus exit 1). Ruling: keep exit 1; make `outcome` return `"unknown"` for anything neither a taxonomy tag nor declaring `outcome`; amend DESIGN.md 13.1.
- **B10.** `Tx.reconcile` ignores `gasData.payment` refs as evidence (conservative; the A1 guard applies).

## C. Minor and nits

- `Journal` JSDoc does not say the default is process-wide; several tests run `Tx.run` on the shared default without `Journal.layerMemory`.
- `Script.layer` builds the client and runs the chain-identifier call before the mainnet gate; gate first via `Layer.unwrap`.
- `codeOfError` maps `SchemaError` to exit 2; not in spec, README or LLMS.
- README error table says timeouts land in `TransportError`; true only inside `Tx.submit`.
- `fromService`: after `dispose()` the next call silently rebuilds; document or make final. Second `register` call gets an independent runtime; document.
- `src/journal.ts` mutates the shared `Journal` object at import time despite `sideEffects: false`; LLMS shows two `Journal` entries.
- LLMS.md: `submit` signature inlined as a structural blob; inherited `message`/`cause` shown on every error; "Never fails." duplicated for `fromService`, `exitCode`, `ephemeral`; `Signer` namespace JSDoc glued onto the interface.
- `test/script.test.ts:421` tests `Sui.network`, not `ScriptReadOnly`. `test/tx.test.ts:244` title misleading; "transport error then found via reconcile" not covered.
- Second SIGINT swallowed in `Script.run`; document.

## D. Phase 0 F-list closure

F1 to F9 all DONE (F7 item 1 by decision: the bridge requires a `BcsType`, which codegen output is; F8 done but untested).

## E. Acceptance criteria not met

- WP7: `TransportError` never escaping `submit` when reconcile's own reads fail is untested; "transport error then found" only as timeout-then-found; `inputConsumed` only via direct `reconcile`; `cosign`/`sponsored` never submitted end to end; `reconcileAll` only the `Executed` branch; `expiration: "epoch"` untested (fake dies on `getCurrentSystemState`).
- WP8: layer-failure rejection identity untested.
- WP9: no test fires an injected signal; stdout/stderr split untested; `ScriptReadOnly` and `layerWithSigner` untested.
- Journal: KV journal never exercised under `Tx.run`; concurrency untested.

## F. Judgements

- Outcome default: exit 1 for an undeclared extension error is right; `SuiError.outcome` must return `"unknown"` for a foreign tag; amend DESIGN.md 13.1.
- Decode helper: absent; ship `SuiSchema.decode(codec, bytes, { objectId?, expectedType? }): Effect<T, DecodeError>` (make `decodeContent` public) before the misofm ports.
- `epoch` test: matters once A5 makes epochs part of the default; script `getCurrentSystemState` in the fake and test both paths.
- Guide readiness: right shape, but not first-attempt correct until B4, B5 and the decode helper land.

## G. Checked and correct

Submit never rebuilds; identical bytes on retry; `Signed` journaled before first execute; timeout retried then reconciled; abort signal forwarded; `chainTime` from the Clock object; nonce from `Random`; `chain` is the base58 chain id; recipe-set expiration left alone; reconcile margin strict; shared objects excluded; bare digest gives `SubmissionUnknown`; `Tx.run` holds the lock across build, preflight, sign, submit; `fromService` rejections are the original instances, streams and nested namespaces work, runtime built once lazily; `Signer` all three schemes, no secret on the value, ephemeral uses the SDK CSPRNG; `Script.run` signal to interrupt to finalizers to 130; `exitCode` over all tags; KV journal index and `onUnresolved`; `JournalEntry` round-trips; `Effect.fn` throughout; no v3 names; no `process.env`, `Date.now`, `Math.random`, `console.log`, `any` in `src/`; `run*` only at the two edges; LLMS.md matches `.d.ts` on ten spot checks; README example verbatim.

## H. Fix list

MUST before the external audit and 0.1.0: A1 (with spec amendment), A2, A3, A4, A5 (epochs in default `ValidDuring`, localnet proof), B1, B2, B3, B5, B9.

SHOULD: B4, B6, B7, B8, the decode helper, `epoch` test via scripted `getCurrentSystemState`, tests for the E-list gaps, Journal process-wide note.

NICE: B10, gate before connect, `SchemaError` exit documented, LLMS cleanups, `dispose` finality, RcMap eviction test, `journal.ts` import-time mutation.
