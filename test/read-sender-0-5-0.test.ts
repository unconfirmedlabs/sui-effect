/**
 * `Executed.sender` on the read paths (0.5.0, wallet finding 15):
 * `Sui.getTransaction`, `streamTransactions` (a `sender` filter and the
 * gRPC ledger's `affectedAddress` listing) ask for the transaction's `bcs`
 * and read the sender out of it, with no change to `SuiCore`'s include types.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Effect, Layer, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, fakeDigest, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = SuiAddress.make(PADDED("a11ce"))
const BOB = PADDED("b0b")
const SUI_TYPE = `${PADDED("2")}::sui::SUI`
const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(71)))

const history: FakeScript["transactions"] = {
  [fakeDigest(1)]: FakeOutcome.succeed({
    sender: ALICE,
    balanceChanges: [
      { coinType: SUI_TYPE, address: ALICE, amount: "-100" },
      { coinType: SUI_TYPE, address: BOB, amount: "100" }
    ]
  })
}

const run = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>, script: FakeScript) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), { local: true })
  )

const successes = <A, E>(items: ReadonlyArray<Result.Result<A, E>>): ReadonlyArray<A> =>
  items.flatMap((item) => Result.isSuccess(item) ? [item.success] : [])

describe("Executed.sender on read paths", () => {
  test("Sui.getTransaction of a scripted transaction, and the include it sent", async () => {
    const { executed, include } = await run(
      Effect.gen(function*() {
        const executed = yield* (yield* Sui).getTransaction(fakeDigest(1) as never)
        const calls = yield* SuiTest.calls("getTransaction")
        return { executed, include: (calls[0]!.options as { include?: Record<string, boolean> }).include }
      }),
      { transactions: history }
    )
    expect(executed.sender).toBe(ALICE)
    expect(include?.["bcs"]).toBe(true)
    expect(include?.["transaction"]).toBeUndefined()
  })

  test("Sui.getTransaction of a transaction the fake executed reads the sender its bytes name", async () => {
    const read = await run(
      Effect.gen(function*() {
        const executed = yield* Tx.run((tx) => {
          tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
        }, { signer })
        return yield* (yield* Sui).getTransaction(executed.digest)
      }),
      {
        balances: [{ owner: signer.address, coinType: SUI_TYPE, balance: "5000000000", coinBalance: "0", addressBalance: "5000000000" }],
        execute: [FakeOutcome.succeed()]
      }
    )
    expect(read.sender).toBe(signer.address)
  })

  test("streamTransactions with a sender filter and with affectedAddress", async () => {
    const { bySender, affected } = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return {
          bySender: successes([...(yield* Stream.runCollect(sui.streamTransactions({ sender: ALICE })))]),
          affected: successes([...(yield* Stream.runCollect(sui.streamTransactions({ affectedAddress: BOB })))])
        }
      }),
      { transactions: history, ledger: {} }
    )
    expect(bySender.map((executed) => executed.sender)).toEqual([ALICE])
    expect(affected.map((executed) => executed.sender)).toEqual([ALICE])
  })
})
