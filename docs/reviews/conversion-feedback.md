# sui-effect changes queued from the conversions (applied after the codex batch)

Sources: issues/partyos.conversion-feedback.md (and later musicos, platform, and each Fable verification's section G).

1. Guide section 16 ("Before the first release"): a `link:` or `bun link` to an external, independently installed sui-effect checkout does NOT dedupe `effect` and `@mysten/sui` (module resolution follows the symlink's real path), so every class crossing the boundary is nominally distinct and typecheck fails with `#private` mismatches. Recommend the packed tarball (`npm pack`, vendored, `file:./vendor/sui-effect-<v>.tgz`) as the default for a separate checkout; reserve `link:` for a real workspace member.
2. Same section: bun probes the registry for an unpublished `peerDependencies` entry even when a local dependency satisfies it (404); the workaround is `peerDependenciesMeta.<name>.optional: true` until the first publish, and the swap-to-npm checklist must undo it.
3. Guide section 3: say why the halfway shape for `Schema.decodeTo(DomainClass, SchemaTransformation.transform(...))` must be an explicit interface (referencing `typeof Class.Encoded` / `typeof Class.Type` inverts the inferred transformation direction and fails to compile); name the explicit interface pattern as required.
4. The template's `package.json` should carry the same optional-peer note in a comment-equivalent (README) since it is copied verbatim.

## From the partyos verification (section G)

5. Export a safe type-string matcher for dynamic-field `name.type` (primitives like `u64`, `bool`, `address`, `vector<u8>` are legal keys and `normalizeStructTag` throws on them); document it in the guide's dynamic-field recipe and in LLMS for `streamDynamicFields`.
6. Template `extension.ts` must thread an `options.chainId` into `warm: { chainId }` (or make `warm` conditional on a known chain id), and the checklist should require a warm-face test on a network with no built-in chain id.
7. Guide section 6: a `layerConfig` override must be validated through the typed deployment path; add a malformed-value test to the template.
8. The skill should say which sui-effect commit or tag a conversion targets, and the tarball workflow needs a "re-pack and diff" step; add migration rows for suffix-matching `assertObjectType` and for `DeploymentError` surfacing synchronously from `$extend` under `warm`; add checklist lines: no `Layer.orDie` over `Sui.layerNoDeps` in a compat class; a fake script with one key type per parent proves nothing about filtering; README `catchTag` strings must match prefixed tags.
9. LLMS entry for `SuiCoreFake` should state that call recording is reached through `SuiTest.calls`.
10. Guide section 16: bun auto-installs peers from the registry; the `peerDependenciesMeta.optional` escape must be reverted on the npm swap.

## From the musicos conversion

11. Testing docs: a `FakeOutcome.succeed({ commandResults })` entry for `sui.view` needs `mutatedReferences: []` on each result or `Simulation` decoding fails opaquely; show a complete entry, and make the fake default missing `mutatedReferences` to `[]`.
12. One-line callout that `Stream.runCollect` returns a plain `Array` in Effect v4, not a `Chunk`.
13. Event decoders often have no Move type tag at decode time (package id unknown); document that `SuiSchema.bcs` without an expected type is the intended shape for events and that the re-serialize check is what still guards them.
14. `SuiError.toJson` falls back to a generic `{ _tag, message }` for errors outside the closed taxonomy (extension errors with `outcome`); it should encode any `Schema.TaggedError` through its own schema (or `Schema.encodeSync` on the instance's constructor) so extension errors serialize with their fields.
15. `Effect.withConfigProvider` does not exist in rc.112; tests provide `ConfigProvider.ConfigProvider` via `Effect.provideService`. Say so in the testing guide's `layerConfig` example.

## From the musicos verification (section G)

16. `PromiseFace`: a plain-object value member (for example `deployment: { packageId }`) is treated as a namespace at runtime (cold read returns a placeholder function) but typed as the value; either throw `ExtensionNotReady` for leaf objects that are not namespaces of functions, or document the split precisely. Fix the guide's wording about "Promises before the runtime exists".
17. Add `SuiGraphQL.query(client => ...)` (or similar) returning `Effect<T, GraphQLUnavailable | TransportError>` so extensions do not re-derive the passthrough of `GraphQLUnavailable` from `Effect.tryPromise` rejections; document the idiom either way.
18. Skill and guide: never `.make` a branded value from unvalidated input (`ObjectId.make`, `StructTag.make` throw); decode with `Schema.decodeUnknownEffect` into `DecodeError`; an error whose schema needs an id you do not have is a sign you need your own error or `Option`. Also: put `tests` in the package tsconfig `include` or type-level pins never compile.
19. Note that `Config.option` turns an empty environment variable into "unset", so `layerConfig` docs should not promise `ConfigError` for empty values.
20. Call out on the npm swap that `Tx.build` now always simulates, so tests asserting `simulateTransaction` call counts move.
21. `SuiCoreFake.getDynamicField` matches on `name.type` only and ignores `name.bcs`, so no harness test can prove a lookup used the right key bytes or distinguish two same-typed keys on one parent; match on both.
22. `fromService` JSDoc and the guide must say that with `warm`, `sui.chainId` is taken as the pinned id and never asserted against the node until the first call (document the exact moment the node is consulted).
