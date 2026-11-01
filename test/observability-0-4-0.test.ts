/**
 * The 0.4.0 Effect-usage audit, observability half: which helpers have no span
 * of their own (#1), the metrics and their bounded attributes (#2), the span
 * attributes a trace of a submission is read for (#3), and `Tx.build`
 * retrying its resolver on the `SuiCore` read policy rather than a private
 * copy of it (#4).
 *
 * Every metric test runs under a fresh `Metric.MetricRegistry`, so no count
 * leaks between tests (the default registry is process-wide).
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Duration, Effect, Fiber, Layer, Logger, Metric, References, Result, Schedule, Tracer } from "effect"
import { TestClock } from "effect/testing"
import * as Metrics from "../src/domain/metrics.ts"
import { ObjectId } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import { Sui as SuiTag } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const ESCROW_ID = PADDED("e1")
const OTHER_ID = PADDED("e2")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(5)))
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

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: 1_700_000_000_000n,
  objects: [
    {
      objectId: ESCROW_ID,
      type: ESCROW_TYPE,
      version: 3n,
      owner,
      content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
    },
    {
      objectId: OTHER_ID,
      type: RECEIPT_TYPE,
      version: 3n,
      owner,
      content: EscrowBcs.serialize({ id: OTHER_ID, amount: "7" }).toBytes()
    }
  ],
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
  const names = () => spans.map((span) => span.name)
  const attributesOf = (name: string): ReadonlyArray<ReadonlyMap<string, unknown>> =>
    spans.filter((span) => span.name === name).map((span) => span.attributes)
  return { tracer, names, attributesOf }
}

/**
 * Runs the effect over the fake under a recording tracer and a fresh metric
 * registry, and hands back both.
 */
const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript = baseScript,
  extra?: Layer.Layer<never>
) => {
  const { attributesOf, names, tracer } = recording()
  const registry: Metric.MetricRegistry = new Map()
  const layers = extra === undefined
    ? Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory)
    : Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory, extra)
  return Effect.runPromise(
    Effect.provide(Effect.withTracer(effect, tracer), layers, { local: true }).pipe(
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  ).then((value) => ({ value, attributesOf, names, registry }))
}

/** A counter's count in a registry, under the given attributes. */
const countIn = (
  registry: Metric.MetricRegistry,
  counter: Metric.Counter<number>,
  attributes?: Metric.Metric.AttributeSet
): Promise<number> =>
  Effect.runPromise(
    Metric.value(attributes === undefined ? counter : Metric.withAttributes(counter, attributes)).pipe(
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  ).then((state) => Number(state.count))

/** How many observations a histogram holds in a registry, under the given attributes. */
const observationsIn = <I>(
  registry: Metric.MetricRegistry,
  histogram: Metric.Histogram<I>,
  attributes?: Metric.Metric.AttributeSet
): Promise<number> =>
  Effect.runPromise(
    Metric.value(attributes === undefined ? histogram : Metric.withAttributes(histogram, attributes)).pipe(
      Effect.provideService(Metric.MetricRegistry, registry)
    )
  ).then((state) => state.count)

/** Runs a `Tx.run` with the clock advanced, so retries and waits complete. */
const advanced = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake>, by: Duration.Input = "10 minutes") =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.result(effect))
    yield* TestClock.adjust(by)
    return yield* Fiber.join(fiber)
  })

describe("#1 per-item helpers carry no span of their own", () => {
  test("a batch read makes no span per object, and the page says how many failed to decode", async () => {
    const { attributesOf, names, value } = await run(
      Effect.gen(function*() {
        const sui = yield* SuiTag
        return yield* sui.getObjects([ObjectId.make(ESCROW_ID), ObjectId.make(OTHER_ID)], {
          expectedType: ESCROW_TYPE
        })
      })
    )
    expect(value.map(Result.isSuccess)).toEqual([true, false])
    expect(names()).not.toContain("Sui.decodeObject")
    const [page] = attributesOf("Sui.getObjectsPage")
    expect(page?.get("sui.decode_failures")).toBe(1)
    expect(page?.get("sui.object_count")).toBe(2)
    const [batch] = attributesOf("Sui.getObjects")
    expect(batch?.get("sui.object_count")).toBe(2)
    expect(batch?.get("sui.chunk_count")).toBe(1)
  })

  test("simulate keeps its public span and loses the nested ones", async () => {
    const { names } = await run(
      Effect.gen(function*() {
        const sui = yield* SuiTag
        return yield* sui.simulate(claim, { sender: signer.address })
      }),
      { ...baseScript, simulate: [FakeOutcome.succeed({})] }
    )
    expect(names()).toContain("Sui.simulate")
    expect(names()).toContain("SuiCore.simulateTransaction")
    expect(names()).not.toContain("Sui.simulateRaw")
    expect(names()).not.toContain("Sui.fromSimulationResult")
  })

  test("a reconcile keeps Tx.recover and Tx.inputEvidence, and drops the one-read wrappers", async () => {
    const { names } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [FakeOutcome.transportError("UNAVAILABLE")], getTransaction: [FakeOutcome.notFound()] },
      SubmitConfig.layer({ resubmit: Schedule.spaced("1 second"), resubmitAttempts: 1 })
    )
    expect(names()).toContain("Tx.recover")
    for (const gone of ["Tx.inputStateOf", "Tx.consumedVersionOf", "Tx.currentEpoch", "Tx.expiryClosed"]) {
      expect(names()).not.toContain(gone)
    }
    expect(names()).not.toContain("Executed.fromTransactionResult")
    expect(names()).not.toContain("Journal.put")
  })
})

