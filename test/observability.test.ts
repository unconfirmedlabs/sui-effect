/**
 * Metrics and spans are a public contract (README, "Metrics"): every metric is
 * `sui_effect_`-prefixed with attribute values from a closed set, and the
 * spans name what a trace of a stuck submission is read for.
 */
import { describe, expect, test } from "bun:test"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { Transaction } from "@mysten/sui/transactions"
import { Effect, Fiber, Layer, Metric, Result, Schedule, Tracer } from "effect"
import { TestClock } from "effect/testing"
import * as Metrics from "../src/domain/metrics.ts"
import { ObjectId } from "../src/domain/schemas.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Tx } from "../src/services/Tx.ts"
import { FakeOutcome, type FakeScript } from "../src/testing.ts"
import { adjusted, bytes, EPOCH, run, signer, sequence, SUI, type Stubs } from "./support.ts"
import { TransactionNotFound } from "../src/domain/errors.ts"

const pinsNothing = (tx: Transaction) => {
  tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] })
}

/** Runs `effect` under a recording tracer and a fresh metric registry. */
const measured = async <A, E>(effect: Effect.Effect<A, E, never> | Effect.Effect<A, E, any>, script: FakeScript = {}, stubs: Stubs = {}) => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  const registry: Metric.MetricRegistry = new Map()
  const value = await run(Effect.result(Effect.withTracer(adjusted(effect as Effect.Effect<A, E, any>), tracer)).pipe(Effect.provideService(Metric.MetricRegistry, registry)), script, stubs)
  const count = (metric: Metric.Counter<number> | Metric.Histogram<number>, attributes?: Metric.Metric.AttributeSet) =>
    Effect.runPromise(Metric.value(attributes === undefined ? metric : Metric.withAttributes(metric as never, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry)))
      .then((state) => Number((state as { count: number | bigint }).count))
  const attributesOf = (name: string) => spans.filter((span) => span.name === name).map((span) => span.attributes)
  const names = () => spans.map((span) => span.name)
  return { value, count, attributesOf, names, registry }
}

describe("a successful Tx.run", () => {
  test("is counted, timed and annotated, and no metric is keyed by a digest, an address or an id", async () => {
    const { value, count, attributesOf, registry } = await measured(Tx.run(pinsNothing, { signer }))
    expect(Result.isSuccess(value)).toBe(true)
    expect(await count(Metrics.executeAttempts)).toBe(1)
    expect(await count(Metrics.submitResults, { result: "executed" })).toBe(1)
    expect(await count(Metrics.buildDuration as never, { simulated_by: "sdk" })).toBe(1)
    expect(await count(Metrics.senderLockWait as never)).toBe(1)
    expect(await count(Metrics.visibilityWait as never, { result: "visible" })).toBe(1)
    const [build] = attributesOf("Tx.build")
    expect([build?.get("sui.sender"), build?.get("sui.simulated_by"), build?.get("sui.gas_payment"), typeof build?.get("sui.gas_budget")]).toEqual([
      signer.address,
      "sdk",
      "addressBalance",
      "number"
    ])
    expect(attributesOf("Tx.submit")[0]?.get("sui.outcome")).toBe("executed")
    expect(attributesOf("Tx.withSenderLock")[0]?.get("sui.sender")).toBe(signer.address)
    const snapshot = await Effect.runPromise(Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)))
    expect(snapshot.length).toBeGreaterThan(0)
    for (const metric of snapshot) {
      expect(metric.id.startsWith("sui_effect_")).toBe(true)
      for (const attribute of Object.values(metric.attributes ?? {})) {
        expect(attribute).not.toMatch(/^0x[0-9a-f]{8,}/)
        expect(attribute.length).toBeLessThan(24)
      }
    }
  })
})

