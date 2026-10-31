/**
 * The fake's address-balance model (DESIGN §14, 0.4.0): seeding, the
 * `getBalance`/`listBalances` composition, the resolver's `setGasPayment`
 * mirror, the node-shaped execution refusals, and the balances a successful
 * (or failed) execution moves.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, type TransactionArgument, TransactionDataBuilder } from "@mysten/sui/transactions"
import { fromBase58, normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { Sui } from "../src/services/Sui.ts"
import { fakeCoin, FakeOutcome, type FakeScript, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = "0x2::sui::SUI"
const USDC = `${PADDED("a11ce")}::usdc::USDC`
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41)))
const SENDER = signer.address
const RECIPIENT = normalizeSuiAddress("0xb0b")
const OTHER = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(42))).address

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

/** Net gas of the fake's default gas summary: 1_000_000 + 2_000_000 - 980_000. */
const DEFAULT_NET_GAS = 2_020_000n
const ONE_SUI = 1_000_000_000n

const funded = (addressBalance: bigint, who?: string, coinType = SUI) => ({
  ...(who === undefined ? {} : { owner: who }),
  coinType,
  balance: addressBalance.toString(),
  coinBalance: "0",
  addressBalance: addressBalance.toString()
})

const coinA = fakeCoin({ objectId: "0xc01", owner: SENDER, balance: 400n })
const coinB = fakeCoin({ objectId: "0xc02", owner: SENDER, balance: 600n })

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner, content: new Uint8Array() }],
  coins: [coinA, coinB],
  balances: [funded(ONE_SUI, SENDER)],
  execute: [FakeOutcome.succeed()]
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript = baseScript
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), {
      local: true
    })
  )

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

const sendFunds = (tx: Transaction, value: TransactionArgument, to: string, coinType = SUI, module = "coin") => {
  tx.moveCall({
    target: `0x2::${module}::send_funds`,
    typeArguments: [coinType],
    arguments: [value, tx.pure.address(to)]
  })
}

const dataOf = (bytes: Uint8Array) => TransactionDataBuilder.fromBytes(bytes)

const coinIds = Effect.flatMap(SuiCoreFake, (fake) =>
  Effect.promise(() => fake.client.core.listCoins({ owner: SENDER, coinType: SUI })).pipe(
    Effect.map((page) => page.objects.map((coin) => normalizeSuiAddress(coin.objectId)))
  ))

describe("seeding", () => {
  test("owner-specific entry, owner-less entry, unscripted type", async () => {
    const result = await run(
      Effect.gen(function*() {
        return {
          sender: yield* SuiTest.addressBalance(SENDER),
          other: yield* SuiTest.addressBalance(OTHER),
          unscripted: yield* SuiTest.addressBalance(SENDER, USDC)
        }
      }),
      { ...baseScript, balances: [funded(7n), funded(5n, SENDER)] }
    )
    expect(result).toEqual({ sender: 5n, other: 7n, unscripted: 0n })
  })

  test("a written value wins over the seed", async () => {
    const result = await run(
      Effect.gen(function*() {
        yield* SuiTest.setAddressBalance(SENDER, 42n)
        yield* SuiTest.setAddressBalance(SENDER, 9n, USDC)
        return [yield* SuiTest.addressBalance(SENDER), yield* SuiTest.addressBalance(SENDER, USDC)]
      })
    )
    expect(result).toEqual([42n, 9n])
  })
})

