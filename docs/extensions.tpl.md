# Writing a sui-effect extension

Every downstream SDK we own is an **extension**: an Effect service built on
`Sui` and `Tx`, published as its own package, with a derived Promise face for
consumers who have an SDK client and no Effect. The extension mechanism is how
most consumers reach Sui, so it is a contract rather than an escape hatch, and
this guide is that contract.

Read it with `examples/extension-template/` open. The template is a complete,
typechecked, tested package, and **every code block below is copied verbatim
from it** — `test/extensions-guide.test.ts` fails if the two drift. Each block
names the file it came from.

## The shape in one paragraph

An extension is one `Context.Service` whose layer requires `Sui` and nothing it
could have built itself; whose every member returns an `Effect` with a closed
error union of sui-effect's taxonomy plus its own `Schema.TaggedError` classes;
whose contributions to a transaction are recipe fragments a consumer composes;
whose writes go through `Tx`, so the journal, the expiration, the sender lock
and reconcile apply to every transaction on the platform; whose credentials are
its own and whose signers are parameters; and whose Promise face is derived from
the service by `SuiExtension.fromService` rather than maintained beside it.

## 1. The service

The interface is the contract. Write it first, before any implementation: it is
what consumers, agents and `LLMS.md` read.

@@ src/Escrow.ts :: export interface EscrowService { :: }

What to notice:

- **No `Promise` anywhere**, and no `unknown` in an error channel. A member is
  an `Effect`, a function returning an `Effect`, a `Stream`, a plain value, or a
  nested object of those. Nothing else.
