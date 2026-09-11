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

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
export interface EscrowService {
  /** The package this service reads and writes. */
  readonly packageId: string
  /**
   * The address the package collects fees at, read through the upstream SDK.
   *
   * Fails with: `DecodeError` (the upstream answer was not an address),
   * `TransportError`.
   */
  readonly feeCollector: Effect.Effect<SuiAddress, DecodeError | TransportError>
  /**
   * Reads one escrow object and decodes its content.
   *
   * Fails with: `EscrowNotFound` (no such object, or it was deleted),
   * `DecodeError` (it is not an escrow), `TransportError`.
   */
  readonly get: (id: ObjectId) => Effect.Effect<
    EscrowObject,
    EscrowNotFound | DecodeError | TransportError
  >
  /**
   * The commands that claim one escrow, as a recipe fragment.
   *
   * This is the composable half of the package: a consumer appends it to a
   * transaction that also carries other extensions' fragments and submits once.
   * Never fails; a recipe is synchronous, and `Tx.build` reports a recipe that
   * throws as a `BuildError`.
   */
  readonly claim: (escrow: EscrowObject) => Recipe
  /**
   * Claims one escrow on the signer's behalf and tells the operator about it.
   *
   * The signer is a parameter, never a layer field. The write goes through
   * `Tx.run`, so the journal, the expiration, the sender lock and reconcile all
   * apply.
   *
   * Fails with: `EscrowNotFound`, `DecodeError`, `TransportError`,
   * `BuildError`, `SimulationFailed`, `PolicyDenied`, `SigningError`,
   * `ExecutionFailed`, `NotApplied`, `SubmissionUnknown`, `JournalError`,
   * `UnexpectedEffects` (the claim applied but produced no receipt), and
   * `EscrowSettlementUnknown` when the claim is on chain but the operator never
   * confirmed it.
   */
  readonly claimFor: (
    id: ObjectId,
    opts: { readonly signer: Signer }
  ) => Effect.Effect<ChangedRef, ClaimForError>
  /** A namespace, which the Promise face maps recursively. */
  readonly owned: {
    /**
     * Every escrow an address owns, paginated.
     *
     * Fails with: `DecodeError`, `TransportError`.
     */
    readonly stream: (
      owner: SuiAddress
    ) => Stream.Stream<EscrowObject, DecodeError | TransportError>
    /**
     * How many escrows an address owns.
     *
     * Fails with: `DecodeError`, `TransportError`.
     */
    readonly count: (
      owner: SuiAddress
    ) => Effect.Effect<number, DecodeError | TransportError>
  }
}
```

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

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
export type ClaimForError =
  | EscrowNotFound
  | EscrowSettlementUnknown
  | DecodeError
  | UnexpectedEffects
  | RunError
```

### Identifiers and naming

