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
