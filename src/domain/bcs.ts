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
import { normalizeStructTag } from "@mysten/sui/utils"
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
 * `Coin<0x2::sui::SUI>` and its padded spelling are the same type.
 */
export const bcs = <T extends Input, Input>(
  bcsType: BcsType<T, Input>,
  expectedType: string
): Schema.Codec<T, Uint8Array> => {
  const normalized = normalizeSafe(expectedType)
  // A BCS layout carries no runtime type to test a decoded value against: the
  // parse below is the validation, so the target schema accepts whatever the
  // layout produced.
  const target = Schema.declare((_u: unknown): _u is T => true)
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
                throw new Error(`expected ${bytes.length} bytes of ${normalized}`)
              }
              return parsed
            },
            catch: (cause) =>
              new SchemaIssue.InvalidValue(
                { message: `Could not parse ${normalized} from BCS content: ${String(cause)}` },
                bytes,
                options
              )
          }),
        encode: (value, options) =>
          Effect.try({
            try: () => bcsType.serialize(value).toBytes(),
            catch: (cause) =>
              new SchemaIssue.InvalidValue(
                { message: `Could not serialize ${normalized} to BCS: ${String(cause)}` },
                value,
                options
              )
          })
      })
    )
  ).annotate({ [SUI_TYPE_ANNOTATION]: normalized }) as unknown as Schema.Codec<T, Uint8Array>
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

/**
 * Whether an object's type tag satisfies a codec's expected type, comparing
 * normalized struct tags so generic instantiations match. Never fails.
 */
export const typeMatches = (expected: string, actual: string): boolean =>
  normalizeSafe(expected) === normalizeSafe(actual)

/**
 * Decodes object content with a codec, turning any schema failure into a
 * `DecodeError` that names the object and the type that was expected.
 *
 * Fails with: `DecodeError`.
 */
export const decodeContent = <T>(
  schema: Schema.Codec<T, Uint8Array>,
  content: Uint8Array,
  context?: { readonly objectId?: ObjectId; readonly expectedType?: string }
): Effect.Effect<T, DecodeError> =>
  Schema.decodeUnknownEffect(schema)(content).pipe(
    Effect.mapError(
      (error) =>
        new DecodeError({
          ...(context?.objectId === undefined ? {} : { objectId: context.objectId }),
          ...(context?.expectedType === undefined
            ? expectedTypeOf(schema) === undefined
              ? {}
              : { expectedType: expectedTypeOf(schema)! }
            : { expectedType: context.expectedType }),
          issue: error.message
        })
    )
  )
