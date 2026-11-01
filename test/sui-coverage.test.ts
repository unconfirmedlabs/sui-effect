/**
 * 0.4.0's `Sui` coverage (issue #4, WP4): event and transaction streams, coin
 * and balance streams, coin metadata, dynamic object fields, name service, the
 * one structured "the reply did not decode" cause, and the widened `view`.
 * Every test runs on `layerTest`, the real `Sui` over the fake `SuiCore`.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { Effect, Layer, Option, Result, Stream } from "effect"
import { bcs } from "../src/domain/bcs.ts"
import { SuiSchema } from "../src/index.ts"
import { DecodeError, TransportError } from "../src/domain/errors.ts"
import { CoinType, ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { Tx } from "../src/services/Tx.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import {
  type FakeScript,
  FakeOutcome,
  fakeDigest,
  SuiCoreFake
} from "../src/services/SuiCoreFake.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const BOB = PADDED("b0b")
const PKG = PADDED("abc")
const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCore | SuiCoreFake>,
  script: FakeScript = {}
) =>
  Effect.runPromise(
    Effect.provide(effect, layerTest({ chainId: CHAIN_ID, ...script }), { local: true })
  )

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.map(Stream.runCollect(stream), (chunk) => [...chunk])

const event = (
  type: string,
  sender: string,
  amount: number
): SuiClientTypes.Event => ({
  packageId: PKG,
  module: type.split("::")[1] as string,
  sender,
  eventType: type,
  bcs: suiBcs.U64.serialize(amount).toBytes(),
  json: null
})

const U64 = bcs(suiBcs.U64, "u64")

const Deposited = `${PKG}::vault::Deposited`
const Withdrawn = `${PKG}::vault::Withdrawn`
const Minted = `${PKG}::coin_maker::Minted`

/** Three scripted transactions, in ledger order, with four events between them. */
const ledger: FakeScript["transactions"] = {
  [fakeDigest(1)]: FakeOutcome.succeed({
    sender: ALICE,
    moveCalls: [`${PKG}::vault::deposit`],
    checkpoint: "10",
    events: [event(Deposited, ALICE, 1), event(Deposited, ALICE, 2)]
  }),
  [fakeDigest(2)]: FakeOutcome.succeed({
    sender: BOB,
    moveCalls: [`${PKG}::coin_maker::mint`],
    checkpoint: "11",
    events: [event(Minted, BOB, 3)]
  }),
  [fakeDigest(3)]: FakeOutcome.failWith(
    { $kind: "MoveAbort", MoveAbort: { abortCode: "7" }, message: "aborted" } as never,
    {
      sender: ALICE,
      moveCalls: [`${PKG}::vault::withdraw`],
      checkpoint: "12",
      events: [event(Withdrawn, ALICE, 4)]
    }
  )
}

describe("streamEvents", () => {
  test("every event in ledger order, with its place in the ledger", async () => {
    const events = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* collect(sui.streamEvents())
      }),
      { transactions: ledger, pageSize: 1 }
    )
    expect(events.map((entry) => entry.eventType)).toEqual([Deposited, Deposited, Minted, Withdrawn])
    expect(events[1]?.eventIndex).toBe(1)
    expect(events[1]?.checkpoint).toBe(10n)
    expect(events[2]?.transactionDigest).toBe(fakeDigest(2) as never)
    expect(events[0]?.sender).toBe(SuiAddress.make(ALICE))
  })

  test("descending reads newest first and continues with `before`", async () => {
    const [events, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const events = yield* collect(sui.streamEvents(undefined, { order: "descending" }))
        return [events, yield* SuiTest.calls("listEvents")] as const
      }),
      { transactions: ledger, pageSize: 3 }
    )
    expect(events.map((entry) => entry.eventType)).toEqual([Withdrawn, Minted, Deposited, Deposited])
    const second = calls[1]?.options as { before?: string; after?: string }
    expect(second.before).toBe("1")
    expect(second.after).toBeUndefined()
  })

  test("the SDK's EventFilter: sender, emitModule, eventType", async () => {
    const [bySender, byModule, byType, byModuleType] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* collect(sui.streamEvents({ sender: BOB })),
          yield* collect(sui.streamEvents({ emitModule: `0xabc::vault` })),
          yield* collect(sui.streamEvents({ eventType: Withdrawn })),
          yield* collect(sui.streamEvents({ eventType: `${PKG}::coin_maker` }))
        ] as const
      }),
      { transactions: ledger }
    )
    expect(bySender.map((entry) => entry.eventType)).toEqual([Minted])
    expect(byModule).toHaveLength(3)
    expect(byType.map((entry) => entry.eventType)).toEqual([Withdrawn])
    expect(byModuleType.map((entry) => entry.eventType)).toEqual([Minted])
  })

  test("an empty page with hasNextPage does not end the stream", async () => {
    // A scan-limited server: each request examines one event, so the filter
    // for BOB's single event yields two empty pages before it and one after.
    const [events, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const events = yield* collect(sui.streamEvents({ sender: BOB }))
        return [events, yield* SuiTest.calls("listEvents")] as const
      }),
      { transactions: ledger, scanLimit: 1 }
    )
    expect(events.map((entry) => entry.eventType)).toEqual([Minted])
    expect(calls).toHaveLength(4)
  })

  test("a payload decodes with SuiSchema.decode", async () => {
    const amounts = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const events = yield* collect(sui.streamEvents({ eventType: Deposited }))
        return yield* Effect.forEach(events, (entry) => SuiSchema.decode(U64, entry.bcs))
      }),
      { transactions: ledger }
    )
    expect(amounts).toEqual(["1", "2"])
  })

  test("a reply that does not decode is a TransportError with a structured DecodeError", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* collect(sui.streamEvents()).pipe(Effect.flip)
      }),
      {
        transactions: {
          [fakeDigest(1)]: FakeOutcome.succeed({
            events: [{ ...event(Deposited, ALICE, 1), sender: "not an address" }]
          })
        }
      }
    )
    expect(error._tag).toBe("TransportError")
    expect(error.method).toBe("listEvents")
    expect(error.cause).toBeInstanceOf(DecodeError)
    const cause = error.cause as DecodeError
    expect(cause.kind).toBe("shape")
    expect(cause.issues?.some((issue) => issue.path.includes("sender"))).toBe(true)
  })
})

