# Prior art in-house: `@misofm/effect` and its consumers

Found 2026-09-11 after the design converged. `misofm/sdks/packages/effect` (`@misofm/effect` 0.1.1, 440 lines, Apache-2.0) is an existing Effect v4 rc.112 foundation over the Sui Core API that `@misofm/musicos`, `@misofm/partyos` and `@misofm/platform` are built on, and that `misofm/app`, `misofm/cli` and `misofm/api` (crank service) consume. sui-effect is its successor; the conversion work is migrating these packages onto sui-effect. Its shape confirms the spec rather than contradicting it.

## What it provides

- `SuiClient`: `Context.Service<SuiClient, ClientWithCoreApi>` with `SuiClient.layer(client) = Layer.succeed`. Also `SuiGraphQL` service for a `SuiGraphQLClient`, used only by platform catalog "type discovery" reads.
- Errors (`Schema.TaggedError`): `ObjectNotFoundError { objectId }`, `ObjectTypeMismatchError { objectId, expected, actual }`, `SuiRpcError { operation, cause }`, `BcsDecodeError { type, objectId?, cause }`, `TransactionFailedError { digest, status }`, `GraphQLUnavailableError`, `DeploymentError { message }`. Not-found is detected by duck-typing `code` plus regexes on messages (pre-2.26 SDK).
- Reads: `getObjectContent(id) -> { content: Uint8Array, type, version }`, `getOptionalObjectContent -> Option`, `getObjectsContent(ids) -> ReadonlyMap<id, { content, type }>` (single un-chunked call, errored ids silently dropped), `listDynamicFields(parent): Stream` via `Stream.paginate`, `decodeBcs(codec, schema, bytes, ctx)` (generated `.parse` codec then `Schema.decodeUnknownEffect` into a domain class), `assertObjectType(id, actual, expected)` (exact string compare, no normalization).
- Execute: `TxThunk = (tx) => void | Promise<void>` (in practice every implementation is synchronous), `buildTx(...thunks): Effect<Transaction>`, `signAndExecute(signer, tx)` via `core.signAndExecuteTransaction` with `include { effects, objectTypes, balanceChanges }` then `waitForTransaction`, `execThunks(signer, ...thunks)`, `ExecResult { digest, changedObjects, objectTypes, balanceChanges, gasUsed: number }` with pure extractors `publishedPackageId`, `allPublishedPackageIds`, `createdByType(substr)`, `maybeCreatedByType`, `createdByExactType`, `allCreatedByType(substr)`, `balanceDelta(address, coinType): string`.

Call-site counts across sdks, app, cli and api: `decodeBcs` 22, `getOptionalObjectContent` 20, `getObjectsContent` 12, `allCreatedByType` 7, `assertObjectType` 6, `listDynamicFields` 4, `buildTx` 4, `getObjectContent` 3, `createdByType` 3, `createdByExactType` 3, `signAndExecute` 2, `publishedPackageId` 2, `execThunks` 2, `balanceDelta` 1.

## How the platform SDK is shaped today

`@misofm/platform` exposes `miso()` returning a `SuiClientRegistration` whose `register(client)` constructs a large `MisoPlatformClient` class (client.ts is about 1400 lines) holding `SuiClient.layer(client)` internally, a cached `ready()` chain-identifier check, and Promise-facing methods that run Effects. Reads live in `read/*.ts` and `catalog.ts` as `Effect.fn` functions requiring `SuiClient | SuiGraphQL`. PTB builders return `TxThunk`s. musicos and partyos follow the same pattern at smaller scale. Consumers: app calls `Effect.runPromise` at React edges and uses `buildTx` for sponsored flows; cli provides `SuiClient.layer` per command and loads a Ledger signer lazily; the api crank service is the heaviest Effect consumer (15 `@misofm/effect` imports).

Publishing is per-package version tags (`effect-v*`, `platform-v*` ...) through `.github/workflows/publish.yml` with npm provenance; CI gates are `bun run typecheck`, `test`, `build`, `codegen:check`, `test:consumer` (packs tarballs and installs them into an isolated consumer).

## Mapping onto sui-effect

| `@misofm/effect` | sui-effect |
|---|---|
| `SuiClient.layer(client)` | `SuiCore.layerFromClient(client)` under `Sui.layerNoDeps` (adds the chain-id check that platform's `ready()` does by hand) |
| `SuiGraphQL` | stays a platform-owned service; not sui-effect's concern (GraphQL layer deferred) |
| `ObjectNotFoundError` | `ObjectNotFound` (plus `ObjectDeleted`, `ObjectUnavailable` from the SDK's own `reason`) |
| `ObjectTypeMismatchError` | `DecodeError { objectId, expectedType, issue }` from the BCS bridge's normalized tag check |
| `SuiRpcError { operation }` | `TransportError { method }` |
| `BcsDecodeError` | `DecodeError` |
| `TransactionFailedError { digest, status }` | `ExecutionFailed { digest, reason, command, effects }` |
| `getObjectContent` | `Sui.getObject(id)` (no schema: `content` is the raw bytes) |
| `getOptionalObjectContent` | `Sui.getObjectOption` |
| `getObjectsContent` | `Sui.getObjects` (chunked, integrity-checked, per-item `Result` instead of silent drops) |
| `listDynamicFields` | `Sui.streamDynamicFields` |
| `decodeBcs(codec, schema, bytes)` | `SuiSchema.bcs(codec, expectedType)` composed with the domain `Schema.Class` via `Schema.decodeTo`; pass as `Sui.getObject(id, { schema })` |
| `assertObjectType` | folded into the bridge's tag check |
| `TxThunk` | `Recipe = (tx) => void` (all existing thunks are already synchronous) |
| `buildTx(...thunks)` | compose recipes: `(tx) => { a(tx); b(tx) }`, then `Tx.build` |
| `signAndExecute` / `execThunks` | `Tx.run(recipe, { signer })` |
| `ExecResult` + extractors | `Executed` with `created(type)`, `packagesPublished()`, `balanceChange(address, coinType)`, `expectCreated` |

## Requirements this adds for Phase 1 (feed to the implementer)

1. `SuiSchema.bcs` must accept any codec with `parse(bytes: Uint8Array): T`, not only a `@mysten/bcs` `BcsType`, because the generated `@mysten/codegen` contracts are the codecs every misofm package uses. The expected type must be compared after `normalizeStructTag` on both sides.
2. `Executed.created(type)` matches on the normalized full struct tag. Add `createdWhere(predicate)` so the substring-based `createdByType`/`allCreatedByType` call sites (10 in total) have a direct replacement without reintroducing substring matching as the default.
3. `Executed.balanceChange(address, coinType)` returns `Mist` (`bigint`), and `gasUsedTotal` is `bigint`; consumers currently use `number`, which is a known precision hazard.
4. `Sui.getObjects` returning per-item `Result` is a deliberate behaviour change from `getObjectsContent` silently dropping errored ids; the conversion issues must call it out.
5. `Tx.run` replaces `signAndExecuteTransaction` plus `waitForTransaction`; the second call was redundant and is gone.
6. `SuiExtension.fromService` must support a large existing class surface: platform's registration exposes dozens of methods plus nested namespaces (`client.miso.protocol`, `client.miso.party`). The Promise facade needs to handle nested service objects, not just a flat interface.
