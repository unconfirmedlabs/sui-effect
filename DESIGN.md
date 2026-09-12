# @unconfirmed/sui-effect: v1 specification

Status: converged after a four-round adversarial design review on 2026-09-11 (see `docs/debate-log.md`). Research inputs live in `docs/research/`. This document is the scope for the first implementation; anything not listed is deferred (section 14).

## 0. Purpose in one paragraph

@unconfirmed/sui-effect is an opinionated Effect v4 layer over `@mysten/sui` 2.x for building safe TypeScript applications and on-demand agent scripts on Sui. The SDK keeps doing BCS, transaction building, signing and transport. @unconfirmed/sui-effect owns the shape of the program around it: two client tiers, closed error unions on every function, the transaction lifecycle as functions with typed outcomes, crash-safe submission, and time, retry and interruption through Effect so tests can drive them. Every public name mirrors the SDK name it wraps so an agent that knows the SDK can guess @unconfirmed/sui-effect.

Three audiences, each with a stated entry point:

- **SDK authors** (our own downstream packages: onara, publish, m2m, future ones) build on `Sui` and `Tx` and ship an Effect service plus a derived Promise-facing client extension. Section 13 is their contract.
- **Script writers and agents** use `Script`, `Sui`, `Tx` and those SDK services directly, with full typed errors.
- **Promise consumers** (dapp-kit, third-party TypeScript) use the derived `$extend` registration on a plain SDK client and never see Effect.

`SuiCore` is the floor for all three. `Sui` and `Tx` are primarily the SDK author's toolkit; most consumer code will call an extension service, not `Sui`.

## 1. Modules and dependencies

| Subpath | Contents |
|---|---|
| `@unconfirmed/sui-effect` | `SuiCore`, `Sui`, `SuiGraphQL`, errors, branded schemas, `SuiSchema.bcs`, `Executed` |
| `@unconfirmed/sui-effect/tx` | `Signer`, `Tx.*`, `SubmitConfig`, `Journal`, `JournalEntry` |
| `@unconfirmed/sui-effect/journal` | durable `Journal` layer over `KeyValueStore` (`effect/unstable/persistence`) |
| `@unconfirmed/sui-effect/extension` | `SuiExtension.fromService` (Effect service to `$extend` registration), authoring conventions and helpers |
| `@unconfirmed/sui-effect/script` | `Script` service, `Script.run`, exit-code mapping |
| `@unconfirmed/sui-effect/testing` | `SuiCoreFake.layer(script)`, `layerTest(script)` (the real `Sui` over the fake), fixtures, schema round-trip helpers, extension test harness |

