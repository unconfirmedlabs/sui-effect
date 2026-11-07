/**
 * The one test in this repository that touches a network.
 *
 * The unit suite runs over scripted answers, which is what makes it fast and
 * deterministic — and which is exactly why it cannot answer the question this
 * file exists for: does a transaction sui-effect builds with its *default*
 * settings get accepted by a real validator? Scripted answers execute nothing
 * and validate nothing, so the epoch bounds in the default `ValidDuring`
 * (DESIGN.md section 6) are unfalsifiable without a live chain.
 *
 * Gated behind `SUI_LIVE=1`, so `bun run check` never opens a socket:
 *
 * ```bash
 * SUI_LIVE=1 bun test test/live.devnet.test.ts
 * ```
 *
 * It funds a throwaway key from the devnet faucet with
 * `requestSuiFromFaucetV3`, the proof-of-work faucet devnet and testnet run
 * since `@mysten/sui` 2.34. V3 pays into the recipient's **address balance**,
 * not a coin object, so the transactions below also exercise the resolver's
 * address-balance gas path; `Sui.getBalance` sums both. If the faucet refuses or
 * rate-limits, the test skips loudly rather than failing: a faucet outage is
 * not a regression in this package. So does an SDK older than 2.34, which has
 * no V3 helper.
 */
import { describe, expect, test } from "bun:test"
import { getFaucetHost } from "@mysten/sui/faucet"
import { Transaction } from "@mysten/sui/transactions"
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import { DateTime, Duration, Effect, Layer, Schedule } from "effect"
import { maxTimestampMsOf } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { ephemeral } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { defaultGrpcUrl, SuiCore } from "../src/services/SuiCore.ts"

const LIVE = process.env["SUI_LIVE"] === "1"
const BASE_URL = process.env["SUI_RPC_URL"] ?? defaultGrpcUrl("devnet")!
const MINUTE = 60_000

const layer = Layer.mergeAll(
  Sui.layerNoDeps.pipe(
    Layer.provideMerge(SuiCore.layerGrpc({ network: "devnet", baseUrl: BASE_URL }))
  ),
  Journal.layerMemory
)

const live = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore>): Promise<A> =>
  Effect.runPromise(Effect.provide(effect, layer, { local: true }))

/**
 * `@mysten/sui/faucet`'s V3 helper, which first shipped in 2.34.
 *
 * Loaded through a variable specifier and typed here, the way `Signer` loads
 * `MLDSA65Keypair`: the CI SDK matrix typechecks this file against 2.30.0 too,
 * where a static `import { requestSuiFromFaucetV3 }` is a compile error.
 */
const FAUCET_MODULE = "@mysten/sui/faucet"

interface FaucetV3Module {
  readonly requestSuiFromFaucetV3?: (input: {
    readonly host: string
    readonly recipient: string
    readonly signal?: AbortSignal
    readonly timeout?: number
  }) => Promise<{ readonly status: string; readonly digest: string; readonly amountMist: string }>
}

/**
 * A funded throwaway signer, or `undefined` when the faucet would not play.
 *
 * The faucet answers before the payout is queryable, so this waits for the
 * balance to appear rather than assuming it.
 */
const funded = async () => {
  const signer = await Effect.runPromise(ephemeral)
  const faucet: FaucetV3Module = await import(FAUCET_MODULE)
  if (faucet.requestSuiFromFaucetV3 === undefined) {
    return { signer, reason: "the installed @mysten/sui predates requestSuiFromFaucetV3 (2.34)" }
  }
  try {
    const response = await faucet.requestSuiFromFaucetV3({
      host: getFaucetHost("devnet"),
      recipient: signer.address,
      // Fetching the challenge and solving the proof of work; the SDK's own
      // default is three minutes.
      timeout: 3 * MINUTE
    })
    if (response.status !== "success") {
      return { signer, reason: `the faucet answered ${JSON.stringify(response.status)}` }
    }
  } catch (cause) {
    return { signer, reason: `the faucet refused or rate-limited: ${String(cause)}` }
  }
  const balance = await live(
    Effect.gen(function*() {
      const sui = yield* Sui
      return yield* Effect.retry(
        Effect.flatMap(sui.getBalance(signer.address), (value) =>
          value.balance > 0n
            ? Effect.succeed(value.balance)
            : Effect.fail("the faucet payout is not visible yet" as const)),
        { schedule: Schedule.spaced("2 seconds"), times: 15 }
      ).pipe(Effect.orElseSucceed(() => 0n))
    })
  )
  return balance === 0n
    ? { signer, reason: "the faucet payout never became visible" }
    : { signer, reason: undefined }
}

