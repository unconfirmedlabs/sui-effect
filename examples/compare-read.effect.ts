/**
 * Reads one Escrow object and its optional note through sui-effect.
 *
 * Compare with `examples/compare-read.sdk.ts`, which reads the same two
 * things with the canonical SDK client. Both print identical output.
 *
 * Run with `SUI_NETWORK=testnet ESCROW_ID=0x… bun examples/compare-read.effect.ts`.
 * Every failure this program can produce is in the generator's inferred error
 * type: `ObjectNotFound`, `ObjectDeleted`, `ObjectUnavailable` and
 * `DecodeError` (the last one is what a wrong Move type becomes, because
 * `getObject`'s tag check runs before a byte is parsed), plus `TransportError`
 * from both reads and, from the layer, `ConfigError` and `NetworkMismatch`.
 */
import { bcs } from "@mysten/sui/bcs"
import { Config, Console, Effect, Option } from "effect"
import { ObjectId, Sui, SuiSchema } from "../src/index.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

const Escrow = SuiSchema.bcs(
  bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() }),
  `${PKG}::escrow::Escrow`
)
// The note's value has no struct tag of its own, so its codec carries none;
// the key is a primitive `u64`, which is why nothing here reaches for
// `normalizeStructTag` on it.
const Note = SuiSchema.bcs(bcs.u64())
const NOTE_NAME = { type: "u64", bcs: bcs.u64().serialize(0).toBytes() }

/** The program itself, exported so a test can run it against the fake. */
export const program = Effect.gen(function*() {
  const sui = yield* Sui
  const id = yield* Config.schema(ObjectId, "ESCROW_ID")
  // No `ObjectError.reason` switch and no manual type comparison: a missing
  // or deleted escrow and a wrong Move type are already three different tags
  // in the type this line returns.
  const escrow = yield* sui.getObject(id, { schema: Escrow })
  const field = yield* sui.getDynamicFieldOption(id, NOTE_NAME)
  const note = yield* Option.match(field, {
    onNone: () => Effect.void,
    onSome: (entry) => SuiSchema.decode(Note, entry.value.bcs)
  })
  yield* Console.log(`${escrow.id} holds ${escrow.content.amount}, note: ${note ?? "none"}`)
})

if (import.meta.main) {
  // Imported here rather than at the top so that a test can import `program`
  // without pulling a platform package into the test process.
  const { BunRuntime } = await import("@effect/platform-bun")
  BunRuntime.runMain(program.pipe(Effect.provide(Sui.layerConfig)))
}
