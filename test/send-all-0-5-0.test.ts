/**
 * `Tx.sendAll` (0.5.0, DESIGN §6): sweeping one coin type — coins and the
 * address balance — into a recipient's address balance through `Tx.run`, on
 * the fake's address-balance model. `test/live.localnet.test.ts` proves on a
 * chain that the sender is left with 0 of it.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CoinType, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = CoinType.SUI
const USDC = CoinType.normalize(`${PADDED("abc")}::usdc::USDC`)

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(51)))
const SENDER = signer.address
const RECIPIENT = SuiAddress.make(PADDED("a11ce"))

const balance = (coinType: string, coinBalance: bigint, addressBalance: bigint) => ({
  owner: SENDER,
  coinType,
  balance: (coinBalance + addressBalance).toString(),
  coinBalance: coinBalance.toString(),
  addressBalance: addressBalance.toString()
})

const coin = (n: number, amount: bigint, coinType: string = SUI) =>
  fakeCoin({ objectId: PADDED(`c${n.toString(16).padStart(3, "0")}`), owner: SENDER, balance: amount, coinType })

const script = (overrides: Partial<FakeScript>): FakeScript => ({
  chainId: CHAIN_ID,
  objects: [],
  coins: [],
  balances: [],
  execute: [FakeOutcome.succeed()],
  ...overrides
})

const run = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>, fake: FakeScript) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(fake), TestClock.layer(), Journal.layerMemory), { local: true })
  )

/** What the sender holds of a coin type afterwards: coins and balance. */
const left = (coinType: string) =>
  Effect.gen(function*() {
    const coins = [...(yield* Stream.runCollect((yield* Sui).streamCoins(SENDER, coinType)))]
    return { coins: coins.length, addressBalance: yield* SuiTest.addressBalance(SENDER, coinType) }
  })

const sent = Effect.map(SuiTest.calls("executeTransaction"), (calls) => {
  const bytes = (calls.at(-1)?.options as { readonly transaction: Uint8Array }).transaction
  return TransactionDataBuilder.fromBytes(bytes)
})

const moveCalls = (data: TransactionDataBuilder) =>
  data.commands.flatMap((command) =>
    command.$kind === "MoveCall" ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : []
  )

