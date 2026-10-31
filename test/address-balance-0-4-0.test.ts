/**
 * Address balance as the default gas payment (0.4.0, DESIGN §6 and §7): the
 * `gasPayment` policy, the explicit-empty-payment check with withdrawals, the
 * expiration rule, the `lockSender: "whenPinned"` lock rule, `Tx.sendFunds`,
 * and folding (`Tx.planFold`, `Tx.fold`, `Tx.foldCoins`), on the fake's
 * address-balance model. `test/live.localnet.test.ts` proves the same claims
 * against a chain.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Coin, CoinType, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui as SuiNs } from "../src/services/Sui.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = `${PADDED("2")}::sui::SUI`
const USDC = CoinType.normalize(`${PADDED("abc")}::usdc::USDC`)
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41)))
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(42)))
const SENDER = signer.address
const RECIPIENT = SuiAddress.make(PADDED("a11ce"))
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const funded = (addressBalance: bigint, who: string = SENDER, coinType: string = SUI) => ({
  owner: who,
  coinType,
  balance: addressBalance.toString(),
  coinBalance: "0",
  addressBalance: addressBalance.toString()
})

const suiCoin = (n: number, balance: bigint, who: string = SENDER) =>
  fakeCoin({ objectId: PADDED(`c${n.toString(16).padStart(3, "0")}`), owner: who, balance })

/** Pure inputs only: no owned object, so with address-balance gas it pins nothing. */
const pinsNothing = (tx: Transaction) => {
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [SUI],
    arguments: [tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] }), tx.pure.address(RECIPIENT)]
  })
}

