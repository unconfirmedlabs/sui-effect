# Agent guidance

`DESIGN.md` is the specification and wins over everything else; `docs/PLAN.md` is
the work plan. Where this file and the spec disagree, fix this file.

## Ground rules

- **Effect v4, pinned to exactly `4.0.0-rc.112`.** The peer range is the exact
  version, not a range: rc.113 renamed `Config.nonEmptyString`, `Config.string`
  and `Config.redacted` to `Config.NonEmptyString`, `Config.String` and
  `Config.Redacted`, which this package calls at four sites (`Script.ts:64,66`,
  `Signer.ts:150,154`, `SuiCore.ts:458-462`, `SuiGraphQL.ts:73-77`). v3 names
  are compile errors. Never
  write an Effect name from memory: verify it in `node_modules/effect/dist/*.d.ts`.
  The house skill `effect-ts` and its review checklist are binding.
- **SDK names are the source of truth.** Read
  `node_modules/@mysten/sui/docs/llms-index.md` first, then the version-matched
  page, then confirm the signature in `node_modules/@mysten/sui/dist/**/*.d.mts`.
- Everything that is not public API lives in `src/internal.ts`, which is not in
  the `exports` map. `src/index.ts` is exactly the public surface.
- **Every public name mirrors the SDK name it wraps**, so an agent that knows
  `@mysten/sui` can guess @unconfirmed/sui-effect.
- Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `@effect/platform-bun`
  is a devDependency for tests and examples only.
- No `Effect.runPromise` / `runSync` under `src/`, except at the two documented
  edges: the Promise facade of `SuiExtension.fromService`, and `Script.run`,
  which is a process entrypoint and whose whole job is to fork the root fiber,
  await its `Exit` and exit.
- No `any`. No `unknown` in an error channel. No `console.log` in `src/`.
- **One Move type rule.** `typeMatches(expected, actual)` (`src/domain/bcs.ts`)
  is the only comparison: a bare expected tag matches every instantiation of the
  generic, a parameterized one is compared in full after normalization. The
  bridge, `expectedType`, `SuiSchema.decode`'s `actualType` and the fake's
  owned-object filter all go through it, and so must anything new.
- **A `TransportError` for your own transport** comes from
  `TransportError.fromUnknown(method, cause, retryable?)`, never from
  hand-building the three fields.
- Every public function carries a JSDoc block that **states its error union in
  words** ("Fails with: `ObjectNotFound`, `TransportError`."), so `LLMS.md` can be
  generated from the source.
- Every dependency is a `Context.Service` with static layers (`layer`,
  `layerNoDeps`, `layerConfig`, a test layer). Every error is a
  `Schema.TaggedError`. Schema decodes at every boundary. Time comes from
  `DateTime`/`Clock`, randomness from `Random`, config from `Config`.
- Every service method is `Effect.fn("Service.method")`, which names its span.
  The only exceptions are `Sui.getObject`, `getObjectOption` and `getObjects`,
  whose declared types are overload sets `Effect.fn` cannot express; their
  implementations are still `Effect.fn`.
- Every SDK call forwards the Effect's `AbortSignal` into the SDK's `signal`
  option, so `Effect.timeout` and interruption cancel the request.
- Tests run on `bun test` with `effect/testing` (`TestClock`, `TestSchema`).
  Tests provide their own layers and never touch the network, with one gated
  exception: `test/live.devnet.test.ts` runs against devnet behind `SUI_LIVE=1`
  and is the only proof that a default-built transaction is accepted by a real
  validator. Localnet tests sit behind `SUI_LOCALNET=1`. A test that runs
  `Tx.submit` or `Tx.run` provides `Journal.layerMemory`, because the default
  journal is process-wide.