describe("sends that do not simply land", () => {
  test("a retried send counts every attempt, and the submit span carries the last attempt number", async () => {
    const { count, attributesOf } = await measured(Tx.run(pinsNothing, { signer }).pipe(SubmitConfig.with({ resubmit: Schedule.spaced("1 second") })), {
      execute: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()]
    })
    expect(await count(Metrics.executeAttempts)).toBe(2)
    expect(attributesOf("Tx.submit")[0]?.get("sui.attempt")).toBe(2)
  })

  test("a refusal on the first send is counted and marked refused", async () => {
    const { count, attributesOf } = await measured(Tx.run(pinsNothing, { signer }), { execute: [FakeOutcome.transportError("INVALID_ARGUMENT")] })
    expect(await count(Metrics.submitResults, { result: "refused" })).toBe(1)
    expect([attributesOf("Tx.submit")[0]?.get("sui.refused"), attributesOf("Tx.submit")[0]?.get("sui.outcome")]).toEqual([true, "refused"])
  })

  test("a lock conflict is counted and marked; the reconcile's answer is counted too", async () => {
    const conflict = FakeOutcome.transportError("FAILED_PRECONDITION", "Object (0xe1, SequenceNumber(3), o#1111) already locked by a different transaction")
    const { count, attributesOf } = await measured(Tx.run(pinsNothing, { signer }), { execute: [conflict] })
    expect(await count(Metrics.lockConflicts)).toBe(1)
    expect(attributesOf("Tx.submit")[0]?.get("sui.lock_conflict")).toBe(true)
    expect(await count(Metrics.reconcileResults, { result: "submission_unknown" })).toBeGreaterThan(0)
  })

  test("a reconcile that proves NotApplied names its evidence, on the span and in the count", async () => {
    const built = await bytes({ inputs: [], payment: [] })
    const notFound: Stubs = {
      getTransaction: ((o: { digest: string }) => Effect.fail(new TransactionNotFound({ digest: o.digest as never }))) as never,
      getCurrentSystemState: sequence([() => Effect.succeed({ systemState: { epoch: String(EPOCH + 2n) } })]).stub
    }
    const { value, count, attributesOf } = await measured(Effect.flatMap(Effect.flatMap(Tx.fromBytes(built), (b) => Tx.sign(b, signer)), Tx.reconcile), {}, notFound)
    expect(Result.isFailure(value) && value.failure._tag).toBe("NotApplied")
    expect(await count(Metrics.reconcileResults, { result: "not_applied", evidence: "expired" })).toBe(1)
    expect([attributesOf("Tx.reconcile")[0]?.get("sui.outcome"), attributesOf("Tx.reconcile")[0]?.get("sui.not_applied.evidence")]).toEqual(["not_applied", "expired"])
  })
})

describe("reads", () => {
  test("Tx.build retries its resolver on the read policy, counted under method use", async () => {
    const { value, count } = await measured(Tx.build(pinsNothing, { sender: signer.address }), { simulate: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()] })
    expect(Result.isSuccess(value)).toBe(true)
    expect(await count(Metrics.readRetries, { method: "use", status: "UNAVAILABLE" })).toBe(1)
  })

  test("a read abandoned at requestTimeout is counted by method, and its retries by status", async () => {
    const client = {
      network: "localnet",
      core: { getObject: (o: { signal: AbortSignal }) => new Promise((_, reject) => o.signal.addEventListener("abort", () => reject(new Error("aborted")))) }
    } as unknown as ClientWithCoreApi
    const registry: Metric.MetricRegistry = new Map()
    await Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(Effect.flatMap(SuiCore, (core) => core.getObject({ objectId: `0x${"1".padStart(64, "0")}` }))))
      yield* TestClock.adjust("10 minutes")
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(Layer.merge(SuiCore.layerFromClient(client, { requestTimeout: "2 seconds", readRetry: Schedule.recurs(2) }), TestClock.layer()), { local: true }),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.runPromise
    )
    const count = (metric: Metric.Counter<number>, attributes: Metric.Metric.AttributeSet) =>
      Effect.runPromise(Metric.value(Metric.withAttributes(metric, attributes)).pipe(Effect.provideService(Metric.MetricRegistry, registry))).then((s) => Number(s.count))
    expect([await count(Metrics.requestTimeouts, { method: "getObject" }), await count(Metrics.readRetries, { method: "getObject", status: "DEADLINE_EXCEEDED" })]).toEqual([3, 2])
  })
})

