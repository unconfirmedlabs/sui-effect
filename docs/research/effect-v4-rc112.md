# Effect v4 (4.0.0-rc.112) research for wrapping an SDK

Researched 2026-09-11 against `delta/node_modules/effect` (rc.112). npm `rc` tag was rc.113 for `effect` and rc.114 for `@effect/platform-bun` on 2026-09-10. The package ships `ai-docs/src/**` with runnable examples; that plus `dist/*.d.ts` was the source. Everything below is verified against rc.112 unless flagged.

## Package layout

Subpath exports: `effect`, `effect/testing`, `effect/unstable/{ai,cli,cluster,devtools,encoding,eventlog,http,httpapi,observability,persistence,process,reactivity,rpc,schema,socket,sql,workflow,workers}`, and `effect/*` for any core module. Everything that was `@effect/platform` (HttpClient, FetchHttpClient, HttpRouter, ...) is now inside `effect` under `effect/unstable/http`. `@effect/platform-bun` / `@effect/platform-node` stay separate (runtime, servers, filesystem). Peer versions unverified locally (only `effect` installed in delta).

## 1. Services

```ts
export class Database extends Context.Service<Database, {
  query(sql: string): Effect.Effect<Array<unknown>, DatabaseError>
}>()("myapp/db/Database") {
  static readonly layer = Layer.effect(Database, Effect.gen(function*() {
    const query = Effect.fn("Database.query")(function*(sql: string) { ... })
    return Database.of({ query })
  }))
}
export type DatabaseService = Database["Service"]
```

- `Context.Service<Self, Shape>()(id)`; `.of(shape)`; `Self["Service"]`; the class is yieldable.
- `Context.Reference<Shape>(key, { defaultValue })` for settings with defaults.
- `Layer.provide` (hide deps) vs `Layer.provideMerge` (expose deps). Idiom: `layerNoDeps` + `layer = layerNoDeps.pipe(Layer.provide(X))` + `layerTest = layerNoDeps.pipe(Layer.provideMerge(FakeX))`.
- `Layer.unwrap(Effect<Layer>)` for Config-driven layer choice.
- **No `Layer.scoped`.** `Layer.effect`'s effect runs inside the layer scope: `Effect.acquireRelease` inside it is released on teardown. Signature: `Layer<I, E, Exclude<R, Scope>>`.
- `Layer.effectDiscard` + `Effect.forkScoped` for background fibers.
- `LayerMap.Service` for per-key layers with idle TTL (per-network RPC client, per-tenant pool).
- `Layer.mock(Service, partialImpl)` exists (`Layer.d.ts:3497`): unimplemented members die only when invoked.
- `ServiceMap` does **not** exist in rc.112; the module is `Context`.

## 2. Typed errors

- `Data.TaggedError(tag)<Fields>` (no schema), `Schema.Error<Self>(id)(fields)` (untagged, schema), `Schema.TaggedError<Self>()(tag, fields, annotations?)` (dominant idiom). All yieldable: `return yield* new E({...})`.
- `Schema.Defect()` is the field type for unknown thrown values (`cause`).
- Catching: `Effect.catchTag(tag | [tags], h)`, `catchTags({...})`, `Effect.catch(h)` (all), `catchCause`, `catchDefect`, `mapError`, `orDie`.
- **Reason pattern (v4 only):** a TaggedError with `reason: Schema.Union([A, B, C])` plus `Effect.catchReason("E", "A", h, orElse?)`, `catchReasons("E", {...})`, `unwrapReason("E")` (lifts the reason union into the error channel). Ideal for a top-level `SuiError` with a nested cause union.
- `Cause<E>.reasons: Array<Fail<E> | Die | Interrupt>` (flat). `Cause.squash`, `Cause.pretty`, `Cause.findErrorOption`.
- `Effect.fn("Name")(function*(...){...}, ...combinators)`: span + stack traces; extra args are pipe steps (never `.pipe` the result). `Effect.fn.Return<A, E, R>`.
- `Effect.tryPromise({ try: (signal) => ..., catch })` and `Effect.promise((signal) => ...)` **pass an AbortSignal** (verified in `.d.ts`), so interruption cancels the underlying call when forwarded.
- Custom `message` getter on `Schema.TaggedError`: works as ordinary class inheritance; not explicitly documented (inferred).

## 3. Schema

