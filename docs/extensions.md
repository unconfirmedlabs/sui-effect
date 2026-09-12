# Writing a @unconfirmed/sui-effect extension

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
error union of @unconfirmed/sui-effect's taxonomy plus its own `Schema.TaggedError` classes;
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
  with: …"), the convention @unconfirmed/sui-effect itself follows, so the generated
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

Mirror the names of the thing you wrap, the way @unconfirmed/sui-effect mirrors the SDK: a
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
idiom to send again. The `"not_applied"` default is for @unconfirmed/sui-effect's own
taxonomy, not for yours.

**`outcome` can be a schema field instead of a class field, and there is a
reason to prefer it.** `readonly outcome: Outcome = "not_applied"` beside the
schema — what `src/errors.ts` does, and what three converted packages copy — is
a class field, so it is invisible to the schema: it does not appear in the
error's JSON Schema, `Schema.decodeUnknownSync(MyError)` on a logged line does
not get it back, and `SuiError.toJson` has to read it off the instance and patch
it in. `Schema.tag` makes it a real field with a fixed value:

<!-- inline -->

```ts
export class EscrowUnsupportedNetwork extends Schema.TaggedError<EscrowUnsupportedNetwork>()(
  "escrow/EscrowUnsupportedNetwork",
  { network: Schema.String, outcome: Schema.tag("not_applied") }
) {}
```

`new EscrowUnsupportedNetwork({ network: "devnet" })` still takes only
`network` — a `Schema.tag` field supplies itself — while `outcome` is present on
the instance, encoded by `SuiError.toJson` with no patch-back, decodable again,
and visible to `Schema.is`. `SuiError.outcome` and `Script.exitCode` read it
exactly as they read the class field, so the two forms are interchangeable at
every call site and **the class-field form keeps working**; use `Schema.tag` for
errors you are writing now.

**Tag strings are namespaced by whoever defined them, and sui-effect's are
not.** @unconfirmed/sui-effect's own tags are bare — `TransportError`,
`ObjectNotFound`, `DecodeError` — while an extension prefixes its own, so a
platform's tag is `partyos/PartyNotFound` or `EscrowNotFound` depending on the
convention that package chose. `Effect.catchTag` matches the string exactly, so
**copy the tag from the installed package**, never from a migration note or
from memory: a `catchTag("PartyNotFound")` against a package that ships
`partyos/PartyNotFound` compiles (the union is open at the string level in
neither direction you expect) or silently never fires, and a README that
disagrees with the class is the single most common conversion bug. When you
rename or re-prefix a tag, that is a breaking change and belongs in your
changelog with the old and the new string side by side.

**`DecodeError` carries a `kind`, and that is what to branch on.** `"type"` is
"this object is not of the type I asked for" — the one a read service answers
with a 404 or a `filter`. `"bytes"` is "the type matched and the BCS did not
parse", which is a layout mismatch between your package and the chain and must
never be swallowed. `"shape"` is a domain schema refusing an already-parsed
value. The `issue` string is for a human and its wording changes between
releases; branching on it is how a foreign-object 404 quietly starts hiding a
real decode bug.

