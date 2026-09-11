import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { ConfigProvider } from "effect"
import {
  defaultGrpcUrl,
  mapSdkError,
  RETRYABLE_GRPC_STATUSES,
  SuiCore
} from "../src/services/SuiCore.ts"
import {
  ClockBcs,
  FakeOutcome,
  fakeDigest,
  SuiCoreFake
} from "../src/services/SuiCoreFake.ts"
import { ObjectError, SimulationError, TransactionError } from "@mysten/sui/client"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW = PADDED("e5c")
const Escrow = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.U64 })

const script = {
  chainId: "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S",
  clockTimestampMs: 1_700_000_000_000n,
  objects: [
    {
      objectId: ESCROW,
      type: "0x2::escrow::Escrow",
      version: 3n,
      content: Escrow.serialize({ id: ESCROW, amount: "5" }).toBytes()
    }
  ]
}

const run = <A, E>(
  effect: Effect.Effect<A, E, SuiCore | SuiCoreFake>,
  layer = SuiCoreFake.layer(script)
) => Effect.runPromise(Effect.provide(effect, layer, { local: true }))

const runExit = <A, E>(
  effect: Effect.Effect<A, E, SuiCore | SuiCoreFake>,
  layer = SuiCoreFake.layer(script)
) => Effect.runPromiseExit(Effect.provide(effect, layer, { local: true }))

describe("mapSdkError", () => {
  test("maps ObjectError by reason", () => {
    const notFound = mapSdkError(
      "getObject",
      new ObjectError("notFound", "missing", { reason: "notFound", objectId: ESCROW })
    )
    expect(notFound._tag).toBe("ObjectNotFound")
    const deleted = mapSdkError(
      "getObject",
      new ObjectError("deleted", "gone", { reason: "deleted", objectId: ESCROW })
    )
    expect(deleted._tag).toBe("ObjectDeleted")
    const unknown = mapSdkError(
      "getObject",
      new ObjectError("unknown", "?", { reason: "unknown", objectId: ESCROW })
    )
    expect(unknown._tag).toBe("ObjectUnavailable")
  })

  test("maps TransactionError to TransactionNotFound", () => {
    const error = mapSdkError("getTransaction", new TransactionError("notFound", fakeDigest(3)))
    expect(error._tag).toBe("TransactionNotFound")
  })

  test("maps SimulationError and parses its executionError", () => {
    const error = mapSdkError(
      "simulateTransaction",
      new SimulationError("aborted", {
        executionError: {
          message: "MoveAbort",
          command: 1,
          $kind: "MoveAbort",
          MoveAbort: { abortCode: "7" }
        } as never
      })
    )
    expect(error._tag).toBe("SimulationFailed")
    if (error._tag === "SimulationFailed") {
      expect(error.reason.$kind).toBe("MoveAbort")
      if (error.reason.$kind === "MoveAbort") {
        expect(error.reason.MoveAbort.abortCode).toBe(7n)
      }
    }
  })

  test("maps gRPC statuses into retryable and non-retryable TransportErrors", () => {
    for (const status of ["UNAVAILABLE", "DEADLINE_EXCEEDED", "RESOURCE_EXHAUSTED"]) {
      const error = mapSdkError("getObject", Object.assign(new Error(status), { code: status }))
      expect(error._tag).toBe("TransportError")
      if (error._tag === "TransportError") {
        expect(error.retryable).toBe(true)
        expect(error.status).toBe(status)
      }
    }
    const notFound = mapSdkError(
      "getObject",
      Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" })
    )
    expect(notFound._tag === "TransportError" && notFound.retryable).toBe(false)
  })

  test("a transport-level gRPC failure is retryable", () => {
    // `@protobuf-ts/grpcweb-transport` reports a refused connection or a DNS
    // failure as INTERNAL, and maps HTTP 500 to UNKNOWN. Neither reached a
    // node, so a read may try again.
    for (const status of ["INTERNAL", "UNKNOWN"]) {
      const error = mapSdkError("getObject", Object.assign(new Error(status), { code: status }))
      expect(error._tag).toBe("TransportError")
      if (error._tag === "TransportError") {
        expect(error.retryable).toBe(true)
        expect(error.status).toBe(status)
      }
    }
    expect([...RETRYABLE_GRPC_STATUSES].sort()).toEqual([
      "DEADLINE_EXCEEDED",
      "INTERNAL",
      "RESOURCE_EXHAUSTED",
      "UNAVAILABLE",
      "UNKNOWN"
    ])
  })

  test("an answer from the node is not retryable", () => {
    for (const status of ["NOT_FOUND", "INVALID_ARGUMENT", "PERMISSION_DENIED", "ABORTED"]) {
      const error = mapSdkError("getObject", Object.assign(new Error(status), { code: status }))
      expect(error._tag === "TransportError" && error.retryable).toBe(false)
    }
  })

  test("maps HTTP statuses", () => {
    const server = mapSdkError("getObject", Object.assign(new Error("boom"), { status: 503 }))
    expect(server._tag === "TransportError" && server.retryable).toBe(true)
    const rateLimited = mapSdkError("getObject", Object.assign(new Error("slow"), { status: 429 }))
    expect(rateLimited._tag === "TransportError" && rateLimited.retryable).toBe(true)
    const badRequest = mapSdkError("getObject", Object.assign(new Error("bad"), { status: 400 }))
    expect(badRequest._tag === "TransportError" && badRequest.retryable).toBe(false)
  })

  test("maps a timeout to a retryable DEADLINE_EXCEEDED", () => {
    const error = mapSdkError("getObject", { _tag: "TimeoutError" })
    expect(error._tag === "TransportError" && error.retryable).toBe(true)
    expect(error._tag === "TransportError" && error.status).toBe("DEADLINE_EXCEEDED")
  })

  test("maps anything else to a non-retryable TransportError", () => {
    const error = mapSdkError("getObject", "a string")
    expect(error._tag === "TransportError" && error.retryable).toBe(false)
  })
})

