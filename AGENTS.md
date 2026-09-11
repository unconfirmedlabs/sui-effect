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
- **Every public name mirrors the SDK name it wraps**, so an agent that knows
  `@mysten/sui` can guess sui-effect.
- Nothing under `src/` imports `@effect/platform-bun` or `bun:*`. `@effect/platform-bun`
  is a devDependency for tests and examples only.
- No `Effect.runPromise` / `runSync` under `src/`, except inside the documented
  Promise facade of `SuiExtension.fromService` (phase 1).
- No `any`. No `unknown` in an error channel. No `console.log` in `src/`.
- Every public function carries a JSDoc block that **states its error union in
  words** ("Fails with: `ObjectNotFound`, `TransportError`."), so `LLMS.md` can be
  generated from the source.
- Every dependency is a `Context.Service` with static layers (`layer`,
  `layerNoDeps`, `layerConfig`, a test layer). Every error is a
  `Schema.TaggedError`. Schema decodes at every boundary. Time comes from
  `DateTime`/`Clock`, randomness from `Random`, config from `Config`.
- Every service method has a span named after it.
- Every SDK call forwards the Effect's `AbortSignal` into the SDK's `signal`
  option, so `Effect.timeout` and interruption cancel the request.
- Tests run on `bun test` with `effect/testing` (`TestClock`, `TestSchema`).
  Tests provide their own layers and never touch the network. Localnet tests sit
  behind `SUI_LOCALNET=1`.
- Done means `bun run check` (typecheck, build, test) is green.

## The two tiers

| Tier | What it is | When to use it |
|---|---|---|
| `SuiCore` | A 1:1 Effect wrap of `ClientWithCoreApi`. One member per `SuiClientTypes.TransportMethods` key plus `getObject`, `getDynamicObjectField`, `waitForTransaction`, `signAndExecuteTransaction` and `use`. `Include` generics preserved. | Reaching a field or method `Sui` does not expose, and inside extension implementations. |
| `Sui` | The opinionated tier over `SuiCore`: fixed include sets, decoded BCS content, `Option` where absence is normal, chunked and integrity-checked batch reads, `Stream` pagination, one sender lock. | Almost all application and extension code. |

Reads go through `Sui`; writes go through `Tx` (phase 1). An extension never
calls `SuiCore.executeTransaction` directly.

`SuiCore` retries retryable `TransportError`s on reads only
(`Schedule.min([exponential("250 millis"), spaced("10 seconds")])` jittered, five
attempts). `executeTransaction` is never retried at this tier.

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
| `SubmissionUnknown` | Bytes may have been sent; the outcome is unknown. Carries the signed bytes. |
| `NotApplied` | Provably never applied (`expired` or `inputConsumed`). |
| `SigningError` / `BuildError` / `PolicyDenied` / `JournalError` / `UnexpectedEffects` | Signing, building, preflight policy, journal, and effects that did not contain what was expected. |

`SuiError.outcome(e)` puts every failure on the axis a wrapper script acts on:
`"applied"` for `ExecutionFailed`, `"unknown"` for `SubmissionUnknown`,
`"not_applied"` for everything else. An extension error may declare its own
`outcome`. `SuiError.isRetryable`, `SuiError.describe` (one actionable line) and
`SuiError.toJson` round it out.

## Testing

`sui-effect/testing` ships `SuiCoreFake.layer(script)` and `layerTest(script)`
(the real `Sui` over the fake `SuiCore`). The fake serves in-memory objects with
BCS content, the Clock object `0x6`, and scripted outcomes
(`FakeOutcome.succeed`, `failWith`, `transportError`, `notFound`, `timeoutThen`)
for simulate, execute and `getTransaction`. It records every call so a test can
assert the include set that was sent. Any method the script does not cover dies
with a message naming it: a test never silently passes against a stub.