**`SuiError.outcome` takes a phase.** The default (`"post-submit"`) answers
`"unknown"` for a tag it does not recognise, because after a submission an
unfamiliar error is not evidence that nothing was sent. In a `catchAll` that can
only be reached **before** a submission — validation, a build, a signature —
pass `{ phase: "pre-submit" }` and an unrecognised tag becomes `"not_applied"`,
which is true by construction there. `SuiError.isTaxonomy(error)` is the same
question one level lower.

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
      SchemaTransformation.transformOrFail<typeof Settlement.Encoded, typeof SettlementBcs.$inferType>({
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

When the mapping is a plain function that may throw — a constructor, a
`BigInt(...)`, a branding call — `SuiSchema.decodeWith(layout, type, map)` is
that composition in one call:

<!-- inline -->

```ts
const EscrowContent = (typeOrigin: string) =>
  SuiSchema.decodeWith(
    EscrowLayout,
    escrowType(typeOrigin),
    (raw) => new Escrow(ObjectId.normalize(raw.id), BigInt(raw.amount))
  )
```

A throw inside `map` becomes the `DecodeError` the caller already handles,
carrying the expected type — which is the part that gets forgotten when the same
thing is written as `Effect.try` around `Schema.decodeUnknownEffect`, where the
throw arrives as a defect instead. The codec still carries the Move type, so
`sui.getObject(id, { schema })` checks the tag before it parses. There is no
encoder: a mapping function has no inverse, so serialize with the layout itself.

The domain class is an ordinary `Schema.Class`:

<!-- from: examples/extension-template/src/schema.ts -->

```ts
export class Settlement extends Schema.Class<Settlement>("escrow/Settlement")({
  escrowId: ObjectId,
  settledAt: Schema.DateTimeUtc,
  claimedBy: SuiAddress
}) {}
```

**The halfway shape is the target's `Encoded` side.** The transformation's
source type — what `decode` produces and `encode` consumes — is
`typeof Settlement.Encoded`, and `src/schema.ts` spells it exactly that way. A
hand-written interface with the same fields is equivalent and compiles too, but
it is a second copy of the class's shape that can drift from it, so prefer the
`Encoded` side. What does **not** fit is `typeof Settlement.Type`: that is the
*instance* side, which inverts the direction the transformation is being
inferred in, and the error arrives several frames away from the line that caused
it.

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

Worked, on owned objects, because that is where it pays: one codec and one bare
tag serve every instantiation a wallet holds, including on the fake.

<!-- inline -->

```ts
// One codec for every `Composition<T>`, built from the type origin.
const compositionType = (typeOrigin: string) => `${typeOrigin}::composition::Composition`
const CompositionContent = (typeOrigin: string) =>
  SuiSchema.bcs(CompositionLayout, compositionType(typeOrigin))

// Every composition an address owns, whatever it is parameterized by.
const owned = (owner: SuiAddress) =>
  sui.streamOwnedObjects(owner, {
    type: compositionType(typeOrigin),
    schema: CompositionContent(typeOrigin)
  })

// In a test, the fake filters with the same rule, so objects whose `type` is
// the instantiated tag are served for the bare one:
const script = {
  objects: [
    { objectId: FIRST, type: `${ORIGIN}::composition::Composition<${ORIGIN}::share::Share>`, … },
    { objectId: SECOND, type: `${ORIGIN}::composition::Composition<0x2::sui::SUI>`, … }
  ]
}
// `owned(address)` yields both, each decoded by the one codec.
```

The instantiation is not lost: each object keeps its own tag on
`SuiObject.type`, so a member that cares which one it read still can. What the
bare tag does is stop you writing a codec per type argument.

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
because `0x1` is not a 32-byte address. **`SuiAddress.normalize` and
`ObjectId.normalize` are the pair that take the shorthand**: they run the
schema's own decode (`normalizeSuiAddress`) and then brand, so `"0x1"`, an
unpadded hex string and the padded form all produce the same branded value.

<!-- inline -->

```ts
const treasury = SuiAddress.normalize("0x2") // 0x0000…0002, branded
const clock = ObjectId.normalize("0x6")
```

They throw, exactly like `.make`, so they are still for literals and
configuration **you** control — a deployment constant, a CLI flag you already
validated. Anything that arrived from a node, a user or an upstream package goes
through `Schema.decodeUnknownEffect(ObjectId)` and becomes a typed
`DecodeError`.

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
import { SuiSchema } from "@unconfirmed/sui-effect"

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
- **hard** — every id must be there: `sui.getObjectsStrict(ids, opts)` (named
  `getObjectsOrFail` before 0.1.2, and still reachable under that name), which
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

### A signer double, for tests

`Signer.fromSdkSigner` reads `toSuiAddress()` and `getKeyScheme()` **at
construction** and rejects a value that has neither, so a partial double is a
`TypeError` where it used to be `scheme: undefined` and silence. A double is
`Signer.remote`, which takes exactly what a signer is:

<!-- inline -->

```ts
const doubleSigner = (address: SuiAddress): Signer =>
  Signer.remote({
    address,
    scheme: "ED25519",
    signTransaction: () => Effect.succeed("AAAA…" as string) // any non-empty string decodes
  })
```

For a test that actually submits, use a real keypair
(`Signer.fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))`):
the fake checks that the signatures cover the addresses the bytes name, and a
fabricated signature only passes the count check.

### Sponsored by an external service

`Tx.run`'s `sponsor` and `Tx.cosign` both want a local `Signer`. A service that
co-signs **and submits** on your behalf — a relayer, a sponsorship API — has
neither, and `Tx.submit` is not the last step either, because the service sends
the bytes. The supported sequence is:

<!-- inline -->

```ts
const built = yield* Tx.build(Tx.sponsored({ sender, gasOwner })(recipe), {
  sender,
  gasOwner
})
const signed = yield* Tx.sign(built, signer)
// The wire form: base64 bytes, and the serialized signature string the SDK
// produces. `signed.signatures[0]` is the sender's; the service adds its own.
const envelope = {
  transactionBlockBytes: toBase64(signed.bytes),
  signature: signed.signatures[0]!
}
const reply = yield* callTheSponsor(envelope)
// Two ways to end, and both are supported:
//   the service returned an execute envelope — decode it and keep the accessors
const executed = yield* Executed.fromPartial(reply)
//   or it returned only a digest — ask the chain yourself
const settled = yield* Tx.reconcile(signed)
```

Three things to know. The digest does not change when the sponsor adds its
signature, so `signed.digest` is the digest to record and to reconcile by.
`Tx.reconcile(signed)` — passing the `Signed`, not the bare digest — is what
gets the evidence rules, so a service that never sent the bytes ends as
`NotApplied` rather than as an eternal `SubmissionUnknown`. And whatever the
service returns is a **reduced** envelope: see "Relay and sponsor envelopes"
below, and use `Executed.fromPartial` rather than `Schema.decodeUnknownSync`.

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
- a nested namespace is mapped recursively, **including one typed as an
  `interface`** — the recursion is by type, not by how the member was declared;
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

**A `warm` registration runs the whole layer synchronously, so every failure of
that layer is thrown out of `$extend`.** Not only an asynchronous step and not
only a missing chain id: a deployment your bundle does not have for this
network, a `ConfigError`, a `NetworkMismatch`, anything the layer declares.
There is no first call to reject, because the layer is built before `register`
returns. Catch it where you register, and say so in your registration's JSDoc.
The mirror image is the lazy default, where the layer's failure surfaces as the
rejection of whatever call needed it first.

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

**Do not over-invest in testing the mismatch checks.** A consumer that reads
both from one deployment manifest — `network: deployment.network` on the client
and `chainId: deployment.chainIdentifier` on the registration — cannot make the
network check and the chain-id check fire except by supplying an inconsistent
pair on purpose. One test that a wrong `chainId` throws is worth having; a
matrix over the combinations is testing the manifest, not the code.

**In a browser, `warm` throws into your import graph.** The natural place for a
registration in an SPA is module scope, and a throw there takes down the whole
module — no error boundary, no console line a user can act on, just a blank
page. Two patterns work: register lazily and `await client.ext.$ready()` in a
boot step that has somewhere to put the failure; or keep the `warm`
registration and wrap it, exporting the error instead of throwing it:

<!-- inline -->

```ts
// sui-client.ts
export let bootError: unknown
export const client = (() => {
  try {
    return baseClient.$extend(escrow({ warm: { chainId } }))
  } catch (cause) {
    bootError = cause
    return baseClient.$extend(escrow({})) // lazy: every call rejects, nothing throws
  }
})()
```

**Thread the chain id through your registration options**, the way
`src/extension.ts` and `src/Platform.ts` both do, rather than relying on the
built-in table. It is what makes the face work on `devnet` and `localnet`, and
it is what lets every registration on one client agree — see the next
paragraph. The template has a test for the warm face on a network with no
built-in chain id; a conversion should have one too.

**What a cold call actually is.** The value a member call returns before the
runtime exists is a real `Promise` subclass that also implements
`Symbol.asyncIterator`, because nothing yet knows whether the member was an
`Effect` (a Promise) or a `Stream` (an `AsyncIterable`). So `instanceof Promise`
holds, `for await` works, and in `bun:test`
`await expect(client.ext.thing()).rejects.toBeInstanceOf(ExtensionNotReady)`
does what it looks like. (In 0.1.0 it was a bare thenable and `.rejects` did not
recognise it; `await ... .catch()` was the workaround and is no longer needed.)

Its rejection is also **pre-handled**: a cold call nobody awaits —
`client.ext.doThing()` written as a statement — rejects with
`ExtensionNotReady` into a no-op catch rather than aborting the process on an
unhandled rejection. Your own `await` still throws. Write the test that proves
this for your own face; it is the one failure mode that kills a test run rather
than failing a test.

And **`$dispose()` keeps a warm registration warm**: the next use re-runs the
same warm build rather than leaving every synchronous member throwing
`ExtensionNotReady` forever after.

If your extension's surface is entirely `Effect` and `Stream` members, none of
this applies: the lazy default is right and the first `await` builds everything.

### Namespaces, leaves, and the one member that still lies

The face recurses into object-typed members — that is what makes
`client.platform.escrow.get(id)` work — and **the recursion is by type, not by
declaration style**. An `interface`-typed namespace (`readonly escrow:
EscrowService`) is mapped exactly like an inline object literal. In 0.1.0 it was
not: the type's bound was `Record<string, unknown>`, which an interface is not
assignable to, so an interface-typed namespace kept its `Effect` members **in
the type** while the runtime mapped them to Promises. If you carried a local
type alias to work around that, delete it.

These are the leaves — passed through whole, in the type and at runtime alike:
functions, arrays, `Uint8Array`, `Date`, `Promise`, and a BCS codec (anything
with both `parse` and `serialize`, which is every `BcsType`). Exposing a codec
as a member is safe.

For **any other class instance** — a `Schema.Class` instance, a policy object,
anything with methods of its own — say so:

<!-- inline -->

```ts
import { SuiExtension } from "@unconfirmed/sui-effect/extension"

interface MyService {
  readonly policy: SuiExtension.Leaf<Policy>
}
// in the layer:
return { policy: SuiExtension.leaf(new Policy()) }
```

`Leaf<T>` **is** a `T`, so the Effect face is unaffected; what it does is tell
the Promise face that this member is a value rather than a namespace of members.
Without it the type would recurse into the class while the runtime passes class
instances through untouched, and for a class whose methods return `Effect`s that
is the same lie in the other direction.

The remaining disagreement is the one that cannot be resolved by types at all. A
**plain-object value** member — `deployment: { packageId }` — is
indistinguishable from a namespace of members, so the type maps it as the value
while the **cold** face treats it as a namespace and hands back a placeholder
for `deployment.packageId`. Reading that placeholder throws `ExtensionNotReady`
naming the path, so it is typed and named rather than silent, but it is still a
disagreement. Either register `warm` (or `await $ready()`), or expose the value
through an `Effect` member. Do not put a plain-object value member on a service
that consumers will register lazily.

**Write a `PromiseFace<Service>` type test per namespace.** It is four lines, it
is the only thing that catches a face type that has drifted from the runtime,
and the template has one to copy:

<!-- from: examples/extension-template/test/escrow.test.ts -->

```ts
describe("the Promise face type", () => {
  /** Compile-time assignability, as a value a test can assert on. */
  const assignableTo = <_A extends _B, _B>(): true => true

  type EscrowFace = PromiseFace<EscrowService>
  type PlatformFace = PromiseFace<PlatformService>

  test("an Effect member becomes a Promise-returning method", () => {
    expect(assignableTo<EscrowFace["get"], (id: ObjectId) => Promise<EscrowObject>>()).toBe(true)
    expect(assignableTo<EscrowFace["feeCollector"], () => Promise<SuiAddress>>()).toBe(true)
  })

  test("a Stream member becomes an AsyncIterable", () => {
    expect(
      assignableTo<EscrowFace["owned"]["stream"], (owner: SuiAddress) => AsyncIterable<EscrowObject>>()
    ).toBe(true)
  })

  test("a synchronous member stays synchronous", () => {
    expect(assignableTo<EscrowFace["packageId"], string>()).toBe(true)
    expect(assignableTo<EscrowFace["claim"], (escrow: EscrowObject) => Recipe>()).toBe(true)
  })

  test("an interface-typed namespace is mapped all the way down", () => {
    // `PlatformService.escrow` is `EscrowService`, an interface. The members
    // reached through it must be the mapped ones, not the Effect ones.
    expect(assignableTo<PlatformFace["escrow"]["get"], (id: ObjectId) => Promise<EscrowObject>>())
      .toBe(true)
    expect(
      assignableTo<
        PlatformFace["escrow"]["owned"]["count"],
        (owner: SuiAddress) => Promise<number>
      >()
    ).toBe(true)
    expect(assignableTo<PlatformFace["escrow"]["packageId"], string>()).toBe(true)
  })

  test("the composition's own member is mapped too", () => {
    expect(
      assignableTo<
        PlatformFace["claimEverything"],
        (ids: ReadonlyArray<ObjectId>, opts: { readonly signer: Signer }) => Promise<
          ReadonlyArray<ChangedRef>
        >
      >()
    ).toBe(true)
  })
})
```

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

#### A standalone function that needs a sibling extension

A service member yields its dependencies; a **standalone exported function**
has no layer of its own, and the temptation is to build the sibling's layer
inside it on every call or, worse, to keep a module-level `ManagedRuntime`.
Neither is sanctioned. There are exactly two shapes, and the first is the
default:

<!-- inline -->

```ts
// 1. Take the sibling's service as a parameter. The caller already holds it —
//    it is in a member's `Effect.gen`, or in a script that provided the layer —
//    and the function stays `R = Sui`, testable with the sibling's test layer
//    and nothing else.
export const settleAll = Effect.fn("settleAll")(function*(
  escrow: EscrowService,
  ids: ReadonlyArray<ObjectId>,
  opts: { readonly signer: Signer }
) {
  const settled: Array<ChangedRef> = []
  for (const id of ids) settled.push(yield* escrow.claimFor(id, opts))
  return settled
})

// 2. Require it, and let the caller provide it once. Use this when the function
//    is part of a surface whose consumers already hold the layer.
export const settleAllOwned = Effect.fn("settleAllOwned")(function*(
  owner: SuiAddress,
  opts: { readonly signer: Signer }
) {
  const escrow = yield* Escrow // R = Sui | Escrow
  …
})
```

What not to do: `Layer.build` (or `Effect.provide(Escrow.layer(options))`)
**inside** the function body. It is one layer build per call — a fresh cache, a
fresh connection, a fresh sender lock for whatever the sibling holds — and the
options have to come from somewhere, which is how a package id ends up read from
`process.env` three files away from the service that owns it. If a function
genuinely needs to build the sibling itself, build it **once** in the function
that builds the registration and close over the service, the way `Platform.layer`
does with `Layer.provide`.

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
          new DecodeError({ expectedType: "SuiAddress", kind: "shape", issue: issue.message })
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

In both cases the upstream answer is **narrowed to a @unconfirmed/sui-effect schema before
anything else sees it**. Upstream types are never re-exported: the template's
`src/upstream.ts` is absent from `src/index.ts`, and `SettlementResponse` never
reaches a consumer. That narrowing is what makes the wrapper worth having —
precise errors and stable types instead of whatever the upstream ships next
release.

### If your extension reads GraphQL

`SuiGraphQL` is a tag over the SDK's own client, not a wrapper: `yield*
SuiGraphQL` hands back the `SuiGraphQLClient` that was passed to
`SuiGraphQL.layer(client)`, so the service type is `SuiGraphQL["Service"]`
(which *is* `SuiGraphQLClient`) and that is what a helper taking it as a
parameter should be typed with. `SuiGraphQL.query(run, method?)` is the one call
that sorts out the two failures:

<!-- inline -->

```ts
import { SuiGraphQL } from "@unconfirmed/sui-effect"

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

`@unconfirmed/sui-effect/testing` is the whole harness. An extension's tests need nothing
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

It also provides **`SuiGraphQL.layerUnavailable`**, so an extension that reads
GraphQL builds in a test with no endpoint and every GraphQL call fails with
`GraphQLUnavailable` — the failure it already handles. Anything else your layer
requires that the client could not have given it goes in the third argument:

<!-- inline -->

```ts
const layer = layerExtensionTest(Escrow.layerTest(), script, {
  extra: SuiGraphQL.layer(scriptedClient) // or an HttpClient, an operator service…
})
```

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

**`waitForTransaction` is scripted through `getTransaction`.** There is no
separate knob: `Tx.submit` waits by polling `getTransaction`, so the ordered
`FakeScript.getTransaction` outcomes (and `FakeScript.transactions` / 
`SuiTest.recordTransaction` for answers keyed by digest) are what decide whether
a wait succeeds, times out or reports the transaction missing. A test that wants
"executed, then not visible for two polls, then visible" scripts exactly that
list.

`FakeScript.coinMetadata` is the same idea for `getCoinMetadata`: a record keyed
by coin type, with an unscripted type answering `{ coinMetadata: null }` the way
a node does. Unscripted entirely, the method dies naming itself, like every
other method the script does not cover.

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

### Scripting a submit, and the traps in it

Four things about the fake decide whether a submit test means anything.

**`Tx.submit` asks `getTransaction` when it cannot get a clean answer.** A
retryable transport failure, a timeout, anything that leaves the outcome open
ends in `Tx.reconcile`, and `reconcile`'s first move is a `getTransaction` for
the digest. So a script whose `getTransaction` is a `succeed` is saying "this
transaction is on chain" — and a submit test that did not mean that gets a
**success** out of a path it was trying to prove fails. Unless the test is
modelling a landed transaction, script `getTransaction: [FakeOutcome.notFound()]`
and let the evidence rules run.

**A sponsored submit needs `Tx.cosign` first.** The fake refuses a submission
whose signatures do not cover the addresses the bytes name — by count, and by
the addresses recovered from the signatures themselves — the way a validator
does, with a gRPC `INVALID_ARGUMENT`. `Tx.submit` reports that one outright as a
`TransportError { retryable: false, status: "INVALID_ARGUMENT" }` rather than
reconciling it, because the node refused the request and nothing was executed.
So a sponsored-flow test builds with `Tx.sponsored`, signs with the sender,
**`Tx.cosign`s with the sponsor**, and only then submits; `Tx.run(recipe, {
signer, sponsor })` does all of that itself. Assert it, too — the signature
count is on the recorded call:

<!-- inline -->

```ts
const sent = yield* SuiTest.calls("executeTransaction")
expect(sent).toHaveLength(1)
expect((sent[0]!.options as { signatures: ReadonlyArray<string> }).signatures)
  .toHaveLength(2)
```

**`FakeOutcome.failWith` takes either reason shape.** The SDK's
`SuiClientTypes.ExecutionError` is the wire shape — a top-level `message` and an
`abortCode` **string** — and sui-effect's decoded `ExecutionReason` has a
`bigint` `abortCode` and no `message`. Both are accepted and the second is
encoded for you; anything that is neither throws where the fixture is written,
naming both shapes, instead of failing a decode several calls later on an
unrelated method.

**Which script slot drives the build's simulate.** `Tx.build` always simulates,
and on the fake that simulate is the **resolver's**: it is recorded (so
`SuiTest.calls("simulateTransaction")` counts it) and it is answered by
`buildSimulate` when that script has entries, and otherwise by the ordered
`simulate` script. So `simulate: [FakeOutcome.failWith(...)]` makes `Tx.build`
and `Tx.run` fail with `SimulationFailed` the way a node would, and
`buildSimulate` is the slot to use when a test needs the build's simulate and
an explicit `sui.simulate` to answer differently.

**`layerTest` asserts the built-in chain id for `mainnet` and `testnet`.**
It is `Sui.layerNoDeps`, the production layer, so a script that says
`network: "mainnet"` and a `chainId` of its own fails to build with
`NetworkMismatch`. Use `network: "localnet"` (the default, which asserts
nothing) in fixtures, or the real bundled identifier for the network you named.

**The fake writes nothing to standard error, ever.** If your test output has a
line in it, it came from your code or from Effect's logger, not from here.

### Injecting a read failure

`FakeScript.getObject` is a list of `FakeOutcome`s consumed one per `getObject`,
for the retry and fallback paths a script of *objects* cannot express:
`FakeOutcome.transportError("UNAVAILABLE")` to drive `SuiCore`'s read retry,
`FakeOutcome.notFound()` for an `ObjectNotFound`, `FakeOutcome.timeoutThen` for
an interruption. A `succeed` entry — and an absent or exhausted script — serves
the object map as usual. `SuiTest.scriptGetObject(outcomes)` sets it mid-test.

`FakeScript.balances` is keyed by **owner and coin type**: an entry with an
`owner` answers only for that address, one without answers for any (which is
what a pre-0.1.2 script meant), and an owner with no entry gets zero, the way a
node answers.

### The fixture package's `node_modules` is not your source

An isolated-consumer fixture — a directory with its own `package.json` that
installs a packed tarball, the way `scripts/check-package.ts` builds one — is
typechecked against **whatever tarball it last installed** the moment `test` is
in the package `tsconfig`'s `include`. So a fixture left over from a previous
release quietly typechecks your new code against the old library, and the
checklist item "put `test` in `include`" turns into a stale pin. Either exclude
the fixture directory from `include` (it has its own `tsconfig`), or re-pack and
re-install it as a step of `check`, with `bun install --force` when the filename
did not change.

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

- **`getObject` can be scripted to fail.** `FakeScript.getObject` /
  `SuiTest.scriptGetObject` inject a transport failure, a miss or a timeout into
  a read; the object map serves everything else.
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

`SuiError.toJson` serializes your errors too. A tag in @unconfirmed/sui-effect's own taxonomy
encodes through the taxonomy's schema; **anything else that is a
`Schema.TaggedError` encodes through its own**, so an extension error arrives as
`{ _tag, escrowId, outcome, message }` rather than a bare `{ _tag, message }`.
`outcome` is there whichever form section 2 you chose — a class field is read
off the instance and added, a `Schema.tag("not_applied")` field is simply
encoded — but only the `Schema.tag` form survives a
`Schema.decodeUnknownSync(YourError)` of that line back into an error, because
only it is part of the schema. `message` is added from the error's own
`.message` when the encoding produced none.

**`outcome` is in that JSON even though it is a class field.** Declaring it the
way the template does — `readonly outcome: Outcome = "unknown"` beside the
schema fields — keeps the call site clean, and a class field is not part of the
schema, so encoding alone would drop exactly the field a wrapper script acts on.
`toJson` reads it off the instance and puts it back. Keep declaring it as a
field; there is nothing to change in your errors. That is
what makes a structured log of a failed run useful, and it is a reason to give
every field of an error a schema rather than stuffing detail into a string.

**A wrapper error must carry what it wrapped.** `Script.exitCode` honours a
declared `outcome` **before** the tag, which is what makes an extension's errors
land on the right exit code — and what makes an error that wraps one and forgets
to copy the `outcome` land on the wrong one. `catchAll(cause => new MyError({
cause }))` around a `Tx.run` turns a charged `ExecutionFailed` (exit 5, do not
retry) into an unclassified error (exit 1) or, worse, into a default
`not_applied` (exit 4, "safe to retry") and the wrapper retries a transaction
that already ran. Copy both fields: `outcome: SuiError.outcome(cause)` and the
digest from `digestOf(cause)`, or do not wrap at all. The same applies to a CLI
that catches at the command boundary and re-raises its own error type.

**A CLI with its own argv parser does not need `Script.run`.** `Script.run` is a
whole entrypoint — it builds the layer, forks the root fiber, installs signal
handlers and exits — and a commander program with twenty subcommands has all of
that. What it still wants is the two things `run` does at the end:
`Script.report(exit, { stderr?, journal? })` writes one diagnostic line per
failure (with a `SubmissionUnknown`'s bytes) plus every unresolved journal
entry, and returns the exit code. Assign it to `process.exitCode` rather than
calling `process.exit`, so buffered output flushes, and pass the journal the
program actually ran with — reading the default reference would look in the
process-wide in-memory journal and find nothing.

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
   your service interface, and a group is a member on it — an `interface` is
   fine, the face maps it either way. Write the interface before you move any
   code: it is the only artefact the conversion is reviewed against.

   **Grep for the shapes the library replaces, not only for names.** Two are
   worth a pattern each. `\.find\(.*type\??\.includes\(` followed by a
   `throw` — "find the created object whose type contains `::Receipt`, or blow
   up" — is exactly `executed.expectCreated(type)`, which compares normalized
   struct tags and fails with `UnexpectedEffects { digest, expected, found }`.
   And `@<scope>/` imports resolved against the **published `exports` map**
   rather than against remembered call sites: regenerate the consumer-edit
   table with `grep -rn "@scope/" <consumer>/src` and one row per removed
   subpath export, because a re-export dropped from a subpath (`/party` no
   longer re-exporting `TxThunk`) breaks every importer while no facade call
   site changed at all.

   **Grep for captured aliases, not only for dotted calls.** A consumer that
   writes `const party = client.miso.party` and then `party.join(...)` does not
   appear in a search for `client.miso.party.join`, and a namespace that looks
   unused gets dropped from the interface. Search for the namespace name on its
   own (`\bclient\.\w+\.party\b`, `= .*\.party\b`) as well as for the calls.
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

The predecessor library and its consumers map onto @unconfirmed/sui-effect like this. The
conversion is mechanical except where the behaviour deliberately changed.

| `@misofm/effect` | @unconfirmed/sui-effect |
|---|---|
| `SuiClient.layer(client)` | `SuiCore.layerFromClient(client)` under `Sui.layerNoDeps`, which does the chain-id check `ready()` did by hand |
| `yield* SuiClient` then `client.core.x(...)` | `sui.core.x(...)`, or `sui.core.use((client, signal) => ...)` when the SDK client object itself is needed. The reach-through disappears; the error mapping and the `AbortSignal` come with it |
| `SuiGraphQL` | @unconfirmed/sui-effect's `SuiGraphQL` — the same tag for everyone, over the SDK's `SuiGraphQLClient`. @unconfirmed/sui-effect wraps no GraphQL API: you keep your queries and map failures yourself. `SuiGraphQL.layer(client)`, `layerConfig` (`SUI_GRAPHQL_URL`, `SUI_NETWORK`), `layerUnavailable` |
| `GraphQLUnavailableError` | `GraphQLUnavailable { method, reason }`, in the taxonomy, outcome `not_applied` — what `SuiGraphQL.layerUnavailable` rejects every call with |
| `DeploymentError` | your own `<pkg>/DeploymentError` (the template's `EscrowUnsupportedNetwork`), a `Schema.TaggedError` declaring `outcome: "not_applied"`, failed from a `Layer.unwrap` that reads `sui.network` (section 6) |
| `ObjectNotFoundError` | `ObjectNotFound`, plus `ObjectDeleted` and `ObjectUnavailable` from the SDK's own `reason` |
| `ObjectTypeMismatchError` | `DecodeError { objectId, expectedType, kind: "type", issue }` from the bridge's tag check. Branch on `kind`, which is `"type"` here and `"bytes"` for a BCS failure, so a consumer that used to catch a type mismatch to 404 a foreign object keeps doing exactly that and stops swallowing real decode bugs |
| `SuiRpcError { operation }` | `TransportError { method }`. For your own HTTP or GraphQL calls, `TransportError.fromUnknown(method, cause, retryable?)` classifies the status and the retryability the way `SuiCore` does — do not hand-build the three fields |
| `BcsDecodeError` | `DecodeError` |
| `TransactionFailedError { digest, status }` | `ExecutionFailed { digest, reason, command, effects }` |
| `getObjectContent` | `sui.getObject(id)` — with no schema, `content` is the raw bytes |
| `getOptionalObjectContent` | `sui.getObjectOption` — `None` for missing and deleted, which is also the blessed way to express domain absence |
| `getObjectsContent` | `sui.getObjects` — chunked, integrity-checked, a per-item `Result` instead of silently dropping errored ids; `sui.getObjectsStrict` (the deprecated `getObjectsOrFail`) when every id must be there |
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
| a hand-rolled idempotent submitter (persist the signed bytes, execute, wait, re-poll by digest on error, resubmit the identical bytes) | `Tx.build` → `Tx.sign` → `Tx.submit` with a durable `Journal` (`@unconfirmed/sui-effect/journal`), and `Tx.reconcileAll()` at startup. The journal write before the first send, the verbatim resubmit and the reconcile are all in `Tx.submit`; what stays yours is the domain record, which goes in `Tx.run`'s `onSigned` hook |
| `client.core.getTransaction(digest)` on a transaction that may have failed | `sui.core.getTransaction` — **not** `sui.getTransaction`, which fails with `ExecutionFailed` for a `FailedTransaction` (that is the point of it). Reach for the core tier when what you need is the failed transaction's own events or effects |
| a `ready()` that checks the genesis digest before anything else | `Sui.layerNoDepsWith({ chainId: deployment.chainIdentifier })`. `Sui.layerNoDeps` asserts the **built-in table's** id for the client's network, which is not the same claim as "this is the chain my deployment manifest was generated against"; `layerNoDepsPinned(chainId)` asserts nothing and makes no call, for a consumer that has already checked |
| a standalone read function the predecessor exported (`getReleaseById(client, id)`) | a member on the service taking the branded id and returning decoded content. Grep the consumer for the **function name**, not for a facade call site: a removed standalone export does not appear in any `client.*` search |

Five behaviour changes to put in the conversion issues:

1. `getObjects` returns a per-item `Result`; ids that failed are no longer
   silently dropped. `getObjectsStrict` is the fail-first variant.
2. `balanceChange` and `gasUsedTotal` are `bigint`, not `number` — and a
   `bigint` **throws** in `JSON.stringify`. Anything that logs, persists or
   returns one over HTTP needs `value.toString()` or a replacer
   (`(_, v) => typeof v === "bigint" ? v.toString() : v`). Decimal strings are
   what the wire uses and what every schema here decodes from, so a string is
   the right thing to store.
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
- declares `@unconfirmed/sui-effect`, `effect` or `@mysten/sui` in `dependencies` rather than
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
- has no `PromiseFace<Service>` type test per namespace, or has one that only
  checks the top level;
- exposes a class instance with `Effect`-returning methods without
  `SuiExtension.Leaf<T>` / `SuiExtension.leaf(value)`;
- calls `.make` on a branded schema with a value that came from outside;
- promises a `ConfigError` for an empty environment variable it reads with
  `Config.option`;
- has a test double for a signer that is not a real SDK `Signer`
  (`Signer.fromSdkSigner` now rejects a value with no `toSuiAddress`,
  `getKeyScheme` or `signTransaction`; use `Signer.remote` for a double);
- branches on a `DecodeError`'s `issue` text instead of its `kind`;
- typechecks its tests against an isolated-consumer fixture's installed
  `node_modules` (see section 10) rather than against the source under test.

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
  "@unconfirmed/sui-effect": "^0.1.0"
},
"peerDependenciesMeta": {
  "@unconfirmed/sui-effect": {
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

`@unconfirmed/sui-effect`, `effect`, `@mysten/sui` and **`@mysten/bcs`** are peer
dependencies, with the exact rcs pinned in `devDependencies`. `@mysten/bcs` is
on that list because your BCS layouts are `BcsType`s from it and they cross the
boundary into `SuiSchema.bcs`: two copies in one process is two `BcsType`
classes, and a codec built with one is not the codec the other's `instanceof`
recognises. Two copies of `effect` means two `Context.Service` identities and
layers that silently do not match; two copies of `@mysten/sui` means
`instanceof` on its error classes fails.

The template is shipped inside the published package, so
`node_modules/@unconfirmed/sui-effect/examples/extension-template/` is a directory you can
copy even when you have no checkout of this repository.

`examples/extension-template/README.md` has the step by step: rename the
package, the service identifier and the registration name; drop the `paths`
blocks that resolve `@unconfirmed/sui-effect` inside this repository; replace the package id,
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

@unconfirmed/sui-effect is built with TypeScript 5.9 and its emitted declarations are what a
consumer typechecks against. **Consumers on TypeScript 7 (`tsgo`) are
supported** — there is nothing in the shipped `.d.ts` that needs the old
compiler — and an extension package is free to use it. The `prepare` script in
this repository (`effect-language-service patch`) is a *library* concern: it
patches the checker for the diagnostics we develop against, and it belongs to
whoever builds this package, not to whoever consumes it. Do not copy it into a
consumer.

## 16. Before the first release

@unconfirmed/sui-effect is published as `@unconfirmed/sui-effect` on npm. While a conversion runs ahead of
a release that has not happened yet — a new peer version, an unpublished
change — the dependency needs a form that does not exist on the registry.

**Use the packed tarball.** It is the default, not the fallback:

```bash
cd /path/to/sui-effect && bun run build && npm pack
mkdir -p vendor && cp /path/to/sui-effect/unconfirmed-sui-effect-0.1.0.tgz vendor/
cd /path/to/your-package && bun add -d ./vendor/unconfirmed-sui-effect-0.1.0.tgz
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

**And re-install with `--force`.** bun keys a file dependency by name and
version, not by content, so re-packing over `vendor/unconfirmed-sui-effect-0.1.1.tgz`
and running `bun install` again leaves the *old* extraction in `node_modules` —
silently, and for as long as it takes you to notice that a fix you just made is
not there. Either bump the filename (`…-0.1.1+2.tgz`) or:

```bash
bun install --force
```

Verify it took: `cat node_modules/@unconfirmed/sui-effect/package.json | grep version`, or
grep the shipped `dist` for the change you are looking for.

**Until the first publish, bun probes the registry for every peer.** It does so
even for a peer a local dependency already satisfies, and an unpublished name
404s the install. The escape is
`"peerDependenciesMeta": { "@unconfirmed/sui-effect": { "optional": true } }` in your
`package.json` — which the template ships, because it is copied verbatim.

Put both halves of the swap on the release checklist:

1. replace the tarball with the published range (`"@unconfirmed/sui-effect": "^0.1.0"`);
2. **delete the `peerDependenciesMeta` entry.** Left in, it turns a genuinely
   missing peer into a silent `undefined` at import time;
3. re-run the isolated-consumer check against the published package.

Say in the PR which form was used while the branch was in flight. A `link:` that
reaches `main` is a build that works on one machine.

## 17. Application consumers

The sections above are for the package that *is* an extension. This one is for
the application that consumes one — a React or Svelte SPA, a Next route, a test
suite on vitest — because none of its problems are the extension's and all of
them are recurring.

**One runtime per process, at module scope.** An Effect program at the edge of a
browser app wants exactly one `ManagedRuntime`, built once and imported
everywhere:

<!-- inline -->

```ts
// sui-client.ts
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Sui, SuiCore } from "@unconfirmed/sui-effect"
import { Effect, Layer, ManagedRuntime } from "effect"

const client = new SuiGrpcClient({ network: deployment.network, url: deployment.url })

// `layerNoDepsWith({ chainId })` over the client you already have: the chain id
// asserted is the deployment's, not the built-in table's entry for the network.
const layer = Sui.layerNoDepsWith({ chainId: deployment.chainIdentifier }).pipe(
  Layer.provide(SuiCore.layerFromClient(client))
)

export const runtime = ManagedRuntime.make(layer)
export const runSui = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<A> =>
  runtime.runPromise(effect)

// Vite / webpack HMR: dispose the old runtime, or every edit leaks one.
if (import.meta.hot) import.meta.hot.dispose(() => void runtime.dispose())
```

**A `ManagedRuntime` memoizes its layer build, including a failure.** The build
here makes one `getChainIdentifier` call, and if that call fails — a flaky
network on the first paint, a proxy still waking up — the runtime caches the
failed build and **every** later use fails with the same stale `TransportError`,
forever. Three cures, and a browser app usually wants two of them: pass
`retry` (`Sui.layerNoDepsWith({ chainId, retry: Schedule.exponential("200 millis") })`)
so a transient failure does not decide the runtime's life; dispose and rebuild
the runtime when a use fails at the layer (it is a module-level `let`, not a
`const`, in that design); or use `Sui.layerNoDepsPinned(chainId)`, which makes no
call at all when the deployment manifest has already told you the chain id.

**`Journal`'s default is process-wide memory, and in a browser that means
nothing survives.** "A journal entry written before the first execute, so a
crash mid-flight leaves a record" is true of a server process and false of a
tab: a refresh is a new process with an empty `Map`, and two tabs are two
journals and two sender locks. What an app actually has is the
`SubmissionUnknown` in its hands — it carries the signed bytes, and
`SuiError.describe` prints them — so persist *that* (IndexedDB, `localStorage`,
your own backend) at the moment you catch it, and reconcile it on the next boot
with `Tx.reconcile(signed)`. `@unconfirmed/sui-effect/journal` over a
`KeyValueStore` is the durable version of the same idea when you want the
library to do it; see the Workers section for the adapter shape.

**Mapping failures onto UI states.** `SuiError.outcome(error)` is the axis:
`"applied"` means it happened and the UI must not offer "try again",
`"unknown"` means show the digest and a reconcile action, `"not_applied"` means
the button can be re-enabled. Two caveats. In a `catchAll` that only wraps a
build, a simulate or a signature, pass `{ phase: "pre-submit" }`, or an
extension error the taxonomy does not own comes back `"unknown"` and the UI
offers a reconcile for a transaction that was never built. And
`SuiError.describe(error)` is safe to show in a debug panel for **any** error,
including one of your own — since 0.1.2 it falls back to the tag and message
rather than returning nothing.

**Signing with an external cosigner, from an app.** A wallet signs as the
sender, a sponsorship service signs as the gas owner and submits. That is not
`Tx.run`: see "Sponsored by an external service" in section 5 for the exact
sequence, and note that the digest to record is the one `Tx.sign` already
returned.

**Testing an app on vitest.** The harness does not assume `bun:test`: it is
`layerTest`/`layerExtensionTest` plus `SuiTest`, all ordinary Effect values.
Give the app's own `runSui` a test double built on the same layer and the app's
components are testable with no network at all:

<!-- inline -->

```ts
// test/sui-client.ts
import { layerTest } from "@unconfirmed/sui-effect/testing"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Journal } from "@unconfirmed/sui-effect/tx"

export const testRuntime = (script: Parameters<typeof layerTest>[0] = {}) => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(layerTest(script), Journal.layerMemory)
  )
  return { runSui: runtime.runPromise.bind(runtime), dispose: () => runtime.dispose() }
}
```

Dispose it in an `afterEach`, keep `Journal.layerMemory` in the layer (the
default journal is process-wide and leaks entries between tests), and script
`getTransaction: [FakeOutcome.notFound()]` on anything that submits unless the
test means "this landed" — section 10 has the rest.

**Keep Effect out of the first paint if bundle size matters.** The runtime
module above is a fine dynamic `import()`: nothing in it runs until something
awaits it, and a lazy `$extend` registration costs nothing at module scope.

## 18. Workers and Durable Objects

Cloudflare Workers, Durable Objects and every other isolate runtime work, with
four differences that are not obvious.

**There is no `process`.** `Script` (and `Script.run`) is a Node entrypoint and
does not belong here; build the layer directly. Configuration comes from the
Worker's `env` argument, not from `process.env`, which means providing a
`ConfigProvider` per request rather than relying on the default one:

<!-- inline -->

```ts
const provider = ConfigProvider.fromEnvRecord(env as Record<string, string>)
const program = effect.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider))
```

**One runtime per isolate, never one per request.** `Effect.provide(effect,
Sui.layerNoDeps)` inside a `fetch` handler rebuilds the layer — and its chain-id
round trip — on every request. Cache a `ManagedRuntime` in module scope (a
Worker isolate is reused across requests) or on the Durable Object instance, and
read the "memoizes its failure" warning in section 17 (Application consumers): in an isolate that lives
for hours, a cached failed build is a much longer outage than in a tab.

**The sender lock does not cross isolates.** `sui.withSenderLock` is a
semaphore in one runtime's memory. Two isolates, two Durable Objects, two
regions — two locks, and nothing stops both picking the same gas coin. Either
serialize submissions for an address through one Durable Object (which is what
DOs are for), or stop depending on the lock: with `tx.setGasPayment([])` there is
no gas coin to equivocate on, the node picks from the address balance, and
`SubmitConfig.lockSender: false` is then correct rather than reckless. A
sponsored transaction built with `Tx.sponsored` already has an empty gas
payment, and `Tx.build` preserves it through the resolver.

**Time is not wall-clock time in a DO alarm.** `Tx.submit`'s resubmit schedule
and `visibilityTimeout` are Effect sleeps inside one invocation; a Durable
Object that wants to retry across hours uses an alarm and calls
`Tx.reconcileAll()` (or `Tx.reconcile(signed)`) when it wakes, with a durable
`Journal` underneath. That is the split: sleeps for seconds, alarms plus the
journal for anything longer.

### A `KeyValueStore` over Durable Object storage

`@unconfirmed/sui-effect/journal` needs a `KeyValueStore`, and Effect ships
memory, filesystem, SQL and Web Storage layers — none of which exist in a DO.
`KeyValueStore.makeStringOnly({ get, set, remove, clear, size })` is the whole
adapter: five members over strings, and the journal uses nothing else (its
entries are JSON and its unresolved index is one more key).

<!-- inline -->

```ts
import { KeyValueStore } from "effect/unstable/persistence"
import { Effect, Layer } from "effect"
import { layerKeyValueStore } from "@unconfirmed/sui-effect/journal"

