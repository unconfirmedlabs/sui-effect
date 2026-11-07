# @unconfirmed/sui-effect

An [Effect](https://effect.website) v4 program to interact with the Sui
blockchain: a light wrapper around the official
[`@mysten/sui`](https://www.npmjs.com/package/@mysten/sui) TypeScript SDK that
makes it safer to use and uses Effect for reliability, convenience and a better
developer experience.

The SDK keeps doing BCS, transaction building, signing and transport.
sui-effect adds what a program around it needs:

- a closed, tagged error union on every function, each failure placed on one
  axis (`applied`, `not_applied`, `unknown`);
- cancellation, a span and transport retries on every SDK call;
- decoded, type-checked reads;
- a crash-safe transaction lifecycle: simulate before signing, journal before
  sending, re-send identical bytes, reconcile against objects;
- an in-memory fake chain, so every test runs with no network.

Every public name mirrors the SDK name it wraps, so an agent or a person who
knows `@mysten/sui` can guess this package.

## Install

```bash
bun add @unconfirmed/sui-effect
bun add -d effect@4.1.1 @mysten/sui@2.38.0
```

`effect`, `@mysten/sui` and `@mysten/bcs` are peer dependencies: one copy of
each per process, or `Context.Service` identities and `instanceof` checks stop
matching. A library built on sui-effect puts all three in its own
`peerDependencies` and `devDependencies`, never in `dependencies`.

## A complete program

Claim an escrow: read the object, build, simulate, sign, journal and submit,
then read the receipt off the effects.

```ts
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect } from "effect"
import { ObjectId, Sui, SuiSchema } from "@unconfirmed/sui-effect"
import { Signer, Tx } from "@unconfirmed/sui-effect/tx"

const PKG = "0x…"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)

export const program = Effect.gen(function*() {
  const sui = yield* Sui
  const signer = yield* Effect.flatMap(Config.Redacted("SUI_PRIVATE_KEY"), Signer.fromSecretKey)
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

// BunRuntime.runMain(program.pipe(Effect.provide(Sui.layerConfig)))
```

That is the program in `examples/compare-write.effect.ts`; a test runs it
against the fake and asserts this README quotes it. Every failure it can
produce — the reads, the build, the signer, the submission, the config — is in
the generator's inferred error type, with no handling lines anywhere.

## Map

| Part | Import | One line |
|---|---|---|
| [The two read tiers](#the-two-read-tiers) | `@unconfirmed/sui-effect` | `SuiCore`, the SDK's Core API one-to-one; `Sui`, the convenience tier: decoded reads, `Option`, `Stream` |
| [The transaction lifecycle](#the-transaction-lifecycle) | `@unconfirmed/sui-effect/tx` | `Tx.run`, or `build` / `sign` / `submit` / `reconcile` by hand; `approve`; the sender lock; `resubmit` |
| [Signers](#signers) | `@unconfirmed/sui-effect/tx` | `Signer` values: keys, mnemonics, SDK signers, remote signers, zkLogin, multisig, address aliases; `Verify` |
| [Sponsorship](#sponsorship) | `@unconfirmed/sui-effect/tx` | `Tx.sponsored`, `fromBytes`, `attach`, `cosign`, `verifySponsored`, `submitVia` |
| [Address balances and coins](#address-balances-and-coins) | `@unconfirmed/sui-effect/tx` | Gas from the address balance; `Tx.sendFunds`, `Tx.foldCoins`, `Tx.gaslessStablecoinTransfer` |
| [`SubmitConfig`](#submitconfig) | `@unconfirmed/sui-effect/tx` | Every lifecycle decision, with defaults |
| [The journal](#the-journal) | `@unconfirmed/sui-effect/tx`, `/journal` | The record of signed bytes; in memory by default, durable over a `KeyValueStore` |
| [Errors](#errors) | `@unconfirmed/sui-effect` | One flat tagged error per failure, and `SuiError.outcome` |
| [Metrics and tracing](#metrics-and-tracing) | — | The span attributes and the `sui_effect_*` metrics |
| [Testing](#testing) | `@unconfirmed/sui-effect/testing` | The real `Sui` over an in-memory fake chain |

[Side by side](#side-by-side), at the end, is one read and one write against
the plain SDK and against this package.

## The two read tiers

**`SuiCore`** is a one-to-one Effect wrap of the SDK's `ClientWithCoreApi`:
every transport method present, the SDK's options objects and `Include`
generics unchanged, every call cancellable through the Effect's `AbortSignal`,
every failure mapped into one tagged error, a span per method, and reads
retried on transient transport failures — each attempt bounded by
`requestTimeout` (30 s; `SUI_RPC_TIMEOUT` under `layerConfig`; `"Infinity"`
turns it off), because the SDK's own `timeout` only sets a gRPC header.
`core.use((client, signal) => …)` reaches the client object itself, with the
same error mapping.

**`Sui`** is the convenience tier over it: fixed include sets, BCS content
decoded through a schema after the object's Move type is checked, `Option`
where absence is normal, batch reads chunked to 50 and checked for missing or
duplicated ids, pagination as `Stream`, and the chain's clock. It carries its
`SuiCore` as `sui.core`.

```ts
const sui = yield* Sui
const escrow = yield* sui.getObject(id, { schema: Escrow })            // ObjectNotFound | ObjectDeleted | … | DecodeError
const maybe = yield* sui.getObjectOption(id, { schema: Escrow })       // Option<SuiObject<…>>
const balance = yield* sui.getBalance(owner)                           // SUI by default
const now = yield* sui.chainTime                                       // the Clock object 0x6
const total = yield* sui.view(recipe, bcs.u64())                       // a Move return value, simulated
const page = yield* sui.core.listEvents({ filter, after: cursor })     // the SDK's own page
```

- **`Sui` members are positional; `SuiCore` members take the SDK's options
  object.** `sui.getObject(id, { schema })`, but
  `sui.core.getObject({ objectId, include })`.
- **The SDK's `listX` is `sui.streamX`**, a `Stream` that follows every page
  and ends once caught up: `streamOwnedObjects`, `streamCoins`,
  `streamBalances`, `streamDynamicFields`, `streamEvents`,
  `streamTransactions`. **`tailEvents` and `tailTransactions` never end**: they
  poll, retry from the last cursor, and keep a filtered cursor ahead of a
  pruning node (sound only against one sticky node). `{ after }` starts any of
  them at a cursor. A reader that commits its own cursor pages through
  `sui.core.listEvents` / `sui.core.listTransactions`, whose pages carry
  `endCursor` (`examples/recipes/indexer.ts`).
- **A history includes what an address received.** `{ affectedAddress }` on
  the transaction streams is the gRPC ledger's own predicate, which the SDK's
  `TransactionFilter` does not expose; a transport without it fails with
  `TransportError { status: "UNIMPLEMENTED" }` rather than answering half.
- A transaction `function` filter must be fully qualified
  (`pkg::module::function`): the SDK cannot page past the first page of a
  shorter one, so the streams refuse it up front.
- **Ids from a person go through `.Strict`.** `SuiAddress.Strict` and
  `ObjectId.Strict` take exactly 64 hex digits; decoding `SuiAddress` pads,
  which is right for a node and wrong for a typed recipient. `.normalize` is
  for a shorthand literal (`"0x6"`), `.make` for the padded form.
- `SuiSchema.bcs(bcsType, "0x…::module::Type")` is the bridge from a
  `@mysten/bcs` layout to a `Schema` codec that checks the Move type first. A
  type with no type arguments matches every instantiation of it.

`SuiGraphQL` is the SDK's `SuiGraphQLClient` as one shared tag; sui-effect
wraps no GraphQL API. `SuiGraphQL.layerUnavailable` makes every call fail with
`GraphQLUnavailable`.

## The transaction lifecycle

A recipe is a synchronous `(tx: Transaction) => void`; reads happen in the
surrounding Effect. `Tx.run(recipe, { signer })` does the whole lifecycle:

1. **Build**, which always simulates before anything is signed — the SDK's
   resolver does when it chooses a budget, and `Tx.build` runs one explicit
   simulate whenever it will not, on every transport. A budget over
   `SubmitConfig.maxGasBudget` is `PolicyDenied { rule: "maxGasBudget" }`; a
   resolver refusal is a `BuildError` with the node's message.
2. **Expire**: unless the recipe set one, a `ValidDuring` expiration of the
   current epoch and the next, naming the chain, so bytes signed for testnet
   cannot land on mainnet.
3. **Approve** (optional): `approve(prepared)` is shown the built bytes and
   the simulation of exactly those bytes, before the first signature.
4. **Sign**, with the sponsor too when the gas owner is not the sender.
5. **Journal** the signed bytes, then **submit**, re-sending the identical
   bytes — never a rebuild — on a retryable failure or a timeout, and waiting
   until the execution is readable.
6. **Reconcile** when the outcome is still unknown: `Executed`,
   `ExecutionFailed`, `NotApplied { evidence }`, or `SubmissionUnknown`
   carrying the bytes.

The steps are public too: `Tx.build`, `Tx.sign`, `Tx.cosign`, `Tx.submit`,
`Tx.reconcile`, each with a closed error union and `R = Sui`.

```ts
const executed = yield* Tx.run(recipe, {
  signer,
  approve: (prepared) => askThePerson(prepared), // Effect<void, UserRejected>: refusing signs nothing
  onSigned: (signed) => recordDigest(signed.digest) // after the last signature, before the first send
})
```

**`approve` is the person, or the policy, in the loop.** `prepared.built.gas`
is the fee line (budget, price, payer, and whether the address balance, a coin
reservation or coins pay it); `prepared.simulation` has the same accessors an
`Executed` has — `created()`, `transferred()`, `balanceChange(address,
coinType)`. A refusal is `approve`'s own error, and nothing is signed, sent or
journalled. It runs under the sender lock only when the bytes pin something.

**The sender lock.** Two concurrent builds from one address can pin the same
gas coin or owned object. `Tx.run` takes the sender's lock for every build, and
holds it through signing and submission only when the bytes pin something (an
owned input, a gas coin, a coin reservation); address-balance transactions from
one sender are signed and sent concurrently (on localnet, ten `Tx.sendFunds`
runs took 1,044 ms against 8,069 ms with the lock held throughout).
`Tx.withSenderLock(address)(effect)` is the same lock for a program that
assembles `build → sign → submit` by hand. `SubmitConfig.lockSender` decides
the rule.

**Since bytes may have been sent, no `TransportError` escapes.** It becomes
`SubmissionUnknown`, with one exception: a gRPC `INVALID_ARGUMENT` on the
first send, the node refusing the request outright, which is reported as it is
and journalled `NotApplied { evidence: "refused" }`.

**`NotApplied` is hard to earn, on purpose**, because it tells a caller it is
safe to send again. Its evidence is read from **objects**, never from
transaction history: `"inputConsumed"` needs a *different* transaction's own
effects to report the exact version the bytes pinned; `"expired"` needs the
epoch bound observed as passed, then a miss, then both again after
`SubmitConfig.reconcileRecheck`, and a pinned object naming this very digest
vetoes it, as does a gRPC node that has pruned into the validity window. Almost
every stuck submission therefore ends as `SubmissionUnknown`; do not build a
retry loop that waits for `NotApplied`. Reconcile also refuses to reason
across chains.

**Re-sending is explicit.** `Tx.resubmit(signedOrUnknown)` sends the identical
bytes again — one digest, one execution — and reconciles instead when the
journal says they settled, the bytes name another chain or their window has
closed. `Tx.reconcileAll({ resubmit: true })` is the startup sweep over a
durable journal.

## Signers

A `Signer` is a value, not a service: `{ address, scheme, signTransaction,
signPersonalMessage }`, with `maxEpoch` when it is bounded and `alias` when it
signs as another address. One process can hold two. A signer never exposes
secret material, and every signer only signs: building, simulation, the journal
and submission stay `Tx`'s.

| Constructor | Signs with |
|---|---|
| `Signer.fromKeypair(kp)` / `Signer.fromSdkSigner(signer)` | Any `@mysten/sui/cryptography` signer: a `Keypair`, the SDK's `PasskeyKeypair`, a Ledger or KMS signer |
| `Signer.fromSecretKey(secret, { scheme? })` | A `suiprivkey1…` (any scheme, `MLDSA65` included), a 64-digit hex seed or 32 bytes; the bytes are copied first |
| `Signer.fromMnemonic(phrase, { scheme?, account?, path? })` | A BIP-39 phrase, **checked** (word count, word list, checksum) before the SDK derives anything; a typo is `KeyError`, never an empty account |
| `Signer.generateMnemonic(words?)` / `Signer.derivationPath(scheme, account?)` | A fresh phrase from `crypto.getRandomValues`, redacted; the standard Sui paths |
| `Signer.ephemeral` | A throwaway Ed25519 key |
| `Signer.remote({ address, scheme, signTransaction })` | Anything that signs elsewhere: a KMS, an HSM, another process |
| `Signer.zkLogin({ address, ephemeralSigner, inputs, maxEpoch })` | The ephemeral signature wrapped in a zkLogin proof (the SDK's option names) |
| `Signer.multisig(publicKey, signers)` | A weighted multisig over member signers of any scheme |
| `Signer.alias(address, signer)` | `signer`'s key, signing **as** `address` through its address aliases |

Reading a key from the environment is
`Config.Redacted("SUI_PRIVATE_KEY").pipe(Effect.flatMap(Signer.fromSecretKey))`.
Getting a zkLogin proof — the OAuth flow, the prover, keeping the ephemeral key
— is the application's; the signer refuses bytes that cannot start before
`maxEpoch` with `SigningError { reason: "expired" }`, and `Tx.run` keeps the
build's window inside `maxEpoch` and refuses a passed one before anything is
built.

### Address aliases and multisig accounts

Sui's address aliases (`0x2::address_alias`) let an address A list other
addresses that may sign transactions **as** A. An account whose only alias is a
multisig M keeps one address while its keys change.

```ts
// An account whose only alias is a multisig: hand it over once, then every transaction's sender
// is the account and its signature the multisig's.
import type { MultiSigPublicKey } from "@mysten/sui/multisig"
import { Effect } from "effect"
import type { SuiAddress } from "@unconfirmed/sui-effect"
import { AddressAlias, Signer, Tx } from "@unconfirmed/sui-effect/tx"

// Once, signed by the account's own key: `enable` (it returns no object, so the edit is a second
// transaction), then add the multisig and remove the account itself. Its own key then signs nothing.
export const handOver = (account: Signer, multisig: SuiAddress) =>
  Effect.gen(function*() {
    yield* Tx.run(AddressAlias.enable(), { signer: account })
    return yield* Tx.run((tx) => {
      AddressAlias.add({ address: account.address, alias: multisig })(tx)
      AddressAlias.remove({ address: account.address, alias: account.address })(tx)
    }, { signer: account })
  })

// Every transaction after: members in any order (they are combined in the multisig's member
// order), `Signer.alias` to sign AS the account. `Tx.run` reads the account's alias set once and
// refuses a multisig it does not list with `PolicyDenied { rule: "alias.signer" }` before
// building; the sender lock and the journal are the account's.
export const payAs = (
  account: SuiAddress,
  publicKey: MultiSigPublicKey,
  members: ReadonlyArray<Signer>,
  recipient: SuiAddress
) =>
  Effect.gen(function*() {
    const multisig = yield* Signer.multisig(publicKey, members)
    return yield* Tx.run(Tx.sendFunds({ amount: 1_000n, recipient }), { signer: Signer.alias(account, multisig) })
  })
```

- **`Signer.multisig`** signs with each member, one after another, and combines
  the partial signatures **in the multisig's member order**, whatever order the
  signers were given in. The SDK's `combinePartialSignatures` keeps the order
  it is handed and a validator pairs the n-th signature with the n-th bitmap
  bit, so any other order is refused on chain. A non-member, a duplicate or too
  little weight is `KeyError { reason: "invalidMultisig" }`. Its `maxEpoch` is
  the earliest member's.
- **`Signer.alias(A, signer)`** has `address` A and `alias` the key that signs.
  Everything keyed on the sender is A's: the build, the sender lock,
  `Built.sender`, the journal. `Tx.run` reads A's `AddressAliases` object once
  before building and refuses a key A does not list with
  `PolicyDenied { rule: "alias.signer" }`. Aliases cover transactions only.
- **`AddressAlias`** reads the set from the **object** derived from `0xa`
  (`aliasesId`), never from transaction history: `getAliases`,
  `requireSigner`, and the recipes `enable`, `add`, `remove`, `replaceAll`.
- **`Verify`** is the Effect face of `@mysten/sui/verify`:
  `Verify.verifyTransactionSignature(bytes, signature, { address?, checkAddressAliases? })`
  and `verifyPersonalMessageSignature`. An invalid signature is
  `SigningError`; a check that could not reach the node is `TransportError`,
  never a verdict. With `checkAddressAliases: true` it checks a sender the way
  a validator does.

## Sponsorship

**Both parties in one process:** `Tx.run(recipe, { signer, gasOwner, sponsor })`
signs with both; without `sponsor` it fails with `SigningError` before anything
is built. **`Tx.sponsored({ sender, gasOwner })`** leaves the gas payment
empty, so the sponsor's **address balance** pays, no coin is selected, and one
sponsor serves many senders concurrently.

```ts
// The explicit lifecycle, for two parties: the sender signs, the sponsor pays.
import { Effect } from "effect"
import type { ObjectId } from "@unconfirmed/sui-effect"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

// `Tx.sponsored` sets sender, gas owner and an empty gas payment: gas comes from the sponsor's
// SUI ADDRESS balance, which must cover the budget or `Tx.build` fails with `BuildError` before
// anything is signed. Fund it from a coin with `coin::into_balance` + `balance::send_funds<SUI>`.
export const sponsoredIncrement = (sender: Signer, sponsor: Signer, counter: ObjectId) =>
  Effect.gen(function*() {
    const parties = { sender: sender.address, gasOwner: sponsor.address }
    const recipe = Tx.sponsored(parties)((tx) => {
      tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
    })
    const built = yield* Tx.build(recipe, parties)
    const signed = yield* Tx.cosign(yield* Tx.sign(built, sender), sponsor)
    return yield* Tx.submit(signed)
  })

// The coin-paid alternative, both signers in one process: no `Tx.sponsored`, just a gas owner.
// Gas is the sponsor's coins, so `Tx.run` also takes the sponsor's lock (only when coins pay).
export const coinPaidIncrement = (sender: Signer, sponsor: Signer, counter: ObjectId) =>
  Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
  }, { signer: sender, sponsor, gasOwner: sponsor.address })
```

**A sponsor service that only sees bytes** rebuilds nothing:
`Tx.fromBytes(bytes)` reads sender, gas owner, expiration and chain off them
(other-chain bytes refused), `Tx.attach(built, senderSignature)` verifies and
adds the sender's signature (an alias of the sender or gas owner counts), and
`Tx.cosign` and `Tx.submit` finish.

```ts
// A stateless sponsor service: handed the sender's bytes and signature, it checks, co-signs and
// submits. The sender built `Tx.build(Tx.sponsored(parties)(recipe), parties)` and sent
// `built.bytes` with the signature `Tx.sign(built, sender)` made.
import { Effect } from "effect"
import { PolicyDenied, Sui } from "@unconfirmed/sui-effect"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

export const sponsorBytes = (sponsor: Signer) => (bytes: Uint8Array, senderSignature: string) =>
  Effect.gen(function*() {
    // Sender, gas owner, expiration and chain are read out of the bytes, never taken on trust.
    const built = yield* Tx.fromBytes(bytes)
    if (built.gasOwner !== sponsor.address) {
      return yield* new PolicyDenied({ rule: "sponsor.gasOwner", message: `not paid by ${sponsor.address}` })
    }
    // `fromBytes` simulates nothing: simulate bytes you did not build before paying for them.
    yield* Effect.flatMap(Sui, (sui) => sui.simulate(built.bytes))
    // Verified against the bytes; the signer must be their sender or gas owner.
    const withSender = yield* Tx.attach(built, senderSignature)
    return yield* Tx.submit(yield* Tx.cosign(withSender, sponsor))
  })
```

**The sender's side** checks the bytes a sponsor returns with
`verifySponsored(built, { sender, gasOwner?, transactionKind? })`: the sender
the bytes name, a distinct gas owner, and — given the kind bytes it asked for
— exactly that transaction kind, so a sponsor cannot add a command and still
get a signature.

**When someone else submits**, `Tx.submitVia(signed, send)` keeps the
lifecycle around it: it journals `Signed`, calls `send` exactly once, turns the
reply into an `Executed` (an SDK result, a reduced envelope, or a bare digest),
and reconciles an ambiguous failure. `Executed.fromPartial(envelope)` decodes
what a relay returns and leaves what it was not told `Unknown`.

## Address balances and coins

**Gas comes from the payer's SUI address balance by default**, and from coins
only when the balance cannot cover it. An address balance has no object
version, so a transaction paid from it, drawing its funds from it, pins nothing
and runs beside the sender's other transactions.

- **`Tx.sendFunds({ coinType?, amount, recipient })`** sends from the sender's
  address balance into the recipient's: a `FundsWithdrawal`, redeemed and
  deposited with `0x2::balance::send_funds`. Address balances only — no coin
  fallback; a balance that does not cover it is refused when the build
  resolves it.
- **`Tx.foldCoins({ signer })`** moves coin objects into the balance:
  `Tx.planFold` (reads only), then one `Tx.run(Tx.fold(batch))` per batch, SUI
  first. SUI pays for its own fold, so a coin-only account needs nothing first.
  Given a previewed `plan` it runs exactly that plan, calling
  `approve(prepared, batch)` per batch; `batch.amount` is what moves into the
  balance.
- **`Tx.gaslessStablecoinTransfer({ coinType, amount, recipient, requireZeroGas? })`**
  is Sui's canonical free stablecoin transfer; the SDK resolver sets zero gas
  only when the network's protocol config allows it, and `requireZeroGas`
  refuses to sign otherwise.

```ts
// Fold an account's coin objects into its address balance once, so later transactions pay gas
// from the balance and pin nothing. SUI pays for its own fold: a coin-only account (a localnet
// faucet's) needs no balance first. Safe to repeat: each call re-plans from what is left.
import { Effect } from "effect"
import { Sui } from "@unconfirmed/sui-effect"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

// Reads only: what a fold would do, each batch built and simulated, nothing signed.
export const previewFold = (signer: Signer) =>
  Effect.gen(function*() {
    const sui = yield* Sui
    const plan = yield* Tx.planFold({ owner: signer.address })
    for (const batch of plan.batches) {
      const built = yield* Tx.build(Tx.fold(batch), { sender: signer.address })
      yield* sui.simulate(built.bytes)
    }
    return plan
  })

export const foldAll = (signer: Signer) =>
  Tx.foldCoins({ signer }).pipe(
    Effect.map(({ executed, plan }) => ({
      digests: executed.map((run) => run.digest),
      // SUI dust worth less than the gas of folding it, with no balance to pay for it either.
      dust: plan.skipped.length
    }))
  )
```

The localnet faucet (V2) pays coins, so fold first; the devnet and testnet
faucet (V3) pays into the address balance. In your own recipes prefer
`tx.coin({ balance })` / `tx.balance(…)` to `tx.splitCoins(tx.gas, …)`, which
pays gas from a coin.

## `SubmitConfig`

`program.pipe(SubmitConfig.with({ … }))` merges over the config **in force**;
`SubmitConfig.layer({ … })` spreads over the defaults. Durations take any
`Duration.Input`.

| Field | Default | What it decides |
|---|---|---|
| `expiration` | `"validDuring"` | The expiration `Tx.build` sets when the recipe set none (`"epoch"`, `"none"`) |
| `validFor` | unset | An extra wall-clock bound; no Sui network accepts one yet |
| `maxGasBudget` | 50 SUI | The ceiling above which `Tx.build` fails with `PolicyDenied { rule: "maxGasBudget" }` |
| `preflight` | unset | `(simulation) => Effect<void, PolicyDenied>`, run before signing |
| `lockSender` | `"whenPinned"` | When `Tx.run` holds the sender lock past the build (`"always"`, `"never"`) |
| `gasPayment` | `"preferAddressBalance"` | `"requireAddressBalance"` makes coin-paid gas a `BuildError` naming `Tx.foldCoins` |
| `resubmit` / `resubmitAttempts` | exponential from 250 ms, capped at 30 s / 5 | How `Tx.submit` re-sends the identical bytes |
| `executeTimeout` | 60 s | One `executeTransaction` |
| `expiryEvidence` | `"epochThenMiss"` | Whether a closed window may prove `NotApplied` (`"never"` behind a mixed-node load balancer) |
| `expiryMargin` / `reconcileRecheck` | 30 s / 2 s | The expiry rule's skew and its second observation |
| `awaitVisibility` / `visibilityTimeout` | `true` / 15 s | Wait for the execution to be readable before returning |
| `nonce` | a random `u32` | The nonce of a default `ValidDuring` expiration |

Lock-free runs from one sender can together overdraw a balance; a flow that
spends a balance to zero sets `lockSender: "always"`.

## The journal

`Journal` is the record of every signed transaction: `Tx.submit` writes
`Signed` before the first send and the terminal answer — `Executed`, `Failed`,
`NotApplied` — when it has one, or `Unknown` with the bytes. `Journal.get(digest)`
answers what it recorded for one digest. The default is process-wide memory; a
test provides `Journal.layerMemory`.

A long-lived service provides a durable one from
`@unconfirmed/sui-effect/journal`, over any `KeyValueStore`:

```ts
// Submissions that survive a crash: a durable journal, and a sweep of whatever the last run
// left unresolved before anything new is sent.
import { Effect, Layer } from "effect"
import type { KeyValueStore } from "effect/persistence"
import type { SuiAddress } from "@unconfirmed/sui-effect"
import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

// In production `KeyValueStore.layerFileSystem("./journal")` over a platform's `FileSystem` and
// `Path` (`BunServices.layer`); in a test `KeyValueStore.layerMemory`.
export const durableJournal = <E>(store: Layer.Layer<KeyValueStore.KeyValueStore, E>) =>
  layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(store))

export const payOnce = (signer: Signer, recipient: SuiAddress, amount: bigint) =>
  Effect.gen(function*() {
    yield* Tx.reconcileAll({ resubmit: true })
    const executed = yield* Tx.run(Tx.sendFunds({ amount, recipient }), { signer })
    return executed.digest
  })
```

`onUnresolved: "fail"` refuses to build while the store holds unsettled
entries; `"ignore"` leaves them for `Tx.reconcileAll()`, the explicit startup
call. Each entry is one key and several processes can share a prefix; a
settled entry carries a marker, so a listing reads only the unresolved ones.
`pruneSettled(before)` deletes settled entries older than a cutoff.

## Errors

Every failure is one flat `Schema.TaggedError`; there is no inheritance to
match on. `SuiError.outcome(error)` puts any value on the axis a caller acts
on.

| Tag | Outcome | Means |
|---|---|---|
| `TransportError` | `not_applied` | No usable answer; `retryable` says whether a read may try again |
| `ObjectNotFound` / `ObjectDeleted` / `ObjectUnavailable` | `not_applied` | The SDK's three object-error reasons |
| `TransactionNotFound` | `not_applied` | No transaction with that digest is known |
| `NetworkMismatch` | `not_applied` | The node is on another chain than expected |
| `DecodeError` | `not_applied` | BCS or a schema boundary did not decode; branch on `kind` (`"type"`, `"bytes"`, `"shape"`) |
| `SimulationFailed` | `not_applied` | The simulation reported an execution failure; no gas charged |
| `BuildError` / `PolicyDenied` / `SigningError` / `JournalError` | `not_applied` | Building; a policy (`maxGasBudget`, `preflight`, `alias.signer`, `sponsored.*`); signing; the journal write before the first send |
| `KeyError` | `not_applied` | A phrase, secret key, path or multisig member set that is not one |
| `GraphQLUnavailable` | `not_applied` | No usable GraphQL endpoint |
| `NotApplied` | `not_applied` | Provably never applied: `evidence` is `"expired"`, `"inputConsumed"` or `"refused"` |
| `ExecutionFailed` | `applied` | Applied on chain and failed; gas charged |
| `UnexpectedEffects` | `applied` | It ran, but the effects lack what the caller expected |
| `SubmissionUnknown` | `unknown` | Bytes may have been sent; carries them for `Tx.reconcile` or `Tx.resubmit` |

`SuiError.describe`, `toJson`, `isRetryable`, `isTaxonomy`, `digestOf`,
`moveAbort` and `isMoveAbort` take `unknown`, so a Promise `catch (e)` needs no
cast. An error of your own declares `outcome` (a class field is fine) and is
placed on the same axis. Match a Move abort on `module` and `constant`, not
`package`: after an upgrade the abort names the latest package id.

```ts
// Mapping a Move abort to your own error. Match on `module` and `constant` (or `code`), not on
// `package`: after an upgrade the abort's location names the LATEST package id.
import { Effect, Schema } from "effect"
import { type ObjectId, SuiError } from "@unconfirmed/sui-effect"
import { type Signer, Tx } from "@unconfirmed/sui-effect/tx"

const PKG = "0x00000000000000000000000000000000000000000000000000000000000000e5"

export class AlreadyClaimed extends Schema.TaggedError<AlreadyClaimed>()("AlreadyClaimed", {
  escrow: Schema.String,
  // A simulated abort charged nothing; an executed one did. Declare which, for `SuiError.outcome`.
  outcome: Schema.Literals(["applied", "not_applied"])
}) {}

export const claim = (signer: Signer, escrow: ObjectId) =>
  Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(escrow)] })
  }, { signer }).pipe(
    Effect.catchIf(
      (error) => SuiError.isMoveAbort(error, { module: "escrow", constant: "EAlreadyClaimed" }),
      (error) => new AlreadyClaimed({ escrow, outcome: error._tag === "ExecutionFailed" ? "applied" : "not_applied" })
    )
  )
```

Branch on `_tag` and `DecodeError.kind`, never on a message, whose wording
changes between releases.

## Metrics and tracing

Every public member opens a span named after itself (`SuiCore.getObject`,
`Tx.submit`, `Tx.withSenderLock`). A submission's spans carry `sui.digest`,
`sui.attempt` and `sui.outcome`; `Tx.build`'s carry `sui.simulated_by`,
`sui.gas_budget` and `sui.gas_payment`; `Tx.run`'s carries `sui.sender_lock`
(`held`, `build`, `none`) and, for an alias signer, `sui.signer_alias`.

Metrics go through Effect's `Metric` into the `Metric.MetricRegistry` in
context. **The names and attribute keys are a public contract**, and every
attribute value comes from a closed set — never a digest, address or coin type.

| Metric | Kind | Attributes |
|---|---|---|
| `sui_effect_tx_execute_attempts_total` | counter | — |
| `sui_effect_tx_submit_total` | counter | `result`: `executed`, `execution_failed`, `not_applied`, `submission_unknown`, `refused`, `journal_error` |
| `sui_effect_tx_lock_conflicts_total` | counter | — |
| `sui_effect_tx_reconcile_total` | counter | `result`; `evidence` on `not_applied` |
| `sui_effect_tx_visibility_wait` | timer (ms) | `result`: `visible`, `timeout`, `failed` |
| `sui_effect_tx_build_duration` | timer (ms) | `simulated_by`: `sdk`, `explicit` |
| `sui_effect_tx_build_gas_budget` | histogram (MIST) | — |
| `sui_effect_core_read_retries_total` | counter | `method`, `status` |
| `sui_effect_core_request_timeouts_total` | counter | `method` |
| `sui_effect_sender_lock_wait` | timer (ms) | — |

## Testing

`@unconfirmed/sui-effect/testing` ships `SuiCoreFake`, an in-memory chain, and
`layerTest(script)`, the real `Sui` over it, so a test exercises the
production tier with no network. `SuiTest` drives the fake's state and reads
back what it was sent; `SuiTest.provide(layer)` adds a fresh
`Journal.layerMemory` and `TestClock`, built locally.

```ts
// A test on the in-memory fake: the real `Sui` over a scripted `SuiCore`, no network.
import { expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import { Effect, Option } from "effect"
import { ObjectId, Sui, SuiSchema } from "@unconfirmed/sui-effect"
import { layerTest, SuiTest } from "@unconfirmed/sui-effect/testing"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const CounterBcs = bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() })
const Counter = SuiSchema.bcs(CounterBcs, `${PKG}::counter::Counter`)

test("a counter the fake serves decodes, and a missing one is None", async () => {
  const id = ObjectId.normalize("0xc0")
  const content = CounterBcs.serialize({ id, value: 7n }).toBytes()
  const [found, missing] = await Effect.gen(function*() {
    yield* SuiTest.putObject({ objectId: id, type: `${PKG}::counter::Counter`, version: 1n, content })
    const sui = yield* Sui
    return yield* Effect.all([sui.getObject(id, { schema: Counter }), sui.getObjectOption(ObjectId.normalize("0xc1"))])
  }).pipe(Effect.provide(layerTest()), Effect.runPromise)
  expect(found.content.value).toBe("7")
  expect(Option.isNone(missing)).toBe(true)
})
```

The fake models objects, coins, dynamic fields, the clock, the epoch,
**address balances** (`SuiTest.setAddressBalance`, executions charge gas,
debit withdrawals and follow deposits), **address alias sets**
(`FakeScript.addressAliases`, `SuiTest.setAddressAliases`; its signature check
resolves aliases the way a validator does) and the ledger reads. It runs no
Move and verifies no signature cryptographically; the localnet suites
(`SUI_LOCALNET=1`) cover what only a validator can. A service built on `Sui`
tests over `MyService.layer.pipe(Layer.provideMerge(layerTest(script)))`.

## Versions

| Package | Range | Tested against |
|---|---|---|
| `effect` | `>=4.1.1 <4.2` | `4.1.1`, in CI |
| `@mysten/sui` | `^2.28` | `2.30.0` and `2.38.0`, in CI |
| `@mysten/bcs` | `^2.1.3` | `2.1.3` |
| TypeScript | `5.9.x` to build | `5.9.3` |
| Bun | `1.4.x` | `1.4.2` |

The one direct dependency is `@scure/bip39` (`^2.3.0`, the range every
`@mysten/sui` in the peer range declares), for the checked recovery phrase.
`bun run check` is typecheck, build and tests.

## For agents

`LLMS.md` ships in the package: a "start here" section with the subpath map,
tested recipes, the error table, `SubmitConfig`'s defaults and the invariants,
then every public export with its signature and the error union its JSDoc
states, plus every example verbatim. `AGENTS.md` is the list of rules to read
before the code, and `DESIGN.md` the specification.

## Side by side

The same two tasks, once against the canonical `@mysten/sui` 2.38 SDK (a gRPC
client, the Core API, `Transaction`) and once against sui-effect. Both sides
are exercised in `test/examples.test.ts`, and this section is asserted to be
the literal text of the four files it quotes.

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
// `Signer.fromSecretKey` loads it on demand where it exists.
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
import { ObjectId, Sui, SuiSchema } from "../src/index.ts"
import { Signer, Tx } from "../src/tx.ts"

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
 * `KeyError` and `ConfigError`, plus `NetworkMismatch` from the layer.
 */
export const program = Effect.gen(function*() {
  const sui = yield* Sui
  const signer = yield* Effect.flatMap(Config.Redacted("SUI_PRIVATE_KEY"), Signer.fromSecretKey)
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
  const { BunRuntime } = await import("@effect/platform-bun")
  BunRuntime.runMain(program.pipe(Effect.provide(Sui.layerConfig)))
}
```

### What differs

- **Absence.** The SDK throws `ObjectError` and the reason (`notFound`,
  `deleted`, `unknown`) is read off the caught value by hand; sui-effect's
  `getObject` fails with `ObjectNotFound` / `ObjectDeleted` /
  `ObjectUnavailable`, three tags a caller can `catchTag`.
- **Wrong type.** The SDK compares `object.type` itself; sui-effect's bridge
  checks the Move type inside every `getObject`, generics included.
- **BCS.** Both hand a `BcsType` to a struct; sui-effect parses once, inside
  `getObject`, after the type check has passed.
- **Signing.** Both decode `SUI_PRIVATE_KEY` and dispatch on the scheme flag;
  sui-effect's version is `Signer.fromSecretKey`, one call.
- **Effects.** The SDK inspects `$kind` and `status.error` and joins
  `changedObjects` against `objectTypes` by hand; `expectCreated(type)` is
  that join, plus a check that exactly one match exists.
- **What sui-effect adds that neither SDK file has:** a default expiration
  bounded to the current epoch and the chain, a journal entry written before
  the first execute, re-sending identical signed bytes instead of rebuilding
  on a transient failure, `reconcile` when a submission's outcome is unknown,
  and a sender lock so two concurrent writes from one address cannot pick the
  same gas coin.
- **What it costs.** The sui-effect files run inside `Effect.gen`; a reader
  who does not already know Effect's vocabulary has that to learn first.

## License

MIT