- `Schema.Class<Self>(id)(fields)`, `Schema.Struct`, `Schema.TaggedStruct(tag, fields)`, `Schema.Union([A, B])` (array), `Schema.Literal(x)` (one), `Schema.Literals([...])`.
- `Schema.TaggedUnion({ Tag: fields, ... })` and `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))` give `.match`, `.matchOrElse`, `.guards`, `.isAnyOf`, `.cases.X.make`.
- Brands: `Schema.String.pipe(Schema.brand("SuiAddress"))`; `X.make(v)` validates + brands. Standalone `Brand` module also exists.
- **Checks:** `Schema.check(...)` with `Schema.isPattern(re)`, `isMinLength`, `isGreaterThan`, `isInt`, `isUUID`, ... and custom `Schema.makeFilter(pred, { message })`. `Schema.refine(guard)` narrows. **`Schema.filter` does not exist.**
- **Transforms:** `Schema.transform`/`transformOrFail` do **not** exist. Use `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform({ decode, encode })))` or `SchemaGetter.transform`/`transformOrFail` legs. Presets in `SchemaTransformation` (`numberFromString`, `uint8ArrayFromBase64String`, ...).
- Useful primitives: `Schema.BigInt`, `BigIntFromString`, `Uint8Array`, `Uint8ArrayFromBase64`, `Uint8ArrayFromBase64Url`, `Uint8ArrayFromHex`, `Option`, `OptionFromNullOr`, `NumberFromString`, `optionalKey` vs `optional`, `Redacted`/`RedactedFromValue`, `fromJsonString(S)`.
- Decode/encode: `decodeUnknownEffect | Sync | Result | Option | Exit | Promise`, `decodeEffect` (typed Encoded input), `encode*` mirrors, `Schema.is`, `Schema.asserts`. `SchemaError` is tagged with `.issue`.
- `Config.schema(codec, path?)` builds a Config from a Schema (no `Schema.Config`).
- `Schema.toJsonSchemaDocument`, `toStandardSchemaV1`, `toEquivalence`, `toArbitrary`.

## 4. Resilience

- `Schedule.exponential(base, factor?)`, `spaced`, `fixed`, `recurs(n)`, `jittered`, `min([...])` (fastest delay = cap), `max([...])` (continue while all continue), `Schedule.while(({ input, attempt, elapsed }) => ...)` with `Schedule.setInputType<E>()`, `Schedule.tap`, `Schedule.upTo({ times?, duration? })`, `Schedule.cron`. **No `Schedule.until`, `andThen`, `both`, `either`.**
- `Effect.retry(schedule | { schedule?, while?, until?, times? })`, `retryOrElse`, `Effect.repeat({ schedule, until })`, `Effect.schedule`.
- Production default: `Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("10 seconds")]).pipe(Schedule.jittered)` combined with `Schedule.max([..., Schedule.recurs(5)])`, `while: isRetryable`, outer `Effect.timeout`.
- `Effect.timeout(d)` adds `Cause.TimeoutError`; `timeoutOption`, `timeoutOrElse`; `Effect.race`, `raceAll`, `firstSuccessOf`.
- `ExecutionPlan.make({ provide, attempts, schedule, while }, ...)` + `Effect.withExecutionPlan` for ordered fallbacks (e.g. RPC endpoint failover).
- `Semaphore.make(n)`, `Semaphore.withPermits`; `Effect.forEach(items, f, { concurrency })`.
- `RateLimiter` lives in `effect/unstable/persistence` (store-backed: memory or Redis; token-bucket/fixed-window; `onExceeded: "delay" | "fail"`), also `HttpClient.withRateLimiter`.
- `Cache.make({ lookup, capacity, timeToLive })`, `ScopedCache`, `Effect.cached`, `cachedWithTTL`, `cachedInvalidateWithTTL`. `RequestResolver` + `Request.Class` + `Effect.request` for batching/dedup with `RequestResolver.withCache`, `setDelay`, `withSpan`.
- **No circuit breaker** in v4 core.

## 5. Concurrency and state

`Ref`, `SynchronizedRef`, `SubscriptionRef` (`.changes` is a Stream), `ScopedRef`, `Deferred`, `Latch`, `Semaphore`, `Queue.bounded<A, Cause.Done>(n)` (Queue replaces Mailbox; carries end/fail), `PubSub.bounded({ capacity, replay })`, `Tx*` family (`TxRef`, `TxHashMap`, `TxQueue`, ...) inside `Effect.tx`, `Effect.txRetry`. Fibers: `Effect.forkChild` (was fork), `forkScoped`, `forkIn(scope)`, `forkDetach` (was forkDaemon). `FiberSet`, `FiberMap`, `FiberHandle`. `RcMap`/`RcRef` for ref-counted resources by key. **`Mailbox` does not exist.**

## 6. Streams

