/**
 * Address aliases and a multisig signer, proved against a **localnet**.
 *
 * The unit suite runs over scripted answers, which execute no Move and verify
 * no signature against an alias set, so what this file checks needs a chain:
 * that `AddressAlias.aliasesId` is the id the framework derives, that a
 * validator accepts `Signer.alias(A, Signer.multisig(…))` — partial signatures
 * combined in member order — through `Tx.run` and through `Tx.attach`, and
 * that once A removed itself from its own set its old key is refused.
 *
 * Gated behind `SUI_LOCALNET=1`, so `bun run check` never opens a socket:
 *
 * ```bash
 * sui start --with-faucet --force-regenesis &
 * SUI_LOCALNET=1 bun test test/live.localnet-alias.test.ts
 * ```
 *
 * `SUI_LOCALNET_URL` (default `http://127.0.0.1:9000`) and
 * `SUI_LOCALNET_FAUCET` (default `http://127.0.0.1:9123`) override the
 * endpoints, as in `test/live.localnet.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { MultiSigPublicKey } from "@mysten/sui/multisig"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect, Layer, Schedule } from "effect"
import { SuiError } from "../src/domain/errors.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { AddressAlias } from "../src/services/AddressAlias.ts"
import { Journal } from "../src/services/Journal.ts"
import { ephemeral, fromKeypair, Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"
import { Verify } from "../src/services/Verify.ts"

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

describe.skipIf(!LOCALNET)("address aliases on localnet, with SUI_LOCALNET=1", () => {
  test(
    "enable, add a multisig, remove the sender; Tx.run signed by the multisig lands and the old key is refused",
    async () => {
      // A: a throwaway key with the faucet's coins on it.
      const account = await Effect.runPromise(ephemeral)
      const A = account.address
      await requestSuiFromFaucetV2({ host: FAUCET, recipient: A })
      await local(Effect.gen(function*() {
        const sui = yield* Sui
        yield* Effect.retry(
          Effect.flatMap(sui.getBalance(A), (value) =>
            value.coinBalance > 0n ? Effect.void : Effect.fail("not visible yet" as const)),
          { schedule: Schedule.spaced("250 millis"), times: 40 }
        )
      }))

      // Tx.sendFunds draws from the address balance only: fold the faucet's coins.
      await local(Tx.foldCoins({ signer: account }))

      // M: a 2-of-3 multisig of fresh Ed25519 keys.
      const keys = [new Ed25519Keypair(), new Ed25519Keypair(), new Ed25519Keypair()]
      const publicKey = MultiSigPublicKey.fromPublicKeys({
        threshold: 2,
        publicKeys: keys.map((key) => ({ publicKey: key.getPublicKey(), weight: 1 }))
      })
      const M = SuiAddress.make(normalizeSuiAddress(publicKey.toSuiAddress()))
      const SINK = (await Effect.runPromise(ephemeral)).address

      // 1. enable: signed by A's own key; the object lands at the derived id.
      const enabled = await local(Tx.run(AddressAlias.enable(), { signer: account }))
      expect(enabled.effects.status.success).toBe(true)
      expect(enabled.created().some((change) => change.id === AddressAlias.aliasesId(A))).toBe(true)
      expect(await local(AddressAlias.getAliases(A))).toMatchObject({ _tag: "Enabled", aliases: [A] })

      // 2. add M and remove A, in one transaction, still signed by A's key.
      const edited = await local(Tx.run((tx) => {
        AddressAlias.add({ address: A, alias: M })(tx)
        AddressAlias.remove({ address: A, alias: A })(tx)
      }, { signer: account }))
      expect(edited.effects.status.success).toBe(true)
      const aliases = await local(AddressAlias.getAliases(A))
      expect(aliases._tag === "Enabled" && aliases.aliases).toEqual([M])

      // 3. Tx.run as A, signed by M — two members given out of member order.
      const m = await local(Signer.multisig(publicKey, [fromKeypair(keys[2]!), fromKeypair(keys[0]!)]))
      const viaM = await local(Tx.run(Tx.sendFunds({ amount: 1_000n, recipient: SINK }), {
        signer: Signer.alias(A, m)
      }))
      expect(viaM.effects.status.success).toBe(true)
      expect(viaM.sender).toBe(A)
      console.error(`alias: ${viaM.digest} sent by ${A}, signed by the multisig ${M}`)

      // The same two members combined in the order given — what the SDK's
      // `combinePartialSignatures` keeps — is refused by the validator.
      const misordered = Signer.alias(A, Signer.remote({
        address: M,
        scheme: "MultiSig",
        signTransaction: (bytes) =>
          Effect.promise(async () =>
            publicKey.combinePartialSignatures([
              (await keys[2]!.signTransaction(bytes)).signature,
              (await keys[0]!.signTransaction(bytes)).signature
            ])
          )
      }))
      const refused = await local(Effect.flip(Tx.run(Tx.sendFunds({ amount: 999n, recipient: SINK }), { signer: misordered })))
      console.error(`member order reversed: ${SuiError.describe(refused)}`)
      expect(SuiError.outcome(refused)).toBe("not_applied")

      // 4. The explicit lifecycle: build as A, sign with M, attach, submit.
      const attached = await local(Effect.gen(function*() {
        const built = yield* Tx.build(Tx.sendFunds({ amount: 1_001n, recipient: SINK }), { sender: A })
        const signature = yield* m.signTransaction(built.bytes)
        yield* Verify.verifyTransactionSignature(built.bytes, signature, { address: A, checkAddressAliases: true })
        return yield* Tx.submit(yield* Tx.attach(built, signature))
      }))
      expect(attached.effects.status.success).toBe(true)

      // 5. The old key: refused by the node, and by the alias-aware checks.
      const old = await local(Effect.flip(Tx.run(Tx.sendFunds({ amount: 1_002n, recipient: SINK }), { signer: account })))
      console.error(`old key: ${old._tag} ${SuiError.describe(old)}`)
      expect(SuiError.outcome(old)).toBe("not_applied")
      const checks = await local(Effect.gen(function*() {
        const built = yield* Tx.build(Tx.sendFunds({ amount: 1_003n, recipient: SINK }), { sender: A })
        const own = yield* account.signTransaction(built.bytes)
        return {
          verify: yield* Effect.flip(
            Verify.verifyTransactionSignature(built.bytes, own, { address: A, checkAddressAliases: true })
          ),
          // A one-member multisig signer that A does not list.
          outsider: yield* Effect.flip(Tx.run(Tx.sendFunds({ amount: 1_004n, recipient: SINK }), {
            signer: Signer.alias(A, fromKeypair(keys[1]!))
          }))
        }
      }))
      expect(checks.verify._tag).toBe("PolicyDenied")
      expect(checks.outsider._tag).toBe("PolicyDenied")
    },
    5 * MINUTE
  )
})