describe("#2/#3 a successful Tx.run", () => {
  test("is counted, timed, and annotated", async () => {
    const { attributesOf, registry, value } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [executed] }
    )
    expect(Result.isSuccess(value)).toBe(true)

    expect(await countIn(registry, Metrics.executeAttempts)).toBe(1)
    expect(await countIn(registry, Metrics.submitResults, { result: "executed" })).toBe(1)
    expect(await observationsIn(registry, Metrics.buildDuration, { simulated_by: "sdk" })).toBe(1)
    expect(await observationsIn(registry, Metrics.buildGasBudget)).toBe(1)
    expect(await observationsIn(registry, Metrics.senderLockWait)).toBe(1)
    expect(await observationsIn(registry, Metrics.visibilityWait, { result: "visible" })).toBe(1)
    expect(await countIn(registry, Metrics.reconcileResults, { result: "executed" })).toBe(0)

    const [build] = attributesOf("Tx.build")
    expect(build?.get("sui.simulated_by")).toBe("sdk")
    expect(typeof build?.get("sui.gas_budget")).toBe("number")
    expect(typeof build?.get("sui.max_epoch")).toBe("number")
    expect(attributesOf("Tx.submit")[0]?.get("sui.outcome")).toBe("executed")
  })

  test("no metric is keyed by a digest, an address or an object id", async () => {
    const { registry } = await run(advanced(Tx.run(claim, { signer })), { ...baseScript, execute: [executed] })
    const snapshot = await Effect.runPromise(
      Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry))
    )
    expect(snapshot.length).toBeGreaterThan(0)
    for (const metric of snapshot) {
      expect(metric.id.startsWith("sui_effect_")).toBe(true)
      for (const value of Object.values(metric.attributes ?? {})) {
        expect(value).not.toMatch(/^0x[0-9a-f]{8,}/)
        expect(value.length).toBeLessThan(24)
      }
    }
  })
})