describe("streamTransactions", () => {
  test("every transaction as Executed; an on-chain failure is a Result failure", async () => {
    const transactions = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* collect(sui.streamTransactions())
      }),
      { transactions: ledger, pageSize: 2 }
    )
    expect(transactions).toHaveLength(3)
    expect(Result.isSuccess(transactions[0]!)).toBe(true)
    expect(Result.isSuccess(transactions[1]!)).toBe(true)
    const failed = transactions[2]!
    expect(Result.isFailure(failed)).toBe(true)
    if (Result.isFailure(failed)) {
      expect(failed.failure._tag).toBe("ExecutionFailed")
      expect(failed.failure.digest).toBe(fakeDigest(3) as never)
    }
    if (Result.isSuccess(transactions[0]!)) {
      expect(transactions[0].success.digest).toBe(fakeDigest(1) as never)
    }
  })

  test("asks for the execute include set and filters with the SDK's TransactionFilter", async () => {
    const [bySender, byFunction, byModule, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* collect(sui.streamTransactions({ sender: ALICE })),
          yield* collect(sui.streamTransactions({ function: `0xabc::coin_maker::mint` })),
          // A module filter cannot be paginated by the SDK, so the stream
          // refuses it; one page of it is a `core.listTransactions` call.
          (yield* sui.core.listTransactions({ filter: { function: `${PKG}::vault` } })).transactions,
          yield* SuiTest.calls("listTransactions")
        ] as const
      }),
      { transactions: ledger }
    )
    expect(bySender).toHaveLength(2)
    expect(byFunction).toHaveLength(1)
    expect(byModule).toHaveLength(2)
    expect((calls[0]?.options as { include?: unknown }).include).toEqual({
      effects: true,
      events: true,
      balanceChanges: true,
      objectTypes: true
    })
  })

  test("a transaction recorded later joins the ledger", async () => {
    const count = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        yield* SuiTest.recordTransaction(fakeDigest(9), FakeOutcome.succeed({ sender: BOB }))
        return (yield* collect(sui.streamTransactions({ sender: BOB }))).length
      }),
      { transactions: ledger }
    )
    expect(count).toBe(2)
  })

  test("a transaction the fake executed is listed, filtered on its bytes' sender and calls", async () => {
    const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
    const ESCROW = PADDED("e1")
    const [bySender, byFunction, byOther] = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        yield* Tx.run((tx) => {
          tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(ESCROW)] })
        }, { signer })
        return [
          yield* collect(sui.streamTransactions({ sender: signer.address })),
          yield* collect(sui.streamTransactions({ function: `${PKG}::escrow::claim` })),
          yield* collect(sui.streamTransactions({ function: `${PKG}::escrow::refund` }))
        ] as const
      }).pipe(
        Effect.provide(Journal.layerMemory),
        Effect.provide(
          layerTest({
            chainId: CHAIN_ID,
            objects: [{
              objectId: ESCROW,
              type: `${PKG}::escrow::Escrow`,
              version: 3n,
              owner: { $kind: "AddressOwner", AddressOwner: signer.address },
              content: new Uint8Array([1])
            }],
            coins: [{
              objectId: PADDED("c01"),
              version: "2",
              digest: "11111111111111111111111111111111",
              type: "0x2::coin::Coin<0x2::sui::SUI>",
              balance: "1000000000",
              owner: { $kind: "AddressOwner", AddressOwner: signer.address }
            }],
            execute: [FakeOutcome.succeed()]
          }),
          { local: true }
        )
      )
    )
    expect(bySender).toHaveLength(1)
    expect(byFunction).toHaveLength(1)
    expect(byOther).toHaveLength(0)
  })

  test("paginates through scan-limited empty pages", async () => {
    const [transactions, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const transactions = yield* collect(
          sui.streamTransactions({ sender: BOB }, { order: "descending" })
        )
        return [transactions, yield* SuiTest.calls("listTransactions")] as const
      }),
      { transactions: ledger, scanLimit: 1 }
    )
    expect(transactions).toHaveLength(1)
    expect(calls).toHaveLength(3)
  })
})