const durableStore = (storage: DurableObjectStorage) =>
  KeyValueStore.makeStringOnly({
    get: (key) =>
      Effect.map(
        Effect.promise(() => storage.get<string>(key)),
        Option.fromNullishOr
      ),
    set: (key, value) => Effect.promise(() => storage.put(key, value)),
    remove: (key) => Effect.asVoid(Effect.promise(() => storage.delete(key))),
    clear: Effect.promise(() => storage.deleteAll()),
    size: Effect.map(Effect.promise(() => storage.list()), (map) => map.size)
  })

const journal = (storage: DurableObjectStorage) =>
  layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
    Layer.provide(Layer.succeed(KeyValueStore.KeyValueStore, durableStore(storage)))
  )
```

Build it once per DO instance, alongside the runtime. `onUnresolved: "fail"`
refuses to build while the store still holds unsettled entries, which is the
right setting for a process whose startup is allowed to demand attention and
the wrong one for a DO that must answer the next request.

## 19. Relay and sponsor envelopes

`Executed` describes the SDK's own execute include set: effects, events, balance
changes and the `objectTypes` join. A relay, a sponsor or any service that
submitted on your behalf sends back whatever *it* asked the node for, which is
usually less — `changedObjects` with an `objectId` and an `idOperation` and
nothing else, no `objectTypes`, no `balanceChanges`, no checkpoint, events as
JSON with no BCS.

`Executed.fromPartial(envelope)` decodes exactly that. What it was not told
stays "not told": the input and output states are `Unknown` rather than a
guessed `ObjectWrite`, versions and digests are `null`, and the accessors read
`Unknown` as "the envelope did not say" so `created()` and `deleted()` still
classify from the id operation alone. JSON spellings are accepted where the
SDK's types are not JSON — `bcs` as base64 or a byte array, every `u64` as a
number or a `bigint` as well as the decimal string.

Two things it cannot invent:

- **the types.** `created(type)`, `mutated(type)` and `expectCreated(type)`
  match against the `objectTypes` join, so without one they match nothing. Ask
  your relay for `objectTypes`; failing that, use `created()` unfiltered or
  `createdWhere(predicate)` and read the ids.
- **the gas.** `gasUsedTotal` is `0n` for an envelope that reported no gas.
  That means "not reported", not "free".

`Executed.fromTransactionResult(result)` is the other constructor: the strict
one, for an SDK `TransactionResult` read with the full include set, which is
what to use when the service handed you a real execute response.

### `Tx.submitVia`: the journal, for a submission you do not make

`Tx.submit` is what writes journal entries, and a consumer that hands its bytes
to a relay never calls it — so the crash window between "signed" and "the
service answered" had no record at all. `Tx.submitVia` is that path:

<!-- inline -->

```ts
const executed = yield* Tx.submitVia(signed, (bytes, signatures) =>
  postToTheRelay({ bytes: toBase64(bytes), signature: signatures[0]! }))