describe("spans", () => {
  const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
  const Escrow = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
  const objects = ["e1", "e2"].map((suffix, i) => ({
    objectId: PADDED(suffix),
    type: i === 0 ? `${PADDED("2")}::escrow::Escrow` : `${PADDED("2")}::escrow::Receipt`,
    version: 3n,
    content: Escrow.serialize({ id: PADDED(suffix), amount: "5" }).toBytes()
  }))

  test("SuiCore.getObject carries the object id and the network; a batch read makes no span per object", async () => {
    const { value, attributesOf, names } = await measured(Effect.flatMap(Sui, (sui) => Effect.zip(
      sui.getObject(ObjectId.make(PADDED("e1"))),
      sui.getObjects([ObjectId.make(PADDED("e1")), ObjectId.make(PADDED("e2"))], { expectedType: `${PADDED("2")}::escrow::Escrow` })
    )), { objects })
    expect(Result.isSuccess(value) && value.success[1].map(Result.isSuccess)).toEqual([true, false])
    expect([attributesOf("SuiCore.getObject")[0]?.get("sui.object_id"), attributesOf("SuiCore.getObject")[0]?.get("sui.network")]).toEqual([PADDED("e1"), "localnet"])
    expect(names()).not.toContain("Sui.decodeObject")
    expect([attributesOf("Sui.getObjectsPage")[0]?.get("sui.decode_failures"), attributesOf("Sui.getObjects")[0]?.get("sui.chunk_count")]).toEqual([1, 1])
  })

  test("Tx.sign carries the digest and the signer; a reconcile keeps Tx.recover and drops the one-read wrappers", async () => {
    const built = await bytes()
    const { value, attributesOf, names } = await measured(Effect.gen(function*() {
      const signed = yield* Tx.sign(yield* Tx.fromBytes(built), signer)
      yield* Effect.flip(Tx.reconcile(signed))
      return signed
    }), {}, { getTransaction: ((o: { digest: string }) => Effect.fail(new TransactionNotFound({ digest: o.digest as never }))) as never })
    const signed = Result.isSuccess(value) ? (value.success as { readonly digest: string }) : undefined
    expect([attributesOf("Tx.sign")[0]?.get("sui.digest"), attributesOf("Tx.sign")[0]?.get("sui.signer")]).toEqual([signed?.digest, signer.address])
    expect(names()).toContain("Tx.recover")
    for (const gone of ["Tx.inputStateOf", "Tx.consumedVersionOf", "Tx.currentEpoch", "Tx.expiryClosed", "Executed.fromTransactionResult", "Journal.put"]) expect(names()).not.toContain(gone)
  })
})

describe("output", () => {
  test("a successful Tx.run, and one whose visibility wait times out, write nothing to stdout or stderr", async () => {
    const written: Array<string> = []
    const original = { out: process.stdout.write, err: process.stderr.write, log: console.log, error: console.error, warn: console.warn }
    const capture = (chunk: string | Uint8Array) => (written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)), true)
    process.stdout.write = capture as typeof process.stdout.write
    process.stderr.write = capture as typeof process.stderr.write
    console.log = console.error = console.warn = (...args: ReadonlyArray<unknown>) => void written.push(args.join(" "))
    try {
      await run(Tx.run(pinsNothing, { signer }))
      await run(adjusted(Tx.run(pinsNothing, { signer })), {}, { waitForTransaction: (() => Effect.never) as never })
    } finally {
      process.stdout.write = original.out
      process.stderr.write = original.err
      console.log = original.log
      console.error = original.error
      console.warn = original.warn
    }
    expect(written.join("")).toBe("")
  })
})
