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
bun add -d effect@4.1.1 @mysten/sui@2.38.0
```

`effect` and `@mysten/sui` are peer dependencies: one copy of each per process,
or `Context.Service` identities and `instanceof` checks stop matching. The
`effect` peer is `>=4.1.1 <4.2`: the stable 4.1.x line. 4.1.1 is the floor
because 4.1 made `KeyValueStore.keys` part of every store, which the durable
journal relies on; 0.3.x of this package is the line for 4.0.x. Release
candidates are not supported; 0.2.x of this package is the line for
`4.0.0-rc.112`.

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

That is the program in `examples/script-claim.ts`, written here against the
package's subpaths where the file imports `../src`; a test asserts the two agree
line for line and runs the file against the in-memory fake. Every failure it can
produce is in the generator's inferred error type and has its own exit code,
with no handling lines anywhere.

## Map

| Part | Import | One line |
|---|---|---|
| [The two tiers](#the-two-tiers) | `@unconfirmed/sui-effect` | `Sui` for reads (positional arguments, decoded content, `Option`, `Stream`); `SuiCore`, the SDK's Core API one-to-one (the SDK's options objects) |
| [The transaction lifecycle](#the-transaction-lifecycle) | `@unconfirmed/sui-effect/tx` | `Tx.run`, or `build` / `sign` / `cosign` / `submit` / `reconcile` by hand; `fromBytes` / `attach` for a sponsor; `resubmit`; `Signer` values; `Verify` |
| [`SubmitConfig`](#submitconfig) | `@unconfirmed/sui-effect/tx` | Every lifecycle decision, with defaults, overridable per effect or per layer |
| [Fold your coins](#fold-your-coins) | `@unconfirmed/sui-effect/tx` | Move coin objects into the address balance, which pays gas by default; `Tx.sendFunds` |
| [Declared intents](#declared-intents) | `@unconfirmed/sui-effect/tx`, `/gate` | `Intent` claims checked against the simulation in code; `Tx.verify`; an optional semantic screen (`Gate`, Jev) |
| [The journal](#the-journal) | `@unconfirmed/sui-effect/journal` | The record of signed bytes; in memory by default, durable over a `KeyValueStore` |
| [Errors](#errors) | `@unconfirmed/sui-effect` | One flat tagged error per failure, `SuiError.outcome` and the exit codes |
| [Scripts](#scripts) | `@unconfirmed/sui-effect/script` | `Script.run`: config from the environment, signals, stderr diagnostics, exit codes |
| [Extensions](#extensions) | `@unconfirmed/sui-effect/extension` | A downstream SDK as an Effect service with a derived Promise face |
| [Metrics and tracing](#metrics-and-tracing) | — | The span attributes and the `sui_effect_*` metrics, whose names are a public contract |
| [Testing](#testing) | `@unconfirmed/sui-effect/testing` | The real `Sui` over an in-memory fake; no network |

[Side by side](#side-by-side), at the end, is one read and one write against the
plain SDK and against this package.

## The two tiers

`SuiCore` is the mechanical tier: a one-to-one Effect wrap of the SDK's
`ClientWithCoreApi`, with every transport method present, the SDK's `Include`
generics preserved, every call cancellable through the Effect's `AbortSignal`,
every failure mapped into one tagged error by one mapper, a span per method, and
retries on transient transport failures for reads only — each attempt bounded
by `requestTimeout` (30 s by default; `SUI_RPC_TIMEOUT` under `layerConfig`,
`"Infinity"` to turn it off), because the SDK's own `timeout` only sets a gRPC
header and a hung node would otherwise hang a read forever. Reach for it when you
need a field or a method the tier above does not expose, and through
`core.use(client => …)` when an upstream package wants the client object itself.

`Sui` is the opinionated tier over it, and is what application and extension
code reads through: fixed include sets, BCS content decoded through `Schema`
with the object's Move type checked first, `Option` where absence is normal,
batch reads chunked to 50 and checked for missing or duplicated ids — per-item
`Result` from `getObjects`, first-error-wins from `getObjectsStrict` — pagination
as `Stream` (owned objects, dynamic fields, coins, balances, events and
transactions; the last yields a `Result` per entry, because a transaction that
failed on chain is an ordinary line of a history), one lock per sender so two transactions from one address cannot
pick the same gas coin, and the chain's own clock. A Move type with no type
arguments matches every instantiation of it, wherever a type is compared, so one
codec covers a generic Move type and the object keeps its own instantiated type. It carries the `SuiCore` it
was built over as `sui.core`, which is why every `Tx.*` function needs only
`Sui`.

**`Sui` members are positional; `SuiCore` members take the SDK's options
object.** `sui.getObject(id, { schema })` and `sui.getBalance(owner, coinType)`,
but `sui.core.getObject({ objectId, include })`. The SDK habit,
`sui.getObject({ objectId })`, does not typecheck.

**The SDK's `listX` is `sui.streamX`**: `listOwnedObjects` → `streamOwnedObjects`,
`listCoins` → `streamCoins`, `listBalances` → `streamBalances`,
`listDynamicFields` → `streamDynamicFields`, `listEvents` → `streamEvents`,
`listTransactions` → `streamTransactions`. The two ledger streams also take
`after`/`before`, come as pages (`streamEventPages`, `streamTransactionPages`:
`{ items, endCursor }`, so an indexer commits its cursor with its rows), and
have never-ending `tail…` forms that poll, retry from the last cursor, and keep
a filtered cursor ahead of a pruning node (sound only against one sticky node:
behind a load-balanced endpoint that move can skip matches). A transaction
`function` filter must be fully qualified (`pkg::module::function`); the SDK
cannot page past the first page of a `pkg` or `pkg::module` filter, so the
streams refuse those up front, and one page of one is
`sui.core.listTransactions`.

**Ids from a user go through `.Strict`.** `Schema.decodeUnknownEffect(SuiAddress)`
pads (`"2"` is `0x…02`), which is right for a node and wrong for a recipient a
human typed; `SuiAddress.Strict` and `ObjectId.Strict` take exactly 64 hex
digits. `.normalize` is for a shorthand literal (`"0x6"`), `.make` for the
padded form. Reads that take a Move type (`getBalance`, `streamCoins`,
`getCoinMetadataOption`, `streamOwnedObjects({ type })`) and
`executed.balanceChange` accept a plain string; `CoinType.SUI` is the padded
SUI type.

## The transaction lifecycle

`Tx` is the lifecycle as functions — `build`, `sign`, `cosign`, `fromBytes`,
`attach`, `sponsored`, `gaslessStablecoinTransfer`, `sendFunds`, `planFold`,
`fold`, `foldCoins`, `submit`, `submitVia`, `verify`, `reconcile`, `resubmit`,
`recorded`, `run`, `reconcileAll` — each with a closed error union and `R = Sui`. Gas comes
from the payer's SUI **address balance** by default, and from coins only when
the balance cannot cover it ([Fold your coins](#fold-your-coins)). `Tx.run`
holds the sender lock for every build, and through submit only when the bytes
pin a versioned object (an owned input or a gas coin), builds
(which always simulates before anything is signed — the SDK's resolver does it
when it has a budget to choose, and `Tx.build` runs one explicitly whenever it
will not, on every transport, so a transaction that would abort never gets
signed),
signs, journals the signed bytes before the first execute, re-sends the
identical bytes — never a rebuild — on a retryable transport failure or a
timeout, waits for the execution to be visible to reads before it returns
(and releases the lock, when it holds one), and if it still does not know what happened, reconciles: `Executed`,
`ExecutionFailed`, `NotApplied { evidence }`, or `SubmissionUnknown` carrying
the bytes. `reconcile` and `reconcileAll` have no `TransportError` in their
unions at all, and none escapes `submit` once bytes may have been sent, with one
exception: a gRPC **`INVALID_ARGUMENT` on the first send**,
which is the node refusing the request outright (malformed bytes, or a
sponsored transaction carrying one signature). Nothing was executed, so
`Tx.submit` reports that error as it is rather than reconciling, because a
reconcile would go on to ask whether that digest is on chain — a question about
a transaction that was never sent — and settles the journal entry as
`NotApplied { evidence: "refused" }`. A refusal after a timeout or a retryable
failure is not that: the earlier send may have landed, so it reconciles.
`Tx.build` retries its resolver call on a retryable `TransportError`, the way
`SuiCore` retries a read, because nothing has been signed yet; a resolver
**refusal** — an input owned by someone else, a function that does not exist,
no coin to pay gas with — is a `BuildError` carrying the node's message, and a
budget over `SubmitConfig.maxGasBudget` is `PolicyDenied { rule: "maxGasBudget" }`. `Signer` is a
value, not a service, so one process can hold two credentials; `SubmitConfig`
and `Journal` are `Context.Reference`s with working defaults, so none of this
needs wiring (both have their own sections below). `SignatureScheme` is the
SDK's own type, so it follows the installed SDK (`"MLDSA65"` from 2.36).

**`Verify` checks a signature someone else made.**
`Verify.verifyTransactionSignature(bytes, signature, { address? })` and
`Verify.verifyPersonalMessageSignature(message, signature, { address? })` are
the Effect face of `@mysten/sui/verify`, with the client a zkLogin or multisig
check needs taken from `Sui`. They answer the public key; an invalid signature,
or one made by another address than `address`, is `SigningError`, and a check
that could not reach the node is `TransportError` — never a verdict. A sponsor
runs the first on the sender's signature before it co-signs.

**`Tx.gaslessStablecoinTransfer` builds Sui's canonical free stablecoin
transfer**, as a `Transaction#balance` intent consumed by
`0x2::balance::send_funds`. It neither talks to a sponsor nor forces zero gas:
the gRPC or GraphQL SDK resolver simulates the PTB, checks the network's current
protocol configuration and sets zero gas only when it qualifies.