- **Every member states its error union in words** in its JSDoc ("Fails
  with: …"), the convention sui-effect itself follows, so the generated
  documentation and a reading agent agree with the compiler.
- **A nested namespace is a plain object.** Platform surfaces in the wild group
  dozens of members this way (`client.miso.protocol.*`); the Promise face maps
  them recursively, so group freely.
- **Long unions get a name.** `RunError` is the union `Tx.run` declares.

@@ src/Escrow.ts :: export type ClaimForError = :: | RunError

### Identifiers and naming

The service identifier is `"<package>/<Name>"`. It is the runtime key every copy
of the module agrees on, so **it never changes after publication**. One service
per package unless there is a real reason for more.

@@ src/Escrow.ts :: export class Escrow extends Context.Service<Escrow, EscrowService>()( :: ) {

Mirror the names of the thing you wrap, the way sui-effect mirrors the SDK: a
consumer who knows the Move package should be able to guess your method names.
The property the extension takes on a client (`client.escrow`) is the `name` in
the registration, and it is part of your API too.

## 2. Errors and outcomes

Every failure is a `Schema.TaggedError` with fields a caller can act on, never a
bare message. Prefix the tag with the package name where a collision is
plausible — `EscrowNotFound` is a name two packages could both want.

@@ src/errors.ts :: export class EscrowNotFound extends Schema.TaggedError<EscrowNotFound>()( :: }

@@ src/errors.ts :: export class EscrowSettlementUnknown extends Schema.TaggedError<EscrowSettlementUnknown>()( :: }

`outcome` is the axis a wrapper script acts on: `"applied"` (it is on chain, gas
was charged, do not retry), `"unknown"` (reconcile before doing anything else),
`"not_applied"` (nothing happened, safe to retry). `SuiError.outcome` reads the
field off any error that declares one, and `Script.exitCode` maps the three to
exit 5, 3 and 4.

**Declare `outcome` on every error you define.** An extension error that does
not declare one is *unclassified*: `Script.exitCode` cannot place a tag it has
never heard of and exits 1, the code that also means "defect". The
`"not_applied"` default that `SuiError.outcome` applies is for sui-effect's own
taxonomy, not for yours.

Do not invent an error for something the taxonomy already names. A node that
could not be reached is a `TransportError`; bytes that did not decode are a
`DecodeError`; a transaction that aborted on chain is an `ExecutionFailed`. Your
own errors are for your own domain — policy, protocol state, an operator
service — and upstream failures are mapped into one or the other.

## 3. Reads through `Sui`, writes through `Tx`

@@ src/Escrow.ts :: const get = Effect.fn("Escrow.get")(function*(id: ObjectId) { :: })

`sui.getObject(id, { schema })` checks the object's Move type against the type
recorded on the codec before it parses a byte, so a wrong object is a
`DecodeError` naming both types rather than a confusing parse failure. Notice
which failures are translated and which are not: a missing or deleted escrow is
this package's `EscrowNotFound`, but `ObjectUnavailable` — the node could not
say what happened to it — is a transport problem and stays one.

**An extension never calls `SuiCore.executeTransaction`.** Writes go through
`Tx.submit` or `Tx.run`, so that every transaction on the platform gets the
journal, the default expiration, the sender lock and reconcile. This is not a
style rule: `executeTransaction` inside an extension is how a crashed process
leaves a transaction nobody can account for.

@@ src/Escrow.ts :: const claimFor = Effect.fn("Escrow.claimFor")(function*( :: }, Effect.provideService(Sui, sui))

The last line is the detail that is easy to get wrong. `Tx.*` declares
`R = Sui`, and a service member must have **no requirements at all** — a
consumer yields your service and calls it. The layer already holds a `Sui`, so
provide it to the members that need one, as an extra argument to `Effect.fn`
rather than a `.pipe` on its result.

### Reaching `SuiCore`

`Sui` carries the `SuiCore` it was built over as `sui.core`, so an extension can
reach a method the opinionated tier does not expose — or the SDK client object
itself, through `sui.core.use` — without adding `SuiCore` to its own
requirements. Reach for it for a field `Sui` does not expose, and for nothing
else.

## 4. Recipe fragments versus submissions

A `Recipe` is `(tx: Transaction) => void`: synchronous, replayable, free of
dependencies. **An extension that adds commands to a transaction exposes
fragments, not submissions**, so a consumer can compose several extensions into
one programmable transaction and submit once.

@@ src/Escrow.ts :: const claim = (escrow: EscrowObject): Recipe => (tx) => { :: }

A consumer composes fragments by calling them in order on one transaction:

@@ test/escrow.test.ts :: test("the recipe fragment composes into a consumer's transaction", async () => { :: })

An extension submits on the consumer's behalf only when that is its purpose —
onara's sponsor-and-run, this template's `claimFor` — and when it does, it still
exposes the recipe-level pieces, so a consumer who wants one transaction instead
of two is not locked out.

## 5. Signers are parameters

An extension never holds a consumer's signer in its layer. It holds its own
credentials — a sponsor key, an API key — and takes the consumer's signer as an
argument, because a layer field cannot say *which* credential a call meant and
one process may legitimately hold two.

@@ src/Escrow.ts :: export interface EscrowOptions { :: }

## 6. Layers

Three of them, following the house convention: `layer(opts)` for the live one,
`layerConfig` for the environment, `layerTest` for tests. All three require
`Sui` and nothing else — an extension never constructs its own client, because
then the consumer's client and the extension's would be two connections with two
chain-identifier checks.

@@ src/Escrow.ts :: static readonly layer = (options: EscrowOptions): Layer.Layer<Escrow, never, Sui> => ::     )

`layerConfig` reads a prefixed namespace through `Config.nested`, and every
secret is `Config.redacted`, so it cannot reach a log line:

@@ src/Escrow.ts :: static readonly layerConfig: Layer.Layer<Escrow, Config.ConfigError, Sui> = Layer.unwrap( :: )

`layerTest` is the **real service** over a fake of whatever the extension owns
that is not Sui — here the operator's settlement service. It is not a mock of
the extension: a test must exercise the code that ships.

@@ src/Escrow.ts :: static readonly layerTest = ( :: )

## 7. The Promise face

Never maintain a Promise API beside the Effect one; derive it.

@@ src/extension.ts :: export const escrow = (options: EscrowOptions) => :: SuiExtension.fromService(Escrow, { name: "escrow", layer: Escrow.layer(options) })

`register(client)` does no work until the first call. Then it builds one
`ManagedRuntime` over `SuiCore.layerFromClient(client)`, `Sui.layerNoDeps` and
your layer, so the extension and the consumer share one transport and one
chain-identifier check. After that:

- an `Effect` member is a zero-argument method returning a `Promise`;
- a function returning an `Effect` keeps its arguments and returns a `Promise`;
- a `Stream` is an `AsyncIterable`, usable in `for await`;
- a nested namespace is mapped recursively;
- a plain value passes through;
- a rejection is **the same tagged error instance**, so a Promise consumer can
  still switch on `_tag` and read `outcome`;
- `dispose()` releases everything the layer acquired.

Two things worth telling consumers. Until the first `await` the runtime does not
exist and neither does the member list, so a plain-value member reads as a
callable placeholder rather than as its value; after the first call,
`client.escrow.packageId` is the string. And under `noUncheckedIndexedAccess`
the SDK types `$extend`'s result through an indexed access, so the registered
property arrives as possibly `undefined`; name it once
(`const api = client.escrow as NonNullable<typeof client.escrow>`) and move on.
`examples/extension-consumer.ts` in this repository shows both consumers of one
extension side by side.

## 8. Wrapping an upstream Promise package

For upstream SDKs we do not own (suins, deepbook, whatever comes next) we do not
lift their Promise surface generically. We maintain an Effect-native extension
per package, built to this contract, that depends on the upstream package for
its logic and hides it completely. There are exactly two shapes.

**A call that needs the SDK client object** goes through `sui.core.use`, which
runs the error mapper and forwards the `AbortSignal`:

@@ src/Escrow.ts :: const feeCollector = sui.core ::       )

