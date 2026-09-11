# `@your-org/example-extension`

A copyable skeleton for a sui-effect extension: one Effect service built on
`Sui` and `Tx`, its errors, its three layers, its tests on the sui-effect
harness, and the derived Promise face a `client.$extend(...)` consumer sees.

`docs/extensions.md` in the sui-effect repository is the authoring guide, and
every code block in it is copied from this directory.

## What is in it

| File | What it shows |
|---|---|
| `src/schema.ts` | Move layouts through `SuiSchema.bcs`, so an object's type tag is checked before its bytes are parsed |
| `src/errors.ts` | Two `Schema.TaggedError` classes, each declaring the `outcome` a script's exit code is derived from |
| `src/Escrow.ts` | The service: a read, a recipe fragment, a submit-on-behalf operation, a nested namespace, and `layer` / `layerConfig` / `layerTest` |
| `src/upstream.ts` | A stand-in for a third-party Promise SDK, wrapped in `src/Escrow.ts` with `SuiCore.use` and `Effect.tryPromise` |
| `src/extension.ts` | `SuiExtension.fromService`: the Promise face, derived, never hand-written |
| `test/escrow.test.ts` | The whole test suite on `layerExtensionTest` and `SuiTest` from `sui-effect/testing`. No network, no mocks of its own |

## Running it here

```bash
cd examples/extension-template
bun run check        # tsc --noEmit && bun test
```

From the repository root, `bun run check:template` does the same thing.

Do **not** run `bun install` in this directory while it lives inside the
sui-effect repository. It needs no install: `effect` and `@mysten/sui` resolve
from the repository's own `node_modules`, and `sui-effect` resolves through the
`paths` block in `tsconfig.json`. Installing here would put a second copy of
`effect` in scope, and two copies of `effect` in one process means two
`Context.Service` identities and layers that silently do not match.

## Consuming it from a separate checkout

If you are developing your extension against a sui-effect **checkout** rather
than a published version, use the packed tarball, not `link:` or `bun link`:

```bash
cd /path/to/sui-effect && bun run build && npm pack
mkdir -p vendor && cp /path/to/sui-effect/sui-effect-*.tgz vendor/
bun add -d ./vendor/sui-effect-0.1.0.tgz
```

`link:` and `bun link` symlink the checkout, and **module resolution follows the
symlink's real path**: the linked checkout resolves `effect` and `@mysten/sui`
from its own `node_modules`, your package resolves them from yours, and the two
copies are nominally distinct. Every class that crosses the boundary then fails
to typecheck with `#private` mismatches, and at runtime two `Context.Service`
identities mean layers that silently do not match. Reserve `link:` for a real
workspace member, where one `node_modules` serves both.

Re-pack whenever the library changes, and **diff before you install**: `tar -tzf`
the new tarball against the old one, so a file that stopped shipping is caught
here rather than in a consumer. Record which sui-effect commit or tag the vendor
copy came from — a line in your README, or the tarball's own filename — so a
conversion can be re-run against the same library.

## Copying it out

1. Copy the directory somewhere of your own and rename it in `package.json`
   (`name`, `description`, and the `escrow` property name in `src/extension.ts`).
2. Delete the `baseUrl` and `paths` blocks from `tsconfig.json` **and
   `tsconfig.build.json`**, and install the dependencies:

   ```bash
   bun add -d sui-effect effect@4.0.0-rc.112 @mysten/sui@2.30.0 @mysten/bcs \
     @effect/language-service @types/bun typescript
   ```

   Note the `-d`. `sui-effect`, `effect` and `@mysten/sui` belong in
   **`peerDependencies` and `devDependencies`**, never in `dependencies` — a
   library that depends on any of them directly puts a second copy in the
   consumer's process, and two copies of `effect` means two `Context.Service`
   identities and layers that silently do not match. The `peerDependencies`
   block this template ships already says so; `devDependencies` is what pins
   the exact versions you build and test against.

   `effect` is pinned **exactly** (`4.0.0-rc.112`), not to a range: rc.113
   renamed `Config.nonEmptyString`, `Config.string` and `Config.redacted` to
   `Config.NonEmptyString`, `Config.String` and `Config.Redacted`, so the
   neighbouring rcs are not interchangeable. Match whatever `sui-effect`'s own
   `peerDependencies` pins.

   **Until `sui-effect` is published**, bun probes the registry for every
   `peerDependencies` entry — even one a local dependency already satisfies —
   and a 404 fails the install. That is what the
   `peerDependenciesMeta.sui-effect.optional: true` block in `package.json` is
   for. Delete that block on the swap to the published package, and make it a
   line on your release checklist: left in, it turns a genuinely missing peer
   into a silent `undefined` at import time.