describe("coins, balances and metadata", () => {
  const SUI_COIN = "0x2::coin::Coin<0x2::sui::SUI>"
  const coins: ReadonlyArray<SuiClientTypes.Coin> = [1, 2, 3].map((n) => ({
    objectId: PADDED(`c${n}`),
    version: "4",
    digest: fakeDigest(40 + n),
    owner: { $kind: "AddressOwner", AddressOwner: ALICE },
    type: SUI_COIN,
    balance: String(n * 100)
  }))

  test("streamCoins pages through an owner's coins", async () => {
    const [streamed, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const streamed = yield* collect(sui.streamCoins(SuiAddress.make(ALICE)))
        return [streamed, yield* SuiTest.calls("listCoins")] as const
      }),
      { coins, pageSize: 2 }
    )
    expect(streamed.map((coin) => coin.balance)).toEqual([100n, 200n, 300n] as never)
    expect(streamed[0]?.objectId).toBe(ObjectId.make(PADDED("c1")))
    expect(calls).toHaveLength(2)
  })

  test("streamCoins passes the coin type through", async () => {
    const [streamed, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const streamed = yield* collect(
          sui.streamCoins(SuiAddress.make(ALICE), "0x2::sui::SUI" as CoinType)
        )
        return [streamed, yield* SuiTest.calls("listCoins")] as const
      }),
      { coins }
    )
    expect(streamed).toHaveLength(3)
    expect((calls[0]?.options as { coinType?: string }).coinType).toBe("0x2::sui::SUI")
  })

  test("streamBalances pages through an owner's balances", async () => {
    const balances = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* collect(sui.streamBalances(SuiAddress.make(ALICE)))
      }),
      {
        pageSize: 1,
        balances: [
          { owner: ALICE, coinType: "0x2::sui::SUI", balance: "5", coinBalance: "5", addressBalance: "0" },
          { owner: ALICE, coinType: `${PKG}::usd::USD`, balance: "9", coinBalance: "9", addressBalance: "0" },
          { owner: BOB, coinType: "0x2::sui::SUI", balance: "1", coinBalance: "1", addressBalance: "0" }
        ]
      }
    )
    expect(balances.map((balance) => balance.balance)).toEqual([5n, 9n] as never)
  })

  test("getCoinMetadataOption: Some for a known type, None for one with no metadata", async () => {
    const [known, unknown] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.getCoinMetadataOption("0x2::sui::SUI" as CoinType),
          yield* sui.getCoinMetadataOption(`${PKG}::nope::NOPE` as CoinType)
        ] as const
      }),
      {
        coinMetadata: {
          "0x2::sui::SUI": {
            id: PADDED("ee"),
            decimals: 9,
            name: "Sui",
            symbol: "SUI",
            description: "",
            iconUrl: null
          }
        }
      }
    )
    expect(Option.getOrThrow(known).decimals).toBe(9)
    expect(Option.getOrThrow(known).id).toBe(ObjectId.make(PADDED("ee")))
    expect(Option.isNone(unknown)).toBe(true)
  })
})

