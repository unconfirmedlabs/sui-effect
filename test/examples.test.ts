/**
 * Every example runs against the fake.
 *
 * `examples/script-claim.ts` has its own file. This one covers the read example
 * and both faces of the extension example, so no snippet that reaches `LLMS.md`
 * or the README is untested.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { ConfigProvider, Effect, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { readEscrow } from "../examples/compare-read.sdk.ts"
import { program as compareReadProgram } from "../examples/compare-read.effect.ts"
import { claimEscrow } from "../examples/compare-write.sdk.ts"
import { program as compareWriteProgram } from "../examples/compare-write.effect.ts"
import { Escrow, program as consumerProgram, readWithPromises } from "../examples/extension-consumer.ts"
import { program as readProgram } from "../examples/read-escrow.ts"
import { Script } from "../src/script.ts"
import { Journal } from "../src/services/Journal.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { layerTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const PKG = PADDED("2")
const ESCROW_ID = PADDED("e5c0")
const RECEIPT_ID = PADDED("7ece17")

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(5))
const SENDER = keypair.toSuiAddress()
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

/** The layout `examples/read-escrow.ts` reads: two fields. */
const ReadEscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.u64() })
/** The layout `examples/extension-consumer.ts` reads: three fields. */
const ConsumerEscrowBcs = suiBcs.struct("Escrow", {
  id: suiBcs.Address,
  owner: suiBcs.Address,
  amount: suiBcs.u64()
})

const coin = {
  objectId: PADDED("c01"),
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PKG}::coin::Coin<${PKG}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const env = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    SUI_NETWORK: "localnet",
    SUI_PRIVATE_KEY: keypair.getSecretKey(),
    ESCROW_ID
  })
)

describe("examples/read-escrow.ts", () => {
  test("reads the escrow and the chain time against the fake", async () => {
    const script = {
      clockTimestampMs: 1_700_000_000_000n,
      objects: [
        {
          objectId: ESCROW_ID,
          type: `${PKG}::escrow::Escrow`,
          version: 3n,
          owner,
          content: ReadEscrowBcs.serialize({ id: ESCROW_ID, amount: "42" }).toBytes()
        }
      ]
    }
    const lines = await Effect.runPromise(
      readProgram.pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.provide(
          Layer.mergeAll(layerTest(script), TestConsole.layer, env).pipe(Layer.provide(env))
        )
      )
    )
    expect(lines).toHaveLength(1)
    expect(String(lines[0])).toContain("holds 42")
  })
})

describe("examples/extension-consumer.ts", () => {
  const script = {
    objects: [
      {
        objectId: ESCROW_ID,
        type: `${PKG}::escrow::Escrow`,
        version: 3n,
        owner,
        content: ConsumerEscrowBcs.serialize({ id: ESCROW_ID, owner: SENDER, amount: "7" }).toBytes()
      }
    ],
    coins: [coin],
    execute: [
      FakeOutcome.succeed({
        created: [{ objectId: RECEIPT_ID, type: `${PKG}::escrow::Receipt`, version: 4n, owner }],
        mutated: [{ objectId: ESCROW_ID, type: `${PKG}::escrow::Escrow`, version: 4n, owner }]
      })
    ]
  }

  test("the Effect consumer claims through the extension inside a script", async () => {
    const lines: Array<string> = []
    const code = await Script.run(
      // The default journal is process-wide, so a test that submits provides
      // its own and its entries cannot be seen by the next one.
      consumerProgram.pipe(Effect.provide(Layer.mergeAll(Escrow.layer, env, Journal.layerMemory))),
      {
        layer: Script.layerNoDeps.pipe(
          Layer.provideMerge(layerTest(script)),
          Layer.provide(env)
        ),
        exit: () => {},
        stderr: (line) => lines.push(line),
        signals: { on: () => {} }
      }
    )
    expect(lines).toEqual([])
    expect(code).toBe(0)
  })

  test("the Promise consumer reads through $extend with no Effect in sight", async () => {
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer(script), { local: true })
    )
    expect(await readWithPromises(fake.client, ESCROW_ID)).toBe(7n)
  })
})

/** The note `examples/compare-read.*` read: a `u64` dynamic field keyed by index 0. */
const NOTE_FIELD_ID = PADDED("f001")
const NOTE_NAME = { type: "u64", bcs: suiBcs.u64().serialize(0).toBytes() }
const noteEntry: SuiClientTypes.DynamicFieldEntry = {
  fieldId: NOTE_FIELD_ID,
  type: "0x2::dynamic_field::Field<u64, u64>",
  name: NOTE_NAME,
  valueType: "u64",
  $kind: "DynamicField"
}

