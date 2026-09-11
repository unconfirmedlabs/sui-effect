# sui-effect: v1 specification

Status: converged after a four-round adversarial design review on 2026-09-11 (see `docs/debate-log.md`). Research inputs live in `docs/research/`. This document is the scope for the first implementation; anything not listed is deferred (section 14).

## 0. Purpose in one paragraph

sui-effect is an opinionated Effect v4 layer over `@mysten/sui` 2.x for building safe TypeScript applications and on-demand agent scripts on Sui. The SDK keeps doing BCS, transaction building, signing and transport. sui-effect owns the shape of the program around it: two client tiers, closed error unions on every function, the transaction lifecycle as functions with typed outcomes, crash-safe submission, and time, retry and interruption through Effect so tests can drive them. Every public name mirrors the SDK name it wraps so an agent that knows the SDK can guess sui-effect.

Three audiences, each with a stated entry point:

- **SDK authors** (our own downstream packages: onara, publish, m2m, future ones) build on `Sui` and `Tx` and ship an Effect service plus a derived Promise-facing client extension. Section 13 is their contract.
- **Script writers and agents** use `Script`, `Sui`, `Tx` and those SDK services directly, with full typed errors.
- **Promise consumers** (dapp-kit, third-party TypeScript) use the derived `$extend` registration on a plain SDK client and never see Effect.

`SuiCore` is the floor for all three. `Sui` and `Tx` are primarily the SDK author's toolkit; most consumer code will call an extension service, not `Sui`.

## 1. Modules and dependencies

| Subpath | Contents |
|---|---|
| `sui-effect` | `SuiCore`, `Sui`, `SuiGraphQL`, errors, branded schemas, `SuiSchema.bcs`, `Executed` |
| `sui-effect/tx` | `Signer`, `Tx.*`, `SubmitConfig`, `Journal`, `JournalEntry` |
| `sui-effect/journal` | durable `Journal` layer over `KeyValueStore` (`effect/unstable/persistence`) |
| `sui-effect/extension` | `SuiExtension.fromService` (Effect service to `$extend` registration), authoring conventions and helpers |
| `sui-effect/script` | `Script` service, `Script.run`, exit-code mapping |
| `sui-effect/testing` | `SuiCoreFake.layer(script)`, `layerTest(script)` (the real `Sui` over the fake), fixtures, schema round-trip helpers, extension test harness |

