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

## Side by side

The same two tasks, once against the canonical `@mysten/sui` 2.30 SDK (a
gRPC client, the Core API, `Transaction`) and once against sui-effect. Both
sides are exercised in `test/examples.test.ts`, and this section is asserted
to be the literal text of the four files it quotes.

### Read

`examples/compare-read.sdk.ts`:

```ts
/**
 * Reads one Escrow object and an optional dynamic field on it, written
 * against the canonical 2.30 SDK: a gRPC client, the Core API, manual BCS.
 *
 * Compare with `examples/compare-read.effect.ts`. Both print identical
 * output for the same id.
 *
 * Run with `SUI_NETWORK=testnet ESCROW_ID=0x… bun examples/compare-read.sdk.ts`.
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { ObjectError } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const ESCROW_TYPE = `${PKG}::escrow::Escrow`
const EscrowBcs = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() })
// A note some escrows carry, keyed by the literal index 0. The key is a
// primitive `u64`, not a struct tag, so nothing here parses it as one.
const NOTE_NAME = { type: "u64", bcs: bcs.u64().serialize(0).toBytes() }

/** Reads the escrow at `id` plus its optional note. */
export const readEscrow = async (
  client: ClientWithCoreApi,
  id: string
): Promise<{ id: string; amount: string; note: string | undefined }> => {
  let object
  try {
    ;({ object } = await client.core.getObject({ objectId: id, include: { content: true } }))
  } catch (error) {
    // `getObject` throws rather than returning a value that says which of
    // "missing", "deleted" or "unreachable" happened; that three-way split
    // is `ObjectError.reason`, read by hand.
    if (error instanceof ObjectError) {
      if (error.reason === "notFound") throw new Error(`escrow ${id} does not exist`)
      if (error.reason === "deleted") throw new Error(`escrow ${id} was deleted`)
      throw new Error(`escrow ${id}: node could not say what happened to it`, { cause: error })
    }
    throw error
  }
  // No type parameters on this tag, so a plain string comparison is honest;
  // a generic type would need to be parsed and compared piece by piece,
  // which is what sui-effect's bridge does for every caller.
  if (object.type !== ESCROW_TYPE) {
    throw new Error(`${id} is a ${object.type}, not ${ESCROW_TYPE}`)
  }
  const { id: escrowId, amount } = EscrowBcs.parse(object.content)

  let note: string | undefined
  try {
    const { dynamicField } = await client.core.getDynamicField({ parentId: id, name: NOTE_NAME })
    note = bcs.u64().parse(dynamicField.value.bcs)
  } catch (error) {
    // Absence is normal here; only a reason other than "notFound"/"deleted"
    // is a real problem.
    if (!(error instanceof ObjectError) || error.reason === "unknown") throw error
  }

  return { id: escrowId, amount, note }
}

if (import.meta.main) {
  const id = process.env.ESCROW_ID
  if (!id) throw new Error("ESCROW_ID is required")
  const client = new SuiGrpcClient({
    network: (process.env.SUI_NETWORK ?? "testnet") as "testnet",
    baseUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443"
  })
  const escrow = await readEscrow(client, id)
  console.log(`${escrow.id} holds ${escrow.amount}, note: ${escrow.note ?? "none"}`)
}
```

`examples/compare-read.effect.ts`:

```ts
/**
 * Reads one Escrow object and its optional note through sui-effect.
 *
 * Compare with `examples/compare-read.sdk.ts`, which reads the same two
 * things with the canonical SDK client. Both print identical output.
 *
 * Run with `SUI_NETWORK=testnet ESCROW_ID=0x… bun examples/compare-read.effect.ts`.
 * Every failure this program can produce is in the generator's inferred error
 * type: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable` and
 * `DecodeError` (the last one is what a wrong Move type becomes, because
 * `getObject`'s tag check runs before a byte is parsed), plus `TransportError`
 * from both reads and, from the layer, `ConfigError` and `NetworkMismatch`.
 */
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect, Option } from "effect"
import { ObjectId, Sui, SuiSchema } from "../src/index.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)
// The note's value has no struct tag of its own, so its codec carries none;
// the key is a primitive `u64`, which is why nothing here reaches for
// `normalizeStructTag` on it.
const Note = SuiSchema.bcs(bcs.u64())
const NOTE_NAME = { type: "u64", bcs: bcs.u64().serialize(0).toBytes() }

