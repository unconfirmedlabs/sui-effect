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
| `sui-effect` | `SuiCore`, `Sui`, errors, branded schemas, `SuiSchema.bcs`, `Executed` |
| `sui-effect/tx` | `Signer`, `Tx.*`, `SubmitConfig`, `Journal`, `JournalEntry` |
| `sui-effect/journal` | durable `Journal` layer over `KeyValueStore` (`effect/unstable/persistence`) |
| `sui-effect/extension` | `SuiExtension.fromService` (Effect service to `$extend` registration), authoring conventions and helpers |
| `sui-effect/script` | `Script` service, `Script.run`, exit-code mapping |
| `sui-effect/testing` | `SuiCore.layerFake`, fixtures, schema round-trip helpers, extension test harness |

Peer dependencies: `effect >=4.0.0-rc.112 <4.1` with a CI matrix of tested rcs documented in the README; `@mysten/sui ^2.28` (first version whose BCS and gRPC support round-trips `ValidDuring` and `Validity` expirations). The core module imports only stable `effect/*`; `effect/unstable/*` appears only behind `sui-effect/journal`. No platform package dependency anywhere; tests and examples use `@effect/platform-bun`.

Layout follows the effect-ts skill: `src/domain/` (schemas, errors), `src/services/` (one `Context.Service` per file with `layer`, `layerNoDeps`, `layerTest`), `bun test`, `tsc --noEmit` clean before any claim of done. `LLMS.md` generated from the examples ships with the first release.

## 2. `SuiCore`: the mechanical tier

A hand-written 1:1 Effect wrap of `ClientWithCoreApi` from `@mysten/sui/client`.

- Every key of `SuiClientTypes.TransportMethods` is present, none optional on our side. A type-level test asserts `Exclude<keyof TransportMethods, keyof SuiCore["Service"]>` is `never`.
- `Include` generics are preserved exactly as the SDK declares them.
- Every call forwards the AbortSignal from `Effect.tryPromise((signal) => ...)` into `CoreClientMethodOptions.signal`, so `Effect.timeout` and interruption cancel the request.
- Every method is `Effect.fn("SuiCore.<method>")` so it has a span.
- One `mapSdkError` function turns SDK failures into the taxonomy in section 10; per-method unions are derived from it:
  - `getObject`: `ObjectNotFound | ObjectDeleted | ObjectUnavailable | TransportError`
  - `getObjects`: `TransportError` (per-item errors are in the result array)
  - `getTransaction`, `waitForTransaction`: `TransactionNotFound | TransportError`
  - `simulateTransaction`: `SimulationFailed | TransportError`
  - everything else: `TransportError`
