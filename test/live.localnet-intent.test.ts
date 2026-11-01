/**
 * Intents against a **localnet**: the claims rule on the balance changes a real
 * node reports for address-balance gas (DESIGN §17). The fake scripts balance
 * changes; only a node says what they are.
 *
 * Gated behind `SUI_LOCALNET=1`, like `test/live.localnet.test.ts`:
 *
 * ```bash
 * sui start --with-faucet --force-regenesis &
 * SUI_LOCALNET=1 bun test test/live.localnet-intent.test.ts
 * ```
 */
import { describe, expect, test } from "bun:test"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Layer, Schedule } from "effect"
import { checkClaims, Intent } from "../src/domain/intent.ts"
import { CoinType } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import type { Signer } from "../src/services/Signer.ts"
import { ephemeral } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"

const LOCALNET = process.env["SUI_LOCALNET"] === "1"
const BASE_URL = process.env["SUI_LOCALNET_URL"] ?? "http://127.0.0.1:9000"
const FAUCET = process.env["SUI_LOCALNET_FAUCET"] ?? "http://127.0.0.1:9123"
const MINUTE = 60_000
const ONE_SUI = 1_000_000_000n

const layer = Layer.mergeAll(
  Sui.layerNoDeps.pipe(
    Layer.provideMerge(SuiCore.layerGrpc({ network: "localnet", baseUrl: BASE_URL }))
  ),
  Journal.layerMemory
)

const local = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer, { local: true }))

/** A fresh key whose faucet coins are folded, so gas comes from its address balance. */
const folded = async (): Promise<Signer> => {
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
  await local(Tx.foldCoins({ signer }))
  return signer
}

const sendIntent = (recipient: Signer["address"], max: bigint): Intent => ({
  summary: "Send 1 SUI to a friend.",
  author: "user",
  claims: { outflows: [{ coinType: CoinType.SUI, max }], recipients: [recipient], objects: [] }
})

describe.skipIf(!LOCALNET)("intents on localnet, with SUI_LOCALNET=1", () => {
  test(
    "address-balance gas is not an outflow; the withdrawal is, and its receiver a recipient",
    async () => {
      const signer = await folded()
      const friend = await Effect.runPromise(ephemeral)
      const answer = await local(Effect.gen(function*() {
        const sui = yield* Sui
        const built = yield* Tx.build(Tx.sendFunds({ amount: ONE_SUI, recipient: friend.address }), {
          sender: signer.address
        })
        const simulation = yield* sui.simulate(built.bytes)
        return { built, simulation }
      }))
      expect(TransactionDataBuilder.fromBytes(answer.built.bytes).gasData.payment).toEqual([])
      const { built, simulation } = answer
      expect(checkClaims(sendIntent(friend.address, ONE_SUI), simulation, built)).toEqual([])
      expect(checkClaims(sendIntent(friend.address, ONE_SUI - 1n), simulation, built).map((v) => v.rule))
        .toEqual(["outflow"])
      const derived = Intent.fromSimulation(simulation, built, { summary: "Send 1 SUI.", author: "dapp" })
      expect(derived.claims.outflows).toEqual([{ coinType: CoinType.SUI, max: ONE_SUI }])
      expect(derived.claims.recipients).toEqual([friend.address])
      expect(derived.claims.objects).toEqual([])
    },
    5 * MINUTE
  )

  test(
    "Tx.run with an intent executes inside its claims, and refuses one tighter",
    async () => {
      const signer = await folded()
      const friend = await Effect.runPromise(ephemeral)
      const recipe = Tx.sendFunds({ amount: ONE_SUI, recipient: friend.address })
      const refused = await local(Effect.flip(Tx.run(recipe, { signer, intent: sendIntent(friend.address, ONE_SUI / 2n) })))
      expect(refused._tag).toBe("PolicyDenied")
      if (refused._tag === "PolicyDenied") expect(refused.rule).toBe("intent.outflow")
      const executed = await local(Tx.run(recipe, { signer, intent: sendIntent(friend.address, ONE_SUI) }))
      expect(executed.effects.status.success).toBe(true)
      expect(executed.balanceChange(friend.address, "0x2::sui::SUI")).toBe(ONE_SUI)
    },
    5 * MINUTE
  )
})