```ts
const recipe = Tx.gaslessStablecoinTransfer({
  coinType,
  amount: 1_000_000n,
  recipient
})
const executed = yield* Tx.run(recipe, { signer })
```

The helper does not hardcode today's allowlist or 0.01 minimum. Both are
protocol policy, and the minimum is stored per token in base units; this API
cannot infer trustworthy decimals from a type string. `Tx.build`'s mandatory
simulation rejects an ineligible type or too-small amount before signing. An
application that already has verified coin metadata should validate its display
amount earlier for a better error message.

**`NotApplied` is hard to earn, on purpose.** Saying a transaction never applied
tells the documented retry idiom to send the caller's intent again, so there are
exactly two kinds of evidence and both are checked twice over. `"expired"`
requires the epoch (or timestamp) bound to be observed as passed, then a
`getTransaction` miss, then — after `SubmitConfig.reconcileRecheck` — both
again; a single observation is `SubmissionUnknown`, and
`SubmitConfig.expiryEvidence: "never"` turns the rule off for a deployment
behind a mixed-node load balancer. Positive evidence vetoes it — a pinned object
that names this very digest as its last mutation means it applied — and on gRPC
a node that has pruned into the transaction's validity window cannot prove a
miss, so the answer there is `SubmissionUnknown`; JSON-RPC and GraphQL cannot
report their history, so behind a pruning node on those set
`expiryEvidence: "never"`. `"inputConsumed"` requires a *different*
transaction's **own effects** to report that it took a pinned object at exactly
the version the bytes pinned: reconcile follows the live object's
`previousTransaction` — which names the latest mutation, not the consumer of the
version in question — to that transaction and reads `inputVersion` off its
`changedObjects`. There is no "the object at version `v + 1`" rule, because Sui
stamps every output with the transaction's **Lamport version**, `max(input
versions) + 1`, so a coin read alongside a newer gas object jumps from version 4
to 6,436,928 and version 5 never existed. Every pinned reference — owned inputs
and gas coins alike — is tried before reconcile gives up; a coin-reservation
ref in the gas payment (address-balance gas) pins no version and is skipped.

**In practice that means `SubmissionUnknown`, not `NotApplied`, for almost
every stuck submission** whose PTB touched a shared object or an owned object
older than the gas coin. Plan an operator path or a `reconcileAll` at startup;
do not build a retry loop that expects `NotApplied { inputConsumed }`. Before
any of this, reconcile compares the chain the bytes were built for with
`sui.chainId` and refuses to reason across chains.

**Re-sending a lost submission.** A `SubmissionUnknown` carries the signed
bytes, and sending identical bytes again is safe — one digest, one execution.
`Tx.resubmit(error)` does exactly that: it re-sends the same bytes, never a
rebuild, refuses when the journal already says `NotApplied`, and reconciles
instead when the journal says it executed, when the bytes name another chain or
when their window has closed. `Tx.reconcileAll({ resubmit: true })` at startup
re-sends every entry still unknown after reconciling, so a CLI that obeys
"reconcile before sending anything else" is not stuck for two epochs. A
first-send validator lock conflict ("already locked by a different
transaction") is rechecked three times before `Tx.submit` answers, and a
`SubmissionUnknown` from a send names that send's own error.

**`Tx.run` has a hook between signing and sending.** `onSigned(signed)` runs
inside the sender lock, after the last signature and before the first
`executeTransaction`, for the record the journal does not hold — a domain row
joining the digest to a batch, an outbox, an idempotency key. Failing it fails
the run with nothing sent; its error is `JournalError`, which is already in
`Tx.run`'s union and already means "the record could not be written and nothing
has gone out".

**Prepare, approve, then sign** (0.5.0). `Tx.prepare(recipeOrBuilt, { sender, intent? })`
is `Tx.run`'s front half without the signature: it builds (or, for bytes from
`Tx.fromBytes`, takes them as they are), simulates exactly those bytes, runs
`preflight` and the intent, and answers `{ built, simulation, verified? }` —
`built.gas` for the fee line (budget, price, payer, and whether it is paid from
the address balance, a coin reservation or coins), `simulation.created()`,
`transferred()`, `balanceChange(...)` for the rest, the same accessors an
`Executed` has. A wallet that signs straight after asking passes
`approve` to `Tx.run` instead: it is shown the same value after the checks and
before the first signature, refuses by failing with its own error (nothing
signed, nothing journalled), and runs under the sender lock only when the bytes
pin something. A signer with a session bound (`Signer.maxEpoch`) keeps the
build's window inside it.

```ts
const executed = yield* Tx.run(recipe, {
  signer,
  approve: (prepared) => askThePerson(prepared) // Effect<void, UserRejected>
})
```

**`Tx.submitVia(signed, send)` is the lifecycle when someone else submits.** A
relay or a sponsorship service that holds the only key allowed to talk to the
node gets the bytes from you; this keeps everything around that. It journals
`Signed` before calling `send`, calls it exactly once, turns the reply into an
`Executed` when it carries one (an SDK `TransactionResult`, a reduced envelope,
or a bare digest, in which case it asks the chain), reconciles an ambiguous
`send` failure with the full evidence rules, and journals the terminal answer.
A `send` error whose instance declares `outcome: "not_applied"` is taken at its
word and fails straight through.

**`Tx.reconcileAll()` returns only what was unresolved**, as a tagged union —
`{ _tag: "Executed", executed }`, `{ _tag: "ExecutionFailed", error }`,
`{ _tag: "NotApplied", error }`, `{ _tag: "SubmissionUnknown", error }`. A
digest that had already settled is not in it; `Tx.recorded(digest)` answers with
that entry (`Option<JournalEntry>`).

**A sponsored `Tx.run` needs both signatures.** When the gas owner is not the
sender, pass `sponsor`: `Tx.run(recipe, { signer, gasOwner, sponsor })`. Without
it the run fails with `SigningError` before anything is built, because one
signature on sponsored bytes is something a validator rejects outright. The
recipe is applied before any lock is chosen, so a gas owner it sets itself
(`Tx.sponsored` does) is known without `opts.gasOwner`.

**Two ways to sponsor.** `Tx.sponsored({ sender, gasOwner })` leaves the gas
payment empty: the sponsor's **SUI address balance** pays and no coin is
selected, so `Tx.run` never takes the sponsor's lock — one sponsor serves many
senders concurrently — and a sponsored transaction with no owned input pins
nothing, so it holds the sender's lock only for its build. That balance has to
cover the budget plus the SUI the bytes withdraw from it. The devnet and testnet
faucet (`requestSuiFromFaucetV3`) pays into the address balance; the localnet
faucet (V2) and most other funding pay coins, so a sponsor funded that way folds
them first (`Tx.foldCoins({ signer: sponsor })`); `Tx.build` checks before
signing and fails with `BuildError` when it falls short. A sponsored recipe
never uses `tx.gas`: with an empty payment the gas coin is empty, which the
build simulation does not show (the node mocks one) and execution fails on,
charging gas, so `Tx.build` refuses such bytes with `BuildError`. Use
`tx.coin({ balance, useGasCoin: false })` or `Tx.sendFunds({ ..., useGasCoin:
false })`, never `tx.splitCoins(tx.gas, ...)`. Without `Tx.sponsored`, `Tx.run(recipe, { signer, gasOwner,
sponsor })` pays from the sponsor's **coins**, and then the sponsor's lock is
held too, because two runs could pick the same coin.

**A sponsor service that only sees bytes** rebuilds nothing: `Tx.fromBytes(bytes)`
is a `Built` with the chain and expiration read off the bytes (other-chain bytes
refused), `Tx.attach(built, senderSignature)` verifies and adds the sender's
signature, then `Tx.cosign(signed, sponsor)` and `Tx.submit`. Two parties that
cannot both sign in one process use `build`, `sign`, `cosign` and `submit`
directly.

When the recipe sets no expiration, `Tx.build` sets one: `ValidDuring` bounded
to the current epoch and the next, carrying the chain identifier as a replay
guard. Two epochs is what the validator rule allows for a transaction with no
address-owned inputs — a PTB over shared objects, or any sponsored transaction —
and the chain field is enforced, so bytes signed for testnet cannot land on
mainnet. There is deliberately no wall-clock bound: every Sui network refuses a
transaction that carries one today. `SubmitConfig.validFor` adds one for the day
that changes.

## `SubmitConfig`

Every field is overridable, and one of them usually should be.
`SubmitConfig` is a `Context.Reference` with the spec's defaults, including a
`maxGasBudget` of **50 SUI** — a ceiling, not a budget, but far above what a
sponsor policy typically allows. Narrow it once, where the runtime is built:

```ts
program.pipe(SubmitConfig.with({
  maxGasBudget: Mist.make(1_000_000_000n), // 1 SUI
  lockSender: "always"                     // see below
}))
```

`SubmitConfig.with(overrides)` merges the overrides over the config **in
force** — an inner `with({ executeTimeout })` keeps an outer `maxGasBudget`
(before 0.4.0 it reset everything to the defaults) — and provides the whole
value, which is what a `Context.Reference` holds; `SubmitConfig.layer(overrides)`
spreads the defaults, as a `Layer`, for an application that sets its policy once
where the runtime is built. Durations take `Duration.Input`, so
`executeTimeout: "10 seconds"` typechecks. A budget over `maxGasBudget` fails
`Tx.build` with `PolicyDenied { rule: "maxGasBudget" }`.

`lockSender` is the other one worth a decision. The lock exists because two
concurrent builds from one address can pin the same gas coin or owned object
at the same version. Bytes that pin nothing — gas from the address balance,
inputs that are pure values, shared objects or balance withdrawals — cannot
race anything once they exist, so under the default, `"whenPinned"`, `Tx.run`
takes the lock for **every build** and keeps it through signing and submission
only when the built bytes pin something (an owned input, a gas coin, or a coin
reservation — the whole balance a `tx.gas` user's gas is drawn from, which is
why such a run also waits for the lock-free runs in flight before it builds);
address-balance transactions from one
sender are signed, sent and awaited concurrently (on localnet ten
`Tx.sendFunds` runs from one sender took 1,044 ms, against 8,069 ms under
`"always"`). The span attribute `sui.sender_lock` says which happened (`"held"`
or `"build"`). `"always"` is the rule before 0.4.0, the lock from build through
submit on every run; `"never"` takes none. `true` and `false` are still accepted
and mean `"always"` and `"never"`.

**Lock-free runs can overdraw.** Two of them can together withdraw more than
the balance holds, gas budgets counted in full. When the shortfall is there as
the bytes are submitted the node refuses them (`INVALID_ARGUMENT`, a
`TransportError`, journaled `NotApplied { evidence: "refused" }`); when it
arises in flight the node executes the one that overdraws as a failure
(`InsufficientFundsForWithdraw`, no gas charged), which is `ExecutionFailed`. A
flow that spends a balance down to zero sets `lockSender: "always"`, as above.

`gasPayment` decides an unset gas payment. `"preferAddressBalance"` (the
default) leaves it to the SDK resolver, which pays from the payer's SUI address
balance when that covers the budget and the transaction does not use `tx.gas`,
and from coins otherwise; the span attribute `sui.gas_payment` names the choice
(`"addressBalance"`, `"coinReservation"`, `"coins"`). `"requireAddressBalance"`,
for a wallet that wants the balance enforced, pins the payment to the balance
before the build and fails with `BuildError` when the balance cannot cover it
or a `tx.gas` user was paid with coins; and when an SDK intent (`tx.coin`,
`tx.balance` for SUI) the balance did not cover fell back to splitting
`tx.gas`, which is empty under an address-balance payment, the `BuildError`
names `Tx.foldCoins`. Across isolates (Workers, Durable
Objects), where a per-runtime semaphore is not a lock at all, that policy is
what makes a transaction with no owned input pin nothing whatever the balance
holds. `awaitVisibility` delays every return of `Tx.submit` either way — with
`lockSender: "never"` too — and that default is right: without it the caller's
next read can miss the object it just wrote.

The fields and their defaults: `expiration` (`"validDuring"`: the current epoch
and the next, plus the chain id), `validFor` (unset; no network accepts a
wall-clock bound yet), `maxGasBudget` (50 SUI), `preflight` (unset),
`lockSender` (`"whenPinned"`), `gasPayment` (`"preferAddressBalance"`), `resubmit` (exponential from 250 ms capped at 30 s,
jittered), `resubmitAttempts` (5), `executeTimeout` (60 s), `expiryMargin`
(30 s), `expiryEvidence` (`"epochThenMiss"`), `reconcileRecheck` (2 s),
`awaitVisibility` (`true`), `visibilityTimeout` (15 s) and `nonce` (a random
`u32` from Effect's `Random`).

## Fold your coins

Gas comes from the address balance by default, and an address balance has no
object version: a transaction paid from it, and drawing its funds from it,
pins nothing, cannot equivocate a coin, and runs beside the sender's other
transactions without holding the sender lock past its build. Coins arrive
anyway — the localnet faucet, a transfer, an exchange withdrawal — and folding
is how they get into the balance. Until then the resolver pays with coins and
everything still works; it is just serialized.

```ts
import { Console, Effect } from "effect"
import { Sui } from "@unconfirmed/sui-effect"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

