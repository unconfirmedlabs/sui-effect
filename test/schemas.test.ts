/**
 * The branded schemas and the BCS bridge: decode at the boundary, the one Move
 * type rule, and the dynamic-field key builder.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import { normalizeStructTag } from "@mysten/sui/utils"
import { Effect, Result, Schema, SchemaTransformation } from "effect"
import { TestSchema } from "effect/testing"
import { bcs, decodeContent, expectedTypeOf, typeMatches } from "../src/domain/bcs.ts"
import {
  CoinType,
  Digest,
  makeSuiObject,
  Mist,
  ObjectEnvelope,
  ObjectId,
  Owner,
  StructTag,
  SuiAddress,
  Version
} from "../src/domain/schemas.ts"
import * as SuiSchema from "../src/domain/sui-schema.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const DIGEST = "7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn"
const COIN_TYPE = "0x2::coin::Coin<0x2::sui::SUI>"
const Coin = suiBcs.struct("Coin", { id: suiBcs.Address, balance: suiBcs.U64 })
const CoinCodec = bcs(Coin, COIN_TYPE)
const OBJECT_ID = PADDED("c01")
const content = Coin.serialize({ id: OBJECT_ID, balance: "123456789" }).toBytes()

const decodes = <A, I>(schema: Schema.Codec<A, I>, input: unknown) => Schema.decodeUnknownResult(schema)(input)
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect))

describe("branded schemas", () => {
  const roundTrips: ReadonlyArray<readonly [string, Schema.Codec<any, any>, unknown, unknown, unknown]> = [
    ["SuiAddress", SuiAddress, "0x2", PADDED("2"), PADDED("2")],
    ["ObjectId", ObjectId, "0x6", PADDED("6"), PADDED("6")],
    ["Digest", Digest, DIGEST, DIGEST, DIGEST],
    ["StructTag", StructTag, COIN_TYPE, `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`, `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`],
    ["CoinType", CoinType, "0x2::sui::SUI", `${PADDED("2")}::sui::SUI`, `${PADDED("2")}::sui::SUI`],
    ["Mist", Mist, "42", 42n, "42"],
    ["Version", Version, "7", 7n, "7"],
    ["Owner", Owner, { $kind: "Shared", Shared: { initialSharedVersion: "3" } }, { $kind: "Shared", Shared: { initialSharedVersion: 3n } }, { $kind: "Shared", Shared: { initialSharedVersion: "3" } }]
  ]
  for (const [name, schema, encoded, decoded, reencoded] of roundTrips) {
    test(`${name} decodes, normalizing, and encodes back`, async () => {
      const asserts = new TestSchema.Asserts(schema)
      await asserts.decoding().succeed(encoded, decoded)
      await asserts.encoding().succeed(decoded, reencoded)
    })
  }

  test("refuses malformed input, naming the brand", () => {
    const refused: ReadonlyArray<readonly [Schema.Codec<any, any>, unknown, string]> = [
      [SuiAddress, "0xnothex", "Expected a 32-byte Sui address"],
      [SuiAddress, "", "Expected a 32-byte Sui address"],
      [ObjectId, "0x", "Expected a 32-byte Sui object id"],
      [ObjectId, `0x${"ab".repeat(33)}`, "Expected a 32-byte Sui object id"],
      [Digest, "abc", "Expected a base58 32-byte transaction digest"],
      [CoinType, "not a type", "Expected a fully qualified Move coin type"],
      [Mist, "-1", "Expected a value greater than or equal to 0n"],
      [SuiAddress, 5, "Expected SuiAddress"]
    ]
    for (const [schema, input, message] of refused) {
      const result = decodes(schema, input)
      expect([input, result._tag === "Failure" ? String(result.failure) : "Success"]).toEqual([input, `SchemaError(${message})`])
    }
  })

  test("Strict takes exactly 64 hex digits, under the same brand", () => {
    const strict = Schema.decodeUnknownResult(SuiAddress.Strict)
    for (const bad of ["0x2", `0x${"a".repeat(60)}`, `0x${"a".repeat(65)}`, `0x${"g".repeat(64)}`]) {
      expect([bad, strict(bad)._tag]).toEqual([bad, "Failure"])
    }
    expect(Result.getOrThrow(strict(`0x${"AB".repeat(32)}`))).toBe(SuiAddress.make(`0x${"ab".repeat(32)}`))
    expect(Schema.decodeUnknownResult(ObjectId.Strict)(`0x${"a".repeat(60)}`)._tag).toBe("Failure")
    expect(Schema.decodeUnknownResult(CoinType.Strict)("0x2::sui::SUI")._tag).toBe("Success")
  })

  test("normalize decodes a shorthand and throws a SchemaError; make only validates", () => {
    expect(SuiAddress.normalize("0x2")).toBe(SuiAddress.make(PADDED("2")))
    expect(CoinType.normalize("0x2::sui::SUI")).toBe(CoinType.SUI)
    expect(StructTag.normalize(COIN_TYPE)).toBe(StructTag.make(`${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`))
    try {
      ObjectId.normalize("zz")
      throw new Error("expected a throw")
    } catch (error) {
      expect(Schema.isSchemaError(error)).toBe(true)
    }
    expect(() => ObjectId.make("0x6")).toThrow()
  })
})

describe("the BCS bridge", () => {
  test("decodes content into the Move struct and encodes it back", () => {
    expect(Result.getOrThrow(run(decodeContent(CoinCodec, content)))).toEqual({ id: OBJECT_ID, balance: "123456789" })
    expect(Array.from(Effect.runSync(Schema.encodeUnknownEffect(CoinCodec)({ id: OBJECT_ID, balance: "123456789" })))).toEqual(Array.from(content))
  })

  test("bad bytes, trailing bytes and another struct are DecodeErrors of the right kind", () => {
    const bad = run(decodeContent(CoinCodec, new Uint8Array([1, 2, 3]), { objectId: ObjectId.make(OBJECT_ID) }))
    expect(Result.isFailure(bad) && [bad.failure.kind, bad.failure.objectId, bad.failure.expectedType]).toEqual([
      "bytes",
      ObjectId.make(OBJECT_ID),
      normalizeStructTag(COIN_TYPE)
    ])
    const trailing = run(decodeContent(bcs(suiBcs.Address), new Uint8Array([...suiBcs.Address.serialize(OBJECT_ID).toBytes(), 7])))
    expect(Result.isFailure(trailing)).toBe(true)
    const wrongType = run(SuiSchema.decode(CoinCodec, content, { actualType: "0x2::coin::TreasuryCap<0x2::sui::SUI>" }))
    expect(Result.isFailure(wrongType) && wrongType.failure.kind).toBe("type")
  })

  test("the expected type is normalized, survives decodeTo, and is absent for a bare layout", () => {
    expect(expectedTypeOf(CoinCodec)).toBe(normalizeStructTag(COIN_TYPE))
    class Wallet extends Schema.Class<Wallet>("Wallet")({ id: Schema.String, balance: Schema.String }) {}
    const Composed = CoinCodec.pipe(
      Schema.decodeTo(Wallet, SchemaTransformation.transform({ decode: (value) => new Wallet(value), encode: (wallet) => ({ ...wallet }) }))
    )
    expect(expectedTypeOf(Composed)).toBe(expectedTypeOf(CoinCodec))
    expect(Effect.runSync(Schema.decodeUnknownEffect(Composed)(content))).toBeInstanceOf(Wallet)
    expect(expectedTypeOf(bcs(suiBcs.Address))).toBeUndefined()
  })

  test("decodeWith parses and maps in one codec, and a throwing mapper is a DecodeError", () => {
    const amount = SuiSchema.decodeWith(Coin, COIN_TYPE, (raw) => BigInt(raw.balance))
    expect(Result.getOrThrow(run(decodeContent(amount, content)))).toBe(123456789n)
    const throwing = SuiSchema.decodeWith(Coin, COIN_TYPE, () => {
      throw new Error("no")
    })
    expect(Result.isFailure(run(decodeContent(throwing, content)))).toBe(true)
  })

  test("a SuiObject carries its ref from the envelope", () => {
    const envelope = Effect.runSync(
      Schema.decodeUnknownEffect(ObjectEnvelope)({
        objectId: OBJECT_ID,
        version: "7",
        digest: "digest",
        owner: { $kind: "AddressOwner", AddressOwner: PADDED("a11ce0") },
        type: COIN_TYPE
      })
    )
    const object = makeSuiObject(envelope, { id: OBJECT_ID, balance: "1" })
    expect([object.id, object.ref.version, object.ref.type]).toEqual([
      ObjectId.make(OBJECT_ID),
      7n as Version,
      StructTag.make(normalizeStructTag(COIN_TYPE))
    ])
  })
})

describe("typeMatches: the one Move type rule", () => {
  const COMPOSITION = `${PADDED("c0de")}::composition::Composition`
  const SHARE = `${PADDED("5ha4e")}::share::Share`
  const cases: ReadonlyArray<readonly [string, string, boolean]> = [
    [COMPOSITION, `${COMPOSITION}<${SHARE}>`, true],
    ["0xc0de::composition::Composition", `${COMPOSITION}<${SHARE}>`, true],
    ["0x2::coin::Coin", COIN_TYPE, true],
    [COMPOSITION, `${PADDED("c0de")}::composition::Draft<${SHARE}>`, false],
    [COMPOSITION, `${PADDED("beef")}::composition::Composition`, false],
    [`${COMPOSITION}<${SHARE}>`, `${COMPOSITION}<${SHARE}>`, true],
    [`${COMPOSITION}<${SHARE}>`, COMPOSITION, false],
    [`${COMPOSITION}<${SHARE}>`, `${COMPOSITION}<0x2::sui::SUI>`, false],
    ["package", "package", true],
    ["package", COMPOSITION, false],
    ["u64", "u64", true]
  ]
  for (const [expected, actual, matches] of cases) {
    test(`${expected} ${matches ? "matches" : "does not match"} ${actual}`, () => expect(typeMatches(expected, actual)).toBe(matches))
  }

  test("a bare codec decodes an instantiated object's content", () => {
    const Generic = suiBcs.struct("Composition", { id: suiBcs.Address })
    const bytes = Generic.serialize({ id: OBJECT_ID }).toBytes()
    expect(Result.isSuccess(run(decodeContent(bcs(Generic, COMPOSITION), bytes, { actualType: `${COMPOSITION}<${SHARE}>` })))).toBe(true)
  })
})

describe("SuiSchema.name", () => {
  test("builds one key from a codec or from a layout and its input, with the type normalized", () => {
    const PostKey = suiBcs.struct("PostKey", { index: suiBcs.u64() })
    const KEY = `${PADDED("abc")}::board::PostKey`
    const bytes = PostKey.serialize({ index: 0 }).toBytes()
    expect(SuiSchema.name(PostKey, "0xabc::board::PostKey", { index: 0 })).toEqual({ type: KEY, bcs: bytes })
    expect(SuiSchema.name(bcs(PostKey, KEY), { index: "0" })).toEqual({ type: KEY, bcs: bytes })
    expect(SuiSchema.name(suiBcs.u64(), "u64", 7).type).toBe("u64")
    expect(() => SuiSchema.name(bcs(PostKey), { index: "0" })).toThrow("carries no Move type")
  })
})
