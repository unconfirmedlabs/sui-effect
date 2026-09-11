import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { ConfigProvider, Effect, Layer } from "effect"
import { program } from "../examples/script-claim.ts"
import { Script } from "../src/script.ts"
import { FakeOutcome } from "../src/services/SuiCoreFake.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const PKG = PADDED("2")
const ESCROW_ID = PADDED("e5c0")
const RECEIPT_ID = PADDED("7ece17")

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11))
const SENDER = keypair.toSuiAddress()
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.u64() })

const script = {
  chainId: CHAIN_ID,
  objects: [
    {
      objectId: ESCROW_ID,
      type: `${PKG}::escrow::Escrow`,
      version: 3n,
      owner,
      content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
    }
  ],
  coins: [
    {
      objectId: PADDED("c01"),
      version: "2",
      digest: "11111111111111111111111111111111",
      type: `${PKG}::coin::Coin<${PKG}::sui::SUI>`,
      balance: "1000000000",
      owner,
      previousTransaction: null
    } as unknown as SuiClientTypes.Coin
  ],
  execute: [
    FakeOutcome.succeed({
      created: [{ objectId: RECEIPT_ID, type: `${PKG}::escrow::Receipt`, version: 4n, owner }],
      mutated: [{ objectId: ESCROW_ID, type: `${PKG}::escrow::Escrow`, version: 4n, owner }]
    })
  ]
}

const env = ConfigProvider.layer(
  ConfigProvider.fromEnvRecord({
    SUI_NETWORK: "localnet",
    SUI_PRIVATE_KEY: keypair.getSecretKey(),
    ESCROW_ID
  })
)

describe("examples/script-claim.ts", () => {
  test("claims the escrow against the fake and prints the receipt id", async () => {
    const lines: Array<string> = []
    const codes: Array<number> = []
    const code = await Script.run(program.pipe(Effect.provide(env)), {
      layer: Script.layerNoDeps.pipe(Layer.provideMerge(layerTest(script)), Layer.provide(env)),
      exit: (value) => codes.push(value),
      stderr: (line) => lines.push(line),
      signals: { on: () => {} }
    })
    expect(lines).toEqual([])
    expect(code).toBe(0)
    expect(codes).toEqual([0])
  })

  test("a missing ESCROW_ID is a configuration failure, exit 2", async () => {
    const lines: Array<string> = []
    const withoutEscrow = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SUI_NETWORK: "localnet",
        SUI_PRIVATE_KEY: keypair.getSecretKey()
      })
    )
    const code = await Script.run(program.pipe(Effect.provide(withoutEscrow)), {
      layer: Script.layerNoDeps.pipe(
        Layer.provideMerge(layerTest(script)),
        Layer.provide(withoutEscrow)
      ),
      exit: () => {},
      stderr: (line) => lines.push(line),
      signals: { on: () => {} }
    })
    expect(code).toBe(2)
  })
})