The service identifier is `"<package>/<Name>"`. It is the runtime key every copy
of the module agrees on, so **it never changes after publication**. One service
per package unless there is a real reason for more.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
export class Escrow extends Context.Service<Escrow, EscrowService>()(
  "example-extension/Escrow"
) {
```

Mirror the names of the thing you wrap, the way sui-effect mirrors the SDK: a
consumer who knows the Move package should be able to guess your method names.
The property the extension takes on a client (`client.escrow`) is the `name` in
the registration, and it is part of your API too.

## 2. Errors and outcomes

Every failure is a `Schema.TaggedError` with fields a caller can act on, never a
bare message. Prefix the tag with the package name where a collision is
plausible — `EscrowNotFound` is a name two packages could both want.

<!-- from: examples/extension-template/src/errors.ts -->

```ts
export class EscrowNotFound extends Schema.TaggedError<EscrowNotFound>()(
  "escrow/EscrowNotFound",
  { escrowId: ObjectId }
) {
  readonly outcome: Outcome = "not_applied"
}
```

<!-- from: examples/extension-template/src/errors.ts -->

```ts
export class EscrowSettlementUnknown extends Schema.TaggedError<EscrowSettlementUnknown>()(
  "escrow/EscrowSettlementUnknown",
  { escrowId: ObjectId, digest: Digest, message: Schema.String }
) {
  readonly outcome: Outcome = "unknown"
}
```

`outcome` is the axis a wrapper script acts on: `"applied"` (it is on chain, gas
was charged, do not retry), `"unknown"` (reconcile before doing anything else),
`"not_applied"` (nothing happened, safe to retry). `SuiError.outcome` reads the
field off any error that declares one, and `Script.exitCode` maps the three to
exit 5, 3 and 4.

**Declare `outcome` on every error you define.** An extension error that does
not declare one is *unclassified*, and the two helpers answer differently on
purpose. `Script.exitCode` exits 1, the code that also means "defect", because
exit 3 would tell a wrapper there is a digest to reconcile and an unrecognised
error is not evidence that anything was ever sent. `SuiError.outcome` answers
`"unknown"`, because a tag it has never heard of is equally not evidence that
nothing happened — answering `"not_applied"` would tell the documented retry
idiom to send again. The `"not_applied"` default is for sui-effect's own
taxonomy, not for yours.

Do not invent an error for something the taxonomy already names. A node that
could not be reached is a `TransportError`; bytes that did not decode are a
`DecodeError`; a transaction that aborted on chain is an `ExecutionFailed`; a
transaction that applied but did not produce what you expected is an
`UnexpectedEffects`. Your own errors are for your own domain — policy, protocol
state, an operator service — and upstream failures are mapped into one or the
other.

**Never map an error onto one with a different outcome.** This is the mistake
worth naming: `UnexpectedEffects` says the transaction applied and gas was
charged, `TransportError` says nothing happened and a retry is safe. Mapping the
first onto the second tells a wrapper script to run the transaction again, and
the wrapper will. The same goes the other way: a `DecodeError` is a boundary
that was wrong, not a node that was unreachable, and dressing it as a
`TransportError` both loses the type that was expected and makes a declared
`DecodeError` unreachable. Map an error onto another only when the two say the
same thing about the chain.

## 3. Reads through `Sui`, writes through `Tx`

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const get = Effect.fn("Escrow.get")(function*(id: ObjectId) {
  return yield* sui.getObject(id, { schema: EscrowContent }).pipe(
    Effect.catchTag(
      ["ObjectNotFound", "ObjectDeleted"],
      () => Effect.fail(new EscrowNotFound({ escrowId: id }))
    ),
    Effect.catchTag(
      "ObjectUnavailable",
      (error) => Effect.fail(transport("escrow.get")(error))
    )
  )
})
```

`sui.getObject(id, { schema })` checks the object's Move type against the type
recorded on the codec before it parses a byte, so a wrong object is a
`DecodeError` naming both types rather than a confusing parse failure. Notice
which failures are translated and which are not: a missing or deleted escrow is
this package's `EscrowNotFound`, but `ObjectUnavailable` — the node could not
say what happened to it — is a transport problem and stays one.

Where you already have bytes — a `Stream` of envelopes, a dynamic field's value,
an event payload — `SuiSchema.decode(codec, bytes, { objectId?, expectedType? })`
is the same decode `getObject` does, and produces the same `DecodeError` naming
the object and the type. Use it instead of hand-rolling
`Schema.decodeUnknownEffect(...).pipe(Effect.mapError(...))`.

**An extension never calls `SuiCore.executeTransaction`.** Writes go through
`Tx.submit` or `Tx.run`, so that every transaction on the platform gets the
journal, the default expiration, the sender lock and reconcile. This is not a
style rule: `executeTransaction` inside an extension is how a crashed process
leaves a transaction nobody can account for.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const claimFor = Effect.fn("Escrow.claimFor")(function*(
  id: ObjectId,
  opts: { readonly signer: Signer }
) {
  const escrow = yield* get(id)
  const executed = yield* Tx.run(claim(escrow), { signer: opts.signer })
  // The transaction applied and gas was charged; what is missing is the
  // receipt. That is what `UnexpectedEffects` means, and `outcome` puts it
  // on "applied". Mapping it to `TransportError` would tell a wrapper the
  // opposite — nothing happened, retry — about a claim that ran.
  const receipt = yield* executed.expectCreated(RECEIPT_TYPE)
  yield* notify(id, executed.digest)
  return receipt
// `Tx.*` requires `Sui`, and the layer has one: providing it here is what
// keeps every member's requirement channel empty, which is what
// `SuiExtension.fromService` and every consumer expect.
}, Effect.provideService(Sui, sui))
```

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

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const claim = (escrow: EscrowObject): Recipe => (tx) => {
  tx.moveCall({
    target: `${packageId}::escrow::claim`,
    arguments: [tx.object(escrow.id), tx.pure.u64(escrow.content.amount)]
  })
}
```

A consumer composes fragments by calling them in order on one transaction:

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
test("the recipe fragment composes into a consumer's transaction", async () => {
  const commands = await provide(
    Effect.gen(function*() {
      const escrow = yield* Escrow
      const object = yield* escrow.get(ESCROW_ID)
      const tx = new Transaction()
      // A consumer composes fragments from several extensions and submits once.
      escrow.claim(object)(tx)
      escrow.claim(object)(tx)
      return tx.getData().commands
    })
  )
  expect(commands).toHaveLength(2)
  expect(commands[0]?.$kind).toBe("MoveCall")
})
```

Notice `claimFor`: the receipt comes from `executed.expectCreated(...)` with no
`mapError` at all. The claim is on chain and gas was charged; only the receipt is
missing, which is exactly what `UnexpectedEffects` means, and its outcome is
`"applied"`. Adding it to the member's declared union is the honest fix; mapping
it to something with outcome `"not_applied"` is not.

An extension submits on the consumer's behalf only when that is its purpose —
onara's sponsor-and-run, this template's `claimFor` — and when it does, it still
exposes the recipe-level pieces, so a consumer who wants one transaction instead
of two is not locked out.

## 5. Signers are parameters

An extension never holds a consumer's signer in its layer. It holds its own
credentials — a sponsor key, an API key — and takes the consumer's signer as an
argument, because a layer field cannot say *which* credential a call meant and
one process may legitimately hold two.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
export interface EscrowOptions {
  /** The published package id. */
  readonly packageId: string
  /** The operator's settlement service. */
  readonly url: string
  /** The extension's own credential — never the consumer's. */
  readonly apiKey: Redacted.Redacted<string>
}
```

## 6. Layers

Three of them, following the house convention: `layer(opts)` for the live one,
`layerConfig` for the environment, `layerTest` for tests. All three require
`Sui` and nothing else — an extension never constructs its own client, because
then the consumer's client and the extension's would be two connections with two
chain-identifier checks.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layer = (options: EscrowOptions): Layer.Layer<Escrow, never, Sui> =>
  Layer.effect(
    Escrow,
    make({
      packageId: options.packageId,
      api: settlementApi({ url: options.url, apiKey: Redacted.value(options.apiKey) })
    })
  )
```

`layerConfig` reads a prefixed namespace through `Config.nested`, and every
secret is `Config.redacted`, so it cannot reach a log line:

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layerConfig: Layer.Layer<Escrow, Config.ConfigError, Sui> = Layer.unwrap(
  Effect.gen(function*() {
    const options = yield* Config.all({
      packageId: Config.nonEmptyString("PACKAGE_ID").pipe(
        Config.withDefault(ESCROW_PACKAGE)
      ),
      url: Config.nonEmptyString("URL"),
      apiKey: Config.redacted("API_KEY")
    }).pipe(Config.nested("ESCROW"))
    return Escrow.layer(options)
  })
)
```

`layerTest` is the **real service** over a fake of whatever the extension owns
that is not Sui — here the operator's settlement service. It is not a mock of
the extension: a test must exercise the code that ships.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layerTest = (
  state: { readonly settled?: boolean } = {}
): Layer.Layer<Escrow, never, Sui> =>
  Layer.effect(
    Escrow,
    make({ packageId: ESCROW_PACKAGE, api: fakeApi(state.settled ?? true) })
  )
```

## 7. The Promise face

Never maintain a Promise API beside the Effect one; derive it.

<!-- from: examples/extension-template/src/extension.ts -->

```ts
export const escrow = (options: EscrowOptions) =>
  SuiExtension.fromService(Escrow, { name: "escrow", layer: Escrow.layer(options) })
```

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

Three things worth telling consumers. Until the first `await` the runtime does
not exist and neither does the member list, so a plain-value member reads as a
callable placeholder rather than as its value; after the first call,
`client.escrow.packageId` is the string. `fromService` is generic in the
registration name, so `client.escrow` is a property of the extended client's
type — no cast, and no `| undefined` under `noUncheckedIndexedAccess`. And
`dispose()` is not final: it releases what the layer acquired and forgets the
runtime, and the next call builds a fresh one, so dispose when the consumer is
done rather than between calls. Registering the same extension twice, or on two
clients, gives two independent runtimes and two layer builds.
`examples/extension-consumer.ts` in this repository shows both consumers of one
extension side by side.

## 8. Wrapping an upstream Promise package

For upstream SDKs we do not own (suins, deepbook, whatever comes next) we do not
lift their Promise surface generically. We maintain an Effect-native extension
per package, built to this contract, that depends on the upstream package for
its logic and hides it completely. There are exactly two shapes.

**A call that needs the SDK client object** goes through `sui.core.use`, which
runs the error mapper and forwards the `AbortSignal`:

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const feeCollector = sui.core
  .use((client, signal) => api.resolveFeeCollector(client, packageId, signal))
  .pipe(
    Effect.catchTag(
      ["ObjectNotFound", "ObjectDeleted", "ObjectUnavailable", "TransactionNotFound", "SimulationFailed"],
      (error) => Effect.fail(transport("escrow.feeCollector")(error))
    ),
    // Upstream answered with `unknown`; it becomes a sui-effect schema
    // before anything else in this package sees it. A value that does not
    // decode is a `DecodeError` and stays one: it says which boundary was
    // wrong, where `TransportError` would claim the node was unreachable.
    Effect.flatMap((raw) =>
      decodeAddress(raw).pipe(
        Effect.mapError((issue) =>
          new DecodeError({ expectedType: "SuiAddress", issue: issue.message })
        )
      )
    ),
    Effect.withSpan("Escrow.feeCollector")
  )
```

**A pure upstream helper** goes through `Effect.tryPromise` with a mapping
function — never a bare `catch: (cause) => cause`, which would put `unknown` in
your error channel — and with the signal forwarded, so interruption cancels the
request:

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const notify = Effect.fn("Escrow.notify")(function*(escrowId: ObjectId, digest: Digest) {
  const unknownOutcome = (message: string) =>
    new EscrowSettlementUnknown({ escrowId, digest, message })
  // A pure upstream helper: `Effect.tryPromise` with a mapping function,
  // and the signal forwarded so an interrupted claim cancels the request.
  const response = yield* Effect.tryPromise({
    try: (signal) => api.notifyClaim({ escrowId, digest }, signal),
    catch: (cause) => unknownOutcome(`the settlement service failed: ${String(cause)}`)
  })
  const settlement = yield* decodeSettlement(response).pipe(
    Effect.mapError((issue) =>
      unknownOutcome(`the settlement service answered something unreadable: ${issue.message}`)
    )
  )
  if (settlement.status !== "settled") {
    return yield* unknownOutcome("the settlement service is still holding the claim")
  }
})
```

In both cases the upstream answer is **narrowed to a sui-effect schema before
anything else sees it**. Upstream types are never re-exported: the template's
`src/upstream.ts` is absent from `src/index.ts`, and `SettlementResponse` never
reaches a consumer. That narrowing is what makes the wrapper worth having —
precise errors and stable types instead of whatever the upstream ships next
release.

## 9. Testing

`sui-effect/testing` is the whole harness. An extension's tests need nothing
else: no network, no HTTP mock, no hand-rolled client.

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
const provide = <A, E>(
  effect: Effect.Effect<A, E, Escrow | Sui | SuiCore | SuiCoreFake | TestClock.TestClock>,
  state: { readonly settled?: boolean } = {}
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(
        layerExtensionTest(Escrow.layerTest(state), script),
        // The program's own clock, for retries and timeouts. The chain's clock
        // is `SuiTest.setClock`.
        TestClock.layer(),
        // The default journal is a process-wide memory journal, so a test that
        // submits provides its own to stay isolated.
        Journal.layerMemory
      ),
      { local: true }
    )
  )
```

`layerExtensionTest(extensionLayer, script)` is the extension's layer over
`layerTest(script)`, which is the **real** `Sui` over the in-memory `SuiCore`.
So a test exercises the production high tier: the include sets, the BCS bridge,
the chunked batch reads, the sender lock and every `Tx` step.

The `script` is what the fake serves — objects with real BCS content, gas coins,
and scripted outcomes for simulate, execute and `getTransaction`:

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
const script = {
  objects: [escrowObject("5")],
  coins: [
    {
      objectId: padded("c01"),
      version: "2",
      digest: "11111111111111111111111111111111",
      type: `0x2::coin::Coin<0x2::sui::SUI>`,
      balance: "1000000000",
      owner,
      previousTransaction: null
    } as unknown as SuiClientTypes.Coin
  ],
  execute: [
    FakeOutcome.succeed({
      created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
      mutated: [{ objectId: ESCROW_ID, type: `${ESCROW_PACKAGE}::escrow::Escrow`, version: 4n, owner }]
    })
  ]
}
```

`SuiTest` drives the fake from inside an `Effect`: `putObject`, `bumpVersion`,
`deleteObject`, `setClock` (the chain's clock, which is what `Tx.build` bounds a
transaction against — Effect's `TestClock` drives the program's own time),
`scriptExecute` / `scriptSimulate` / `scriptGetTransaction`, and `calls` for
asserting what was actually sent.

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
test("claimFor submits once and returns the receipt", async () => {
  const { executes, receipt } = await provide(
    Effect.gen(function*() {
      const escrow = yield* Escrow
      const receipt = yield* escrow.claimFor(ESCROW_ID, { signer })
      const executes = yield* SuiTest.calls("executeTransaction")
      return { receipt, executes: executes.length }
    })
  )
  expect(String(receipt.id)).toBe(RECEIPT_ID)
  expect(String(receipt.type)).toBe(RECEIPT_TYPE)
  expect(executes).toBe(1)
})
```

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
test("the version the fake serves is the version the extension reads", async () => {
  const versions = await provide(
    Effect.gen(function*() {
      const escrow = yield* Escrow
      const before = yield* escrow.get(ESCROW_ID)
      yield* SuiTest.bumpVersion(ESCROW_ID)
      const after = yield* escrow.get(ESCROW_ID)
      return [before.version, after.version]
    })
  )
  expect(versions.map(Number)).toEqual([3, 4])
})
```

There are two clocks, and an extension test usually needs both. Effect's
`TestClock` drives the program's own time — every sleep, every retry schedule,
every `Effect.timeout` — so a test never waits. `SuiTest.setClock` moves the
chain's Clock object `0x6`, which is what `Tx.build` reads to bound a
transaction. Both are provided by the test's own layer, alongside
`Journal.layerMemory`: the default journal is a process-wide memory journal, and
a test that submits provides its own to stay isolated.

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
test("a retryable transport failure re-sends the identical bytes", async () => {
  const { attempts, bytes } = await provide(
    Effect.gen(function*() {
      const escrow = yield* Escrow
      yield* SuiTest.scriptExecute([
        FakeOutcome.transportError("UNAVAILABLE"),
        FakeOutcome.succeed({
          created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }]
        })
      ])
      // The resubmit schedule sleeps, so the test drives the clock rather
      // than waiting.
      const fiber = yield* Effect.forkChild(escrow.claimFor(ESCROW_ID, { signer }))
      yield* TestClock.adjust("1 minute")
      yield* Fiber.join(fiber)
      const sent = yield* SuiTest.calls("executeTransaction")
      return {
        attempts: sent.length,
        bytes: new Set(
          sent.map((call) =>
            String((call.options as { readonly transaction: Uint8Array }).transaction)
          )
        ).size
      }
    })
  )
  expect(attempts).toBe(2)
  // The same bytes both times: `Tx.submit` never rebuilds.
  expect(bytes).toBe(1)
})
```

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
| `decodeBcs(codec, schema, bytes)` | `SuiSchema.bcs(codec, expectedType)`, composed with a domain class through `Schema.decodeTo`, passed as `sui.getObject(id, { schema })`; for bytes you already have, `SuiSchema.decode(codec, bytes, { objectId?, expectedType? })` |
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

<!-- from: examples/extension-template/package.json -->

```json
"peerDependencies": {
  "@mysten/sui": "^2.28",
  "effect": ">=4.0.0-rc.112 <4.1",
  "sui-effect": ">=0.0.0"
},
"devDependencies": {
  "@mysten/bcs": "2.1.1",
  "@mysten/sui": "2.30.0",
  "@types/bun": "1.4.2",
  "effect": "4.0.0-rc.112",
  "typescript": "5.9.3"
}
```

`sui-effect`, `effect` and `@mysten/sui` are **peer** dependencies, with the
exact rcs pinned in `devDependencies`. Two copies of `effect` in one process
means two `Context.Service` identities and layers that silently do not match;
two copies of `@mysten/sui` means `instanceof` on its error classes fails.

`examples/extension-template/README.md` has the step by step: rename the
package, the service identifier and the registration name; drop the `paths`
block that resolves `sui-effect` inside this repository; replace the package id,
the BCS layouts and the Move targets; keep the shape.
