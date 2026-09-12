# Effect v4 documentation audit (2026-09-12)

Five research passes over effect.website/docs/v4 (guide and core API, cross-checked against the installed rc.112 types) followed by an adversarial audit of sui-effect against them. NB1–NB16 shipped in 0.1.3; BR1 is pending a 0.2.0 decision; R1–R15 were rejected or deferred with the reasons given.

# F. Audit of sui-effect's use of Effect v4 (rc.112) against the official docs, and a change plan

Inputs: reports A–E in this directory, the library at `/home/bl/unconfirmedlabs/sui-effect` (0.1.2), the installed `node_modules/effect/dist/*.d.ts` and `node_modules/effect/AGENTS.md` + `ai-docs/` (rc.112 ground truth), `DESIGN.md`, `docs/extensions.md`, `docs/reviews/conversion-feedback.md`, the six misofm `*.feedback.md` files. Every claim below that is not a pure code reading was checked by a probe under `probes/` (`probe1.ts`–`probe4.ts`, run with `bun` and typechecked with the project's `tsconfig.json` flags including `exactOptionalPropertyTypes`; all four typecheck, exit 0). Nothing in the library was edited.

Line numbers are as of the working tree on 2026-09-12.

## (a) Verdict

sui-effect uses Effect v4 the way Effect's own rc.112 machine guide says to, and in several places more carefully than the guide's examples: every error is a `Schema.TaggedError` with `cause: Schema.Defect()` (the guide's own idiom), every service is `Context.Service` with `Effect.fn("Service.method")` members and no `.pipe` after `Effect.fn`, `Effect.catch`/`Effect.result`/flat `Cause` guards/`Effect.forkChild`/`Result` are the v4 spellings throughout, `Effect.retry` uses the options object, `Stream.paginate` and `Stream.toAsyncIterableWith` are exactly the documented shapes, the `Layer.MemoMap` + `ManagedRuntime` sharing in `SuiExtension` is the most advanced documented layer idiom applied correctly, and the v3→v4 traps (`Config.String` spelling, `Either`, `Layer.scoped`, `Effect.withConfigProvider`) are all avoided. **No correctness defect was found in the Effect usage.** Of the 63 candidate rows the five researchers raised, 13 are confirmed, 10 partial, 40 rejected — 31 of the rejections were the researchers' own "no concern, noted" entries, 9 are deliberate design choices the docs give no reason to reopen, and three observations were factually wrong: the `SHARED_BASES` "leak" is a `WeakMap` keyed by the client, `Tx.ts` does log, and `typeof Settlement.Encoded` *does* compile (it is the library's guide that is wrong there). What is left is ergonomics, and it clusters in four places the researchers each saw a slice of: (1) **schema metadata** — no `identifier`/`description` on any branded or declared schema, `Schema.optional` where `optionalKey` is the documented choice for library-owned shapes, `DecodeError.issue` throwing away the structured issue tree; (2) **what a consumer sees in the editor and in `LLMS.md`** — `Built`/`Signed`/`Simulation` render as 40-line structural blobs instead of their names, and `SubmitConfig` overrides need a `{ ...SubmitConfig.defaults }` spread at every site (13 in the tests alone); (3) **observability** — spans are named but carry no attributes (no `objectId`, no `digest`, no sender), which the docs' tracing example treats as the point of a span; (4) **one real maintenance hazard the researchers missed** — the taxonomy's tag list is spelled in three places (`errors.ts`, `Script.ts` twice) and `Script.exitCode`'s `switch` has a `default:` that silently exits 1 for any tag added to the taxonomy but not to that switch. Everything above is a patch release. The one minor-release item worth doing is `Schema.optionalKey` on the shapes sui-effect itself produces, which narrows types under `exactOptionalPropertyTypes` and can break a consumer that passes an explicit `undefined`. The design decisions the reports poked at — `Signer` as a value, `Schema.TaggedError` over `Data.TaggedError`, `RcMap<Semaphore>` over `PartitionedSemaphore`, `Random` bypass in `Signer.ephemeral`, no `Layer.mock`, no `Match`, `Effect.tryPromise` signal forwarding instead of `uninterruptible` — all stand; the docs give no reason the design missed.

## (b) Verification of the candidate concerns

Legend: CONFIRMED = a real gap against the docs; PARTIAL = the observation is right but the impact or the fix differs; REJECTED = no gap (deliberate and justified, or the observation is wrong). "Plan" points at section (d).

| # | Claim (report) | Verdict | Evidence | Plan |
|---|---|---|---|---|
| A1 | `Schema.TaggedError` everywhere, never `Data.TaggedError` | REJECTED | `node_modules/effect/AGENTS.md` itself uses `Schema.TaggedError` with `cause: Schema.Defect()` in every example (`Database`, `ParseError`, `FileProcessingError`); `errors.ts:30-399` matches it. Not a divergence. | — |
| A2 | `catchTag` array form used correctly | REJECTED (no concern) | `Sui.ts:444,569,783`, `Tx.ts:529`. | — |
| A3 | `Effect.retry` options-object idiom | REJECTED (no concern) | `SuiCore.ts:342-347`, `Tx.ts:953-957`. | — |
| A4 | `Effect.timeout` → `Cause.TimeoutError` → `mapError` | REJECTED (no concern) | `Tx.ts:442-444,876-882,947-948`; the `Effect.catch` vs `catchCause` comment at `Tx.ts:878-881` is the docs' guidance. | — |
| A5 | Flat `Cause` API in `Script.ts` | REJECTED (no concern) | `Script.ts:287-297,377-382`; `Cause.hasDies/hasInterrupts/hasFails/findErrorOption/pretty` all present in `Cause.d.ts:851-1192`. | — |
| A6 | `Result` not `Either` | REJECTED (no concern) | `Sui.ts:457-529`, `errors.ts:689-690`. | — |
| A7 | `dual` not used, and appropriately so | PARTIAL | Correct for `Tx.*` (data-first domain functions). Two members are combinator-shaped and data-last only: `Sui.withSenderLock(address)(effect)` (`Sui.ts:748-765`) and `Tx.sponsored(opts)(recipe)` (`Tx.ts:755-765`). `Function.dual` exists (`Function.d.ts:99`). The docs' dual rule targets pipeable combinators; both are used exactly once per call site, `effect.pipe(sui.withSenderLock(a))` already reads well. | reject/defer R3 |
| A8 | `Redacted` usage unknown (Signer out of scope) | REJECTED (resolved) | `Signer.ts:18,217-235`: `Config.redacted` + `Redacted.value`, decoded bytes never leave the function, the `ConfigError` carries a fixed sentence and no `cause` because the Bech32 decoder's message quotes the key. Better than the docs' minimum. | — |
| A9 | No `Data`/`Equal` | REJECTED (no concern) | Nothing in scope needs custom equality; `Schema.Class` `Executed` already gets `Equal`. | — |
| A10 | `Effect.fn` everywhere per AGENTS.md | REJECTED (no concern) | `Effect.fn` is `Effect.d.ts:17453`; the library never does `Effect.fn(...)(gen).pipe(...)` (grep: 0 hits), which is the one thing Effect's AGENTS.md forbids. | — |
| A11 | `getObjects` builds per-item `Result` by hand rather than `Effect.partition` | REJECTED as stated | Right reasoning: the per-item results are a reshaping of one SDK batch answer, not per-element effect failures. The real gap in that function is C4. | see C4 |
| B1 | No span attributes anywhere | CONFIRMED | grep `annotateCurrentSpan|annotateSpans` over `src/`: 0 hits. `Effect.fn` accepts static `SpanOptionsNoTrace.attributes` (`Effect.d.ts:17453`, `Tracer.d.ts:245-254`) and `Effect.annotateCurrentSpan` (`Effect.d.ts:15019`) inside the body lands on the fn's own span (probe1 §3: span `probe.f` carries `{"static":1,"sui.objectId":"0xabc"}`). The docs' tracing example (`ai-docs/src/08_observability/20_otlp-tracing.ts:55-60`) annotates with the order id. | NB6 |
| B2 | No `Effect.log*` in library internals | PARTIAL | True for the 9 files B read; false for the library: `Tx.ts:797` (`logError`, journal write after the answer) and `Tx.ts:883` (`logWarning`, visibility timeout), both `annotateLogs({ digest })` (`Tx.ts:801,888`), exactly the docs' `Effect.annotateLogs` idiom. `Script.run` binds the logger to stderr (`Script.ts:540-543,651`). No gap. | — |
| B3 | `Signer.ephemeral` bypasses `Random` | REJECTED | `Signer.ts:243-248` explains: `Random` is a seeded PRNG; key material needs a CSPRNG. Correct and documented. | — |
| B4 | `Layer.mock` unused | REJECTED | `Layer.mock` (`Layer.d.ts:3497`) is "missing members die"; the fake needs scripted outcomes, call recording, versioned objects, `$extend`. Not the same tool. | — |
| B5 | `Config` names are rc.112-correct | REJECTED (no concern) | `Script.ts:76,78`, `Signer.ts:217`, `SuiCore.ts:595-596`, `SuiGraphQL.ts:89-90`. | — |
| B6 | `Layer.effect` not `Layer.scoped`; no resource to release | REJECTED (no concern) | Correct. | — |
| B7 | `ManagedRuntime` + `Layer.MemoMap` sharing is a compliance highlight | REJECTED (no concern) | `SuiExtension.ts:338-405,597-602,633-637`. | — |
| B8 | `Context.Reference` idiom matches docs | REJECTED (no concern) | `SubmitConfig.ts:600-605`, `Journal.ts:369-371` = `ai-docs/src/01_effect/03_services/10_reference.ts`. | see N4 for the override helper |
| C1 | Retry/schedule construction matches docs | REJECTED (no concern) | as A3. | — |
| C2 | `RcMap<string, Semaphore>` vs `PartitionedSemaphore` | REJECTED | `PartitionedSemaphore` exists (`PartitionedSemaphore.d.ts:130`) but has no idle eviction; DESIGN §3 chose `RcMap` for exactly that. Considered and correctly rejected. | — |
| C3 | `SHARED_BASES` hand-rolled registry never evicts; use `RcMap`/`RcRef` | REJECTED | `SuiExtension.ts:336` is `WeakMap<object, Map<string, SharedBase>>` keyed by `client.core`: an entry dies with its client, so it does not "grow for the life of the process". The inner map is bounded by distinct chain ids per client (≤ a handful). `RcMap`/`RcRef`/`LayerMap` (`LayerMap.d.ts:145,302`) all live *inside* a runtime and are scoped; this registry has to be consulted synchronously from `register(client)` before any runtime exists. The reference counting that matters is done by `Layer.buildWithMemoMap`, which is the right primitive. | R5 |
| C4 | `getObjects` chunks are fetched strictly sequentially, no `Effect.forEach` concurrency | CONFIRMED | `Sui.ts:474-515`: `for (const page of chunk(unique)) { yield* core.getObjects(...) }`. `Effect.forEach(..., { concurrency })` (`Effect.d.ts` `forEach`) preserves input order and short-circuits on first failure (probe2 §G), which is what the loop's `return yield* new TransportError` relies on. Bounded, not unbounded, because a node rate-limits (429 → retryable, but avoidable). | NB5 |
| C5 | In-memory `Journal` uses a bare `Map` under `Effect.sync` not `Ref` | REJECTED | `Journal.ts:350-366`: each access is one synchronous callback, so there is no interleaving a `Ref` would prevent; `Ref` would add nothing but shape. DESIGN §8 specifies a `Map`. | — |
| C6 | `PUT_LOCKS` module-level `Map` of semaphores | REJECTED (no concern) | `JournalKeyValueStore.ts:48-72` documents the single-process limitation; eviction is undesirable. | — |
| C7 | No `uninterruptible`/`onInterrupt`/`ensuring` | REJECTED (no concern) | Interruption is `Effect.tryPromise({ try: (signal) => ... })` forwarding the `AbortSignal` (`SuiCore.ts:752-755,1038-1041`; `Tx.build`'s abortable client, DESIGN §6). That is Effect's documented cancellation mechanism for promise work. | — |
| C8 | `TestClock` idiom in tests | REJECTED (no concern) | `test/tx.test.ts:419-420,469-478`: `Effect.forkChild` + `TestClock.adjust` + `Fiber.await`, the docs' shape. | — |
| D4.1a | Brand definitions: check-then-brand, normalise in `decode` | REJECTED (no concern) | `schemas.ts:37-48,93-104,133-140,147-174,186-196`. | — |
| D4.1b | `SuiAddress.normalize` docstring says "an `Error` whose cause is the schema issue" | CONFIRMED | probe2 §A: `ObjectId.normalize("zz")` throws a `SchemaError` (`Schema.isSchemaError` true) with `.issue` set and `cause` **undefined**. `schemas.ts:61` (and the same sentence on `ObjectId`, `:109-127`) is wrong; a caller catching it should use `Schema.isSchemaError(e)` and `e.issue`. | NB9 |
| D4.1c | No `identifier`/`title`/`expected` annotation on any branded schema, so a non-string reports `Expected string` | CONFIRMED | probe1 §6: `Schema.decodeUnknownResult(ObjectId)(5)` → `Expected string`; a bad string → the filter message `Expected a 32-byte Sui object id` (good). Docs page "annotations": `identifier` drives `Expected <identifier>` and JSON-Schema `$ref`s. grep `identifier:` in `src/domain`: 0 hits. | NB3 |
| D4.2a | `Schema.Class` only where behaviour lives | REJECTED (no concern) | `executed.ts:114`. | — |
| D4.2b | Template `Settlement` class identifier `"Settlement"` collides | CONFIRMED (template only) | `examples/extension-template/src/schema.ts:75`; the library's own is `"sui-effect/Executed"` (`executed.ts:114`). Docs "classes": identifier is the stable runtime marker and JSON-Schema `$ref` key. | NB10 |
| D4.3a | `Schema.TaggedError` + disjoint tags in `SuiErrorSchema` | REJECTED (no concern) | `errors.ts:423-442`. | — |
| D4.3b | `cause: Schema.Defect()` JSON-safe | REJECTED (no concern) | `errors.ts:34,275,304,315,326`. | — |
| D4.3c | `override get message()` on 15 classes, `message` schema field on 3: `toJson` emits `message` inconsistently | PARTIAL | Deliberate (AGENTS.md "it is a getter, so it stays out of the encoding"; CHANGELOG 0.1.2). But the inconsistency is real for an operator reading JSON logs, and probe2 §D shows adding a `message` key to `toJson` output still decodes through `SuiErrorSchema` (excess keys ignored). A uniform `message` in `toJson` is additive and safe. | NB8 |
| D4.3d | `outcome` as class field + `withOutcome` patch-back vs `Schema.tag` | PARTIAL | `Schema.tag` exists in rc.112 (`Schema.d.ts:4728`). probe3: `outcome: Schema.tag("not_applied")` on a `TaggedError` gives `new X({ id })` with `outcome` present, encodes it, `SuiError.outcome`/`toJson` read it — and the patch-back (`errors.ts:709-719`) becomes a no-op for such errors. Decoding *without* the key fails (`tagDefaultOmit` is the other way round: omitted on encode). So it is a better convention for **new** extension errors, not a replacement: the class-field form must keep working (three converted packages use it). Docs-only change. | NB11 |
| D4.3e | `withDecodingDefaultKey` + `withConstructorDefault` stacked on `DecodeError.kind` | REJECTED (no concern) | `errors.ts:238-241`; probe2 §H. | — |
| D4.4a | BCS bridge as `transformOrFail`; `SchemaGetter.forbidden` is the shorter spelling of the `decodeWith` encoder | PARTIAL (cosmetic) | `bcs.ts:58-93,148-179`; `SchemaGetter.forbidden` exists (`SchemaGetter.d.ts:157`). Same behaviour. | R7 |
| D4.4b | `Schema.declare(...)` targets carry no annotations, so every bridge codec is `<Declaration>` to formatters/JSON-Schema/arbitrary | CONFIRMED | `bcs.ts:57,147`; `declare(is, annotations?)` takes `Annotations.Declaration` (`Schema.d.ts:381`). probe2 §E: anonymous → `Expected <Declaration>`, with `{ identifier: "Escrow" }` → `Expected Escrow`. | NB3 |
| D4.4c | Custom annotation key is a string, walked by hand | REJECTED (no concern) | `bcs.ts:17,191-202`: the resolvers do not follow encoding links, so the walk is needed. | — |
| D4.4d | `as unknown as Schema.Codec<T, Uint8Array>` where `Schema.revealCodec` is the documented zero-cost widening | CONFIRMED | `bcs.ts:96,180`; `revealCodec` at `Schema.d.ts:873`; probe2 §F assigns without a cast. | NB12 |
| D4.4e | Guide says `typeof Settlement.Encoded` as the halfway shape "does not compile"; D says it does | CONFIRMED (guide is wrong) | probe2 §B is the template's exact composition with `SchemaTransformation.transformOrFail<typeof Settlement.Encoded, typeof SettlementBcs.$inferType>`; `tsc -p` under the project's flags exits 0 and the bytes decode to `Success`. `docs/extensions.tpl.md:192-198` and `docs/reviews/conversion-feedback.md` item 3 (which came from a `transform` with `typeof Class.Type`, the instance side — that one does invert) overgeneralised. | NB13 |
| D4.4f | `Schema.toType` not needed | REJECTED (no concern) | — | — |
| D4.5 | Tagged unions (`TaggedUnion`, `toTaggedUnion("$kind")`, `.match`, `.isAnyOf`) | REJECTED (no concern) | `journal-entry.ts:355-393`, `schemas.ts:223-236,407-470`, `errors.ts:563-585`. | — |
| D4.6a | `Schema.optional` on SDK-mirroring fields | REJECTED (no concern) | Explicit `undefined` can arrive from SDK-built objects; `optional` is right. | — |
| D4.6b | `Schema.optional` on **library-owned** shapes where docs say `optionalKey` | CONFIRMED | `schemas.ts:640,652,680,681,683` (`SignedTransaction.expiration/chain`, `Built.gasOwner/expiration/chain`), `journal-entry.ts:36` (`Executed.checkpoint`), `errors.ts:33,136,156,167,231,232,260,275` (every optional error field). The producers already spread keys conditionally (`errors.ts:75`, `executed.ts:148-151`). probe1 §1 under `exactOptionalPropertyTypes`: `optional` types `status?: string \| undefined` and accepts `{ status: undefined }`; `optionalKey` types `status?: string`, rejects the explicit `undefined` at compile time and at decode. Docs "optional and default keys": "Use `Schema.optionalKey` instead when a field may be omitted but, when present, must contain a value accepted by its schema." | BR1 |
| D4.6c | `Executed.fromPartial` hand-rolls a lenient envelope instead of a second codec | PARTIAL | `executed.ts:436-561`. Correct today; a schema-shaped envelope would be introspectable and report all issues. Large rewrite for a relay-only path. | R8 |
| D4.7 | No `identifier`/`title`/`description` anywhere under `src/` | CONFIRMED | Same as D4.1c/D4.4b. `Schema.toJsonSchemaDocument` exists (`Schema.d.ts:10211`) and would inline every struct without names. | NB3 |
| D4.8 | `DecodeError.issue` is the first issue's message only; structured path/tree lost | CONFIRMED | `bcs.ts:323`, `executed.ts:413,557`; `SchemaError.issue: SchemaIssue.Issue` (`Schema.d.ts:932-934`); `SchemaIssue.makeFormatterStandardSchemaV1` (`SchemaIssue.d.ts:818`) returns `{ issues: [{ path, message }] }` and `{ errors: "all" }` reports every issue (probe1 §4). | NB4 |
| D4.9 | `Schema.is` for guards; hand-rolled tag sets for `isTaxonomy` | PARTIAL | `errors.ts:480-482` uses `Schema.is`; `TAXONOMY_TAGS` (`errors.ts:488-507`) is hand-written and duplicated — see N1. | NB1 |
| D4.10 | No exported equivalences | REJECTED (no concern) | Nothing compares refs structurally. | — |
| D4.11a | `Schema.Number` where docs use `Schema.Finite` | PARTIAL (cosmetic) | 17 sites (`schemas.ts:384-612`, `executed.ts:121`, `errors.ts:260`, `journal-entry.ts:48`); values come from JSON/gRPC decoders, `Finite` exists (`Schema.d.ts:5733`), `Type` stays `number`. | NB14 |
| D4.11b | `Uint8Array` vs `Uint8ArrayFromBase64` per field | REJECTED (no concern) | Correct field-level choice. | — |
| D4.11c | `.make`/`normalize` split | REJECTED (no concern) | — | — |
| E8.1 | Hand-rolled `toBase64` instead of `Encoding.encodeBase64` | CONFIRMED | `Script.ts:523-527`, used at `:489,566`; `Encoding.encodeBase64: (input: Uint8Array \| string) => string` (`Encoding.d.ts:126`). | NB7 |
| E8.2 | Hand-rolled `chunk` instead of `Array.chunksOf` | CONFIRMED | `Sui.ts:449-455`; `Array.chunksOf` (`Array.d.ts:5694`), same last-chunk semantics. | NB5 |
| E8.2b | `Stream.paginate` matches docs | REJECTED (no concern) | `Sui.ts:695-746`. | — |
| E8.3 | No `Match`; `switch (x._tag)` / `x._tag === ...` everywhere | PARTIAL | The `switch`es that matter are exhaustive by construction (`describeTaxonomy` `errors.ts:625-672` has no `default` and a `string` return type, so a missing case is a compile error). Reading `Option._tag`/`Result._tag` directly (`Tx.ts:966,1073,1122`, `SuiCore.ts:59,64`) is cosmetic. The real hazard E pointed at exists in one place it did not name: `Script.ts:390-428` `codeOfError` has `default: return EXIT.defect`, so a tag added to the taxonomy and forgotten there exits 1 silently — see N1. `Match.tagsExhaustive` over `SuiError` does compile (probe1 §5) and is a fine consumer idiom; the library does not need it. | NB1 |
| E8.4 | `Data` module unused | REJECTED | As A1. | — |
| E8.5 | No `Struct`/`Predicate`/`Iterable`; hand-written `isRecord` | PARTIAL | `Iterable.filterMap` for `executed.ts:155-169` is taste. But Effect's AGENTS.md says in bold "**NEVER** write your own helper functions like `isRecord` or `isString`, instead use the helpers from the `Predicate` module", and `executed.ts:437-438` is a hand-written `isRecord`; `Script.ts:315-325` (`isConfigError`, `hasTag`, `hasOutcomeField`) are `Predicate.isTagged`/`hasProperty` (`Predicate.d.ts:1229,1325`). | NB15 |
| E8.6 | `Stream.toAsyncIterableWith` is right | REJECTED (no concern) | `SuiExtension.ts:606-611`. | — |
| E8.7 | Flat named exports, one namespace | REJECTED (no concern) | DESIGN §0 "every public name mirrors the SDK name". | — |
| E8.8 | SDK `fromBase64`/`fromHex` at SDK boundaries | REJECTED (no concern) | `executed.ts:463`, `Signer.ts:189` decode SDK-format inputs for SDK calls. | — |

Counts: CONFIRMED 13, PARTIAL 10, REJECTED 40 (31 of which were the researchers' own "no concern" entries; 9 are justified design choices).

## (c) What the researchers missed

**N1. The taxonomy's tag list lives in three places, and one of them fails open.** `errors.ts:488-507` (`TAXONOMY_TAGS`), `Script.ts:499-518` (`SUI_ERROR_TAGS`, a verbatim copy) and `Script.ts:409-423` (the `case` list inside `codeOfError`), beside the `SuiError` type (`errors.ts:402-420`) and `SuiErrorSchema` (`errors.ts:423-442`). Adding a tag is five edits; forgetting `codeOfError` is not a compile error because of `default: return EXIT.defect` (`Script.ts:426`), so the new error exits 1 ("defect") instead of 4/3/5 — the exact failure mode `docs/extensions.md` §2 warns extension authors about, inside the library. The docs' tool for this is the tagged union the schema already is: `SuiErrorSchema.pipe(Schema.toTaggedUnion("_tag"))` yields `.cases` (18 keys, probe2 §C) and `.isAnyOf`, and `SuiError.outcome` already encodes the exit-code axis, so `codeOfError` can be `NetworkMismatch → 2, else code of SuiError.outcome(error)` with no per-tag list at all. Plan NB1.

**N2. `Tx.build`, `Tx.sign`, `Tx.submit`, `Tx.run` print a 40-line structural blob where a consumer should read `Built`/`Signed`.** `LLMS.md:3092-3140` (and every editor hover): `readonly build: (...) => Effect.Effect<{ readonly digest: Digest; ...; readonly expiration?: { readonly $kind: "None"; ... } | { ... "ValidDuring" ... } | { ... "Validity" ... } }, ...>` because `Built`/`Signed` are `typeof Struct.Type` aliases (`schemas.ts:654,685`, `Tx.ts:69-74`), which TypeScript expands. partyos feedback #11 fixed the `Brand<...>` half of this (0 `Brand<` in LLMS.md now) but not the struct half. Fix, proven in probe4 (`tsc --declaration` emits `Effect.Effect<Built>`): `type BuiltType = typeof BuiltSchema.Type; export interface Built extends BuiltType {}` — structurally identical, so nothing breaks, and the name survives into `.d.ts`, hover and `LLMS.md`. Same for `SignedTransaction`/`Signed`, `Simulation`, `ObjectEnvelope`, `ObjectRef`, `DynamicField`, `DynamicFieldEntry`. Plan NB2.

**N3. `SubmitConfig` has no override helper.** Every override is `Effect.provideService(effect, SubmitConfig, { ...SubmitConfig.defaults, maxGasBudget })` (`SubmitConfig.ts:585-598` doc, `test/tx.test.ts:143,193,226,239,262,284,441,459,501,671`, cli feedback #7). `Journal` already ships `Journal.layerMemory` (`Journal.ts:398-403`) for the same reason. A `SubmitConfig.layer(overrides: Partial<SubmitConfigService>): Layer.Layer<never>` (= `Layer.succeed(SubmitConfig, { ...defaults, ...overrides })`) and `SubmitConfig.with(overrides)` (= the `provideService` form) remove the spread and the `as typeof SubmitConfig.defaults.maxGasBudget` cast at every site. Plan NB16.

**N4. `SuiError.toJson` output has no `message` for 15 of 18 classes** (D4.3c) — additive fix, probe-verified safe. Plan NB8.

**N5. Span attributes are the one observability gap** (B1). The docs put the domain id on the span; sui-effect's spans say `SuiCore.getObject` and nothing else, so a trace of `Tx.run` cannot be joined to a digest or an address without logs. Plan NB6.

**N6. Two docs statements are false for rc.112**: the guide's halfway-shape paragraph (D4.4e) and the `normalize` docstring (D4.1b). Both send an extension author down a longer path than necessary. Plan NB9, NB13.

**N7. Things checked and found right that no report covered:** `Effect.fn` bodies never followed by `.pipe` (Effect AGENTS.md rule); `Sui.layerNoDepsWith` is `Layer.effect(Sui, Effect.gen(...))` exactly like the guide's `Database.layer`; service identifiers are `"<package>/<Name>"` as the guide asks; `Effect.catchTag` on the overloaded `getObject` narrows correctly at consumer sites (`examples/extension-consumer.ts:66-74`); `Effect.catchTags` and `Match.tagsExhaustive` over `SuiError` compile (probe1 §5) so consumers have both documented recovery idioms; the `Reconciled` `Schema.TaggedUnion` (`Tx.ts:116-125`) is the docs' shape for a discriminated result; `Effect.forkChild`/`TestClock.layer()` in tests are the v4 names; `Script.run` uses `Effect.runFork` + `Fiber.interrupt` rather than `BunRuntime.runMain` only because `src/` may not import a platform package (AGENTS.md), which the docs allow.

**N8. Not a gap, but worth stating for the record:** no `Effect.Service`-style accessors exist in v4 (`Context.Service` has no `accessors` option; grep `accessors` in `Context.d.ts`: 0), so "would `Effect.Service` accessors remove boilerplate" has no docs-backed answer; consumers write `const sui = yield* Sui` like every v4 example. `LayerMap.Service` (`ai-docs/.../30_layer-map.ts`) is the docs' keyed-layer tool and is the wrong shape for `SHARED_BASES` (C3). `Effect.catchReason` (`ai-docs/.../20_reason-errors.ts`) wants a tagged `reason` object, not `DecodeError.kind`'s literal; consumers use `Effect.catchIf` or a `kind` check, which is what `errors.ts:212-213` documents.

## (d) Ranked change plan

Ordering inside each bucket is by consumer-visible value over cost. Every item names what, where, the motivating docs page, the benefit, and the test to add. "Docs page" cites the rc.112 in-package guide (`node_modules/effect/AGENTS.md`, `ai-docs/`) or the captured page in this directory.

### Non-breaking, do now (patch 0.1.3)

**NB1. One source of truth for the taxonomy's tags; make `Script.exitCode` closed.**
- What: in `errors.ts`, replace the hand-written `TAXONOMY_TAGS` (`:488-507`) with the keys of `SuiErrorSchema.pipe(Schema.toTaggedUnion("_tag")).cases` (keep the exported `SuiErrorSchema` as is; add a non-exported `SuiErrorTagged`). Export nothing new. In `Script.ts`, delete `SUI_ERROR_TAGS`/`isSuiError` (`:499-521`) in favour of `SuiError.isTaxonomy`; rewrite `codeOfError` (`:386-429`) as: `ConfigError`/`SchemaError`/`NetworkMismatch → EXIT.configuration`; declared `outcome` field → `codeOfOutcome`; `TimeoutError → unresolved ? unknown : notApplied`; `SuiError.isTaxonomy(error) → codeOfOutcome(SuiError.outcome(error))`; else `EXIT.defect`. The `switch` and its `default` go away.
- Where: `src/domain/errors.ts:488-507`, `src/services/Script.ts:386-429,499-521`.
- Docs: Schema "tagged unions" (`toTaggedUnion` → `.cases`/`.isAnyOf`, captured in `part2-classes-errors.md`); Effect AGENTS.md "Runtime type guards" (no hand-rolled guards).
- Benefit: adding a taxonomy tag becomes two edits (`SuiError` type, `SuiErrorSchema`) and a miss is a compile error; `Script.exitCode` can no longer exit 1 for a real taxonomy error. Extension authors' `outcome` rule is now also the library's.
- Test: in `test/script.test.ts`, for every `tag of Object.keys(cases)` assert `codeOfError` agrees with `SuiError.outcome` (5/3/4) except `NetworkMismatch` (2), by constructing one instance per class from a fixture map keyed by tag, with a type-level `Exclude<SuiError["_tag"], keyof typeof fixtures>` asserted `never` so a new tag fails to compile until the fixture exists. Keep the existing exit-code tests.

**NB2. Name the lifecycle shapes so hover and LLMS.md print `Built`, `Signed`, `Simulation`.**
- What: for each `export type X = typeof X.Type` over a `Schema.Struct` that appears in a public signature, change to `type XType = typeof XSchema.Type; export interface X extends XType {}`. Targets: `Built` (`schemas.ts:685`), `SignedTransaction` (`:654`) and the `Signed` alias (`Tx.ts:72`), `Simulation` (`:819`), `ObjectEnvelope` (`:768`), `ObjectRef` (`:243-250`), `DynamicField`, `DynamicFieldEntry` (`:266,277`), `Balance` (`:259`). Leave tagged unions (`Owner`, `ExecutionReason`, `TransactionExpiration`) alone — an interface cannot extend a union, and the union spelled out is what a reader wants there.
- Where: `src/domain/schemas.ts` (lines above), `src/services/Tx.ts:72`.
- Docs: not an Effect page; the project's own LLMS readability rule (partyos feedback #11, `scripts/llms.ts` `NoTruncation`).
- Benefit: `Tx.build` reads `Effect.Effect<Built, BuildError | SimulationFailed | TransportError, Sui>` in the editor and in `LLMS.md:3092` instead of 40 lines; every `Tx.*` member becomes one line. Zero runtime change; structurally identical types (probe4).
- Test: `test/llms.test.ts` already regenerates and diffs; add an assertion that the generated `Tx` block contains `=> Effect.Effect<Built,` and `=> Effect.Effect<Signed,` and no line matching `readonly \$kind: "ValidDuring"` inside the `Tx` section. Type test in `test/SuiCore.types.test.ts`: `Built` is assignable to and from `typeof BuiltSchema.Type`.

**NB3. Annotate the reusable schemas with `identifier` (and `description` where a sentence exists).**
- What: `Schema.brand("SuiAddress")` already sets the brand identifier on the branded node, but the *string* node underneath is what reports a non-string input; add `.annotate({ identifier: "SuiAddress", description: "..." })` **before** `Schema.check` (annotating after `.check` targets the last check — docs warning) on `SuiAddress`, `ObjectId`, `Digest`, `StructTag`, `CoinType`, `Signature`, `Mist`, `Version`, `Network`. Give every `Schema.Struct` that NB2 names an `identifier` too (`ObjectRef`, `Balance`, `Built`, `SignedTransaction`, `Simulation`, ...). In `bcs.ts:57,147` pass `{ identifier: label, description: \`BCS layout ${label}\` }` to `Schema.declare`.
- Where: `src/domain/schemas.ts:37-48,93-104,133-140,147-174,186-196,200,503-506` and each Struct; `src/domain/bcs.ts:57,147`.
- Docs: "annotations" (`annotations.md`: `identifier` → `Expected <identifier>` messages and JSON-Schema `$ref`s); "error messages" (`error-messages.md`); D4.4b for `declare`.
- Benefit: `DecodeError.issue` reads `Expected ObjectId at ["objectId"]` instead of `Expected string`; `Expected Escrow` instead of `Expected <Declaration>` for a mis-shaped bridge value; `Schema.toJsonSchemaDocument(ObjectRef)` gets named `$defs`, which is what an agent toolkit (DESIGN §15 `/ai`) will consume.
- Test: `test/domain.test.ts`: `Schema.decodeUnknownResult(ObjectId)(5)` failure message starts with `Expected ObjectId`; `SuiSchema.decode(SuiSchema.bcs(layout, type), badBytes)` issue mentions the type; `Schema.toJsonSchemaDocument(ObjectRef)` has a `$defs`/`definitions` entry named `ObjectRef` (assert on `JSON.stringify` containing `"ObjectRef"`).

**NB4. Keep the structured issue on `DecodeError`, and report every issue.**
- What: add an optional field `issues: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.Array(Schema.Union([Schema.String, Schema.Number])), message: Schema.String })))` to `DecodeError` (`errors.ts:230-243`); in the three producers (`bcs.ts:313-326`, `executed.ts:412-414`, `executed.ts:553-560`) call `Schema.decodeUnknownEffect(schema)(input, { errors: "all" })` and fill `issues` from `SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues`. `issue` (the string) stays exactly as it is; `kind` stays the branching field.
- Where: `src/domain/errors.ts:230-243`, `src/domain/bcs.ts:313`, `src/domain/executed.ts:388-414,553-560`, `src/services/Sui.ts:92-96` (the `boundaryError` mapper at `:98-103` can also carry the formatted issues in its `cause`).
- Docs: "error formatters" (`error-formatters.md`: `makeFormatterStandardSchemaV1` → `{ path, message }[]`; `{ errors: "all" }`).
- Benefit: an operator debugging a `"shape"` failure on a relay envelope with three bad fields sees three paths, not one sentence; a UI can render per-field errors. Additive: consumers who never read `issues` are unaffected; `toJson` round-trips (`optionalKey` → key absent when empty).
- Test: `test/executed.test.ts`: `Executed.fromPartial` over an envelope with two bad fields yields `issues.length === 2` with the two paths; `test/domain.test.ts`: `SuiError.toJson(decodeError)` decodes back through `SuiErrorSchema` with `issues` intact.

**NB5. `Sui.getObjects`: `Array.chunksOf` and bounded-concurrent chunk fetches.**
- What: replace `chunk` (`Sui.ts:449-455`) with `Array.chunksOf(unique, CHUNK)`; replace the `for (const page of ...)` loop (`:474-515`) with `const pages = yield* Effect.forEach(Array.chunksOf(unique, CHUNK), fetchPage, { concurrency: CHUNK_CONCURRENCY })` where `fetchPage` is the loop body as an `Effect.fn("Sui.getObjectsPage")` returning `ReadonlyArray<readonly [key, Item]>` and failing with `TransportError` exactly where the loop `return yield*`s today; then fold `pages` into `answers`. `CHUNK_CONCURRENCY = 4` (module constant; document it). `forEach` preserves input order and fails on the first failure, so the integrity checks and the "first `TransportError` from `decodeObject` fails the whole read" rule (`:509`) are unchanged.
- Where: `src/services/Sui.ts:16-29` (add `Array` to the import), `:449-529`.
- Docs: "basic concurrency" (`Effect.forEach(..., { concurrency })`, captured in report C §concurrency); `Array.chunksOf` (`Array.d.ts:5694`, report E §8.2).
- Benefit: a 500-id read is ~10 chunk RTTs today and ~3 with concurrency 4; latency for `getObjectsStrict` callers (every batch read in the three conversions) drops accordingly, without unbounded fan-out against a rate-limited node.
- Test: `test/Sui.test.ts`: (1) 120 ids → `SuiTest.calls("getObjects")` has 3 entries with sizes 50/50/20 and the result is in input order (existing behaviour); (2) concurrency: script `getObjects` through a `Latch` (`effect` `Latch`) so the first two chunk calls block until both have been *recorded*, then open — proves two chunks are in flight together; (3) a scripted non-retryable `TransportError` on chunk 2 fails the whole read with that error (do not assert chunk 3 was never sent — under concurrency it may already be in flight; assert only that the failure escapes and no partial array is returned).

**NB6. Span attributes on the calls a trace has to be joined to.**
- What: inside the `Effect.fn` bodies, add `yield* Effect.annotateCurrentSpan({...})` with: `SuiCore.getObject` → `{ "sui.object_id": options.objectId }`; `SuiCore.getObjects` → `{ "sui.object_count": options.objectIds.length }`; `SuiCore.getTransaction`/`waitForTransaction` → `{ "sui.digest": options.digest }`; `SuiCore.executeTransaction` → `{ "sui.signature_count": ... }`; `SuiCore.getDynamicField` → parent id; `Tx.build` → `{ "sui.sender", "sui.gas_owner" }`; `Tx.sign`/`cosign` → signer address; `Tx.submit` → `{ "sui.digest" }` and, inside `once`, `{ "sui.attempt": attempts }`; `Tx.reconcile` → digest and evidence path; `Sui.withSenderLock` → `{ "sui.sender": address }`. Use `Effect.fn("...", { attributes: { "sui.network": ... } })` where a static attribute is known at construction (`makeFromClient` knows `client.network`).
- Where: `src/services/SuiCore.ts:765-782,810-818,855-901`, `src/services/Tx.ts:499,709,737,926,940-950,1440`, `src/services/Sui.ts:748-765`.
- Docs: `ai-docs/src/08_observability/20_otlp-tracing.ts:55-60` (`annotateSpans({ "checkout.order_id": orderId })`); `Effect.annotateCurrentSpan` (`Effect.d.ts:15019`); Effect AGENTS.md "Observability".
- Benefit: an OTLP trace of a stuck submission can be searched by digest and sender; the three conversions' operators asked for exactly this join (api feedback #5 "persist the digest before the first send").
- Test: `test/Sui.test.ts` (or a new `test/tracing.test.ts`): provide `Effect.withTracer(Tracer.make({ span: (options) => recordingSpan(options) }))` (`Tracer.d.ts:439`; `Span.attribute(key, value)` at `:371` is what `annotateCurrentSpan` calls) and assert the span named `SuiCore.getObject` received `sui.object_id`, and `Tx.submit` received `sui.digest` and `sui.attempt` 1..n under a scripted retry.

**NB7. `Encoding.encodeBase64` in `Script.ts`.**
- What: delete `toBase64` (`Script.ts:523-527`); use `Encoding.encodeBase64(bytes)` at `:489,566`.
- Docs: `Encoding.d.ts:126`; report E §8.1.
- Benefit: one less hand-rolled helper in a file agents read as the reference entrypoint.
- Test: `test/script.test.ts` already asserts the `bytes:` line; add `expect(line).toBe(\`bytes: ${Buffer.from(signed.bytes).toString("base64")}\`)`.

**NB8. Uniform `message` in `SuiError.toJson`.**
- What: in `toJson` (`errors.ts:738-749`), after encoding a taxonomy error, add `message: describe(error)` when the encoded object has no `message` key. Do the same on the `encodeThroughOwnSchema` path using the instance's `.message` when it is a non-empty string.
- Docs: Schema "classes" (`Error.prototype.message` is not a schema field); probe2 §D (round trip safe: excess keys ignored on decode).
- Benefit: every JSON log line has a human sentence in the same key; operators stop special-casing three tags.
- Test: `test/domain.test.ts`: for every class in `SuiErrorSchema.members`, `toJson(instance).message` is a non-empty string equal to `describe(instance)`, and `Schema.decodeUnknownSync(SuiErrorSchema)(toJson(instance))._tag === instance._tag`.

**NB9. Fix the `normalize` docstrings.**
- What: `schemas.ts:61` (and the `ObjectId` twin at `:109-127`): "It throws a `SchemaError` (`Schema.isSchemaError`), whose `.issue` is the schema issue and whose `.message` is the formatted line, like `Schema.decodeSync`; `.make` throws an `Error` with the issue in `cause`."
- Docs: "default constructors" (`.make` throws `Error` with `SchemaIssue.Issue` in `cause`) vs `decodeSync` (`SchemaError`, `Schema.d.ts:932-939`); probe2 §A.
- Benefit: a caller that catches `normalize` finds the issue where the docs say it is.
- Test: `test/domain.test.ts`: `expect(() => ObjectId.normalize("zz")).toThrow()` and the thrown value satisfies `Schema.isSchemaError` with `issue` defined.

**NB10. Template: scope the `Settlement` class identifier.**
- What: `examples/extension-template/src/schema.ts:75`: `Schema.Class<Settlement>("escrow/Settlement")`. Regenerate `docs/extensions.md` (`bun run docs:extensions`) and `LLMS.md`.
- Docs: "classes" (identifier is the runtime marker and JSON-Schema `$ref` key); the guide's own `"<package>/<Name>"` rule for services and error tags (`docs/extensions.md` §1 "Identifiers and naming").
- Benefit: two extensions with a `Settlement` class no longer collide in a JSON-Schema document or an identifier registry.
- Test: `examples/extension-template/test/escrow.test.ts`: `Settlement.identifier === "escrow/Settlement"` (or `Schema.toJsonSchemaDocument(Settlement)` contains it).

**NB11. Document `Schema.tag` as the schema-visible way to declare `outcome`.**
- What: in `docs/extensions.tpl.md` §2 and §11, beside the class-field form, show `outcome: Schema.tag("not_applied")` and say: it is a real schema field (encoded, decodable, `Schema.is`-visible), `.make`/`new` do not require it, and `SuiError.toJson` needs no patch-back for it; the class-field form keeps working. Do **not** change the template's errors (three converted packages copy it) — or change one of the three (`EscrowUnsupportedNetwork`) to show both forms side by side.
- Docs: "default constructors" (`Schema.tag`, `Schema.tagDefaultOmit`; `Schema.d.ts:4728,4760`); probe3.
- Benefit: an extension error's JSON schema names its `outcome`; `Schema.decodeUnknown(MyError)` on a logged line gets it back.
- Test: `test/extensions-guide.test.ts` (which checks guide blocks against the template): a `Schema.tag` error round-trips through `SuiError.toJson` and `Schema.decodeUnknownSync(MyError)` with `outcome` intact, and `Script.exitCode` maps it.

**NB12. `Schema.revealCodec` instead of `as unknown as`.**
- What: `bcs.ts:96,180`: wrap in `Schema.revealCodec(...)` and drop the casts. If the `annotate(...)` return type still does not unify, reveal before `.annotate` and re-annotate.
- Docs: `Schema.revealCodec` ("widens without runtime cost", `Schema.d.ts:873`); probe2 §F.
- Benefit: the bridge's public type is checked by the compiler rather than asserted; a future rc that changes `decodeTo`'s return shape fails at build, not at a consumer.
- Test: existing `test/bcs.test.ts` covers behaviour; add a type test that `SuiSchema.bcs(layout, type)` is assignable to `Schema.Codec<T, Uint8Array>` **without** the cast being needed (i.e. the test file compiles against the un-cast expression).

**NB13. Correct the guide's halfway-shape paragraph.**
- What: `docs/extensions.tpl.md:192-198`: replace "must be an explicit interface ... does not compile" with: "the source type of the transformation is the target's **Encoded** side — `typeof Settlement.Encoded` — which is what `decode` produces and `encode` consumes; a hand-written interface is equivalent and can drift. `typeof Settlement.Type` is the *instance* side and does not fit." Update `examples/extension-template/src/schema.ts:85-90,127` to use `typeof Settlement.Encoded` (delete `SettlementParts`), regenerate the guide, and strike item 3 in `docs/reviews/conversion-feedback.md` with a note.
- Docs: Schema "transformations" (`decodeTo(target)`'s decode getter produces `target.Encoded`, `part1-basics-filters-transformations.md`); probe2 §B typechecks under the project's flags.
- Benefit: one fewer interface per domain class in every extension; no drift between `SettlementParts` and `Settlement`.
- Test: `examples/extension-template/test/escrow.test.ts` decode of a `Settlement` already exists; the template's `tsc --noEmit` in `bun run check:template` is the proof.

**NB14. `Schema.Finite` where a JSON number is meant.**
- What: `Schema.Number` → `Schema.Finite` at `schemas.ts:384,386,392,393,420,421,426,430,443,444,484,543,580,612`, `executed.ts:121`, `errors.ts:260`, `journal-entry.ts:48`.
- Docs: Schema "basics" (`Finite` excludes `NaN`/`Infinity`; the docs' examples use it).
- Benefit: a `NaN` that reaches a schema from a relay envelope is a `DecodeError`, not a value; `Type` is still `number` so nothing breaks.
- Test: `test/domain.test.ts`: `Schema.decodeUnknownResult(GasCostSummary)({ ..., computationCost: NaN })` is a failure.

**NB15. Use `Predicate` for the runtime guards.**
- What: `executed.ts:437-438` `isRecord` → `Predicate.isObject` (verify it excludes arrays — `Predicate.d.ts:1105` has a separate `isObjectOrArray`, which implies it does; otherwise keep `!Array.isArray`). `Script.ts:315-325`: `isConfigError` → `Predicate.isTagged("ConfigError")`, `hasTag` → `Predicate.hasProperty(e, "_tag") && typeof e._tag === "string"`, `hasOutcomeField` → `Predicate.hasProperty(e, "outcome")`. `SuiCore.ts:75`, `errors.ts:692` are one-liners; optional.
- Docs: Effect AGENTS.md "Runtime type guards" ("**NEVER** write your own helper functions like `isRecord`").
- Benefit: the library follows the one bold rule in Effect's own agent guide; agents copying `Script.ts` copy the right idiom.
- Test: existing `test/script.test.ts` exit-code tests cover behaviour.

**NB16. `SubmitConfig.layer(overrides)` and `SubmitConfig.with(overrides)`.**
- What: in `SubmitConfig.ts:600-605` add `layer: (overrides: Partial<SubmitConfigService>) => Layer.succeed(SubmitConfigRef, { ...defaults, ...overrides })` and `with: (overrides) => <A, E, R>(effect) => Effect.provideService(effect, SubmitConfigRef, { ...defaults, ...overrides })`; keep `defaults`. Update the JSDoc example and README "Scripts"; use it in the tests.
- Where: `src/services/SubmitConfig.ts:580-605`, `test/tx.test.ts` (13 sites).
- Docs: `ai-docs/src/01_effect/03_services/10_reference.ts` (a `Reference` is provided like a service); `Journal.layerMemory` precedent (`Journal.ts:400`).
- Benefit: `Tx.run(recipe, { signer }).pipe(SubmitConfig.with({ maxGasBudget: Mist.make(1_000_000_000n) }))` — no spread, no cast; the override idiom cli feedback #7 asked to surface becomes one call.
- Test: `test/tx.test.ts`: a `Tx.run` under `SubmitConfig.with({ lockSender: false })` records no `withSenderLock` span / does not serialize; `SubmitConfig.layer({ resubmitAttempts: 1 })` composed with `layerTest` yields exactly one `executeTransaction` call on a retryable failure.

### Breaking, worth it (minor 0.2.0)

**BR1. `Schema.optionalKey` on every shape sui-effect produces itself.**
- What: `Schema.optional(X)` → `Schema.optionalKey(X)` at `schemas.ts:640,652,680,681,683` (`SignedTransaction.expiration/chain`, `Built.gasOwner/expiration/chain`), `journal-entry.ts:36` (`Executed.checkpoint`), `errors.ts:33,136,156,167,231,232,260,275` (`TransportError.status`, `ObjectNotFound/Deleted/Unavailable.version`, `DecodeError.objectId/expectedType`, `ExecutionFailed.command`, `SubmissionUnknown.signed`). Leave every SDK-mirroring field (`DynamicFieldEntry.childId`, `MoveLocation.*`, `CleverError.*`, `Event.json`, `ExecutionReason.*`) as `optional`.
- Docs: "optional and default keys" ("Use `Schema.optionalKey` instead when a field may be omitted but, when present, must contain a value accepted by its schema"); probe1 §1.
- Benefit: types read `chain?: string` instead of `chain?: string | undefined`; JSON Schema loses the spurious `null` branch; a persisted journal line or a hand-built error with `undefined` is refused rather than silently accepted.
- Why breaking: under `exactOptionalPropertyTypes` (the library's own setting, and the three misofm consumers'), `new DecodeError({ objectId: undefined, ... })` or `{ ...built, chain: undefined }` stops compiling. Runtime is unchanged for JSON (JSON cannot carry `undefined`).
- Migration per consumer: **platform** (`read/receipts.ts` and the `DecodeError` constructions api feedback #2 mentions): drop `objectId: undefined`/`expectedType: undefined` from `new DecodeError({...})`, spread conditionally as `errors.ts:75` does. **musicos/partyos**: grep `new (TransportError|DecodeError|ObjectNotFound|ObjectDeleted|ObjectUnavailable|SubmissionUnknown)\(` for explicit `undefined` values (expected: none — the guide tells authors to use `TransportError.fromUnknown`). **app/cli** (relay path): a `Signed` rebuilt from wire form must omit `expiration`/`chain` rather than set them `undefined`. Provide a one-line CHANGELOG row.
- Test: `test/domain.test.ts` type tests: `// @ts-expect-error` on `new DecodeError({ objectId: undefined, issue: "x" })`; decode of `{ _tag: "TransportError", method, retryable, status: undefined, cause }` through `SuiErrorSchema` fails; `TestSchema.Asserts` round-trips for every error and `JournalEntry` variant still pass.

### Reject / defer, with reasons

**R1. `Data.TaggedError` instead of `Schema.TaggedError`** (A1, E8.4) — reject: Effect's own guide uses `Schema.TaggedError`; serialization needs it.

**R2. `Ref` for the in-memory journal** (C5) — reject: no interleaving is possible inside `Effect.sync`; DESIGN §8 specifies a `Map`.

**R3. `dual` on `withSenderLock`/`Tx.sponsored`** (A7) — defer: both are used once per call site in data-last position and read well in `.pipe`; a dual signature on a service *member* would complicate `PromiseFace` mapping (`SuiExtension.ts:150-166`) for no consumer request.

**R4. `PartitionedSemaphore` for the sender lock** (C2) — reject: no idle eviction; DESIGN §3 chose `RcMap` for it.

**R5. `RcMap`/`RcRef`/`LayerMap` for `SHARED_BASES`** (C3) — reject: the registry is consulted synchronously outside any runtime; it is a `WeakMap` keyed by the client and does not leak; reference counting is already `Layer.buildWithMemoMap`'s.

**R6. `Match.tagsExhaustive` inside the library** (E8.3) — reject after NB1: the remaining `switch`es are exhaustive by return type; reading `Option._tag`/`Result._tag` is cosmetic. Mention `Effect.catchTags` and `Match.tagsExhaustive` in `LLMS.md`'s `SuiError` entry as consumer idioms (one sentence, in NB8's docs pass).

**R7. `SchemaGetter.forbidden` spelling in `decodeWith`** (D4.4a) — defer: identical behaviour; the current form carries a message that names the codec, which `forbidden`'s message callback also allows, so fold it into NB12 only if the reveal touches those lines anyway.

**R8. A schema-shaped lenient envelope for `Executed.fromPartial`** (D4.6c) — defer to the relay work (DESIGN §19 "Relay and sponsor envelopes"): correct today, and NB4's `issues` gives the operator the paths it was missing.

**R9. `Layer.mock` for the fake** (B4) — reject: wrong tool.

**R10. `Random` for `Signer.ephemeral`** (B3) — reject: security.

**R11. `Effect.catchReason`-shaped `DecodeError.reason`** (docs `20_reason-errors.ts`) — defer: it would replace `kind` (0.1.2, consumers branch on it) with a tagged object for a marginally nicer `catchReason`; `Effect.catchIf((e) => e._tag === "DecodeError" && e.kind === "type", ...)` is one line today.

**R12. `RequestResolver` for cross-call `getObject` dedup** (C4 second half) — defer: changes the call shape; the SDK batch endpoint already batches; no consumer asked.

**R13. `Effect.Service`-style accessor statics on `Sui`/`SuiCore`** — reject: v4 has no such feature (`Context.Service` has no `accessors`), and every v4 doc example writes `const sui = yield* Sui`; adding hand-written statics would double the surface `LLMS.md` prints.

**R14. `@effect/vitest` `it.effect`** (docs testing page) — reject: AGENTS.md mandates `bun test`; the `run`/`layerTest` helper in `test/tx.test.ts:145-156` is the same shape.

**R15. `BunRuntime.runMain` in `Script.run`** — reject: `src/` may not import a platform package (AGENTS.md); `Script.exitCode` is exported for consumers who use `runMain`.

## Counts

Non-breaking, do now: 16 (NB1–NB16). Breaking, worth it: 1 (BR1). Reject/defer: 15 (R1–R15).

Suggested order of execution for an implementer: NB2 → NB16 → NB1 → NB3 → NB4 → NB8 → NB9 → NB13 → NB10 → NB11 (docs pass, regenerate `docs/extensions.md` and `LLMS.md` once) → NB5 → NB6 → NB7 → NB12 → NB14 → NB15 → `bun run check` → BR1 on a `0.2.0` branch with the migration rows in `CHANGELOG.md`.