declare const signer: Signer

export const fold = Effect.gen(function*() {
  const sui = yield* Sui
  // Reads only: the coins, the SUI address balance, the reference gas price.
  const plan = yield* Tx.planFold({ owner: signer.address })
  for (const batch of plan.batches) {
    // A preview: built and simulated, nothing signed.
    const built = yield* Tx.build(Tx.fold(batch), { sender: signer.address })
    const { effects } = yield* sui.simulate(built.bytes)
    yield* Console.log(batch.coinType, batch.coins.length, batch.gas, effects.gasUsed.computationCost)
  }
  // Plans again and runs every batch, SUI first: it pays for its own fold.
  const { executed } = yield* Tx.foldCoins({ signer })
  return executed.map((each) => each.digest)
})
```

`Tx.planFold({ owner, coinType?, maxCoinsPerTransaction? })` answers a
`FoldPlan`: `batches` of at most 500 coins each (one `MergeCoins`; a gas
payment takes at most 256), SUI first, and `skipped`, SUI dust worth less than
the cost of folding it. `Tx.fold(batch)` is one batch's recipe, and
`Tx.foldCoins({ signer })` plans for `signer.address` and runs every batch
through `Tx.run`, answering `{ plan, executed }`; it stops at the first batch
that fails, and calling it again re-plans from what is left. Given the `plan` a
person previewed (0.5.0), it runs that plan as is and calls `approve(prepared,
batch)` per batch; `Tx.foldMovement(batch, prepared.simulation)` is what the
fold moves from coins into the balance, which its balance changes — the net
gas only — do not show.

**SUI pays for its own fold**, so a coin-only account needs nothing first: the
batch is the gas payment and `0x2::coin::send_funds<SUI>` deposits the whole
gas coin, leaving no SUI coin at all. On localnet five 200-SUI faucet coins
folded in one transaction to zero coins and 1,000,003,939,506 MIST of address
balance, and 290 coins folded in one (a 0.155-SUI budget, net gas negative
from the storage rebates). Other coin types fold after SUI, paid from the SUI
just deposited.

**Faucets.** The localnet faucet (V2, `requestSuiFromFaucetV2`) pays coins, so
fold first; the devnet and testnet faucet (V3, `requestSuiFromFaucetV3`) pays
straight into the address balance.

**Send into a balance.** `Tx.sendFunds({ coinType?, amount, recipient })` is
the canonical transfer: `0x2::balance::send_funds<T>` of a `tx.balance(...)`,
drawn from the sender's balance when it covers the amount (no versioned input
at all) and from coins otherwise, and the recipient gets a balance rather than
a coin it would have to fold. Its `useGasCoin` stays `true` (the default) for
your own transactions — `false` makes every SUI coin an input and leaves none
to pay gas with on an account that has not folded — and is `false` under
`Tx.sponsored`, where the gas coin is the sponsor's. In a recipe of your own,
prefer `tx.coin({ balance })` and `tx.balance(...)` to
`tx.splitCoins(tx.gas, ...)`: anything that uses `tx.gas` pays gas from a coin
(or a coin reservation) rather than from the balance.

```ts
const sent = yield* Tx.run(Tx.sendFunds({ amount: 1_000_000_000n, recipient }), { signer })

