import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect } from "effect"
import { SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const BOB = PADDED("b0b")
const ESCROW = PADDED("e5c")
const TICKET = PADDED("41c")
const GAS_COIN = PADDED("6a5")
const OTHER_COIN = PADDED("07e")
const PACKAGE = PADDED("2")
const COIN_DIGEST = "7YcE7X6LmUcbqHcRYMRT8vBTxtnCbfGJkH6yZPFpTFwn"

const Escrow = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.U64 })

const coin = (
  objectId: string,
  owner: string,
  type = `0x2::coin::Coin<0x2::sui::SUI>`
): SuiClientTypes.Coin => ({
  objectId,
  version: "5",
  digest: COIN_DIGEST,
  owner: { $kind: "AddressOwner", AddressOwner: owner },
  type,
  balance: "1000000000"
})

const script = {
  network: "localnet" as SuiClientTypes.Network,
  referenceGasPrice: 1234n,
  gasBudget: 7_000_000n,
  coins: [
    coin(GAS_COIN, ALICE),
    coin(OTHER_COIN, BOB),
    coin(PADDED("d0c"), ALICE, `0x2::coin::Coin<0x2::usdc::USDC>`)
  ],
  objects: [
    {
      // A shared object: `tx.object` must become a SharedObject input.
      objectId: ESCROW,
      type: "0x2::escrow::Escrow",
      version: 3n,
      owner: {
        $kind: "Shared" as const,
        Shared: { initialSharedVersion: "1" }
      },
      content: Escrow.serialize({ id: ESCROW, amount: "5" }).toBytes()
    },
    {
      // An owned object: `tx.object` must become an ImmOrOwnedObject input.
      objectId: TICKET,
      type: "0x2::escrow::Ticket",
      version: 9n,
      digest: COIN_DIGEST,
      owner: { $kind: "AddressOwner" as const, AddressOwner: ALICE },
      content: new Uint8Array()
    }
  ]
}

const run = <A, E>(
  effect: Effect.Effect<A, E, SuiCore | SuiCoreFake>,
  layer = SuiCoreFake.layer(script)
) => Effect.runPromise(Effect.provide(effect, layer, { local: true }))

const claim = () => {
  const tx = new Transaction()
  tx.setSender(ALICE)
  const [paid] = tx.splitCoins(tx.gas, [100])
  tx.moveCall({
    target: `${PACKAGE}::escrow::claim`,
    arguments: [tx.object(ESCROW), tx.object(TICKET), tx.pure.u64(5n), paid!]
  })
  return tx
}

describe("the fake's resolve plugin", () => {
  test("builds a transaction to bytes that parse back", async () => {
    const parsed = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const bytes = yield* Effect.promise(() => claim().build({ client: fake.client }))
        return { bytes, data: TransactionDataBuilder.fromBytes(bytes) }
      })
    )
    expect(parsed.data.sender).toBe(ALICE)
    expect(parsed.data.gasData.price).toBe("1234")
    expect(parsed.data.gasData.budget).toBe("7000000")
    expect(parsed.data.gasData.payment).toEqual([
      { objectId: GAS_COIN, version: "5", digest: COIN_DIGEST }
    ])
    expect(parsed.data.commands).toHaveLength(2)
    // The shared object resolved from the stored owner, the owned one from its
    // version and digest, and the pure argument never needed the network.
    const kinds = parsed.data.inputs.map((input) =>
      input.$kind === "Object" ? input.Object.$kind : input.$kind
    )
    expect(kinds).toEqual(["Pure", "SharedObject", "ImmOrOwnedObject", "Pure"])
    const shared = parsed.data.inputs[1]
    expect(shared?.Object?.SharedObject).toMatchObject({
      objectId: ESCROW,
      initialSharedVersion: "1",
      mutable: true
    })
    expect(parsed.data.inputs[2]?.Object?.ImmOrOwnedObject).toMatchObject({
      objectId: TICKET,
      version: "9",
      digest: COIN_DIGEST
    })
  })

  test("an explicit empty gas payment is left alone", async () => {
    const payment = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const tx = new Transaction()
        tx.setSender(ALICE)
        tx.setGasPayment([])
        tx.moveCall({ target: `${PACKAGE}::escrow::ping`, arguments: [tx.object(ESCROW)] })
        const bytes = yield* Effect.promise(() => tx.build({ client: fake.client }))
        return TransactionDataBuilder.fromBytes(bytes).gasData.payment
      })
    )
    expect(payment).toEqual([])
  })

  test("an unknown input object fails the build", async () => {
    const failed = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const tx = new Transaction()
        tx.setSender(ALICE)
        tx.moveCall({ target: `${PACKAGE}::escrow::ping`, arguments: [tx.object(PADDED("dead"))] })
        return yield* Effect.promise(() =>
          tx
            .build({ client: fake.client })
            .then(() => false)
            .catch(() => true)
        )
      })
    )
    expect(failed).toBe(true)
  })
})