- Read methods retry `TransportError` where `retryable` is true (gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`, `RESOURCE_EXHAUSTED`, HTTP 5xx and 429) on `Schedule.min([exponential("250 millis"), spaced("10 seconds")]).pipe(Schedule.jittered)` capped at 5 attempts. `executeTransaction` is never retried at this tier.
- `use(f: (client: ClientWithCoreApi, signal: AbortSignal) => Promise<A>): Effect<A, SuiError>` is the low-level hatch for one-off calls into the SDK client object. It runs the same `mapSdkError`. There is no `raw` property. Third-party `$extend` packages are not used directly from application code; each gets an Effect-native extension we maintain (section 13.3), and `use` is how that extension's implementation reaches the upstream package when it needs the client object.
- Layers: `layerGrpc({ network, baseUrl, timeout?, mvr? })`, `layerFromClient(client)`, `layerConfig` (`SUI_NETWORK` required with no default, `SUI_RPC_URL` optional with a built-in default gRPC URL table because the SDK ships none), `layerFake(script)` in `sui-effect/testing`.

## 3. `Sui`: the opinionated tier

`layerNoDeps: Layer<Sui, NetworkMismatch | TransportError, SuiCore>`; `layer = layerNoDeps` over `SuiCore.layerGrpc`; `layerTest = layerNoDeps` over `SuiCore.layerFake`. At build it calls `getChainIdentifier` once and fails with `NetworkMismatch { expected, actual }` if it disagrees with `network`. It owns a `PartitionedSemaphore` keyed by sender address.

Members and error unions:

```ts
network: Network
chainId: string
chainTime: Effect<DateTimeUtc, TransportError>                       // Clock object 0x6 via the BCS bridge, never cached
getObject<S>(id: ObjectId, opts?: { schema?: Schema.Codec<S, Uint8Array> }):
  Effect<SuiObject<S>, ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError | TransportError>
getObjectOption<S>(id, opts?):                                        // not found and deleted become None
  Effect<Option<SuiObject<S>>, ObjectUnavailable | DecodeError | TransportError>
getObjects<S>(ids, opts?):                                            // chunked by 50, response integrity checked
  Effect<ReadonlyArray<Result<SuiObject<S>, ObjectNotFound | ObjectDeleted | ObjectUnavailable | DecodeError>>, TransportError>
getBalance(owner: SuiAddress, coinType?: CoinType): Effect<Balance, TransportError>
getDynamicFieldOption(parent: ObjectId, name: DynamicFieldName): Effect<Option<DynamicField>, TransportError>
getTransaction(digest: Digest): Effect<Executed, ExecutionFailed | TransactionNotFound | TransportError>
simulate(input: Recipe | Transaction | Uint8Array): Effect<Simulation, SimulationFailed | BuildError | TransportError>
view<S>(recipe: Recipe, schema: Schema.Codec<S, Uint8Array>, opts?: { command?: number; result?: number }):
  Effect<S, SimulationFailed | BuildError | DecodeError | TransportError>
streamOwnedObjects(owner, opts?: { type?: StructTag }): Stream<SuiObject, TransportError>
streamDynamicFields(parent): Stream<DynamicFieldEntry, TransportError>
withSenderLock(address: SuiAddress): <A, E, R>(effect: Effect<A, E, R>) => Effect<A, E, R>
```

Fixed include sets: objects always `content + owner + type + version + digest`; execute always `effects + events + balanceChanges + objectTypes`. Anything else is one `SuiCore` call away.

Decisions recorded:
- `getTransaction` on a historical transaction whose status is failed fails with `ExecutionFailed`, the same as `Tx.submit` and `Tx.reconcile`, so there is exactly one representation of an on-chain failure.
- `view` decodes return value `result` (default 0) of command `command` (default the last command) from `simulate` with `commandResults`, and `checksEnabled: false` so non-entry functions can be inspected.
- `SuiObject<S>` carries `id`, `version`, `digest`, `type`, `owner` as a tagged union, `content: S`, and `ref: ObjectRef` for feeding the builder.

## 4. `Executed`

A `Schema.Class` built from the execute include set: `digest`, `effects`, `events`, `balanceChanges`, `objectTypes`, `checkpoint?`, `timestampMs?`. Accessors, each returning full refs `{ id, type, version, digest, owner }` so the next transaction can consume them, and each ignoring accumulator writes:

`created(type?)`, `mutated(type?)`, `deleted()`, `packagesPublished()` (`PackageWrite` and `Created`), `balanceChange(address, coinType)`, `gasUsedTotal`, and `expectCreated(type): Effect<ObjectRef, UnexpectedEffects>` for the one-result case.

## 5. `Signer` is a value, not a service

A credential is data, and one process may hold two (onara verifies a sender signature and signs as sponsor). `R = Signer` cannot say which one, so the signer is always an explicit parameter.

```ts
interface Signer { address: SuiAddress; scheme: SignatureScheme; signTransaction(bytes): Effect<Signature, SigningError>; signPersonalMessage(bytes): Effect<Signature, SigningError> }
Signer.fromKeypair(kp)
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
Tx.submit(signed: Signed):                 Effect<Executed, ExecutionFailed | SubmissionUnknown | JournalError>
Tx.reconcile(input: Digest | Unknown):     Effect<Executed, ExecutionFailed | NotApplied | SubmissionUnknown | TransportError>
Tx.run(recipe: Recipe, opts: { signer: Signer; gasOwner?: SuiAddress }):
  Effect<Executed, BuildError | SimulationFailed | PolicyDenied | SigningError | ExecutionFailed | SubmissionUnknown | JournalError>
```

Semantics:
- **Build already simulates.** On gRPC the SDK resolve plugin calls `simulateTransaction` with checks enabled during `build` and throws `SimulationError` on execution failure. `Tx.build` maps that to `SimulationFailed`, so simulate-before-submit is inherent and costs nothing extra.
- **Default expiration.** If the recipe did not set one, `Tx.build` sets `ValidDuring { maxTimestamp: chainTime + validFor, chain: chainId, nonce: random }`. The SDK only defaults an expiration when a transaction has no owned inputs, so this is set unconditionally. The `chain` field is a replay guard: bytes signed for testnet cannot land on mainnet. `Signed` records the expiration.
- **Submit never rebuilds.** `Tx.submit` writes `JournalEntry.Signed` before the first `executeTransaction`, retries only the identical bytes on retryable `TransportError` or timeout, and when retries exhaust runs `Tx.reconcile`. `TransportError` never escapes `submit` once bytes may have been sent.
- **Reconcile.** `getTransaction(digest)` found means `Executed` or `ExecutionFailed`. Not found may only become `NotApplied` with `evidence: "expired"` when `chainTime` exceeds the recorded `maxTimestamp` plus a margin, or `evidence: "inputConsumed"` when an owned input's version has advanced past the version the transaction referenced. Otherwise `SubmissionUnknown`, which carries the signed bytes so an operator or a later process can reconcile.
- **Sender lock.** Gas-coin selection happens at build, so `Tx.run` holds `sui.withSenderLock(sender)` from build through submit. `Tx.build` and `Tx.submit` called separately do not lock; documented.
- **Preflight.** `SubmitConfig.preflight`, when set, costs one extra simulate with effects and is where spend limits and target policies plug in. It fails with `PolicyDenied` only, so `Tx.run` stays typed.
- **Retry after not applied** is a documented idiom, not an API: wrap the whole `Effect.gen` block (reads plus `Tx.run`) in `Effect.retry({ while: (e) => SuiError.outcome(e) === "not_applied", times: 3 })`. Because `outcome(ExecutionFailed)` is `"applied"`, the idiom never re-runs a transaction that charged gas.
- `waitForCheckpoint` is deferred to phase 2.

## 7. `SubmitConfig` (`Context.Reference`, defaults shown)

`expiration: "validDuring" | "epoch" | "none"` (`"validDuring"`), `validFor: Duration` (2 minutes), `maxGasBudget: Mist`, `preflight?: (sim: Simulation) => Effect<void, PolicyDenied>` (none), `lockSender: boolean` (true), `resubmit: Schedule` (jittered exponential, 5 attempts, 30 second cap).

## 8. `Journal` (`Context.Reference`, memory default)

Interface: `put(entry)`, `get(digest)`, `listUnresolved`. The memory default keeps `Journal` out of `R` and makes a one-shot script work with zero setup; for scripts, the signed bytes inside `SubmissionUnknown` are the durable record and `describe` prints digest plus base64 bytes.

`sui-effect/journal` provides `Journal.layerKeyValueStore({ onUnresolved: "fail" | "ignore" }): Layer<Journal, JournalError, KeyValueStore>`. Layer build does no network work beyond listing entries; an application that wants to reconcile at startup calls `Tx.reconcileAll: Effect<ReadonlyArray<Executed | NotApplied | SubmissionUnknown>, JournalError | TransportError, Sui | Journal>` explicitly. This keeps the layer dependency direction simple and keeps network calls out of layer construction.

## 9. `JournalEntry` (`Schema.TaggedUnion`)

`Signed { digest, bytes, signatures, sender, expiration, signedAt }`, `Executed { digest, checkpoint?, at }`, `Failed { digest, reason, at }`, `Unknown { digest, signed, lastError, attempts }`. This is the only place the lifecycle appears as a union; the program abstraction is the functions in section 6.

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
| `SubmissionUnknown` | `digest`, `signed`, `cause` |
| `NotApplied` | `digest`, `evidence: "expired" \| "inputConsumed"` |
| `SigningError` | `cause` |
| `BuildError` | `message`, `cause` |
| `PolicyDenied` | `rule`, `message` |
| `JournalError` | `cause` |
| `UnexpectedEffects` | `digest`, `expected`, `found` |

`ExecutionReason` is a `Schema.TaggedUnion` mirroring `SuiClientTypes.ExecutionError` exactly (`MoveAbort` with `abortCode: bigint`, `location`, `cleverError`; `SizeError`; `CommandArgumentError`; `TypeArgumentError`; `PackageUpgradeError`; `IndexError`; `CoinDenyListError`; `CongestedObjects`; `ObjectIdError`; `Unknown`). Clever-error constant names are decoded automatically; a per-package abort registry is deferred.

`SuiError` is the union plus four helpers every repo hand-rolls today: `isRetryable(e)`, `outcome(e): "applied" | "not_applied" | "unknown"` (`applied` for `ExecutionFailed`, `unknown` for `SubmissionUnknown`, `not_applied` for everything else), `describe(e): string` (one actionable line, for example `ExecutionFailed MoveAbort 0x..::escrow::claim code 3 (EAlreadyClaimed) in command 1`), and `toJson(e)`.

## 11. Branded schemas and the BCS bridge

`SuiAddress`, `ObjectId`, `Digest`, `StructTag`, `CoinType`, `Mist` (`bigint`) as `Schema.String.pipe(Schema.check(...), Schema.brand(...))` with normalization on decode via `SchemaGetter.transform` (`normalizeSuiAddress`, `normalizeStructTag`). `SuiSchema.bcs(bcsType, expectedType)` turns a `@mysten/bcs` `BcsType<T>` into `Schema.Codec<T, Uint8Array>` that decodes from `content` bytes only (never the transport-varying `json`) and compares the object's type tag with `normalizeStructTag` so generic instantiations match.

## 12. `Script` preset (`sui-effect/script`)

- `Script` is a `Context.Service` `{ sui: Sui, core: SuiCore, signer: Signer, network }`. `Script.layer` reads `SUI_NETWORK` (required, no default; `mainnet` refused unless `SUI_ALLOW_MAINNET=1`), `SUI_RPC_URL` (optional), `SUI_PRIVATE_KEY` (Bech32, `Config.redacted`). `Script.layerReadOnly` omits `signer` from the type.
- `Script.run(effect)` installs SIGINT/SIGTERM handlers, interrupts the root fiber, waits for finalizers, maps the `Exit` to an exit code and exits. No platform dependency. `Script.exitCode(exit)` is exported for consumers on `BunRuntime.runMain`.
- stdout carries the script's data only; the logger and `describe` output go to stderr, one line per failure plus `digest:` when present, and for `SubmissionUnknown` the base64 bytes and a reconcile hint.
- Exit codes: 0 success; 1 defect or unclassified; 2 configuration (`ConfigError`, `NetworkMismatch`, mainnet gate); 3 unknown outcome (`SubmissionUnknown`); 4 not applied (`SimulationFailed`, `BuildError`, `SigningError`, `PolicyDenied`, not-found family, `TransportError` after retries); 5 applied but failed on chain (`ExecutionFailed`); 130 interrupt. The applied / not applied / unknown axis matches what a wrapper script acts on and matches publish's existing exit 3.
- No `--json` flag at this level; the consumer's CLI owns flags and can use `SuiError.toJson`.

The target shape of an on-demand script:

```ts
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "sui-effect"
import { Tx } from "sui-effect/tx"
import { Script } from "sui-effect/script"
import { bcs } from "@mysten/sui/bcs"

const PKG = "0x…"
const Escrow = SuiSchema.bcs(bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64 }), `${PKG}::escrow::Escrow`)

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
- **Layers** follow the house skill: `layer(opts)`, `layerConfig` reading `<PREFIX>_*` through `Config` with secrets as `Config.redacted`, `layerTest` backed by a `Ref`. The layer requires `Sui`; it never constructs its own client.
- **Errors** are `Schema.TaggedError` with a unique tag prefixed by the package name where collision is plausible. An extension error may declare its outcome for the script exit-code axis by implementing `outcome: "applied" | "not_applied" | "unknown"`; `SuiError.outcome` and `Script.run` honour it, defaulting to `not_applied`. `describe` uses the error's `message`.
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