describe("getBalance / listBalances", () => {
  test("an untouched scripted entry is served verbatim, a touched one with the new address balance", async () => {
    const entry = { owner: SENDER, coinType: SUI, balance: "10", coinBalance: "3", addressBalance: "7" }
    const [before, after] = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const before = yield* Effect.promise(() => fake.client.core.getBalance({ owner: SENDER }))
        yield* SuiTest.setAddressBalance(SENDER, 2n)
        const after = yield* Effect.promise(() => fake.client.core.getBalance({ owner: SENDER }))
        return [before.balance, after.balance]
      }),
      { ...baseScript, balances: [entry] }
    )
    expect(before).toEqual({ coinType: SUI, balance: "10", coinBalance: "3", addressBalance: "7" })
    expect(after).toEqual({ coinType: SUI, balance: "5", coinBalance: "3", addressBalance: "2" })
  })

  test("with no entry: coinBalance is the owner's coins, balance adds the address balance", async () => {
    const balance = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        yield* SuiTest.setAddressBalance(SENDER, 50n)
        return (yield* Effect.promise(() => fake.client.core.getBalance({ owner: SENDER }))).balance
      }),
      { ...baseScript, balances: [] }
    )
    // The SDK client normalizes a coin type it defaulted.
    expect(balance).toEqual({ coinType: normalizeStructTag(SUI), balance: "1050", coinBalance: "1000", addressBalance: "50" })
  })

  test("listBalances: scripted entries, then address balances and coin types no entry names", async () => {
    const usdcCoin = fakeCoin({ objectId: "0xd01", owner: SENDER, balance: 30n, coinType: USDC })
    const OTHER_COIN = `${PADDED("beef")}::other::OTHER`
    const balances = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        yield* SuiTest.setAddressBalance(SENDER, 11n, OTHER_COIN)
        yield* SuiTest.setAddressBalance(SENDER, 0n, `${PADDED("dead")}::zero::ZERO`)
        return (yield* Effect.promise(() => fake.client.core.listBalances({ owner: SENDER }))).balances
      }),
      { ...baseScript, coins: [coinA, usdcCoin] }
    )
    expect(balances).toEqual([
      { coinType: SUI, balance: ONE_SUI.toString(), coinBalance: "0", addressBalance: ONE_SUI.toString() },
      { coinType: normalizeStructTag(OTHER_COIN), balance: "11", coinBalance: "0", addressBalance: "11" },
      { coinType: normalizeStructTag(USDC), balance: "30", coinBalance: "30", addressBalance: "0" }
    ])
  })
})

describe("the resolver's gas payment", () => {
  test("pays from the address balance when it covers the budget and tx.gas is unused", async () => {
    const built = await run(Tx.build(claim, { sender: SENDER }))
    expect(dataOf(built.bytes).gasData.payment).toEqual([])
  })

  test("pays with coins when the address balance does not cover the budget", async () => {
    const built = await run(Tx.build(claim, { sender: SENDER }), {
      ...baseScript,
      balances: [funded(1000n, SENDER)]
    })
    expect(dataOf(built.bytes).gasData.payment?.map((ref) => normalizeSuiAddress(ref.objectId))).toEqual([
      coinA.objectId,
      coinB.objectId
    ])
  })

  test("puts a coin reservation ref ahead of the coins for a tx.gas user with a balance", async () => {
    const usesGas = (tx: Transaction) => {
      tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(5n)])], tx.pure.address(RECIPIENT))
    }
    const [first, again, otherOwner] = await run(
      Effect.gen(function*() {
        const first = yield* Tx.build(usesGas, { sender: SENDER })
        const again = yield* Tx.build(usesGas, { sender: SENDER })
        yield* SuiTest.setAddressBalance(OTHER, ONE_SUI)
        const otherOwner = yield* Tx.build(usesGas, { sender: OTHER })
        return [first, again, otherOwner]
      })
    )
    const payment = dataOf(first.bytes).gasData.payment ?? []
    expect(payment).toHaveLength(3)
    const [reservation, ...coins] = payment
    expect(coins.map((ref) => normalizeSuiAddress(ref.objectId))).toEqual([coinA.objectId, coinB.objectId])
    // The shape `Tx.ts`'s `isCoinReservationRef` (and the SDK) recognize.
    expect(String(reservation?.version)).toBe("0")
    const digest = fromBase58(reservation?.digest ?? "")
    expect(digest.length).toBe(32)
    expect([...digest.slice(12)].every((byte) => byte === 0xac)).toBe(true)
    const view = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
    expect(view.getBigUint64(0, true)).toBe(ONE_SUI)
    expect(view.getUint32(8, true)).toBe(100)
    // Deterministic per owner, different across owners.
    expect(dataOf(again.bytes).gasData.payment?.[0]?.objectId).toBe(reservation?.objectId)
    expect(dataOf(otherOwner.bytes).gasData.payment?.[0]?.objectId).not.toBe(reservation?.objectId)
  })

  test("no coins and no balance: the SDK's own error, as a BuildError", async () => {
    const error = await run(Effect.flip(Tx.build(claim, { sender: SENDER })), {
      ...baseScript,
      coins: [],
      balances: []
    })
    expect(error._tag).toBe("BuildError")
    expect(`${error.message} ${String((error as { readonly cause?: unknown }).cause)}`).toContain(
      "No valid gas coins found for the transaction."
    )
  })

  test("an explicit payment is left alone", async () => {
    const built = await run(
      Tx.build((tx) => {
        claim(tx)
        tx.setGasPayment([{ objectId: coinB.objectId, version: coinB.version, digest: coinB.digest }])
      }, { sender: SENDER })
    )
    expect(dataOf(built.bytes).gasData.payment?.map((ref) => normalizeSuiAddress(ref.objectId))).toEqual([
      coinB.objectId
    ])
  })
})

