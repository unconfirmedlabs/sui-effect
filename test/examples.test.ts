/**
 * The read examples the README shows side by side, over scripted objects: the
 * SDK version reads the responder's own SDK client, the sui-effect version the
 * `Sui` over it. (The write examples claim an escrow in a package that exists
 * on no network; they typecheck, and the write path itself is proved on a
 * localnet.)
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { readEscrow } from "../examples/compare-read.sdk.ts"
import { program as compareRead } from "../examples/compare-read.effect.ts"
import { program as readEscrowProgram } from "../examples/read-escrow.ts"
import type { Sui } from "../src/services/Sui.ts"
import { type FakeScript, layerTest, ScriptedSuiCore } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e5c0")
const Escrow = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() })
const escrow = { objectId: ESCROW_ID, type: `${PADDED("2")}::escrow::Escrow`, version: 3n, content: Escrow.serialize({ id: ESCROW_ID, amount: "42" }).toBytes() }
const NOTE = PADDED("f001")
const withNote: FakeScript = {
  objects: [escrow],
  dynamicFields: { [ESCROW_ID]: [{ fieldId: NOTE, type: "0x2::dynamic_field::Field<u64, u64>", name: { type: "u64", bcs: bcs.u64().serialize(0).toBytes() }, valueType: "u64", $kind: "DynamicField" }] },
  dynamicFieldValues: { [NOTE]: { type: "u64", bcs: bcs.u64().serialize(99).toBytes() } },
  clockTimestampMs: 1_700_000_000_000n
}
const env = ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SUI_NETWORK: "localnet", ESCROW_ID } }))
const lines = <E>(program: Effect.Effect<void, E, Sui>, script: FakeScript) =>
  Effect.runPromise(program.pipe(Effect.andThen(TestConsole.logLines), Effect.provide(Layer.mergeAll(layerTest(script), TestConsole.layer, env)))).then((l) => l.map(String))
const clientOf = (script: FakeScript) => Effect.runSync(Effect.provide(Effect.map(ScriptedSuiCore, (h) => h.client), ScriptedSuiCore.layer(script)))

describe("the read examples", () => {
  test("read-escrow prints the escrow and the chain time", async () => {
    expect((await lines(readEscrowProgram, withNote))[0]).toContain("holds 42")
  })

  test("compare-read: the SDK version and the sui-effect version read the same fields, with and without a note", async () => {
    expect(await readEscrow(clientOf(withNote), ESCROW_ID)).toEqual({ id: ESCROW_ID, amount: "42", note: "99" })
    expect((await readEscrow(clientOf({ objects: [escrow] }), ESCROW_ID)).note).toBeUndefined()
    await expect(readEscrow(clientOf({}), ESCROW_ID)).rejects.toThrow("does not exist")
    expect((await lines(compareRead, withNote))[0]).toContain("holds 42, note: 99")
    expect((await lines(compareRead, { objects: [escrow] }))[0]).toContain("holds 42, note: none")
  })
})
