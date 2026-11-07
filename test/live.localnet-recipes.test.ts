/**
 * The recipes `docs/llms-head.md` quotes whose point is what a validator
 * does, run against a **localnet**: folding coins into the address balance,
 * paying from it, the two sponsored flows (and a submission missing the
 * sponsor's signature, which a validator refuses), and handing an account over
 * to a multisig alias.
 *
 * Gated behind `SUI_LOCALNET=1`, so `bun run check` never opens a socket:
 *
 * ```bash
 * sui start --with-faucet --force-regenesis &
 * SUI_LOCALNET=1 bun test test/live.localnet-recipes.test.ts
 * ```
 *
 * `SUI_LOCALNET_URL` (default `http://127.0.0.1:9000`) and
 * `SUI_LOCALNET_FAUCET` (default `http://127.0.0.1:9123`) override the
 * endpoints. The localnet faucet pays coin objects, which is what the fold
 * recipe exists for.
 */
import { describe, expect, test } from "bun:test"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Layer, Schedule, Stream } from "effect"
import { handOver, payAs } from "../examples/recipes/account-alias.ts"
import { pay } from "../examples/recipes/build-and-submit.ts"
import { foldAll, previewFold } from "../examples/recipes/fold-coins.ts"
import { sponsorBytes } from "../examples/recipes/sponsored-stateless.ts"
import { sponsoredRun, sponsoredSend } from "../examples/recipes/sponsored.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { AddressAlias } from "../src/services/AddressAlias.ts"
import { Journal } from "../src/services/Journal.ts"
import { ephemeral, fromKeypair, type Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"

const LOCALNET = process.env["SUI_LOCALNET"] === "1"
const BASE_URL = process.env["SUI_LOCALNET_URL"] ?? "http://127.0.0.1:9000"
const FAUCET = process.env["SUI_LOCALNET_FAUCET"] ?? "http://127.0.0.1:9123"
const MINUTE = 60_000

const layer = Layer.mergeAll(
  Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCore.layerGrpc({ network: "localnet", baseUrl: BASE_URL }))),
  Journal.layerMemory
)
const local = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<A> => Effect.runPromise(Effect.provide(effect, layer, { local: true }))

/** A fresh key with the faucet's coins on it, once a read sees them. */
const funded = async (): Promise<Signer> => {
  const signer = await Effect.runPromise(ephemeral)
  await requestSuiFromFaucetV2({ host: FAUCET, recipient: signer.address })
  await local(Effect.flatMap(Sui, (sui) =>
    Effect.retry(
      Effect.flatMap(sui.getBalance(signer.address), (balance) => balance.coinBalance > 0n ? Effect.void : Effect.fail("not visible yet" as const)),
      { schedule: Schedule.spaced("250 millis"), times: 40 }
    )))
  return signer
}
const balanceOf = (address: SuiAddress) => local(Effect.flatMap(Sui, (sui) => sui.getBalance(address)))
const coinsOf = (address: SuiAddress) => local(Effect.flatMap(Sui, (sui) => Effect.map(Stream.runCollect(sui.streamCoins(address)), (coins) => [...coins].length)))
const stranger = () => SuiAddress.make(new Ed25519Keypair().toSuiAddress())

describe.skipIf(!LOCALNET)("recipes on localnet, with SUI_LOCALNET=1", () => {
  test(
    "fold-coins previews, then folds a faucet account to zero coins; build-and-submit then pays from the balance",
    async () => {
      const signer = await funded()
      const plan = await local(previewFold(signer))
      expect(plan.batches.length).toBeGreaterThan(0)
      const folded = await local(foldAll(signer))
      expect(folded.digests.length).toBe(plan.batches.length)
      expect(await coinsOf(signer.address)).toBe(0)
      expect((await balanceOf(signer.address)).addressBalance > 0n).toBe(true)

      const recipient = stranger()
      const digest = await local(pay(signer, recipient, 1_234n))
      expect(digest.length).toBeGreaterThan(0)
      expect((await balanceOf(recipient)).addressBalance).toBe(1_234n as never)
    },
    5 * MINUTE
  )

  test(
    "sponsored: both flows land with the sponsor paying; bytes the sponsor does not pay for, or missing its signature, are refused",
    async () => {
      const [sender, sponsor] = await Promise.all([funded(), funded()])
      await local(Effect.all([Tx.foldCoins({ signer: sender }), Tx.foldCoins({ signer: sponsor })]))
      const recipient = stranger()

      const before = await balanceOf(sender.address)
      const explicit = await local(sponsoredSend(sender, sponsor, recipient, 1_000n))
      const inProcess = await local(sponsoredRun(sender, sponsor, recipient, 2_000n))
      expect([explicit.effects.status.success, inProcess.effects.status.success]).toEqual([true, true])
      // The sender paid the amounts and no gas.
      expect(before.addressBalance - (await balanceOf(sender.address)).addressBalance).toBe(3_000n as never)
      expect((await balanceOf(recipient)).addressBalance).toBe(3_000n as never)

      // The stateless sponsor: handed the sender's bytes and signature.
      const parties = { sender: sender.address, gasOwner: sponsor.address }
      const built = await local(Tx.build(Tx.sponsored(parties)(Tx.sendFunds({ amount: 500n, recipient })), parties))
      const signature = await Effect.runPromise(sender.signTransaction(built.bytes))
      const stateless = await local(sponsorBytes(sponsor)(built.bytes, signature))
      expect(stateless.effects.status.success).toBe(true)
      const selfPaid = await local(Tx.build(Tx.sendFunds({ amount: 1n, recipient }), { sender: sender.address }))
      const refused = await local(Effect.flip(sponsorBytes(sponsor)(selfPaid.bytes, await Effect.runPromise(sender.signTransaction(selfPaid.bytes)))))
      expect(refused._tag).toBe("PolicyDenied")

      // Sponsored bytes signed by the sender alone: the validator refuses them, and nothing ran.
      const unsponsored = await local(Effect.gen(function*() {
        const bytes = yield* Tx.build(Tx.sponsored(parties)(Tx.sendFunds({ amount: 7n, recipient })), parties)
        return yield* Effect.flip(Tx.submit(yield* Tx.sign(bytes, sender)))
      }))
      expect([unsponsored._tag, unsponsored._tag === "TransportError" && unsponsored.status]).toEqual(["TransportError", "INVALID_ARGUMENT"])
    },
    5 * MINUTE
  )

  test(
    "account-alias: hand the account over to a multisig, then pay as the account, signed by it",
    async () => {
      const account = await funded()
      await local(Tx.foldCoins({ signer: account }))
      const keys = [new Ed25519Keypair(), new Ed25519Keypair(), new Ed25519Keypair()]
      const publicKey = MultiSigPublicKey.fromPublicKeys({ threshold: 2, publicKeys: keys.map((key) => ({ publicKey: key.getPublicKey(), weight: 1 })) })
      const M = SuiAddress.make(normalizeSuiAddress(publicKey.toSuiAddress()))
      await local(handOver(account, M))
      expect(await local(AddressAlias.getAliases(account.address))).toMatchObject({ _tag: "Enabled", aliases: [M] })
      const recipient = stranger()
      // Members given out of member order: the recipe combines them in it.
      const executed = await local(payAs(account.address, publicKey, [fromKeypair(keys[2]!), fromKeypair(keys[1]!)], recipient))
      expect([executed.effects.status.success, executed.sender]).toEqual([true, account.address])
      expect((await balanceOf(recipient)).addressBalance).toBe(1_000n as never)
    },
    5 * MINUTE
  )
})