/** The program itself, exported so a test can run it against the fake. */
export const program = Effect.gen(function*() {
  const sui = yield* Sui
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  // No `ObjectError.reason` switch and no manual type comparison: a missing
  // or deleted escrow and a wrong Move type are already three different tags
  // in the type this line returns.
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const field = yield* sui.getDynamicFieldOption(id, NOTE_NAME)
  const note = yield* Option.match(field, {
    onNone: () => Effect.void,
    onSome: (entry) => SuiSchema.decode(Note, entry.value.bcs)
  })
  yield* Console.log(`${escrow.id} holds ${escrow.content.amount}, note: ${note ?? "none"}`)
})

if (import.meta.main) {
  // Imported here rather than at the top so that a test can import `program`
  // without pulling a platform package into the test process.
  const { BunRuntime } = await import("@effect/platform-bun")
  BunRuntime.runMain(program.pipe(Effect.provide(Sui.layerConfig)))
}
```

### Write

`examples/compare-write.sdk.ts`:

```ts
/**
 * Claims an escrow through a PTB, written against the canonical 2.30 SDK.
 *
 * Compare with `examples/compare-write.effect.ts`, which does the same thing
 * through `Tx.run` and notes what that adds over this file. Both sign with
 * `SUI_PRIVATE_KEY` and print the created receipt's object id.
 *
 * Run with:
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/compare-write.sdk.ts
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { Keypair } from "@mysten/sui/cryptography"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { Transaction } from "@mysten/sui/transactions"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const RECEIPT_TYPE = `${PKG}::escrow::Receipt`
const EscrowBcs = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() })

// The scheme flag on a Bech32 key names one of three keypair classes;
// nothing else decodes it, and a fourth scheme has no keypair class at all.
const KEYPAIR_FOR: Record<string, undefined | ((secretKey: Uint8Array) => Keypair)> = {
  ED25519: Ed25519Keypair.fromSecretKey,
  Secp256k1: Secp256k1Keypair.fromSecretKey,
  Secp256r1: Secp256r1Keypair.fromSecretKey
}

/**
 * Reads the escrow, claims it, and returns the created receipt's object id.
 *
 * Builds, signs and executes as three explicit steps rather than the
 * one-call `signAndExecuteTransaction`, so this can run against an in-memory
 * client with no live network or signer behind it.
 */
export const claimEscrow = async (
  client: ClientWithCoreApi,
  escrowId: string,
  keypair: Keypair
): Promise<string> => {
  const { object } = await client.core.getObject({ objectId: escrowId, include: { content: true } })
  const { amount } = EscrowBcs.parse(object.content)

  const tx = new Transaction()
  tx.setSenderIfNotSet(keypair.toSuiAddress())
  tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(escrowId), tx.pure.u64(amount)] })
  const bytes = await tx.build({ client })
  const { signature } = await keypair.signTransaction(bytes)

  const result = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, objectTypes: true }
  })
  const digest = (result.Transaction ?? result.FailedTransaction).digest
  await client.core.waitForTransaction({ digest })

  if (result.$kind === "FailedTransaction") {
    const { error } = result.FailedTransaction.status
    if (error?.$kind === "MoveAbort") {
      const { abortCode, cleverError } = error.MoveAbort
      throw new Error(`claim aborted: code ${abortCode}${cleverError?.constantName ? ` (${cleverError.constantName})` : ""}`)
    }
    throw new Error(`claim failed: ${error?.message}`)
  }

  // Effects list every changed object by id; only the `objectTypes` join
  // says which one is the receipt. sui-effect's `expectCreated` is this join,
  // plus a check that exactly one match exists.
  const { changedObjects } = result.Transaction.effects
  const created = changedObjects.find(
    (change) => change.idOperation === "Created" && result.Transaction.objectTypes[change.objectId] === RECEIPT_TYPE
  )
  if (created === undefined) throw new Error(`claim applied (${digest}) but created no ${RECEIPT_TYPE}`)
  return created.objectId
}