describe("Tx.sendAll", () => {
  test("SUI in coins only: the coins are the gas payment and the gas coin is deposited", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.sendAll({ signer, recipient: RECIPIENT })
        return { result, data: yield* sent, left: yield* left(SUI), got: yield* SuiTest.addressBalance(RECIPIENT) }
      }),
      script({ coins: [coin(1, 2_000_000_000n), coin(2, 3_000_000_000n)], balances: [balance(SUI, 5_000_000_000n, 0n)] })
    )
    expect(outcome.result.sweep.gas).toBe("coins")
    expect(outcome.result.sweep.amount).toBe(5_000_000_000n)
    expect(outcome.result.sweep.coins.map((c) => c.balance)).toEqual([3_000_000_000n, 2_000_000_000n])
    expect(outcome.data.gasData.payment?.length).toBe(2)
    expect(moveCalls(outcome.data)).toEqual(["coin::send_funds"])
    expect(outcome.left).toEqual({ coins: 0, addressBalance: 0n })
    // 5 SUI less the fake's net gas.
    expect(outcome.got).toBeGreaterThan(4_990_000_000n)
    expect(outcome.got).toBeLessThan(5_000_000_000n)
  })

  test("SUI in the address balance only: a reservation of all of it is the gas coin", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.sendAll({ signer, recipient: RECIPIENT })
        return { result, data: yield* sent, left: yield* left(SUI), got: yield* SuiTest.addressBalance(RECIPIENT) }
      }),
      script({ balances: [balance(SUI, 0n, 4_000_000_000n)] })
    )
    expect(outcome.result.sweep.gas).toBe("coinReservation")
    const payment = outcome.data.gasData.payment ?? []
    expect(payment.length).toBe(1)
    expect(String(payment[0]!.version)).toBe("0")
    expect(outcome.data.inputs.filter((input) => input.$kind === "Object")).toHaveLength(0)
    expect(outcome.left).toEqual({ coins: 0, addressBalance: 0n })
    expect(outcome.got).toBeGreaterThan(3_990_000_000n)
  })

  test("SUI with more in the balance than in coins: the coins are merged into the reservation", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.sendAll({ signer, recipient: RECIPIENT })
        return { result, data: yield* sent, left: yield* left(SUI) }
      }),
      script({ coins: [coin(1, 1_000_000_000n)], balances: [balance(SUI, 1_000_000_000n, 3_000_000_000n)] })
    )
    expect(outcome.result.sweep.gas).toBe("coinReservation")
    expect(outcome.result.sweep.amount).toBe(4_000_000_000n)
    expect(outcome.data.commands.map((command) => command.$kind)).toEqual(["MergeCoins", "MoveCall"])
    expect(outcome.left).toEqual({ coins: 0, addressBalance: 0n })
  })

  test("SUI with more in coins than in the balance: the balance is redeemed into the coin payment", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.sendAll({ signer, recipient: RECIPIENT })
        return { result, data: yield* sent, left: yield* left(SUI) }
      }),
      script({ coins: [coin(1, 5_000_000_000n)], balances: [balance(SUI, 5_000_000_000n, 1_000_000_000n)] })
    )
    expect(outcome.result.sweep.gas).toBe("coins")
    expect(moveCalls(outcome.data)).toEqual(["coin::redeem_funds", "coin::send_funds"])
    const withdrawal = outcome.data.inputs.find((input) => input.$kind === "FundsWithdrawal")
    expect(withdrawal?.FundsWithdrawal?.reservation).toEqual({ $kind: "MaxAmountU64", MaxAmountU64: "1000000000" })
    expect(outcome.left).toEqual({ coins: 0, addressBalance: 0n })
  })

  test("another coin type: every coin and the whole balance, gas from SUI", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.sendAll({ signer, recipient: RECIPIENT, coinType: USDC })
        return {
          result,
          data: yield* sent,
          left: yield* left(USDC),
          got: yield* SuiTest.addressBalance(RECIPIENT, USDC),
          sui: yield* SuiTest.addressBalance(SENDER)
        }
      }),
      script({
        coins: [coin(1, 700n, USDC), coin(2, 300n, USDC)],
        balances: [balance(USDC, 1_000n, 250n), balance(SUI, 0n, 2_000_000_000n)]
      })
    )
    expect(outcome.result.sweep.gas).toBe("auto")
    expect(outcome.result.sweep.amount).toBe(1_250n)
    expect(moveCalls(outcome.data)).toEqual(["coin::send_funds", "balance::redeem_funds", "balance::send_funds"])
    // Gas from the SUI balance: nothing of the swept type pays it.
    expect(outcome.data.gasData.payment).toEqual([])
    expect(outcome.left).toEqual({ coins: 0, addressBalance: 0n })
    expect(outcome.got).toBe(1_250n)
    expect(outcome.sui).toBeLessThan(2_000_000_000n)
  })

  test("received is what the effects credit the recipient", async () => {
    const result = await run(
      Tx.sendAll({ signer, recipient: RECIPIENT, coinType: USDC }),
      script({
        balances: [balance(USDC, 0n, 900n), balance(SUI, 0n, 2_000_000_000n)],
        execute: [FakeOutcome.succeed({ balanceChanges: [{ coinType: USDC, address: RECIPIENT, amount: "900" }] })]
      })
    )
    expect(result.received).toBe(900n)
    expect(result.executed.sender).toBe(SENDER)
  })

  test("approve is shown the sweep, and a refusal sends nothing", async () => {
    class Refused extends Schema.TaggedError<Refused>()("Refused", {}) {}
    const outcome = await run(
      Effect.gen(function*() {
        const seen: Array<bigint> = []
        const refused = yield* Effect.flip(Tx.sendAll({
          signer,
          recipient: RECIPIENT,
          approve: (prepared, sweep) =>
            Effect.andThen(
              Effect.sync(() => seen.push(sweep.amount, BigInt(prepared.built.gas.budget))),
              Effect.fail(new Refused())
            )
        }))
        return { refused, seen, executes: (yield* SuiTest.calls("executeTransaction")).length }
      }),
      script({ balances: [balance(SUI, 0n, 4_000_000_000n)], simulate: [FakeOutcome.succeed()] })
    )
    expect(outcome.refused._tag).toBe("Refused")
    expect(outcome.seen[0]).toBe(4_000_000_000n)
    expect(outcome.executes).toBe(0)
  })

  test("nothing to send, sending to oneself and too many coins are BuildErrors before anything is built", async () => {
    const empty = await run(Effect.flip(Tx.sendAll({ signer, recipient: RECIPIENT })), script({}))
    expect(empty._tag).toBe("BuildError")
    expect(empty.message).toContain("holds no")
    const self = await run(Effect.flip(Tx.sendAll({ signer, recipient: SENDER })), script({}))
    expect(self._tag).toBe("BuildError")
    const many = Array.from({ length: 501 }, (_, index) => coin(index + 1, 1_000n, USDC))
    const tooMany = await run(
      Effect.flip(Tx.sendAll({ signer, recipient: RECIPIENT, coinType: USDC })),
      script({ coins: many, balances: [balance(USDC, 501_000n, 0n)] })
    )
    expect(tooMany._tag).toBe("BuildError")
    expect(tooMany.message).toContain("Tx.foldCoins")
  })
})