describe("#2/#3 sends that do not simply land", () => {
  test("a retried send counts every attempt", async () => {
    const { registry } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [FakeOutcome.transportError("UNAVAILABLE"), executed] },
      SubmitConfig.layer({
        resubmit: Schedule.spaced("1 second"),
        resubmitAttempts: 3,
        executeTimeout: Duration.seconds(5)
      })
    )
    expect(await countIn(registry, Metrics.executeAttempts)).toBe(2)
    expect(await countIn(registry, Metrics.submitResults, { result: "executed" })).toBe(1)
  })

  test("a refusal on the first send is refused, on the span and in the count", async () => {
    const { attributesOf, registry, value } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [FakeOutcome.transportError("INVALID_ARGUMENT")] }
    )
    expect(Result.isFailure(value)).toBe(true)
    expect(await countIn(registry, Metrics.submitResults, { result: "refused" })).toBe(1)
    const [submit] = attributesOf("Tx.submit")
    expect(submit?.get("sui.refused")).toBe(true)
    expect(submit?.get("sui.outcome")).toBe("refused")
  })

  test("a send that ends unknown is reconciled, and both answers are counted", async () => {
    const { attributesOf, registry } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [FakeOutcome.transportError("UNAVAILABLE")], getTransaction: [FakeOutcome.notFound()] },
      SubmitConfig.layer({ resubmit: Schedule.spaced("1 second"), resubmitAttempts: 1 })
    )
    expect(await countIn(registry, Metrics.reconcileResults, { result: "submission_unknown" })).toBe(1)
    expect(await countIn(registry, Metrics.submitResults, { result: "submission_unknown" })).toBe(1)
    expect(attributesOf("Tx.reconcileSigned")[0]?.get("sui.outcome")).toBe("submission_unknown")
  })

  test("a lock conflict is counted and marked", async () => {
    const conflict = FakeOutcome.transportError(
      "FAILED_PRECONDITION",
      `Transaction is rejected as invalid by more than 1/3 of validators by stake (non-retriable). ` +
        `Object (${ESCROW_ID}, SequenceNumber(3), o#11111111111111111111111111111111) already locked by a different transaction`
    )
    const { attributesOf, registry } = await run(
      advanced(Tx.run(claim, { signer })),
      { ...baseScript, execute: [conflict], getTransaction: [FakeOutcome.notFound()] }
    )
    expect(await countIn(registry, Metrics.lockConflicts)).toBe(1)
    expect(attributesOf("Tx.submit")[0]?.get("sui.lock_conflict")).toBe(true)
  })

  test("a reconcile that proves NotApplied names its evidence", async () => {
    const { attributesOf, registry, value } = await run(
      advanced(
        Effect.gen(function*() {
          const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: signer.address }), signer)
          // The epoch window closes before anyone asks, and the node never saw it.
          yield* SuiTest.setEpoch(99n)
          return yield* Tx.reconcile(signed)
        })
      ),
      {
        ...baseScript,
        epoch: 42n,
        getTransaction: [FakeOutcome.notFound()],
        ledger: { lowestAvailableCheckpoint: 100n, firstCheckpoints: { "42": 100n } }
      }
    )
    expect(Result.isFailure(value)).toBe(true)
    if (Result.isFailure(value)) expect(value.failure._tag).toBe("NotApplied")
    expect(await countIn(registry, Metrics.reconcileResults, { result: "not_applied", evidence: "expired" })).toBe(1)
    const [reconcile] = attributesOf("Tx.reconcile")
    expect(reconcile?.get("sui.outcome")).toBe("not_applied")
    expect(reconcile?.get("sui.not_applied.evidence")).toBe("expired")
  })
})

describe("#4 Tx.build retries its resolver on the SuiCore read policy", () => {
  test("a custom readRetry is honoured, and every retry is counted under method use", async () => {
    const { registry, value } = await run(
      advanced(Tx.build(claim, { sender: signer.address })),
      {
        ...baseScript,
        // One retry allowed: the second failure stands, though a third answer would succeed.
        readOptions: { readRetry: Schedule.recurs(1) },
        buildSimulate: [
          FakeOutcome.transportError("UNAVAILABLE"),
          FakeOutcome.transportError("UNAVAILABLE"),
          FakeOutcome.succeed({})
        ]
      }
    )
    expect(Result.isFailure(value)).toBe(true)
    if (Result.isFailure(value)) expect(value.failure._tag).toBe("TransportError")
    expect(await countIn(registry, Metrics.readRetries, { method: "use", status: "UNAVAILABLE" })).toBe(1)
  })

  test("the default policy still builds through a transient failure, and logs the retry", async () => {
    const logged: Array<string> = []
    const { registry, value } = await run(
      advanced(Tx.build(claim, { sender: signer.address })),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed({})] },
      Layer.mergeAll(
        Logger.layer([Logger.map(Logger.formatLogFmt, (line) => logged.push(line))]),
        Layer.succeed(References.MinimumLogLevel, "Debug")
      )
    )
    expect(Result.isSuccess(value)).toBe(true)
    expect(await countIn(registry, Metrics.readRetries, { method: "use", status: "UNAVAILABLE" })).toBe(1)
    expect(logged.some((line) => line.includes("SuiCore.use: retrying a retryable read failure"))).toBe(true)
  })
})

describe("#2 SuiCore read metrics", () => {
  test("a read abandoned at requestTimeout is counted by method", async () => {
    const client = {
      network: "localnet",
      core: {
        getObject: (options: { readonly signal: AbortSignal }) =>
          new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))
      }
    } as unknown as ClientWithCoreApi
    const registry: Metric.MetricRegistry = new Map()
    await Effect.runPromise(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fiber = yield* Effect.forkChild(Effect.exit(core.getObject({ objectId: PADDED("1") })))
        yield* TestClock.adjust("10 minutes")
        return yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(
          Layer.merge(
            SuiCore.layerFromClient(client, { requestTimeout: "2 seconds", readRetry: Schedule.recurs(2) }),
            TestClock.layer()
          ),
          { local: true }
        ),
        Effect.provideService(Metric.MetricRegistry, registry)
      )
    )
    expect(await countIn(registry, Metrics.requestTimeouts, { method: "getObject" })).toBe(3)
    expect(await countIn(registry, Metrics.readRetries, { method: "getObject", status: "DEADLINE_EXCEEDED" })).toBe(2)
  })
})
