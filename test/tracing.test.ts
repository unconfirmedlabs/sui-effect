/**
 * NB6: a span that says `SuiCore.getObject` and nothing else cannot be joined
 * to a digest, an object or a sender, which is the whole point of tracing a
 * submission. Every call a trace has to be joined on now annotates its own
 * span, and this is the proof: a recording tracer collects the spans and the
 * attributes are read back off them.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { Effect, Fiber, Layer, Schedule, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { Duration } from "effect"
import { ObjectId } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import { Sui as SuiTag } from "../src/services/Sui.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3)))
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: signer.address }

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })

const coin = {
  objectId: PADDED("c01"),
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  objects: [{
    objectId: ESCROW_ID,
    type: ESCROW_TYPE,
    version: 3n,
    owner,
    content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
  }],
  coins: [coin]
}

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

const executed = FakeOutcome.succeed({
  created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
  mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, inputVersion: 3n, owner }]
})

/** Every span the effect made, with the attributes it ended up carrying. */
const recording = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const attributesOf = (name: string): ReadonlyArray<ReadonlyMap<string, unknown>> =>
    spans.filter((span) => span.name === name).map((span) => span.attributes)
  return { tracer, attributesOf }
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript,
  extra?: Layer.Layer<never>
) => {
  const { attributesOf, tracer } = recording()
  const layers = extra === undefined
    ? Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory)
    : Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory, extra)
  return Effect.runPromise(
    Effect.provide(Effect.withTracer(effect, tracer), layers, { local: true })
  ).then((value) => ({ value, attributesOf }))
}

describe("span attributes", () => {
  test("SuiCore.getObject carries the object id and the network", async () => {
    const { attributesOf } = await run(
      Effect.gen(function*() {
        const sui = yield* SuiTag
        return yield* sui.getObject(ObjectId.make(ESCROW_ID))
      })
    )
    const [attributes] = attributesOf("SuiCore.getObject")
    expect(attributes?.get("sui.object_id")).toBe(ESCROW_ID)
    expect(attributes?.get("sui.network")).toBe("localnet")
  })

  test("SuiCore.getObjects carries the count", async () => {
    const { attributesOf } = await run(
      Effect.gen(function*() {
        const sui = yield* SuiTag
        return yield* sui.getObjects([ObjectId.make(ESCROW_ID)])
      })
    )
    expect(attributesOf("SuiCore.getObjects")[0]?.get("sui.object_count")).toBe(1)
  })

  test("Tx.build carries the sender, and Tx.sign the digest", async () => {
    const { attributesOf, value } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: signer.address })
        return yield* Tx.sign(built, signer)
      })
    )
    expect(attributesOf("Tx.build")[0]?.get("sui.sender")).toBe(signer.address)
    expect(attributesOf("Tx.sign")[0]?.get("sui.digest")).toBe(value.digest)
    expect(attributesOf("Tx.sign")[0]?.get("sui.signer")).toBe(signer.address)
  })

  test("Tx.submit carries the digest, and the attempt number under a retry", async () => {
    const { attributesOf } = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }))
        yield* TestClock.adjust("1 minute")
        return yield* Fiber.join(fiber)
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE"), executed]
      },
      SubmitConfig.layer({
        resubmit: Schedule.spaced("1 second"),
        resubmitAttempts: 3,
        executeTimeout: Duration.seconds(5)
      })
    )
    const [submit] = attributesOf("Tx.submit")
    expect(typeof submit?.get("sui.digest")).toBe("string")
    // Two sends, so the last value the span saw is attempt 2.
    expect(submit?.get("sui.attempt")).toBe(2)
    // And the sender lock names the address it serialized on.
    expect(attributesOf("Sui.withSenderLock")[0]?.get("sui.sender")).toBe(signer.address)
  })
})