Everything the package uses to implement itself and everything the tests reach for lives in `src/internal.ts` (`mapSdkError`, `DefectMarker`, `makeFromClient`, `readSchedule`, the include sets, `fromTransactionResult`, `makeSuiObject`, `executionReasonOf`, `digestOf`, `SuiErrorSchema`, and the BCS bridge's `typeMatches` / `expectedTypeOf`; `decodeContent` is public as `SuiSchema.decode`, because an extension that holds bytes — a stream of envelopes, a dynamic field value, an event payload — otherwise hand-rolls a worse `DecodeError`). It is deliberately absent from the package `exports` map, so `src/index.ts` is exactly the public API.

Peer dependencies: `effect >=4.0.0-rc.112 <4.1` with a CI matrix of tested rcs documented in the README; `@mysten/sui ^2.28` (first version whose BCS and gRPC support round-trips `ValidDuring` and `Validity` expirations). The core module imports only stable `effect/*`; `effect/unstable/*` appears only behind `sui-effect/journal`. No platform package dependency anywhere; tests and examples use `@effect/platform-bun`.

Layout follows the effect-ts skill: `src/domain/` (schemas, errors), `src/services/` (one `Context.Service` per file with `layer`, `layerNoDeps`, `layerTest`), `bun test`, `tsc --noEmit` clean before any claim of done. `LLMS.md` generated from the examples ships with the first release.

## 2. `SuiCore`: the mechanical tier

A hand-written 1:1 Effect wrap of `ClientWithCoreApi` from `@mysten/sui/client`.

- Every key of `SuiClientTypes.TransportMethods` is present, none optional on our side. A type-level test asserts `Exclude<keyof TransportMethods, keyof SuiCore["Service"]>` is `never`.
- `Include` generics are preserved exactly as the SDK declares them.
- Every call forwards the AbortSignal from `Effect.tryPromise((signal) => ...)` into `CoreClientMethodOptions.signal`, so `Effect.timeout` and interruption cancel the request.
- Every method is `Effect.fn("SuiCore.<method>")` so it has a span and the `Include` generic still flows. The same holds on `Sui`, with one exception: `getObject`, `getObjectOption` and `getObjects` declare overloads so that passing a `schema` narrows the result type, and `Effect.fn` cannot express an overload set. Their implementations are still `Effect.fn`; only the declared type is written out by hand.
- One `mapSdkError` function turns SDK failures into the taxonomy in section 10; per-method unions are derived from it:
  - `getObject`: `ObjectNotFound | ObjectDeleted | ObjectUnavailable | TransportError`
  - `getObjects`: `TransportError` (per-item errors are in the result array)
  - `getTransaction`, `waitForTransaction`: `TransactionNotFound | TransportError`
  - `simulateTransaction`: `SimulationFailed | TransportError`
  - everything else: `TransportError`
- Read methods retry `TransportError` where `retryable` is true on `Schedule.min([exponential("250 millis"), spaced("10 seconds")]).pipe(Schedule.jittered)` capped at 5 attempts. `executeTransaction` is never retried at this tier. The retryable set is exactly: gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, `INTERNAL` and `UNKNOWN`; HTTP 5xx and 429; and timeouts. `INTERNAL` and `UNKNOWN` are in the set because they are how the transport reports that the request never reached a node at all: `@protobuf-ts/grpcweb-transport` turns a rejected `fetch` (connection refused, DNS failure) into `INTERNAL`, and its grpc-web format maps HTTP 500 to `UNKNOWN`. Without them a read against a node that is merely down or restarting is never retried. Every other status is an answer from the node and is not retried.
- `use(f: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>): Effect<A, SuiError>` is the low-level hatch for one-off calls into the SDK client object. It runs the same `mapSdkError`. There is no `raw` property. Third-party `$extend` packages are not used directly from application code; each gets an Effect-native extension we maintain (section 13.3), and `use` is how that extension's implementation reaches the upstream package when it needs the client object.
- Layers: `layerGrpc({ network, baseUrl, timeout?, mvr? })`, `layerFromClient(client)`, `layerConfig` (`SUI_NETWORK` required with no default, `SUI_RPC_URL` optional with a built-in default gRPC URL table because the SDK ships none), and `SuiCoreFake.layer(script)` in `sui-effect/testing`, which provides both `SuiCore` and a `SuiCoreFake` handle a test drives it with.

## 3. `Sui`: the opinionated tier

`layerNoDeps: Layer<Sui, NetworkMismatch | TransportError, SuiCore>`; `layer = layerNoDeps` over `SuiCore.layerGrpc`. At build it calls `getChainIdentifier` once and records the answer on `Sui.chainId`. The test layer is **not** a static on `Sui`: `layerTest(script)` is a function in `sui-effect/testing` (`Sui.layerNoDeps` over `SuiCoreFake.layer(script)`), so nothing under `src/services/Sui.ts` depends on the fake.

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
getObjectsOrFail<S>(ids, opts?):                                      // the fail-first variant: the first item error is the failure
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

`created(type?)`, `createdWhere(predicate)` (the direct replacement for the substring matching downstream repos hand-roll), `mutated(type?)`, `deleted()`, `packagesPublished()` (`PackageWrite` and `Created`, refs like every other accessor, `type` falling back to the literal `package`), `balanceChange(address, coinType): bigint` and `gasUsedTotal: bigint` (both are signed deltas, so neither is `Mist`, which is non-negative), and `expectCreated(type): Effect<ChangedRef, UnexpectedEffects>` for the one-result case.

Every accessor returns a `ChangedRef { id, type?, version?, digest?, owner? }` rather than a full `ObjectRef`: the effects carry `id` always and the rest only sometimes (a deleted object has no output version, a change missing from the `objectTypes` join has no type), and inventing version `0`, an empty digest or an `Unknown` owner would hand the builder a reference that looks usable and is not. `objectRefOf(ref)` returns a full `ObjectRef` when every field is present and `undefined` otherwise.

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
Tx.submit(signed: Signed):                 Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | JournalError>
Tx.reconcile(input: Digest | Signed | SubmissionUnknown):
  Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | TransportError>
Tx.run(recipe: Recipe | Transaction, opts: { signer: Signer; gasOwner?: SuiAddress }):
  Effect<Executed, BuildError | SimulationFailed | PolicyDenied | SigningError | ExecutionFailed | NotApplied | SubmissionUnknown | JournalError | TransportError>
Tx.reconcileAll(): Effect<ReadonlyArray<Executed | ExecutionFailed | NotApplied | SubmissionUnknown>, JournalError | TransportError>
```

`submit` and `run` carry `NotApplied` because `submit` runs `reconcile` when its retries are exhausted, and proving that a transaction never applied is one of the three answers `reconcile` can give. `run` carries `TransportError` because `build` does: reads before the bytes exist can fail the ordinary way. Once bytes may have been sent, no `TransportError` escapes.

`reconcile` takes the signed bytes, not only a digest, because the evidence rules need them: given a bare `Digest` there is nothing to reason about and an unknown transaction is always `SubmissionUnknown` (with no `signed` on it, since there is nothing to re-send).

Semantics:
- **Build already simulates.** On gRPC the SDK resolve plugin calls `simulateTransaction` with checks enabled during `build` and throws `SimulationError` on execution failure. `Tx.build` maps that to `SimulationFailed`, so simulate-before-submit is inherent and costs nothing extra.
- **Default expiration.** If the recipe did not set one, `Tx.build` sets `ValidDuring { minEpoch: epoch, maxEpoch: epoch + 1, minTimestamp: null, maxTimestamp: null, chain: chainId, nonce: random }`, where `epoch` comes from one `getCurrentSystemState` read. The epochs are not optional: the validator rule is that a transaction must either have address-owned inputs or a `ValidDuring` expiration of **at most two epochs**, so an unbounded expiration is rejected outright for a PTB whose only object inputs are shared, and for every `Tx.sponsored` transaction, which pays gas from an address balance and so has no gas coins either. Setting an expiration also suppresses the SDK resolver's own default, so nothing else will supply the epochs later. The SDK only defaults an expiration when a transaction has no owned inputs, so ours is set unconditionally. The `chain` field is a replay guard, and a live node enforces it: bytes signed for testnet cannot land on mainnet. `Signed` records the expiration.
- **No wall-clock bound by default.** `maxTimestamp` is `null` unless `SubmitConfig.validFor` is set, because **no Sui network accepts a timestamp expiration yet**: a devnet node refuses any transaction that carries one with `Feature is not supported: Timestamp-based transaction expiration is not yet supported`, whether or not epochs are set alongside it (verified live against `fullnode.devnet.sui.io`, epoch 91, by `test/live.devnet.test.ts`). `validFor` stays in `SubmitConfig` so a network that gains support needs no new API, and so the wall-clock rule in `reconcile` has something to read.
- **Submit never rebuilds.** `Tx.submit` writes `JournalEntry.Signed` before the first `executeTransaction`, retries only the identical bytes on retryable `TransportError` or timeout, and when retries exhaust runs `Tx.reconcile`. `TransportError` never escapes `submit` once bytes may have been sent.
- **Reconcile.** `getTransaction(digest)` found means `Executed` or `ExecutionFailed`. Not found may only become `NotApplied` with `evidence: "expired"` when the current epoch is past the recorded `maxEpoch` — the rule that fires in practice, since the default expiration is epoch-bounded; it costs one `getCurrentSystemState` read and needs no margin, an epoch being a consensus fact rather than a reading of a clock — or when `chainTime` exceeds a recorded `maxTimestamp` plus `expiryMargin`, or `evidence: "inputConsumed"` under the guard below. Otherwise `SubmissionUnknown`, which carries the signed bytes so an operator or a later process can reconcile.
- **`inputConsumed` needs a consuming digest.** That an owned input has advanced is *not* evidence: the transaction being reconciled is itself the likeliest thing to have advanced it, and a node that has not caught up answers `getTransaction` with not-found while a node that has shows the new version. Reporting that as `NotApplied` puts outcome `not_applied` on a transaction that applied, and the documented retry idiom then executes the caller's intent twice. So when a pinned reference has moved on — an owned input **or a gas payment coin**, both of which the bytes pin — `Tx.reconcile` reads the object again through `SuiCore.getObject` with `previousTransaction` in the include set and branches on what the node names:
  - a **different** digest: those exact bytes can never execute again, and this is the only thing `NotApplied { inputConsumed }` is ever built on;
  - **our own** digest: the transaction applied; `getTransaction` is asked once more and answers `Executed` or `ExecutionFailed`, or `SubmissionUnknown` if the node still does not serve it;
  - **no readable digest** — the object is deleted or wrapped, or the node does not serve the field: nothing is proven and the answer is `SubmissionUnknown`, never `NotApplied`.

  `Tx.reconcileAll` settles every entry through `Tx.reconcile`, so the same guard applies at startup.
- **The journal never changes an answer.** `JournalError` escapes `Tx.submit` only from the `Signed` write, which happens before the first `executeTransaction`: failing there is honest, because nothing has been sent. Once execute or reconcile has answered, a journal write that fails is logged with `Effect.logError` annotated with the digest and the outcome stands — reporting a charged `ExecutionFailed` as `JournalError` would put it on exit 4, "safe to retry", and invite a second submission.
- **A signer must match the bytes.** `Tx.sign` and `Tx.cosign` compare `signer.address` with the sender and the gas owner read back out of the bytes, and fail with `SigningError` when it is neither. Otherwise a misconfigured credential becomes a non-retryable `INVALID_ARGUMENT` from `executeTransaction`, which `Tx.submit` can only report as `SubmissionUnknown` for a transaction that never had a chance. A `Signer.remote` therefore has to report the address it signs as truthfully.
- **Sender lock.** Gas-coin selection happens at build, so `Tx.run` holds a sender lock from build through submit. The address that matters is the one whose coins are spent, which is the **gas owner** when there is one: two sponsored runs for different senders paid by one sponsor are exactly the case that picks the same coin twice. When sender and gas owner differ, both locks are held, in ascending address order, so two runs needing the same pair cannot deadlock. `Tx.build` and `Tx.submit` called separately do not lock; documented.
- **Preflight.** `SubmitConfig.preflight`, when set, costs one extra simulate with effects and is where spend limits and target policies plug in. It fails with `PolicyDenied` only, so `Tx.run` stays typed.
- **Retry after not applied** is a documented idiom, not an API: wrap the whole `Effect.gen` block (reads plus `Tx.run`) in `Effect.retry({ while: (e) => SuiError.outcome(e) === "not_applied", times: 3 })`. Because `outcome(ExecutionFailed)` is `"applied"`, the idiom never re-runs a transaction that charged gas.
- `waitForCheckpoint` is deferred to phase 2.

## 7. `SubmitConfig` (`Context.Reference`, defaults shown)

`expiration: "validDuring" | "epoch" | "none"` (`"validDuring"`, which costs one `getCurrentSystemState` read per build for the epoch bounds), `validFor?: Duration` (unset; an *additional* `maxTimestamp`, which every Sui network refuses today), `maxGasBudget: Mist` (50 SUI, the protocol maximum; `Tx.build` fails with `BuildError` when the budget the node chose is over it), `preflight?: (sim: Simulation) => Effect<void, PolicyDenied>` (none), `lockSender: boolean` (true), `resubmit: Schedule` (jittered exponential, 30 second cap), `resubmitAttempts: number` (5), `executeTimeout: Duration` (60 seconds, after which one `executeTransaction` is treated as a retryable transport failure), `expiryMargin: Duration` (30 seconds of clock skew `Tx.reconcile` allows before calling a transaction expired).

`resubmitAttempts`, `executeTimeout` and `expiryMargin` are separate fields rather than constants because each is a number a test has to be able to drive and an operator has to be able to change: the attempt count is not expressible in a v4 `Schedule` that also has to be jittered, the timeout is what makes `Cause.TimeoutError` reachable at all, and the margin is the difference between "probably gone" and "provably gone".

## 8. `Journal` (`Context.Reference`, memory default)

Interface: `put(entry)`, `get(digest)`, `listUnresolved`. The memory default keeps `Journal` out of `R` and makes a one-shot script work with zero setup — and, because a `Context.Reference`'s default is computed once and cached on the reference, it is **process-wide**, so a test that submits provides `Journal.layerMemory` to stay isolated; for scripts, the signed bytes inside `SubmissionUnknown` are the durable record and `describe` prints digest plus base64 bytes. Because a `Context.Reference`'s identifier is `never` in v4 — which is exactly why it stays out of `R` — the layers that provide one are `Layer<never, ...>`; `Journal.layerMemory` is a fresh in-memory journal for a test or a process that wants its own, since the default value is computed once and cached on the reference.

`sui-effect/journal` provides `layerKeyValueStore({ onUnresolved: "fail" | "ignore" }): Layer<never, JournalError, KeyValueStore>` and `makeKeyValueStore(store)` as module-level functions, and re-exports the unchanged `Journal` reference. They are not statics on `Journal`: attaching them would mean mutating the one shared reference object at import time, which a package marked `sideEffects: false` is entitled to have dropped. `KeyValueStore` has no key enumeration, so the journal keeps its own index under one key: the digests that are still unresolved, rewritten whenever an entry is put. Layer build does no network work beyond listing entries; an application that wants to reconcile at startup calls `Tx.reconcileAll: Effect<ReadonlyArray<Executed | NotApplied | SubmissionUnknown>, JournalError | TransportError, Sui | Journal>` explicitly. This keeps the layer dependency direction simple and keeps network calls out of layer construction.

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
| `DecodeError` | `objectId?`, `expectedType?`, `issue` |
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
| `UnexpectedEffects` | `digest`, `expected: string`, `found: ObjectId[]` (the ids that did match, so zero and many are told apart; `expected` is the string the caller asked for, because fabricating a valid `StructTag` from an invalid one is worse than repeating it) |

`ExecutionReason` and `Owner` are `Schema.Union([...]).pipe(Schema.toTaggedUnion("$kind"))` rather than `_tag` unions, so the discriminant is the SDK's own `$kind` and our narrowing and the SDK's agree. `ExecutionReason` mirrors `SuiClientTypes.ExecutionError` exactly (`MoveAbort` with `abortCode: bigint`, `location`, `cleverError`; `SizeError`; `CommandArgumentError`; `TypeArgumentError`; `PackageUpgradeError`; `IndexError`; `CoinDenyListError`; `CongestedObjects`; `ObjectIdError`; `Unknown`). Clever-error constant names are decoded automatically; a per-package abort registry is deferred.

`TransportError.fromUnknown(method, cause, retryable?)` is the constructor an extension uses for its own network calls: it classifies `status` and `retryable` exactly as `SuiCore` does for the SDK's failures (gRPC status names, HTTP 5xx and 429, aborts and timeouts), so a hand-built `TransportError` never drifts from the library's.

`SuiError` is the union plus four helpers every repo hand-rolls today: `isRetryable(e)`, `outcome(e): "applied" | "not_applied" | "unknown"` (`applied` for `ExecutionFailed`, `unknown` for `SubmissionUnknown`, `not_applied` for every other tag **in the taxonomy**, and `unknown` for anything else — see 13.1), `describe(e): string` (one actionable line, for example `ExecutionFailed MoveAbort 0x..::escrow::claim code 3 (EAlreadyClaimed) in command 1`), and `toJson(e)`.

## 11. Branded schemas and the BCS bridge

`SuiAddress`, `ObjectId`, `Digest`, `StructTag`, `CoinType`, `Signature`, `Mist` (`bigint`) as `Schema.String.pipe(Schema.check(...), Schema.brand(...))` with normalization on decode via `SchemaGetter.transform` (`normalizeSuiAddress`, `normalizeStructTag`). `SuiSchema.bcs(bcsType, expectedType?)` turns a `@mysten/bcs` `BcsType<T>` into `Schema.Codec<T, Uint8Array>` that decodes from `content` bytes only (never the transport-varying `json`).

**One type-matching rule, everywhere.** `typeMatches(expected, actual)` parses both with `parseStructTag`. When the expected tag carries **no type arguments** it names the generic itself and only `address::module::name` is compared, so `pkg::m::Composition` accepts `pkg::m::Composition<0x…::share::Share>` — which is what a node does with a bare type filter, and what makes one codec usable for a generic Move type. When the expected tag **carries** type arguments the two are compared in full after `normalizeStructTag`, so `Coin<0x2::sui::SUI>` matches its padded spelling and not `Coin<…::usdc::USDC>`. Anything that is not a struct tag (the literal `package`) compares as a normalized string. The object keeps its own instantiated type on `SuiObject.type`. The same function decides the `expectedType` option of `getObject` / `getObjectOption` / `getObjects`, the `actualType` check inside `SuiSchema.decode`, and the `type` filter of `SuiCoreFake.listOwnedObjects`, which would otherwise be stricter than a node.

`expectedType` is **optional**: a Move return value has no struct tag, so `SuiSchema.bcs(bcs.Address())` for a `Sui.view` carries none and nothing is compared. The re-serialize length check is still what rejects mis-shaped bytes. It must be a `BcsType`, not merely a `{ parse }` codec: the bridge re-serializes what it parsed to reject trailing bytes, which is what stops an `objectBcs` envelope from decoding as the struct it wraps (generated codegen output is a `BcsType`, so this costs nothing in practice). The expected type is stored as a schema annotation and read back by walking the encoding chain, so `SuiSchema.bcs(...).pipe(Schema.decodeTo(DomainClass, ...))` keeps the check; `getObject`, `getObjectOption` and `getObjects` also accept an explicit `expectedType` for codecs built some other way. A `Uint8Array` field that can reach an error or a journal entry (`SignedTransaction.bytes`) uses a base64 codec, so `SuiError.toJson` is JSON.

## 12. `Script` preset (`sui-effect/script`)

- `Script` is a `Context.Service` `{ sui: Sui, core: SuiCore, signer: Signer, network }`. `Script.layer` reads `SUI_NETWORK` (required, no default; `mainnet` refused unless `SUI_ALLOW_MAINNET=1`), `SUI_RPC_URL` (optional), `SUI_PRIVATE_KEY` (Bech32, `Config.redacted`), and provides `Sui` and `SuiCore` alongside `Script`, so `Tx.*` works inside a script with no further wiring. `Script.layerReadOnly` provides a separate service, `ScriptReadOnly`, whose shape has no `signer`: one service cannot have two shapes, and a script written against `Script` must not silently build over a layer that cannot sign. `Script.layerNoDeps`, `Script.layerWithSigner(signer)` and `Script.layerReadOnlyNoDeps` build over a `Sui` the caller already has, which is how a test runs a script against the fake.
- `Script.run(effect, options?)` installs SIGINT/SIGTERM handlers, interrupts the root fiber, waits for finalizers, maps the `Exit` to an exit code, exits and returns the code. No platform dependency: `process` is the only global it touches, and `options` can replace `exit`, `stderr`, `signals` and the `layer`, so a test drives the whole path without ending the test process. `Script.exitCode(exit)` is exported for consumers on `BunRuntime.runMain`.
- stdout carries the script's data only. `Script.run` installs a logger bound to the injected stderr writer for the whole run, so `Effect.log` from the script or from anything it calls cannot corrupt the script's output; `describe` output goes there too, one line per failure plus `digest:` when present, and for `SubmissionUnknown` the base64 bytes and a reconcile hint. On an interrupt or a defect it additionally prints whatever the **default** journal still holds unresolved — `unresolved <digest> (<tag>)` and the base64 bytes — because a script killed between signing and the answer otherwise exits 130 with no record of what may be on the wire.
- A second SIGINT is ignored. The handler interrupts the root fiber once; the point of the first interrupt is to let finalizers — the journal write above all — run to completion. A script whose finalizers hang has to be killed with SIGKILL, which no process can handle.
- Exit codes: 0 success; 1 defect or unclassified; 2 configuration (`ConfigError`, `NetworkMismatch`, `SchemaError` — what `Config.schema` and `Schema.decodeUnknownEffect` fail with, which in a script can only mean an input did not fit its schema — and the mainnet gate, which is read before the client is built, through `Layer.unwrap`, so a script pointed at mainnet without `SUI_ALLOW_MAINNET=1` never opens a connection); 3 unknown outcome (`SubmissionUnknown`); 4 not applied (`SimulationFailed`, `BuildError`, `SigningError`, `PolicyDenied`, `NotApplied`, `DecodeError`, `JournalError`, `UnexpectedEffects`, the not-found family, `TransportError` after retries, and `Cause.TimeoutError`, which sits outside the taxonomy but can only mean a read timed out — `Tx.submit` turns a timed-out submission into `SubmissionUnknown` before it ever reaches here); 5 applied but failed on chain (`ExecutionFailed`); 130 interrupt. The applied / not applied / unknown axis matches what a wrapper script acts on and matches publish's existing exit 3.
- No `--json` flag at this level; the consumer's CLI owns flags and can use `SuiError.toJson`.

The target shape of an on-demand script:

```ts
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "sui-effect"
import { Tx } from "sui-effect/tx"
import { Script } from "sui-effect/script"
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

`fromService` returns a `SuiClientRegistration` whose `register(client)` builds a `ManagedRuntime` over `SuiCore.layerFromClient(client)`, `Sui.layerNoDepsWith(options.sui)` and the extension layer, and exposes each interface member as a Promise-returning method (or an `AsyncIterable` for Streams), mapping nested **plain** objects of members recursively so a namespaced surface (`client.miso.protocol.*`) works. A class instance — a `BcsType`, a `Schema.Class` — is a leaf, in the type and at runtime alike. Rejections are the same tagged error instances, so a Promise consumer can still switch on `_tag`. One implementation, two faces; the Effect face is the one agents and our own scripts use.

Options beyond `name` and `layer`:

- `layer` is bounded by `Layer<Self, E, Sui | SuiCore>`. The rule is not "requires `Sui` and nothing else" but *requires nothing the consumer's client could have provided*: an extension's own dependencies (an `HttpClient`, a `SuiGraphQL`, another extension's service) are provided inside its layer or in the function that builds the registration.
- `sui?: SuiLayerOptions` is routed to `Sui.layerNoDepsWith`, so an extension whose deployment names a custom network's `chainIdentifier` can pin it and refuse another chain.
- `warm?: { chainId? }` builds the runtime **synchronously inside `register`**, with `Sui.layerNoDepsPinned`. A layer that needs an asynchronous step throws out of `register` — that is the contract, not an accident — and the chain identifier is taken rather than read (`warm.chainId`, `sui.chainId`, or the `KNOWN_CHAIN_IDS` entry; on a network with no entry, `warm` throws rather than guess).

**The synchronous-member rule.** By default the runtime is built on first use, and until it exists nothing knows what a member is. An `Effect` or `Stream` member behaves as the face promises anyway. A **synchronous** member — a recipe builder, a package id — does not: `PromiseFace` types those as synchronous, so the face fails with `ExtensionNotReady` (naming the member) instead of returning a `Promise` where the type says a value. The face carries `$ready(): Promise<void>`, which builds the runtime and resolves the service so every member is real afterwards, and `$dispose()` (`dispose()` is kept as an alias). `$dispose` is not final: the next call builds a fresh runtime. Each `register` is independent.

### 13.3 Third-party packages: we maintain Effect-native variants

For upstream SDK extensions we do not own (suins, deepbook, and whatever comes next), we do not lift their Promise surfaces generically. We maintain our own Effect-native extension for each one, built to the 13.1 contract, published alongside sui-effect (for example `@unconfirmed/suins-effect`). Each variant depends on the upstream package for its logic (BCS layouts, PTB construction, name resolution) and wraps those calls behind a `Context.Service` with precise per-method error unions, spans, signal forwarding and a `layerTest`. The upstream registration is never exposed to consumers.

Consequences:

- Precise errors instead of a broad `SuiError` union, because we read the upstream code and map its failures.
- One convention for every extension a consumer meets, whether we wrote the logic or wrapped it.
- The authoring guide gets a section on wrapping an upstream Promise package: `SuiCore.use` for calls that need the client object, `Effect.tryPromise` with a mapping function for pure upstream helpers, and a rule that upstream types are re-exported only after being narrowed to sui-effect schemas.
- A generic `SuiExtension.lift` is deferred; it may return later as a stopgap for packages we have not wrapped yet.

### 13.4 The extension authoring guide (a v1 deliverable)

`docs/extensions.md`, shipped in the package and included in `LLMS.md`, covering: the service shape above with a complete worked example (the onara rewrite is the canonical one); how to define errors and declare outcomes; recipe fragments versus submissions and how consumers compose them; `layer`, `layerConfig`, `layerTest`; deriving the Promise face with `fromService`; testing on `layerTest` from `sui-effect/testing` and `TestClock` with zero network; composing extensions; converting an existing facade; a layer that picks its deployment from `sui.network`; how to depend on sui-effect before a release; a review checklist mirroring the effect-ts skill's (reject any Promise in an interface, any direct `executeTransaction`, any signer held in a layer, any `unknown` in an error channel). `examples/extension-template/` is a copyable package skeleton that typechecks against the pinned rcs. `sui-effect/testing` ships an extension harness: `layerTest` plus the fake `SuiCore` with helpers to script object state and execution outcomes for an extension's tests.

### 13.5 `SuiGraphQL`: one tag, no wrapper

sui-effect does not wrap the GraphQL API, and the Effect-native GraphQL tier stays deferred (section 15). What it owns is the **tag**: `SuiGraphQL` is `Context.Service<SuiGraphQL, SuiGraphQLClient>()("sui-effect/SuiGraphQL")` over the SDK's own client, exported from the core subpath, so two extensions that both read GraphQL — and the application that configures the endpoint — agree on one client instead of each opening its own and each inventing a name for the failure.

- `SuiGraphQL.layer(client)` over a client the caller built.
- `SuiGraphQL.layerConfig` reads `SUI_GRAPHQL_URL` and `SUI_NETWORK` (the same variable `SuiCore.layerConfig` reads: an endpoint for one chain and a node for another is a misconfiguration no error can describe afterwards).
- `SuiGraphQL.layerUnavailable` (and `layerUnavailableWith(reason)`) provides a client whose every call rejects with `GraphQLUnavailable { method, reason }`. This is what an application with no endpoint provides: the absence becomes the failure the extension already handles, at the call it would have made, instead of a layer that will not build.

An extension calls `query` or `execute` inside `Effect.tryPromise` and maps the rejection into its own union — `GraphQLUnavailable` as it is, or `TransportError.fromUnknown` for a call that reached the endpoint and failed.

## 14. Testing

- `SuiCoreFake.layer(script)` in `sui-effect/testing`: a `Map` of objects plus scripted outcomes for `getChainIdentifier`, `getReferenceGasPrice`, `getObjects`, `listCoins`, `simulateTransaction`, `executeTransaction`, `getTransaction`, the resolver's budget simulation (`buildSimulate`, which is how a test makes `Tx.build` fail with `SimulationFailed`), and the Clock object `0x6`. Outcomes include `succeed`, `failWith(reason)`, `transportError(status)`, `notFound()`, `timeoutThen(found)`. It also implements `resolveTransactionPlugin`, so `transaction.build({ client })` resolves gas price, gas budget, gas payment and object inputs from the script with no network, and it keys pending and known transactions by `TransactionDataBuilder.getDigestFromBytes` of the bytes it was given, so journal and reconcile tests are stable. No Move execution, no dynamic fields; localnet covers those.
- `layerTest(script)` in `sui-effect/testing` is `Sui.layerNoDeps` over the fake, so tests exercise the real high tier and the real `Tx.submit` under `TestClock`, under the production chain-id rules. `layerExtensionTest(layer, script)` puts an extension's own layer over it, and composes with whatever fakes that layer carries for the things that are not the chain.
- The fake's `client` is a `ClientWithCoreApi` and **implements `$extend`**, so a derived Promise face is testable the way a consumer writes it. Its `listOwnedObjects` filters by `typeMatches`, not string equality, so a bare tag matches every instantiation as it does on a node; its `getDynamicField` matches an entry by `name.type` only, not by the `name.bcs` bytes.
- `TestSchema.Asserts` round-trips every error class and every `JournalEntry` variant.
- The `TransportMethods` completeness type test.
- Localnet integration tests behind `SUI_LOCALNET=1`. (A devnet proof of the default expiration and the whole `Tx.run` lifecycle ships now, behind `SUI_LIVE=1`, in `test/live.devnet.test.ts`.)
- Dogfood order: the onara SDK rewrite as an extension (it exercises `Sui`, `Tx`, `fromService` and the guide), then `publish` (consumes the onara extension, already idempotency-shaped), then m2m's journal code and its suins usage through our maintained suins variant.

## 15. Deferred

`sui-effect/ai` toolkit, event and transaction streams (first in line once the bcs-only decoding rule is settled), gRPC subscriptions, per-package abort registry, `waitForCheckpoint`, a GraphQL-backed `SuiCore` and any Effect-native wrapping of the GraphQL API (the `SuiGraphQL` tag in 13.5 is not that), `effect/unstable/workflow` integration, Move ABI to Schema codegen, MVR conveniences, `Tx.runEffect` with an effectful recipe, a generic `SuiExtension.lift` for not-yet-wrapped upstream packages.

## 16. Phases

- **Phase 0:** scaffold, `SuiCore` with gRPC layer and fake, errors, branded schemas, BCS bridge, `Sui` reads and streams, completeness test. Typecheck and tests green.
- **Phase 1:** `Signer`, `Tx.*`, `SubmitConfig`, memory `Journal`, `Executed` accessors, `SuiExtension.fromService`, the extension authoring guide and template (including the section on wrapping an upstream package), the extension test harness, `Script` preset, `LLMS.md`. Proof: rewrite the onara SDK as an extension and confirm its existing Promise consumers work unchanged through `fromService`.
- **Phase 2:** durable journal and `Tx.reconcileAll`, events stream, `waitForCheckpoint`, abort registry, the `sui-effect` skill in `unconfirmedlabs/skills`, `publish` and m2m ports, and the first maintained third-party variant (suins, since m2m already uses it) as the worked example of section 13.3.
