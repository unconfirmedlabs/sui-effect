/**
 * `SuiCore`: the error mapping, the read policy (retries, request timeout,
 * cancellation) and the layers, each over a stub SDK client whose one method
 * answers or fails as the test says.
 */
import { describe, expect, test } from "bun:test"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"
import { Cause, Clock, ConfigProvider, Effect, Exit, Fiber, Layer, Logger, References, Schedule } from "effect"
import { TestClock } from "effect/testing"
import type { TransportError } from "../src/domain/errors.ts"
import { defaultGrpcUrl, mapSdkError, readSchedule, SuiCore } from "../src/services/SuiCore.ts"

const OBJECT = `0x${"0".repeat(63)}7`
const DIGEST = "11111111111111111111111111111111"

const rpc = (status: string) => Object.assign(new Error(status), { code: status, name: "RpcError" })

/** A client whose `core` has exactly the methods given. */
const stubClient = (core: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ network: "localnet", core, ...extra }) as unknown as ClientWithCoreApi

/** Runs `f` over `SuiCore.layerFromClient(client)` under a `TestClock` advanced far enough for every retry. */
const withCore = <A, E>(
  client: ClientWithCoreApi,
  f: (core: SuiCore["Service"]) => Effect.Effect<A, E>,
  options?: Parameters<typeof SuiCore.layerFromClient>[1],
  extra: Layer.Layer<never> = Layer.empty
) =>
  Effect.gen(function*() {
    const fiber = yield* Effect.forkChild(Effect.exit(Effect.flatMap(SuiCore, f)))
    yield* TestClock.adjust("1 hour")
    return yield* Fiber.join(fiber)
  }).pipe(
    Effect.provide(Layer.mergeAll(SuiCore.layerFromClient(client, options), TestClock.layer(), extra), { local: true }),
    Effect.runPromise
  )

/** A `getObject` that fails with `cause` every time, counting calls and aborts. */
const counting = (answer: (options: { readonly signal: AbortSignal }) => Promise<unknown>) => {
  const state = { calls: 0, aborted: 0 }
  const client = stubClient({
    getObject: (options: { readonly signal: AbortSignal }) => {
      state.calls += 1
      options.signal.addEventListener("abort", () => (state.aborted += 1))
      return answer(options)
    }
  })
  return { state, client }
}
const hang = (options: { readonly signal: AbortSignal }) =>
  new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted"))))

describe("mapSdkError", () => {
  /** A class from a second copy of the SDK: the same name and fields, another identity. */
  const otherCopy = (name: string, fields: Record<string, unknown>) => Object.assign(new Error(name), { name, ...fields })
  const cases: ReadonlyArray<readonly [string, unknown, string, (string | boolean | undefined)?, boolean?]> = [
    ["ObjectError notFound", new ObjectError("notFound", "x", { reason: "notFound", objectId: OBJECT }), "ObjectNotFound"],
    ["ObjectError deleted", new ObjectError("deleted", "x", { reason: "deleted", objectId: OBJECT }), "ObjectDeleted"],
    ["ObjectError unknown", new ObjectError("unknown", "x", { reason: "unknown", objectId: OBJECT }), "ObjectUnavailable"],
    ["an ObjectError from another SDK copy", otherCopy("ObjectError", { reason: "deleted", objectId: OBJECT }), "ObjectDeleted"],
    ["TransactionError", new TransactionError("notFound", DIGEST), "TransactionNotFound"],
    ["a TransactionError from another SDK copy", otherCopy("TransactionError", { reason: "notFound", digest: DIGEST }), "TransactionNotFound"],
    ["a SimulationError carrying an executionError", new SimulationError("aborted", { cause: rpc("UNAVAILABLE"), executionError: { $kind: "MoveAbort", message: "x", MoveAbort: { abortCode: "7" } } as unknown as SuiClientTypes.ExecutionError }), "SimulationFailed"],
    ["a SimulationError wrapping an RpcError (the resolver's transport failure)", new SimulationError("resolution failed", { cause: rpc("UNAVAILABLE") }), "TransportError", "UNAVAILABLE", true],
    ["a SimulationError wrapping an HTTP 502", new SimulationError("resolution failed", { cause: Object.assign(new Error("bad gateway"), { status: 502 }) }), "TransportError", "502", true],
    ["a retryable gRPC status", rpc("UNAVAILABLE"), "TransportError", "UNAVAILABLE", true],
    ["INTERNAL, a refused fetch", rpc("INTERNAL"), "TransportError", "INTERNAL", true],
    ["UNKNOWN, an HTTP 500 under grpc-web", rpc("UNKNOWN"), "TransportError", "UNKNOWN", true],
    ["an answer from the node", rpc("INVALID_ARGUMENT"), "TransportError", "INVALID_ARGUMENT", false],
    ["a timeout", { _tag: "TimeoutError" }, "TransportError", "DEADLINE_EXCEEDED", true],
    ["anything else", "a string", "TransportError", undefined, false],
    ["a reason with no id is not the SDK's", { reason: "notFound" }, "TransportError", undefined, false]
  ]
  for (const [name, cause, tag, status, retryable] of cases) {
    test(name, () => {
      const error = mapSdkError("m", cause)
      expect<string>(error._tag).toBe(tag)
      if (error._tag === "TransportError") expect([error.status, error.retryable]).toEqual([status, retryable])
    })
  }

  test("a SimulationFailed parses the executionError", () => {
    const error = mapSdkError("simulateTransaction", new SimulationError("aborted", { executionError: { $kind: "MoveAbort", message: "x", command: 1, MoveAbort: { abortCode: "7" } } as never }))
    expect(error._tag === "SimulationFailed" && error.reason.$kind === "MoveAbort" && error.reason.MoveAbort.abortCode).toBe(7n)
  })
})