3. Rename the service and its identifier. `"example-extension/Escrow"` is a
   runtime key: pick `"<your-package>/<Name>"` once and never change it after
   publishing.
4. Replace `ESCROW_PACKAGE`, the BCS layouts and the Move call targets with
   yours, and delete `src/upstream.ts` unless you really are wrapping a
   third-party Promise package. Note that every type-shaped value —
   `EscrowContent`, `escrowType`, `receiptType`, `SettlementContent` — is a
   **function of the package id**, because a Move type name contains one:
   configuring a different package has to move the codecs with it. Keep that
   shape.
5. Keep the shape: reads through `Sui`, writes through `Tx`, contributions as
   recipe fragments, signers as parameters, every error a `Schema.TaggedError`
   with an `outcome`, and the Promise face derived from the service.

## Building and publishing

`exports` points into `dist`, so the package has to be built before it is
published or consumed:

```bash
bun run build      # tsc -p tsconfig.build.json, emitting dist/ with declarations
bun run check      # typecheck, tests, and the packed-tarball check below
```

`bun run check:package` is the step that matters and the one most templates
lack: it builds, packs the tarball with `bun pm pack`, unpacks it into a
throwaway `node_modules`, and imports the package the way a consumer will.
`tsc --noEmit` and `bun test` both import `src/`, so both pass for a package
whose `dist` is never built and whose `files` list therefore ships nothing —
which is exactly the state this template was in before. Keep the script.

**It works after you copy the template out.** `check-package.ts` resolves
`sui-effect`, `effect` and `@mysten/*` from this package's own `node_modules`
first, which is what a copied-out package has after `bun install`, and only
falls back to the sui-effect repository two directories up when that repository
is really there (it checks the `name` in its `package.json`). Whichever copy of
`sui-effect` it finds has to be **built**, because the consumer imports its
`exports` map; a published tarball always is.

To publish:

1. Set `name`, `version` and, for a scoped package, `publishConfig.access`.
   The template is `0.0.0` and deliberately **not** `private`: a package meant
   to be copied and published must not carry a flag that silently refuses to.
2. `bun run check`.
3. `npm publish` (or `bun publish`). The `files` list ships `dist` and the
   README and nothing else — no sources, no tests, no tsconfig.

## Registering it on a client

`src/extension.ts` and `src/Platform.ts` both register `warm` and both thread
an `options.chainId` through. That is deliberate and it is the rule:

- **Every registration on one client gets the same chain id.** The base `Sui`,
  its transport and its **sender-lock map** are shared per client per effective
  chain id. Two registrations that disagree — or one `warm` on a pinned id and
  one lazy with none — get two of everything, and two `Tx.run`s for one address
  stop serializing.
- **`warm` needs a chain id it can take.** It builds the runtime inside
  `register`, synchronously, so it never asks the node. `mainnet` and `testnet`
  are in the built-in table; `devnet`, `localnet` and any custom network are
  not, and `register` throws without `options.chainId`. `test/escrow.test.ts`
  has that case.
- **`warm` is what makes synchronous members real.** A recipe builder, a
  package id or a codec read off a lazy registration before its first `await`
  throws `ExtensionNotReady`.

## The review checklist

The guide's checklist, in short. Reject an extension that has a `Promise` in an
interface, calls `executeTransaction` directly, holds a consumer signer in a
layer, has `unknown` in an error channel, maintains a Promise facade by hand,
or builds its own client instead of requiring `Sui`. Also reject one that
declares `sui-effect` in `dependencies`, hand-builds a `TransportError` instead
of `TransportError.fromUnknown`, or registers two extensions on one client with
different chain ids.
