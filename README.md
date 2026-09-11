# sui-effect

An opinionated [Effect](https://effect.website) v4 layer over
[`@mysten/sui`](https://www.npmjs.com/package/@mysten/sui) for building safe
TypeScript applications and on-demand agent scripts on Sui.

The SDK keeps doing BCS, transaction building, signing and transport.
sui-effect owns the shape of the program around it: two client tiers, closed
error unions on every function, the transaction lifecycle as functions with
typed outcomes, crash-safe submission, and time, retry and interruption through
Effect so tests can drive them.

## Install

```bash
bun add sui-effect
bun add -d effect@4.0.0-rc.112 @mysten/sui@2.30.0
```

`effect` and `@mysten/sui` are peer dependencies: one copy of each per process,
or `Context.Service` identities and `instanceof` checks stop matching.

## A complete script

```ts
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "sui-effect"
import { Script } from "sui-effect/script"
import { Tx } from "sui-effect/tx"

const PKG = "0x…"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)

export const program = Effect.gen(function*() {
  const { signer, sui } = yield* Script
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const executed = yield* Tx.run((tx) => {
    tx.moveCall({
      target: `${PKG}::escrow::claim`,
      arguments: [tx.object(id), tx.pure.u64(escrow.content.amount)]
    })
  }, { signer })
  const receipt = yield* executed.expectCreated(`${PKG}::escrow::Receipt`)
  yield* Console.log(receipt.id)
})

if (import.meta.main) {
  await Script.run(program)
}
```

That is `examples/script-claim.ts`, which a test runs against the in-memory
fake. Every failure it can produce is in the generator's inferred error type and
has its own exit code, with no handling lines anywhere.

## The two tiers

`SuiCore` is the mechanical tier: a one-to-one Effect wrap of the SDK's
`ClientWithCoreApi`, with every transport method present, the SDK's `Include`
generics preserved, every call cancellable through the Effect's `AbortSignal`,
every failure mapped into one tagged error by one mapper, a span per method, and
retries on transient transport failures for reads only. Reach for it when you
need a field or a method the tier above does not expose, and through
`core.use(client => …)` when an upstream package wants the client object itself.

`Sui` is the opinionated tier over it, and is what application and extension
code reads through: fixed include sets, BCS content decoded through `Schema`
with the object's Move type checked first, `Option` where absence is normal,
batch reads chunked to 50 and checked for missing or duplicated ids, pagination
as `Stream`, one lock per sender so two transactions from one address cannot
pick the same gas coin, and the chain's own clock. It carries the `SuiCore` it
was built over as `sui.core`, which is why every `Tx.*` function needs only
`Sui`.

## The transaction lifecycle

`Tx` is the lifecycle as functions — `build`, `sign`, `cosign`, `sponsored`,
`submit`, `reconcile`, `run`, `reconcileAll` — each with a closed error union
and `R = Sui`. `Tx.run` holds the sender lock from build through submit, builds
(which already simulates, so a transaction that would abort never gets signed),
signs, journals the signed bytes before the first execute, re-sends the
identical bytes — never a rebuild — on a retryable transport failure or a
timeout, and if it still does not know what happened, reconciles: `Executed`,
`ExecutionFailed`, `NotApplied { evidence }` when the expiration has passed or
an input has moved on, or `SubmissionUnknown` carrying the bytes. A
`TransportError` never escapes once bytes may have been sent. `Signer` is a
value, not a service, so one process can hold two credentials; `SubmitConfig`
and `Journal` are `Context.Reference`s with working defaults, so none of this
needs wiring, and `sui-effect/journal` swaps the memory journal for a durable
one over `KeyValueStore`.

## Extensions

A downstream SDK is an extension: an Effect service built on `Sui` and `Tx`
whose layer requires `Sui` and nothing it could have built itself, whose
contributions to a transaction are recipe fragments consumers compose into one
programmable transaction, whose signers are parameters, and whose Promise face
is derived — not hand-maintained — by `SuiExtension.fromService`, so a consumer
with an SDK client writes `client.$extend(escrow(options))` and then plain
`await`s, with the same tagged error instances on rejection.
**[`docs/extensions.md`](docs/extensions.md) is the contract**, and
`examples/extension-template/` is a copyable package that implements it.

## Errors

Every failure is one of these, every one is a `Schema.TaggedError`, and there is
no error inheritance to match on.

| Tag | Fields | Means |
|---|---|---|
| `TransportError` | `method`, `retryable`, `status?`, `cause` | The request did not reach a usable answer. Timeouts land here with `retryable: true` and `status: "DEADLINE_EXCEEDED"` |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | `objectId`, `version?` | The three `ObjectError.reason` values |
| `TransactionNotFound` | `digest` | No transaction with that digest is known |
| `NetworkMismatch` | `expected`, `actual` | The node is on another chain than the layer was built for |
| `DecodeError` | `objectId?`, `expectedType?`, `issue` | BCS content or a schema boundary did not decode |
| `SimulationFailed` | `reason`, `message` | Simulation reported an execution failure. No gas charged |
| `ExecutionFailed` | `digest`, `reason`, `command?`, `effects` | Applied on chain and failed. Gas charged |
| `SubmissionUnknown` | `digest`, `signed?`, `cause` | Bytes may have been sent; the outcome is unknown. Carries them, unless it came from reconciling a bare digest |
| `NotApplied` | `digest`, `evidence: "expired" \| "inputConsumed"` | Provably never applied, and never will be |
| `SigningError` | `cause` | A signer refused or failed |
| `BuildError` | `message`, `cause` | The transaction could not be built |
| `PolicyDenied` | `rule`, `message` | A preflight policy refused it before it was signed |
| `JournalError` | `cause` | The journal could not be read or written |
| `UnexpectedEffects` | `digest`, `expected`, `found` | The effects did not contain what the caller expected |

`ExecutionReason` mirrors the SDK's `ExecutionError` variant for variant, with
`MoveAbort.abortCode` as a `bigint` and clever-error constant names decoded.
`SuiError.isRetryable`, `SuiError.outcome`, `SuiError.describe` and
`SuiError.toJson` are the four helpers every repo otherwise hand-rolls;
`outcome` puts every failure on the `"applied" | "not_applied" | "unknown"`
axis, and an extension error may declare its own.

## Scripts

`Script.layer` reads the environment:

| Variable | Required | Meaning |
|---|---|---|
| `SUI_NETWORK` | yes, no default | `mainnet`, `testnet`, `devnet`, `localnet` or your own |
| `SUI_ALLOW_MAINNET` | only for mainnet | `1` or `true`; a script that means mainnet has to say so twice |
| `SUI_RPC_URL` | no | The gRPC endpoint; defaulted per known network |
| `SUI_PRIVATE_KEY` | `Script` only | A Bech32 `suiprivkey1…` key, read through `Config.redacted` |

`Script.layerReadOnly` provides `ScriptReadOnly`, which has no signer at all —
a separate service key, so a script written to sign cannot silently build over a
layer that cannot. `Script.run` installs SIGINT and SIGTERM handlers, interrupts
the root fiber so finalizers run, writes one diagnostic line per failure to
stderr (stdout carries only what the script printed), and exits:

| Code | Means |
|---|---|
| 0 | success |
| 1 | a defect, or an unclassified failure |
| 2 | configuration: `ConfigError`, `NetworkMismatch`, the mainnet gate |
| 3 | unknown outcome: reconcile before sending anything else |
| 4 | nothing applied: safe to retry |
| 5 | applied and failed on chain: gas was charged, do not retry |
| 130 | interrupted |

## Testing

`sui-effect/testing` ships the in-memory `SuiCoreFake`, `layerTest(script)` (the
real `Sui` over the fake, so tests exercise the production high tier),
`layerExtensionTest(layer, script)` for an extension's own tests, and `SuiTest`
for driving the fake's state and reading back what it was sent. No test in this
repository touches the network, and neither should yours.

## Versions

| Package | Range | Tested against |
|---|---|---|
| `effect` | `>=4.0.0-rc.112 <4.1` | `4.0.0-rc.112` |
| `@mysten/sui` | `^2.28` (the first version whose BCS and gRPC round-trip `ValidDuring` and `Validity` expirations) | `2.30.0` |
| `@mysten/bcs` | `^2.1.1` | `2.1.1` |
| TypeScript | `5.9.x` | `5.9.3` |
| Bun | `1.4.x` | `1.4.2` |

`bun run check` is typecheck, build, tests and the extension template's own
check.

## For agents

`LLMS.md` ships in the package: every public export with its signature and the
error union its JSDoc states, plus every example verbatim. It is generated by
`bun run llms` and a test fails when it is stale. `AGENTS.md` is the short list
of invariants to read before the code, `DESIGN.md` the specification, and
`docs/extensions.md` the extension contract.

## License

MIT