const paid = yield* Tx.run((tx) => {
  tx.transferObjects([tx.coin({ balance: 1_000_000_000n })], recipient)
}, { signer })
```

A wallet that wants the balance enforced sets
`SubmitConfig.gasPayment: "requireAddressBalance"`: an unfolded account's
transactions then fail with `BuildError` naming `Tx.foldCoins` instead of
quietly paying with coins. And a flow that spends its balance down to zero sets
`lockSender: "always"`, because lock-free runs from one sender can together
overdraw it (`SubmitConfig`, above).

## Declared intents

A transaction can say what it is for, and `Tx.run` will refuse to sign one that
does more. An `Intent` is one sentence plus exact claims:

```ts
import { Effect } from "effect"
import { CoinType, type SuiAddress } from "@unconfirmed/sui-effect"
import { type Intent, type Signer, Tx } from "@unconfirmed/sui-effect/tx"

declare const signer: Signer
declare const coldWallet: SuiAddress

const intent: Intent = {
  summary: "Send 250 SUI to my cold wallet.",
  author: "user",
  claims: {
    outflows: [{ coinType: CoinType.SUI, max: 250_000_000_000n }],
    recipients: [coldWallet],
    objects: []
  }
}

const sent = Tx.run(Tx.sendFunds({ amount: 250_000_000_000n, recipient: coldWallet }), { signer, intent })
```

The claims are compared with the simulated effects **in code**, deny by default:
a coin that is not claimed may not decrease, an address that is not claimed may
not receive anything, and an object that is not claimed may not leave the
sender. Gas is never an outflow, whether a gas coin or the address balance paid
it; anything else drawn from the address balance is. Every refusal is a
`PolicyDenied` whose `rule` says which check (`intent.outflow`,
`intent.recipient`, `intent.object`, ...), before anything is signed. `Tx.run`
runs the check on the same simulate as `SubmitConfig.preflight`, where it signs:
under the sender lock only when the bytes pin something.

`Tx.verify(built, intent)` is the same check for the explicit lifecycle and
answers a `Verified`, which `Tx.sign` takes as it is; the explicit lifecycle is
not gated otherwise. For bytes somebody else built — a dapp's —
`Intent.fromSimulation(simulation, built, { summary, author: "dapp" })` is the
exact claims the simulation implies, to show a person and then verify:

```ts
import { Effect } from "effect"
import { Sui } from "@unconfirmed/sui-effect"
import { Intent, Tx } from "@unconfirmed/sui-effect/tx"

declare const dappBytes: Uint8Array
declare const dappSays: string

const review = Effect.gen(function*() {
  const sui = yield* Sui
  const built = yield* Tx.fromBytes(dappBytes)
  const claims = Intent.fromSimulation(yield* sui.simulate(built.bytes), built, {
    summary: dappSays,
    author: "dapp"
  })
  // ...show `claims` and ask...
  return yield* Tx.verify(built, claims)
})
```

The sentence is read by a **screen**, when one is configured.
`@unconfirmed/sui-effect/gate` provides one that asks
[Jev](https://docs.typesafe.ai), TypeSafe's System One model, whether each
simulated effect and each claim — rendered as words, never as hex or base units
— is something the sentence describes:

```ts
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { layerJevConfig } from "@unconfirmed/sui-effect/gate"