`fromService` returns a `SuiClientRegistration` whose `register(client)` builds, lazily on first call, a `ManagedRuntime` over `SuiCore.layerFromClient(client)`, `Sui.layerNoDeps` and the extension layer, and exposes each interface member as a Promise-returning method (or an `AsyncIterable` for Streams). Rejections are the same tagged error instances, so a Promise consumer can still switch on `_tag`. The registration exposes `dispose()` for clean shutdown. One implementation, two faces; the Effect face is the one agents and our own scripts use.

### 13.3 Third-party packages: we maintain Effect-native variants

For upstream SDK extensions we do not own (suins, deepbook, and whatever comes next), we do not lift their Promise surfaces generically. We maintain our own Effect-native extension for each one, built to the 13.1 contract, published alongside sui-effect (for example `@unconfirmed/suins-effect`). Each variant depends on the upstream package for its logic (BCS layouts, PTB construction, name resolution) and wraps those calls behind a `Context.Service` with precise per-method error unions, spans, signal forwarding and a `layerTest`. The upstream registration is never exposed to consumers.

Consequences:

- Precise errors instead of a broad `SuiError` union, because we read the upstream code and map its failures.
- One convention for every extension a consumer meets, whether we wrote the logic or wrapped it.
- The authoring guide gets a section on wrapping an upstream Promise package: `SuiCore.use` for calls that need the client object, `Effect.tryPromise` with a mapping function for pure upstream helpers, and a rule that upstream types are re-exported only after being narrowed to sui-effect schemas.
- A generic `SuiExtension.lift` is deferred; it may return later as a stopgap for packages we have not wrapped yet.