Everything the package uses to implement itself and everything the tests reach for lives in `src/internal.ts` (`mapSdkError`, `DefectMarker`, `makeFromClient`, `readSchedule`, the include sets, `fromTransactionResult`, `makeSuiObject`, `executionReasonOf`, `digestOf`, `SuiErrorSchema`, and the BCS bridge's `typeMatches` / `expectedTypeOf`; `decodeContent` is public as `SuiSchema.decode`, because an extension that holds bytes — a stream of envelopes, a dynamic field value, an event payload — otherwise hand-rolls a worse `DecodeError`). It is deliberately absent from the package `exports` map, so `src/index.ts` is exactly the public API.

Peer dependencies: `effect` pinned to **exactly `4.0.0-rc.112`**, with a CI matrix of one documented in the README; `@mysten/sui ^2.28` (first version whose BCS and gRPC support round-trips `ValidDuring` and `Validity` expirations). The core module imports only stable `effect/*`; `effect/unstable/*` appears only behind `@unconfirmed/sui-effect/journal`. No platform package dependency anywhere; tests and examples use `@effect/platform-bun`.

The `effect` pin is exact rather than a range because rc.113 renamed three `Config` constructors this package calls: `Config.nonEmptyString` to `Config.NonEmptyString`, `Config.string` to `Config.String` and `Config.redacted` to `Config.Redacted`. The four call sites are `src/services/Script.ts:64,66` (`SUI_NETWORK`, `SUI_ALLOW_MAINNET`), `src/services/Signer.ts:150,154` (`SUI_PRIVATE_KEY`), `src/services/SuiCore.ts:458-462` (`SUI_NETWORK`, `SUI_RPC_URL`) and `src/services/SuiGraphQL.ts:73-77` (`SUI_GRAPHQL_URL`, `SUI_NETWORK`). On rc.113 and later those are undefined calls, so `Script.layer`, `SuiCore.layerConfig`, `SuiGraphQL.layerConfig` and `Signer.fromConfig` throw at runtime and the package does not typecheck. **Widening the range means supporting both spellings and proving the wider one in CI**, not editing the range.

Layout follows the effect-ts skill: `src/domain/` (schemas, errors), `src/services/` (one `Context.Service` per file with `layer`, `layerNoDeps`, `layerTest`), `bun test`, `tsc --noEmit` clean before any claim of done. `LLMS.md` generated from the examples ships with the first release.

## 2. `SuiCore`: the mechanical tier

A hand-written 1:1 Effect wrap of `ClientWithCoreApi` from `@mysten/sui/client`.

- Every key of `SuiClientTypes.TransportMethods` is present, none optional on our side. A type-level test asserts `Exclude<keyof TransportMethods, keyof SuiCore["Service"]>` is `never`.
- `Include` generics are preserved exactly as the SDK declares them.
- Every call forwards the AbortSignal from `Effect.tryPromise((signal) => ...)` into `CoreClientMethodOptions.signal`, so `Effect.timeout` and interruption cancel the request.
- Every method is `Effect.fn("SuiCore.<method>")` so it has a span and the `Include` generic still flows. The same holds on `Sui`, with one exception: `getObject`, `getObjectOption` and `getObjects` declare overloads so that passing a `schema` narrows the result type, and `Effect.fn` cannot express an overload set. Their implementations are still `Effect.fn`; only the declared type is written out by hand.
- `mapSdkError` distinguishes a `SimulationError` that describes a transaction from one that is really a transport failure. The SDK's resolve plugin wraps *whatever went wrong* in a `SimulationError`, a rejected fetch and a gRPC `UNAVAILABLE` included; only a wrapper carrying an `executionError` is `SimulationFailed`. One whose `cause` chain classifies as transport (a gRPC status name, an HTTP status number, an abort, a bare `fetch` `TypeError`) is a `TransportError` with that cause's status and retryability.
- One `mapSdkError` function turns SDK failures into the taxonomy in section 10; per-method unions are derived from it:
  - `getObject`: `ObjectNotFound | ObjectDeleted | ObjectUnavailable | TransportError`
  - `getObjects`: `TransportError` (per-item errors are in the result array)
  - `getTransaction`, `waitForTransaction`: `TransactionNotFound | TransportError`
  - `simulateTransaction`: `SimulationFailed | TransportError`
  - everything else: `TransportError`
- Read methods retry `TransportError` where `retryable` is true on `Schedule.min([exponential("250 millis"), spaced("10 seconds")]).pipe(Schedule.jittered)` capped at 5 attempts. `executeTransaction` is never retried at this tier. The retryable set is exactly: gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `INTERNAL` and `UNKNOWN`; HTTP 5xx and 429; and timeouts. `INTERNAL` and `UNKNOWN` are in the set because they are how the transport reports that the request never reached a node at all: `@protobuf-ts/grpcweb-transport` turns a rejected `fetch` (connection refused, DNS failure) into `INTERNAL`, and its grpc-web format maps HTTP 500 to `UNKNOWN`. Without them a read against a node that is merely down or restarting is never retried. Every other status is an answer from the node and is not retried.
- `getObjectAtVersion({ objectId, version }): Effect<VersionedObject, TransportError>` is the one member that is **not** a wrap of a Core method, because the Core API has none: `GetObjectOptions` carries no version. It reaches the transport's own historical read — the gRPC `LedgerService.GetObject` with a `version`, JSON-RPC `sui_tryGetPastObject` — and answers `{ _tag: "Absent", reason }` on a transport that has neither, on a pruned version, and on a version that never existed. It exists for one caller: `Tx.reconcile` identifying which transaction consumed a version a set of bytes pinned (§6). `Absent` is never evidence.
- `use(f: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>): Effect<A, SuiError>` is the low-level hatch for one-off calls into the SDK client object. It runs the same `mapSdkError`. There is no `raw` property. Third-party `$extend` packages are not used directly from application code; each gets an Effect-native extension we maintain (section 13.3), and `use` is how that extension's implementation reaches the upstream package when it needs the client object.
- Layers: `layerGrpc({ network, baseUrl, timeout?, mvr? })`, `layerFromClient(client)`, `layerConfig` (`SUI_NETWORK` required with no default, `SUI_RPC_URL` optional with a built-in default gRPC URL table because the SDK ships none), and `SuiCoreFake.layer(script)` in `@unconfirmed/sui-effect/testing`, which provides both `SuiCore` and a `SuiCoreFake` handle a test drives it with.

## 3. `Sui`: the opinionated tier

`layerNoDeps: Layer<Sui, NetworkMismatch | TransportError, SuiCore>`; `layer = layerNoDeps` over `SuiCore.layerGrpc`. At build it calls `getChainIdentifier` once and records the answer on `Sui.chainId`. The test layer is **not** a static on `Sui`: `layerTest(script)` is a function in `@unconfirmed/sui-effect/testing` (`Sui.layerNoDeps` over `SuiCoreFake.layer(script)`), so nothing under `src/services/Sui.ts` depends on the fake.

`layerNoDepsPinned(chainId)` builds `Sui` **without** reading the chain identifier, taking the one it is given. It exists for `SuiExtension.fromService`'s `warm` option (13.2), which builds its runtime synchronously inside `register` and therefore cannot await a round trip. Nothing is asserted because nothing is asked; what still catches a node on the wrong chain is `Tx.build` stamping that id on the expiration, which a validator enforces.

Whether it asserts is decided by one exported table, `KNOWN_CHAIN_IDS`, holding the genesis checkpoint digests observed on the live networks (`mainnet` `4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S`, `testnet` `69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD`); the SDK ships no such table. When the client's network is in the table, a node reporting a different identifier fails the layer with `NetworkMismatch { expected, actual }`. `devnet`, `localnet` and custom networks are regenerated and have no fixed identifier, so nothing is asserted and the observed one is recorded. `layerNoDepsWith({ chainId })` pins any network and overrides the table.

It owns one `Semaphore` per sender address, kept in an `RcMap<address, Semaphore>` with a one minute idle time to live: a shared pool with per-key fairness, which is what `PartitionedSemaphore` would have given if v4 shipped one. Reference counting is what keeps the pool bounded — whoever is inside the lock holds a reference, so a lock cannot be dropped while it is in use, and an idle one is released rather than sitting in a map for the life of the process.

Members and error unions:

```ts
network: Network
core: SuiCore                                                        // the tier below, so every `Tx.*` can declare `R = Sui`
chainId: string
chainTime: Effect<DateTimeUtc, TransportError>                       // Clock object 0x6 via the BCS bridge, never cached
getObject<S>(id: ObjectId, opts?: { schema?: Schema.Codec<S, Uint8Array>; expectedType?: string }):
  Effect<SuiObject<S>, ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError | TransportError>
getObjectOption<S>(id, opts?):                                        // not found and deleted become None
  Effect<Option<SuiObject<S>>, ObjectUnavailable | DecodeError | TransportError>
getObjects<S>(ids, opts?):                                            // ids normalized and deduped, chunked by 50, response integrity checked
  Effect<ReadonlyArray<Result<SuiObject<S>, ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError>>, TransportError>
getObjectsStrict<S>(ids, opts?):                                      // the fail-first variant: the first item error is the failure (0.1.0-0.1.1: getObjectsOrFail, kept as a deprecated alias)
  Effect<ReadonlyArray<SuiObject<S>>, ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError | TransportError>
getBalance(owner: SuiAddress, coinType?: CoinType): Effect<Balance, TransportError>
getDynamicFieldOption(parent: ObjectId, name: DynamicFieldName): Effect<Option<DynamicField>, TransportError>
  // the base client rethrows ObjectError from getDynamicField (client/core.mjs:48), so SuiCore.getDynamicField and
  // getDynamicObjectField declare the object-error union; Sui folds not-found and deleted into None and the rest
  // into TransportError
getTransaction(digest: Digest): Effect<Executed, ExecutionFailed | TransactionNotFound | TransportError>
simulate(input: Recipe | Transaction | Uint8Array, opts?: { sender?: SuiAddress }):
  Effect<Simulation, SimulationFailed | BuildError | TransportError>
view<S, I>(recipe: Recipe, schema: Schema.Codec<S, Uint8Array> | BcsType<S, I>,
           opts?: { command?: number; result?: number; sender?: SuiAddress }):
  Effect<S, SimulationFailed | BuildError | DecodeError | TransportError>
streamOwnedObjects(owner, opts?: { type?: StructTag }): Stream<SuiObject, TransportError>
streamDynamicFields(parent): Stream<DynamicFieldEntry, TransportError>
withSenderLock(address: SuiAddress): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
```

Fixed include sets: objects always `content + owner + type + version + digest`; execute always `effects + events + balanceChanges + objectTypes`. Anything else is one `SuiCore` call away.

Decisions recorded:
- `getTransaction` on a historical transaction whose status is failed fails with `ExecutionFailed`, the same as `Tx.submit` and `Tx.reconcile`, so there is exactly one representation of an on-chain failure.
- `view` decodes return value `result` (default 0) of command `command` (default the last command) from `simulate` with `commandResults`, and `checksEnabled: false` so non-entry functions can be inspected. It accepts a bare `@mysten/bcs` `BcsType` as well as a `Schema.Codec`, because a Move **return value** has no struct tag: `view(recipe, bcs.Address())` needs no invented type. `opts.sender` is set with `setSenderIfNotSet` on both `view` and `simulate`, so a recipe that set its own sender wins and an omitted sender is the SDK's own zero-address default.
- `SuiObject<S>` carries `id`, `version`, `digest`, `type`, `owner` as a tagged union, `content: S`, and `ref: ObjectRef` for feeding the builder. `type` is `ObjectType`, a union of `StructTag` and the literal `package`: gRPC reports `package` for a Move package object, and a package is a readable object like any other. `Simulation.objectTypes` and `Executed.objectTypes` are plain strings for the same reason.

## 4. `Executed`

A `Schema.Class` built from the execute include set: `digest`, `effects`, `events`, `balanceChanges`, `objectTypes`, `checkpoint?`, `timestampMs?`. Accessors, each returning full refs `{ id, type, version, digest, owner }` so the next transaction can consume them, and each ignoring accumulator writes:

`created(type?)`, `createdWhere(predicate)` (the direct replacement for the substring matching downstream repos hand-roll), `mutated(type?)`, `deleted()`, `wrapped()`, `packagesPublished()` (`PackageWrite` and `Created`, refs like every other accessor, `type` falling back to the literal `package`), `balanceChange(address, coinType): bigint` and `gasUsedTotal: bigint` (both are signed deltas, so neither is `Mist`, which is non-negative), and `expectCreated(type): Effect<ChangedRef, UnexpectedEffects>` for the one-result case.

`deleted()` covers both shapes the effects use for "this object is gone from where it was": a delete (`idOperation: "Deleted"`) and a **wrap**, which the SDK's effects converter represents as an input that existed, an output that does not, and no id operation at all (`"None"`). `wrapped()` returns just the second kind, for a caller that has to tell them apart — a wrapped object still exists inside its wrapper and can come back.

Every accessor returns a `ChangedRef { id, type?, version?, digest?, owner? }` rather than a full `ObjectRef`: the effects carry `id` always and the rest only sometimes (a deleted object has no output version, a change missing from the `objectTypes` join has no type), and inventing version `0`, an empty digest or an `Unknown` owner would hand the builder a reference that looks usable and is not. `objectRefOf(ref)` returns a full `ObjectRef` when every field is present and `undefined` otherwise. `sdkRefOf(ref)` returns the shape the **SDK builder** wants — `{ objectId, version: string, digest }` — because sui-effect's `ObjectRef` carries `id` and a `bigint` `version` and `Transaction#objectRef` accepts neither. It is for an address-owned or immutable object only: a **shared** object goes through `tx.sharedObjectRef({ objectId, initialSharedVersion, mutable })`, whose initial shared version is on `ref.owner.Shared.initialSharedVersion`, and a **receiving** object through `tx.receivingRef(...)`, which takes the same three fields; passing a shared object by `objectRef` produces bytes a validator rejects.

## 5. `Signer` is a value, not a service

A credential is data, and one process may hold two (onara verifies a sender signature and signs as sponsor). `R = Signer` cannot say which one, so the signer is always an explicit parameter.

```ts
interface Signer { address: SuiAddress; scheme: SignatureScheme; signTransaction(bytes): Effect<Signature, SigningError>; signPersonalMessage(bytes): Effect<Signature, SigningError> }
Signer.fromSdkSigner(signer)                                                  // any @mysten/sui/cryptography Signer: Ledger, wallet, KMS
Signer.fromKeypair(kp)                                                        // a thin alias; a Keypair is an SDK Signer
Signer.fromConfig(name = "SUI_PRIVATE_KEY"): Effect<Signer, ConfigError>     // Config.redacted + decodeSuiPrivateKey + scheme dispatch
Signer.ephemeral: Effect<Signer>
Signer.remote(f): Signer                                                      // KMS or wallet
```

A `Signer` never exposes secret material.

## 6. `Tx`: the lifecycle as functions (all `R = Sui`)

A recipe is a synchronous `(tx: Transaction) => void`. Reads happen in the surrounding Effect before the recipe. The draft is therefore pure, replayable and free of `R`.

```ts
Tx.build(input: Recipe | Transaction, opts: { sender: SuiAddress; gasOwner?: SuiAddress }):
  Effect<Built, BuildError | SimulationFailed | TransportError>
Tx.sign(built: Built, signer: Signer):     Effect<Signed, SigningError>
Tx.cosign(signed: Signed, signer: Signer): Effect<Signed, SigningError>
Tx.sponsored(opts: { sender; gasOwner }): (recipe: Recipe) => Recipe      // setSender, setGasOwner, setGasPayment([])
Tx.submit(signed: Signed):                 Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | JournalError | TransportError>
Tx.submitVia<E, R>(signed: Signed, send: (bytes, signatures) => Effect<unknown, E, R>):   // 0.1.2
  Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | JournalError | E, Sui | R>
Tx.reconcile(input: Digest | Signed | SubmissionUnknown):
  Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | TransportError>
Tx.recorded(digest: Digest): Effect<Option<JournalEntry>, JournalError>                  // 0.1.2
Tx.run(recipe: Recipe | Transaction, opts: { signer: Signer; gasOwner?: SuiAddress; sponsor?: Signer; onSigned?: (signed: Signed) => Effect<void, JournalError> }):
  Effect<Executed, BuildError | SimulationFailed | PolicyDenied | SigningError | ExecutionFailed | NotApplied | SubmissionUnknown | JournalError | TransportError>
Tx.reconcileAll(): Effect<ReadonlyArray<Reconciled>, JournalError | TransportError>       // Reconciled is a Schema.TaggedUnion since 0.1.2
```

`Reconciled` is `{ _tag: "Executed", executed } | { _tag: "ExecutionFailed" | "NotApplied" | "SubmissionUnknown", error }`: one discriminator in one place, which the 0.1.0 shape (a bare `Executed` beside three tagged errors) did not have. `reconcileAll` answers only for entries that were unresolved; `Tx.recorded` is how a caller asks about one that already settled.

`submit` carries `TransportError` for exactly one status: gRPC `INVALID_ARGUMENT`, the node refusing the request outright, where nothing was executed and reconciling would ask whether a never-sent transaction is on chain. Every other transport failure after the bytes may have gone out is still `SubmissionUnknown`.

`submitVia` is `submit` for a submission a third party makes: the `Signed` journal entry before the call, one call, the reply decoded into an `Executed` when it carries one, and `reconcile`'s evidence rules on an ambiguous failure. A `send` error whose instance declares `outcome: "not_applied"` fails through without a reconcile.

`submit` and `run` carry `NotApplied` because `submit` runs `reconcile` when its retries are exhausted, and proving that a transaction never applied is one of the three answers `reconcile` can give. `run` carries `TransportError` because `build` does: reads before the bytes exist can fail the ordinary way. Once bytes may have been sent, no `TransportError` escapes.

`reconcile` takes the signed bytes, not only a digest, because the evidence rules need them: given a bare `Digest` there is nothing to reason about and an unknown transaction is always `SubmissionUnknown` (with no `signed` on it, since there is nothing to re-send).

Semantics:
- **Building always simulates.** On gRPC the SDK resolve plugin calls `simulateTransaction` with checks enabled during `build` and throws `SimulationError` on execution failure, which `Tx.build` maps to `SimulationFailed`. But the resolver **returns early** for a transaction that is already fully resolved — every input resolved, gas price, budget and payment set — and then nothing simulates at all, so a fully resolved `Tx.run` could sign and submit a transaction that was never checked. `Tx.build` mirrors the SDK's `needsTransactionResolution` before it builds and, when the answer is "nothing to resolve", runs one explicit `simulateTransaction` with checks enabled afterwards. So simulate-before-submit is unconditional: it costs nothing extra when the SDK had to resolve, and one call otherwise.
- **An interrupted build cancels the request it started, on every transport.** `BuildTransactionOptions` has no `signal`, and the resolver simulates through whatever client it is given, so an interrupted `Tx.build` used to end — releasing the sender lock — with a simulate still in flight. `Tx.build` hands the SDK a proxy client whose `core` methods inject the Effect's `AbortSignal`, which covers the base resolver (JSON-RPC, GraphQL) because it goes through `client.core.*`. The **gRPC** resolver does not: `GrpcCoreClient#resolveTransactionPlugin` closes over the private grpc client it was constructed with and calls `transactionExecutionService.simulateTransaction(request)` with no second argument, while every other method on that class passes `{ abort: options.signal }`. So on a gRPC client the plugin is rebuilt rather than delegated: `GrpcCoreClient` is public, and constructing one over a `SuiGrpcClient` whose `transactionExecutionService.simulateTransaction` adds `{ abort: signal }` — and whose `core` is the already-signalled proxy, for the resolver's own `getChainIdentifier`/`getCurrentSystemState` reads — yields the SDK's own plugin, line for line, with the signal attached. Nothing is re-implemented, and the cache is shared through `base`. `test/final-batch.test.ts` proves it at the transport: a recording `RpcTransport` under a real `SuiGrpcClient` sees `SimulateTransaction` carrying an `AbortSignal`, and that signal aborted when the build timed out.
- **Default expiration.** If the recipe did not set one, `Tx.build` sets `ValidDuring { minEpoch: epoch, maxEpoch: epoch + 1, minTimestamp: null, maxTimestamp: null, chain: chainId, nonce }`, where `epoch` comes from one `getCurrentSystemState` read and `nonce` from `SubmitConfig.nonce` (a `u32` from `Random` by default; see §7 for why a collision is not a second execution). `Built` and `Signed` also record `chain: sui.chainId`, which is what the chain-identity guard below reads for the expiration variants that name no chain. The epochs are not optional: the validator rule is that a transaction must either have address-owned inputs or a `ValidDuring` expiration of **at most two epochs**, so an unbounded expiration is rejected outright for a PTB whose only object inputs are shared, and for every `Tx.sponsored` transaction, which pays gas from an address balance and so has no gas coins either. Setting an expiration also suppresses the SDK resolver's own default, so nothing else will supply the epochs later. The SDK only defaults an expiration when a transaction has no owned inputs, so ours is set unconditionally. The `chain` field is a replay guard, and a live node enforces it: bytes signed for testnet cannot land on mainnet. `Signed` records the expiration.
- **No wall-clock bound by default.** `maxTimestamp` is `null` unless `SubmitConfig.validFor` is set, because **no Sui network accepts a timestamp expiration yet**: a devnet node refuses any transaction that carries one with `Feature is not supported: Timestamp-based transaction expiration is not yet supported`, whether or not epochs are set alongside it (verified live against `fullnode.devnet.sui.io`, epoch 91, by `test/live.devnet.test.ts`). `validFor` stays in `SubmitConfig` so a network that gains support needs no new API, and so the wall-clock rule in `reconcile` has something to read.
- **Submit never rebuilds.** `Tx.submit` writes `JournalEntry.Signed` before the first `executeTransaction`, retries only the identical bytes on retryable `TransportError` or timeout, and when retries exhaust runs `Tx.reconcile`. `TransportError` never escapes `submit` once bytes may have been sent.
- **Reconcile.** `getTransaction(digest)` found means `Executed` or `ExecutionFailed`. Not found may only become `NotApplied` on one of two kinds of evidence, and both are deliberately hard to obtain.
- **Chain identity first.** Before any recovery query, the chain the bytes were built for — `ValidDuring.chain` / `Validity.chain`, or the `chain` field `Tx.build` records for the variants that name none — is compared with `sui.chainId`. A mismatch is `SubmissionUnknown` naming both chains and nothing is asked, because a transaction still valid on chain A must never be declared expired by chain B's epoch. The journal's memory default is process-wide, which makes a mixed-network process exactly the case that would have done it.
- **Expiry is ordered and repeated, never a single observation.** That an expiration window has closed proves the bytes cannot execute *later*; it does not prove they did not execute *earlier*, and execution can happen between a lookup and an expiry check. The Core API offers no historical non-inclusion proof, so `NotApplied { evidence: "expired" }` requires, **in this order**: (a) `getCurrentSystemState` reporting an epoch strictly greater than the recorded `maxEpoch` (or `chainTime` past a recorded `maxTimestamp` by more than `expiryMargin`), then (b) a `getTransaction` miss, then (c) after `SubmitConfig.reconcileRecheck` (2 seconds by default, through the `Clock`) both (a) and (b) again. Any other order, or a single observation, yields `SubmissionUnknown`. `SubmitConfig.expiryEvidence: "never"` disables the rule outright, which is what a deployment behind a mixed-node load balancer sets. **Residual risk:** a node whose transaction index lags its epoch view can satisfy the rule twice for a transaction it has in fact executed; the recheck makes that unlikely, not impossible.
- **`inputConsumed` needs the consuming transaction's own `inputVersion`.** That an owned input has advanced is *not* evidence: the transaction being reconciled is itself the likeliest thing to have advanced it. Nor is the live object's `previousTransaction` by itself, which names the **latest** mutation — T can consume version 3 and U version 4, and the object then names U, so reconciling T against it would report `NotApplied` for a transaction that applied.

  There is **no `v + 1` rule**. Sui stamps every output of a transaction with that transaction's **Lamport version**, `max(input versions) + 1` across all of its inputs, so an owned object read alongside a newer gas coin goes from version 4 to 6,436,928 and the object "at version 5" never existed. (Observed live: a Clock-reading PTB moved a gas coin from version 4 to 6,436,928; `getObjectAtVersion(gas, 5)` was absent, and the old rule therefore produced `SubmissionUnknown` with `AppliedByUs` evidence one read away.) The rule is instead: for each pinned reference — an owned input **or a gas payment coin**, both of which the bytes pin — that has moved on or is gone, read the live object's `previousTransaction` and then:
  - it is **our** digest: the transaction applied; `getTransaction` is asked once more and answers `Executed` or `ExecutionFailed`, or `SubmissionUnknown` if the node still does not serve it;
  - it is a **different** digest: fetch **that** transaction with effects and find our object in its `changedObjects`. `inputVersion` **equal to the version these bytes pinned** means those exact bytes can never execute again, and that is the only thing `NotApplied { inputConsumed }` is ever built on. A **greater** `inputVersion` means something between the two consumed our version and the node does not serve the state in between, so nothing is proven. A transaction that **failed** on chain still consumed its inputs, so its effects are read out of `ExecutionFailed` as readily as out of `Executed`;
  - nothing readable — a deleted object, a node that names no transaction, a transaction the node has pruned: nothing is proven, never `NotApplied`.

  **Every pinned reference is tried** before the answer is `SubmissionUnknown`; the first inconclusive one is remembered and the next is read. `SuiCore.getObjectAtVersion` stays as a public primitive — it is the only way to read an object as it was — but it is no longer part of this rule. In practice `SubmissionUnknown`, not `NotApplied`, is what almost every stuck submission gets whose PTB touched a shared object or an owned object older than the gas coin; a deployment plans an operator or `reconcileAll` path for it.
- **No `TransportError` escapes reconcile either.** `Tx.reconcile` and `Tx.reconcileAll` convert every recovery read failure into `SubmissionUnknown { digest, signed?, cause }`. `SuiError.outcome` puts `TransportError` on `"not_applied"` and `Script.exitCode` on 4, which about a submission that may have landed is the one answer that is never safe. `TransportError` stays in both signatures so the union does not shrink under callers. In `Tx.reconcileAll` the failure settles **that entry** and the loop goes on, rather than aborting a whole startup on one unreachable read.

  `Tx.reconcileAll` settles every entry through `Tx.reconcile`, so the same rules apply at startup.
- **Visibility before the lock is released.** Execute and indexing are two different operations: a transaction that executed is not necessarily one the next read or the next build's input resolution can see, and serializing per sender does not stop the second build resolving a gas coin the first one already spent. After a successful execute and **before** releasing the sender lock, `Tx.submit` calls `SuiCore.waitForTransaction({ digest })` bounded by `SubmitConfig.visibilityTimeout` (15 seconds). A wait that fails or times out **never changes the outcome**: the transaction executed, the failure is logged with the digest, and the `Executed` stands. `SubmitConfig.awaitVisibility: false` turns it off.
- **The journal never changes an answer.** `JournalError` escapes `Tx.submit` only from the `Signed` write, which happens before the first `executeTransaction`: failing there is honest, because nothing has been sent. Once execute or reconcile has answered, a journal write that fails is logged with `Effect.logError` annotated with the digest and the outcome stands — reporting a charged `ExecutionFailed` as `JournalError` would put it on exit 4, "safe to retry", and invite a second submission.
- **A signer must match the bytes.** `Tx.sign` and `Tx.cosign` compare `signer.address` with the sender and the gas owner read back out of the bytes, and fail with `SigningError` when it is neither. Otherwise a misconfigured credential becomes a non-retryable `INVALID_ARGUMENT` from `executeTransaction`, which `Tx.submit` can only report as `SubmissionUnknown` for a transaction that never had a chance. A `Signer.remote` therefore has to report the address it signs as truthfully.
- **A sponsored `run` needs both signatures.** A transaction whose gas owner is not its sender is signed by both parties; one signature on such bytes is something a validator rejects outright. `Tx.run` takes `sponsor?: Signer` and co-signs with it. When `opts.gasOwner` differs from the signer's address and no `sponsor` is given, it fails with `SigningError` naming the missing address **before** anything is built; the same check runs again on the addresses read back out of the built bytes, so a recipe that set its own gas owner — which `Tx.sponsored` does — is caught too. Two parties that cannot both sign in one process use the explicit lifecycle (`build`, `sign`, `cosign`, `submit`).
- **Sender lock.** Gas-coin selection happens at build, so `Tx.run` holds a sender lock from build through submit. The address that matters is the one whose coins are spent, which is the **gas owner** when there is one: two sponsored runs for different senders paid by one sponsor are exactly the case that picks the same coin twice. When sender and gas owner differ, both locks are held, in ascending address order, so two runs needing the same pair cannot deadlock. `Tx.build` and `Tx.submit` called separately do not lock; documented.
- **Preflight.** `SubmitConfig.preflight`, when set, costs one extra simulate with effects and is where spend limits and target policies plug in. It fails with `PolicyDenied` only, so `Tx.run` stays typed.
- **A nonce outside the `u32` range fails the build.** `SubmitConfig.nonce` is a caller-supplied allocator and a value the wire cannot carry is a configuration mistake, not a transport failure: `Tx.build` fails with `BuildError` naming the value, so nothing puts it on the retry path.
- **Retry after not applied** is a documented idiom, not an API: wrap the whole `Effect.gen` block (reads plus `Tx.run`) in `Effect.retry({ while: (e) => SuiError.outcome(e) === "not_applied", times: 3 })`. Because `outcome(ExecutionFailed)` is `"applied"`, the idiom never re-runs a transaction that charged gas.
- `waitForCheckpoint` is deferred to phase 2.

## 7. `SubmitConfig` (`Context.Reference`, defaults shown)

`expiration: "validDuring" | "epoch" | "none"` (`"validDuring"`, which costs one `getCurrentSystemState` read per build for the epoch bounds), `validFor?: Duration` (unset; an *additional* `maxTimestamp`, which every Sui network refuses today), `maxGasBudget: Mist` (50 SUI, the protocol maximum; `Tx.build` fails with `BuildError` when the budget the node chose is over it), `preflight?: (sim: Simulation) => Effect<void, PolicyDenied>` (none), `lockSender: boolean` (true), `resubmit: Schedule` (jittered exponential, 30 second cap), `resubmitAttempts: number` (5), `executeTimeout: Duration` (60 seconds, after which one `executeTransaction` is treated as a retryable transport failure), `expiryMargin: Duration` (30 seconds of clock skew `Tx.reconcile` allows before calling a transaction expired), `expiryEvidence: "epochThenMiss" | "never"` (`"epochThenMiss"`; whether a closed expiration window may be evidence at all, §6), `reconcileRecheck: Duration` (2 seconds; the delay between the two observations that rule needs), `awaitVisibility: boolean` (true) and `visibilityTimeout: Duration` (15 seconds), which bound the `waitForTransaction` `Tx.submit` makes after a successful execute, and `nonce: Effect<number>` (a `u32` from `Random`).

`nonce` is what makes two otherwise identical address-balance transactions in one epoch different bytes with different digests. The default is process-local and does not survive a restart: independent 32-bit draws collide with probability about 1.16% after ten thousand such transactions. **A collision is not a second execution** — identical bytes have one digest and one journal key, so the second build *is* the first transaction; the failure mode is a transaction that can no longer be sent because its digest is taken, not a duplicated intent. A deployment that cares supplies a monotonic allocator that survives restarts (a counter in the store the journal uses, an id service); the value must be an integer in `[0, 2^32)` or the build fails. A journal-backed allocator is deferred (§15).

`resubmitAttempts`, `executeTimeout` and `expiryMargin` are separate fields rather than constants because each is a number a test has to be able to drive and an operator has to be able to change: the attempt count is not expressible in a v4 `Schedule` that also has to be jittered, the timeout is what makes `Cause.TimeoutError` reachable at all, and the margin is the difference between "probably gone" and "provably gone".

## 8. `Journal` (`Context.Reference`, memory default)

Interface: `put(entry)`, `get(digest)`, `listUnresolved`. The memory default keeps `Journal` out of `R` and makes a one-shot script work with zero setup — and, because a `Context.Reference`'s default is computed once and cached on the reference, it is **process-wide**, so a test that submits provides `Journal.layerMemory` to stay isolated; for scripts, the signed bytes inside `SubmissionUnknown` are the durable record and `describe` prints digest plus base64 bytes. Because a `Context.Reference`'s identifier is `never` in v4 — which is exactly why it stays out of `R` — the layers that provide one are `Layer<never, ...>`; `Journal.layerMemory` is a fresh in-memory journal for a test or a process that wants its own, since the default value is computed once and cached on the reference.

**Write order is crash-safety, and it depends on the entry.** The store has no key enumeration, so the journal keeps its own index of unresolved digests under one key, and a `put` is two writes. An **unresolved** entry (`Signed`, `Unknown`) writes the **index first**, so a crash between the two leaves a digest whose entry is missing, which `listUnresolved` skips. A **terminal** entry (`Executed`, `Failed`, `NotApplied`) writes the **entry first** and only then drops the digest from the index, so a crash leaves the digest still indexed with its terminal answer already stored — `listUnresolved` reads it, sees it is resolved and skips it. The other order is how a settled transaction reverted to a stale `Signed` entry that startup recovery could no longer find.

**Single writer per store prefix, and it is a limitation, not a guarantee.** The `put` semaphore is module-level, keyed by the store prefix, so two journal instances built in one process share it. Two *processes* over one store still race: `KeyValueStore` has no compare-and-set, so there is nothing to build a cross-process lock on. Run one writer per prefix; a storage-level lock is deferred (§15).

`@unconfirmed/sui-effect/journal` provides `layerKeyValueStore({ onUnresolved: "fail" | "ignore" }): Layer<never, JournalError, KeyValueStore>` and `makeKeyValueStore(store)` as module-level functions, and re-exports the unchanged `Journal` reference. They are not statics on `Journal`: attaching them would mean mutating the one shared reference object at import time, which a package marked `sideEffects: false` is entitled to have dropped. `KeyValueStore` has no key enumeration, so the journal keeps its own index under one key: the digests that are still unresolved, rewritten whenever an entry is put. Layer build does no network work beyond listing entries; an application that wants to reconcile at startup calls `Tx.reconcileAll: Effect<ReadonlyArray<Reconciled>, JournalError | TransportError, Sui | Journal>` explicitly. This keeps the layer dependency direction simple and keeps network calls out of layer construction.

## 9. `JournalEntry` (`Schema.TaggedUnion`)

`Signed { digest, signed, signedAt }`, `Executed { digest, checkpoint?, at }`, `Failed { digest, reason, at }`, `NotApplied { digest, evidence, at }`, `Unknown { digest, signed, lastError, attempts, at }`, where `signed` is a `SignedTransaction { digest, bytes, signatures, sender, expiration? }` — one representation of signed bytes, shared with `SubmissionUnknown`, rather than the same five fields spelled out twice. `lastError` is the `SuiError.describe` line, so an entry is JSON with no error schema nested inside it. `Signed` and `Unknown` are the unresolved tags; `Executed`, `Failed` and `NotApplied` are terminal. `NotApplied` is terminal and therefore a variant of its own: recording a proven-dead submission as `Unknown` would leave it in the durable journal's unresolved index forever, and `onUnresolved: "fail"` would refuse to build for the life of the store. This is the only place the lifecycle appears as a union; the program abstraction is the functions in section 6.

## 10. Errors

All `Schema.TaggedError` so they serialize. Flat tags, no inheritance.

| Tag | Fields |
|---|---|
| `TransportError` | `method`, `retryable`, `status?`, `cause` (timeouts map here with `retryable: true`, `status: "DEADLINE_EXCEEDED"`) |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | `objectId`, `version?` (the three `ObjectError.reason` values) |
| `TransactionNotFound` | `digest` |
| `NetworkMismatch` | `expected`, `actual` |
| `DecodeError` | `objectId?`, `expectedType?`, `kind: "type" \| "bytes" \| "shape"`, `issue` |
| `SimulationFailed` | `reason: ExecutionReason`, `message` |
| `ExecutionFailed` | `digest`, `reason: ExecutionReason`, `command?`, `effects` |
| `SubmissionUnknown` | `digest`, `signed?`, `cause` (absent only when `Tx.reconcile` was given a bare digest, so there are no bytes to carry) |
| `NotApplied` | `digest`, `evidence: "expired" \| "inputConsumed"` |
| `SigningError` | `cause` |
| `BuildError` | `message`, `cause` |
| `PolicyDenied` | `rule`, `message` |
| `JournalError` | `cause` |
| `GraphQLUnavailable` | `method`, `reason` (what `SuiGraphQL.layerUnavailable` rejects every call with; outcome `not_applied`) |
| `ExtensionNotReady` | `extension`, `member` (a synchronous member of a Promise face called before its runtime existed; outcome `not_applied`, see 13.2) |
| `UnexpectedEffects` | `digest`, `expected: string`, `found: ObjectId[]` (the ids that did match, so zero and many are told apart; `expected` is the string the caller asked for, because fabricating a valid `StructTag` from an invalid one is worse than repeating it). Outcome **`applied`**, exit **5**: it is built from an `Executed`, so the transaction reached the chain and gas was charged; only the receipt is missing |

`ExecutionReason` and `Owner` are `Schema.Union([...]).pipe(Schema.toTaggedUnion("$kind"))` rather than `_tag` unions, so the discriminant is the SDK's own `$kind` and our narrowing and the SDK's agree. `ExecutionReason` mirrors `SuiClientTypes.ExecutionError` exactly (`MoveAbort` with `abortCode: bigint`, `location`, `cleverError`; `SizeError`; `CommandArgumentError`; `TypeArgumentError`; `PackageUpgradeError`; `IndexError`; `CoinDenyListError`; `CongestedObjects`; `ObjectIdError`; `Unknown`). Clever-error constant names are decoded automatically; a per-package abort registry is deferred.

`TransportError.fromUnknown(method, cause, retryable?)` is the constructor an extension uses for its own network calls: it classifies `status` and `retryable` exactly as `SuiCore` does for the SDK's failures (gRPC status names, HTTP 5xx and 429, aborts and timeouts), so a hand-built `TransportError` never drifts from the library's.

`SignedTransaction` and `Built` carry `chain?: string`, the chain identifier `Tx.build` was run against, so the chain-identity guard in §6 works for the expiration variants (`Epoch`, `None`) that name no chain themselves.

`SuiError` is the union plus four helpers every repo hand-rolls today: `isRetryable(e)`, `outcome(e): "applied" | "not_applied" | "unknown"` (`applied` for `ExecutionFailed` and `UnexpectedEffects`, `unknown` for `SubmissionUnknown`, `not_applied` for every other tag **in the taxonomy**, and `unknown` for anything else — see 13.1), `describe(e): string` (one actionable line, for example `ExecutionFailed MoveAbort 0x..::escrow::claim code 3 (EAlreadyClaimed) in command 1`), and `toJson(e)`.

## 11. Branded schemas and the BCS bridge

`SuiAddress`, `ObjectId`, `Digest`, `StructTag`, `CoinType`, `Signature`, `Mist` (`bigint`) as `Schema.String.pipe(Schema.check(...), Schema.brand(...))` with normalization on decode via `SchemaGetter.transform` (`normalizeSuiAddress`, `normalizeStructTag`). `SuiSchema.bcs(bcsType, expectedType?)` turns a `@mysten/bcs` `BcsType<T>` into `Schema.Codec<T, Uint8Array>` that decodes from `content` bytes only (never the transport-varying `json`).

**One type-matching rule, everywhere.** `typeMatches(expected, actual)` parses both with `parseStructTag`. When the expected tag carries **no type arguments** it names the generic itself and only `address::module::name` is compared, so `pkg::m::Composition` accepts `pkg::m::Composition<0x…::share::Share>` — which is what a node does with a bare type filter, and what makes one codec usable for a generic Move type. When the expected tag **carries** type arguments the two are compared in full after `normalizeStructTag`, so `Coin<0x2::sui::SUI>` matches its padded spelling and not `Coin<…::usdc::USDC>`. Anything that is not a struct tag (the literal `package`) compares as a normalized string. The object keeps its own instantiated type on `SuiObject.type`. The same function decides the `expectedType` option of `getObject` / `getObjectOption` / `getObjects`, the `actualType` check inside `SuiSchema.decode`, and the `type` filter of `SuiCoreFake.listOwnedObjects`, which would otherwise be stricter than a node.

`expectedType` is **optional**: a Move return value has no struct tag, so `SuiSchema.bcs(bcs.Address())` for a `Sui.view` carries none and nothing is compared. The re-serialize length check is still what rejects mis-shaped bytes. It must be a `BcsType`, not merely a `{ parse }` codec: the bridge re-serializes what it parsed to reject trailing bytes, which is what stops an `objectBcs` envelope from decoding as the struct it wraps (generated codegen output is a `BcsType`, so this costs nothing in practice). The expected type is stored as a schema annotation and read back by walking the encoding chain, so `SuiSchema.bcs(...).pipe(Schema.decodeTo(DomainClass, ...))` keeps the check; `getObject`, `getObjectOption` and `getObjects` also accept an explicit `expectedType` for codecs built some other way. A `Uint8Array` field that can reach an error or a journal entry (`SignedTransaction.bytes`) uses a base64 codec, so `SuiError.toJson` is JSON.

## 12. `Script` preset (`@unconfirmed/sui-effect/script`)

- `Script` is a `Context.Service` `{ sui: Sui, core: SuiCore, signer: Signer, network }`. `Script.layer` reads `SUI_NETWORK` (required, no default; `mainnet` refused unless `SUI_ALLOW_MAINNET=1`), `SUI_RPC_URL` (optional), `SUI_PRIVATE_KEY` (Bech32, `Config.redacted`), and provides `Sui` and `SuiCore` alongside `Script`, so `Tx.*` works inside a script with no further wiring. `Script.layerReadOnly` provides a separate service, `ScriptReadOnly`, whose shape has no `signer`: one service cannot have two shapes, and a script written against `Script` must not silently build over a layer that cannot sign. `Script.layerNoDeps`, `Script.layerWithSigner(signer)` and `Script.layerReadOnlyNoDeps` build over a `Sui` the caller already has, which is how a test runs a script against the fake.
- `Script.run(effect, options?)` installs SIGINT/SIGTERM handlers, interrupts the root fiber, waits for finalizers, maps the `Exit` to an exit code, exits and returns the code. No platform dependency: `process` is the only global it touches, and `options` can replace `exit`, `stderr`, `signals` and the `layer`, so a test drives the whole path without ending the test process. `Script.exitCode(exit)` is exported for consumers on `BunRuntime.runMain`.
- stdout carries the script's data only. `Script.run` installs a logger bound to the injected stderr writer for the whole run, so `Effect.log` from the script or from anything it calls cannot corrupt the script's output; `describe` output goes there too, one line per failure plus `digest:` when present, and for `SubmissionUnknown` the base64 bytes and a reconcile hint. On **every non-zero exit** — a typed failure as much as an interrupt or a defect — it additionally prints whatever the journal still holds unresolved (`unresolved <digest> (<tag>)` and the base64 bytes), because a script that fails after a submission leaves the same record on the wire as one that is killed. The journal it reads is the one the script **ran with**, captured inside the script runtime: reading the bare reference afterwards would find the process-wide memory default and print nothing for exactly the script that provided a durable journal.
- A second SIGINT is ignored. The handler interrupts the root fiber once; the point of the first interrupt is to let finalizers — the journal write above all — run to completion. A script whose finalizers hang has to be killed with SIGKILL, which no process can handle.
- Exit codes: 0 success; 1 defect or unclassified; 2 configuration (`ConfigError`, `NetworkMismatch`, `SchemaError` — what `Config.schema` and `Schema.decodeUnknownEffect` fail with, which in a script can only mean an input did not fit its schema — and the mainnet gate, which is read before the client is built, through `Layer.unwrap`, so a script pointed at mainnet without `SUI_ALLOW_MAINNET=1` never opens a connection); 3 unknown outcome (`SubmissionUnknown`); 4 not applied (`SimulationFailed`, `BuildError`, `SigningError`, `PolicyDenied`, `NotApplied`, `DecodeError`, `JournalError`, the not-found family, `TransportError` after retries); 5 applied but failed on chain (`ExecutionFailed`, and `UnexpectedEffects`, which can only come from one); 130 interrupt.
- **A timeout or an interrupt asks the journal.** `Cause.TimeoutError` sits outside the taxonomy, and it used to be mapped unconditionally to 4 on the theory that `Tx.submit` turns a timed-out submission into `SubmissionUnknown` first. An `Effect.timeout` wrapped *around* a submission interrupts it from the outside and never reaches that mapping, so the bytes may be on the wire. `Script.exitCode(exit, { unresolved })` therefore takes the count of unresolved journal entries — `Script.run` fills it in from the journal it captured — and a timeout exits **3** when there is one and 4 otherwise; an interrupt exits **3** when there is one and 130 otherwise, because a wrapper that sees 130 has no reason to go looking for a transaction to reconcile. The applied / not applied / unknown axis matches what a wrapper script acts on and matches publish's existing exit 3.
- No `--json` flag at this level; the consumer's CLI owns flags and can use `SuiError.toJson`.

The target shape of an on-demand script:

```ts
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "@unconfirmed/sui-effect"
import { Tx } from "@unconfirmed/sui-effect/tx"
import { Script } from "@unconfirmed/sui-effect/script"
import { bcs } from "@mysten/sui/bcs"

const PKG = "0x…"
const Escrow = SuiSchema.bcs(bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }), `${PKG}::escrow::Escrow`)

Script.run(Effect.gen(function*() {
  const { sui, signer } = yield* Script
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const executed = yield* Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(id), tx.pure.u64(escrow.content.amount)] })
  }, { signer })
  const receipt = yield* executed.expectCreated(`${PKG}::escrow::Receipt`)
  yield* Console.log(receipt.id)
}))
```

Not found, Move abort, unknown outcome and configuration errors are all distinct exit codes with zero handling lines, and the generator's inferred error type lists every one of them.

## 13. Extensions: how downstream SDKs are built

Every downstream SDK we own will be rewritten on sui-effect, and the extension mechanism is the main way consumers will reach Sui. So extensions are a first-class contract with their own module, guide and template, not a hatch.

### 13.1 An extension is an Effect service built on `Sui` and `Tx`

```ts
export class Onara extends Context.Service<Onara, {
  status: Effect<Status, OnaraUnavailable | TransportError>
  sponsor(built: Built): Effect<Signed, SponsorshipDenied | OnaraUnavailable | TransportError>
  sponsorAndRun(recipe: Recipe, opts: { signer: Signer }):
    Effect<Executed, BuildError | SimulationFailed | SponsorshipDenied | SigningError | ExecutionFailed | SubmissionUnknown | JournalError>
}>()("onara/Onara") {
  static layer(opts: OnaraOptions): Layer<Onara, never, Sui | HttpClient>
  static layerConfig: Layer<Onara, ConfigError, Sui | HttpClient>       // ONARA_URL, ONARA_API_KEY
  static layerTest(state?: OnaraFakeState): Layer<Onara, never, Sui>
}
```

Conventions, enforced by the guide and by review:

- **Identifier** is `"<package>/<Name>"`. One service per package unless there is a real reason for more.
- **Every method returns an Effect** whose error union is the sui-effect taxonomy plus the extension's own `Schema.TaggedError` classes. No `unknown`, no plain `Error`, no `Promise` in the interface.
- **Reads go through `Sui`, writes through `Tx`.** An extension never calls `SuiCore.executeTransaction` directly; it calls `Tx.submit` or `Tx.run` so the journal, expiration, sender lock and reconcile apply to every transaction on the platform. It reaches `SuiCore` only for fields or methods `Sui` does not expose.
- **Transaction contributions are recipes, not submissions.** An extension that adds commands to a transaction exposes recipe fragments (`(tx) => void`) or recipe transformers (`Recipe => Recipe`, like `Tx.sponsored`). Consumers compose several extensions into one PTB and submit once. An extension only submits on the consumer's behalf when that is its purpose (onara's sponsor-and-run), and then it exposes the recipe-level pieces too.
- **Layers** follow the house skill: `layer(opts)`, `layerConfig` reading `<PREFIX>_*` through `Config` with secrets as `Config.redacted`, `layerTest` backed by a `Ref`, and for an extension over a published Move package a `layerBundled` that reads `sui.network` through `Layer.unwrap` and fails with the package's own deployment error on a network it does not bundle. A layer never constructs its own client; it may require `Sui | SuiCore` and provides everything else — including another extension's service — inside itself.
- **Errors** are `Schema.TaggedError` with a unique tag prefixed by the package name where collision is plausible. An extension error may declare its outcome for the script exit-code axis by implementing `outcome: "applied" | "not_applied" | "unknown"`; `SuiError.outcome` and `Script.run` honour it. `describe` uses the error's `message`.
- **Declare `outcome` on every error you define.** An error that neither carries a taxonomy tag nor declares an `outcome` is *unclassified*, and the two helpers answer differently on purpose. `SuiError.outcome` returns `"unknown"`: a tag this library has never heard of says nothing about whether a transaction applied, and `"not_applied"` would tell the documented retry idiom to send again on no evidence at all. `Script.exitCode` returns 1, the code that also means defect, rather than 3: exit 3 tells a wrapper there is a digest to reconcile, and an unrecognised error is not evidence that anything was ever sent. The `"not_applied"` default is for sui-effect's own taxonomy, not for yours.
- **Observability** comes for free from `Effect.fn("Onara.sponsor")` on every method.
- **Signers are parameters.** An extension never holds a consumer signer in its layer; it holds only its own credentials (a sponsor key, an API key).

