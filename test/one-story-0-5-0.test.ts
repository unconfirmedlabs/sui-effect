/**
 * One prepare → verify → approve story across signer kinds (0.5.0, DESIGN
 * §18): `Enoki.run` on the same front half and lock rule as `Tx.run`, a
 * sponsor backend that signs sender-built bytes (`Tx.run` with
 * `Signer.remote`), and one that builds them (`Tx.fromBytes` →
 * `Tx.verifySponsored` → `Tx.prepare` → approve → `Tx.sign` → `Tx.attach` →
 * `Tx.submit`). All on `layerTest` with a fake Enoki client.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { fromBase64, toBase64 } from "@mysten/sui/utils"
import { Effect, Layer, Option, Schema, Tracer } from "effect"
import { TestClock } from "effect/testing"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Enoki, type EnokiClient } from "../src/enoki.ts"
import { Gate } from "../src/services/Gate.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair, remote } from "../src/services/Signer.ts"
import { verifySponsored } from "../src/services/Sponsored.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { type Prepared, Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`

const senderKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(61))
const sponsorKey = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(62))
const signer = fromKeypair(senderKey)
const SENDER = signer.address
const SPONSOR = SuiAddress.make(sponsorKey.toSuiAddress())
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

/** Pins nothing of the sender's: a pure input only. */
const ping = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::demo::ping`, arguments: [tx.pure.u64(1n)] })
}

/** Pins one owned object of the sender's. */
const claim = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::escrow::claim`, arguments: [tx.object(ESCROW_ID)] })
}

/** What a sponsor does with kind bytes: sender, gas owner, address-balance gas, expiration. */
const sponsorBytes = (kind: Uint8Array, sender: string) => {
  const tx = Transaction.fromKind(kind)
  tx.setSender(sender)
  tx.setGasOwner(SPONSOR)
  tx.setGasPayment([])
  tx.setGasBudget(1_000_000)
  tx.setGasPrice(1_000)
  tx.setExpiration({
    ValidDuring: { minEpoch: "100", maxEpoch: "101", minTimestamp: null, maxTimestamp: null, chain: CHAIN_ID, nonce: 1 }
  })
  return tx.build()
}

interface FakeEnoki extends EnokiClient {
  readonly created: Array<string>
  readonly executed: Array<{ digest: string; signature: string }>
}

const fakeEnoki = (): FakeEnoki => {
  const created: Array<string> = []
  const executed: Array<{ digest: string; signature: string }> = []
  return {
    created,
    executed,
    createSponsoredTransaction: async (input) => {
      created.push(input.transactionKindBytes)
      const bytes = await sponsorBytes(fromBase64(input.transactionKindBytes), input.sender!)
      return { bytes: toBase64(bytes), digest: TransactionDataBuilder.getDigestFromBytes(bytes) }
    },
    executeSponsoredTransaction: async (input) => {
      executed.push(input)
      return { digest: input.digest }
    }
  }
}

const sponsorFunded = {
  owner: SPONSOR,
  coinType: "0x2::sui::SUI",
  balance: "5000000000",
  coinBalance: "0",
  addressBalance: "5000000000"
}

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner, content: new Uint8Array() }],
  balances: [sponsorFunded],
  simulate: [FakeOutcome.succeed()],
  getTransaction: [FakeOutcome.succeed()]
}

const recording = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { tracer, attribute: (name: string, key: string) => spans.find((span) => span.name === name)?.attributes.get(key) }
}

const run = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>, script: FakeScript = baseScript) => {
  const { tracer, attribute } = recording()
  return Effect.runPromise(
    Effect.provide(
      Effect.withTracer(effect, tracer),
      Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory),
      { local: true }
    )
  ).then((value) => ({ value, attribute }))
}

class UserRejected extends Schema.TaggedError<UserRejected>()("UserRejected", {}) {}

describe("Tx.verifySponsored", () => {
  test("is on the Tx namespace, and is the flat export", () => {
    expect(Tx.verifySponsored).toBe(verifySponsored)
  })
})