### 13.4 The extension authoring guide (a v1 deliverable)

`docs/extensions.md`, shipped in the package and included in `LLMS.md`, covering: the service shape above with a complete worked example (the onara rewrite is the canonical one); how to define errors and declare outcomes; recipe fragments versus submissions and how consumers compose them; `layer`, `layerConfig`, `layerTest`; deriving the Promise face with `fromService`; testing on `Sui.layerTest` and `TestClock` with zero network; a review checklist mirroring the effect-ts skill's (reject any Promise in an interface, any direct `executeTransaction`, any signer held in a layer, any `unknown` in an error channel). `examples/extension-template/` is a copyable package skeleton that typechecks against the pinned rcs. `sui-effect/testing` ships an extension harness: a `Sui.layerTest` plus fake `SuiCore` with helpers to script object state and execution outcomes for an extension's tests.

## 14. Testing

- `SuiCore.layerFake(script)`: a `Map` of objects plus scripted outcomes for `getChainIdentifier`, `getReferenceGasPrice`, `getObjects`, `simulateTransaction`, `executeTransaction`, `getTransaction`, and the Clock object `0x6`. Outcomes include `succeed`, `failWith(reason)`, `timeoutThen(found)`. No Move execution, no dynamic fields; localnet covers those.
- `Sui.layerTest = Sui.layerNoDeps` over the fake, so tests exercise the real high tier and the real `Tx.submit` under `TestClock`.
- `TestSchema.Asserts` round-trips every error class and every `JournalEntry` variant.
- The `TransportMethods` completeness type test.
- Localnet integration tests behind `SUI_LOCALNET=1`.
- Dogfood order: the onara SDK rewrite as an extension (it exercises `Sui`, `Tx`, `fromService` and the guide), then `publish` (consumes the onara extension, already idempotency-shaped), then m2m's journal code and its suins usage through our maintained suins variant.

