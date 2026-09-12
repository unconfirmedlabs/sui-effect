/**
 * The BCS bridge: a `@mysten/bcs` layout becomes an Effect `Schema.Codec` whose
 * encoded side is the `content` bytes of an object.
 *
 * Decoding never reads the transport-varying `json` field of an object, only
 * `content`, so the same program gives the same answer on gRPC, GraphQL and
 * JSON-RPC.
 *
 * @since 0.1.0
 */
import type { BcsType } from "@mysten/bcs"
import { normalizeStructTag, parseStructTag } from "@mysten/sui/utils"
import { Effect, Schema, SchemaAST, SchemaIssue, SchemaTransformation } from "effect"
import { DecodeError } from "./errors.ts"
import type { ObjectId } from "./schemas.ts"

const SUI_TYPE_ANNOTATION = "sui-effect/suiType"

const normalizeSafe = (value: string): string => {
  try {
    return normalizeStructTag(value)
  } catch {
    return value
  }
}

/**
 * Turns a BCS layout into a `Schema.Codec<T, Uint8Array>` tagged with the Move
 * type it belongs to.
 *
 * Decoding fails with a `SchemaError` (which `Sui` maps to `DecodeError`) when
 * the bytes do not parse; encoding fails the same way when the value does not
 * serialize. The expected type is normalized with `normalizeStructTag`, so
 * `Coin<0x2::sui::SUI>` and its padded spelling are the same type, and a tag
 * with no type arguments matches every instantiation of it (see
 * {@link typeMatches}).
 *
 * **`expectedType` is optional.** A Move *return value* has no struct tag —
 * `sui.view(recipe, bcs.Address())` reads a `vector<u8>` off a command result —
 * and inventing one so the bridge has something to compare is worse than saying
 * there is nothing to compare. A codec built without an expected type carries
 * none, so nothing checks a tag before it parses: the re-serialize length check
 * is still what rejects mis-shaped bytes. Give the type whenever the bytes come
 * from an object, which is every `getObject(id, { schema })` read.
 */
export const bcs = <T extends Input, Input>(
  bcsType: BcsType<T, Input>,
  expectedType?: string
): Schema.Codec<T, Uint8Array> => {
  const normalized = expectedType === undefined ? undefined : normalizeSafe(expectedType)
  // What the failure messages call the layout when it has no Move type of its
  // own: `bcsType.name` is what `@mysten/bcs` named it (`"Escrow"`, `"vector"`).
  const label = normalized ?? bcsType.name
  // A BCS layout carries no runtime type to test a decoded value against: the
  // parse below is the validation, so the target schema accepts whatever the
  // layout produced.
  const target = Schema.declare((_u: unknown): _u is T => true, {
    identifier: label,
    description: `BCS layout ${label}`
  })
  return Schema.Uint8Array.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<T, Uint8Array>({
        decode: (bytes, options) =>
          Effect.try({
            try: () => {
              const parsed = bcsType.parse(bytes)
              // `parse` stops at the end of the layout and ignores whatever
              // follows, which would silently accept an `objectBcs` envelope
              // where `content` was expected. Re-serializing costs one pass and
              // catches both trailing and mis-shaped bytes.
              if (bcsType.serialize(parsed).toBytes().length !== bytes.length) {
                throw new Error(`expected ${bytes.length} bytes of ${label}`)
              }
              return parsed
            },
            catch: (cause) =>
              new SchemaIssue.InvalidValue(
                { message: `Could not parse ${label} from BCS content: ${String(cause)}` },
                bytes,
                options
              )
          }),
        encode: (value, options) =>
          Effect.try({
            try: () => bcsType.serialize(value).toBytes(),
            catch: (cause) =>
              new SchemaIssue.InvalidValue(
                { message: `Could not serialize ${label} to BCS: ${String(cause)}` },
                value,
                options
              )
          })
      })
    )
  ).annotate(
    normalized === undefined ? {} : { [SUI_TYPE_ANNOTATION]: normalized }
  ) as unknown as Schema.Codec<T, Uint8Array>
}

