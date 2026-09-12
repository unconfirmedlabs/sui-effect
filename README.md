# @unconfirmed/sui-effect

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
bun add @unconfirmed/sui-effect
bun add -d effect@4.0.0-rc.112 @mysten/sui@2.30.0
```

`effect` and `@mysten/sui` are peer dependencies: one copy of each per process,
or `Context.Service` identities and `instanceof` checks stop matching. The
`effect` peer is pinned **exactly** to `4.0.0-rc.112`, because rc.113 renamed
`Config.nonEmptyString`, `Config.string` and `Config.redacted` to
`Config.NonEmptyString`, `Config.String` and `Config.Redacted`, and neighbouring
release candidates are not interchangeable.

A **library** built on sui-effect puts all three in its own
`peerDependencies` **and** `devDependencies`, never in `dependencies`; see
`examples/extension-template/README.md`.

## A complete script

```ts
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "@unconfirmed/sui-effect"
import { Script } from "@unconfirmed/sui-effect/script"
import { Tx } from "@unconfirmed/sui-effect/tx"

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
batch reads chunked to 50 and checked for missing or duplicated ids — per-item
`Result` from `getObjects`, first-error-wins from `getObjectsOrFail` — pagination
as `Stream`, one lock per sender so two transactions from one address cannot
pick the same gas coin, and the chain's own clock. A Move type with no type
arguments matches every instantiation of it, wherever a type is compared, so one
codec covers a generic Move type and the object keeps its own instantiated type. It carries the `SuiCore` it
was built over as `sui.core`, which is why every `Tx.*` function needs only
`Sui`.

## The transaction lifecycle

`Tx` is the lifecycle as functions — `build`, `sign`, `cosign`, `sponsored`,
`submit`, `reconcile`, `run`, `reconcileAll` — each with a closed error union
and `R = Sui`. `Tx.run` holds the sender lock from build through submit, builds
(which always simulates before anything is signed — the SDK's resolver does it
when there is anything to resolve, and `Tx.build` runs one explicitly when
there is not, so a transaction that would abort never gets signed),
signs, journals the signed bytes before the first execute, re-sends the
identical bytes — never a rebuild — on a retryable transport failure or a
timeout, waits for the execution to be visible to reads before it releases the
lock, and if it still does not know what happened, reconciles: `Executed`,
`ExecutionFailed`, `NotApplied { evidence }`, or `SubmissionUnknown` carrying
the bytes. A `TransportError` never escapes once bytes may have been sent —
from `submit`, and from `reconcile` and `reconcileAll` too. `Signer` is a
value, not a service, so one process can hold two credentials; `SubmitConfig`
and `Journal` are `Context.Reference`s with working defaults, so none of this
needs wiring, and `@unconfirmed/sui-effect/journal` swaps the memory journal for a durable
one over `KeyValueStore`.

