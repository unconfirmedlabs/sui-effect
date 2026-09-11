# sui-effect

An opinionated [Effect](https://effect.website) v4 layer over
[`@mysten/sui`](https://www.npmjs.com/package/@mysten/sui) for building safe
TypeScript applications and on-demand agent scripts on Sui.

The SDK keeps doing BCS, transaction building, signing and transport. sui-effect
owns the shape of the program around it: two client tiers, closed error unions on
every function, the transaction lifecycle as functions with typed outcomes,
crash-safe submission, and time, retry and interruption through Effect so tests
can drive them.

> Status: phase 1. `SuiCore`, `Sui`, the error taxonomy, the branded schemas, the
> BCS bridge, `Executed`, the in-memory fake, `Signer`, `Tx`, `SubmitConfig`, the
> journal (memory and `KeyValueStore`), `SuiExtension.fromService` and the
> `Script` preset are implemented. The extension authoring guide, the template
> and `LLMS.md` land next. See `DESIGN.md` and `docs/PLAN.md`.

## Install

```bash
bun add sui-effect effect@4.0.0-rc.112 @mysten/sui
```

## The two tiers

`SuiCore` is a 1:1 Effect wrap of the SDK's `ClientWithCoreApi`: every transport
method, the SDK's `Include` generics preserved, every call cancellable, every
failure a tagged error.

`Sui` is the opinionated tier: fixed include sets, BCS content decoded through
`Schema`, `Option` where absence is normal, batch reads chunked and checked,
pagination as `Stream`, and one lock per sender.

```ts
import { Effect } from "effect"
import { bcs } from "@mysten/sui/bcs"
import { ObjectId, Sui, SuiSchema } from "sui-effect"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  "0x2::escrow::Escrow"
)

const program = Effect.gen(function*() {
  const sui = yield* Sui
  const escrow = yield* sui.getObject(ObjectId.make("0x…"), { schema: Escrow })
  return escrow.content.amount
})
```

The inferred error type of that generator lists `ObjectNotFound`,
`ObjectDeleted`, `ObjectUnavailable`, `DecodeError` and `TransportError`, and
nothing else.

## Writing a transaction

`Tx` is the lifecycle as functions, each with a closed error union. A recipe is
a synchronous `(tx: Transaction) => void`, so the draft is replayable and free
of dependencies.

```ts
import { Effect } from "effect"
import { Tx } from "sui-effect/tx"

const claim = Effect.gen(function*() {
  const executed = yield* Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(id)] })
  }, { signer })
  return yield* executed.expectCreated(`${PKG}::escrow::Receipt`)
})
```

`Tx.run` holds one lock per sender from build through submit, builds (which
already simulates), signs, journals the signed bytes before the first execute,
re-sends the identical bytes on a retryable transport failure or a timeout, and
if it still does not know, reconciles: `Executed`, `ExecutionFailed`,
`NotApplied { evidence }`, or `SubmissionUnknown` carrying the bytes. A
`TransportError` never escapes once bytes may have been sent.

`Signer` is a value, not a service — one process can hold two credentials:
`Signer.fromKeypair(kp)`, `Signer.fromConfig()` (Bech32, `Config.redacted`),
`Signer.ephemeral`, `Signer.remote(f)` for a KMS or a wallet. Secret material
never reaches the value.

`SubmitConfig` and `Journal` are `Context.Reference`s with working defaults, so
none of this needs wiring. `sui-effect/journal` swaps the memory journal for a
durable one over `KeyValueStore`, and `Tx.reconcileAll()` is the explicit
startup call that settles what a previous run left behind.

## Scripts

```ts
import { Console, Effect } from "effect"
import { Script } from "sui-effect/script"

Script.run(Effect.gen(function*() {
  const { signer, sui } = yield* Script
  // ...
}))
```

`Script.layer` reads `SUI_NETWORK` (required, no default, `mainnet` refused
unless `SUI_ALLOW_MAINNET=1`), `SUI_RPC_URL` and `SUI_PRIVATE_KEY`. stdout
carries only what the script printed; diagnostics go to stderr, and the exit
code says what a wrapper should do: 0 success, 2 configuration, 3 unknown
outcome (reconcile before retrying), 4 nothing applied (safe to retry), 5
applied and failed on chain (gas charged), 130 interrupted, 1 a defect.
`examples/script-claim.ts` is the whole thing end to end.

## Extensions

A downstream SDK is an Effect service built on `Sui` and `Tx`, and
`SuiExtension.fromService` derives its Promise face for consumers who have an
SDK client and no Effect:

```ts
import { SuiExtension } from "sui-effect/extension"

export const onara = (opts: OnaraOptions) =>
  SuiExtension.fromService(Onara, { name: "onara", layer: Onara.layer(opts) })

const client = new SuiGrpcClient({ network: "testnet", baseUrl }).$extend(onara({ url }))
const status = await client.onara.status()
```

Effect members become Promise methods, Stream members become `AsyncIterable`s,
nested namespaces are mapped recursively, and a rejection is the original tagged
error instance, so a Promise consumer can still switch on `_tag`.

## Testing

```ts
import { layerTest } from "sui-effect/testing"
```

`layerTest` is the real `Sui` over an in-memory `SuiCore`, so a test exercises
the production high tier with no network. See `AGENTS.md`.

## License

MIT