```

It writes the `Signed` entry **before** calling `send`, calls `send` exactly
once (a third party's submit is not known to be idempotent, and re-sending is
not the library's decision), turns the reply into an `Executed` when it carries
one — an SDK `TransactionResult`, a reduced envelope, or nothing at all, in
which case it asks the chain by the digest it already has — and journals the
terminal answer. A failure from `send` is ambiguous, so it ends in
`Tx.reconcile` with the full evidence rules; an error whose instance declares
`outcome: "not_applied"` is taken at its word and fails straight through
without spending a reconcile, which is how a service says "I refused this and
sent nothing". Declare that field on your relay-refusal error.

It fails with `ExecutionFailed`, `NotApplied`, `SubmissionUnknown` (carrying the
bytes, with the sender's failure as its `cause`), `JournalError` from the write
before the send, and your own error when it declared itself not-applied.

## 20. What extension authors must know

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
- **Copy `scripts/check-package.ts`.** It resolves `@unconfirmed/sui-effect`, `effect` and
  `@mysten/*` from your own `node_modules` first, so it works outside this
  repository unchanged. `@unconfirmed/sui-effect` belongs in `devDependencies` and
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
- **Write a `PromiseFace<Service>` type test per namespace**, and put `test` in
  the package `tsconfig`'s `include` so those pins actually compile. A namespace
  may be an `interface`; since 0.1.1 the face maps it the same as a type alias,
  so the local aliases a 0.1.0 conversion carried for this are unnecessary.
- **A class instance with `Effect`-returning methods needs
  `SuiExtension.leaf`.** `Uint8Array`, `Date`, `Promise`, arrays and BCS codecs
  are leaves already; everything else with a prototype of its own is passed
  through by the runtime and must say so in the type.
- **A cold call is a real `Promise`** that is also an `AsyncIterable`, and its
  rejection is pre-handled, so `expect(...).rejects` works and an un-awaited
  cold call cannot abort the test run.
- **`outcome` survives `SuiError.toJson`** even as a class field; keep declaring
  it as one.
- **`warm` throws *any* layer failure synchronously out of `$extend`**, not only
  an asynchronous step or a missing chain id.
- **Two copies of `@mysten/sui` are still a bug**, but `mapSdkError` duck-types
  the SDK's error classes now, so `ObjectNotFound` survives it and one warning
  names the real problem. Fix the duplication anyway: BCS codecs and
  `Transaction` inputs have no such fallback.
- **`SuiAddress.normalize` / `ObjectId.normalize`** take `"0x1"`; `.make` does
  not, and never will, because it validates without decoding.
- **`bun install --force` after re-packing a vendored tarball** with the same
  filename and version, or bun keeps the old extraction.
- **`DecodeError` carries a `kind`** — `"type"`, `"bytes"`, `"shape"`. Branch on
  it, never on `issue`.
- **Every taxonomy error has a real `.message`** since 0.1.2 (it is
  `SuiError.describe`), so anything that surfaces `.message` shows a line
  instead of an empty string, and `SuiError.describe` accepts a foreign error
  rather than returning `undefined` for it.
- **`Tx.reconcileAll` returns a tagged union** — `{ _tag: "Executed", executed }`
  or `{ _tag, error }` — not a bare `Executed | error`. It returns **only what
  was unresolved**; `Tx.recorded(digest)` is how to ask about a settled one.
- **`Tx.submit` fails outright on a gRPC `INVALID_ARGUMENT`** instead of
  reconciling: the node refused the request, nothing executed, and reconciling
  it would ask a question about a transaction that was never sent. That is the
  only `TransportError` that escapes `Tx.submit`.
- **A sponsored submission needs both signatures before `Tx.submit`**, on the
  fake as on a node. `Tx.cosign`, or `Tx.run`'s `sponsor`.
- **`Signer.fromSdkSigner` validates its argument** and reads `toSuiAddress()`
  and `getKeyScheme()` **at construction**. A test double needs all three
  members, or use `Signer.remote`.
- **`Signer.fromConfig` takes a 32-byte hex seed** as well as a Bech32
  `suiprivkey`, defaulting to Ed25519.
- **`Tx.run` has an `onSigned` hook** between the last signature and the first
  send, for a consumer's own record; `Tx.submitVia` is the same lifecycle when
  somebody else does the sending.
- **`bigint` throws in `JSON.stringify`.** Gas, balances and versions are all
  `bigint`; use `.toString()` or a replacer at every JSON boundary.