describe("listCoins", () => {
  test("serves the scripted coins the owner holds, by coin type", async () => {
    const result = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const sui = yield* core.listCoins({ owner: ALICE })
        const usdc = yield* core.listCoins({ owner: ALICE, coinType: "0x2::usdc::USDC" })
        const none = yield* core.listCoins({ owner: PADDED("f00") })
        return { sui: sui.objects, usdc: usdc.objects, none: none.objects }
      })
    )
    expect(result.sui.map((c) => c.objectId)).toEqual([GAS_COIN])
    expect(result.usdc).toHaveLength(1)
    expect(result.none).toHaveLength(0)
  })
})

describe("digests come from the bytes", () => {
  const bytesOf = (fake: SuiCoreFake["Service"]) =>
    Effect.promise(() => claim().build({ client: fake.client }))

  test("executeTransaction keys the transaction by the digest of its bytes", async () => {
    const layer = SuiCoreFake.layer({ ...script, execute: [FakeOutcome.succeed()] })
    const result = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        const bytes = yield* bytesOf(fake)
        const executed = yield* core.executeTransaction({ transaction: bytes, signatures: [] })
        const digest = executed.$kind === "Transaction"
          ? executed.Transaction.digest
          : executed.FailedTransaction.digest
        const found = yield* core.getTransaction({ digest })
        return {
          digest,
          expected: TransactionDataBuilder.getDigestFromBytes(bytes),
          foundDigest: found.$kind === "Transaction"
            ? found.Transaction.digest
            : found.FailedTransaction.digest
        }
      }),
      layer
    )
    expect(result.digest).toBe(result.expected)
    expect(result.foundDigest).toBe(result.expected)
  })

  test("timeoutThen(true) leaves the bytes digest findable afterwards", async () => {
    const layer = SuiCoreFake.layer({
      ...script,
      execute: [FakeOutcome.timeoutThen(true)],
      getTransaction: [FakeOutcome.succeed()]
    })
    const result = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        const bytes = yield* bytesOf(fake)
        const digest = TransactionDataBuilder.getDigestFromBytes(bytes)
        yield* Effect.exit(
          core
            .executeTransaction({ transaction: bytes, signatures: [] })
            .pipe(Effect.timeout("20 millis"))
        )
        return yield* Effect.exit(core.getTransaction({ digest }))
      }),
      layer
    )
    expect(result._tag).toBe("Success")
  })

  test("timeoutThen(false) makes the bytes digest report not found", async () => {
    const layer = SuiCoreFake.layer({ ...script, execute: [FakeOutcome.timeoutThen(false)] })
    const error = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        const bytes = yield* bytesOf(fake)
        const digest = TransactionDataBuilder.getDigestFromBytes(bytes)
        yield* Effect.exit(
          core
            .executeTransaction({ transaction: bytes, signatures: [] })
            .pipe(Effect.timeout("20 millis"))
        )
        return yield* core.getTransaction({ digest }).pipe(Effect.flip)
      }),
      layer
    )
    expect(error._tag).toBe("TransactionNotFound")
  })
})
