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
  /** The package this service calls into. */
  readonly packageId: string
  /**
   * The package the types this service decodes were **first** published in,
   * which is what appears inside every Move type name. It is the same as
   * `packageId` until the package is upgraded.
   */
  readonly typeOrigin: string
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
per package unless there is a real reason for more — a composition over two
packages (section 8) is one.

A scoped package keeps its scope: `@misofm/partyos` names its service
`"@misofm/partyos/Partyos"`, not `"partyos/Partyos"`. The identifier is not a
JavaScript identifier and nothing parses it; what it has to be is unique, and
the published package name is the one string that already is.

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
  return yield* sui.getObject(id, { schema: content }).pipe(
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

### What the bridge takes, and where domain mapping goes

`SuiSchema.bcs(layout, type?)` takes a **`BcsType`** — a `@mysten/bcs` layout.
Generated `@mysten/codegen` output qualifies because its `MoveStruct`,
`MoveEnum` and `MoveTuple` extend `BcsStruct`, `BcsEnum` and `BcsTuple`, which
are `BcsType`s. A hand-rolled `{ parse(bytes) { … } }` does **not** qualify, and
that is deliberate: the bridge re-serializes what it parsed and compares the
length, which is what stops an `objectBcs` envelope from decoding as the struct
it wraps, and only a real layout can serialize.

So a codec that maps into your own domain types is a `BcsType` **composed with
`Schema.decodeTo`**, never a custom `parse`:

<!-- from: examples/extension-template/src/schema.ts -->

```ts
export const SettlementContent = (typeOrigin: string) =>
  SuiSchema.bcs(
    SettlementBcs,
    `${typeOrigin}::escrow::Settlement`
  ).pipe(
    Schema.decodeTo(
      Settlement,
      SchemaTransformation.transformOrFail<SettlementParts, typeof SettlementBcs.$inferType>({
        decode: (fields, options) =>
          // `transformOrFail`, not `transform`, because one of these mappings can
          // fail: a `u64` of milliseconds is not necessarily a time. A `transform`
          // whose body throws is a **defect**, which is not what a bad byte on the
          // wire should be; failing with a `SchemaIssue` here is what makes it a
          // `DecodeError` like any other.
          Effect.map(
            Effect.fromOption(
              DateTime.make(Number(fields.settled_at_ms)),
              () =>
                new SchemaIssue.InvalidValue(
                  { message: `settled_at_ms ${fields.settled_at_ms} is not a time` },
                  fields,
                  options
                )
```

The domain class is an ordinary `Schema.Class`:

<!-- from: examples/extension-template/src/schema.ts -->

```ts
export class Settlement extends Schema.Class<Settlement>("Settlement")({
  escrowId: ObjectId,
  settledAt: Schema.DateTimeUtc,
  claimedBy: SuiAddress
}) {}
```

**The halfway shape must be an explicit interface.** The transformation's source
type — what `decode` produces and `encode` consumes — is written out as its own
interface, as `src/schema.ts` does. Reaching for `typeof Settlement.Encoded` or
`typeof Settlement.Type` instead looks equivalent and is not: those name the
class's *own* two sides, which inverts the direction the transformation is being
inferred in, and the result does not compile — with an error about the wrong
side of the transformation, several frames away from the line that caused it.
Write the interface.

`decode` produces the target's field shape and the target schema does the rest,
so the `ObjectId` and `SuiAddress` brands are checked as part of the same
decode. Use `SchemaTransformation.transform` for a total mapping and
`transformOrFail` for one that can fail; a `transform` whose body *throws* is a
defect, and bad bytes deserve a failure. Either way a failure inside the domain
transform is still a **`DecodeError`** from `SuiSchema.decode` and from
`sui.getObject`, carrying the same `objectId` and `expectedType` — the domain
mapping is part of the boundary, not a step after it.

### Generic Move types

A Move type with type parameters is a different tag per instantiation:
`pkg::composition::Composition<0x…::share::Share>`. You do not write a codec per
instantiation. Give the bridge the **bare** tag —
`pkg::composition::Composition` — and it matches every instantiation of it,
comparing `address::module::name` only. Give it a tag that *carries* type
arguments and it is compared in full, after normalization, so
`Coin<0x2::sui::SUI>` does not accept `Coin<…::usdc::USDC>`.

The same rule holds everywhere a Move type is compared: the `expectedType`
option of `getObject` / `getObjectOption` / `getObjects`, `SuiSchema.decode`'s
`actualType`, the `type` filter of `streamOwnedObjects`, and the fake's filter
in tests. The object keeps the type it actually has on `SuiObject.type`, so an
extension that cares which instantiation it read can still look.

### Every type-shaped constant is a function of the package id

A Move type name **contains its package id**. So a codec, an owned-object
filter or a receipt type built from a module-level constant checks the wrong
type the moment a consumer configures a different package, and the symptom is
brutal: a correctly encoded object fails with `DecodeError`, and a claim that
applied on chain reports a missing receipt. The template derives all of them
from the id the service was built with:

<!-- from: examples/extension-template/src/schema.ts -->

```ts
export const escrowType = (typeOrigin: string): string =>
  `${typeOrigin}::escrow::Escrow`

/** The Move type of a claim receipt, which `claimFor` expects to be created. */
export const receiptType = (typeOrigin: string): string =>
  `${typeOrigin}::escrow::Receipt`

/**
 * `escrow::Escrow`, the object this extension reads, **as a function of the
 * package it lives in**.
 *
 * A Move type name contains its package id, so a codec built from a hard-coded
 * constant checks the wrong type the moment a consumer configures a different
 * package: `getObject(id, { schema })` compares the object's tag before it
 * parses a byte, and a correctly encoded object under the configured package
 * fails with `DecodeError`. Every type-shaped constant in an extension takes
 * the package id the service was built with, and the service passes its own.
 *
 * **Which package id.** The one that appears in a type name is the **type
 * origin**: the package the type was *first* published in. Upgrading a package
 * gives it a new id for *calls*, and the type origin does not move. So an
 * extension over an upgraded package carries two ids — `packageId` for
 * `moveCall` targets, `typeOrigin` for codecs, filters and receipt types — and
 * they are the same value until the first upgrade. `Escrow.layer` takes both.
 */
export const EscrowContent = (typeOrigin: string) => SuiSchema.bcs(
  EscrowBcs,
  escrowType(typeOrigin)
)
```

**Which id, though.** The one inside a type name is the **type origin**: the
package the type was *first* published in. Upgrading a package gives it a new id
for `moveCall` targets and leaves every type name pointing at the original. So
an extension over an upgradeable package carries two: `packageId` for calls,
`typeOrigin` for codecs, filters and expected types. They are the same value
until the first upgrade, which is why `EscrowOptions.typeOrigin` defaults to
`packageId`.

### Bytes you already have

Where you already have bytes — a `Stream` of envelopes, a dynamic field's value,
an event payload — `SuiSchema.decode(codec, bytes, { objectId?, expectedType?, actualType? })`
is the same decode `getObject` does, and produces the same `DecodeError` naming
the object and the type. Use it instead of hand-rolling
`Schema.decodeUnknownEffect(...).pipe(Effect.mapError(...))`. Pass `actualType`
when you know the type the bytes came from and the tag check runs here too:

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
const stream = (owner: SuiAddress) =>
  sui.streamOwnedObjects(owner, { type: ownedFilter }).pipe(
    Stream.mapEffect((object) =>
      // `SuiSchema.decode` is the same decode `sui.getObject({ schema })`
      // does, for the places that already have bytes. Bytes that do not
      // decode are a `DecodeError` naming the object and the type — not a
      // transport failure, which is what a node that could not be reached
      // is.
      SuiSchema.decode(content, object.content, {
        objectId: object.id,
        // The type the object actually has. Give it and `SuiSchema.decode`
        // runs the same tag check `getObject` does, under the same rule: a
        // bare expected tag matches every instantiation of it, a
        // parameterized one is compared in full.
        actualType: object.type
      }).pipe(Effect.map((content): EscrowObject => ({ ...object, content })))
    )
  )
```

`expectedType` on `SuiSchema.bcs` is **optional**, and there are two cases that
have no tag to compare. A Move **return value**: `sui.view(recipe,
bcs.Address())` takes a bare `@mysten/bcs` layout, so nothing has to invent a
type for a codec that will never meet an object. And an **event payload** whose
Move type contains a package id the decoder does not know — an event decoder is
usually written once and used against whatever package the deployment
configured, so `SuiSchema.bcs(layout)` with no expected type is the intended
shape for events, not a shortcut. What still guards those bytes is the
re-serialize check the bridge always runs: a layout that parsed but whose
re-serialization is a different length is rejected, which is what stops an
envelope decoding as the struct it wraps.

### Never `.make` a branded value from unvalidated input

`ObjectId.make`, `SuiAddress.make`, `StructTag.make` and friends **validate and
throw**. They are for a literal you wrote yourself, or a value that has already
been through a schema. A string that came from a node, a config file, a user or
an upstream package goes through `Schema.decodeUnknownEffect(ObjectId)` and
becomes a typed `DecodeError`; `.make` on it is a defect in a member whose error
union says it cannot fail.

They also validate rather than normalize: `SuiAddress.make("0x1")` throws,
because `0x1` is not a 32-byte address. Normalize first
(`normalizeSuiAddress`) or write the padded form.

When the error you would build *needs a field you do not have* — a `DecodeError`
wants an `objectId` and you are decoding an event payload with no object — that
is the signal to declare your own error, or to return an `Option`, rather than
to invent a value to satisfy the schema.

### Dynamic fields, and the types their keys may be

`sui.streamDynamicFields(parent)` pages a parent's fields; there is no key
filter, because the node has none, so a caller filters the stream on
`entry.name.type`. Do that with **`SuiSchema.matchesType(expected, actual)`**,
which is the one Move-type rule this package uses everywhere and is safe on any
string:

<!-- inline -->

```ts
import { Stream } from "effect"
import { SuiSchema } from "sui-effect"

const shares = sui.streamDynamicFields(parentId).pipe(
  Stream.filter((entry) => SuiSchema.matchesType(shareKeyType, entry.name.type)),
  Stream.mapEffect((entry) =>
    SuiSchema.decode(ShareValue, entry.value.bcs, { actualType: entry.valueType })
  )
)
```

Do **not** reach for the SDK's `normalizeStructTag` here. A dynamic-field key is
legally a primitive — `u64`, `bool`, `address`, `vector<u8>` — and
`normalizeStructTag` throws on every one of them, so the obvious filter dies as
a defect on the first `u64` key in somebody's table.

A note on `Stream`: **`Stream.runCollect` returns a plain `Array` in Effect v4**,
not a `Chunk`. `.length` and `[0]` work; `Chunk.toReadonlyArray` does not exist
for it.

### Absence, and batch reads

Absence is not always an error. `sui.getObjectOption(id, { schema })` is `None`
for a missing or deleted object, and an extension whose domain says "there may
be no profile yet" is right to return `Option` (or `null`, at a Promise
boundary) rather than inventing a `NotFound` error. Reserve an error for the
case where the caller asked for something that must exist.

`sui.getObjects(ids, opts)` returns a per-item `Result`, because one missing id
out of fifty is not a failed read. Two idioms, and you should pick deliberately:

- **soft** — the ones that are there are the answer:
  `results.filter(Result.isSuccess).map((result) => result.success)`, or
  `Result.getOrElse(result, () => fallback)` per item, or a `Map` keyed by id so
  a caller can ask about one;
- **hard** — every id must be there: `sui.getObjectsOrFail(ids, opts)`, which
  fails with the first item's error (`ObjectNotFound`, `ObjectDeleted`,
  `ObjectUnavailable` or `DecodeError`) and otherwise hands back the objects in
  the order of the ids.

Return the `Result` array to *your* consumers only when they can act on it;
otherwise pick one of the two above inside the extension and declare what you
picked in the member's error union.

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
  const created = yield* executed.expectCreated(receipt)
  yield* notify(id, executed.digest)
  return created
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

`Recipe` is the **top-level** draft type: what `Tx.build`, `Tx.run` and
`sui.simulate` take. A *fragment* need not return `void` — the common shape for
an object model is a fragment that returns the builder arguments it created, so
a later command can consume them:

```text
const createComposition = (tx: Transaction) => {
  const [composition, cap] = tx.moveCall({ target: `${pkg}::composition::new`, arguments: [] })
  return { composition, cap }
}
```

`(tx) => A` is assignable to `Recipe` because TypeScript ignores a return value
where `void` is expected, so such a fragment is still usable as a top-level
recipe — but that is a convenience, not the contract. Say in your own types
which functions are fragments returning arguments and which are recipes.

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
  /** The published package id, which is what `moveCall` targets name. */
  readonly packageId: string
  /**
   * The type origin: the package the Move **types** were first published in,
   * which is what appears inside `pkg::escrow::Escrow`.
   *
   * Defaults to `packageId`, which is right until the package is upgraded —
   * an upgrade gives the package a new id for calls and leaves every type name
   * pointing at the original. Set it then, and codecs, owned-object filters and
   * the receipt type keep checking the type that exists.
   */
  readonly typeOrigin?: string
  /** The operator's settlement service. */
  readonly url: string
  /** The extension's own credential — never the consumer's. */
  readonly apiKey: Redacted.Redacted<string>
}
```

**A sponsored write needs two of them.** When the transaction's gas owner is not
its sender, both parties sign; one signature on such bytes is something a
validator rejects outright. `Tx.run(recipe, { signer, gasOwner, sponsor })`
takes the sponsor's `Signer` and co-signs, and refuses with `SigningError` —
before anything is built — when a gas owner has no sponsor to go with it. The
same check runs on the addresses read back out of the built bytes, so a recipe
that set its own gas owner (anything built with `Tx.sponsored`) is caught too.
An extension whose two parties cannot both sign in one process — the sponsor is
a remote service, the sender is a wallet — uses the explicit lifecycle instead:
`Tx.build`, `Tx.sign`, hand the bytes over, `Tx.cosign`, `Tx.submit`.

## 6. Layers

Following the house convention: `layer(opts)` for the live one, `layerConfig`
for the environment, `layerTest` for tests, and — for an extension over a
published Move package — `layerBundled`, which picks the deployment from the
network the client is already on.

The rule is **not** "requires `Sui` and nothing else". It is: *requires nothing
the consumer's client could have provided*. `SuiExtension.fromService` accepts a
`Layer<Self, E, Sui | SuiCore>` and builds both tiers over the client `$extend`
was called on, so an extension never constructs its own client — two clients
would mean two connections and two chain-identifier checks. Anything else your
layer needs — an `HttpClient`, a `SuiGraphQL`, another extension's service — you
provide **inside** your layer (or in the function that builds the registration),
so what comes out still fits the bound. Section 8 shows that with a second
service; the shape is `Layer.effect(Self, make).pipe(Layer.provide(Dependency.layer(…)))`.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layer = (options: EscrowOptions): Layer.Layer<Escrow, never, Sui> =>
  Layer.effect(
    Escrow,
    make({
      packageId: options.packageId,
      ...(options.typeOrigin === undefined ? {} : { typeOrigin: options.typeOrigin }),
      api: settlementApi({ url: options.url, apiKey: Redacted.value(options.apiKey) })
    })
  )
```

`layerConfig` reads a prefixed namespace through `Config.nested`, and every
secret is `Config.redacted`, so it cannot reach a log line. **Every value that
has a schema is read through it**, with `Config.schema(ObjectId, "PACKAGE_ID")`
rather than `Config.nonEmptyString`: an override that is not an object id then
fails where it was set, naming the variable, instead of being carried into every
`moveCall` target and every codec and surfacing three calls later as a Move
abort nobody can trace back to an environment variable. The template has a test
for the malformed case; so should you.

Two things not to promise in the docs you write around it. `Config.option` turns
an **empty** variable into "unset", so `FOO=""` takes the default rather than
failing — do not write "an empty value is a `ConfigError`" above a
`Config.option`. And `Effect.withConfigProvider` does not exist in Effect v4
rc.112: a test provides the provider like anything else, with
`ConfigProvider.layer(ConfigProvider.fromEnvRecord({ … }))` or
`Effect.provideService(effect, ConfigProvider.ConfigProvider, provider)`.

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layerConfig: Layer.Layer<Escrow, Config.ConfigError, Sui> = Layer.unwrap(
  Effect.gen(function*() {
    const options = yield* Config.all({
      packageId: Config.schema(ObjectId, "PACKAGE_ID").pipe(
        Config.withDefault(ObjectId.make(ESCROW_PACKAGE))
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

An extension that owns nothing but `Sui` has nothing to fake, and then
`layerTest = layer(fixedDeployment)` — a package id and no more. That degenerate
case is expected, not a smell: the harness in section 10 fakes the chain, the
extension's own layer has nothing left to fake, and the checklist's "a
`layerTest` its own tests do not use" is about a `layerTest` nobody exercises,
not about one that is thin.

### A layer that picks a bundled deployment

A package id is per network, and a consumer who has already chosen a network by
building a client should not have to carry a table of them. `Layer.unwrap` lets
a layer read `Sui` before deciding which layer to be:

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
static readonly layerBundled = (
  options: { readonly apiKey: Redacted.Redacted<string> }
): Layer.Layer<Escrow, EscrowUnsupportedNetwork, Sui> =>
  Layer.unwrap(
    Effect.gen(function*() {
      const sui = yield* Sui
      const deployment = DEPLOYMENTS[sui.network]
      if (deployment === undefined) {
        return yield* new EscrowUnsupportedNetwork({ network: sui.network })
      }
      return Escrow.layer({ ...deployment, apiKey: options.apiKey })
    })
  )
```

<!-- from: examples/extension-template/src/Escrow.ts -->

```ts
export const DEPLOYMENTS: Readonly<Record<string, EscrowDeployment>> = {
  testnet: { packageId: ESCROW_PACKAGE, url: "https://settlement.testnet.example" },
  mainnet: { packageId: ESCROW_PACKAGE, url: "https://settlement.example" }
}
```

A network with no entry is a **typed failure** of your own — here
`EscrowUnsupportedNetwork`, outcome `not_applied` — not an `undefined` package
id that surfaces as a Move abort three calls later. This is what a predecessor's
`DeploymentError` becomes.

<!-- from: examples/extension-template/src/errors.ts -->

```ts
export class EscrowUnsupportedNetwork extends Schema.TaggedError<EscrowUnsupportedNetwork>()(
  "escrow/EscrowUnsupportedNetwork",
  { network: Schema.String }
) {
  readonly outcome: Outcome = "not_applied"
}
```

And when the only configuration *is* the package id, `layerBundled` is the layer
to ship and `layerConfig` is the override: something for a private deployment, a
package under test, a credential the table cannot hold. `layerConfig` earns its
place when configuration carries more than the network already implies — it is
not a rule that every extension must read an environment variable.

## 7. The Promise face

Never maintain a Promise API beside the Effect one; derive it.

<!-- from: examples/extension-template/src/extension.ts -->

```ts
export const escrow = (options: EscrowRegistrationOptions) =>
  SuiExtension.fromService(Escrow, {
    name: "escrow",
    layer: Escrow.layer(options),
    warm: options.chainId === undefined ? {} : { chainId: options.chainId }
  })
```

`register(client)` does no work until the first call. Then it builds one
`ManagedRuntime` over your layer and a **base shared per client** —
`SuiCore.layerFromClient(client)` plus `Sui.layerNoDeps` — so the extension and
the consumer share one transport and one chain-identifier check, and so do two
different extensions on the same client. After that:

- an `Effect` member is a zero-argument method returning a `Promise`;
- a function returning an `Effect` keeps its arguments and returns a `Promise`;
- a `Stream` is an `AsyncIterable`, usable in `for await`;
- a nested namespace is mapped recursively;
- a plain value passes through;
- a rejection is **the same tagged error instance**, so a Promise consumer can
  still switch on `_tag` and read `outcome`;
- `dispose()` releases everything the layer acquired.

### Synchronous members, `$ready` and `warm`

This is the part that bites. `PromiseFace` types an `Effect` member as
Promise-returning and leaves everything else alone: a recipe builder
`(p: Params) => Recipe` is still `(p: Params) => Recipe` on the face, and
`packageId` is still a `string`. But **until the runtime exists there is no
service object**, so nothing knows what a member is, and a placeholder is not a
`Recipe` and not a string.

An `Effect` member and a `Stream` member both work cold, because the face
promises a `Promise` for one and an `AsyncIterable` for the other and a cold
call can be both at once: what it returns is a thenable *and* an async iterable,
so `await client.status()` and `for await (const x of client.owned.stream(a))`
are each right before anything has been awaited.

So a synchronous member used before the runtime exists fails with
`ExtensionNotReady`, naming itself — a value read as a string throws, a
synchronous call rejects — instead of quietly handing back a `Promise` where the
type says `Recipe`. (That is the bug worth naming: the old behaviour worked on
the *second* call, once the member had become real, so it survived review and
broke in production.) Two cures, both yours to choose:

- **`await client.<name>.$ready()`** once after `$extend`. It builds the runtime
  and resolves the service; every member is the real thing from then on. It is
  idempotent and free after the first time.
- **`warm`**, which does the same synchronously inside `register`, so the
  consumer has to do nothing at all:

<!-- from: examples/extension-template/src/Platform.ts -->

```ts
export const platform = (options: PlatformRegistrationOptions) =>
  SuiExtension.fromService(Platform, {
    name: "platform",
    layer: Platform.layer(options),
    warm: options.chainId === undefined ? {} : { chainId: options.chainId }
  })
```

`warm` has two conditions and both are enforced. The layer must not perform an
asynchronous step — a layer that reads the network at build cannot be built
synchronously and `register` throws. And the chain identifier is **taken, not
read**: `warm.chainId`, or `sui.chainId`, or the built-in entry for `mainnet`
and `testnet`; on `devnet`, `localnet` or a custom network, `warm` without a
`chainId` throws rather than guess.

Be precise about what "taken, not read" costs. The node is not asked at
registration, and it is **not asked later either**: the pinned id is what
`Sui.chainId` reports for the life of the registration, and the first time the
node is consulted at all is the extension's own first call — which does not
check the identifier. So a `warm` registration never detects a node on another
chain. What catches it is the chain itself: `Tx.build` stamps that id on the
transaction's expiration and a validator refuses bytes signed for another chain.
Register lazily when the assertion is what you want.

**Thread the chain id through your registration options**, the way
`src/extension.ts` and `src/Platform.ts` both do, rather than relying on the
built-in table. It is what makes the face work on `devnet` and `localnet`, and
it is what lets every registration on one client agree — see the next
paragraph. The template has a test for the warm face on a network with no
built-in chain id; a conversion should have one too.

If your extension's surface is entirely `Effect` and `Stream` members, none of
this applies: the lazy default is right and the first `await` builds everything.

### Non-plain values are leaves, and plain ones are not

The face maps plain object literals recursively and passes everything else
through: a `BcsType`, a `Schema.Class` instance, a `Date` — anything with a
prototype of its own — arrives whole, in the type and at runtime alike. So
exposing a codec or a domain class as a member is safe, and a "namespace" must
be a plain object literal to be mapped as one.

The other half of that rule is the trap. A **plain-object value** member —
`deployment: { packageId }` — is indistinguishable from a namespace of members,
so the type maps it as the value while the **cold** face treats it as a
namespace and hands back a placeholder for `deployment.packageId`. Reading that
placeholder throws `ExtensionNotReady` naming the path, so the disagreement is
typed and named rather than silent, but it is still a disagreement. Either
register `warm` (or `await $ready()`), or expose the value through an `Effect`
member, or give it a prototype of its own. Do not put a plain-object value
member on a service that consumers will register lazily.

### The rest of the contract

`fromService` is generic in the registration name, so `client.escrow` is a
property of the extended client's type — no cast, and no `| undefined` under
`noUncheckedIndexedAccess`. `options.sui` pins the chain identifier the node
must report, which is how an extension whose deployment names a custom network's
`chainIdentifier` refuses to run against another chain. And `$dispose()` (still
available as `dispose()`) is not final: it releases what the layer acquired and
forgets the runtime, and the next call builds a fresh one, so dispose when the
consumer is done rather than between calls. Registering the same extension
twice, or on two clients, still gives two independent runtimes and two layer
builds — two copies of whatever *your* layer holds.

**The base is shared per client per chain id, and it matters more than it
sounds.** `Sui` owns the sender lock: one semaphore per address, which is what
stops two `Tx.run`s from selecting the same gas coin. When each registration
built its own `Sui`, two extensions on one client had two lock maps and could do
exactly that, and "register each extension once" did not help.

Every registration on one client whose **effective chain id** is the same —
`warm.chainId`, else `sui.chainId`, else the built-in entry for the network —
shares one `Sui`, one transport and one lock map. The key is the chain, not the
registration's style, so a `warm` registration and a lazy one on the same chain
do share; keying them apart is how the template's own pair used to end up with
two lock maps. A registration that pins a *different* chain id is asking for a
different `Sui` and gets one, on purpose.

Because a `warm` registration has to build synchronously, the shared base for a
known chain id is the **pinned** one, and a lazy registration joining it
performs its own `getChainIdentifier` assertion as one extra layer — run once
however many lazy registrations join, so nothing is lost and nothing is
duplicated.

So: **register every extension on a client the same way and with the same chain
id**, or accept two of everything. It is reference counted: the base is built by
the first registration that needs it and released when the **last** one is
disposed, so `$dispose()` on one extension never tears the transport out from
under another.
`examples/extension-consumer.ts` in this repository shows both consumers of one
extension side by side.

## 8. Composing extensions

A platform SDK is rarely one Move package. It is a service per package, plus a
service on top that consumers actually hold, and the top one exposes the others
as **namespaces** — `client.platform.escrow.get(id)` — rather than making a
consumer register three extensions and remember which is which.

Two rules make that work, and both are in one file:

<!-- from: examples/extension-template/src/Platform.ts -->

```ts
export interface PlatformService {
  /**
   * The escrow package's whole surface, as a namespace.
   *
   * It is the dependency service's own object, unchanged: no wrapper methods to
   * keep in step, and the Promise face maps it recursively, so
   * `client.platform.escrow.get(id)` works for a Promise consumer exactly as
   * `platform.escrow.get(id)` does for an Effect one.
   */
  readonly escrow: EscrowService
  /**
   * One operation that spans the packages this platform composes.
   *
   * The error union is the composition's: this package's own errors plus
   * whatever the packages underneath declare. Nothing is swallowed and nothing
   * is widened.
   *
   * Fails with: `EscrowNotFound`, `EscrowSettlementUnknown`, `DecodeError`,
   * `UnexpectedEffects`, and everything `Tx.run` declares.
   */
  readonly claimEverything: (
    ids: ReadonlyArray<ObjectId>,
    opts: { readonly signer: Signer }
  ) => Effect.Effect<ReadonlyArray<ChangedRef>, ClaimForError>
}
```

The dependency's service object is exposed **as it is**. There are no wrapper
methods to keep in step, and the Promise face maps a plain object of members
recursively, so `client.platform.escrow.get(id)` works for a Promise consumer
exactly as `platform.escrow.get(id)` does for an Effect one.

<!-- from: examples/extension-template/src/Platform.ts -->

```ts
static readonly layer = (options: PlatformOptions): Layer.Layer<Platform, never, Sui> =>
  Layer.effect(Platform, make).pipe(Layer.provide(Escrow.layer(options)))
```

`Layer.provide(Escrow.layer(options))` is the second rule. The composition's own
construction requires `Escrow`; providing it here means the layer that comes out
requires only `Sui`, which is what `SuiExtension.fromService` can satisfy from
the consumer's client. An extension's dependencies are provided inside its
layer — the consumer never learns they exist.

Two services in one package is exactly the case the "one service per package"
rule allows for: the second one is the composition. Keep the dependency
published and usable on its own, so a consumer who wants only that package is
not forced to take the platform.

The same shape holds for a dependency that is not an extension at all — a
`SuiGraphQL` client, an `HttpClient`, your own operator service: yield it in
`make`, provide its layer in `layer`.

## 9. Wrapping an upstream Promise package

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

### If your extension reads GraphQL

`SuiGraphQL` is a tag over the SDK's own client, not a wrapper, and
`SuiGraphQL.query(run, method?)` is the one call that sorts out the two
failures:

<!-- inline -->

```ts
import { SuiGraphQL } from "sui-effect"

const chainId = SuiGraphQL.query(
  (client) => client.query({ query: "{ chainIdentifier }", variables: {} }),
  "chainIdentifier"
)
// Effect<…, GraphQLUnavailable | TransportError, SuiGraphQL>
```

A rejection from `SuiGraphQL.layerUnavailable` is already a
`GraphQLUnavailable` and is passed through unchanged; anything else becomes
`TransportError.fromUnknown(method, cause)`. Deriving that by hand in every
member is how the passthrough gets forgotten and "there is no endpoint
configured" arrives as an unclassified transport failure.

## 10. Testing

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

### Your own fake beside the harness

`layerExtensionTest` composes: the first argument is *your* layer, and your
layer is free to carry a fake of its own. The template's `Escrow.layerTest`
holds an in-memory settlement service; a platform composed over it carries the
same fake one level down:

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
test("the dependency's surface is a namespace on the composition", async () => {
  const amount = await Effect.runPromise(
    Effect.provide(
      Effect.flatMap(Platform, (platform) => platform.escrow.get(ESCROW_ID)),
      Layer.mergeAll(
        // The composition's own test layer over the harness: one fake for the
        // chain, and the dependency's own fake for its operator service.
        layerExtensionTest(Platform.layerTest({ settled: true }), script),
        Journal.layerMemory
      ),
      { local: true }
    ).pipe(Effect.map((escrow) => escrow.content.amount))
  )
  expect(amount).toBe("5")
})
```

So an extension with a `SuiGraphQL` dependency provides
`SuiGraphQL.layer(fakeClient)` (or `SuiGraphQL.layerUnavailable`, to test the
path where there is no endpoint) inside its own `layerTest`, and the harness
keeps serving the chain. One fake per thing that is not the chain; the chain is
the harness's.

### What the fake does and does not do

- **Its client supports `$extend`.** `SuiCoreFake`'s handle exposes `client`, a
  `ClientWithCoreApi` that implements `$extend`, so a derived Promise face can
  be tested exactly the way a consumer writes it — `fake.client.$extend(escrow(options))`
  — with no network.
- **`getDynamicField` matches on `name.type` *and* `name.bcs`.** An entry
  scripted without `bcs` still matches any key of its type, which is what a test
  that only cares about the type wants; two entries of the same type on one
  parent are told apart by their bytes, so a test **can** prove which key
  encoding a lookup used.
- **Call recording is reached through `SuiTest.calls`**, not off the fake
  handle: `yield* SuiTest.calls("getDynamicField")` gives every call in order
  with the options it was sent.
- **A scripted `commandResults` entry may leave an array out.**
  `SuiClientTypes.CommandResult` requires both `returnValues` and
  `mutatedReferences` on the wire, and a missing one defaults to `[]` here. A
  complete entry for a `sui.view`:

  <!-- inline -->

  ```ts
  FakeOutcome.succeed({
    commandResults: [{ returnValues: [{ bcs: Address.serialize(owner).toBytes() }] }]
  })
  ```

  Before the default, omitting `mutatedReferences` failed the whole `Simulation`
  decode with an issue naming a field the test never mentioned.
- **`getTransaction` can be answered by digest.** `FakeScript.transactions`
  (and `SuiTest.recordTransaction(digest, outcome)`) answers a specific digest
  before the ordered `scriptGetTransaction` is consulted, which is what a
  `NotApplied { inputConsumed }` test needs: the rule reads
  `changedObjects[].inputVersion` off the **consuming** transaction, and
  `FakeChange.inputVersion` is how a test says which version that was.
- **`Tx.build` always simulates.** A test that asserts a `simulateTransaction`
  call count is asserting on that, so a conversion moving onto this build has to
  move those numbers.
- **It runs no Move code.** Execution outcomes are scripted (`FakeOutcome`), and
  what your recipe actually does on chain is localnet's business.

What a test file covers:

- the happy path of every member, through the real service;
- every error in a member's declared union, produced by the fake and asserted
  with `Effect.flip` and `instanceof`;
- what the extension *sent*, not only what came back (`SuiTest.calls`);
- anything time-dependent, under `TestClock` (the program's clock) or
  `SuiTest.setClock` (the chain's);
- the `outcome` of your errors, because that is what a script's exit code is;
- for a face with synchronous members, that `$ready()` (or `warm`) makes them
  real — the placeholder window is the one thing types cannot catch for you.

## 11. Scripts and exit codes

A script that uses an extension provides its layer and yields the service:
`Script` brings `Sui` and `SuiCore`, which is everything an extension layer
requires. `examples/extension-consumer.ts` is that script end to end.

Because your errors declare an `outcome`, a script that fails inside your
extension exits with the code a wrapper can act on — 5 applied, 4 not applied,
3 unknown — with no handling lines anywhere.

`SuiError.toJson` serializes your errors too. A tag in sui-effect's own taxonomy
encodes through the taxonomy's schema; **anything else that is a
`Schema.TaggedError` encodes through its own**, so an extension error arrives as
`{ _tag, escrowId, outcome }` rather than a bare `{ _tag, message }`. That is
what makes a structured log of a failed run useful, and it is a reason to give
every field of an error a schema rather than stuffing detail into a string.

Two of those deserve a second look. `UnexpectedEffects` — what
`executed.expectCreated(type)` fails with — is **applied**, exit 5: it can only
come from an `Executed`, so the transaction ran and gas was charged and only the
receipt is missing; treating it as "safe to retry" would run the caller's intent
twice. And a `Cause.TimeoutError` from an `Effect.timeout` wrapped *around* a
submission exits 3, not 4, when the journal still holds an unresolved entry: the
outer timeout interrupts the submission from outside and the bytes may be on the
wire. `Script.run` prints those unresolved entries, with their base64 bytes, on
every non-zero exit.

## 12. Converting an existing facade

Copying the template is the greenfield path. A 14k-line facade with standalone
functions beside it is a different job, and the order that works is this.

1. **Inventory the namespaces first.** List what consumers actually call,
   grouped the way they call it (`ids`, `tx`, `protocol`, `party`). That list is
   your service interface, and a group is a plain object member on it. Write the
   interface before you move any code: it is the only artefact the conversion is
   reviewed against.
2. **Keep the standalone functions.** An existing `Effect<A, E, Sui>` function
   that is exported and used outside the facade stays exported and keeps its
   signature. Do not make consumers hold a service to call something that never
   needed one.
3. **Assemble the service from those functions.** The service's members are thin:
   they close over the layer's `Sui` (`Effect.provideService(Sui, sui)` as an
   extra argument to `Effect.fn`) and call the standalone function. One
   implementation, two entry points — which is the same trick as the Promise
   face, one level down.
4. **Decide where the synchronous members go.** Recipe builders, id derivations,
   codecs and constants can live on the service (a namespace like `tx`) or stay
   free exports. On the service they are reachable from a Promise consumer, at
   the cost of the `$ready` / `warm` rule in section 7. As free exports they are
   simply functions and a Promise consumer imports them. Pick per member: things
   a Promise consumer composes with the rest of the surface go on the service
   and the registration gets `warm`; things only Effect code uses stay free.
5. **Convert the errors before the methods.** Every predecessor error maps to a
   taxonomy tag or to one of your own with an `outcome` (section 2). Doing this
   first means each method's union is already decided when you write it.
6. **Move one namespace at a time, with its tests.** The old facade and the new
   service can coexist behind the same package export for as long as the
   conversion takes.

What not to do: do not wrap the old facade in the new service. The point of the
conversion is that every method gets a closed error union, and a wrapper around
a `Promise`-shaped class has `unknown` in its error channel by construction.

## 13. Migrating a `@misofm/effect` package

The predecessor library and its consumers map onto sui-effect like this. The
conversion is mechanical except where the behaviour deliberately changed.

| `@misofm/effect` | sui-effect |
|---|---|
| `SuiClient.layer(client)` | `SuiCore.layerFromClient(client)` under `Sui.layerNoDeps`, which does the chain-id check `ready()` did by hand |
| `yield* SuiClient` then `client.core.x(...)` | `sui.core.x(...)`, or `sui.core.use((client, signal) => ...)` when the SDK client object itself is needed. The reach-through disappears; the error mapping and the `AbortSignal` come with it |
| `SuiGraphQL` | sui-effect's `SuiGraphQL` — the same tag for everyone, over the SDK's `SuiGraphQLClient`. sui-effect wraps no GraphQL API: you keep your queries and map failures yourself. `SuiGraphQL.layer(client)`, `layerConfig` (`SUI_GRAPHQL_URL`, `SUI_NETWORK`), `layerUnavailable` |
| `GraphQLUnavailableError` | `GraphQLUnavailable { method, reason }`, in the taxonomy, outcome `not_applied` — what `SuiGraphQL.layerUnavailable` rejects every call with |
| `DeploymentError` | your own `<pkg>/DeploymentError` (the template's `EscrowUnsupportedNetwork`), a `Schema.TaggedError` declaring `outcome: "not_applied"`, failed from a `Layer.unwrap` that reads `sui.network` (section 6) |
| `ObjectNotFoundError` | `ObjectNotFound`, plus `ObjectDeleted` and `ObjectUnavailable` from the SDK's own `reason` |
| `ObjectTypeMismatchError` | `DecodeError { objectId, expectedType, issue }` from the bridge's tag check |
| `SuiRpcError { operation }` | `TransportError { method }`. For your own HTTP or GraphQL calls, `TransportError.fromUnknown(method, cause, retryable?)` classifies the status and the retryability the way `SuiCore` does — do not hand-build the three fields |
| `BcsDecodeError` | `DecodeError` |
| `TransactionFailedError { digest, status }` | `ExecutionFailed { digest, reason, command, effects }` |
| `getObjectContent` | `sui.getObject(id)` — with no schema, `content` is the raw bytes |
| `getOptionalObjectContent` | `sui.getObjectOption` — `None` for missing and deleted, which is also the blessed way to express domain absence |
| `getObjectsContent` | `sui.getObjects` — chunked, integrity-checked, a per-item `Result` instead of silently dropping errored ids; `sui.getObjectsOrFail` when every id must be there |
| `listDynamicFields` | `sui.streamDynamicFields` |
| filtering dynamic fields by key type | filter entries on `name.type` with `SuiSchema.matchesType` (never `normalizeStructTag`, which throws on the primitive key types), then decode `name.bcs` with `SuiSchema.decode(keyCodec, entry.name.bcs)`; the entry carries both |
| `deriveDynamicFieldID` + `getObjectOption` for existence | `sui.getDynamicFieldOption(parent, name)` — one call, `None` for absent |
| `decodeBcs(codec, schema, bytes)` | `SuiSchema.bcs(codec, expectedType?)`, composed with a domain class through `Schema.decodeTo`, passed as `sui.getObject(id, { schema })`; for bytes you already have, `SuiSchema.decode(codec, bytes, { objectId?, expectedType?, actualType? })`. The codec must be a `BcsType` — codegen's `MoveStruct` / `MoveEnum` / `MoveTuple` are; a hand-rolled `{ parse }` is not |
| `assertObjectType` | folded into the bridge's tag check, where a bare tag matches every instantiation — and where matching is on `address::module::name`, **not** a suffix. A call that relied on `assertObjectType` accepting a suffix (`"::escrow::Escrow"`) has to name the full tag, derived from the configured type origin |
| `register(client)` throwing at registration | a `warm` registration surfaces a `DeploymentError`-shaped failure **synchronously, out of `register`** rather than as a rejected first call. Catch it where you register |
| a `string` object id or address | `ObjectId.make(id)` / `SuiAddress.make(addr)` at the boundary for a literal you control, `Schema.decodeUnknownEffect(ObjectId)` for anything that came from outside. This is most of the mechanical diff: `Sui.*` takes branded ids, not `string` |
| `TxThunk` | `Recipe = (tx) => void`. Every thunk in the SDKs is already synchronous; a **consumer's** `async (tx) => …` is not, and it hoists its `await` in front of the recipe — the read happens in the surrounding Effect, the recipe stays pure |
| `buildTx(...thunks)` | compose recipes: `(tx) => { a(tx); b(tx) }`, then `Tx.build`. When what you need is a `Transaction` **object** to hand to something else, build it yourself: `const tx = new Transaction(); recipe(tx)` — `Tx.build` returns signed-ready bytes and needs a sender |
| `signAndExecute` / `execThunks` | `Tx.run(recipe, { signer })`; the separate `waitForTransaction` is gone |
| `ParallelTransactionExecutor` | `Tx.run` per PTB, under the sender lock. Parallel submission from one address needs distinct gas owners (`Tx.sponsored`) and is otherwise deferred: the lock is what stops two transactions picking the same gas coin |
| `ExecResult` and its extractors | `Executed` with `created(type)`, `createdWhere(predicate)`, `packagesPublished()`, `balanceChange(address, coinType)`, `expectCreated` |
| a `register(client)` building a class of Promise methods | the service above plus `SuiExtension.fromService`, with `warm` when the surface has synchronous members |

Five behaviour changes to put in the conversion issues:

1. `getObjects` returns a per-item `Result`; ids that failed are no longer
   silently dropped. `getObjectsOrFail` is the fail-first variant.
2. `balanceChange` and `gasUsedTotal` are `bigint`, not `number`.
3. `created(type)` compares normalized struct tags; the substring matching of
   `createdByType` / `allCreatedByType` is `createdWhere(predicate)`.
4. `Tx.run` replaces sign-and-execute plus wait, and a transport failure once
   bytes may have been sent is a `SubmissionUnknown` carrying them, not a retry
   loop.
5. Ids and addresses are branded. `ObjectId.make` at the boundary is not
   ceremony: it is the one place a malformed id is caught, instead of at a node.
   It **throws**, so it is for literals you control; everything from outside
   goes through `Schema.decodeUnknownEffect`.
6. `Tx.build` **always** simulates, so any test asserting a
   `simulateTransaction` call count has to move.
7. `NotApplied { inputConsumed }` is rare on a real network: expect
   `SubmissionUnknown` for almost every stuck submission and plan an operator or
   `reconcileAll` path.

**Name the target.** A conversion is against **one** sui-effect commit or tag —
say which in the issue and in the vendored tarball's filename — because "the
library changed under us" is otherwise indistinguishable from "the conversion
was wrong".

## 14. Review checklist

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
- ships a public member whose JSDoc does not state its error union in words;
- declares `sui-effect`, `effect` or `@mysten/sui` in `dependencies` rather than
  in `peerDependencies` **and** `devDependencies`;
- hand-builds a `TransportError` instead of using `TransportError.fromUnknown`;
- registers two extensions on one client with different chain ids, or mixes a
  `warm` registration with a lazy one whose chain id differs;
- puts `Layer.orDie` over `Sui.layerNoDeps` (or any layer that can fail with
  `NetworkMismatch`) in a compatibility shim — a chain mismatch becomes a defect
  nobody can catch;
- proves its dynamic-field filtering with a fake that has **one key type per
  parent**, which proves nothing about filtering;
- has a README `catchTag` string that does not match the tag the error actually
  carries, prefix included;
- leaves `tests` out of the package `tsconfig`'s `include`, so its type-level
  pins never compile;
- calls `.make` on a branded schema with a value that came from outside;
- promises a `ConfigError` for an empty environment variable it reads with
  `Config.option`.

The effect-ts skill's own checklist still applies underneath: v3 names,
`Effect.gen` returned from a plain arrow, throwing inside an Effect, mutable
module-level state, `run*` outside an entrypoint.

## 15. Copying the template

<!-- from: examples/extension-template/package.json -->

```json
"peerDependencies": {
  "@mysten/bcs": "^2.1.1",
  "@mysten/sui": "^2.28",
  "effect": "4.0.0-rc.112",
  "sui-effect": "^0.1.0"
},
"peerDependenciesMeta": {
  "sui-effect": {
    "optional": true
  }
},
"devDependencies": {
  "@effect/language-service": "0.87.2",
  "@mysten/bcs": "2.1.1",
  "@mysten/sui": "2.30.0",
  "@types/bun": "1.4.2",
  "effect": "4.0.0-rc.112",
  "typescript": "5.9.3"
}
```

`sui-effect`, `effect`, `@mysten/sui` and **`@mysten/bcs`** are peer
dependencies, with the exact rcs pinned in `devDependencies`. `@mysten/bcs` is
on that list because your BCS layouts are `BcsType`s from it and they cross the
boundary into `SuiSchema.bcs`: two copies in one process is two `BcsType`
classes, and a codec built with one is not the codec the other's `instanceof`
recognises. Two copies of `effect` means two `Context.Service` identities and
layers that silently do not match; two copies of `@mysten/sui` means
`instanceof` on its error classes fails.

The template is shipped inside the published package, so
`node_modules/sui-effect/examples/extension-template/` is a directory you can
copy even when you have no checkout of this repository.

`examples/extension-template/README.md` has the step by step: rename the
package, the service identifier and the registration name; drop the `paths`
blocks that resolve `sui-effect` inside this repository; replace the package id,
the BCS layouts and the Move targets; keep the shape.

### The package has to actually build

`exports` points into `dist`, so something has to put a `dist` there. The
template ships `tsconfig.build.json` (emit on, `rootDir: src`, declarations and
maps) and a `build` script, and its `files` list is `dist` plus the README —
which is exactly the combination that is easy to get wrong and impossible to
notice, because `tsc --noEmit` and `bun test` both import `src/` and pass for a
package that ships nothing at all.

So the template's own check does not stop at those two. `bun run check` also
runs `scripts/check-package.ts`, which builds, packs the tarball, unpacks it
into a throwaway `node_modules`, and imports the package the way a consumer
will. Copy that script along with the rest: it is the only step that looks at
what you are actually publishing.

The template is `version: "0.0.0"` and **not** `private`, because a package
meant to be copied and published must not carry a flag that silently refuses to
publish. Set your own name, version and `publishConfig.access` before you run
`npm publish`.

### TypeScript

sui-effect is built with TypeScript 5.9 and its emitted declarations are what a
consumer typechecks against. **Consumers on TypeScript 7 (`tsgo`) are
supported** — there is nothing in the shipped `.d.ts` that needs the old
compiler — and an extension package is free to use it. The `prepare` script in
this repository (`effect-language-service patch`) is a *library* concern: it
patches the checker for the diagnostics we develop against, and it belongs to
whoever builds this package, not to whoever consumes it. Do not copy it into a
consumer.

## 16. Before the first release

sui-effect is published as `sui-effect` on npm. While a conversion runs ahead of
a release that has not happened yet — a new peer version, an unpublished
change — the dependency needs a form that does not exist on the registry.

**Use the packed tarball.** It is the default, not the fallback:

```bash
cd /path/to/sui-effect && bun run build && npm pack
mkdir -p vendor && cp /path/to/sui-effect/sui-effect-0.1.0.tgz vendor/
cd /path/to/your-package && bun add -d ./vendor/sui-effect-0.1.0.tgz
```

It is also the only form that proves anything: an isolated consumer of the
tarball exercises the published `files` list and the `exports` map, which a
symlink does not.

**A `link:` or `bun link` to an external checkout does not dedupe the peers.**
Module resolution follows the symlink's *real* path, so the linked checkout
resolves `effect` and `@mysten/sui` out of its own `node_modules` while your
package resolves them out of yours. The two copies are nominally distinct: every
class that crosses the boundary fails to typecheck with `#private` mismatches,
and at runtime two copies of `effect` means two `Context.Service` identities and
layers that silently do not match. Reserve `link:` for a **real workspace
member**, where one `node_modules` serves both.

**Re-pack, and diff.** A vendored tarball is a snapshot. When the library
changes, re-pack and compare the listings (`tar -tzf new.tgz | sort` against the
old one) before installing: a file that stopped shipping is caught there rather
than in a consumer. Record the sui-effect commit or tag the vendor copy came
from.

**Until the first publish, bun probes the registry for every peer.** It does so
even for a peer a local dependency already satisfies, and an unpublished name
404s the install. The escape is
`"peerDependenciesMeta": { "sui-effect": { "optional": true } }` in your
`package.json` — which the template ships, because it is copied verbatim.

Put both halves of the swap on the release checklist:

1. replace the tarball with the published range (`"sui-effect": "^0.1.0"`);
2. **delete the `peerDependenciesMeta` entry.** Left in, it turns a genuinely
   missing peer into a silent `undefined` at import time;
3. re-run the isolated-consumer check against the published package.

Say in the PR which form was used while the branch was in flight. A `link:` that
reaches `main` is a build that works on one machine.

## 17. What extension authors must know

The short list an independent verification of v0.1.0 said a downstream
conversion has to carry. Everything here is documented somewhere above; this is
the page to read before the conversion rather than after it.

- **Register every extension on a client the same way and with the same chain
  id** — all `warm: { chainId }`, or all lazy, and the same id. The base `Sui`,
  its transport and its **sender-lock map** are shared per client per effective
  chain id; disagreeing registrations get two of everything and two `Tx.run`s
  for one address stop serializing.
- **Expect `SubmissionUnknown`, not `NotApplied { inputConsumed }`,** for almost
  every stuck submission whose PTB touched a shared object or an owned object
  older than the gas coin. `inputConsumed` needs the *consuming* transaction's
  own effects to report `inputVersion` equal to the version your bytes pinned,
  and Sui's Lamport versioning means that is usually not what happened. Plan an
  operator path or a `Tx.reconcileAll()` at startup; do not build a retry loop
  that waits for `NotApplied`.
- **A gRPC `NOT_FOUND` during resolution arrives as a `BuildError`** naming the
  object inputs the resolver was about to look up. And devnet's simulate may not
  resolve a just-created object for a while **even after `waitForTransaction`
  returned**: visibility of a transaction is not visibility of its objects in
  the resolver path. Retry the build, do not re-read and despair.
- **Pin `effect@4.0.0-rc.112` exactly.** rc.113 renamed `Config.nonEmptyString`,
  `Config.string` and `Config.redacted`, so neighbouring release candidates are
  not interchangeable — and two copies of `effect` in one process is a different
  and worse problem (section 16).
- **Copy `scripts/check-package.ts`.** It resolves `sui-effect`, `effect` and
  `@mysten/*` from your own `node_modules` first, so it works outside this
  repository unchanged. `sui-effect` belongs in `devDependencies` and
  `peerDependencies`, never in `dependencies`.
- **Use `TransportError.fromUnknown`.** Building the error by hand makes you
  guess `retryable` and throws away the status a caller needs.
- **`sdkRefOf` is for address-owned and immutable inputs.** A shared object goes
  in with `tx.sharedObjectRef({ objectId, initialSharedVersion, mutable })`,
  reading `owner.Shared.initialSharedVersion`; a receiving object with
  `tx.receivingRef`. Passing a shared object by `objectRef` produces bytes a
  validator rejects.
- **Under `Random.withSeed`, `SubmitConfig.nonce` is deterministic.** A test
  that builds the same transaction twice and expects two different digests has
  to provide `nonce` explicitly.
- **`Tx.build` always simulates**, so call-count assertions on
  `simulateTransaction` move when you move onto this build.
- **A dynamic-field key may be a primitive.** Filter `name.type` with
  `SuiSchema.matchesType`; `normalizeStructTag` throws on `u64`, `bool`,
  `address` and `vector<u8>`.
- **`Stream.runCollect` returns a plain `Array`** in Effect v4, not a `Chunk`.
- **`Effect.withConfigProvider` does not exist** in rc.112: provide the
  `ConfigProvider` service.
- **`SuiError.describe` covers `GraphQLUnavailable` and `ExtensionNotReady`**,
  and `Script.run` prints them like any other tag.