**A pure upstream helper** goes through `Effect.tryPromise` with a mapping
function — never a bare `catch: (cause) => cause`, which would put `unknown` in
your error channel — and with the signal forwarded, so interruption cancels the
request:

@@ src/Escrow.ts :: const notify = Effect.fn("Escrow.notify")(function*(escrowId: ObjectId, digest: Digest) { :: })

In both cases the upstream answer is **narrowed to a sui-effect schema before
anything else sees it**. Upstream types are never re-exported: the template's
`src/upstream.ts` is absent from `src/index.ts`, and `SettlementResponse` never
reaches a consumer. That narrowing is what makes the wrapper worth having —
precise errors and stable types instead of whatever the upstream ships next
release.

## 9. Testing

`sui-effect/testing` is the whole harness. An extension's tests need nothing
else: no network, no HTTP mock, no hand-rolled client.

@@ test/escrow.test.ts :: const provide = <A, E>( ::   )

`layerExtensionTest(extensionLayer, script)` is the extension's layer over
`layerTest(script)`, which is the **real** `Sui` over the in-memory `SuiCore`.
So a test exercises the production high tier: the include sets, the BCS bridge,
the chunked batch reads, the sender lock and every `Tx` step.

The `script` is what the fake serves — objects with real BCS content, gas coins,
and scripted outcomes for simulate, execute and `getTransaction`:

@@ test/escrow.test.ts :: const script = { :: }

`SuiTest` drives the fake from inside an `Effect`: `putObject`, `bumpVersion`,
`deleteObject`, `setClock` (the chain's clock, which is what `Tx.build` bounds a
transaction against — Effect's `TestClock` drives the program's own time),
`scriptExecute` / `scriptSimulate` / `scriptGetTransaction`, and `calls` for
asserting what was actually sent.

@@ test/escrow.test.ts :: test("claimFor submits once and returns the receipt", async () => { :: })

@@ test/escrow.test.ts :: test("the version the fake serves is the version the extension reads", async () => { :: })

There are two clocks, and an extension test usually needs both. Effect's
`TestClock` drives the program's own time — every sleep, every retry schedule,
every `Effect.timeout` — so a test never waits. `SuiTest.setClock` moves the
chain's Clock object `0x6`, which is what `Tx.build` reads to bound a
transaction. Both are provided by the test's own layer, alongside
`Journal.layerMemory`: the default journal is a process-wide memory journal, and
a test that submits provides its own to stay isolated.

@@ test/escrow.test.ts :: test("a retryable transport failure re-sends the identical bytes", async () => { :: })

What a test file covers:

- the happy path of every member, through the real service;
- every error in a member's declared union, produced by the fake and asserted
  with `Effect.flip` and `instanceof`;