// TYPESAFE_API_KEY from the environment. `requireIntent` is the setting for a
// wallet an agent drives: `Tx.run` signs nothing that declares no intent.
const gate = layerJevConfig({ requireIntent: true }).pipe(Layer.provide(FetchHttpClient.layer))
```

The screen answers in probabilities and decides nothing; the thresholds that
turn them into `intent.effect`, `intent.claim`, `intent.vague` and
`intent.injection` are fields of `Gate`, in code. A screen that is down denies
(`gate.unavailable`) unless `onUnavailable: "unscreened"`, and an unscreened
verdict always says so. `Gate.with` merges over the gate in force, so it never
drops a layer's screen.

What it does not prove: a simulation is one execution against the state the
node had, so a package that branches on a shared object can still behave
differently when the bytes land.

## The journal

`Journal` is the record of every signed transaction: `Tx.submit` writes a
`Signed` entry before the first send and the terminal answer — `Executed`,
`Failed`, `NotApplied` — when it has one, or `Unknown` with the bytes when it
does not. The default is process-wide memory, which is enough for a script:
`Script.run` prints the unresolved entries on every non-zero exit. A test that
submits provides `Journal.layerMemory` so it sees only its own entries.

A long-lived service provides a durable one from `@unconfirmed/sui-effect/journal`,
whose functions are module exports rather than statics on `Journal`:

```ts
import { Layer } from "effect"
import { KeyValueStore } from "effect/persistence"
import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"

