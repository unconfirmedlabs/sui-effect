/**
 * The 0.4.0 lifecycle batch (issue #4, WP2): refusals settle the journal, a
 * refusal after an ambiguous send reconciles, coin-reservation refs are not
 * evidence, the build's resolver is retried, and the reconcile unions carry no
 * tag they never produce. Plus the cheap coverage gaps of item 2.10.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { toBase58 } from "@mysten/sui/utils"
import { Clock, Deferred, Duration, Effect, Fiber, Layer, Logger, Option, References, Schema } from "effect"
import { TestClock } from "effect/testing"
import { type NotApplied, type SubmissionUnknown, SuiError, type TransportError } from "../src/domain/errors.ts"
import { Digest, Nonce, NotAppliedEvidence, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import type { SuiCoreService } from "../src/services/SuiCore.ts"
import { makeFromClient, readSchedule, SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { type Signed, Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`
const COIN_ID = PADDED("c01")
/** The id a coin reservation ref carries: there is no object behind it. */
const RESERVATION_ID = PADDED("5e5e")

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9)))

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const escrow = {
  objectId: ESCROW_ID,
  type: ESCROW_TYPE,
  version: 3n,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
}

const coin = {
  objectId: COIN_ID,
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const coinObject = { objectId: COIN_ID, type: coin.type, version: 2n, owner, content: new Uint8Array() }

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: 1_700_000_000_000n,
  objects: [escrow],
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
  mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }]
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript,
  extra?: Layer.Layer<never>
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      extra === undefined
        ? Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory)
        : Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory, extra),
      { local: true }
    )
  )

describe("2.1 a node refusal settles the journal entry", () => {
  test("Tx.submit: INVALID_ARGUMENT escapes as itself and leaves NotApplied { refused }", async () => {
    const { error, entry, unresolved, settled } = await run(
      Effect.gen(function*() {
        const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: SENDER }), signer)
        const error = yield* Effect.flip(Tx.submit(signed))
        const journal = yield* Journal
        const entry = yield* journal.get(signed.digest)
        const unresolved = yield* journal.listUnresolved
        const settled = yield* Tx.reconcileAll()
        return { error, entry, unresolved, settled }
      }),
      { ...baseScript, execute: [FakeOutcome.transportError("INVALID_ARGUMENT")] }
    )
    // The error is unchanged: the node's own answer.
    expect(error._tag).toBe("TransportError")
    if (error._tag === "TransportError") expect(error.status).toBe("INVALID_ARGUMENT")
    // The journal no longer holds a `Signed` entry every startup reconciles.
    expect(Option.isSome(entry)).toBe(true)
    if (Option.isSome(entry)) {
      expect(entry.value._tag).toBe("NotApplied")
      if (entry.value._tag === "NotApplied") expect(entry.value.evidence).toBe("refused")
    }
    expect(unresolved).toHaveLength(0)
    expect(settled).toHaveLength(0)
  })

  test("Tx.submitVia: a sender error declaring not_applied settles the entry too", async () => {
    class RelayRefused extends Schema.TaggedError<RelayRefused>()("RelayRefused", {}) {
      readonly outcome = "not_applied" as const
    }
    const { error, entry } = await run(
      Effect.gen(function*() {
        const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: SENDER }), signer)
        const error = yield* Effect.flip(Tx.submitVia(signed, () => Effect.fail(new RelayRefused())))
        const entry = yield* (yield* Journal).get(signed.digest)
        return { error, entry }
      })
    )
    expect(error._tag).toBe("RelayRefused")
    expect(Option.isSome(entry) && entry.value._tag).toBe("NotApplied")
    if (Option.isSome(entry) && entry.value._tag === "NotApplied") {
      expect(entry.value.evidence).toBe("refused")
    }
  })

  test("\"refused\" is one of the NotApplied evidence values", () => {
    expect(Schema.is(NotAppliedEvidence)("refused")).toBe(true)
  })
})

describe("2.2 a refusal after an ambiguous send reconciles", () => {
  test("a timeout, then INVALID_ARGUMENT, is SubmissionUnknown, not TransportError", async () => {
    const error = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }).pipe(Effect.flip))
        yield* TestClock.adjust("1 minute")
        return yield* Fiber.join(fiber)
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(false), FakeOutcome.transportError("INVALID_ARGUMENT")],
        getTransaction: [FakeOutcome.notFound()]
      },
      SubmitConfig.layer({ resubmitAttempts: 2, executeTimeout: Duration.seconds(5) })
    )
    // The first send may be on chain: "not applied, safe to retry" would
    // invite a second execution.
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.outcome(error)).toBe("unknown")
  })
})