- Done means `bun run check` (typecheck, build, tests, and the extension
  template's own check) is green. `LLMS.md` is generated — `bun run llms` after
  any public signature or example change, and a test fails if it is stale.
  `docs/extensions.md` is generated from `docs/extensions.tpl.md` by
  `bun run docs:extensions`, and its code blocks must stay verbatim copies of
  `examples/extension-template/`.

## The two tiers

| Tier | What it is | When to use it |
|---|---|---|
| `SuiCore` | A 1:1 Effect wrap of `ClientWithCoreApi`. One member per `SuiClientTypes.TransportMethods` key plus `getObject`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction` and `use`. `Include` generics preserved. | Reaching a field or method `Sui` does not expose, and inside extension implementations. |
| `Sui` | The opinionated tier over `SuiCore`: fixed include sets, decoded BCS content, `Option` where absence is normal, chunked and integrity-checked batch reads (`getObjects` per-item `Result`, `getObjectsOrFail` first-error-wins), `Stream` pagination, one sender lock. | Almost all application and extension code. |

Reads go through `Sui`; writes go through `Tx`. An extension never calls
`SuiCore.executeTransaction` directly. `Sui` exposes the `SuiCore` it was built
over as `sui.core`, which is what lets every `Tx.*` function declare `R = Sui`
and nothing else.

## The lifecycle

| Name | What it is |
|---|---|
| `Signer` | A credential as a **value**, never a service: `{ address, scheme, signTransaction, signPersonalMessage }`. One process may hold two. Secret material never reaches the value. |
| `Tx.build/sign/cosign/sponsored/submit/reconcile/run/reconcileAll` | The lifecycle as functions, each with a closed error union, all `R = Sui`. |
| `SubmitConfig` | A `Context.Reference` holding expiration policy, the optional `validFor` wall-clock bound, the gas-budget ceiling, `preflight`, the sender lock, the resubmit schedule, attempts, timeout and expiry margin, plus `expiryEvidence`, `reconcileRecheck`, `awaitVisibility`, `visibilityTimeout` and `nonce`. |
| `Journal` | A `Context.Reference` with an in-memory default. `@unconfirmed/sui-effect/journal` swaps in a durable one over `KeyValueStore`; `Tx.reconcileAll()` is the explicit startup call. |
| `Script` | `{ sui, core, signer, network }` plus `Script.run` and `Script.exitCode`. `ScriptReadOnly` is the signer-less variant, a separate key on purpose. |
| `SuiExtension.fromService` | The Promise face of an Effect service, and the only place in `src/` allowed to run Effects. Options: `sui` (chain pinning), `warm` (build the runtime synchronously in `register`). The face carries `$ready()` and `$dispose()`; a synchronous member called before the runtime exists fails with `ExtensionNotReady`, while `Effect` and `Stream` members work cold. Every registration on one client shares one base `Sui`/`SuiCore` — one chain-id read and one sender-lock map — reference counted, so `$dispose()` releases it only when the last registration does. |
| `SuiGraphQL` | A bare tag over the SDK's `SuiGraphQLClient` (`layer`, `layerConfig`, `layerUnavailable`). @unconfirmed/sui-effect wraps no GraphQL API; the tag exists so extensions share one client. |

## Extensions

Downstream SDKs are extensions: one `Context.Service` on `Sui` and `Tx`, layers
that require `Sui` and never build a client, recipe fragments rather than
submissions, signers as parameters, errors that declare an `outcome`, and a
Promise face derived by `SuiExtension.fromService`. `docs/extensions.md` is the
contract and its review checklist; `examples/extension-template/` is the
copyable package every block of that guide is quoted from, and
`bun run check:template` is its own check.

`Tx.submit` journals `Signed` before the first execute, re-sends the identical
bytes (never a rebuild) on a retryable `TransportError` or a timeout, and
reconciles when the retries run out. A `TransportError` never escapes once bytes
may have been sent: it becomes `SubmissionUnknown`, which carries them.
`JournalError` escapes only from the `Signed` write, before anything is sent;
after the network has answered, a failed journal write is logged and the answer
stands.

`Tx.build` bounds a transaction to the current epoch and the next and names the
chain, records `sui.chainId` on `Built`/`Signed`, always simulates before
anything is signed (the SDK's resolver does it whenever there is anything to
resolve — a client with a base resolver and a preset gas budget resolves without
simulating, and `willResolve` sees that and runs one explicitly), and cancels
its in-flight request when interrupted, on **every** transport: the gRPC
resolver's simulate is reached by rebuilding the SDK's own
`GrpcCoreClient.resolveTransactionPlugin` over a client that carries the
signal. It sets no `maxTimestamp`: no Sui network accepts a timestamp
expiration yet (`test/live.devnet.test.ts`, behind `SUI_LIVE=1`, is the proof).
`Tx.run` takes `sponsor?: Signer` and requires it whenever the bytes name a gas
owner that is not the sender. `Tx.submit` waits for visibility before releasing
the sender lock.

`NotApplied` needs evidence that is checked twice: `"expired"` is
epoch-or-timestamp closed, then a `getTransaction` miss, then both again after
`SubmitConfig.reconcileRecheck`; `"inputConsumed"` is a **different**
transaction's own effects reporting `inputVersion` equal to the version the
bytes pinned. Reconcile follows the live object's `previousTransaction` — which
names the latest mutation, and is never evidence by itself — to that
transaction and reads `changedObjects[].inputVersion` off it. There is no
`v + 1` rule: Sui stamps every output with the transaction's Lamport version
(`max(input versions) + 1`), so the object "one version on" from a pinned one
usually never existed. `SuiCore.getObjectAtVersion` is still a public primitive;
it is no longer part of the rule. Every pinned reference is tried before the
answer is `SubmissionUnknown`, which is what almost every stuck submission gets.
Chain identity is compared before any recovery query, and
`reconcile`/`reconcileAll` turn every recovery read failure into
`SubmissionUnknown`.

`SuiCore` retries retryable `TransportError`s on reads only
(`Schedule.min([exponential("250 millis"), spaced("10 seconds")])` jittered, five
attempts). Retryable means gRPC `UNAVAILABLE`, `DEADLINE_EXCEEDED`,
`RESOURCE_EXHAUSTED`, `INTERNAL` or `UNKNOWN`, HTTP 5xx or 429, or a timeout;
`INTERNAL` and `UNKNOWN` are how grpc-web reports that the request never reached
a node at all. `executeTransaction` is never retried at this tier.

## The error taxonomy

Every failure is one flat tag; there is no error inheritance.

| Tag | Means |
|---|---|
| `TransportError` | The request did not reach a usable answer. `retryable` says whether a read may try again. |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | The three `ObjectError.reason` values. |
| `TransactionNotFound` | No transaction with that digest is known. |
| `NetworkMismatch` | The node is on another chain than the layer was built for. |
| `DecodeError` | BCS content or a schema boundary did not decode. |
| `SimulationFailed` | Simulation reported an execution failure. No gas charged. |
| `ExecutionFailed` | Applied on chain and failed. Gas charged. |
| `SubmissionUnknown` | Bytes may have been sent; the outcome is unknown. Carries the signed bytes, unless it came from reconciling a bare digest. |
| `NotApplied` | Provably never applied. `expired`: the expiry window was observed closed and the transaction missing, twice, `reconcileRecheck` apart. `inputConsumed`: the object at the version **after** a pinned one names a **different** transaction. An input that merely moved on is not evidence. |
| `SigningError` / `BuildError` / `PolicyDenied` / `JournalError` / `UnexpectedEffects` | Signing, building, preflight policy, journal, and effects that did not contain what was expected. |
| `GraphQLUnavailable` / `ExtensionNotReady` | No usable GraphQL endpoint; a synchronous Promise-face member used before its runtime existed. Both `not_applied`. |

`SuiError.outcome(e)` puts every failure on the axis a wrapper script acts on:
`"applied"` for `ExecutionFailed` and `UnexpectedEffects`, `"unknown"` for `SubmissionUnknown`,
`"not_applied"` for every other tag in the taxonomy, and `"unknown"` for
anything that is neither one of those tags nor declares an `outcome`.
`Script.exitCode` exits 1 for that last case rather than 3. An extension error
may declare its own `outcome`, and should. `SuiError.isRetryable`, `SuiError.describe` (one actionable line) and
`SuiError.toJson` round it out.

## Testing

`@unconfirmed/sui-effect/testing` ships `SuiCoreFake.layer(script)`, `layerTest(script)`
(the real `Sui` over the fake `SuiCore`), `layerExtensionTest(layer, script)`
(an extension's own layer over that) and `SuiTest` (`putObject`, `bumpVersion`,
`recordTransaction`, `deleteObject`, `setClock`, `setEpoch`, `scriptExecute`,
`scriptSimulate`, `scriptGetTransaction`, `calls`), which is the whole harness
an extension's tests need. Call recording is reached through `SuiTest.calls`,
not off the fake handle. The fake serves in-memory objects with
BCS content, the Clock object `0x6`, and scripted outcomes
(`FakeOutcome.succeed`, `failWith`, `transportError`, `notFound`, `timeoutThen`)
for simulate, execute, `getTransaction` and the resolver's budget simulation
(`buildSimulate`, which is how a test makes `Tx.build` fail with
`SimulationFailed`). It records every call so a test can
assert the include set that was sent. It also implements
`resolveTransactionPlugin` and `listCoins`, so `transaction.build({ client })`
against the fake's `client` resolves gas and object inputs from the script with
no network, and it keys transactions by
`TransactionDataBuilder.getDigestFromBytes` of the bytes it was handed. Any
method the script does not cover dies with a message naming it: a test never
silently passes against a stub. Its `client` implements `$extend`, so a derived
Promise face is testable the way a consumer writes it; `listOwnedObjects`
filters through `typeMatches` rather than string equality, and `getDynamicField`
matches an entry on **both** `name.type` and `name.bcs` — an entry scripted
without `bcs` still matches any key of its type, so two same-typed keys on one
parent can be told apart and a test can prove which key bytes a lookup used.
`FakeScript.transactions` (and `SuiTest.recordTransaction`) answers
`getTransaction` **by digest**, before the ordered script, which is what a
`NotApplied { inputConsumed }` test needs: the rule reads
`changedObjects[].inputVersion` off the consuming transaction, and
`FakeChange.inputVersion` is how a test says which version that was. A scripted
`commandResults` entry may give either array; the missing one defaults to `[]`
rather than failing a `Simulation` decode.

The fake enforces the invariants the lifecycle depends on: a known digest
executes idempotently, gas selection excludes object inputs, the coin set
evolves (deleted, mutated with `FakeChange.balance`, gas-bumped, created), a
submission with fewer signatures than the bytes name signers is refused, and a
version history is served through `tryGetPastObject`, which is what
`SuiCore.getObjectAtVersion` reads.