/**
 * A BCS layout plus the mapping into a domain value, as one codec.
 *
 * This is the shape every extension writes by hand and writes slightly
 * differently: parse the bytes with a layout, then hand the raw struct to a
 * constructor or a mapping function that may throw (an id that has to be
 * branded, a `bigint` that has to be range-checked, a discriminant that has to
 * become a union). Written out it is `SuiSchema.bcs(...)` piped into a
 * `Schema.decodeTo` with a `transformOrFail` and an `Effect.try`, and the part
 * that gets forgotten is turning the thrown value into a schema issue, so the
 * failure arrives as a defect instead of a `DecodeError`.
 *
 * `map` is called with whatever the layout parsed. Returning a value decodes
 * it; **throwing** fails the decode, and the thrown value's message becomes the
 * `DecodeError.issue` the caller sees, with the expected type already on it.
 * The result is a `Schema.Codec<A, Uint8Array>` like any other: pass it as
 * `sui.getObject(id, { schema })`, and the Move type check still runs first
 * because the annotation {@link bcs} leaves behind survives the composition.
 *
 * Encoding is not supported: a mapping function has no inverse, and inventing
 * one silently is worse than saying so. Encode with the layout itself when you
 * need bytes back.
 *
 * Fails with: `DecodeError` (through the schema), when the bytes do not parse
 * or `map` throws.
 *
 * @since 0.1.1
 *
 * @example
 * ```ts
 * import { ObjectId, SuiSchema } from "@unconfirmed/sui-effect"
 *
 * class Escrow {
 *   constructor(readonly id: ObjectId, readonly amount: bigint) {}
 * }
 *
 * const EscrowContent = SuiSchema.decodeWith(
 *   EscrowLayout,
 *   `${packageId}::escrow::Escrow`,
 *   (raw) => new Escrow(ObjectId.normalize(raw.id), BigInt(raw.amount))
 * )
 * ```
 */
export const decodeWith = <T extends Input, Input, A>(
  bcsType: BcsType<T, Input>,
  expectedType: string | undefined,
  map: (parsed: T) => A
): Schema.Codec<A, Uint8Array> => {
  const label = expectedType ?? bcsType.name
  const target = Schema.declare((_u: unknown): _u is A => true, {
    identifier: label,
    description: `BCS layout ${label}`
  })
  return bcs(bcsType, expectedType).pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<A, T>({
        decode: (parsed, options) =>
          Effect.try({
            try: () => map(parsed),
            catch: (cause) =>
              new SchemaIssue.InvalidValue(
                {
                  message: `Could not map ${label} into its domain value: ${String(cause)}`
                },
                parsed,
                options
              )
          }),
        encode: (value, options) =>
          Effect.fail(
            new SchemaIssue.Forbidden(
              {
                message:
                  `${label} was built with SuiSchema.decodeWith, which has no encoder: serialize with the BCS layout instead`
              },
              value,
              options
            )
          )
      })
    )
  ) as unknown as Schema.Codec<A, Uint8Array>
}

const MAX_ENCODING_DEPTH = 32

/**
 * Walks the encoding chain looking for the annotation {@link bcs} leaves
 * behind. `SuiSchema.bcs(...).pipe(Schema.decodeTo(DomainClass, ...))` puts a
 * new node on top and keeps the annotated node as the source side of the
 * transformation, so the tag survives composition.
 */