describe("2.3 coin-reservation refs are not pinned objects", () => {
  /** A ref shaped the way the SDK's `createCoinReservationRef` shapes one. */
  const reservationRef = () => {
    const digest = new Uint8Array(32)
    new DataView(digest.buffer).setBigUint64(0, 1_000n, true)
    digest.fill(0xac, 12)
    return { objectId: RESERVATION_ID, version: "0", digest: toBase58(digest) }
  }

  test("reconcile reads the real gas coin and never the reservation", async () => {
    const { error, objectReads } = await run(
      Effect.gen(function*() {
        const tx = new Transaction()
        tx.moveCall({ target: `${PADDED("2")}::escrow::noop`, arguments: [tx.pure.u64(1n)] })
        tx.setSender(SENDER)
        tx.setGasPrice(1_000)
        tx.setGasBudget(10_000_000)
        tx.setGasPayment([reservationRef(), { objectId: COIN_ID, version: "2", digest: coin.digest }])
        const bytes = yield* Effect.promise(() => tx.build())
        const signed: Signed = {
          digest: Digest.make(yield* Effect.promise(() => tx.getDigest())),
          bytes,
          signatures: [yield* signer.signTransaction(bytes)],
          sender: SENDER
        }
        const error = yield* Effect.flip(Tx.reconcile(signed))
        const objectReads = (yield* SuiTest.calls())
          .filter((call) => call.method === "getObject")
          .map((call) => (call.options as { objectId: string }).objectId)
        return { error, objectReads }
      }),
      { ...baseScript, objects: [escrow, coinObject], getTransaction: [FakeOutcome.notFound()] }
    )
    expect(objectReads).toEqual([COIN_ID])
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.describe(error)).not.toContain(RESERVATION_ID)
  })
})

describe("2.4 the build's resolver is retried", () => {
  test("a retryable failure inside the resolver is retried, and the build succeeds", async () => {
    const { built, resolverSimulates } = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.build(claim, { sender: SENDER }))
        yield* TestClock.adjust("1 minute")
        const built = yield* Fiber.join(fiber)
        const resolverSimulates = (yield* SuiTest.calls())
          .filter((call) => call.method === "simulateTransaction" && (call.options as { resolver?: boolean }).resolver === true).length
        return { built, resolverSimulates }
      }),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed({})] }
    )
    expect(built.bytes.length).toBeGreaterThan(0)
    expect(resolverSimulates).toBe(2)
  })

  test("it gives up after five attempts with the TransportError", async () => {
    const { error, resolverSimulates } = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.flip(Tx.build(claim, { sender: SENDER })))
        yield* TestClock.adjust("5 minutes")
        const error = yield* Fiber.join(fiber)
        const resolverSimulates = (yield* SuiTest.calls())
          .filter((call) => call.method === "simulateTransaction" && (call.options as { resolver?: boolean }).resolver === true).length
        return { error, resolverSimulates }
      }),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("UNAVAILABLE")] }
    )
    expect(error._tag).toBe("TransportError")
    expect(resolverSimulates).toBe(5)
  })
})

describe("2.6 the reconcile unions carry no tag they never produce", () => {
  test("TransportError is not in Tx.reconcile's or Tx.reconcileAll's error type", () => {
    type ReconcileError = Effect.Error<ReturnType<typeof Tx.reconcile>>
    type ReconcileAllError = Effect.Error<ReturnType<typeof Tx.reconcileAll>>
    const reconcileHasNone: [Extract<ReconcileError, TransportError>] extends [never] ? true : false = true
    const reconcileAllHasNone: [Extract<ReconcileAllError, TransportError>] extends [never] ? true : false = true
    // And what they do declare is still there.
    const keeps: [Extract<ReconcileError, NotApplied | SubmissionUnknown>] extends [never] ? false : true = true
    expect([reconcileHasNone, reconcileAllHasNone, keeps]).toEqual([true, true, true])
  })
})

describe("2.9 Nonce is the public u32 schema SubmitConfig.nonce is checked against", () => {
  test("it accepts a u32 and refuses anything else", () => {
    const is = Schema.is(Nonce)
    expect(is(0)).toBe(true)
    expect(is(4_294_967_295)).toBe(true)
    expect(is(4_294_967_296)).toBe(false)
    expect(is(-1)).toBe(false)
    expect(is(1.5)).toBe(false)
  })
})