describe.skipIf(!LIVE)("devnet, with SUI_LIVE=1", () => {
  test(
    "a default-built transaction is accepted by a real validator",
    async () => {
      const { reason, signer } = await funded()
      if (reason !== undefined) {
        console.error(`SKIPPED: ${reason}`)
        return
      }

      const { Tx } = await import("../src/services/Tx.ts")

      // 1. The whole lifecycle, with nothing overridden: the default
      //    `ValidDuring` expiration, the default gas budget ceiling, the
      //    sender lock, the journal.
      const executed = await live(
        Tx.run((tx) => {
          const [coin] = tx.splitCoins(tx.gas, [1_000n])
          tx.transferObjects([coin!], signer.address)
        }, { signer })
      )
      expect(executed.digest.length).toBeGreaterThan(0)
      expect(executed.effects.status.success).toBe(true)

      // 2. A PTB whose only object input is the shared Clock. It has no
      //    address-owned object inputs at all, which is the case the validator
      //    rejects unless the expiration bounds at most two epochs — the whole
      //    reason the default carries `minEpoch` and `maxEpoch`.
      const built = await live(
        Tx.build((tx: Transaction) => {
          tx.moveCall({
            target: "0x2::clock::timestamp_ms",
            arguments: [tx.object(SUI_CLOCK_OBJECT_ID)]
          })
        }, { sender: signer.address })
      )
      expect(built.bytes.length).toBeGreaterThan(0)
      expect(built.expiration?.$kind).toBe("ValidDuring")
      if (built.expiration?.$kind === "ValidDuring") {
        const { maxEpoch, minEpoch } = built.expiration.ValidDuring
        expect(minEpoch).not.toBeNull()
        expect(maxEpoch).not.toBeNull()
        expect(maxEpoch! - minEpoch!).toBe(1n)
      }

      // The default carries no timestamp bound at all, which is the whole
      // reason transaction 1 above was accepted: a devnet node refuses any
      // transaction that has one.
      expect(maxTimestampMsOf(built.expiration)).toBeUndefined()
      expect(SubmitConfig.defaults.validFor).toBeUndefined()

      // 3. The unit of `maxTimestamp`, for the day a network supports it and
      //    for anyone who sets `validFor` today. The bytes are the only
      //    authority — the expiration on `Built` is read back out of them —
      //    and the chain's own clock is the scale it has to be on. A
      //    seconds-versus-milliseconds mistake would expire every transaction
      //    instantly, or bound none of them for two thousand years.
      const validFor = Duration.minutes(2)
      const bounded = await live(
        Effect.provideService(
          Tx.build((tx: Transaction) => {
            tx.moveCall({
              target: "0x2::clock::timestamp_ms",
              arguments: [tx.object(SUI_CLOCK_OBJECT_ID)]
            })
          }, { sender: signer.address }),
          SubmitConfig,
          { ...SubmitConfig.defaults, validFor }
        ).pipe(Effect.result)
      )
      if (bounded._tag === "Success") {
        const chainTime = await live(Effect.flatMap(Sui, (sui) => sui.chainTime))
        const bound = maxTimestampMsOf(bounded.success.expiration)
        expect(bound).toBeDefined()
        const window = bound! - BigInt(DateTime.toEpochMillis(chainTime))
        const expected = BigInt(Duration.toMillis(validFor))
        // Within a minute of two minutes, in milliseconds.
        expect(window).toBeGreaterThan(expected - BigInt(MINUTE))
        expect(window).toBeLessThan(expected + BigInt(MINUTE))
      } else {
        // The node refuses it, and that refusal is the finding this file
        // records: the default must not carry a timestamp bound.
        const failure = bounded.failure
        console.error(`NOTE: devnet still refuses a timestamp bound: ${String(failure)}`)
        expect(failure._tag).toBe("SimulationFailed")
      }
    },
    // The V3 faucet's proof of work alone may take minutes.
    300_000
  )
})