const findSuiType = (ast: SchemaAST.AST, depth: number): string | undefined => {
  const annotation = ast.annotations?.[SUI_TYPE_ANNOTATION]
  if (typeof annotation === "string") return annotation
  if (depth >= MAX_ENCODING_DEPTH) return undefined
  const encoding = ast.encoding
  if (encoding === undefined) return undefined
  for (const link of encoding) {
    const found = findSuiType(link.to, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * The normalized Move type a codec built by {@link bcs} expects, or `undefined`
 * for any other codec. `Sui.getObject` compares it with the object's own type
 * tag before decoding. Composition preserves it: a codec piped into
 * `Schema.decodeTo(DomainClass, ...)` still reports the type the bytes came
 * from. Never fails.
 */
export const expectedTypeOf = <T, E>(schema: Schema.Codec<T, E>): string | undefined =>
  findSuiType(schema.ast, 0)

const parseSafe = (value: string): ReturnType<typeof parseStructTag> | undefined => {
  try {
    return parseStructTag(value)
  } catch {
    return undefined
  }
}

/**
 * Whether an object's type tag satisfies an expected type.
 *
 * One rule, used everywhere a Move type is checked — the BCS bridge, the
 * `expectedType` option of `Sui.getObject`, `getObjectOption` and `getObjects`,
 * `SuiSchema.decode`, and the fake's owned-object filter:
 *
 * - **An expected tag with no type arguments names the generic itself**, so
 *   `pkg::m::Composition` matches every instantiation:
 *   `pkg::m::Composition<0x…::share::Share>` included. Only
 *   `address::module::name` is compared, with the address normalized. This is
 *   what a node does when a bare type is used as a filter, and it is what makes
 *   a generic Move type usable with the bridge at all: a codec is written once
 *   for `Composition<T>`, and the instantiation lives on the object.
 * - **An expected tag that carries type arguments is compared in full**, after
 *   `normalizeStructTag`, so `Coin<0x2::sui::SUI>` and its padded spelling are
 *   the same type and `Coin<0x2::sui::SUI>` does not match `Coin<0x…::usdc::USDC>`.
 *
 * Anything that is not a struct tag — the literal `package`, a primitive — is
 * compared as a normalized string. The object keeps its own instantiated type
 * on `SuiObject.type`; this only decides whether the bytes may be decoded.
 *
 * **It never throws, which is the reason it is public** as
 * `SuiSchema.matchesType`. A dynamic field's `name.type` is legally a primitive
 * — `u64`, `bool`, `address`, `vector<u8>` — and the SDK's own
 * `normalizeStructTag` throws on every one of them, so the obvious way to
 * filter a `streamDynamicFields` by key type dies on the first `u64` key.
 * Comparing tags with this is safe on any string at all.
 *
 * Never fails.
 */
export const typeMatches = (expected: string, actual: string): boolean => {
  const expectedTag = parseSafe(expected)
  if (expectedTag === undefined || expectedTag.typeParams.length > 0) {
    return normalizeSafe(expected) === normalizeSafe(actual)
  }
  const actualTag = parseSafe(actual)
  if (actualTag === undefined) return normalizeSafe(expected) === normalizeSafe(actual)
  return expectedTag.address === actualTag.address &&
    expectedTag.module === actualTag.module &&
    expectedTag.name === actualTag.name
}

/**
 * Decodes BCS `content` bytes with a codec, turning any schema failure into a
 * `DecodeError` that names the object and the type that was expected.
 *
 * This is what `Sui.getObject(id, { schema })` does after it has checked the
 * object's type tag, exposed as `SuiSchema.decode` for the places that already
 * have bytes: a dynamic field's value, an event payload, a `Stream` of
 * envelopes an extension decodes itself. Without it every caller reinvents the
 * same `Schema.decodeUnknownEffect(...).pipe(Effect.mapError(...))`, and the
 * `DecodeError` it produces is worse than this one.
 *
 * `expectedType` defaults to the Move type the codec was built with, so passing
 * it is only needed for a codec that carries none, or to override the recorded
 * one. `actualType` is the Move type the bytes actually came from, when the
 * caller knows it — a dynamic field's `name.type`, a stream envelope's `type`:
 * give it and the same tag check `getObject` does runs here, under the
 * {@link typeMatches} rule, before a byte is parsed. `objectId` is recorded on
 * the error so an operator knows which object did not decode.
 *
 * Fails with: `DecodeError`.
 */
export const decodeContent = <T>(
  schema: Schema.Codec<T, Uint8Array>,
  content: Uint8Array,
  context?: {
    readonly objectId?: ObjectId
    readonly expectedType?: string
    readonly actualType?: string
  }
): Effect.Effect<T, DecodeError> => {
  const expected = context?.expectedType ?? expectedTypeOf(schema)
  const withExpected = expected === undefined ? {} : { expectedType: expected }
  const withObject = context?.objectId === undefined ? {} : { objectId: context.objectId }
  const actual = context?.actualType
  if (expected !== undefined && actual !== undefined && !typeMatches(expected, actual)) {
    return Effect.fail(
      new DecodeError({
        ...withObject,
        ...withExpected,
        // The type tag did not match, so not a byte was parsed: this is the
        // decode failure a caller may answer with "not one of mine".
        kind: "type",
        issue: `${
          context?.objectId === undefined ? "the bytes have" : `object ${context.objectId} has`
        } type ${actual}`
      })
    )
  }
  return Schema.decodeUnknownEffect(schema)(content).pipe(
    Effect.mapError(
      (error) =>
        new DecodeError({
          ...withObject,
          ...withExpected,
          // The tag matched (or there was none to check) and the bytes
          // themselves did not parse: a layout mismatch or a corrupt object,
          // never something to swallow.
          kind: "bytes",
          issue: error.message
        })
    )
  )
}