describe("2.10 coverage that was missing", () => {
  test("a read is attempted exactly five times, then fails", async () => {
    const { error, reads } = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const fiber = yield* Effect.forkChild(Effect.flip(sui.core.getObject({ objectId: ESCROW_ID })))
        yield* TestClock.adjust("5 minutes")
        const error = yield* Fiber.join(fiber)
        const reads = (yield* SuiTest.calls()).filter((call) => call.method === "getObject").length
        return { error, reads }
      }),
      { ...baseScript, getObject: [FakeOutcome.transportError("UNAVAILABLE")] }
    )
    expect(error._tag).toBe("TransportError")
    expect(reads).toBe(5)
  })

  test("the read schedule doubles from 250ms, caps at 10s, and jitters within 0.8x to 1.2x", async () => {
    const gaps = await Effect.runPromise(
      Effect.gen(function*() {
        const times: Array<number> = []
        const attempt = Effect.flatMap(Clock.currentTimeMillis, (now) => {
          times.push(now)
          return Effect.fail("again" as const)
        })
        const fiber = yield* Effect.forkChild(
          Effect.ignore(Effect.retry(attempt, { schedule: readSchedule, times: 8 }))
        )
        yield* TestClock.adjust("10 minutes")
        yield* Fiber.join(fiber)
        return times.slice(1).map((time, index) => time - times[index]!)
      }).pipe(Effect.provide(TestClock.layer()))
    )
    const bases = [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]
    expect(gaps).toHaveLength(bases.length)
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(bases[index]! * 0.8)
      expect(gap).toBeLessThanOrEqual(bases[index]! * 1.2)
    })
  })

  test("Tx.run interrupted mid-execute releases the lock and leaves Signed", async () => {
    const { unresolved, second } = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const first = yield* Effect.forkChild(Tx.run(claim, { signer }))
        // Until the execute is in flight: it never answers on its own.
        for (let i = 0; i < 1_000; i++) {
          if ((yield* fake.calls).some((call) => call.method === "executeTransaction")) break
          yield* Effect.yieldNow
        }
        yield* Fiber.interrupt(first)
        const unresolved = yield* (yield* Journal).listUnresolved
        // The same sender again: it would block forever if the lock were held.
        const second = yield* Tx.run(claim, { signer })
        return { unresolved, second }
      }),
      { ...baseScript, execute: [FakeOutcome.timeoutThen(false), executed] },
      SubmitConfig.layer({ executeTimeout: Duration.hours(1) })
    )
    expect(unresolved.map((entry) => entry._tag)).toEqual(["Signed"])
    expect(second.created(RECEIPT_TYPE)).toHaveLength(1)
  })

  test("withSenderLock is keyed by the normalized address", async () => {
    // A shorthand spelling only becomes a `SuiAddress` through `normalize`;
    // the lock also normalizes its key, so a non-canonical brand (an
    // upper-case `make`) shares the lock too (release-0-4-0-review.test.ts).
    const short = SuiAddress.normalize("0x2")
    const padded = SuiAddress.make(PADDED("2"))
    expect(short).toBe(padded)
    const { sameBlocked, otherRan } = await run(
      Effect.gen(function*() {
        const release = yield* Deferred.make<void>()
        const holder = yield* Effect.forkChild(Tx.withSenderLock(short)(Deferred.await(release)))
        yield* Effect.yieldNow
        // A different address is not serialized behind the holder...
        const otherRan = yield* Tx.withSenderLock(sponsor.address)(Effect.succeed(true))
        // ...the same address, spelled either way, is.
        const same = yield* Effect.forkChild(Tx.withSenderLock(padded)(Effect.succeed(true)))
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow
        const sameBlocked = same.pollUnsafe() === undefined
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        yield* Fiber.join(same)
        return { sameBlocked, otherRan }
      })
    )
    expect(otherRan).toBe(true)
    expect(sameBlocked).toBe(true)
  })

  const hungRun = (extra: Layer.Layer<never>, minimum?: "Debug") => {
    const state = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ ...baseScript, execute: [executed] }), { local: true })
    )
    const real = makeFromClient(state.client)
    const hung: SuiCoreService = { ...real, waitForTransaction: () => Effect.never }
    const program = Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }))
      yield* TestClock.adjust("5 seconds")
      return yield* Fiber.join(fiber)
    })
    return Effect.runPromise(
      (minimum === undefined ? program : program.pipe(Effect.provideService(References.MinimumLogLevel, minimum))).pipe(
        Effect.provide(
          Layer.mergeAll(
            Sui.layerNoDeps.pipe(Layer.provideMerge(Layer.succeed(SuiCore, hung))),
            TestClock.layer(),
            Journal.layerMemory,
            SubmitConfig.layer({ visibilityTimeout: Duration.seconds(5) }),
            extra
          ),
          { local: true }
        )
      )
    )
  }

  test("visibilityTimeout bounds a hung waitForTransaction, and the outcome stands", async () => {
    const logged: Array<string> = []
    const result = await hungRun(
      Logger.layer([Logger.map(Logger.formatLogFmt, (line) => logged.push(line))]),
      "Debug"
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
    // 0.5.0: at debug level, printed only when the program asks for it.
    expect(logged.join("\n")).toContain("did not become visible to reads")
    expect(logged.join("\n")).toContain("level=DEBUG")
  })

  test("a timed-out visibility wait writes nothing to stdout under the default logger (finding 6)", async () => {
    const original = console.log
    const printed: Array<unknown> = []
    console.log = (...args: Array<unknown>) => {
      printed.push(args)
    }
    try {
      const result = await hungRun(Layer.empty)
      expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
    } finally {
      console.log = original
    }
    expect(printed).toEqual([])
  })
})