describe("the read policy", () => {
  test("a retryable failure is retried: five attempts in all by default, then the failure", async () => {
    const { state, client } = counting(() => Promise.reject(rpc("UNAVAILABLE")))
    const exit = await withCore(client, (core) => core.getObject({ objectId: OBJECT }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.calls).toBe(5)
  })

  test("a non-retryable failure is not retried", async () => {
    const { state, client } = counting(() => Promise.reject(rpc("INVALID_ARGUMENT")))
    await withCore(client, (core) => core.getObject({ objectId: OBJECT }))
    expect(state.calls).toBe(1)
  })

  test("executeTransaction is never retried", async () => {
    let calls = 0
    const client = stubClient({
      executeTransaction: () => {
        calls += 1
        return Promise.reject(rpc("UNAVAILABLE"))
      }
    })
    await withCore(client, (core) => core.executeTransaction({ transaction: new Uint8Array([1]), signatures: [] }))
    expect(calls).toBe(1)
  })

  test("an attempt that never answers is aborted at requestTimeout and retried as a retryable DEADLINE_EXCEEDED", async () => {
    const { state, client } = counting(hang)
    const exit = await withCore(client, (core) => core.getObject({ objectId: OBJECT }), {
      requestTimeout: "2 seconds",
      readRetry: Schedule.recurs(2)
    })
    const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined
    expect(error?._tag === "Some" && [(error.value as TransportError).status, (error.value as TransportError).retryable]).toEqual([
      "DEADLINE_EXCEEDED",
      true
    ])
    expect([state.calls, state.aborted]).toEqual([3, 3])
  })

  test("the default request timeout is thirty seconds", async () => {
    const { state, client } = counting(hang)
    const seen = await Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(Effect.flatMap(SuiCore, (core) => core.getObject({ objectId: OBJECT }))))
      yield* TestClock.adjust("29 seconds")
      const before = state.aborted
      yield* TestClock.adjust("2 seconds")
      const after = state.aborted
      yield* Fiber.interrupt(fiber)
      return [before, after]
    }).pipe(Effect.provide(Layer.merge(SuiCore.layerFromClient(client), TestClock.layer()), { local: true }), Effect.runPromise)
    expect(seen).toEqual([0, 1])
  })

  test("each retry is logged at debug level, naming the method", async () => {
    const logged: Array<string> = []
    const { client } = counting(() => Promise.reject(rpc("UNAVAILABLE")))
    await withCore(client, (core) => core.getObject({ objectId: OBJECT }), { readRetry: Schedule.recurs(2) }, Layer.mergeAll(
      Logger.layer([Logger.map(Logger.formatLogFmt, (line) => logged.push(line))]),
      Layer.succeed(References.MinimumLogLevel, "Debug")
    ) as Layer.Layer<never>)
    const retries = logged.filter((line) => line.includes("SuiCore.getObject: retrying"))
    expect(retries).toHaveLength(2)
    expect(retries[0]).toContain("level=DEBUG")
  })

  test("the schedule doubles from 250ms, caps at 10s, and jitters within 0.8x to 1.2x", async () => {
    const gaps = await Effect.gen(function*() {
      const times: Array<number> = []
      const attempt = Effect.flatMap(Clock.currentTimeMillis, (now) => {
        times.push(now)
        return Effect.fail("again" as const)
      })
      const fiber = yield* Effect.forkChild(Effect.ignore(Effect.retry(attempt, { schedule: readSchedule, times: 8 })))
      yield* TestClock.adjust("10 minutes")
      yield* Fiber.join(fiber)
      return times.slice(1).map((time, index) => time - times[index]!)
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
    const bases = [250, 500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000]
    expect(gaps).toHaveLength(bases.length)
    gaps.forEach((gap, index) => {
      expect(gap).toBeGreaterThanOrEqual(bases[index]! * 0.8)
      expect(gap).toBeLessThanOrEqual(bases[index]! * 1.2)
    })
  })

  test("an SDK argument refusal is a defect carrying the SDK's sentence, not a TransportError", async () => {
    const client = stubClient({
      listEvents: async () => {
        throw new Error(`Invalid eventType filter "pkg": expected "package::module" or a fully qualified type name`)
      }
    })
    const exit = await withCore(client, (core) => core.listEvents({ filter: { eventType: "pkg" } }))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("Invalid eventType filter")
  })
})

