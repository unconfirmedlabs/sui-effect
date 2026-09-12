# Changelog

All notable changes to `@unconfirmed/sui-effect`. The format is one line per
change, newest release first.

## 0.1.1

Seventeen fixes from the first downstream conversion. Nothing in the public API
was removed or renamed: an extension built against 0.1.0 compiles unchanged, and
the type-level workarounds it had to carry are now unnecessary.

### Fixed

- `PromiseFace<S>` recurses into **interface-typed** members, not only those assignable to `Record<string, unknown>`, so an interface-typed namespace (`readonly protocol: ProtocolService`) is mapped in the type the way the runtime has always mapped it — before this the face type said `Effect` where the value was a `Promise`.
- `SuiError.toJson` includes `outcome` when the error instance declares one, including the usual case where it is a class field rather than a schema field, so a log line carries the same axis `SuiError.outcome` and `Script.exitCode` read.
- The placeholder a **cold** member call returns is a real `Promise` subclass implementing `Symbol.asyncIterator`, so `instanceof Promise` holds and `expect(...).rejects` recognises it; its rejection is pre-handled, so a cold call nobody awaits no longer aborts the process with an unhandled `ExtensionNotReady`.
- A `warm` registration re-runs its warm build on the next use after `$dispose()` instead of degrading to a cold registration whose every synchronous member throws `ExtensionNotReady`.
- `mapSdkError` duck-types the SDK's error classes when `instanceof` fails — `reason` plus `objectId` for `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable`, `reason` plus `digest` for `TransactionNotFound`, the name plus `executionError` for `SimulationFailed` — so two copies of `@mysten/sui` in one process no longer turn every one of those tags into `TransportError { status: "notFound" }`, and the first such failure logs one warning naming the real problem.

### Added

- `SuiExtension.Leaf<T>` and `SuiExtension.leaf(value)`: the marker an extension puts on a class-instance member the Promise face must pass through whole rather than recurse into. `Uint8Array`, `Date`, `Promise`, arrays and BCS codecs (`parse` plus `serialize`) are recognised without it.
- `SuiAddress.normalize(input)` and `ObjectId.normalize(input)`: decode-and-brand from any spelling the SDK accepts, which is what `"0x1"` needs and what `.make` (validate without decoding) refuses.
- `SuiSchema.decodeWith(bcsType, expectedType, map)`: a BCS layout plus a throwing mapper into a domain value, as one codec, so an extension stops hand-rolling `Effect.try` around `Schema.decodeUnknownEffect` and losing the `DecodeError`.
- `layerExtensionTest(layer, script, { extra })`: extra dependency layers for an extension whose layer requires more than the client could provide, with `SuiGraphQL.layerUnavailable` merged in by default.
- `FakeScript.coinMetadata`, so `getCoinMetadata` is testable on the harness; an unscripted coin type answers `{ coinMetadata: null }` the way a node does.
- `CHANGELOG.md`, shipped in the package's `files`.

### Documentation

- The extension guide gains: the sanctioned idiom for a standalone function that needs a sibling extension's service, a worked generic-Move-type example on the fake, the `bun install --force` step after re-packing a vendored tarball with an unchanged filename, that `waitForTransaction` outcomes are driven by `FakeScript.getTransaction`, that a `warm` registration throws **any** layer failure synchronously out of `$extend`, and what a cold placeholder is now that it is a real `Promise`.
- `SuiGraphQL`'s JSDoc states that `yield* SuiGraphQL` yields the `SuiGraphQLClient` itself and that the service type is `SuiGraphQL["Service"]`.

## 0.1.0

Initial release: two client tiers (`SuiCore`, `Sui`), a closed error taxonomy,
the transaction lifecycle as functions with typed outcomes (`Tx`), the journal,
the `Script` preset, the BCS bridge and branded schemas, `SuiExtension.fromService`
for the Promise face of an Effect service, `SuiGraphQL` as a bare tag, and the
in-memory fake with its test layers.
