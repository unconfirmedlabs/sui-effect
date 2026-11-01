/**
 * Address-balance gas and coin folding, proved against a **localnet**.
 *
 * The fake models address balances (DESIGN §14) but runs no Move and enforces
 * no validator rule, so the claims this file checks are unfalsifiable without
 * a chain: that `0x2::coin::send_funds<SUI>(GasCoin, owner)` folds a coin-only
 * account in one transaction, that every later transaction then pays from the
 * balance and pins nothing, that such transactions from one sender run
 * concurrently without the sender lock, and that the expiration rule is what
 * DESIGN §6 says it is.
 *
 * Gated behind `SUI_LOCALNET=1`, so `bun run check` never opens a socket:
 *
 * ```bash
 * sui start --with-faucet --force-regenesis &
 * SUI_LOCALNET=1 bun test test/live.localnet.test.ts
 * ```
 *
 * `SUI_LOCALNET_URL` (default `http://127.0.0.1:9000`) and
 * `SUI_LOCALNET_FAUCET` (default `http://127.0.0.1:9123`) override the
 * endpoints. The localnet faucet is V2: it pays **coin objects**, five of them,
 * which is exactly the account a fold exists for.
 */
import { describe, expect, test } from "bun:test"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Layer, Schedule, Stream } from "effect"
import type { Prepared } from "../src/services/Tx.ts"
import { CoinType } from "../src/domain/schemas.ts"
import type { SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import type { Signer } from "../src/services/Signer.ts"
import { ephemeral } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"

const LOCALNET = process.env["SUI_LOCALNET"] === "1"
const BASE_URL = process.env["SUI_LOCALNET_URL"] ?? "http://127.0.0.1:9000"
const FAUCET = process.env["SUI_LOCALNET_FAUCET"] ?? "http://127.0.0.1:9123"
const MINUTE = 60_000

const layer = Layer.mergeAll(
  Sui.layerNoDeps.pipe(
    Layer.provideMerge(SuiCore.layerGrpc({ network: "localnet", baseUrl: BASE_URL }))
  ),
  Journal.layerMemory
)

const local = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer, { local: true }))

/**
 * `local` over a `SuiCore` that counts its `simulateTransaction` calls: the
 * explicit simulates, which is what a run costs beyond the gRPC resolver's own
 * (that one goes straight to the node from the SDK's build plugin).
 */
const counted = async <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<{ value: A; simulates: number }> => {
  let simulates = 0
  const core = Layer.effect(
    SuiCore,
    Effect.gen(function*() {
      const inner = yield* SuiCore
      return {
        ...inner,
        simulateTransaction: ((options: Parameters<typeof inner.simulateTransaction>[0]) => {
          simulates += 1
          return inner.simulateTransaction(options)
        }) as typeof inner.simulateTransaction
      }
    })
  ).pipe(Layer.provide(SuiCore.layerGrpc({ network: "localnet", baseUrl: BASE_URL })))
  const value = await Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(Sui.layerNoDeps.pipe(Layer.provideMerge(core)), Journal.layerMemory), {
      local: true
    })
  )
  return { value, simulates }
}

/** A fresh key with the faucet's coins on it, once they are readable. */
const funded = async (): Promise<Signer> => {
  const signer = await Effect.runPromise(ephemeral)
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: signer.address })
  await local(
    Effect.gen(function*() {
      const sui = yield* Sui
      yield* Effect.retry(
        Effect.flatMap(sui.getBalance(signer.address), (value) =>
          value.coinBalance > 0n ? Effect.void : Effect.fail("not visible yet" as const)),
        { schedule: Schedule.spaced("250 millis"), times: 40 }
      )
    })
  )
  return signer
}

/** How many coin objects of a type the owner holds. */
const coinCount = (owner: SuiAddress, coinType?: CoinType) =>
  local(Effect.gen(function*() {
    const sui = yield* Sui
    return (yield* Stream.runCollect(sui.streamCoins(owner, coinType))).length
  }))

