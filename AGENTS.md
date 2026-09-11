# Agent guidance

`DESIGN.md` is the specification and wins over everything else; `docs/PLAN.md` is
the work plan. Where this file and the spec disagree, fix this file.

## Ground rules

- **Effect v4 (`effect@4.0.0-rc.112`) only.** v3 names are compile errors. Never
  write an Effect name from memory: verify it in `node_modules/effect/dist/*.d.ts`.
  The house skill `effect-ts` and its review checklist are binding.
- **SDK names are the source of truth.** Read
  `node_modules/@mysten/sui/docs/llms-index.md` first, then the version-matched
  page, then confirm the signature in `node_modules/@mysten/sui/dist/**/*.d.mts`.
- Everything that is not public API lives in `src/internal.ts`, which is not in
  the `exports` map. `src/index.ts` is exactly the public surface.
- **Every public name mirrors the SDK name it wraps**, so an agent that knows
  `@mysten/sui` can guess sui-effect.
- Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `@effect/platform-bun`
  is a devDependency for tests and examples only.
- No `Effect.runPromise` / `runSync` under `src/`, except at the two documented
  edges: the Promise facade of `SuiExtension.fromService`, and `Script.run`,
  which is a process entrypoint and whose whole job is to fork the root fiber,
  await its `Exit` and exit.
- No `any`. No `unknown` in an error channel. No `console.log` in `src/`.
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
  Tests provide their own layers and never touch the network. Localnet tests sit
  behind `SUI_LOCALNET=1`.
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
| `Sui` | The opinionated tier over `SuiCore`: fixed include sets, decoded BCS content, `Option` where absence is normal, chunked and integrity-checked batch reads, `Stream` pagination, one sender lock. | Almost all application and extension code. |

Reads go through `Sui`; writes go through `Tx`. An extension never calls
`SuiCore.executeTransaction` directly. `Sui` exposes the `SuiCore` it was built
over as `sui.core`, which is what lets every `Tx.*` function declare `R = Sui`
and nothing else.

## The lifecycle

| Name | What it is |
|---|---|
| `Signer` | A credential as a **value**, never a service: `{ address, scheme, signTransaction, signPersonalMessage }`. One process may hold two. Secret material never reaches the value. |
| `Tx.build/sign/cosign/sponsored/submit/reconcile/run/reconcileAll` | The lifecycle as functions, each with a closed error union, all `R = Sui`. |
| `SubmitConfig` | A `Context.Reference` holding expiration policy, `validFor`, the gas-budget ceiling, `preflight`, the sender lock, and the resubmit schedule, attempts, timeout and expiry margin. |
| `Journal` | A `Context.Reference` with an in-memory default. `sui-effect/journal` swaps in a durable one over `KeyValueStore`; `Tx.reconcileAll()` is the explicit startup call. |
| `Script` | `{ sui, core, signer, network }` plus `Script.run` and `Script.exitCode`. `ScriptReadOnly` is the signer-less variant, a separate key on purpose. |
| `SuiExtension.fromService` | The Promise face of an Effect service, and the only place in `src/` allowed to run Effects. |

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
| `NotApplied` | Provably never applied (`expired` or `inputConsumed`). |
| `SigningError` / `BuildError` / `PolicyDenied` / `JournalError` / `UnexpectedEffects` | Signing, building, preflight policy, journal, and effects that did not contain what was expected. |

`SuiError.outcome(e)` puts every failure on the axis a wrapper script acts on:
`"applied"` for `ExecutionFailed`, `"unknown"` for `SubmissionUnknown`,
`"not_applied"` for everything else. An extension error may declare its own
`outcome`. `SuiError.isRetryable`, `SuiError.describe` (one actionable line) and
`SuiError.toJson` round it out.

## Testing

`sui-effect/testing` ships `SuiCoreFake.layer(script)`, `layerTest(script)`
(the real `Sui` over the fake `SuiCore`), `layerExtensionTest(layer, script)`
(an extension's own layer over that) and `SuiTest` (`putObject`, `bumpVersion`,
`deleteObject`, `setClock`, `scriptExecute`, `scriptSimulate`,
`scriptGetTransaction`, `calls`), which is the whole harness an extension's
tests need. The fake serves in-memory objects with
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
silently passes against a stub.