describe("layers", () => {
  test("the default gRPC URL table covers the four known networks", () => {
    expect(defaultGrpcUrl("mainnet")).toBe("https://fullnode.mainnet.sui.io:443")
    expect(defaultGrpcUrl("testnet")).toBe("https://fullnode.testnet.sui.io:443")
    expect(defaultGrpcUrl("devnet")).toBe("https://fullnode.devnet.sui.io:443")
    expect(defaultGrpcUrl("localnet")).toBe("http://127.0.0.1:9000")
    expect(defaultGrpcUrl("staging")).toBe(undefined)
  })

  test("layerConfig requires SUI_NETWORK", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return core.network
      }).pipe(
        Effect.provide(
          SuiCore.layerConfig.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({})))
          )
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("layerConfig defaults SUI_RPC_URL from the table", async () => {
    const network = await Effect.runPromise(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return core.network
      }).pipe(
        Effect.provide(
          SuiCore.layerConfig.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "testnet" }))
            )
          )
        )
      )
    )
    expect(network).toBe("testnet")
  })

  test("layerConfig fails when a custom network has no URL and none is given", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return core.network
      }).pipe(
        Effect.provide(
          SuiCore.layerConfig.pipe(
            Layer.provide(
              ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "staging" }))
            )
          )
        )
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })

  test("layerGrpc builds a client without touching the network", async () => {
    const network = await Effect.runPromise(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return core.network
      }).pipe(
        Effect.provide(
          SuiCore.layerGrpc({ network: "testnet", baseUrl: "https://fullnode.testnet.sui.io:443" })
        )
      )
    )
    expect(network).toBe("testnet")
  })
})

describe("the fake", () => {
  test("serves an object with its BCS content", async () => {
    const object = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const { object } = yield* core.getObject({
          objectId: ESCROW,
          include: { content: true }
        })
        return object
      })
    )
    expect(object.type).toBe("0x2::escrow::Escrow")
    expect(Escrow.parse(object.content).amount).toBe("5")
  })

  test("serves the Clock object 0x6", async () => {
    const timestamp = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const { object } = yield* core.getObject({
          objectId: SUI_CLOCK_OBJECT_ID,
          include: { content: true }
        })
        return ClockBcs.parse(object.content).timestamp_ms
      })
    )
    expect(timestamp).toBe("1700000000000")
  })

  test("a missing object fails with ObjectNotFound", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return yield* core.getObject({ objectId: PADDED("dead") })
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "ObjectNotFound" })
    }
  })

  test("a deleted object fails with ObjectDeleted", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        yield* fake.deleteObject(ESCROW)
        return yield* core.getObject({ objectId: ESCROW })
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.squash(exit.cause)).toMatchObject({ _tag: "ObjectDeleted" })
    }
  })

  test("getObjects reports per-item failures in the result array", async () => {
    const objects = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const { objects } = yield* core.getObjects({
          objectIds: [ESCROW, PADDED("dead")],
          include: { content: true }
        })
        return objects
      })
    )
    expect(objects).toHaveLength(2)
    expect(objects[1]).toBeInstanceOf(Error)
  })

  test("an unscripted method dies with a message naming it", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return yield* core.getProtocolConfig()
      })
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).toContain("getProtocolConfig")
    }
  })

  test("records the options every call received", async () => {
    const calls = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        yield* core.getObject({ objectId: ESCROW, include: { content: true } })
        return yield* fake.calls
      })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe("getObject")
    expect(calls[0]?.options).toMatchObject({ include: { content: true } })
  })
})