/** One owned input. */
const claim = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::escrow::claim`, arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)] })
}

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner, content: new Uint8Array() }],
  coins: [suiCoin(1, 5_000_000_000n)],
  balances: [funded(1_000_000_000n)]
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

const dataOf = (bytes: Uint8Array) => TransactionDataBuilder.fromBytes(bytes)

describe("SubmitConfig (0.4.0)", () => {
  test("the defaults are whenPinned and preferAddressBalance", () => {
    expect(SubmitConfig.defaults.lockSender).toBe("whenPinned")
    expect(SubmitConfig.defaults.gasPayment).toBe("preferAddressBalance")
  })

  test("lockSender still takes the boolean it was before 0.4.0", async () => {
    const read = Effect.gen(function*() {
      return (yield* SubmitConfig).lockSender
    })
    expect(await Effect.runPromise(read.pipe(SubmitConfig.with({ lockSender: true })))).toBe("always")
    expect(await Effect.runPromise(read.pipe(SubmitConfig.with({ lockSender: false })))).toBe("never")
    expect(await Effect.runPromise(read.pipe(SubmitConfig.with({ lockSender: "always" })))).toBe("always")
  })
})

describe("gas comes from the address balance by default", () => {
  test("a covered payer pays from its balance; nothing reads the balance again", async () => {
    const { built, balanceReads } = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return { built, balanceReads: (yield* SuiTest.calls("getBalance")).length }
    }))
    expect(dataOf(built.bytes).gasData.payment).toEqual([])
    // The resolver chose it and read the balance to do so.
    expect(balanceReads).toBe(0)
  })

  test("an uncovered payer falls back to coins under the default policy", async () => {
    const built = await run(
      Tx.build(pinsNothing, { sender: SENDER }),
      { ...baseScript, balances: [funded(0n)] }
    )
    expect(dataOf(built.bytes).gasData.payment?.length).toBe(1)
  })

  test("requireAddressBalance pins the payment before the build: no coins listed", async () => {
    const { built, coinReads } = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return { built, coinReads: (yield* SuiTest.calls("listCoins")).length }
    }).pipe(SubmitConfig.with({ gasPayment: "requireAddressBalance" })))
    expect(dataOf(built.bytes).gasData.payment).toEqual([])
    expect(coinReads).toBe(0)
  })

  test("requireAddressBalance refuses an uncovered payer with a BuildError naming Tx.foldCoins", async () => {
    const error = await run(
      Tx.build(pinsNothing, { sender: SENDER }).pipe(
        Effect.flip,
        SubmitConfig.with({ gasPayment: "requireAddressBalance" })
      ),
      { ...baseScript, balances: [funded(0n)] }
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("Tx.foldCoins")
  })

  test("requireAddressBalance refuses coins chosen for a tx.gas user", async () => {
    const error = await run(
      Tx.build((tx) => {
        const [coin] = tx.splitCoins(tx.gas, [1_000n])
        tx.transferObjects([coin!], RECIPIENT)
      }, { sender: SENDER }).pipe(Effect.flip, SubmitConfig.with({ gasPayment: "requireAddressBalance" })),
      { ...baseScript, balances: [funded(0n)] }
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("coin objects")
  })

  test("a payment the recipe set is its own choice under requireAddressBalance", async () => {
    const built = await run(
      Tx.build((tx) => {
        pinsNothing(tx)
        tx.setGasPayment([{ objectId: PADDED("c001"), version: "2", digest: suiCoin(1, 0n).digest }])
      }, { sender: SENDER }).pipe(SubmitConfig.with({ gasPayment: "requireAddressBalance" }))
    )
    expect(dataOf(built.bytes).gasData.payment?.length).toBe(1)
  })
})

describe("the explicit empty payment check", () => {
  test("counts the SUI the bytes withdraw from the payer", async () => {
    const withdrawing = (tx: Transaction) => {
      const [coin] = tx.moveCall({
        target: "0x2::coin::redeem_funds",
        typeArguments: [SUI],
        arguments: [tx.withdrawal({ amount: 990_000_000n })]
      })
      tx.transferObjects([coin!], RECIPIENT)
      tx.setGasPayment([])
    }
    const error = await run(Tx.build(withdrawing, { sender: SENDER }).pipe(Effect.flip))
    // 1 SUI covers the 0.05 SUI budget, but not the budget plus 0.99 SUI.
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("plus the 990000000 MIST the transaction withdraws from it")
  })

  test("needs a ValidDuring expiration when nothing is address-owned", async () => {
    const error = await run(
      Tx.build((tx) => {
        pinsNothing(tx)
        tx.setGasPayment([])
      }, { sender: SENDER }).pipe(Effect.flip, SubmitConfig.with({ expiration: "epoch" }))
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("ValidDuring")
  })

  test("an address-owned input satisfies the rule without one", async () => {
    const built = await run(
      Tx.build((tx) => {
        claim(tx)
        tx.setGasPayment([])
      }, { sender: SENDER }).pipe(SubmitConfig.with({ expiration: "epoch" }))
    )
    expect(built.expiration?.$kind).toBe("Epoch")
  })
})

/**
 * Two runs, the first held inside `preflight` — which runs after the build —
 * and the order in which they finish. Held through submission, the second
 * cannot overtake the first.
 */
const race = (
  first: (tx: Transaction) => void,
  overrides: Parameters<typeof SubmitConfig.with>[0] = {},
  script: FakeScript = baseScript
) =>
  run(
    Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const inside = yield* Deferred.make<void>()
      const order: Array<string> = []
      let held = false
      const start = (name: string, recipe: (tx: Transaction) => void) =>
        Effect.forkChild(
          Tx.run(recipe, { signer }).pipe(
            Effect.tap(() => Effect.sync(() => order.push(name))),
            SubmitConfig.with({
              ...overrides,
              preflight: () =>
                Effect.gen(function*() {
                  if (held) return
                  held = true
                  yield* Deferred.succeed(inside, undefined)
                  yield* Deferred.await(gate)
                })
            })
          )
        )
      const one = yield* start("first", first)
      yield* Deferred.await(inside)
      const two = yield* start("second", pinsNothing)
      yield* TestClock.adjust("1 second")
      const overtaken = [...order]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(one)
      yield* Fiber.join(two)
      return overtaken
    }),
    { ...script, simulate: [FakeOutcome.succeed()], execute: [FakeOutcome.succeed()] }
  )

describe("lockSender: whenPinned", () => {
  test("bytes that pin nothing are submitted with the lock released", async () => {
    expect(await race(pinsNothing)).toEqual(["second"])
  })

  test("bytes that pin an owned input hold the lock through submission", async () => {
    expect(await race(claim)).toEqual([])
  })

  test("bytes that pin a gas coin hold it too", async () => {
    // No balance: the resolver pays with the coin, so the first run pins it.
    expect(await race(pinsNothing, {}, { ...baseScript, balances: [funded(0n)] })).toEqual([])
  })

  test("always holds it through submission whatever the bytes pin", async () => {
    expect(await race(pinsNothing, { lockSender: "always" })).toEqual([])
  })

  const buildOrder = (lockSender: "whenPinned" | "never") =>
    run(
      Effect.gen(function*() {
        yield* Effect.all([Tx.run(pinsNothing, { signer }), Tx.run(pinsNothing, { signer })], {
          concurrency: "unbounded"
        }).pipe(SubmitConfig.with({ lockSender }))
        // Each build is one system-state read (the expiration) and then the
        // resolver's simulate; under the lock they cannot interleave.
        return (yield* SuiTest.calls())
          .filter((call) =>
            call.method === "getCurrentSystemState" ||
            (call.method === "simulateTransaction" && (call.options as { resolver?: boolean }).resolver === true)
          )
          .map((call) => call.method)
      }),
      { ...baseScript, execute: [FakeOutcome.succeed()] }
    )

  test("builds stay serialized", async () => {
    expect(await buildOrder("whenPinned")).toEqual([
      "getCurrentSystemState",
      "simulateTransaction",
      "getCurrentSystemState",
      "simulateTransaction"
    ])
    // The observation can tell: with no lock the two builds interleave.
    expect(await buildOrder("never")).toEqual([
      "getCurrentSystemState",
      "getCurrentSystemState",
      "simulateTransaction",
      "simulateTransaction"
    ])
  })
})

describe("Tx.sendFunds", () => {
  test("deposits into the recipient's balance from the sender's, pinning nothing", async () => {
    const built = await run(Tx.build(Tx.sendFunds({ amount: 1_000n, recipient: RECIPIENT }), { sender: SENDER }))
    const data = dataOf(built.bytes)
    expect(data.gasData.payment).toEqual([])
    expect(data.inputs.some((input) => input.FundsWithdrawal !== undefined)).toBe(true)
    expect(data.inputs.some((input) => input.Object !== undefined)).toBe(false)
    const targets = data.commands.map((command) => command.MoveCall?.function)
    expect(targets).toContain("send_funds")
  })

  test("lands the amount in the recipient's address balance on the fake", async () => {
    const received = await run(Effect.gen(function*() {
      yield* Tx.run(Tx.sendFunds({ amount: 1_000n, recipient: RECIPIENT }), { signer })
      return yield* SuiTest.addressBalance(RECIPIENT)
    }), { ...baseScript, execute: [FakeOutcome.succeed()] })
    expect(received).toBe(1_000n)
  })
})

describe("Tx.planFold", () => {
  test("SUI pays for its own fold, largest coins first", async () => {
    const plan = await run(
      Tx.planFold({ owner: SENDER }),
      {
        ...baseScript,
        coins: [suiCoin(1, 3_000_000_000n), suiCoin(2, 9_000_000_000n), suiCoin(3, 1_000_000_000n)],
        balances: [{ ...funded(0n), coinBalance: "13000000000", balance: "13000000000" }]
      }
    )
    expect(plan.skipped).toEqual([])
    expect(plan.batches.length).toBe(1)
    expect(plan.batches[0]!.gas).toBe("foldedCoins")
    expect(plan.batches[0]!.amount).toBe(13_000_000_000n)
    expect(plan.batches[0]!.coins.map((coin): bigint => coin.balance)).toEqual([
      9_000_000_000n,
      3_000_000_000n,
      1_000_000_000n
    ])
  })

  test("maxCoinsPerTransaction splits the coins into batches and is clamped to 1..500", async () => {
    const coins = Array.from({ length: 5 }, (_, index) => suiCoin(index + 1, 1_000_000_000n))
    const script = { ...baseScript, coins, balances: [funded(0n)] }
    const two = await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI, maxCoinsPerTransaction: 2 }), script)
    expect(two.batches.map((batch) => batch.coins.length)).toEqual([2, 2, 1])
    const clamped = await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI, maxCoinsPerTransaction: 0 }), script)
    expect(clamped.batches.length).toBe(5)
  })

  test("SUI dust is paid from the balance when it can be, and skipped when it cannot", async () => {
    const dust = [suiCoin(1, 1_000n), suiCoin(2, 2_000n)]
    const covered = await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI }), {
      ...baseScript,
      coins: dust
    })
    expect(covered.batches.map((batch) => batch.gas)).toEqual(["addressBalance"])
    const stranded = await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI }), {
      ...baseScript,
      coins: dust,
      balances: [funded(0n)]
    })
    expect(stranded.batches).toEqual([])
    expect(stranded.skipped.length).toBe(2)
  })

  test("every coin type the owner holds coins of, SUI first", async () => {
    const usdcCoin = fakeCoin({ objectId: PADDED("d01"), owner: SENDER, balance: 5_000n, coinType: USDC })
    const plan = await run(Tx.planFold({ owner: SENDER }), {
      ...baseScript,
      coins: [usdcCoin, suiCoin(1, 5_000_000_000n)],
      // Unscripted: no balance, and the coin balances are the coins'.
      balances: []
    })
    expect(plan.batches.map((batch) => [batch.coinType, batch.gas])).toEqual([
      [CoinType.SUI, "foldedCoins"],
      [USDC, "auto"]
    ])
  })
})

describe("Tx.fold", () => {
  const batchOf = (coins: ReadonlyArray<Coin>, gas: "foldedCoins" | "addressBalance" | "auto", coinType = CoinType.SUI) => ({
    owner: SENDER,
    coinType,
    coins,
    amount: coins.reduce((sum, coin) => sum + coin.balance, 0n),
    gas
  })
  const coinsOf = (count: number) =>
    Array.from({ length: count }, (_, index) =>
      Coin.make({
        objectId: PADDED(`c${(index + 1).toString(16).padStart(3, "0")}`) as Coin["objectId"],
        version: 2n as Coin["version"],
        digest: suiCoin(1, 0n).digest,
        owner: { $kind: "AddressOwner", AddressOwner: SENDER },
        type: `${PADDED("2")}::coin::Coin<${SUI}>` as Coin["type"],
        balance: 1_000_000_000n as Coin["balance"]
      }))

  test("foldedCoins: the coins are the payment and the gas coin is deposited", async () => {
    const coins = coinsOf(300)
    const built = await run(
      Tx.build(Tx.fold(batchOf(coins, "foldedCoins")), { sender: SENDER }),
      { ...baseScript, coins: [] }
    )
    const data = dataOf(built.bytes)
    expect(data.gasData.payment?.length).toBe(256)
    const [merge, send] = data.commands
    expect(merge?.MergeCoins?.destination.$kind).toBe("GasCoin")
    expect(merge?.MergeCoins?.sources.length).toBe(44)
    expect(send?.MoveCall?.function).toBe("send_funds")
    expect(send?.MoveCall?.module).toBe("coin")
    expect(send?.MoveCall?.arguments[0]?.$kind).toBe("GasCoin")
  })

  test("addressBalance: the coins are inputs and gas comes from the balance", async () => {
    const built = await run(Tx.build(Tx.fold(batchOf(coinsOf(3), "addressBalance")), { sender: SENDER }), {
      ...baseScript,
      coins: []
    })
    const data = dataOf(built.bytes)
    expect(data.gasData.payment).toEqual([])
    expect(data.inputs.filter((input) => input.Object?.ImmOrOwnedObject !== undefined).length).toBe(3)
  })

  test("refuses an empty batch, and foldedCoins for a coin that is not SUI", async () => {
    const empty = await run(Tx.build(Tx.fold(batchOf([], "auto")), { sender: SENDER }).pipe(Effect.flip))
    expect(empty._tag).toBe("BuildError")
    const notSui = await run(
      Tx.build(Tx.fold(batchOf(coinsOf(1), "foldedCoins", USDC)), { sender: SENDER }).pipe(Effect.flip)
    )
    expect(notSui._tag).toBe("BuildError")
  })
})

describe("Tx.foldCoins", () => {
  test("a coin-only account folds to zero coins, and its next run pins nothing", async () => {
    const outcome = await run(
      Effect.gen(function*() {
        const result = yield* Tx.foldCoins({ signer })
        const coins = (yield* Stream.runCollect((yield* SuiNs).streamCoins(SENDER))).length
        const balance = yield* SuiTest.addressBalance(SENDER)
        let payment: number | undefined
        yield* Tx.run(pinsNothing, {
          signer,
          onSigned: (signed) =>
            Effect.sync(() => {
              payment = dataOf(signed.bytes).gasData.payment?.length
            })
        })
        return { result, coins, balance, payment }
      }),
      {
        ...baseScript,
        objects: [],
        coins: [suiCoin(1, 2_000_000_000n), suiCoin(2, 3_000_000_000n)],
        balances: [],
        execute: [FakeOutcome.succeed()]
      }
    )
    expect(outcome.result.executed.length).toBe(1)
    expect(outcome.result.plan.batches[0]!.gas).toBe("foldedCoins")
    // Every payment coin was deposited with the gas coin.
    expect(outcome.coins).toBe(0)
    // 5 SUI of coins in, less the fake's net gas charge.
    expect(outcome.balance).toBeGreaterThan(4_900_000_000n)
    expect(outcome.balance).toBeLessThanOrEqual(5_000_000_000n)
    expect(outcome.payment).toBe(0)
  })

  test("an owner with no coins answers an empty plan and runs nothing", async () => {
    const result = await run(Tx.foldCoins({ signer }), { ...baseScript, coins: [] })
    expect(result.plan.batches).toEqual([])
    expect(result.executed).toEqual([])
  })

  test("sponsor's own coins fold the same way", async () => {
    const result = await run(Tx.foldCoins({ signer: sponsor }), {
      ...baseScript,
      coins: [suiCoin(9, 2_000_000_000n, sponsor.address)],
      balances: [],
      execute: [FakeOutcome.succeed()]
    })
    expect(result.executed.length).toBe(1)
  })
})

describe("reconcile of bytes that pin nothing", () => {
  test("is SubmissionUnknown while the window is open, and a re-send lands it", async () => {
    const { unknown, executed } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(pinsNothing, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        const unknown = yield* Effect.flip(Tx.reconcile(signed))
        const executed = yield* Tx.resubmit(signed)
        return { unknown, executed }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()], execute: [FakeOutcome.succeed()] }
    )
    expect(unknown._tag).toBe("SubmissionUnknown")
    expect(executed.effects.status.success).toBe(true)
  })
})