- what the extension *sent*, not only what came back (`SuiTest.calls`);
- anything time-dependent, under `TestClock` (the program's clock) or
  `SuiTest.setClock` (the chain's);
- the `outcome` of your errors, because that is what a script's exit code is.

## 10. Scripts and exit codes

A script that uses an extension provides its layer and yields the service:
`Script` brings `Sui` and `SuiCore`, which is everything an extension layer
requires. `examples/extension-consumer.ts` is that script end to end.

Because your errors declare an `outcome`, a script that fails inside your
extension exits with the code a wrapper can act on — 5 applied, 4 not applied,
3 unknown — with no handling lines anywhere.

## 11. Migrating a `@misofm/effect` package

The predecessor library and its consumers map onto sui-effect like this. The
conversion is mechanical except where the behaviour deliberately changed.

| `@misofm/effect` | sui-effect |
|---|---|
| `SuiClient.layer(client)` | `SuiCore.layerFromClient(client)` under `Sui.layerNoDeps`, which does the chain-id check `ready()` did by hand |
| `SuiGraphQL` | stays yours; sui-effect has no GraphQL layer |
| `ObjectNotFoundError` | `ObjectNotFound`, plus `ObjectDeleted` and `ObjectUnavailable` from the SDK's own `reason` |
| `ObjectTypeMismatchError` | `DecodeError { objectId, expectedType, issue }` from the bridge's normalized tag check |
| `SuiRpcError { operation }` | `TransportError { method }` |
| `BcsDecodeError` | `DecodeError` |
| `TransactionFailedError { digest, status }` | `ExecutionFailed { digest, reason, command, effects }` |
| `getObjectContent` | `sui.getObject(id)` — with no schema, `content` is the raw bytes |
| `getOptionalObjectContent` | `sui.getObjectOption` |
| `getObjectsContent` | `sui.getObjects` — chunked, integrity-checked, a per-item `Result` instead of silently dropping errored ids |
| `listDynamicFields` | `sui.streamDynamicFields` |
| `decodeBcs(codec, schema, bytes)` | `SuiSchema.bcs(codec, expectedType)`, composed with a domain class through `Schema.decodeTo`, passed as `sui.getObject(id, { schema })` |
| `assertObjectType` | folded into the bridge's tag check |
| `TxThunk` | `Recipe = (tx) => void` — every existing thunk is already synchronous |
| `buildTx(...thunks)` | compose recipes: `(tx) => { a(tx); b(tx) }`, then `Tx.build` |
| `signAndExecute` / `execThunks` | `Tx.run(recipe, { signer })`; the separate `waitForTransaction` is gone |
| `ExecResult` and its extractors | `Executed` with `created(type)`, `createdWhere(predicate)`, `packagesPublished()`, `balanceChange(address, coinType)`, `expectCreated` |
| a `register(client)` building a class of Promise methods | the service above plus `SuiExtension.fromService` |

Four behaviour changes to put in the conversion issues:

1. `getObjects` returns a per-item `Result`; ids that failed are no longer
   silently dropped.
2. `balanceChange` and `gasUsedTotal` are `bigint`, not `number`.
3. `created(type)` compares normalized struct tags; the substring matching of
   `createdByType` / `allCreatedByType` is `createdWhere(predicate)`.
4. `Tx.run` replaces sign-and-execute plus wait, and a transport failure once
   bytes may have been sent is a `SubmissionUnknown` carrying them, not a retry
   loop.

## 12. Review checklist

Reject an extension that:

- has a `Promise`, an `Error`, a `Cause` or an `unknown` anywhere in an
  interface or an error channel;
- calls `SuiCore.executeTransaction`, `signAndExecuteTransaction` or
  `waitForTransaction` instead of `Tx.submit` / `Tx.run`;
- holds a consumer's signer, or any per-call credential, in a layer;
- builds its own SDK client instead of requiring `Sui`;
- maintains a Promise facade by hand instead of deriving it with
  `SuiExtension.fromService`;
- defines an error without an `outcome`, or invents an error the taxonomy
  already names;
- leaves a requirement in a member's `R` instead of providing `Sui` inside the
  layer;
- exposes a submission where a recipe fragment would let consumers compose;
- re-exports an upstream package's types, or lets one reach a consumer
  undecoded;
- has a service without `layer`, `layerConfig` and `layerTest`, or a
  `layerTest` its own tests do not use;
- caches versioned on-chain state — an object reference, a version — in a layer;
- runs an Effect (`Effect.runPromise`, `runSync`, a `ManagedRuntime`) anywhere
  but the derived Promise face;
- reads `process.env` or `Date.now()` instead of `Config` and `DateTime`;
- ships a public member whose JSDoc does not state its error union in words.

The effect-ts skill's own checklist still applies underneath: v3 names,
`Effect.gen` returned from a plain arrow, throwing inside an Effect, mutable
module-level state, `run*` outside an entrypoint.

## 13. Copying the template

@@ package.json :: "peerDependencies": { :: } :: json

`sui-effect`, `effect` and `@mysten/sui` are **peer** dependencies, with the
exact rcs pinned in `devDependencies`. Two copies of `effect` in one process
means two `Context.Service` identities and layers that silently do not match;
two copies of `@mysten/sui` means `instanceof` on its error classes fails.

`examples/extension-template/README.md` has the step by step: rename the
package, the service identifier and the registration name; drop the `paths`
block that resolves `sui-effect` inside this repository; replace the package id,
the BCS layouts and the Move targets; keep the shape.
