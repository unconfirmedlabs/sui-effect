# Changelog

All notable changes to `@unconfirmed/sui-effect`. The format is one line per
change, newest release first.

## 0.1.2

Two defects from the first three downstream conversions, and the surface they
exposed. Nothing was removed. Two shapes changed: `Tx.reconcileAll` now returns
a tagged union, and `Tx.submit`'s error union gained `TransportError` for the
one case where a node refuses a submission outright.

### Fixed

- **`Tx.submit` no longer reconciles a submission the node refused.** A gRPC `INVALID_ARGUMENT` — malformed bytes, or a sponsored transaction carrying only the sender's signature — is the node answering that it did not execute anything, so it escapes as the `TransportError` it is. Reconciling it asked "is this digest on chain?" about a transaction that was never sent, and a lagging node (or a scripted `getTransaction`) could answer yes: an app's sponsored, under-signed submission was reported as a **successful `Executed`**. `SubmitError` therefore includes `TransportError`; every other transport failure still becomes `SubmissionUnknown`.
- **`SuiCoreFake` refuses an under-signed or wrongly-signed submission the way a validator does**, with an `RpcError` carrying `INVALID_ARGUMENT` rather than a plain `Error` that `mapSdkError` classified as a *retryable* transport failure. It checks the signature count and, when the signatures parse, the addresses they were made by. A sponsored submit against the fake needs `Tx.cosign` (or `Tx.run`'s `sponsor`) first, exactly as it does against a node.
- **The fake's resolver simulate is recorded**, so `SuiTest.calls("simulateTransaction")` sees the simulate that `Tx.build` promises, and it is answered by `FakeScript.buildSimulate` when there is one and by the ordered `simulate` script otherwise — `simulate: [FakeOutcome.failWith(...)]` now surfaces through `Tx.build` and `Tx.run` as `SimulationFailed` instead of vanishing.
- **Nothing in `src/` writes to stderr** (the one documented `console.warn` aside). A test captures stderr around a full `Tx.run` on the fake, with `bigint`s in the script, and asserts it is empty: the reported `console.error("DEBUG …", JSON.stringify(outcomes))` lines are in no published 0.1.1 artefact, but a `JSON.stringify` over a scripted `bigint` throws, and the throw surfaced later as an unrelated `FakeUnimplemented`.
- **Every error class has a real `.message`.** `Schema.TaggedError` leaves it empty, so anything surfacing `error.message` showed nothing; the classes without a `message` schema field now carry `override get message()` returning `SuiError.describe(this)`. It is a getter, so `SuiError.toJson`'s encoding is unchanged.
- **`SuiError.describe` accepts a foreign error** instead of returning `undefined` from an exhaustive `switch` while its signature promised a `string`. An extension's error, or any `{ _tag }`, gets its tag and message.
- **`SuiCoreFake.getBalance` is keyed by owner**, not by coin type alone. A `FakeBalance` may carry an `owner`; one without answers for every owner, which is what a pre-0.1.2 script meant.
- **`FakeOutcome.failWith` accepts sui-effect's decoded `ExecutionReason`** as well as the SDK's wire `ExecutionError`, encoding the first into the second. A fixture in the wrong shape used to decode-fail several calls later, on a different method, after the outcome cursor had already moved; it now throws where the fixture is written, naming both shapes.

### Added

- **`DecodeError.kind`**: `"type"` (the Move type was not the expected one — nothing was parsed, and the one a consumer may answer with a 404), `"bytes"` (the BCS parse failed or left trailing bytes — never safe to swallow), `"shape"` (a domain schema refused a parsed or JSON value). Every producer sets it, `SuiError.describe` prints it, and it defaults to `"shape"`, so an extension constructing a `DecodeError` without one still compiles. Branch on `kind`, never on `issue`.
- **`Tx.reconcileAll` returns a `Schema.TaggedUnion`**: `{ _tag: "Executed", executed }`, `{ _tag: "ExecutionFailed", error }`, `{ _tag: "NotApplied", error }`, `{ _tag: "SubmissionUnknown", error }`. The old bare union — an `Executed` with no discriminator beside three errors that had one — is exported as the deprecated type `ReconciledOutcome`.
- **`Tx.recorded(digest)`**: the journal entry for one digest, as an `Option`. `reconcileAll` returns **only** the entries that were unresolved, and this is how to ask about one that already settled.
- **`Tx.submitVia(signed, send)`**: the submission lifecycle when a relay or a sponsorship service does the sending. Journals `Signed` before calling `send`, calls it exactly once, decodes whatever it answers (an SDK `TransactionResult`, a reduced envelope, a bare digest, or nothing — in which case it asks the chain), reconciles an ambiguous failure with the full evidence rules, and journals the terminal answer. A `send` error whose instance declares `outcome: "not_applied"` fails straight through without a reconcile.
- **`Tx.run`'s `onSigned` hook**: called with the signed bytes after the last signature and before the first `executeTransaction`, inside the sender lock, for the record the journal does not hold. Its failure is a `JournalError` and fails the run with nothing sent.
- **`Executed.fromPartial(envelope)`**: an `Executed` from a reduced relay or sponsor envelope. `changedObjects` entries need only `objectId` and `idOperation`; what the envelope did not say stays `Unknown` rather than being guessed, and the accessors read `Unknown` as "not said" so `created()` and `deleted()` still classify. JSON spellings are accepted (`bcs` as base64 or a byte array, every `u64` as a number or a `bigint`). It cannot invent the `objectTypes` join, so the type-filtered accessors match nothing without it, and `gasUsedTotal` is `0n` for an envelope that reported no gas.
- **`Executed.fromTransactionResult(result)`** is public: the strict constructor, for an SDK `TransactionResult` read with the full include set.
- **`Event.json`**: kept when the source carried one, which in practice means a relay envelope whose events have no BCS. Never populated from a gRPC execute.
- **`SuiError.outcome(error, { phase: "pre-submit" })`** answers `"not_applied"` rather than `"unknown"` for an unclassified error, which is true by construction before anything is sent. The default is `"post-submit"`, the 0.1.1 behaviour. **`SuiError.isTaxonomy(error)`** answers whether an error is one of the tags this package owns.
- **`Sui.getObjectsStrict`**: `getObjectsOrFail` under a name that reads correctly in isolation. The old name stays as a deprecated alias of the same function.
- **`Signer.fromConfig` accepts a 32-byte hex seed** (64 hex characters, `0x` optional, read as Ed25519) as well as a Bech32 `suiprivkey`, so a raw seed from a secret manager no longer needs `fromHex` in application code.
- **`Signer.fromSdkSigner` validates its argument** and throws a `TypeError` naming the missing member. A double without `getKeyScheme` produced `scheme: undefined` and nothing complained until a validator did. Its JSDoc now states that `toSuiAddress()` and `getKeyScheme()` are read at construction, and that clear-signing inputs are the SDK signer's own concern.
- **`SuiLayerOptions.retry`**: a `Schedule` for the one `getChainIdentifier` a `Sui` layer makes. A `ManagedRuntime` memoizes its layer build, failure included, so one unlucky read at boot otherwise poisons a browser tab or a Worker isolate for its whole life.
- **`FakeScript.getObject`** (and `SuiTest.scriptGetObject`): scripted outcomes for a **read**, so a test can inject a transport failure, a miss or a timeout into `getObject`. An absent or exhausted script serves the object map as before.
- **`Script.report(exit, { stderr?, journal? })`**: the diagnostic lines and the unresolved-entry printing `Script.run` does at the end, returning the exit code, for a CLI that owns its own argv parser and process and cannot hand the entrypoint over.
- **`Script.run` prints each unresolved journal entry encoded through the `JournalEntry` schema** — the same JSON a durable journal stores, bytes base64 — beside the two human lines it already printed.

### Documentation

- The extension guide gains three sections: **"Application consumers"** (a module-level `ManagedRuntime` over `Sui.layerNoDepsWith({ chainId })` and `SuiCore.layerFromClient`, HMR disposal, the memoized-failed-build trap, the in-memory journal in a browser, mapping `outcome` onto UI states with the pre-submit caveat, signing with an external cosigner, and a `layerTest`-backed double for an app's own `runSui`), **"Workers and Durable Objects"** (no `process`, `ConfigProvider.fromEnvRecord(env)`, one runtime per isolate, the sender lock not crossing isolates and address-balance gas, DO alarms versus `Schedule` sleeps, and the whole `KeyValueStore.makeStringOnly` adapter over DO storage), and **"Relay and sponsor envelopes"** (`Executed.fromPartial`, what it cannot invent, and `Tx.submitVia`).
- A **"Sponsored by an external service"** recipe in the signers section: build with `Tx.sponsored`, sign, hand over the base64 bytes and the serialized signature, and reconcile by the digest — which a co-signature does not change.
- The testing section gains: `getTransaction` is what a submit test's reconcile reads (script `notFound` unless the test means "this landed"), a sponsored submit needs `Tx.cosign` and should assert the signature count on `SuiTest.calls("executeTransaction")`, which script slot answers the build's simulate, that `layerTest` asserts the built-in chain id for `mainnet` and `testnet`, how to inject a read failure, and why an isolated-consumer fixture in the package `tsconfig`'s `include` typechecks your code against the tarball it last installed.
- Error guidance: tag strings are namespaced by whoever defined them and must be copied from the installed package; `DecodeError.kind` replaces branching on `issue`; a wrapper error must copy the `outcome` and digest of what it wrapped, because `Script.exitCode` honours `outcome` first.
- Migration-table rows for a hand-rolled idempotent submitter, `sui.core.getTransaction` for a transaction that may have failed, a predecessor `ready()` genesis check mapping to `Sui.layerNoDepsWith({ chainId })`, and a removed standalone read export; plus the `.find(... type?.includes(...))`-then-throw grep pattern that `Executed.expectCreated` replaces, and the rule that a consumer-edit table is regenerated from the published `exports` map rather than from facade call sites.
- README: the `INVALID_ARGUMENT` rule, `onSigned`, `submitVia`, the `Reconciled` shape and `Tx.recorded`, `DecodeError.kind`, the error `.message` getter, `outcome`'s phase, relay envelopes and `Executed.events`' exact type, `bigint` at the JSON boundary, the `SubmitConfig` override idiom with `maxGasBudget`'s 50 SUI default and when `lockSender: false` is correct, and a section on applications, Workers and Durable Objects.

## 0.1.1

Seventeen fixes from the first downstream conversion. Nothing in the public API
was removed or renamed: an extension built against 0.1.0 compiles unchanged, and
the type-level workarounds it had to carry are now unnecessary.

### Fixed

- `PromiseFace<S>` recurses into **interface-typed** members, not only those assignable to `Record<string, unknown>`, so an interface-typed namespace (`readonly protocol: ProtocolService`) is mapped in the type the way the runtime has always mapped it — before this the face type said `Effect` where the value was a `Promise`.
- `SuiError.toJson` includes `outcome` when the error instance declares one, including the usual case where it is a class field rather than a schema field, so a log line carries the same axis `SuiError.outcome` and `Script.exitCode` read.
- The placeholder a **cold** member call returns is a real `Promise` subclass implementing `Symbol.asyncIterator`, so `instanceof Promise` holds and `expect(...).rejects` recognises it; its rejection is pre-handled, so a cold call nobody awaits no longer aborts the process with an unhandled `ExtensionNotReady`.
- A `warm` registration re-runs its warm build on the next use after `$dispose()` instead of degrading to a cold registration whose every synchronous member throws `ExtensionNotReady`.
- `mapSdkError` duck-types the SDK's error classes when `instanceof` fails — `reason` plus `objectId` for `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable`, `reason` plus `digest` for `TransactionNotFound`, the name plus `executionError` for `SimulationFailed` — so two copies of `@mysten/sui` in one process no longer turn every one of those tags into `TransportError { status: "notFound" }`, and the first such failure logs one warning naming the real problem.

### Added

- `SuiExtension.Leaf<T>` and `SuiExtension.leaf(value)`: the marker an extension puts on a class-instance member the Promise face must pass through whole rather than recurse into. `Uint8Array`, `Date`, `Promise`, arrays and BCS codecs (`parse` plus `serialize`) are recognised without it.
- `SuiAddress.normalize(input)` and `ObjectId.normalize(input)`: decode-and-brand from any spelling the SDK accepts, which is what `"0x1"` needs and what `.make` (validate without decoding) refuses.
- `SuiSchema.decodeWith(bcsType, expectedType, map)`: a BCS layout plus a throwing mapper into a domain value, as one codec, so an extension stops hand-rolling `Effect.try` around `Schema.decodeUnknownEffect` and losing the `DecodeError`.
- `layerExtensionTest(layer, script, { extra })`: extra dependency layers for an extension whose layer requires more than the client could provide, with `SuiGraphQL.layerUnavailable` merged in by default.
- `FakeScript.coinMetadata`, so `getCoinMetadata` is testable on the harness; an unscripted coin type answers `{ coinMetadata: null }` the way a node does.
- `CHANGELOG.md`, shipped in the package's `files`.

### Documentation

- The extension guide gains: the sanctioned idiom for a standalone function that needs a sibling extension's service, a worked generic-Move-type example on the fake, the `bun install --force` step after re-packing a vendored tarball with an unchanged filename, that `waitForTransaction` outcomes are driven by `FakeScript.getTransaction`, that a `warm` registration throws **any** layer failure synchronously out of `$extend`, and what a cold placeholder is now that it is a real `Promise`.
- `SuiGraphQL`'s JSDoc states that `yield* SuiGraphQL` yields the `SuiGraphQLClient` itself and that the service type is `SuiGraphQL["Service"]`.

## 0.1.0

Initial release: two client tiers (`SuiCore`, `Sui`), a closed error taxonomy,
the transaction lifecycle as functions with typed outcomes (`Tx`), the journal,
the `Script` preset, the BCS bridge and branded schemas, `SuiExtension.fromService`
for the Promise face of an Effect service, `SuiGraphQL` as a bare tag, and the
in-memory fake with its test layers.
