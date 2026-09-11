# sui-effect

An opinionated [Effect](https://effect.website) v4 layer over
[`@mysten/sui`](https://www.npmjs.com/package/@mysten/sui) for building safe
TypeScript applications and on-demand agent scripts on Sui.

The SDK keeps doing BCS, transaction building, signing and transport. sui-effect
owns the shape of the program around it: two client tiers, closed error unions on
every function, the transaction lifecycle as functions with typed outcomes,
crash-safe submission, and time, retry and interruption through Effect so tests
can drive them.

> Status: phase 0. `SuiCore`, `Sui`, the error taxonomy, the branded schemas, the
> BCS bridge, `Executed` and the in-memory fake are implemented. `Signer`, `Tx`,
> the journal, extensions and the `Script` preset land in phase 1. See
> `DESIGN.md` and `docs/PLAN.md`.

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
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64 }),
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

## Testing

```ts
import { layerTest } from "sui-effect/testing"
```

`layerTest` is the real `Sui` over an in-memory `SuiCore`, so a test exercises
the production high tier with no network. See `AGENTS.md`.

## License

MIT