### 13.2 `SuiExtension.fromService`: the Promise face for non-Effect consumers

```ts
export const onara = (opts: OnaraOptions) =>
  SuiExtension.fromService(Onara, { name: "onara", layer: Onara.layer(opts) })

// Promise consumer, unchanged from today:
const client = new SuiGrpcClient({ network: "testnet", baseUrl }).$extend(onara({ url }))
const status = await client.onara.status()
```

`fromService` returns a `SuiClientRegistration` whose `register(client)` builds a `ManagedRuntime` over a **base shared per client**, `SuiCore.layerFromClient(client)` plus `Sui.layerNoDepsWith(options.sui)`, and the extension layer, and exposes each interface member as a Promise-returning method (or an `AsyncIterable` for Streams), mapping nested objects of members recursively so a namespaced surface (`client.miso.protocol.*`) works. **The recursion is by type, not by declaration style**: an `interface`-typed namespace is mapped exactly like a type alias (before 0.1.1 the type's bound was `Record<string, unknown>`, which an interface is not assignable to, so the type said `Effect` where the runtime produced a `Promise`). The leaves are functions, arrays, `Uint8Array`, `Date`, `Promise`, a BCS codec (recognised by `parse` plus `serialize`) and anything marked `SuiExtension.Leaf<T>` with `SuiExtension.leaf(value)` — which is how a class instance whose methods return `Effect`s is declared a value rather than a namespace, since the runtime passes class instances through untouched. Rejections are the same tagged error instances, so a Promise consumer can still switch on `_tag`. One implementation, two faces; the Effect face is the one agents and our own scripts use.

Options beyond `name` and `layer`:

- `layer` is bounded by `Layer<Self, E, Sui | SuiCore>`. The rule is not "requires `Sui` and nothing else" but *requires nothing the consumer's client could have provided*: an extension's own dependencies (an `HttpClient`, a `SuiGraphQL`, another extension's service) are provided inside its layer or in the function that builds the registration.
- `sui?: SuiLayerOptions` is routed to `Sui.layerNoDepsWith`, so an extension whose deployment names a custom network's `chainIdentifier` can pin it and refuse another chain.
- `warm?: { chainId? }` builds the runtime **synchronously inside `register`**, over a `Sui.layerNoDepsPinned`. The whole layer is built there, so **any** failure of it — a missing deployment, a configuration error, a `NetworkMismatch` — is thrown synchronously out of `register`, which means out of `client.$extend(...)`; catch it where you register. A layer that needs an asynchronous step throws out of `register` — that is the contract, not an accident — and the chain identifier is **taken rather than read**: `warm.chainId`, else `sui.chainId`, else the `KNOWN_CHAIN_IDS` entry for the client's network; on a network with no entry (`devnet`, `localnet`, anything custom) `warm` throws rather than guess. Nothing is asserted against the node at registration, and **nothing is asserted later either**: the id is what `Sui.chainId` reports and what `Tx.build` stamps on the expiration from the first call onwards. A node on another chain is detected by the chain — a validator refuses bytes signed for another chain — not by this layer. The node is consulted for the first time when the extension itself makes a call. A registration that wants the assertion is registered lazily instead.

**One base per client per chain id.** Every registration on one client whose **effective chain id** is the same — `warm.chainId`, else `sui.chainId`, else the `KNOWN_CHAIN_IDS` entry — shares a single `Sui` and `SuiCore`: one transport, one chain identity and, the reason it matters, **one sender-lock map**, so two different extensions calling `Tx.run` for the same address serialize instead of both selecting gas. Keying by the effective chain id rather than by the registration's style is what makes a `warm` registration and a lazy one share, which is the pair the extension template itself has; keying by "read" versus "pinned" meant they never did.

Because a `warm` registration must build synchronously, the shared base for a known chain id is always the **pinned** one, and a **lazy** registration joining it performs its `getChainIdentifier` assertion as one extra layer on top — built through the same memo map, so it runs exactly **once** however many lazy registrations join, and a node on another chain still fails the build. Only a network with no known id at all falls back to a base that reads the identifier.

The key is the client's `core`, not the client: `client.$extend(a).$extend(b)` hands each `register` a different `Proxy` of the same client, and keying by the client meant two chained registrations shared nothing. The base is a `Layer.MemoMap` that Effect reference counts: it is built on the first registration that needs it and released when the last one that used it is disposed. Only the base is shared — each registration still builds its own extension layer, so "register once per client and keep the extended client" remains the rule for whatever that layer holds.

**The synchronous-member rule.** By default the runtime is built on first use, and until it exists nothing knows what a member is. An `Effect` member returns a Promise, as the face promises, and a `Stream` member returns a real `AsyncIterable` whose iterator awaits the runtime internally — the cold call returns a value that is a thenable **and** an async iterable, because nothing yet knows which of the two the member is. A **synchronous** member — a recipe builder, a package id — does not: `PromiseFace` types those as synchronous, so the face fails with `ExtensionNotReady` (naming the member) instead of returning a `Promise` where the type says a value.

The runtime recursion is into **plain-prototype objects only** — a class instance is passed through — while the type recurses into every object that is not one of the leaves above; `SuiExtension.leaf` is what puts the two back in step for a class instance that is a value. The remaining disagreement cuts the other way: a plain-object *value* member (`deployment: { packageId }`) is indistinguishable from a namespace of members, so `PromiseFace` types it as the value while the cold face treats it as a namespace and hands back a placeholder for `deployment.packageId`. Reading that placeholder throws `ExtensionNotReady` naming `deployment.packageId` — the failure is typed and named, not a silent wrong value — but the fix is one of the two cures, not a retry: give the extension `warm`, or `await $ready()`, or expose the value through an `Effect` member. Do not put a plain-object value member on a service that is registered lazily. The face carries `$ready(): Promise<void>`, which builds the runtime and resolves the service so every member is real afterwards, and `$dispose()` (`dispose()` is kept as an alias). `$dispose` is not final: the next call builds a fresh runtime, and a **`warm` registration re-runs its warm build** rather than degrading to cold. Each `register` is independent.

A cold member call returns a real `Promise` subclass that also implements `Symbol.asyncIterator` — so `instanceof Promise` holds, `expect(...).rejects` works, and a cold `Stream` call is still iterable — and its rejection is pre-handled, so a cold call nobody awaits cannot abort the process with an unhandled `ExtensionNotReady`.

### 13.3 Third-party packages: we maintain Effect-native variants

For upstream SDK extensions we do not own (suins, deepbook, and whatever comes next), we do not lift their Promise surfaces generically. We maintain our own Effect-native extension for each one, built to the 13.1 contract, published alongside sui-effect (for example `@unconfirmed/suins-effect`). Each variant depends on the upstream package for its logic (BCS layouts, PTB construction, name resolution) and wraps those calls behind a `Context.Service` with precise per-method error unions, spans, signal forwarding and a `layerTest`. The upstream registration is never exposed to consumers.

Consequences:

- Precise errors instead of a broad `SuiError` union, because we read the upstream code and map its failures.
- One convention for every extension a consumer meets, whether we wrote the logic or wrapped it.
- The authoring guide gets a section on wrapping an upstream Promise package: `SuiCore.use` for calls that need the client object, `Effect.tryPromise` with a mapping function for pure upstream helpers, and a rule that upstream types are re-exported only after being narrowed to sui-effect schemas.
- A generic `SuiExtension.lift` is deferred; it may return later as a stopgap for packages we have not wrapped yet.

### 13.4 The extension authoring guide (a v1 deliverable)

`docs/extensions.md`, shipped in the package and included in `LLMS.md`, covering: the service shape above with a complete worked example (the onara rewrite is the canonical one); how to define errors and declare outcomes; recipe fragments versus submissions and how consumers compose them; `layer`, `layerConfig`, `layerTest`; deriving the Promise face with `fromService`; testing on `layerTest` from `@unconfirmed/sui-effect/testing` and `TestClock` with zero network; composing extensions; converting an existing facade; a layer that picks its deployment from `sui.network`; how to depend on sui-effect before a release; a review checklist mirroring the effect-ts skill's (reject any Promise in an interface, any direct `executeTransaction`, any signer held in a layer, any `unknown` in an error channel). `examples/extension-template/` is a copyable package skeleton that typechecks against the pinned rcs. `@unconfirmed/sui-effect/testing` ships an extension harness: `layerTest` plus the fake `SuiCore` with helpers to script object state and execution outcomes for an extension's tests.

### 13.5 `SuiGraphQL`: one tag, no wrapper

sui-effect does not wrap the GraphQL API, and the Effect-native GraphQL tier stays deferred (section 15). What it owns is the **tag**: `SuiGraphQL` is `Context.Service<SuiGraphQL, SuiGraphQLClient>()("@unconfirmed/sui-effect/SuiGraphQL")` over the SDK's own client, exported from the core subpath, so two extensions that both read GraphQL — and the application that configures the endpoint — agree on one client instead of each opening its own and each inventing a name for the failure.

- `SuiGraphQL.layer(client)` over a client the caller built.
- `SuiGraphQL.layerConfig` reads `SUI_GRAPHQL_URL` and `SUI_NETWORK` (the same variable `SuiCore.layerConfig` reads: an endpoint for one chain and a node for another is a misconfiguration no error can describe afterwards).
- `SuiGraphQL.layerUnavailable` (and `layerUnavailableWith(reason)`) provides a client whose every call rejects with `GraphQLUnavailable { method, reason }`. This is what an application with no endpoint provides: the absence becomes the failure the extension already handles, at the call it would have made, instead of a layer that will not build.

- `SuiGraphQL.query(run, method?)` is that mapping, once: it yields the client, runs one call in `Effect.tryPromise`, passes a `GraphQLUnavailable` through unchanged and turns anything else into `TransportError.fromUnknown(method, cause)`. Its type is `Effect<A, GraphQLUnavailable | TransportError, SuiGraphQL>`. Every extension that read GraphQL was re-deriving those three lines and the passthrough was the part that got forgotten.

An extension may still call `query` or `execute` inside its own `Effect.tryPromise` and map the rejection into its own union — `GraphQLUnavailable` as it is, or `TransportError.fromUnknown` for a call that reached the endpoint and failed.

## 14. Testing

- `SuiCoreFake.layer(script)` in `@unconfirmed/sui-effect/testing`: a `Map` of objects plus scripted outcomes for `getChainIdentifier`, `getReferenceGasPrice`, `getObjects`, `listCoins`, `simulateTransaction`, `executeTransaction`, `getTransaction`, the resolver's budget simulation (`buildSimulate`, which is how a test makes `Tx.build` fail with `SimulationFailed`), and the Clock object `0x6`. Outcomes include `succeed`, `failWith(reason)`, `transportError(status)`, `notFound()`, `timeoutThen(found)`. It also implements `resolveTransactionPlugin`, so `transaction.build({ client })` resolves gas price, gas budget, gas payment and object inputs from the script with no network, and it keys pending and known transactions by `TransactionDataBuilder.getDigestFromBytes` of the bytes it was given, so journal and reconcile tests are stable. No Move execution, no dynamic fields; localnet covers those.
- The fake enforces the invariants lifecycle tests depend on. **Known-digest execution is idempotent**: re-submitting identical bytes returns the recorded result without reapplying the scripted changes, which is what makes replay idempotency testable (it used to take an object from version 3 to 5). **Gas selection excludes object inputs**, the way a validator requires, and resolves them first to do it. **Coin state evolves**: a deleted coin leaves the set, a mutated one takes its new version and its `FakeChange.balance`, a gas coin's version is bumped, and a created coin joins. **A submission with fewer signatures than the bytes name distinct signing addresses is refused** with a non-retryable `INVALID_ARGUMENT`, which is what a sponsored transaction signed by one party gets from a node. And the fake keeps a **version history** and serves it through `tryGetPastObject`, which is how `SuiCore.getObjectAtVersion` — and therefore the consumer-identification rule in §6 — works against it.
- `layerTest(script)` in `@unconfirmed/sui-effect/testing` is `Sui.layerNoDeps` over the fake, so tests exercise the real high tier and the real `Tx.submit` under `TestClock`, under the production chain-id rules. `layerExtensionTest(layer, script)` puts an extension's own layer over it, and composes with whatever fakes that layer carries for the things that are not the chain.
- The fake's `client` is a `ClientWithCoreApi` and **implements `$extend`**, so a derived Promise face is testable the way a consumer writes it. Its `listOwnedObjects` filters by `typeMatches`, not string equality, so a bare tag matches every instantiation as it does on a node; its `getDynamicField` matches an entry by `name.type` only, not by the `name.bcs` bytes.
- `TestSchema.Asserts` round-trips every error class and every `JournalEntry` variant.
- The `TransportMethods` completeness type test.
- Localnet integration tests behind `SUI_LOCALNET=1`. (A devnet proof of the default expiration and the whole `Tx.run` lifecycle ships now, behind `SUI_LIVE=1`, in `test/live.devnet.test.ts`.)
- Dogfood order: the onara SDK rewrite as an extension (it exercises `Sui`, `Tx`, `fromService` and the guide), then `publish` (consumes the onara extension, already idempotency-shaped), then m2m's journal code and its suins usage through our maintained suins variant.

## 15. Deferred

A journal-backed (restart-surviving) nonce allocator for `SubmitConfig.nonce`, a storage-level cross-process lock for the durable journal's index, `@unconfirmed/sui-effect/ai` toolkit, event and transaction streams (first in line once the bcs-only decoding rule is settled), gRPC subscriptions, per-package abort registry, `waitForCheckpoint`, a GraphQL-backed `SuiCore` and any Effect-native wrapping of the GraphQL API (the `SuiGraphQL` tag in 13.5 is not that), `effect/unstable/workflow` integration, Move ABI to Schema codegen, MVR conveniences, `Tx.runEffect` with an effectful recipe, a generic `SuiExtension.lift` for not-yet-wrapped upstream packages.

## 16. Phases

- **Phase 0:** scaffold, `SuiCore` with gRPC layer and fake, errors, branded schemas, BCS bridge, `Sui` reads and streams, completeness test. Typecheck and tests green.
- **Phase 1:** `Signer`, `Tx.*`, `SubmitConfig`, memory `Journal`, `Executed` accessors, `SuiExtension.fromService`, the extension authoring guide and template (including the section on wrapping an upstream package), the extension test harness, `Script` preset, `LLMS.md`. Proof: rewrite the onara SDK as an extension and confirm its existing Promise consumers work unchanged through `fromService`.
- **Phase 2:** durable journal and `Tx.reconcileAll`, events stream, `waitForCheckpoint`, abort registry, the `sui-effect` skill in `unconfirmedlabs/skills`, `publish` and m2m ports, and the first maintained third-party variant (suins, since m2m already uses it) as the worked example of section 13.3.