describe("use", () => {
  test("runs mapSdkError on whatever the call throws", async () => {
    const error = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return yield* core
          .use(async (client) => client.core.getObject({ objectId: PADDED("dead") }))
          .pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("ObjectNotFound")
  })

  test("passes the client object and an AbortSignal through", async () => {
    const chainId = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        return yield* core.use(async (client, signal) => {
          expect(signal).toBeInstanceOf(AbortSignal)
          const { chainIdentifier } = await client.core.getChainIdentifier({ signal })
          return chainIdentifier
        })
      })
    )
    expect(chainId).toBe(script.chainId)
  })
})

describe("retries", () => {
  const flaky = SuiCoreFake.layer({
    ...script,
    getTransaction: [
      FakeOutcome.transportError("UNAVAILABLE"),
      FakeOutcome.transportError("UNAVAILABLE"),
      FakeOutcome.succeed({ digest: fakeDigest(9) })
    ]
  })

  test("a read retries a retryable TransportError and succeeds on the third attempt", async () => {
    const program = Effect.gen(function*() {
      const core = yield* SuiCore
      const fake = yield* SuiCoreFake
      const fiber = yield* Effect.forkChild(core.getTransaction({ digest: fakeDigest(9) }))
      yield* TestClock.adjust("1 minute")
      const exit = yield* Fiber.await(fiber)
      const calls = yield* fake.calls
      return { exit, attempts: calls.filter((call) => call.method === "getTransaction").length }
    })
    const result = await Effect.runPromise(
      Effect.provide(program, Layer.merge(flaky, TestClock.layer()), { local: true })
    )
    expect(Exit.isSuccess(result.exit)).toBe(true)
    expect(result.attempts).toBe(3)
  })

  test("a non-retryable TransportError is not retried", async () => {
    const layer = SuiCoreFake.layer({
      ...script,
      getTransaction: [FakeOutcome.transportError("INVALID_ARGUMENT")]
    })
    const exit = await runExit(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        const result = yield* Effect.exit(core.getTransaction({ digest: fakeDigest(9) }))
        const calls = yield* fake.calls
        return { result, attempts: calls.length }
      }),
      layer
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.attempts).toBe(1)
    }
  })

  test("executeTransaction is never retried", async () => {
    const layer = SuiCoreFake.layer({
      ...script,
      execute: [
        FakeOutcome.transportError("UNAVAILABLE"),
        FakeOutcome.succeed({ digest: fakeDigest(4) })
      ]
    })
    const attempts = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        yield* Effect.exit(
          core.executeTransaction({ transaction: new Uint8Array([1]), signatures: [] })
        )
        const calls = yield* fake.calls
        return calls.filter((call) => call.method === "executeTransaction").length
      }),
      layer
    )
    expect(attempts).toBe(1)
  })
})

describe("interruption", () => {
  test("a timeout aborts the fake's pending promise", async () => {
    const layer = SuiCoreFake.layer({
      ...script,
      execute: [FakeOutcome.timeoutThen(false)]
    })
    const result = await run(
      Effect.gen(function*() {
        const core = yield* SuiCore
        const fake = yield* SuiCoreFake
        const exit = yield* Effect.exit(
          core
            .executeTransaction({ transaction: new Uint8Array([1]), signatures: [] })
            .pipe(Effect.timeout("50 millis"))
        )
        return { failed: Exit.isFailure(exit), aborted: yield* fake.aborted }
      }),
      layer
    )
    expect(result.failed).toBe(true)
    expect(result.aborted).toBe(1)
  })
})
