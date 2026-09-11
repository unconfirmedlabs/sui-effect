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

## Copying it out

1. Copy the directory somewhere of your own and rename it in `package.json`
   (`name`, `description`, and the `escrow` property name in `src/extension.ts`).
2. Delete the `baseUrl` and `paths` block from `tsconfig.json`, and add the
   real dependencies:

   ```bash
   bun add sui-effect
   bun add -d effect@4.0.0-rc.112 @mysten/sui@2.30.0 @types/bun typescript
   ```

   `sui-effect`, `effect` and `@mysten/sui` stay in `peerDependencies` — a
   library must never bundle a second copy of any of them — with the exact rcs
   pinned in `devDependencies`.
3. Rename the service and its identifier. `"example-extension/Escrow"` is a
   runtime key: pick `"<your-package>/<Name>"` once and never change it after
   publishing.
4. Replace `ESCROW_PACKAGE`, the BCS layouts and the Move call targets with
   yours, and delete `src/upstream.ts` unless you really are wrapping a
   third-party Promise package.
5. Keep the shape: reads through `Sui`, writes through `Tx`, contributions as
   recipe fragments, signers as parameters, every error a `Schema.TaggedError`
   with an `outcome`, and the Promise face derived from the service.

## The review checklist

The guide's checklist, in short. Reject an extension that has a `Promise` in an
interface, calls `executeTransaction` directly, holds a consumer signer in a
layer, has `unknown` in an error channel, maintains a Promise facade by hand,
or builds its own client instead of requiring `Sui`.
