/**
 * Regressions from the 0.5.0 pre-merge review. Each `describe` is one defect
 * the review confirmed with a failing test before it was fixed.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { PolicyDenied } from "../src/domain/errors.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { verifySponsored } from "../src/tx.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, layerTest, SuiTest } from "../src/testing.ts"
import { BuildError } from "../src/domain/errors.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = `${PADDED("2")}::sui::SUI`
const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41)))
const other = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(43)))
const SENDER = signer.address
const THIEF = SuiAddress.make(PADDED("bad"))

const funded = (who: string) => ({
  owner: who,
  coinType: SUI,
  balance: "1000000000",
  coinBalance: "0",
  addressBalance: "1000000000"
})

/** A preset budget, so the fake's resolver does not simulate and `Tx.build` does (`built.simulation`). */
const send = (amount: bigint) => (tx: Transaction) => {
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [SUI],
    arguments: [tx.balance({ balance: amount }), tx.pure.address(THIEF)]
  })
  tx.setGasBudget(5_000_000n)
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript
): Promise<A> =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), { local: true })
  )

describe("Tx.foldCoins refuses a plan whose batch names another owner", () => {
  const coin = fakeCoin({ objectId: PADDED("c001"), owner: SENDER, balance: 5_000_000_000n })
  const script: FakeScript = {
    chainId: CHAIN_ID,
    objects: [],
    coins: [coin],
    balances: [{ owner: SENDER, coinType: SUI, balance: "5000000000", coinBalance: "5000000000", addressBalance: "0" }],
    simulate: [FakeOutcome.succeed()],
    execute: [FakeOutcome.succeed()]
  }

  test("plan.owner is the signer, a batch's owner is not: nothing is built", async () => {
    const { error, executes } = await run(
      Effect.gen(function*() {
        const plan = yield* Tx.planFold({ owner: SENDER })
        const forged = { ...plan, batches: plan.batches.map((batch) => ({ ...batch, owner: THIEF })) }
        const error = yield* Effect.flip(Tx.foldCoins({ signer, plan: forged }))
        return { error, executes: (yield* SuiTest.calls("executeTransaction")).length }
      }),
      script
    )
    expect(error).toBeInstanceOf(BuildError)
    expect(executes).toBe(0)
  })
})

describe("handed-over bytes: the gas ceiling and the sponsorship check read the bytes", () => {
  const script: FakeScript = {
    chainId: CHAIN_ID,
    objects: [],
    coins: [],
    balances: [funded(SENDER), funded(other.address)],
    simulate: [FakeOutcome.succeed()],
    execute: [FakeOutcome.succeed()]
  }
  /** Bytes somebody else built with a 5,000,000 MIST budget. */
  const handedOver = Effect.flatMap(
    Tx.build(send(1n), { sender: SENDER }),
    (built) => Tx.fromBytes(built.bytes)
  )

  test("verifySponsored refuses bytes the sender pays for, whatever the Built's gasOwner field says", async () => {
    const error = await run(
      Effect.flatMap(handedOver, (built) =>
        Effect.flip(verifySponsored({ ...built, gasOwner: other.address }, { sender: SENDER }))),
      script
    )
    expect(error).toBeInstanceOf(PolicyDenied)
    expect((error as PolicyDenied).rule).toBe("sponsored.gasOwner")
  })
})