describe("examples/compare-read.sdk.ts and examples/compare-read.effect.ts", () => {
  const escrowObject = {
    objectId: ESCROW_ID,
    type: `${PKG}::escrow::Escrow`,
    version: 3n,
    owner,
    content: ReadEscrowBcs.serialize({ id: ESCROW_ID, amount: "42" }).toBytes()
  }
  const withNote = {
    objects: [escrowObject],
    dynamicFields: { [ESCROW_ID]: [noteEntry] },
    dynamicFieldValues: { [NOTE_FIELD_ID]: { type: "u64", bcs: suiBcs.u64().serialize("99").toBytes() } }
  }
  const withoutNote = { objects: [escrowObject] }

  test("the SDK version reads the escrow and its note directly off the fake client", async () => {
    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(withNote), { local: true }))
    expect(await readEscrow(fake.client, ESCROW_ID)).toEqual({ id: ESCROW_ID, amount: "42", note: "99" })
  })

  test("the SDK version has no note when none is set", async () => {
    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(withoutNote), { local: true }))
    expect((await readEscrow(fake.client, ESCROW_ID)).note).toBeUndefined()
  })

  test("the SDK version reports a missing escrow distinctly from a wrong type", async () => {
    const missing = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer({}), { local: true }))
    await expect(readEscrow(missing.client, ESCROW_ID)).rejects.toThrow("does not exist")

    const wrongType = Effect.runSync(
      Effect.provide(
        SuiCoreFake,
        SuiCoreFake.layer({ objects: [{ ...escrowObject, type: `${PKG}::escrow::Other` }] }),
        { local: true }
      )
    )
    await expect(readEscrow(wrongType.client, ESCROW_ID)).rejects.toThrow("not")
  })

  test("the sui-effect version prints the same fields, with and without a note", async () => {
    const withNoteLines = await Effect.runPromise(
      compareReadProgram.pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.provide(Layer.mergeAll(layerTest(withNote), TestConsole.layer, env).pipe(Layer.provide(env)))
      )
    )
    expect(String(withNoteLines[0])).toContain("holds 42, note: 99")

    const withoutNoteLines = await Effect.runPromise(
      compareReadProgram.pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.provide(Layer.mergeAll(layerTest(withoutNote), TestConsole.layer, env).pipe(Layer.provide(env)))
      )
    )
    expect(String(withoutNoteLines[0])).toContain("holds 42, note: none")
  })
})

describe("examples/compare-write.sdk.ts and examples/compare-write.effect.ts", () => {
  const script = {
    objects: [
      {
        objectId: ESCROW_ID,
        type: `${PKG}::escrow::Escrow`,
        version: 3n,
        owner,
        content: ReadEscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
      }
    ],
    coins: [coin],
    execute: [
      FakeOutcome.succeed({
        created: [{ objectId: RECEIPT_ID, type: `${PKG}::escrow::Receipt`, version: 4n, owner }],
        mutated: [{ objectId: ESCROW_ID, type: `${PKG}::escrow::Escrow`, version: 4n, owner }]
      })
    ]
  }

  test("the SDK version claims the escrow directly against the fake client", async () => {
    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(script), { local: true }))
    expect(await claimEscrow(fake.client, ESCROW_ID, keypair)).toBe(RECEIPT_ID)
  })

  test("the sui-effect version claims the escrow inside a script", async () => {
    const lines: Array<string> = []
    const code = await Script.run(
      // The default journal is process-wide, so a test that submits provides
      // its own and its entries cannot be seen by the next one.
      compareWriteProgram.pipe(Effect.provide(Layer.merge(env, Journal.layerMemory))),
      {
        layer: Script.layerNoDeps.pipe(Layer.provideMerge(layerTest(script)), Layer.provide(env)),
        exit: () => {},
        stderr: (line) => lines.push(line),
        signals: { on: () => {} }
      }
    )
    expect(lines).toEqual([])
    expect(code).toBe(0)
  })
})

describe("README.md", () => {
  /** The slice of a file between two anchor lines, inclusive. */
  const slice = (text: string, first: string, last: string): string => {
    const lines = text.split("\n")
    const start = lines.findIndex((line) => line === first)
    const offset = lines.slice(start).findIndex((line) => line === last)
    expect(start).toBeGreaterThan(-1)
    expect(offset).toBeGreaterThan(-1)
    return lines.slice(start, start + offset + 1).join("\n")
  }

  const readme = readFileSync("README.md", "utf8")
  const example = readFileSync("examples/script-claim.ts", "utf8")

  test("the script example is the one in examples/script-claim.ts", () => {
    const program = slice(example, "export const program = Effect.gen(function*() {", "})")
    expect(readme).toContain(program)
    const schema = slice(example, "const Escrow = SuiSchema.bcs(", ")")
    expect(readme).toContain(schema)
  })

  const compareFiles = [
    "compare-read.sdk.ts",
    "compare-read.effect.ts",
    "compare-write.sdk.ts",
    "compare-write.effect.ts"
  ]

  for (const name of compareFiles) {
    test(`the "Side by side" section quotes examples/${name} verbatim`, () => {
      const content = readFileSync(`examples/${name}`, "utf8")
      expect(readme).toContain(content.trimEnd())
    })
  }
})
