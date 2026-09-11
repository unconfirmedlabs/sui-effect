/**
 * Reads one object and its chain time against a live node.
 *
 * Run with `SUI_NETWORK=testnet ESCROW_ID=0x… bun examples/read-escrow.ts`.
 * Every failure this program can produce is in the generator's inferred error
 * type: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable`, `DecodeError`
 * and `TransportError` from the reads, plus `ConfigError` and `NetworkMismatch`
 * from the layer — the latter when `SUI_NETWORK` is `mainnet` or `testnet` and
 * `SUI_RPC_URL` points at a node on another chain.
 */
import { bcs } from "@mysten/sui/bcs"
import { BunRuntime } from "@effect/platform-bun"
import { Config, Console, Effect } from "effect"
import { ObjectId, Sui, SuiSchema } from "../src/index.ts"

const PACKAGE = "0x0000000000000000000000000000000000000000000000000000000000000002"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PACKAGE}::escrow::Escrow`
)

const program = Effect.gen(function*() {
  const sui = yield* Sui
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const now = yield* sui.chainTime
  yield* Console.log(`${escrow.id} holds ${escrow.content.amount} at ${now.toString()}`)
})

BunRuntime.runMain(program.pipe(Effect.provide(Sui.layerConfig)))