**`NotApplied` is hard to earn, on purpose.** Saying a transaction never applied
tells the documented retry idiom to send the caller's intent again, so there are
exactly two kinds of evidence and both are checked twice over. `"expired"`
requires the epoch (or timestamp) bound to be observed as passed, then a
`getTransaction` miss, then — after `SubmitConfig.reconcileRecheck` — both
again; a single observation is `SubmissionUnknown`, and
`SubmitConfig.expiryEvidence: "never"` turns the rule off for a deployment
behind a mixed-node load balancer. `"inputConsumed"` requires a *different*
transaction's **own effects** to report that it took a pinned object at exactly
the version the bytes pinned: reconcile follows the live object's
`previousTransaction` — which names the latest mutation, not the consumer of the
version in question — to that transaction and reads `inputVersion` off its
`changedObjects`. There is no "the object at version `v + 1`" rule, because Sui
stamps every output with the transaction's **Lamport version**, `max(input
versions) + 1`, so a coin read alongside a newer gas object jumps from version 4
to 6,436,928 and version 5 never existed. Every pinned reference — owned inputs
and gas coins alike — is tried before reconcile gives up.

**In practice that means `SubmissionUnknown`, not `NotApplied`, for almost
every stuck submission** whose PTB touched a shared object or an owned object
older than the gas coin. Plan an operator path or a `reconcileAll` at startup;
do not build a retry loop that expects `NotApplied { inputConsumed }`. Before
any of this, reconcile compares the chain the bytes were built for with
`sui.chainId` and refuses to reason across chains.

**A sponsored `Tx.run` needs both signatures.** When the gas owner is not the
sender, pass `sponsor`: `Tx.run(recipe, { signer, gasOwner, sponsor })`. Without
it the run fails with `SigningError` before anything is built, because one
signature on sponsored bytes is something a validator rejects outright. Two
parties that cannot both sign in one process use `build`, `sign`, `cosign` and
`submit` directly.

When the recipe sets no expiration, `Tx.build` sets one: `ValidDuring` bounded
to the current epoch and the next, carrying the chain identifier as a replay
guard. Two epochs is what the validator rule allows for a transaction with no
address-owned inputs — a PTB over shared objects, or any sponsored transaction —
and the chain field is enforced, so bytes signed for testnet cannot land on
mainnet. There is deliberately no wall-clock bound: every Sui network refuses a
transaction that carries one today. `SubmitConfig.validFor` adds one for the day
that changes.

## Extensions

A downstream SDK is an extension: an Effect service built on `Sui` and `Tx`
whose layer requires `Sui` and nothing it could have built itself, whose
contributions to a transaction are recipe fragments consumers compose into one
programmable transaction, whose signers are parameters, and whose Promise face
is derived — not hand-maintained — by `SuiExtension.fromService`, so a consumer
with an SDK client writes `client.$extend(escrow(options))` and then plain
`await`s, with the same tagged error instances on rejection.
**[`docs/extensions.md`](docs/extensions.md) is the contract**, and
`examples/extension-template/` is a copyable package that implements it — it
ships inside the published package, so
`node_modules/@unconfirmed/sui-effect/examples/extension-template/` is there to copy without
a checkout.

Four things an extension author should know before reading the guide. A layer
may require `Sui | SuiCore` and must provide everything else itself, including
another extension's service — the guide's "composing extensions" section is that
pattern. A Promise face's **synchronous** members (recipe builders, a package
id) are real only once the runtime exists, so either `await client.<name>.$ready()`
once or register with `warm`; calling one before that fails with
`ExtensionNotReady` rather than returning a Promise the type does not mention
(`Effect` and `Stream` members work cold, as Promises and as async iterables).
Every registration on one client **shares one `Sui`**, and therefore one
sender-lock map, so two extensions never select gas for the same address at
once; `$dispose()` releases that shared base only when the last registration on
the client is disposed, and it is not final — the next call builds a fresh one.
And `SuiGraphQL` is sui-effect's tag over the SDK's `SuiGraphQLClient` — one
client shared by every extension that reads GraphQL; sui-effect wraps no GraphQL
API of its own.

## Errors

Every failure is one of these, every one is a `Schema.TaggedError`, and there is
no error inheritance to match on.

| Tag | Fields | Means |
|---|---|---|
| `TransportError` | `method`, `retryable`, `status?`, `cause` | The request did not reach a usable answer. Inside `Tx.submit` a timed-out `executeTransaction` lands here with `retryable: true` and `status: "DEADLINE_EXCEEDED"`; anywhere else `Effect.timeout` produces Effect's own `TimeoutError`, which is not part of this taxonomy |
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
| `JournalError` | `cause` | The journal could not be read or written. It escapes `Tx.submit` only from the write that happens **before** the first send; after the network has answered, a failed write is logged and the answer stands |
| `UnexpectedEffects` | `digest`, `expected`, `found` | The effects did not contain what the caller expected. Outcome `applied` and exit 5: it comes from an `Executed`, so the transaction ran and gas was charged; only the receipt is missing |
| `GraphQLUnavailable` | `method`, `reason` | The GraphQL endpoint an extension needs is not usable. What `SuiGraphQL.layerUnavailable` rejects every call with |
| `ExtensionNotReady` | `extension`, `member` | A synchronous member of a Promise face was called before its runtime existed: `await client.<name>.$ready()`, or register with `warm` |

`ExecutionReason` mirrors the SDK's `ExecutionError` variant for variant, with
`MoveAbort.abortCode` as a `bigint` and clever-error constant names decoded.
`SuiError.isRetryable`, `SuiError.outcome`, `SuiError.describe` and
`SuiError.toJson` are the four helpers every repo otherwise hand-rolls;
`outcome` puts every failure on the `"applied" | "not_applied" | "unknown"`
axis, and an extension error may declare its own. An error that is neither a tag
above nor declares an `outcome` is *unclassified*: `outcome` answers `"unknown"`,
because an unrecognised tag is no evidence that nothing happened, and
`Script.exitCode` exits 1 rather than 3, because it is no evidence that anything
was sent either. Declare `outcome` on every error your extension defines.

## Scripts

`Script.layer` reads the environment:

| Variable | Required | Meaning |
|---|---|---|
| `SUI_NETWORK` | yes, no default | `mainnet`, `testnet`, `devnet`, `localnet` or your own |
| `SUI_ALLOW_MAINNET` | only for mainnet | `1` or `true`; a script that means mainnet has to say so twice |
| `SUI_RPC_URL` | no | The gRPC endpoint; defaulted per known network |
| `SUI_PRIVATE_KEY` | `Script` only | A Bech32 `suiprivkey1…` key, read through `Config.redacted`. A key that does not decode fails with one fixed sentence and no cause: the Bech32 decoder quotes the whole input it rejected, so nothing derived from it is ever printed |

`Script.layerReadOnly` provides `ScriptReadOnly`, which has no signer at all —
a separate service key, so a script written to sign cannot silently build over a
layer that cannot. `Script.run` installs SIGINT and SIGTERM handlers, interrupts
the root fiber so finalizers run, writes one diagnostic line per failure to
stderr, and exits. stdout carries only what the script itself printed: the
logger is bound to stderr for the whole run, so an `Effect.log` anywhere in the
call tree cannot corrupt the output. On every non-zero exit the unresolved
entries of the journal the script ran with are printed too, so a script killed
or failed mid-submit still leaves the digest and the bytes. A second SIGINT is
ignored on purpose — the first one is what lets the finalizers that record those
bytes finish.

| Code | Means |
|---|---|
| 0 | success |
| 1 | a defect, or an unclassified failure |
| 2 | configuration: `ConfigError`, `NetworkMismatch`, `SchemaError`, the mainnet gate |
| 3 | unknown outcome: reconcile before sending anything else |
| 4 | nothing applied: safe to retry |
| 5 | applied on chain: `ExecutionFailed` (gas charged) or `UnexpectedEffects` (it ran; the receipt is missing) |
| 130 | interrupted, with nothing outstanding in the journal |

A timeout or an interrupt asks the journal: with an unresolved submission in it
the exit is 3, not 4 or 130, because an `Effect.timeout` wrapped around a
submission interrupts it from the outside and the bytes may be on the wire.

## Testing

`@unconfirmed/sui-effect/testing` ships the in-memory `SuiCoreFake`, `layerTest(script)` (the
real `Sui` over the fake, so tests exercise the production high tier),
`layerExtensionTest(layer, script)` for an extension's own tests, and `SuiTest`
for driving the fake's state and reading back what it was sent. No test in this
repository touches the network, and neither should yours.

## Versions

| Package | Range | Tested against |
|---|---|---|
| `effect` | `4.0.0-rc.112` (exact) | `4.0.0-rc.112`, in CI |
| `@mysten/sui` | `^2.28` (the first version whose BCS and gRPC round-trip `ValidDuring` and `Validity` expirations) | `2.29.0` and `2.30.0`, both in CI; `2.30.0` is the pinned devDependency |
| `@mysten/bcs` | `^2.1.1` | `2.1.1` |
| TypeScript | `5.9.x` to build | `5.9.3` |
| Bun | `1.4.x` | `1.4.2` |

The SDK row is a matrix, not a hope: CI builds, typechecks and runs the suite
against `@mysten/sui` 2.29.0 and 2.30.0, which are the versions consumers pin
today. The `effect` row is a matrix of one, and it is exact on purpose: rc.113
renamed three `Config` constructors this package calls at four sites
(`Script.ts`, `Signer.ts`, `SuiCore.ts`, `SuiGraphQL.ts`), so widening the range
means supporting both spellings and proving the wider one in CI.

**Consumers on TypeScript 7 (`tsgo`) are supported.** The shipped `.d.ts` needs
nothing from the old compiler. The `prepare` script here
(`effect-language-service patch`) is a library concern — it patches the checker
this repository develops against — and should not be copied into a consumer or
an extension package.

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