describe("execution refusals", () => {
  test("an empty payment the payer's balance no longer covers", async () => {
    const { error, entry, retried, after } = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: SENDER }), signer)
        yield* SuiTest.setAddressBalance(SENDER, 0n)
        const error = yield* Effect.flip(Tx.submit(signed))
        const entry = yield* (yield* Journal).get(signed.digest)
        // Nothing was recorded as executed: funded again, the same bytes execute
        // as a new transaction and are charged.
        yield* SuiTest.setAddressBalance(SENDER, ONE_SUI)
        const retried = yield* Effect.promise(() =>
          fake.client.core.executeTransaction({
            transaction: signed.bytes,
            signatures: [...signed.signatures]
          })
        )
        return { error, entry, retried, after: yield* SuiTest.addressBalance(SENDER) }
      })
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag !== "TransportError") return
    expect(error.status).toBe("INVALID_ARGUMENT")
    expect(String(error.cause)).toContain(
      `Invalid withdraw reservation: Insufficient address balance of coin type 0x2::sui::SUI for address ${SENDER}:` +
        " the transaction requires 50000000 but only 0 is available"
    )
    expect(Option.isSome(entry) && entry.value._tag).toBe("NotApplied")
    if (Option.isSome(entry) && entry.value._tag === "NotApplied") expect(entry.value.evidence).toBe("refused")
    expect(retried.$kind).toBe("Transaction")
    expect(after).toBe(ONE_SUI - DEFAULT_NET_GAS)
  })

  test("a FundsWithdrawal its source's balance does not cover", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* Tx.sign(
          yield* Tx.build((tx) => {
            sendFunds(tx, tx.balance({ type: USDC, balance: 100n }), RECIPIENT, USDC, "balance")
          }, { sender: SENDER }),
          signer
        )
        yield* SuiTest.setAddressBalance(SENDER, 40n, USDC)
        return yield* Effect.flip(Tx.submit(signed))
      }),
      { ...baseScript, balances: [funded(ONE_SUI, SENDER), funded(100n, SENDER, USDC)] }
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag !== "TransportError") return
    expect(error.status).toBe("INVALID_ARGUMENT")
    expect(String(error.cause)).toContain("Invalid withdraw reservation: Insufficient address balance of coin type")
    expect(String(error.cause)).toContain(`for address ${SENDER}: the transaction requires 100 but only 40 is available`)
  })

  test("an empty payment with no owned input and no ValidDuring expiration", async () => {
    const { error, executed } = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const tx = new Transaction()
        tx.setSender(SENDER)
        tx.moveCall({ target: `${PADDED("2")}::escrow::ping`, arguments: [tx.pure.u64(1n)] })
        tx.setGasPayment([])
        tx.setGasBudget(1_000_000)
        tx.setGasPrice(1000)
        tx.setExpiration({ None: true })
        const bytes = yield* Effect.promise(() => tx.build({ client: fake.client }))
        const signed = yield* Tx.sign(yield* Tx.fromBytes(bytes), signer)
        const error = yield* Effect.flip(Tx.submit(signed))
        return { error, executed: yield* SuiTest.addressBalance(SENDER) }
      })
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag !== "TransportError") return
    expect(error.status).toBe("INVALID_ARGUMENT")
    expect(String(error.cause)).toContain(
      "Transactions must either have address-owned inputs, or a ValidDuring expiration with at most two epochs of validity"
    )
    expect(executed).toBe(ONE_SUI)
  })
})