// `layerFileSystem` needs a platform's `FileSystem` and `Path` (e.g. `BunServices.layer`).
const journal = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
  Layer.provide(KeyValueStore.layerFileSystem("./journal"))
)
```

`onUnresolved: "fail"` refuses to build while the store holds unsettled
entries; `"ignore"` builds and leaves them for `Tx.reconcileAll()`, the
explicit startup call. Each entry is one key, and the journal lists them through
`KeyValueStore.keys` — which every store has had to implement since effect 4.1 —
so a custom store must implement `keys`, and several processes writing one
prefix do not lose each other's entries. Listing is a scan, so a service that
runs for months calls `pruneSettled(before)`, which deletes settled entries
recorded before the cutoff and never an unresolved one. `makeKeyValueStore(store)`
is the same journal as a plain `JournalService`.

**A script with a durable journal** gives it to `Script.run` in
`options.layer` (`Layer.merge(Script.layer, journal)`; the option accepts any
error type) or provides it inside the program — `Script.run` finds the journal
either way, and on a failure reports only the entries this run wrote. Sweep
before sending anything new: `yield* Tx.reconcileAll({ resubmit: true })` first
in the program. `examples/recipes/durable-journal-script.ts` (quoted in
`LLMS.md`) is that script, tested.

A store written by 0.3 reads with no migration: its old `index` key is ignored,
left in place and no longer maintained. **Rolling back is not safe as is.** 0.3
lists unresolved entries only through that index, so a `Signed` or `Unknown`
entry 0.4 wrote is invisible to a 0.3 `listUnresolved`, `Tx.reconcileAll` and
`onUnresolved: "fail"` (only `Tx.recorded(digest)` finds it), and a 0.3 reader
cannot decode `NotApplied { evidence: "refused" }`, which 0.4 writes. Before
rolling back, or while 0.3 and 0.4 processes share a store, drain it with
`Tx.reconcileAll()` on 0.4 (or settle the entries by hand) and delete the
`"refused"` entries.

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

Five things an extension author should know before reading the guide. A layer
may require `Sui | SuiCore` and must provide everything else itself, including
another extension's service — the guide's "composing extensions" section is that
pattern. A Promise face's **synchronous** members (recipe builders, a package
id) are real only once the runtime exists, so either `await client.<name>.$ready()`
once or register with `warm`; calling one before that fails with
`ExtensionNotReady` rather than returning a Promise the type does not mention
(`Effect` and `Stream` members work cold: a cold call is a callable `Promise`
that is also an `AsyncIterable` — applying a cold recipe builder's result
throws `ExtensionNotReady`, a cold plain value throws on `.length`,
`.startsWith` and the like — and its rejection is pre-handled so an un-awaited
one cannot abort the process). An `Effect<Option<A>>` member resolves to
`A | undefined` on the face. A namespace member may be an `interface` — the
face maps it by type, not by declaration style — while a class instance with
`Effect`-returning methods is declared `SuiExtension.Leaf<T>` and built with
`SuiExtension.leaf(value)`.
Every registration on one client and chain id **shares one `Sui`** (one
transport, one chain-id read), and the **sender lock is process-wide** — every
registration on every client takes the same lock per address — so two
extensions never select gas for the same address at once; `$dispose()` releases
the shared base only when the last registration on the client is disposed, and
it is not final — the next call builds a fresh one. A Promise consumer sets the
lifecycle on the registration — `submit` (the `SubmitConfig.with` overrides)
and `journal` (e.g. a durable one) — and settles that journal at startup with
`client.<name>.$reconcileAll()`.
And `SuiGraphQL` is sui-effect's tag over the SDK's `SuiGraphQLClient` — one
client shared by every extension that reads GraphQL; sui-effect wraps no GraphQL
API of its own.

## Errors

Every failure is one of these, every one is a `Schema.TaggedError`, and there is
no error inheritance to match on.

| Tag | Fields | Means |
|---|---|---|
| `TransportError` | `method`, `retryable`, `status?`, `cause` | The request did not reach a usable answer; a node reply that did not decode carries a `DecodeError { kind: "shape" }` as its `cause`. Inside `Tx.submit` a timed-out `executeTransaction` lands here with `retryable: true` and `status: "DEADLINE_EXCEEDED"`; anywhere else `Effect.timeout` produces Effect's own `TimeoutError`, which is not part of this taxonomy |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | `objectId`, `version?` | The three `ObjectError.reason` values |
| `TransactionNotFound` | `digest` | No transaction with that digest is known |
| `NetworkMismatch` | `expected`, `actual` | The node is on another chain than the layer was built for |
| `DecodeError` | `objectId?`, `expectedType?`, `actualType?`, `kind`, `issue` | BCS content or a schema boundary did not decode. `kind` is `"type"` (the Move type was not the one expected — nothing was parsed, and the one a caller may answer with a 404), `"bytes"` (the BCS parse failed: a layout mismatch, never safe to swallow) or `"shape"` (a domain schema refused a parsed or JSON value). Branch on `kind`, never on `issue`, whose wording changes between releases |
| `SimulationFailed` | `reason`, `message`, `command?` | Simulation reported an execution failure. No gas charged |
| `ExecutionFailed` | `digest`, `reason`, `command?`, `effects` | Applied on chain and failed. Gas charged (none for `InsufficientFundsForWithdraw`, an overdrawn balance) |
| `SubmissionUnknown` | `digest`, `signed?`, `cause` | Bytes may have been sent; the outcome is unknown. Carries them, unless it came from reconciling a bare digest |
| `NotApplied` | `digest`, `evidence: "expired" \| "inputConsumed" \| "refused"` | Provably never applied, and never will be. `refused` is a node's `INVALID_ARGUMENT` on the first send, or a `submitVia` sender error that declared `not_applied` |
| `SigningError` | `cause` | A signer refused or failed |
| `BuildError` | `message`, `cause` | The transaction could not be built: the recipe threw, the resolver refused (with the node's message), the payer's address balance is below the budget plus its withdrawals, coins were chosen under `gasPayment: "requireAddressBalance"`, or address-balance gas has no epoch-bounded expiration or uses `tx.gas` |
| `PolicyDenied` | `rule`, `message` | A preflight policy refused it before it was signed, or its budget is over `maxGasBudget` (`rule: "maxGasBudget"`) |
| `JournalError` | `cause` | The journal could not be read or written. It escapes `Tx.submit` only from the write that happens **before** the first send; after the network has answered, a failed write is logged and the answer stands |
| `UnexpectedEffects` | `digest`, `expected`, `found` | The effects did not contain what the caller expected. Outcome `applied` and exit 5: it comes from an `Executed`, so the transaction ran and gas was charged; only the receipt is missing |
| `GraphQLUnavailable` | `method`, `reason` | The GraphQL endpoint an extension needs is not usable. What `SuiGraphQL.layerUnavailable` rejects every call with |
| `ExtensionNotReady` | `extension`, `member` | A synchronous member of a Promise face was called before its runtime existed: `await client.<name>.$ready()`, or register with `warm` |

`ExecutionReason` mirrors the SDK's `ExecutionError` variant for variant, with
`MoveAbort.abortCode` as a `bigint` and clever-error constant names decoded;
`Unknown` keeps the node's `message` and `command`, because that sentence
(`InsufficientCoinBalance in command 0`) is all the gRPC parser gives for many
kinds.
**Every one of them has a readable `.message`**: for the classes that carry no
`message` field of their own it is a getter returning `SuiError.describe(this)`,
so anything that surfaces `error.message` — a log line, a UI, another library's
formatter — shows the actionable line instead of an empty string. It is not a
schema field and does not appear in `SuiError.toJson`'s output.

`SuiError.isRetryable`, `SuiError.outcome`, `SuiError.isTaxonomy`,
`SuiError.describe`, `SuiError.toJson`, `SuiError.digestOf`,
`SuiError.moveAbort` and `SuiError.isMoveAbort` are the helpers every repo
otherwise hand-rolls, and **every one takes `unknown`**, so a Promise `catch
(e)` needs no cast. `describe(e)` is one line that says what to do next —
`ExecutionFailed MoveAbort 0x…::escrow::claim EAlreadyClaimed "already claimed" (line 42) in command 1`,
`SimulationFailed InsufficientCoinBalance in command 0`, a `BuildError` with
the exception the recipe threw, `ConfigError missing SUI_NETWORK` — never
bytes, and `{ tag: false }` drops the leading tag.

**Mapping a Move abort to your own error** is
`SuiError.isMoveAbort(e, { module: "escrow", constant: "EAlreadyClaimed" })`
(any of `package`, `module`, `function`, `constant`, `code`), or
`SuiError.moveAbort(e)` for the whole location as an `Option`. It matches a
`SimulationFailed` and an `ExecutionFailed` alike; keep the outcome of the one
you got. After an upgrade the abort's `package` is the **latest** package id,
so match on `module` and `constant`.

The helpers:
`outcome` puts every failure on the `"applied" | "not_applied" | "unknown"`
axis, and an extension error may declare its own. An error that is neither a tag
above nor declares an `outcome` is *unclassified*: `outcome` answers `"unknown"`,
because an unrecognised tag is no evidence that nothing happened, and
`Script.exitCode` exits 1 rather than 3, because it is no evidence that anything
was sent either. Declare `outcome` on every error your extension defines — as a
class field is fine, `toJson` reads it off the instance and serializes it either
way, and the check duck-types the field, so an existing `Error` subclass with an
`outcome` property lands on the axis without becoming a `Schema.TaggedError`
first.

`SuiError.outcome(error, { phase: "pre-submit" })` changes exactly one answer:
an unrecognised tag caught **before** anything could have been sent — in a
`catchAll` around a build, a simulate or a signature — is `"not_applied"`
rather than `"unknown"`, which is true there by construction. The default stays
`"post-submit"`. `SuiError.isTaxonomy(error)` answers the question underneath
it, and `SuiError.describe` accepts a foreign error too, falling back to its tag
and message rather than returning nothing.

**A wrapper error must carry what it wrapped.** `Script.exitCode` honours a
declared `outcome` before the tag, so a `catchAll` that re-raises its own error
type around a `Tx.run` must copy `outcome: SuiError.outcome(cause)` and the
digest, or a charged `ExecutionFailed` becomes exit 1 or, worse, exit 4 — and
the wrapper retries a transaction that already ran.

## Scripts

`Script.layer` reads the environment:

| Variable | Required | Meaning |
|---|---|---|
| `SUI_NETWORK` | yes, no default | `mainnet`, `testnet`, `devnet`, `localnet` or your own |
| `SUI_ALLOW_MAINNET` | only for mainnet | `1` or `true`; a script that means mainnet has to say so twice |
| `SUI_RPC_URL` | no | The gRPC endpoint; defaulted per known network |
| `SUI_RPC_TIMEOUT` | no | The per-attempt read timeout, a duration (`30 seconds`, the default) or `Infinity`. A read that runs out is a retryable `DEADLINE_EXCEEDED` and is retried; it never bounds an execute |
| `SUI_LOG_LEVEL` | no | `Script.run` only: the run's minimum log level — `All`, `Trace`, `Debug`, `Info`, `Warn`, `Error`, `Fatal` or `None`, spelled exactly so (`Config.LogLevel`). Unset, Effect's default (`Info`). `Debug` shows `SuiCore`'s read retries; anything else is a `ConfigError`, exit 2 |
| `SUI_PRIVATE_KEY` | `Script` only | A Bech32 `suiprivkey1…` key of any of the four schemes (Ed25519, Secp256k1, Secp256r1, and ML-DSA-65 on `@mysten/sui` 2.36 or later) **or a 32-byte hex seed** (64 hex characters, `0x` optional, read as Ed25519), through `Config.Redacted`. A key that does not decode fails with one fixed sentence and no cause: the Bech32 decoder quotes the whole input it rejected, so nothing derived from it is ever printed |

`Script.layerReadOnly` provides `ScriptReadOnly`, which has no signer at all —
a separate service key, so a script written to sign cannot silently build over a
layer that cannot. `Script.run` installs SIGINT and SIGTERM handlers, interrupts
the root fiber so finalizers run, writes one diagnostic line per failure to
stderr (through `SuiError.describe`, so a missing variable reads `ConfigError
missing SUI_NETWORK`), and exits. stdout carries only what the script itself printed: the
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

Two rules sit on top of the table. **An error may declare its own exit code**:
an integer `exitCode` (1–255) — a plain field, or Effect's own
`[Runtime.errorExitCode]` marker when there is no such field — is honoured
after `ConfigError` and before `outcome`, which is how a bad-input error of your own exits 2 instead of 4.
And **while this run left a submission unresolved, nothing exits 2, 4 or 130**:
the exit is 3, whether or not another transaction applied, because an
outstanding submission means "reconcile before anything else". With nothing
unresolved, **once this run applied a transaction** the exit is 5 instead, and
the applied digests are printed with "do not send them again" — a timeout or a
Ctrl-C after the execute answered must not read as "safe to retry". 1, 3 and 5
are never rewritten. `Script.run` finds the journal wherever the program provided it, so
this holds for a durable journal provided inside the program too.

**`Script.report(exit, { stderr?, journal? })`** is those last two steps on
their own — the diagnostic lines and the unresolved entries, with the exit code
as the answer — for a CLI that owns its own argv parsing and process. Assign it
to `process.exitCode` rather than calling `process.exit`. It lists **every**
unresolved entry of the journal it is given, another process's included in a
shared store, and any one of them turns a would-be 2, 4 or 130 into 3; it has
no count of what applied, so the "applied → 5" rule is `Script.run`'s alone.
`Script.run` lists, and counts, only the entries its own program wrote.
`Script.layerNoDeps`, `layerWithSigner` and `layerReadOnlyNoDeps` take the
network from the `SuiCore` underneath, not from `SUI_NETWORK`, so they build
over `layerTest` with no environment.

A timeout or an interrupt asks the journal: with an unresolved submission in it
the exit is 3, not 4 or 130, because an `Effect.timeout` wrapped around a
submission interrupts it from the outside and the bytes may be on the wire. Each
unresolved entry is printed as two lines: `unresolved <digest> (<tag>)`, and
`entry: <JSON>`, the whole entry encoded through the `JournalEntry` schema — the
same JSON a durable journal stores, bytes base64 included — so a wrapper can
hand stderr to a recovery process verbatim.

## Relay and sponsor envelopes

`Executed` describes the SDK's own execute include set. A relay, a sponsor or
any service that submitted on your behalf returns whatever *it* asked the node
for, which is usually less: `changedObjects` with an `objectId` and an
`idOperation` and nothing else, no `objectTypes`, no `balanceChanges`, no
checkpoint, events as JSON with no BCS.

`Executed.fromPartial(envelope)` decodes exactly that, and what it was not told
stays "not told": input and output states are `Unknown` rather than a guessed
`ObjectWrite`, versions and digests are `null`, and the accessors read `Unknown`
as "the envelope did not say", so `created()` and `deleted()` still classify
from the id operation alone. JSON spellings are accepted where the SDK's types
are not JSON — `bcs` as base64 or a byte array, every `u64` as a number or a
`bigint` as well as the decimal string the wire uses. Two things it cannot
invent: the **types** (`created(type)` and `expectCreated(type)` match against
the `objectTypes` join, so without one they match nothing — use `created()` or
`createdWhere(predicate)`), and the **gas** (`gasUsedTotal` is `0n` for an
envelope that reported none, which means "not reported", not "free").

`Executed.fromTransactionResult(result)` is the strict constructor, for an SDK
`TransactionResult` read with the full include set.

The whole sequence, for a service that co-signs and submits: `Tx.build` with
`Tx.sponsored`, `Tx.sign`, hand `toBase64(signed.bytes)` and `signed.signatures[0]`
to the service, and then either `Executed.fromPartial(reply)` or — through
`Tx.submitVia`, which keeps the journal — `Tx.reconcile(signed)`. The digest
does not change when the sponsor adds its signature, so `signed.digest` is what
to record. `docs/extensions.md` has the section.

**`Executed.events` is `ReadonlyArray<Event>`, not `SuiClientTypes.Event[]`**:
the same fields with branded ids, and an optional `json` present only when
whatever produced the `Executed` carried one (a relay envelope may; a gRPC
execute never does) — do not branch on it. Decode events with
`executed.eventsOf(codec)` (every match, decoded) or `executed.expectEvent(codec)`
(exactly one, else `UnexpectedEffects`). **After an upgrade an event struct
keeps its original package id**: a v1 struct emitted by v2 code is still
`ORIGINAL::module::T`, so codecs and `eventType` filters use the original id,
while a struct added in v2 lives under the v2 id. A publish or an upgrade reads
back with `executed.expectPublished()` → `{ packageId, package, upgradeCap }`
(`examples/recipes/publish-and-upgrade.ts`). Code typed against the SDK's
`Event[]` does not accept these.

**`bigint` throws in `JSON.stringify`.** Gas, balances, versions and
`checkpoint` are all `bigint`; anything that logs, persists or returns one over
HTTP needs `.toString()` or a replacer. Decimal strings are what the wire uses
and what every schema here decodes from.

## Applications, Workers and Durable Objects

An application that consumes this library — an SPA, a Worker, a Durable Object —
wants one `ManagedRuntime` at module scope over
`Sui.layerNoDepsWith({ chainId })` and `SuiCore.layerFromClient(client)`, and
should know four things:

- **a `ManagedRuntime` memoizes its layer build, failure included.** One flaky
  `getChainIdentifier` at boot and every later use of that runtime fails with the
  same stale `TransportError`. Pass `SuiLayerOptions.retry` (a `Schedule` for
  that one read), dispose and rebuild on a build failure, or use
  `Sui.layerNoDepsPinned(chainId)`, which makes no call at all;
- **the default `Journal` is process-wide memory.** In a browser tab a refresh
  is a new process and two tabs are two journals and two sender locks; what an
  app actually holds is the `SubmissionUnknown` and its bytes, so persist that
  and reconcile it on the next boot, or provide the durable journal;
- **the sender lock does not cross isolates**, so correctness there rests on
  address-balance gas — the default, and a guarantee under
  `gasPayment: "requireAddressBalance"`, so a transaction with no owned input
  pins nothing to race (`lockSender: "never"` then drops the per-isolate build
  lock too) — or on serializing an address through one Durable Object;
- **there is no `process`** in a Worker: `Script` is a Node entrypoint, and
  configuration comes from `ConfigProvider.fromEnvRecord(env)`.

`docs/extensions.md` sections 17 and 18 have the runtime module, the HMR
dispose, the vitest double and the `KeyValueStore.makeStringOnly` adapter over
Durable Object storage.

## Metrics and tracing

Every public member opens a span named after itself (`SuiCore.getObject`,
`Tx.submit`); per-item helpers open none and annotate the enclosing span
instead. A submission's spans carry `sui.digest`, `sui.attempt`, `sui.outcome`
and, when they apply, `sui.refused`, `sui.lock_conflict` and
`sui.not_applied.evidence`; `Tx.build`'s carry `sui.simulated_by`,
`sui.gas_budget`, `sui.max_epoch` and `sui.gas_payment` (`addressBalance`,
`coinReservation`, `coins`); `Tx.run`'s carries `sui.sender_lock` (`held`,
`build`, `none`); `Sui.getObjects` carries
`sui.object_count` and `sui.chunk_count`, and each `Sui.getObjectsPage`
`sui.decode_failures`; a tail carries `sui.page_count` and `sui.caught_up`.

The library also records **metrics**, through Effect's `Metric` into the
`Metric.MetricRegistry` in context (install any exporter; read them with
`Metric.snapshot`). **The names and attribute keys below are a public
contract.** Every attribute value comes from a small closed set: no metric is
ever keyed by a digest, an address, an object id or a coin type.

| Metric | Kind | Attributes | Counts |
|---|---|---|---|
| `sui_effect_tx_execute_attempts_total` | counter | — | `executeTransaction` attempts by `Tx.submit`/`Tx.resubmit`, resends included |
| `sui_effect_tx_submit_total` | counter | `result`: `executed`, `execution_failed`, `not_applied`, `submission_unknown`, `refused`, `journal_error` | How each `Tx.submit`/`Tx.resubmit` ended |
| `sui_effect_tx_lock_conflicts_total` | counter | — | Sends that ended in a validator lock conflict on a pinned input |
| `sui_effect_tx_reconcile_total` | counter | `result` (as above, less `refused`/`journal_error`); `evidence` (`expired`, `inputConsumed`, `refused`) for `not_applied` | Every reconcile answer: inside `Tx.submit`, `Tx.reconcile`, `Tx.resubmit`, `Tx.reconcileAll` |
| `sui_effect_tx_visibility_wait` | timer (ms) | `result`: `visible`, `timeout`, `failed` | `Tx.submit`'s wait for an executed transaction to become readable |
| `sui_effect_tx_build_duration` | timer (ms) | `simulated_by`: `sdk`, `explicit` | Each successful `Tx.build` |
| `sui_effect_tx_build_gas_budget` | histogram (MIST) | — | The gas budget of each successful `Tx.build` |
| `sui_effect_core_read_retries_total` | counter | `method` (the `SuiCore` method; `use` for `Tx.build`'s resolver), `status` (the transport status, or `none`) | Retries of retryable read failures |
| `sui_effect_core_request_timeouts_total` | counter | `method` | Read attempts abandoned at `requestTimeout` |
| `sui_effect_sender_lock_wait` | timer (ms) | — | Time queued for a sender's lock in `Sui.withSenderLock` |

Timers are Effect `Metric.timer` histograms, which add `time_unit:
"milliseconds"`. In a test, provide `Metric.MetricRegistry` with a fresh `Map`
so counts do not leak between tests; the default registry is process-wide.

## Testing

`@unconfirmed/sui-effect/testing` ships the in-memory `SuiCoreFake`, `layerTest(script)` (the
real `Sui` over the fake, so tests exercise the production high tier),
`layerExtensionTest(layer, script, { extra })` for an extension's own tests
(`SuiGraphQL.layerUnavailable` is provided by default; `extra` is for anything
else the extension's layer requires), and `SuiTest`
for driving the fake's state and reading back what it was sent. No test in this
repository touches the network, and neither should yours.

`SuiTest.provide(layer)` is the wiring: it provides the layer with a fresh
`Journal.layerMemory` and Effect's `TestClock`, all local to the test.
`layerTest` re-sends with no delay (`testSubmitConfig`), so a resubmit test
does not sleep on the real clock. `fakeDigest(n)` is a branded `Digest`,
`fakeCoin({ … })` a coin fixture, and a scripted event's `json` is optional.
`FakeScript.visibilityDelay` holds `waitForTransaction` after an execute, which
is how a test interrupts a submission that already landed.

Six things a test on the fake has to know. `layerTest` is the production layer,
so a script naming `mainnet` or `testnet` must report that network's real chain
identifier — use `localnet` (the default) in fixtures. `Tx.submit` reconciles
through `getTransaction`, so a submit test that does not mean "this landed"
scripts `getTransaction: [FakeOutcome.notFound()]`. A **sponsored** submit needs
`Tx.cosign` first: the fake refuses an under-signed or wrongly-signed submission
with a gRPC `INVALID_ARGUMENT`, the way a validator does. And the build's
simulate is the resolver's — recorded, so `SuiTest.calls("simulateTransaction")`
sees it, and answered by `FakeScript.buildSimulate` if there is one and by the
ordered `simulate` script otherwise; like the SDK's core resolver, it runs only
when the recipe left the budget unset, and `Tx.build` simulates explicitly
otherwise. An execute outcome scripted with a digest other than the bytes' own
stops the test with a defect — a node never answers with another transaction's
digest. And an owner with no scripted balance has zero, so a **sponsored**
(`Tx.sponsored`) build needs a balance with an `addressBalance` covering the
budget, or `Tx.build` fails with `BuildError`.

The fake models **address balances** per owner and coin type, seeded from
`FakeScript.balances[].addressBalance`, set with
`SuiTest.setAddressBalance(owner, amount, coinType?)` and read back with
`SuiTest.addressBalance(owner, coinType?)`. Its resolver chooses the way the
SDK's does: payment `[]` when the payer's SUI balance covers the budget plus its
withdrawals and `tx.gas` is unused, coins otherwise — so a test that scripts an
owner-less balance alongside coins gets address-balance gas, and one that wants
coin gas scripts `addressBalance: "0"` for the payer. A payer with neither coins
nor a balance fails the build with `BuildError` ("No valid gas coins found").
Executions charge gas to the balance, debit withdrawals and follow
`send_funds` deposits, so a fold or a `Tx.sendFunds` is observable.

The fake also serves the ledger reads: `listTransactions` and `listEvents`
page through every transaction it was scripted with or executed, filtered by
the sender and Move calls in the bytes, and `FakeScript.scanLimit` makes pages
come back short or empty the way a scan-limited node's do. `FakeScript.names`
answers the name-service reads, and `FakeScript.ledger` serves the pruning
history reconcile asks a gRPC node for.

## Versions

| Package | Range | Tested against |
|---|---|---|
| `effect` | `>=4.1.1 <4.2` | `4.1.1`, in CI; `4.1.1` is the pinned devDependency |
| `@mysten/sui` | `^2.28` (the first version whose BCS and gRPC round-trip `ValidDuring` and `Validity` expirations) | `2.30.0` and `2.38.0`, both in CI; `2.38.0` is the pinned devDependency |
| `@mysten/bcs` | `^2.1.3` | `2.1.3` |
| TypeScript | `5.9.x` to build | `5.9.3` |
| Bun | `1.4.x` | `1.4.2` |

The SDK row is a matrix, not a hope: CI builds, typechecks and runs the suite
against `@mysten/sui` 2.30.0 and 2.38.0: the oldest version consumers pin and
the current one. The `effect` row is a matrix of one today (`4.1.1`): the range admits the 4.1.x
patch releases, and a release is added to the CI matrix once it exists and the
suite has run against it. Release candidates are out of range on purpose: the
module paths (`effect/unstable/*` became `effect/*` in rc.118) and the `Config`
and `Schema` constructors this package calls differ between rc.112 and 4.x.

**TypeScript 7 (`tsgo`) consumers should work but are not checked.** The
shipped `.d.ts` is plain declarations and needs nothing from the old compiler,
but CI's isolated-consumer job typechecks the packed tarball with `tsc` 5.9.3
only. The `prepare` script here
(`effect-language-service patch`) is a library concern — it patches the checker
this repository develops against — and should not be copied into a consumer or
an extension package.

`bun run check` is typecheck, build, tests and the extension template's own
check.

## For agents

`LLMS.md` ships in the package. It opens with a "start here" section — the
subpath map, thirteen tested recipes (reads, a payment, sponsorship by address
balance, by coins and by a stateless service, publish and upgrade, typed events,
a resumable indexer, a durable journal in a script, re-sending a lost
submission, mapping a Move abort, an extension and its Promise face called from
plain TypeScript, a test on the fake), the error table with outcomes and exit
codes, `SubmitConfig`'s defaults, ten invariants and an index of every export — then
every public export with its signature and the error union its JSDoc states,
plus every example verbatim. It is generated by
`bun run llms` and a test fails when it is stale. `AGENTS.md` is the short list
of invariants to read before the code, `DESIGN.md` the specification, and
`docs/extensions.md` the extension contract; all four ship in the package.

## Side by side

The same two tasks, once against the canonical `@mysten/sui` 2.38 SDK (a
gRPC client, the Core API, `Transaction`) and once against sui-effect. Both
sides are exercised in `test/examples.test.ts`, and this section is asserted
to be the literal text of the four files it quotes.

### Read

`examples/compare-read.sdk.ts`:

```ts
/**
 * Reads one Escrow object and an optional dynamic field on it, written
 * against the canonical 2.38 SDK: a gRPC client, the Core API, manual BCS.
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
 * Claims an escrow through a PTB, written against the canonical 2.38 SDK.
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

// The scheme flag on a Bech32 key names one of four keypair classes and
// nothing decodes it for you. ML-DSA-65's class (2.36+) is left out so this
// file compiles on every SDK the peer range admits; sui-effect's
// `Signer.fromConfig` loads it on demand where it exists.
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

## License

MIT