## 15. Deferred

`sui-effect/ai` toolkit, event and transaction streams (first in line once the bcs-only decoding rule is settled), gRPC subscriptions, per-package abort registry, `waitForCheckpoint`, GraphQL layer, `effect/unstable/workflow` integration, Move ABI to Schema codegen, MVR conveniences, `Tx.runEffect` with an effectful recipe, a generic `SuiExtension.lift` for not-yet-wrapped upstream packages.

## 16. Phases

- **Phase 0:** scaffold, `SuiCore` with gRPC layer and fake, errors, branded schemas, BCS bridge, `Sui` reads and streams, completeness test. Typecheck and tests green.
- **Phase 1:** `Signer`, `Tx.*`, `SubmitConfig`, memory `Journal`, `Executed` accessors, `SuiExtension.fromService`, the extension authoring guide and template (including the section on wrapping an upstream package), the extension test harness, `Script` preset, `LLMS.md`. Proof: rewrite the onara SDK as an extension and confirm its existing Promise consumers work unchanged through `fromService`.
- **Phase 2:** durable journal and `Tx.reconcileAll`, events stream, `waitForCheckpoint`, abort registry, the `sui-effect` skill in `unconfirmedlabs/skills`, `publish` and m2m ports, and the first maintained third-party variant (suins, since m2m already uses it) as the worked example of section 13.3.