describe("getDynamicObjectFieldOption", () => {
  const PARENT = PADDED("aa")
  const CHILD = PADDED("cc")
  const ItemBcs = suiBcs.struct("Item", { id: suiBcs.Address, power: suiBcs.U64 })
  const ITEM_TYPE = `${PKG}::hero::Item`
  const Item = bcs(ItemBcs, ITEM_TYPE)
  const key = { type: "u64", bcs: suiBcs.U64.serialize(1).toBytes() }
  const script: FakeScript = {
    objects: [{
      objectId: CHILD,
      type: ITEM_TYPE,
      version: 5n,
      owner: { $kind: "ObjectOwner", ObjectOwner: PADDED("f0") },
      content: ItemBcs.serialize({ id: CHILD, power: 42 }).toBytes()
    }],
    dynamicFields: {
      [PARENT]: [{
        fieldId: PADDED("f0"),
        type: `0x2::dynamic_field::Field<0x2::dynamic_object_field::Wrapper<u64>, 0x2::object::ID>`,
        name: { type: "0x2::dynamic_object_field::Wrapper<u64>", bcs: key.bcs },
        valueType: "0x2::object::ID",
        $kind: "DynamicObject",
        childId: CHILD
      }]
    }
  }

  test("resolves the child object and decodes it with the schema", async () => {
    const item = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getDynamicObjectFieldOption(ObjectId.make(PARENT), key, { schema: Item })
      }),
      script
    )
    const value = Option.getOrThrow(item)
    expect(value.id).toBe(ObjectId.make(CHILD))
    expect(value.content.power).toBe("42")
  })

  test("None for a key that is not there; the type tag is still checked", async () => {
    const [missing, wrongType] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.getDynamicObjectFieldOption(ObjectId.make(PARENT), {
            type: "u64",
            bcs: suiBcs.U64.serialize(2).toBytes()
          }),
          yield* sui.getDynamicObjectFieldOption(ObjectId.make(PARENT), key, {
            expectedType: `${PKG}::hero::Sword`
          }).pipe(Effect.flip)
        ] as const
      }),
      script
    )
    expect(Option.isNone(missing)).toBe(true)
    expect(wrongType._tag).toBe("DecodeError")
  })
})

describe("name service", () => {
  const names = { "alice.sui": ALICE, "a.sui": ALICE }

  test("resolveNameServiceAddressOption", async () => {
    const [found, missing] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.resolveNameServiceAddressOption("alice.sui"),
          yield* sui.resolveNameServiceAddressOption("nobody.sui")
        ] as const
      }),
      { names }
    )
    expect(Option.getOrThrow(found)).toBe(SuiAddress.make(ALICE))
    expect(Option.isNone(missing)).toBe(true)
  })

  test("defaultNameServiceNameOption", async () => {
    const [found, missing] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.defaultNameServiceNameOption(SuiAddress.make(ALICE)),
          yield* sui.defaultNameServiceNameOption(SuiAddress.make(BOB))
        ] as const
      }),
      { names }
    )
    expect(Option.getOrThrow(found)).toBe("alice.sui")
    expect(Option.isNone(missing)).toBe(true)
  })

  test("an SDK before 2.33.2 threw NOT_FOUND for no name: that is None too", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.defaultNameServiceNameOption(SuiAddress.make(BOB))
      }).pipe(
        Effect.provide(
          Sui.layerNoDeps.pipe(
            Layer.provide(
              Layer.mock(SuiCore, {
                network: "localnet" as never,
                mvr: {} as never,
                getChainIdentifier: () => Effect.succeed({ chainIdentifier: CHAIN_ID }),
                defaultNameServiceName: () =>
                  Effect.fail(
                    new TransportError({
                      method: "defaultNameServiceName",
                      retryable: false,
                      status: "NOT_FOUND",
                      cause: "not found"
                    })
                  )
              })
            )
          )
        )
      )
    )
    expect(Option.isNone(result)).toBe(true)
  })

  test("unscripted, the fake dies naming the method", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.resolveNameServiceAddressOption("alice.sui")
      }).pipe(Effect.provide(layerTest({ chainId: CHAIN_ID })))
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("resolveNameServiceAddress")
  })
})

describe("one structured cause for a reply that did not decode (4.7)", () => {
  test("getBalance's boundary failure carries a DecodeError with issues", async () => {
    const error = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.getBalance(SuiAddress.make(ALICE)).pipe(Effect.flip)
      }),
      {
        balances: [{
          coinType: "0x2::sui::SUI",
          balance: "not a number",
          coinBalance: "0",
          addressBalance: "0"
        }]
      }
    )
    expect(error.retryable).toBe(false)
    expect(error.cause).toBeInstanceOf(DecodeError)
    const cause = error.cause as DecodeError
    expect(cause.kind).toBe("shape")
    expect(cause.issues?.[0]?.path).toEqual(["balance"])
  })
})

describe("view takes what simulate takes", () => {
  test("a Transaction, not only a recipe", async () => {
    const value = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const tx = new Transaction()
        tx.moveCall({ target: `${PKG}::hero::power` })
        return yield* sui.view(tx, suiBcs.U64)
      }),
      {
        simulate: [FakeOutcome.succeed({
          commandResults: [{ returnValues: [{ bcs: suiBcs.U64.serialize(42).toBytes() }] }]
        })]
      }
    )
    expect(value).toBe("42")
  })
})