/** The coin and address balances, as plain bigints. */
const balanceOf = (owner: SuiAddress, coinType?: CoinType) =>
  local(Effect.gen(function*() {
    const balance = yield* (yield* Sui).getBalance(owner, coinType)
    return { coinBalance: balance.coinBalance as bigint, addressBalance: balance.addressBalance as bigint }
  }))

/** The gas payment and the pinned owned inputs of signed bytes. */
const shapeOf = (bytes: Uint8Array) => {
  const data = TransactionDataBuilder.fromBytes(bytes)
  return {
    payment: data.gasData.payment?.length ?? -1,
    owned: data.inputs.filter((input) => input.Object?.ImmOrOwnedObject !== undefined).length
  }
}

/** Runs a recipe and reports the shape of the bytes it signed. */
const runShaped = (recipe: (tx: Transaction) => void, signer: Signer) => {
  let shape: ReturnType<typeof shapeOf> | undefined
  return Effect.map(
    Tx.run(recipe, {
      signer,
      onSigned: (signed) => Effect.sync(() => {
        shape = shapeOf(signed.bytes)
      })
    }),
    (executed) => ({ executed, shape: shape! })
  )
}

/**
 * The FCOIN test currency: `coin::create_currency` in `init`, decimals 6,
 * built with `sui move build --dump-bytecode-as-base64` (sui 1.82.1).
 */
const FCOIN_MODULE = "oRzrCwcAAAUKAQAMAgweAyoiBEwIBVRUB6gBsAEI2AJgBrgDEgrKAwUMzwMpAAkBDAIGAhACEQISAAECAAECBwEAAAIADAEAAQIDDAEAAQQEAgAFBQcAAAoAAQABCwEEAQACBwYHAQIDDQkBAQwDDg0BAQwEDwoLAAEDAgUDCAQMAggABwgEAAILAwEIAAsCAQgAAQgFAQsBAQkAAQgABwkAAgoCCgIKAgsBAQgFBwgEAgsDAQkACwIBCQABCwIBCAABCQABBggEAQUBCwMBCAACCQAFDENvaW5NZXRhZGF0YQVGQ09JTgZPcHRpb24LVHJlYXN1cnlDYXAJVHhDb250ZXh0A1VybARjb2luD2NyZWF0ZV9jdXJyZW5jeQtkdW1teV9maWVsZAVmY29pbgRpbml0BG5vbmUGb3B0aW9uFHB1YmxpY19mcmVlemVfb2JqZWN0D3B1YmxpY190cmFuc2ZlcgZzZW5kZXIIdHJhbnNmZXIKdHhfY29udGV4dAN1cmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIKAgYFRkNPSU4KAgIBRgoCAQAAAgEIAQAAAAACEgsAMQYHAAcBBwI4AAoBOAEMAwwCCwM4AgsCCwEuEQU4AwIAAA=="

