import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import { normalizeStructTag } from "@mysten/sui/utils"
import { Effect, Result, Schema, SchemaTransformation } from "effect"
import { bcs, decodeContent, expectedTypeOf, typeMatches } from "../src/domain/bcs.ts"
import { makeSuiObject, ObjectEnvelope, ObjectId, StructTag } from "../src/domain/schemas.ts"
import * as SuiSchema from "../src/domain/sui-schema.ts"

const SUI = "0x2::sui::SUI"
const COIN_TYPE = `0x2::coin::Coin<${SUI}>`
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`

/** The Move struct layout of `0x2::coin::Coin<T>`: a UID and a Balance<T>. */
const Coin = suiBcs.struct("Coin", {
  id: suiBcs.Address,
  balance: suiBcs.U64
})

const CoinCodec = bcs(Coin, COIN_TYPE)

const OBJECT_ID = PADDED("c01")
const content = Coin.serialize({ id: OBJECT_ID, balance: "123456789" }).toBytes()

/** A full `bcs.Object` envelope, as `include: { objectBcs: true }` would return. */
const objectBcs = suiBcs.Object.serialize({
  data: {
    Move: {
      type: { Other: { address: PADDED("2"), module: "coin", name: "Coin", typeParams: [] } },
      hasPublicTransfer: true,
      version: "7",
      contents: content
    }
  },
  owner: { AddressOwner: PADDED("a11ce0") },
  previousTransaction: "7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn",
  storageRebate: "1000"
}).toBytes()

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runSync(Effect.result(effect))

describe("SuiSchema.bcs", () => {
  test("decodes content bytes into the Move struct", () => {
    const decoded = run(decodeContent(CoinCodec, content))
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) {
      expect(decoded.success.balance).toBe("123456789")
      expect(decoded.success.id).toBe(OBJECT_ID)
    }
  })

  test("round trips through encoding", () => {
    const encoded = Effect.runSync(
      Schema.encodeUnknownEffect(CoinCodec)({ id: OBJECT_ID, balance: "123456789" })
    )
    expect(Array.from(encoded)).toEqual(Array.from(content))
  })

  test("decoding wrong bytes yields a DecodeError naming the expected type", () => {
    const decoded = run(
      decodeContent(CoinCodec, new Uint8Array([1, 2, 3]), {
        objectId: ObjectId.make(OBJECT_ID)
      })
    )
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("DecodeError")
      expect(decoded.failure.objectId).toBe(ObjectId.make(OBJECT_ID))
      expect(decoded.failure.expectedType).toBe(expectedTypeOf(CoinCodec) as string)
    }
  })

  test("the objectBcs envelope is not a Move struct and is rejected", () => {
    const decoded = run(decodeContent(CoinCodec, objectBcs))
    expect(Result.isFailure(decoded)).toBe(true)
  })

  test("bcs.Object parses the envelope and its contents match the content bytes", () => {
    const parsed = suiBcs.Object.parse(objectBcs)
    expect(Array.from(parsed.data.Move?.contents ?? [])).toEqual(Array.from(content))
  })

  test("the expected type is normalized", () => {
    expect(expectedTypeOf(CoinCodec)).toBe(
      `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`
    )
  })

  test("a generic instantiation matches after normalization", () => {
    expect(typeMatches(COIN_TYPE, `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`)).toBe(true)
    expect(typeMatches(COIN_TYPE, "0x2::coin::Coin<0x2::usdc::USDC>")).toBe(false)
    expect(typeMatches(COIN_TYPE, "0x2::escrow::Escrow")).toBe(false)
  })

  test("the expected type survives composition with decodeTo", () => {
    class Wallet extends Schema.Class<Wallet>("Wallet")({
      id: Schema.String,
      balance: Schema.String
    }) {}
    const Composed = CoinCodec.pipe(
      Schema.decodeTo(
        Wallet,
        SchemaTransformation.transform({
          decode: (value: { id: string; balance: string }) => new Wallet(value),
          encode: (wallet: Wallet) => ({ id: wallet.id, balance: wallet.balance })
        })
      )
    )
    expect(expectedTypeOf(Composed)).toBe(expectedTypeOf(CoinCodec))
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(Composed)(content))
    expect(decoded).toBeInstanceOf(Wallet)
    expect(decoded.balance).toBe("123456789")
  })

  test("expectedTypeOf is undefined for a codec that is not a BCS bridge", () => {
    expect(expectedTypeOf(Schema.Uint8Array as unknown as Schema.Codec<Uint8Array, Uint8Array>)).toBe(
      undefined
    )
  })
})

describe("SuiSchema.decode", () => {
  test("is the same decode getObject does, for bytes a caller already has", async () => {
    const decoded = await Effect.runPromise(SuiSchema.decode(CoinCodec, content))
    expect(decoded.balance).toBe("123456789")
  })

  test("a failure is a DecodeError naming the object and the type", async () => {
    const error = await Effect.runPromise(
      SuiSchema.decode(CoinCodec, new Uint8Array([1, 2, 3]), {
        objectId: ObjectId.make(OBJECT_ID)
      }).pipe(Effect.flip)
    )
    expect(error._tag).toBe("DecodeError")
    expect(error.objectId).toBe(ObjectId.make(OBJECT_ID))
    // The expected type comes off the codec, so a caller does not repeat it.
    expect(error.expectedType).toBe(normalizeStructTag(COIN_TYPE))
  })

  test("an explicit expectedType overrides the codec's", async () => {
    const error = await Effect.runPromise(
      SuiSchema.decode(CoinCodec, new Uint8Array([9]), { expectedType: "0x9::a::B" }).pipe(
        Effect.flip
      )
    )
    expect(error.expectedType).toBe("0x9::a::B")
  })

  test("it is the very function Sui decodes object content with", () => {
    expect(SuiSchema.decode).toBe(decodeContent)
  })
})

describe("SuiObject", () => {
  test("carries a ref built from the envelope", () => {
    const envelope = Effect.runSync(
      Schema.decodeUnknownEffect(ObjectEnvelope)({
        objectId: OBJECT_ID,
        version: "7",
        digest: "digest",
        owner: { $kind: "AddressOwner", AddressOwner: PADDED("a11ce0") },
        type: COIN_TYPE
      })
    )
    const object = makeSuiObject(envelope, { id: OBJECT_ID, balance: "123456789" })
    expect(object.id).toBe(ObjectId.make(OBJECT_ID))
    expect(object.ref.version).toBe(7n as never)
    expect(object.ref.type).toBe(StructTag.make(`${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`))
    expect(object.content.balance).toBe("123456789")
  })
})

describe("typeMatches: bare tags and instantiations", () => {
  const COMPOSITION = `${PADDED("c0de")}::composition::Composition`
  const SHARE = `${PADDED("5ha4e")}::share::Share`

  test("a bare expected tag accepts every instantiation of it", () => {
    expect(typeMatches(COMPOSITION, `${COMPOSITION}<${SHARE}>`)).toBe(true)
    expect(typeMatches("0x2::coin::Coin", COIN_TYPE)).toBe(true)
    expect(typeMatches("0xc0de::composition::Composition", `${COMPOSITION}<${SHARE}>`)).toBe(true)
  })

  test("a bare expected tag still refuses another type", () => {
    expect(typeMatches(COMPOSITION, `${PADDED("c0de")}::composition::Draft<${SHARE}>`)).toBe(false)
    expect(typeMatches(COMPOSITION, `${PADDED("beef")}::composition::Composition`)).toBe(false)
    expect(typeMatches(COMPOSITION, "package")).toBe(false)
  })

  test("an expected tag with type arguments is compared in full", () => {
    expect(typeMatches(`${COMPOSITION}<${SHARE}>`, `${COMPOSITION}<${SHARE}>`)).toBe(true)
    expect(typeMatches(`${COMPOSITION}<${SHARE}>`, COMPOSITION)).toBe(false)
    expect(typeMatches(`${COMPOSITION}<${SHARE}>`, `${COMPOSITION}<0x2::sui::SUI>`)).toBe(false)
  })

  test("a non-struct type compares as a normalized string", () => {
    expect(typeMatches("package", "package")).toBe(true)
    expect(typeMatches("package", COMPOSITION)).toBe(false)
  })

  test("a bare codec decodes an instantiated object's content", () => {
    const Generic = suiBcs.struct("Composition", { id: suiBcs.Address })
    const codec = bcs(Generic, COMPOSITION)
    const bytes = Generic.serialize({ id: OBJECT_ID }).toBytes()
    const decoded = run(
      decodeContent(codec, bytes, {
        objectId: ObjectId.make(OBJECT_ID),
        actualType: `${COMPOSITION}<${SHARE}>`
      })
    )
    expect(Result.isSuccess(decoded)).toBe(true)
  })

  test("SuiSchema.decode refuses bytes whose actual type is another struct", () => {
    const Generic = suiBcs.struct("Composition", { id: suiBcs.Address })
    const codec = bcs(Generic, COMPOSITION)
    const bytes = Generic.serialize({ id: OBJECT_ID }).toBytes()
    const decoded = run(
      SuiSchema.decode(codec, bytes, {
        objectId: ObjectId.make(OBJECT_ID),
        actualType: `${PADDED("c0de")}::composition::Draft`
      })
    )
    expect(Result.isFailure(decoded)).toBe(true)
    if (Result.isFailure(decoded)) {
      expect(decoded.failure._tag).toBe("DecodeError")
      expect(decoded.failure.expectedType).toBe(normalizeStructTag(COMPOSITION))
      expect(decoded.failure.issue).toContain("Draft")
    }
  })
})

describe("SuiSchema.bcs without an expected type", () => {
  test("carries no Move type and checks none", () => {
    const codec = bcs(suiBcs.Address)
    expect(expectedTypeOf(codec)).toBeUndefined()
    const bytes = suiBcs.Address.serialize(OBJECT_ID).toBytes()
    const decoded = run(decodeContent(codec, bytes, { actualType: "0x2::whatever::Thing" }))
    expect(Result.isSuccess(decoded)).toBe(true)
    if (Result.isSuccess(decoded)) expect(decoded.success).toBe(OBJECT_ID)
  })

  test("still rejects trailing bytes, which is the check that does not need a type", () => {
    const codec = bcs(suiBcs.Address)
    const bytes = new Uint8Array([...suiBcs.Address.serialize(OBJECT_ID).toBytes(), 7])
    expect(Result.isFailure(run(decodeContent(codec, bytes)))).toBe(true)
  })
})