describe("Enoki.run", () => {
  test("sponsor → prepare → approve → sign → execute, through the journal", async () => {
    const enoki = fakeEnoki()
    let seen: Prepared | undefined
    const { value, attribute } = await run(Effect.gen(function*() {
      const executed = yield* Enoki.run(enoki, ping, {
        signer,
        approve: (prepared) => Effect.sync(() => (seen = prepared))
      })
      return { executed, entry: yield* (yield* Journal).get(executed.digest) }
    }))
    expect(seen?.built.sender).toBe(SENDER)
    expect(seen?.built.gas.owner).toBe(SPONSOR)
    expect(seen?.simulation).toBeDefined()
    expect(enoki.executed).toHaveLength(1)
    expect(enoki.executed[0]!.digest).toBe(value.executed.digest)
    expect(value.executed.sender).toBe(SENDER)
    expect(Option.isSome(value.entry) && value.entry.value._tag).toBe("Executed")
    // Nothing of the sender's is pinned: the lock covered the sponsor request only.
    expect(attribute("Enoki.run", "sui.sender_lock")).toBe("build")
  })

  test("bytes that pin the sender's object hold the lock through execution", async () => {
    const { attribute } = await run(Enoki.run(fakeEnoki(), claim, { signer }))
    expect(attribute("Enoki.run", "sui.sender_lock")).toBe("held")
  })

  test("lockSender: always holds it whatever the bytes pin, never takes none", async () => {
    const always = await run(Enoki.run(fakeEnoki(), ping, { signer }).pipe(SubmitConfig.with({ lockSender: "always" })))
    expect(always.attribute("Enoki.run", "sui.sender_lock")).toBe("held")
    const never = await run(Enoki.run(fakeEnoki(), ping, { signer }).pipe(SubmitConfig.with({ lockSender: "never" })))
    expect(never.attribute("Enoki.run", "sui.sender_lock")).toBe("none")
  })

  test("a refusal signs nothing, calls nothing and journals nothing", async () => {
    const enoki = fakeEnoki()
    const { value } = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Enoki.run(enoki, ping, { signer, approve: () => Effect.fail(new UserRejected()) }))
      return { error, unresolved: yield* (yield* Journal).listUnresolved }
    }))
    expect(value.error._tag).toBe("UserRejected")
    expect(enoki.created).toHaveLength(1)
    expect(enoki.executed).toHaveLength(0)
    expect(value.unresolved).toHaveLength(0)
  })

  test("an intent is verified against the simulation and its Verified is what is signed", async () => {
    let seen: Prepared | undefined
    await run(Enoki.run(fakeEnoki(), ping, {
      signer,
      intent: { summary: "Ping the demo module.", author: "user", claims: { outflows: [], recipients: [], objects: [] } },
      approve: (prepared) => Effect.sync(() => (seen = prepared))
    }))
    expect(seen?.verified?.verdict._tag).toBe("Unscreened")
  })

  test("Gate.requireIntent refuses a run without one before Enoki is asked", async () => {
    const enoki = fakeEnoki()
    const { value } = await run(
      Effect.flip(Enoki.run(enoki, ping, { signer })).pipe(Gate.with({ requireIntent: true }))
    )
    expect(value._tag).toBe("PolicyDenied")
    expect(enoki.created).toHaveLength(0)
  })
})

describe("a sponsor backend of one's own", () => {
  test("that signs sender-built bytes: Tx.run({ gasOwner, sponsor: Signer.remote }) with approve", async () => {
    const asked: Array<Uint8Array> = []
    const backend = remote({
      address: SPONSOR,
      scheme: "ED25519",
      signTransaction: (bytes) =>
        Effect.promise(async () => {
          asked.push(bytes)
          return (await sponsorKey.signTransaction(bytes)).signature
        })
    })
    let seen: Prepared | undefined
    const { value } = await run(
      Tx.run(Tx.sponsored({ sender: SENDER, gasOwner: SPONSOR })(ping), {
        signer,
        sponsor: backend,
        approve: (prepared) => Effect.sync(() => (seen = prepared))
      }),
      { ...baseScript, execute: [FakeOutcome.succeed()] }
    )
    expect(seen?.built.gas.owner).toBe(SPONSOR)
    expect(asked).toHaveLength(1)
    expect(value.sender).toBe(SENDER)
  })

  test("that builds: fromBytes → verifySponsored → prepare → approve → sign → attach → submit", async () => {
    const kind = await (() => {
      const tx = new Transaction()
      ping(tx)
      return tx.build({ onlyTransactionKind: true })
    })()
    const { value } = await run(
      Effect.gen(function*() {
        // The backend: assembles the sponsored bytes and signs them as gas owner.
        const bytes = yield* Effect.promise(() => sponsorBytes(kind, SENDER))
        const sponsorSignature = (yield* Effect.promise(() => sponsorKey.signTransaction(bytes))).signature
        // The wallet: the same front half as Tx.run, then its own signature.
        const built = yield* Tx.verifySponsored(yield* Tx.fromBytes(bytes), {
          sender: SENDER,
          gasOwner: SPONSOR,
          transactionKind: kind
        })
        const prepared = yield* Tx.prepare(built, { sender: SENDER })
        yield* Effect.void // approve(prepared) goes here
        const signed = yield* Tx.attach(yield* Tx.sign(prepared.built, signer), sponsorSignature)
        const executed = yield* Tx.submit(signed)
        return { signed, executed, simulates: (yield* SuiTest.calls("simulateTransaction")).length }
      }),
      { ...baseScript, execute: [FakeOutcome.succeed()] }
    )
    expect(value.signed.signatures).toHaveLength(2)
    expect(value.executed.digest).toBe(value.signed.digest)
    expect(value.simulates).toBe(1)
  })
})