describe.skipIf(!LOCALNET)("localnet, with SUI_LOCALNET=1", () => {
  test(
    "a faucet-funded key folds its SUI in one transaction, then pays gas from its address balance",
    async () => {
      const signer = await funded()
      const before = await balanceOf(signer.address)
      expect(before.addressBalance).toBe(0n)
      const coinsBefore = await coinCount(signer.address)
      expect(coinsBefore).toBeGreaterThan(0)

      // The plan and its preview: one batch, paid for by the coins it folds.
      const plan = await local(Tx.planFold({ owner: signer.address }))
      expect(plan.batches.length).toBe(1)
      expect(plan.batches[0]!.gas).toBe("foldedCoins")
      expect(plan.batches[0]!.coins.length).toBe(coinsBefore)
      const preview = await local(Effect.gen(function*() {
        const built = yield* Tx.build(Tx.fold(plan.batches[0]!), { sender: signer.address })
        return yield* (yield* Sui).simulate(built.bytes)
      }))
      expect(preview.effects.status.success).toBe(true)

      const folded = await local(Tx.foldCoins({ signer }))
      expect(folded.executed.length).toBe(1)
      expect(await coinCount(signer.address)).toBe(0)
      const after = await balanceOf(signer.address)
      expect(after.coinBalance).toBe(0n)
      // The storage rebates of the deleted coins make the fold pay for itself.
      expect(after.addressBalance).toBeGreaterThan(before.coinBalance - 10_000_000n)
      console.error(
        `fold: ${coinsBefore} coins (${before.coinBalance} MIST) -> 0 coins, ${after.addressBalance} MIST in the address balance`
      )

      // Afterwards a transfer pays from the balance and pins nothing.
      const recipient = (await Effect.runPromise(ephemeral)).address
      const sent = await local(runShaped(Tx.sendFunds({ amount: 1_000_000n, recipient }), signer))
      expect(sent.executed.effects.status.success).toBe(true)
      expect(sent.shape).toEqual({ payment: 0, owned: 0 })
      expect((await balanceOf(recipient)).addressBalance).toBe(1_000_000n)
      expect(await coinCount(signer.address)).toBe(0)
    },
    5 * MINUTE
  )

  test(
    "address-balance transactions from one sender run concurrently without the sender lock",
    async () => {
      const signer = await funded()
      await local(Tx.foldCoins({ signer }))
      const recipient = (await Effect.runPromise(ephemeral)).address
      const send = (amount: bigint) => Tx.run(Tx.sendFunds({ amount, recipient }), { signer })
      const timed = async (overrides: Parameters<typeof SubmitConfig.with>[0]) => {
        const started = Date.now()
        const executed = await local(
          Effect.all(Array.from({ length: 10 }, (_, index) => send(1_000n + BigInt(index))), {
            concurrency: "unbounded"
          }).pipe(SubmitConfig.with(overrides))
        )
        return { executed, ms: Date.now() - started }
      }
      const concurrent = await timed({})
      const serialized = await timed({ lockSender: "always" })
      for (const executed of [...concurrent.executed, ...serialized.executed]) {
        expect(executed.effects.status.success).toBe(true)
      }
      console.error(`ten sends from one sender: ${concurrent.ms} ms whenPinned, ${serialized.ms} ms always`)
      expect(concurrent.ms).toBeLessThan(serialized.ms)
      const total = [...Array(10).keys()].reduce((sum, index) => sum + 1_000n + BigInt(index), 0n) * 2n
      expect((await balanceOf(recipient)).addressBalance).toBe(total)
    },
    5 * MINUTE
  )

  test(
    "a sponsor's address balance pays for a sender that holds nothing",
    async () => {
      const sponsor = await funded()
      await local(Tx.foldCoins({ signer: sponsor }))
      const sender = await Effect.runPromise(ephemeral)
      const executed = await local(
        Tx.run(
          Tx.sponsored({ sender: sender.address, gasOwner: sponsor.address })((tx) => {
            tx.moveCall({
              target: "0x2::balance::send_funds",
              typeArguments: ["0x2::sui::SUI"],
              arguments: [
                tx.moveCall({ target: "0x2::balance::zero", typeArguments: ["0x2::sui::SUI"] }),
                tx.pure.address(sender.address)
              ]
            })
          }),
          { signer: sender, sponsor }
        )
      )
      expect(executed.effects.status.success).toBe(true)
      expect(executed.balanceChange(sponsor.address, "0x2::sui::SUI")).toBeLessThan(0n)
    },
    5 * MINUTE
  )

  test(
    "a coin-only account falls back to coins by default and is refused under requireAddressBalance",
    async () => {
      const signer = await funded()
      const recipient = (await Effect.runPromise(ephemeral)).address
      const fallback = await local(runShaped(Tx.sendFunds({ amount: 1_000n, recipient }), signer))
      expect(fallback.executed.effects.status.success).toBe(true)
      expect(fallback.shape.payment).toBeGreaterThan(0)

      const refused = await local(
        Effect.flip(Tx.build(Tx.sendFunds({ amount: 1_000n, recipient }), { sender: signer.address })).pipe(
          SubmitConfig.with({ gasPayment: "requireAddressBalance" })
        )
      )
      expect(refused._tag).toBe("BuildError")
      expect(refused.message).toContain("Tx.foldCoins")
    },
    5 * MINUTE
  )

  test(
    "an address-balance transaction needs a ValidDuring expiration and cannot use tx.gas",
    async () => {
      const signer = await funded()
      await local(Tx.foldCoins({ signer }))
      const failure = await local(
        Effect.flip(
          Tx.build((tx) => {
            tx.moveCall({
              target: "0x2::balance::send_funds",
              typeArguments: ["0x2::sui::SUI"],
              arguments: [
                tx.moveCall({ target: "0x2::balance::zero", typeArguments: ["0x2::sui::SUI"] }),
                tx.pure.address(signer.address)
              ]
            })
          }, { sender: signer.address })
        ).pipe(SubmitConfig.with({ expiration: "epoch" }))
      )
      expect(failure._tag).toBe("BuildError")
      expect(failure.message).toContain("ValidDuring")

      // And the gas coin of an empty payment is empty: a node simulates a split
      // of it successfully and fails it on chain, so the build refuses it.
      const gasCoin = await local(
        Effect.flip(
          Tx.build((tx) => {
            const [coin] = tx.splitCoins(tx.gas, [1_000n])
            tx.transferObjects([coin!], signer.address)
            tx.setGasPayment([])
          }, { sender: signer.address })
        )
      )
      expect(gasCoin._tag).toBe("BuildError")
      expect(gasCoin.message).toContain("uses tx.gas")
    },
    5 * MINUTE
  )

  test(
    "bytes that pin nothing reconcile as unknown and land on an identical re-send",
    async () => {
      const signer = await funded()
      await local(Tx.foldCoins({ signer }))
      const recipient = (await Effect.runPromise(ephemeral)).address
      const settled = await local(Effect.gen(function*() {
        const built = yield* Tx.build(Tx.sendFunds({ amount: 7_000n, recipient }), { sender: signer.address })
        const signed = yield* Tx.sign(built, signer)
        expect(shapeOf(signed.bytes)).toEqual({ payment: 0, owned: 0 })
        // Never sent: nothing pinned, the window open, so nothing is proven.
        const unknown = yield* Effect.flip(Tx.reconcile(signed))
        expect(unknown._tag).toBe("SubmissionUnknown")
        return yield* Tx.resubmit(signed)
      }))
      expect(settled.effects.status.success).toBe(true)
      expect((await balanceOf(recipient)).addressBalance).toBe(7_000n)
    },
    5 * MINUTE
  )

  test(
    "three hundred SUI coins and a second coin type fold, SUI first",
    async () => {
      const signer = await funded()
      // A currency of our own first: every coin-paid transaction smashes all of
      // the payer's SUI coins into its gas coin, so the 300 coins come last.
      const published = await local(Tx.run((tx) => {
        const [cap] = tx.publish({ modules: [FCOIN_MODULE], dependencies: ["0x1", "0x2"] })
        tx.transferObjects([cap!], signer.address)
      }, { signer }))
      const packageId = published.effects.changedObjects.find((change) => change.outputState === "PackageWrite")!
        .objectId
      const fcoin = CoinType.normalize(`${packageId}::fcoin::FCOIN`)
      const capId = published.effects.changedObjects.find((change) =>
        change.idOperation === "Created" && change.outputState !== "PackageWrite" &&
        (published.objectTypes?.[change.objectId] ?? "").includes("TreasuryCap")
      )?.objectId
      expect(capId).toBeDefined()
      await local(Tx.run((tx) => {
        for (let index = 0; index < 7; index++) {
          const minted = tx.moveCall({
            target: "0x2::coin::mint",
            typeArguments: [fcoin],
            arguments: [tx.object(capId!), tx.pure.u64(1_000 + index)]
          })
          tx.transferObjects([minted], signer.address)
        }
      }, { signer }))
      await local(Tx.run((tx) => {
        const coins = tx.splitCoins(tx.gas, Array.from({ length: 300 }, () => 1_000_000_000n))
        tx.transferObjects(Array.from({ length: 300 }, (_, index) => coins[index]!), signer.address)
      }, { signer }))
      const suiCoins = await coinCount(signer.address)
      expect(suiCoins).toBeGreaterThan(300)
      expect(await coinCount(signer.address, fcoin)).toBe(7)

      const result = await local(Tx.foldCoins({ signer }))
      expect(result.plan.batches.map((batch) => [batch.coinType === CoinType.SUI, batch.gas])).toEqual([
        [true, "foldedCoins"],
        [false, "auto"]
      ])
      expect(result.executed.length).toBe(2)
      expect(await coinCount(signer.address)).toBe(0)
      expect(await coinCount(signer.address, fcoin)).toBe(0)
      expect((await balanceOf(signer.address, fcoin)).addressBalance).toBe(7_021n)
      console.error(`fold: ${suiCoins} SUI coins and 7 FCOIN coins -> 0 coins in ${result.executed.length} transactions`)
    },
    5 * MINUTE
  )

  test(
    "streamTransactions({ affectedAddress }) lists an incoming transfer a sender filter cannot see",
    async () => {
      const payer = await funded()
      const receiver = await Effect.runPromise(ephemeral)
      const executed = await local(Tx.run((tx) => {
        tx.transferObjects([tx.splitCoins(tx.gas, [1_000_000n])[0]!], receiver.address)
      }, { signer: payer }))
      // The ledger's transaction index follows checkpoints, so wait for it.
      const listed = await local(Effect.gen(function*() {
        const sui = yield* Sui
        return yield* Effect.retry(
          Effect.flatMap(
            Stream.runCollect(Stream.take(
              sui.streamTransactions({ affectedAddress: receiver.address }, { order: "descending" }),
              5
            )),
            (items) => {
              const digests = [...items].map((item) => item._tag === "Success" ? item.success.digest : item.failure.digest)
              return digests.includes(executed.digest) ? Effect.succeed(digests) : Effect.fail("not indexed yet" as const)
            }
          ),
          { schedule: Schedule.spaced("500 millis"), times: 40 }
        )
      }))
      expect(listed).toContain(executed.digest)
      const sent = await local(Effect.gen(function*() {
        const sui = yield* Sui
        return [...(yield* Stream.runCollect(sui.streamTransactions({ sender: receiver.address })))]
      }))
      expect(sent).toHaveLength(0)
    },
    2 * MINUTE
  )

  test(
    "Tx.run({ intent, approve }) on address-balance gas: one simulate, approved before signing, inside the session",
    async () => {
      const signer = await funded()
      await local(Tx.foldCoins({ signer }))
      const recipient = (await Effect.runPromise(ephemeral)).address
      const epoch = await local(Effect.gen(function*() {
        const { systemState } = yield* (yield* SuiCore).getCurrentSystemState()
        return BigInt(systemState.epoch)
      }))
      let seen: Prepared | undefined
      const { value: executed, simulates } = await counted(Tx.run(Tx.sendFunds({ amount: 1_000_000_000n, recipient }), {
        // A one-epoch session: the window is capped at it, and a node accepts that.
        signer: { ...signer, maxEpoch: epoch },
        intent: {
          summary: "Send 1 SUI to a fresh account.",
          author: "user",
          claims: { outflows: [{ coinType: CoinType.SUI, max: 1_000_000_000n }], recipients: [recipient], objects: [] }
        },
        approve: (prepared) => Effect.sync(() => (seen = prepared))
      }))
      expect(executed.effects.status.success).toBe(true)
      expect(executed.sender).toBe(signer.address)
      expect(seen).toBeDefined()
      const prepared = seen!
      expect(prepared.built.gas.source).toBe("addressBalance")
      expect(prepared.built.gas.payment).toEqual([])
      expect(prepared.built.gas.owner).toBe(signer.address)
      // gRPC: the resolver simulated a pre-budget transaction, so the build kept none.
      expect(prepared.built.simulation).toBeUndefined()
      expect(prepared.verified?.verdict._tag).toBe("Unscreened")
      expect(prepared.simulation.balanceChange(recipient, CoinType.SUI)).toBe(1_000_000_000n)
      expect(executed.balanceChange(recipient, CoinType.SUI)).toBe(1_000_000_000n)
      expect(prepared.built.expiration?.$kind === "ValidDuring" ? prepared.built.expiration.ValidDuring.maxEpoch : null)
        .toBe(epoch)
      // Preflight, the intent and approve share one simulate of the final bytes.
      expect(simulates).toBe(1)
      console.error(
        `run({ intent, approve }): ${simulates} explicit simulate, gas ${prepared.built.gas.source},` +
          ` budget ${prepared.built.gas.budget}, net gas ${prepared.simulation.gasUsedTotal}, window ${epoch}..${epoch}`
      )
    },
    5 * MINUTE
  )

  test(
    "Tx.prepare → preview → Tx.sign → Tx.submit, and the same for bytes handed over",
    async () => {
      const signer = await funded()
      await local(Tx.foldCoins({ signer }))
      const recipient = (await Effect.runPromise(ephemeral)).address
      const { value, simulates } = await counted(Effect.gen(function*() {
        const prepared = yield* Tx.prepare(Tx.sendFunds({ amount: 2_000n, recipient }), { sender: signer.address })
        const executed = yield* Tx.submit(yield* Tx.sign(prepared.built, signer))
        // A dapp's bytes: not rebuilt, simulated as they are.
        const handed = yield* Tx.build(Tx.sendFunds({ amount: 3_000n, recipient }), { sender: signer.address })
        const again = yield* Tx.prepare(yield* Tx.fromBytes(handed.bytes), { sender: signer.address })
        const second = yield* Tx.submit(yield* Tx.sign(again.built, signer))
        return { prepared, executed, again, handed, second }
      }))
      expect(value.executed.digest).toBe(value.prepared.built.digest)
      expect(value.executed.sender).toBe(signer.address)
      expect(value.prepared.simulation.balanceChange(recipient, CoinType.SUI))
        .toBe(value.executed.balanceChange(recipient, CoinType.SUI))
      expect(value.again.built.digest).toBe(value.handed.digest)
      expect(value.again.built.gas).toEqual(value.handed.gas)
      expect(value.second.effects.status.success).toBe(true)
      // One per prepare.
      expect(simulates).toBe(2)
      expect((await balanceOf(recipient)).addressBalance).toBe(5_000n)
    },
    5 * MINUTE
  )

  test(
    "a previewed fold runs as planned, and approve sees the coins move into the balance",
    async () => {
      const signer = await funded()
      const before = await balanceOf(signer.address)
      const plan = await local(Tx.planFold({ owner: signer.address }))
      const movements: Array<ReturnType<typeof Tx.foldMovement>> = []
      const result = await local(Tx.foldCoins({
        signer,
        plan,
        approve: (prepared, batch) => Effect.sync(() => movements.push(Tx.foldMovement(batch, prepared.simulation)))
      }))
      const after = await balanceOf(signer.address)
      expect(result.plan).toBe(plan)
      expect(movements.length).toBe(plan.batches.length)
      const moved = movements[0]!
      expect(moved.exact).toBe(true)
      expect(moved.consumed.length).toBe(plan.batches[0]!.coins.length)
      expect(moved.fromCoins).toBe(before.coinBalance)
      // What balanceChanges alone shows: the net gas, a rebate here.
      expect(moved.netChange).toBe(moved.toAddressBalance - moved.fromCoins)
      expect(after.addressBalance - before.addressBalance).toBe(moved.toAddressBalance)
      expect(Tx.foldMovement(plan.batches[0]!, result.executed[0]!)).toEqual(moved)
      console.error(
        `fold preview: ${moved.consumed.length} coins, ${moved.fromCoins} MIST from coins,` +
          ` +${moved.toAddressBalance} MIST into the balance, net change ${moved.netChange}`
      )
    },
    5 * MINUTE
  )

  test(
    "Tx.sendAll leaves 0: SUI in coins, in a balance and in both, and a second coin type",
    async () => {
      const sweepTo = async (signer: Signer, coinType?: CoinType) => {
        const recipient = (await Effect.runPromise(ephemeral)).address
        const before = await balanceOf(signer.address, coinType)
        const result = await local(Tx.sendAll({ signer, recipient, ...(coinType === undefined ? {} : { coinType }) }))
        expect(result.executed.effects.status.success).toBe(true)
        const after = await balanceOf(signer.address, coinType)
        const got = await balanceOf(recipient, coinType)
        console.error(
          `sendAll ${coinType === undefined ? "SUI" : "FCOIN"} (${result.sweep.gas}): before ${before.coinBalance} in coins +` +
            ` ${before.addressBalance} in the balance; after ${after.coinBalance} + ${after.addressBalance};` +
            ` recipient +${got.addressBalance} (received ${result.received})`
        )
        expect(after).toEqual({ coinBalance: 0n, addressBalance: 0n })
        expect(await coinCount(signer.address, coinType)).toBe(0)
        expect(got.addressBalance).toBe(result.received)
        // A read of it names its sender (0.5.0): read from the transaction's BCS.
        const read = await local(Effect.flatMap(Sui, (sui) => sui.getTransaction(result.executed.digest)))
        expect(read.sender).toBe(signer.address)
        return result
      }

      // Coins only: the faucet's five coins are the gas payment.
      const coins = await sweepTo(await funded())
      expect(coins.sweep.gas).toBe("coins")

      // A balance only: a reservation of all of it is the gas coin.
      const folded = await funded()
      await local(Tx.foldCoins({ signer: folded }))
      const balance = await sweepTo(folded)
      expect(balance.sweep.gas).toBe("coinReservation")
      expect(balance.sweep.coins).toHaveLength(0)

      // Both, more in coins: the balance is redeemed into the coin payment. A
      // send to oneself from a coin-only account splits it off the gas coin.
      const mixed = await funded()
      await local(Tx.run(Tx.sendFunds({ amount: 1_000_000_000n, recipient: mixed.address }), { signer: mixed }))
      const both = await balanceOf(mixed.address)
      expect(both.addressBalance).toBe(1_000_000_000n)
      expect(both.coinBalance).toBeGreaterThan(both.addressBalance)
      expect((await sweepTo(mixed)).sweep.gas).toBe("coins")

      // Both, more in the balance: the coins are merged into the reservation.
      const refilled = await funded()
      await local(Tx.foldCoins({ signer: refilled }))
      await requestSuiFromFaucetV2({ host: FAUCET, recipient: refilled.address })
      await local(Effect.retry(
        Effect.flatMap(Effect.flatMap(Sui, (sui) => sui.getBalance(refilled.address)), (value) =>
          value.coinBalance > 0n ? Effect.void : Effect.fail("not visible yet" as const)),
        { schedule: Schedule.spaced("250 millis"), times: 40 }
      ))
      const merged = await sweepTo(refilled)
      expect(merged.sweep.gas).toBe("coinReservation")
      expect(merged.sweep.coins.length).toBeGreaterThan(0)

      // Another coin type: coins and balance, gas from SUI.
      const minter = await funded()
      const published = await local(Tx.run((tx) => {
        const [cap] = tx.publish({ modules: [FCOIN_MODULE], dependencies: ["0x1", "0x2"] })
        tx.transferObjects([cap!], minter.address)
      }, { signer: minter }))
      const packageId = published.effects.changedObjects.find((change) => change.outputState === "PackageWrite")!
        .objectId
      const fcoin = CoinType.normalize(`${packageId}::fcoin::FCOIN`)
      const capId = published.effects.changedObjects.find((change) =>
        change.idOperation === "Created" && change.outputState !== "PackageWrite" &&
        (published.objectTypes?.[change.objectId] ?? "").includes("TreasuryCap")
      )!.objectId
      await local(Tx.run((tx) => {
        for (const amount of [5_000n, 7_000n]) {
          tx.transferObjects([
            tx.moveCall({ target: "0x2::coin::mint", typeArguments: [fcoin], arguments: [tx.object(capId), tx.pure.u64(amount)] })
          ], minter.address)
        }
        tx.moveCall({
          target: "0x2::coin::send_funds",
          typeArguments: [fcoin],
          arguments: [
            tx.moveCall({ target: "0x2::coin::mint", typeArguments: [fcoin], arguments: [tx.object(capId), tx.pure.u64(3_000n)] }),
            tx.pure.address(minter.address)
          ]
        })
      }, { signer: minter }))
      const other = await sweepTo(minter, fcoin)
      expect(other.sweep.gas).toBe("auto")
      expect(other.sweep.amount).toBe(15_000n)
      expect(other.received).toBe(15_000n)
    },
    5 * MINUTE
  )
})