if (import.meta.main) {
  const escrowId = process.env.ESCROW_ID
  const key = process.env.SUI_PRIVATE_KEY
  if (!escrowId || !key) throw new Error("ESCROW_ID and SUI_PRIVATE_KEY are required")
  const parsed = decodeSuiPrivateKey(key)
  const fromSecretKey = KEYPAIR_FOR[parsed.scheme]
  if (!fromSecretKey) throw new Error(`${parsed.scheme} has no keypair class here (use a remote signer)`)
  const client = new SuiGrpcClient({
    network: (process.env.SUI_NETWORK ?? "testnet") as "testnet",
    baseUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443"
  })
  console.log(await claimEscrow(client, escrowId, fromSecretKey(parsed.secretKey)))
}
```

`examples/compare-write.effect.ts`:

```ts
/**
 * Claims an escrow through `Tx.run`, sui-effect's write path.
 *
 * Compare with `examples/compare-write.sdk.ts`, which does the same thing
 * against the canonical SDK client. Both sign with `SUI_PRIVATE_KEY` and
 * print the created receipt's object id.
 *
 * What `Tx.run` adds over the SDK file: a default expiration bounded to the
 * current epoch, a journal entry written before the first execute so a crash
 * mid-flight leaves a record, resending the identical signed bytes rather
 * than rebuilding on a transient failure, `reconcile` when a submission's
 * outcome is unknown, and a sender lock so two concurrent claims from one
 * address cannot pick the same gas coin. What it costs is the Effect
 * vocabulary below.
 *
 * Run with:
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/compare-write.effect.ts
 */
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect } from "effect"
import { ObjectId, SuiSchema } from "../src/index.ts"
import { Script } from "../src/script.ts"
import { Tx } from "../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)

/**
 * The program itself, exported so a test can run it against the fake. Every
 * failure it can produce is in the generator's inferred error type, with no
 * handling lines anywhere in this file: `ObjectNotFound`, `ObjectDeleted`,
 * `ObjectUnavailable`, `DecodeError`, `TransportError`, `BuildError`,
 * `SimulationFailed`, `SigningError`, `PolicyDenied`, `NotApplied`,
 * `JournalError`, `UnexpectedEffects`, `ExecutionFailed`, `SubmissionUnknown`,
 * plus `ConfigError` and `NetworkMismatch` from the layer.
 */
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

### What differs

- **Absence.** The SDK throws `ObjectError` and the reason (`notFound`,
  `deleted`, `unknown`) is read off the caught value by hand; sui-effect's
  `getObject` fails with `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable`,
  three separate tags a caller can `catchTag` without an `if` chain.
- **Wrong type.** The SDK compares `object.type` itself, and only gets away
  with a plain string equality because this particular type has no type
  parameters; a generic Move type would need the same piecewise comparison
  sui-effect's bridge (`typeMatches`) already runs inside every `getObject`.
- **BCS.** Both sides hand a `BcsType` to a struct; the SDK calls `.parse`
  itself, sui-effect calls it once, inside `getObject`, after the type check
  above has already passed.
- **Signing.** Both decode `SUI_PRIVATE_KEY` and dispatch on the scheme flag
  to the matching keypair class; sui-effect's version is `Signer.fromConfig`,
  one call, done once in `src/services/Signer.ts` rather than in every script.
- **Effects.** The SDK inspects `$kind`, `status.error` and joins
  `changedObjects` against `objectTypes` by hand to find the created object;
  sui-effect's `expectCreated(type)` is that join, plus a check that exactly
  one match exists, as a single call on `Executed`.
- **What sui-effect adds that neither SDK file has:** a default expiration
  bounded to the current epoch, a journal entry written before the first
  execute, resending identical signed bytes instead of rebuilding on a
  transient failure, `reconcile` when a submission's outcome is unknown, and
  a sender lock so two concurrent writes from one address cannot pick the
  same gas coin.
- **What it costs.** The sui-effect files import `effect` and run inside
  `Effect.gen`; a reader who does not already know Effect's vocabulary
  (`Effect.fn`, `catchTag`, `Option.match`, `yield*`) has that to learn before
  either file is legible.

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