- `Stream.paginate(s0, (s) => Effect<[ReadonlyArray<A>, Option<S>], E, R>)` is the cursor-pagination idiom (**no `paginateEffect`/`paginateChunkEffect`**; the step is already effectful).
- `Stream.callback<A, E>((queue) => Effect<_, E, Scope>)` with `Queue.offerUnsafe` for callback/subscription sources (**no `Stream.async`**).
- `Stream.fromAsyncIterable(iter, onError)`, `fromEffectSchedule(eff, schedule)` (polling), `fromPubSub`, `fromQueue`, `unfold`.
- `mapEffect(f, { concurrency, unordered })`, `flatMap({ concurrency })`, `take`, `takeUntil`, `changes`, `grouped`, `throttle`, `broadcast`, `share`.
- `runCollect`, `runForEach`, `runDrain`, `runFold`, `runHead`, `toReadableStream`, `toAsyncIterable`, `Stream.toPull`.
- `Ndjson`/`Msgpack` channels in `effect/unstable/encoding`.

## 7. HTTP (`effect/unstable/http`)

`HttpClient`, `HttpClientRequest`, `HttpClientResponse`, `HttpClientError` (`TransportError | EncodeError | InvalidUrlError | StatusCodeError | DecodeError | EmptyBodyError`), `FetchHttpClient.layer`, `FetchHttpClient.Fetch` (a `Context.Reference<typeof fetch>`), `HttpClient.retryTransient`, `filterStatusOk`, `mapRequest`, `withRateLimiter`. An SDK that owns its own fetch transport is wrapped via `Effect.tryPromise((signal) => sdk.call({ signal }))`, not through `HttpClient`.

## 8. Config

`Config.string | nonEmptyString | number | int | boolean | duration | port | url | literal | literals | redacted | schema(codec, path)`, `withDefault`, `orElse`, `map`, `mapOrFail`, `option`, `all`, `nested`. `ConfigProvider.fromEnv`, `fromEnvRecord`, `fromDotEnv`, `fromDir`, `fromUnknown(obj)` (**no `fromMap`/`fromJson`**), `ConfigProvider.layer`, `layerAdd`. `Redacted.value(r)`.

## 9. Runtime edges

`ManagedRuntime.make(layer, { memoMap })` + `runPromise`/`runSync`/`runFork`/`dispose`. `BunRuntime.runMain(effect, opts)`. `Layer.launch(layer): Effect<never>`. `Effect.runPromise`, `runPromiseExit`, `runFork`, `runPromiseWith(ctx)`. `Effect.scoped`.

## 10. Observability

`Effect.withSpan(name, { attributes })`, `annotateCurrentSpan`, `annotateSpans`, `annotateLogs`, `withLogSpan`, `Effect.log*`, `Logger.layer([...])`, `Logger.consoleJson`, `References.MinimumLogLevel`, `Metric.counter | gauge | histogram | summary | frequency | timer`, `Tracer.make`. Exporters in `effect/unstable/observability` (`Otlp.layerJson`, `OtlpTracer`, `PrometheusMetrics`).

## 11. Testing

`effect/testing`: `TestClock` (`adjust`, `setTime`, `withLive`), `TestConsole`, `TestSchema.Asserts`, `FastCheck`. `bun test` needs no adapter; `Effect.provide(layer, { local: true })` isolates memo maps. `@effect/vitest` offers `it.effect`, `it.live`, `layer(L)`. `Layer.mock`, `Effect.provideService`, `ConfigProvider.fromUnknown` for fixed config.

## 12. Unstable modules relevant to a chain SDK

- `effect/unstable/persistence`: `KeyValueStore` (`layerMemory | layerFileSystem | layerSql | layerStorage`, `toSchemaStore`, `prefix`), `PersistedCache`, `PersistedQueue`, `RateLimiter`, `Redis`.
- `effect/unstable/workflow`: `Workflow`, `Activity`, `DurableClock`, `DurableDeferred`, `DurableQueue`, `WorkflowEngine` (`layerMemory`), `WorkflowProxy`. Restart-safe multi-step flows; no ai-docs example shipped, read `.d.ts` before designing on it.
- `effect/unstable/ai`: `Tool.make(name, { parameters, success, failureMode })`, `Toolkit.make(...).toLayer(...)`, `LanguageModel`, `Chat`, `McpServer`. Template for exposing wallet/chain operations as agent tools.
- `effect/unstable/rpc`: typed RPC groups; heavier than needed for wrapping, useful for exposing our own surface.

## Flagged uncertainties

- Peer package versions (`@effect/platform-bun`, `@effect/vitest`) unverified locally.
- `effect/unstable/workflow` usage idiom unverified beyond exports.
- `Schema.TaggedError` custom `message` getter: inferred, not documented.