describe("use", () => {
  test("hands over the client and the Effect's signal, and maps what the call throws", async () => {
    let signal: unknown
    const client = stubClient({})
    const exit = await withCore(client, (core) =>
      core.use(async (_client, abort) => {
        signal = abort
        throw new ObjectError("notFound", "x", { reason: "notFound", objectId: OBJECT })
      }))
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(Exit.isFailure(exit) && Cause.findErrorOption(exit.cause)).toMatchObject({ value: { _tag: "ObjectNotFound" } })
  })
})

describe("getServiceInfo", () => {
  test("reads gRPC LedgerService.GetServiceInfo; another transport is a non-retryable UNIMPLEMENTED", async () => {
    const grpc = stubClient({}, {
      ledgerService: {
        getServiceInfo: async () => ({
          response: { chainId: "c", epoch: 7n, checkpointHeight: 120n, lowestAvailableCheckpoint: 80n, timestamp: { seconds: 2n, nanos: 5_000_000 } }
        })
      }
    })
    const info = await withCore(grpc, (core) => core.getServiceInfo())
    expect(Exit.isSuccess(info) && info.value).toEqual({ chainId: "c", epoch: 7n, checkpointHeight: 120n, lowestAvailableCheckpoint: 80n, timestampMs: 2005 })
    const other = await withCore(stubClient({}), (core) => Effect.flip(core.getServiceInfo()))
    expect(Exit.isSuccess(other) && [other.value.status, other.value.retryable]).toEqual(["UNIMPLEMENTED", false])
  })
})

describe("layers", () => {
  test("the default gRPC URL table covers the four known networks", () => {
    expect(["mainnet", "testnet", "devnet", "localnet", "staging"].map(defaultGrpcUrl)).toEqual([
      "https://fullnode.mainnet.sui.io:443",
      "https://fullnode.testnet.sui.io:443",
      "https://fullnode.devnet.sui.io:443",
      "http://127.0.0.1:9000",
      undefined
    ])
  })

  test("layerConfig: SUI_NETWORK is required, SUI_RPC_URL defaults from the table, SUI_RPC_TIMEOUT is a duration", async () => {
    const builds = (env: Record<string, string>) =>
      Effect.runPromiseExit(
        Effect.scoped(Layer.build(SuiCore.layerConfig)).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env)))
      ).then(Exit.isSuccess)
    expect(await builds({})).toBe(false)
    expect(await builds({ SUI_NETWORK: "testnet" })).toBe(true)
    expect(await builds({ SUI_NETWORK: "staging" })).toBe(false)
    expect(await builds({ SUI_NETWORK: "staging", SUI_RPC_URL: "http://127.0.0.1:1" })).toBe(true)
    expect(await builds({ SUI_NETWORK: "localnet", SUI_RPC_TIMEOUT: "5 seconds" })).toBe(true)
    expect(await builds({ SUI_NETWORK: "localnet", SUI_RPC_TIMEOUT: "soon" })).toBe(false)
  })
})
