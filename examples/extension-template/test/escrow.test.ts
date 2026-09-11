/**
 * The extension's tests: the real service, over the real `Sui`, over the
 * in-memory `SuiCore`. No network, no mocks of our own — everything the test
 * needs comes from `sui-effect/testing`.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { Sui, SuiCore } from "sui-effect"
import { ObjectId, SuiAddress } from "sui-effect"
import type { SuiCoreFake } from "sui-effect/testing"
import { FakeOutcome, layerExtensionTest, SuiTest } from "sui-effect/testing"
import { Journal, Signer } from "sui-effect/tx"
import { Escrow } from "../src/Escrow.ts"
import { EscrowNotFound, EscrowSettlementUnknown } from "../src/errors.ts"
import { ESCROW_PACKAGE, RECEIPT_TYPE } from "../src/schema.ts"

const padded = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = ObjectId.make(padded("e5c0"))
const RECEIPT_ID = padded("7ece17")
const MISSING_ID = ObjectId.make(padded("111"))

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7))
const signer = Signer.fromKeypair(keypair)
const SENDER = signer.address
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const EscrowBcs = bcs.struct("Escrow", {
  id: bcs.Address,
  owner: bcs.Address,
  amount: bcs.u64()
})

const escrowObject = (amount: string) => ({
  objectId: ESCROW_ID,
  type: `${ESCROW_PACKAGE}::escrow::Escrow`,
  version: 3n,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, owner: SENDER, amount }).toBytes()
})

/** Everything the fake serves: one escrow, one gas coin, one scripted execution. */
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

/**
 * One line of wiring: the extension's own test layer over `layerTest`, which is
 * the real `Sui` over the in-memory `SuiCore`. `{ local: true }` gives each
 * test a fresh fake.
 */
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

describe("Escrow", () => {
  test("get decodes an escrow object through the BCS bridge", async () => {
    const escrow = await provide(Effect.flatMap(Escrow, (escrow) => escrow.get(ESCROW_ID)))
    expect(escrow.content.amount).toBe("5")
    expect(Number(escrow.version)).toBe(3)
  })

  test("get is EscrowNotFound when the object is not there", async () => {
    const error = await provide(
      Effect.flatMap(Escrow, (escrow) => Effect.flip(escrow.get(MISSING_ID)))
    )
    expect(error).toBeInstanceOf(EscrowNotFound)
    expect((error as EscrowNotFound).outcome).toBe("not_applied")
  })

  test("get is EscrowNotFound after the object is deleted", async () => {
    const error = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        yield* SuiTest.deleteObject(ESCROW_ID)
        return yield* Effect.flip(escrow.get(ESCROW_ID))
      })
    )
    expect(error).toBeInstanceOf(EscrowNotFound)
  })

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

  test("an unsettled claim is EscrowSettlementUnknown, which exits 3", async () => {
    const error = await provide(
      Effect.flatMap(Escrow, (escrow) =>
        Effect.flip(escrow.claimFor(ESCROW_ID, { signer }))),
      { settled: false }
    )
    expect(error).toBeInstanceOf(EscrowSettlementUnknown)
    expect((error as EscrowSettlementUnknown).outcome).toBe("unknown")
  })

  test("the nested namespace streams and counts owned escrows", async () => {
    const { ids, count } = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        const ids = yield* Stream.runCollect(
          Stream.map(escrow.owned.stream(SuiAddress.make(SENDER)), (object) => object.id)
        )
        const count = yield* escrow.owned.count(SuiAddress.make(SENDER))
        return { ids, count }
      })
    )
    expect(count).toBe(1)
    expect(ids).toEqual([ESCROW_ID])
  })

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
})

describe("Escrow under the two clocks", () => {
  test("the chain's epoch bounds the transaction the extension submits", async () => {
    const expiration = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        yield* SuiTest.setClock(1_000_000_000_000n)
        yield* escrow.claimFor(ESCROW_ID, { signer })
        const sent = yield* SuiTest.calls("executeTransaction")
        const options = sent[0]?.options as { readonly transaction: Uint8Array }
        return TransactionDataBuilder.fromBytes(options.transaction).expiration
      })
    )
    // Every transaction an extension submits through `Tx` is bounded to the
    // current epoch and the next, and carries the chain identifier, with no
    // wiring in the extension at all. The bound is epochs rather than a wall
    // clock because no Sui network accepts a timestamp expiration yet.
    expect(expiration?.$kind).toBe("ValidDuring")
    if (expiration?.$kind === "ValidDuring") {
      expect(String(expiration.ValidDuring.minEpoch)).toBe("100")
      expect(String(expiration.ValidDuring.maxEpoch)).toBe("101")
      expect(expiration.ValidDuring.maxTimestamp).toBeNull()
    }
  })

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
})