describe("execution effects", () => {
  test("a success charges the net gas of the effects it returned to the payer's balance", async () => {
    const gasUsed = {
      computationCost: "3000000",
      storageCost: "1000000",
      storageRebate: "500000",
      nonRefundableStorageFee: "0"
    }
    const after = await run(
      Effect.gen(function*() {
        yield* Tx.run(claim, { signer })
        return yield* SuiTest.addressBalance(SENDER)
      }),
      { ...baseScript, execute: [FakeOutcome.succeed({ gasUsed })] }
    )
    expect(after).toBe(ONE_SUI - 3_500_000n)
  })

  test("a failure charges the net gas too, and nothing else", async () => {
    const { error, sender, recipient } = await run(
      Effect.gen(function*() {
        const error = yield* Effect.flip(
          Tx.run((tx) => sendFunds(tx, tx.balance({ balance: 100n }), RECIPIENT, SUI, "balance"), { signer })
        )
        return {
          error,
          sender: yield* SuiTest.addressBalance(SENDER),
          recipient: yield* SuiTest.addressBalance(RECIPIENT)
        }
      }),
      {
        ...baseScript,
        execute: [
          FakeOutcome.failWith({ $kind: "MoveAbort", message: "aborted", MoveAbort: { abortCode: "3" } } as never)
        ]
      }
    )
    expect(error._tag).toBe("ExecutionFailed")
    expect(sender).toBe(ONE_SUI - DEFAULT_NET_GAS)
    expect(recipient).toBe(0n)
  })

  test("coins pay gas: the address balance is not charged", async () => {
    const after = await run(
      Effect.gen(function*() {
        yield* Tx.run(claim, { signer })
        return yield* SuiTest.addressBalance(SENDER)
      }),
      { ...baseScript, balances: [funded(1000n, SENDER)] }
    )
    expect(after).toBe(1000n)
  })

  test("a FundsWithdrawal comes off its source's balance of its type", async () => {
    const usdc = await run(
      Effect.gen(function*() {
        // Redeemed and kept as a value nothing the fake follows consumes.
        yield* Tx.run((tx) => {
          tx.moveCall({
            target: `${PADDED("2")}::escrow::deposit`,
            arguments: [tx.object(ESCROW_ID), tx.balance({ type: USDC, balance: 30n })]
          })
        }, { signer })
        return yield* SuiTest.addressBalance(SENDER, USDC)
      }),
      { ...baseScript, balances: [funded(ONE_SUI, SENDER), funded(100n, SENDER, USDC)] }
    )
    expect(usdc).toBe(70n)
  })

  test("tx.balance through the SDK intent: redeem_funds then send_funds moves it to the recipient", async () => {
    const { sender, recipient, commands } = await run(
      Effect.gen(function*() {
        yield* Tx.run(
          (tx) => sendFunds(tx, tx.balance({ balance: 100n }), RECIPIENT, SUI, "balance"),
          { signer }
        )
        const sent = yield* SuiTest.calls("executeTransaction")
        const bytes = (sent[0]?.options as { readonly transaction: Uint8Array }).transaction
        return {
          sender: yield* SuiTest.addressBalance(SENDER),
          recipient: yield* SuiTest.addressBalance(RECIPIENT),
          commands: dataOf(bytes).commands.map((command) =>
            command.$kind === "MoveCall" ? `${command.MoveCall.module}::${command.MoveCall.function}` : command.$kind
          )
        }
      })
    )
    expect(commands).toEqual(["balance::redeem_funds", "balance::send_funds"])
    expect(recipient).toBe(100n)
    expect(sender).toBe(ONE_SUI - 100n - DEFAULT_NET_GAS)
  })

  test("tx.coin split: the split amount is deposited, the remainder goes back to the sender", async () => {
    const { sender, recipient } = await run(
      Effect.gen(function*() {
        yield* Tx.run((tx) => sendFunds(tx, tx.coin({ balance: 250n }), RECIPIENT), { signer })
        return {
          sender: yield* SuiTest.addressBalance(SENDER),
          recipient: yield* SuiTest.addressBalance(RECIPIENT)
        }
      })
    )
    expect(recipient).toBe(250n)
    expect(sender).toBe(ONE_SUI - 250n - DEFAULT_NET_GAS)
  })

  test("send_funds of an input coin deposits its value and deletes the coin", async () => {
    const { recipient, coins } = await run(
      Effect.gen(function*() {
        yield* Tx.run((tx) => sendFunds(tx, tx.object(coinA.objectId), RECIPIENT), { signer })
        return { recipient: yield* SuiTest.addressBalance(RECIPIENT), coins: yield* coinIds }
      }),
      {
        ...baseScript,
        objects: [
          ...(baseScript.objects ?? []),
          { objectId: coinA.objectId, type: coinA.type, version: 1n, owner, content: new Uint8Array() }
        ]
      }
    )
    expect(recipient).toBe(400n)
    expect(coins).toEqual([coinB.objectId])
  })

  test("send_funds of the gas coin: every payment coin is deleted, the recipient gets coins less gas", async () => {
    const { sender, recipient, coins } = await run(
      Effect.gen(function*() {
        yield* Tx.run((tx) => {
          tx.setGasPayment([coinA, coinB].map((coin) => ({
            objectId: coin.objectId,
            version: coin.version,
            digest: coin.digest
          })))
          sendFunds(tx, tx.gas, RECIPIENT)
        }, { signer })
        return {
          sender: yield* SuiTest.addressBalance(SENDER),
          recipient: yield* SuiTest.addressBalance(RECIPIENT),
          coins: yield* coinIds
        }
      }),
      {
        ...baseScript,
        coins: [
          fakeCoin({ objectId: "0xc01", owner: SENDER, balance: 3_000_000n }),
          fakeCoin({ objectId: "0xc02", owner: SENDER, balance: 7_000_000n })
        ],
        gasBudget: 5_000_000n
      }
    )
    expect(coins).toEqual([])
    expect(recipient).toBe(10_000_000n - DEFAULT_NET_GAS)
    expect(sender).toBe(ONE_SUI)
  })

  test("send_funds of a gas coin holding a reservation moves the reservation, and the gas comes out of the coin", async () => {
    const { sender, recipient, coins } = await run(
      Effect.gen(function*() {
        yield* Tx.run((tx) => sendFunds(tx, tx.gas, RECIPIENT), { signer })
        return {
          sender: yield* SuiTest.addressBalance(SENDER),
          recipient: yield* SuiTest.addressBalance(RECIPIENT),
          coins: yield* coinIds
        }
      })
    )
    expect(coins).toEqual([])
    expect(recipient).toBe(ONE_SUI + 1000n - DEFAULT_NET_GAS)
    expect(sender).toBe(0n)
  })

  test("a replay of a known digest moves nothing", async () => {
    const after = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: SENDER }), signer)
        const request = { transaction: signed.bytes, signatures: [...signed.signatures] }
        yield* Effect.promise(() => fake.client.core.executeTransaction(request))
        yield* Effect.promise(() => fake.client.core.executeTransaction(request))
        return yield* SuiTest.addressBalance(SENDER)
      })
    )
    expect(after).toBe(ONE_SUI - DEFAULT_NET_GAS)
  })
})
