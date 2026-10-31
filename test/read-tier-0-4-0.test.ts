/**
 * 0.4.0 read-tier fixes from dogfooding (F4a): strict id decoding, plain-string
 * type arguments, the per-attempt request timeout and read retry option, SDK
 * argument errors as defects, unpaginable function filters, resumable and
 * tailing ledger streams, service info, SuiNS `UNIMPLEMENTED`, a decoding
 * `getDynamicFieldOption`, `SuiSchema.name` and package objects.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client"
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  References,
  Schedule,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { bcs } from "../src/domain/bcs.ts"
import { TransportError } from "../src/domain/errors.ts"
import { Executed } from "../src/domain/executed.ts"
import { CoinType, ObjectId, StructTag, SuiAddress } from "../src/domain/schemas.ts"
import { SuiSchema } from "../src/index.ts"
import { Sui } from "../src/services/Sui.ts"
import { makeFromClient, SuiCore, type SuiCoreService } from "../src/services/SuiCore.ts"
import {
  type FakeScript,
  FakeOutcome,
  fakeDigest,
  SuiCoreFake
} from "../src/services/SuiCoreFake.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const PKG = PADDED("abc")
const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCore | SuiCoreFake>,
  script: FakeScript = {}
) =>
  Effect.runPromise(
    Effect.provide(effect, layerTest({ chainId: CHAIN_ID, ...script }), { local: true })
  )

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.map(Stream.runCollect(stream), (chunk) => [...chunk])

/** `Sui` over a `SuiCore` whose members the test replaces on top of the fake's. */
const overFake = (
  script: FakeScript,
  override: (core: SuiCoreService) => Partial<SuiCoreService>
) =>
  Sui.layerNoDepsPinned(CHAIN_ID).pipe(
    Layer.provideMerge(
      Layer.effect(
        SuiCore,
        Effect.gen(function*() {
          const core = yield* SuiCore
          return { ...core, ...override(core) }
        })
      ).pipe(Layer.provideMerge(SuiCoreFake.layer({ chainId: CHAIN_ID, ...script })))
    )
  )

/** The service, as an Effect. */
const core = Effect.service(SuiCore)
const sui = Effect.service(Sui)

/** A hand-written client: only the members a test needs, everything else absent. */
const stubClient = (core: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ network: "localnet", core, ...extra }) as unknown as ClientWithCoreApi

describe("wallet#4: ids from outside", () => {
  test("decoding refuses the empty string and a bare 0x instead of padding them", () => {
    for (const schema of [SuiAddress, ObjectId]) {
      const decode = Schema.decodeUnknownResult(schema as Schema.Codec<string, string>)
      expect(decode("")._tag).toBe("Failure")
      expect(decode("0x")._tag).toBe("Failure")
      expect(decode("0xnothex")._tag).toBe("Failure")
      // Shorthand is still decoded, and padded: that is what the padding rule is.
      const short = decode("0x2")
      expect(short._tag).toBe("Success")
      if (short._tag === "Success") expect(short.success).toBe(PADDED("2"))
    }
  })

  test("Strict takes exactly 64 hex digits and nothing it would have to pad", () => {
    const strict = Schema.decodeUnknownResult(SuiAddress.Strict)
    for (const bad of ["", "0x", "0x2", "2", `0x${"a".repeat(60)}`, `0x${"a".repeat(65)}`, "0x" + "g".repeat(64)]) {
      expect([bad, strict(bad)._tag]).toEqual([bad, "Failure"])
    }
    const upper = strict(`0x${"AB".repeat(32)}`)
    expect(upper._tag).toBe("Success")
    // The same brand as the padding decoder, so it flows anywhere a SuiAddress does.
    if (upper._tag === "Success") {
      const address: SuiAddress = upper.success
      expect(address).toBe(`0x${"ab".repeat(32)}` as SuiAddress)
    }
    expect(strict("a".repeat(64))._tag).toBe("Success")
    const objectId = Schema.decodeUnknownResult(ObjectId.Strict)(`0x${"a".repeat(60)}`)
    expect(objectId._tag).toBe("Failure")
    if (objectId._tag === "Failure") expect(String(objectId.failure)).toContain("exactly 64 hex digits")
  })
})

describe("indexer#6 / move#18: type arguments as plain strings", () => {
  test("CoinType and StructTag normalize; make validates without normalizing; CoinType.SUI", () => {
    expect(CoinType.SUI).toBe(`${PADDED("2")}::sui::SUI` as CoinType)
    expect(CoinType.normalize("0x2::sui::SUI")).toBe(CoinType.SUI)
    expect(CoinType.make("0x2::sui::SUI")).toBe("0x2::sui::SUI" as CoinType)
    expect(StructTag.normalize("0x2::coin::Coin<0x2::sui::SUI>")).toBe(
      `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>` as StructTag
    )
    expect(() => StructTag.normalize("not a tag")).toThrow()
  })

  test("reads and Executed.balanceChange take a plain coin or struct type string", async () => {
    const [balance, metadata, owned, change] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const executed = yield* sui.getTransaction(fakeDigest(1) as never)
        return [
          yield* sui.getBalance(SuiAddress.make(ALICE), "0x2::sui::SUI"),
          yield* sui.getCoinMetadataOption("0x2::sui::SUI"),
          yield* collect(sui.streamOwnedObjects(SuiAddress.make(ALICE), { type: "0x2::coin::Coin" })),
          executed.balanceChange(SuiAddress.make(ALICE), "0x2::sui::SUI")
        ] as const
      }),
      {
        balances: [{ owner: ALICE, coinType: "0x2::sui::SUI", balance: "5", coinBalance: "5", addressBalance: "0" }],
        coinMetadata: {
          "0x2::sui::SUI": {
            id: PADDED("ee"),
            decimals: 9,
            name: "Sui",
            symbol: "SUI",
            description: "",
            iconUrl: null
          }
        },
        objects: [{
          objectId: PADDED("c01"),
          type: `0x2::coin::Coin<0x2::sui::SUI>`,
          version: 1n,
          owner: { $kind: "AddressOwner", AddressOwner: ALICE },
          content: new Uint8Array(40)
        }],
        transactions: {
          [fakeDigest(1)]: FakeOutcome.succeed({
            sender: ALICE,
            balanceChanges: [{ address: ALICE, coinType: `${PADDED("2")}::sui::SUI`, amount: "-7" }]
          })
        }
      }
    )
    expect(balance.balance).toBe(5n as never)
    expect(Option.isSome(metadata)).toBe(true)
    expect(owned).toHaveLength(1)
    expect(change).toBe(-7n)
  })
})

describe("indexer#3 / indexer#12: request timeout and read retry", () => {
  /** A client whose `getObject` never answers, and which records every abort. */
  const hanging = () => {
    const state = { calls: 0, aborted: 0 }
    const client = stubClient({
      getObject: (options: { readonly signal: AbortSignal }) => {
        state.calls += 1
        return new Promise((_, reject) => {
          options.signal.addEventListener("abort", () => {
            state.aborted += 1
            reject(new Error("aborted"))
          })
        })
      }
    })
    return { state, client }
  }

  test("an attempt that never answers is cancelled at requestTimeout and retried as DEADLINE_EXCEEDED", async () => {
    const { state, client } = hanging()
    const program = Effect.gen(function*() {
      const core = yield* SuiCore
      const fiber = yield* Effect.forkChild(core.getObject({ objectId: PADDED("1") }).pipe(Effect.flip))
      yield* TestClock.adjust("10 minutes")
      return yield* Fiber.join(fiber)
    })
    const error = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.merge(
          SuiCore.layerFromClient(client, { requestTimeout: "2 seconds", readRetry: Schedule.recurs(2) }),
          TestClock.layer()
        ),
        { local: true }
      )
    )
    expect(error._tag).toBe("TransportError")
    const transport = error as TransportError
    expect(transport.status).toBe("DEADLINE_EXCEEDED")
    expect(transport.retryable).toBe(true)
    // `Schedule.recurs(2)`: the first attempt and two retries, each one aborted.
    expect(state.calls).toBe(3)
    expect(state.aborted).toBe(3)
  })

  test("the default is thirty seconds, and the default policy makes five attempts", async () => {
    const { state, client } = hanging()
    const program = Effect.gen(function*() {
      const core = yield* SuiCore
      const fiber = yield* Effect.forkChild(core.getObject({ objectId: PADDED("1") }).pipe(Effect.exit))
      yield* TestClock.adjust("29 seconds")
      const before = state.calls
      yield* TestClock.adjust("30 minutes")
      return { before, exit: yield* Fiber.join(fiber) }
    })
    const { before, exit } = await Effect.runPromise(
      Effect.provide(program, Layer.merge(SuiCore.layerFromClient(client), TestClock.layer()), { local: true })
    )
    expect(before).toBe(1)
    expect(Exit.isFailure(exit)).toBe(true)
    expect(state.calls).toBe(5)
  })

  test("each retry is logged at debug level, naming the method", async () => {
    const { client } = hanging()
    const logged: Array<string> = []
    const program = Effect.gen(function*() {
      const core = yield* SuiCore
      const fiber = yield* Effect.forkChild(core.getObject({ objectId: PADDED("1") }).pipe(Effect.exit))
      yield* TestClock.adjust("10 minutes")
      return yield* Fiber.join(fiber)
    })
    await Effect.runPromise(
      Effect.provide(
        program,
        Layer.mergeAll(
          SuiCore.layerFromClient(client, { requestTimeout: "1 second", readRetry: Schedule.recurs(2) }),
          TestClock.layer(),
          Logger.layer([Logger.map(Logger.formatLogFmt, (line) => logged.push(line))]),
          Layer.succeed(References.MinimumLogLevel, "Debug")
        ),
        { local: true }
      )
    )
    const retries = logged.filter((line) => line.includes("SuiCore.getObject: retrying"))
    expect(retries).toHaveLength(2)
    expect(retries[0]).toContain("level=DEBUG")
  })

  test("SUI_RPC_TIMEOUT is read by layerConfig and must be a duration", async () => {
    const build = (env: Record<string, string>) =>
      Effect.runPromiseExit(
        Effect.scoped(Layer.build(SuiCore.layerConfig)).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(env))
        )
      )
    expect(Exit.isSuccess(await build({ SUI_NETWORK: "localnet", SUI_RPC_TIMEOUT: "5 seconds" }))).toBe(true)
    expect(Exit.isSuccess(await build({ SUI_NETWORK: "localnet" }))).toBe(true)
    expect(Exit.isFailure(await build({ SUI_NETWORK: "localnet", SUI_RPC_TIMEOUT: "soon" }))).toBe(true)
  })
})

describe("indexer#2: caller mistakes are not transport failures", () => {
  test("an SDK argument refusal is a defect carrying the SDK's sentence", async () => {
    const client = stubClient({
      listEvents: async () => {
        throw new Error(`Invalid eventType filter "pkg": expected "package::module" or a fully qualified type name`)
      }
    })
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(core, (core) => core.listEvents({ filter: { eventType: "pkg" } })).pipe(
        Effect.provide(SuiCore.layerFromClient(client))
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain("Invalid eventType filter")
    }
  })

  test("a network failure that is not an SDK argument refusal is still a TransportError", async () => {
    const client = stubClient({
      listEvents: async () => {
        throw new Error("socket hang up")
      }
    })
    const error = await Effect.runPromise(
      Effect.flatMap(core, (core) => core.listEvents({})).pipe(
        Effect.flip,
        Effect.provide(SuiCore.layerFromClient(client))
      )
    )
    expect(error._tag).toBe("TransportError")
  })

  test("streamTransactions refuses a module filter before the first request", async () => {
    const [exit, calls] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const exit = yield* Effect.exit(collect(sui.streamTransactions({ function: `${PKG}::vault` })))
        return [exit, yield* SuiTest.calls("listTransactions")] as const
      })
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("package::module::function")
    expect(calls).toHaveLength(0)
  })
})

/** Five transactions, one event each; even ones emit `Ping`, odd ones `Pong`. */
const Ping = `${PKG}::game::Ping`
const Pong = `${PKG}::game::Pong`
const eventOf = (type: string): SuiClientTypes.Event => ({
  packageId: PKG,
  module: "game",
  sender: ALICE,
  eventType: type,
  bcs: suiBcs.U64.serialize(1).toBytes(),
  json: null
})
const ledger = (from: number, to: number): NonNullable<FakeScript["transactions"]> => {
  const out: Record<string, FakeOutcome> = {}
  for (let seed = from; seed <= to; seed += 1) {
    out[fakeDigest(seed)] = FakeOutcome.succeed({
      sender: ALICE,
      checkpoint: String(seed),
      events: [eventOf(seed % 2 === 0 ? Ping : Pong)]
    })
  }
  return out
}

describe("indexer#4: resumable and tailing streams", () => {
  test("pages carry the cursor to resume from, and `after` resumes there", async () => {
    const [pages, resumed] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const pages = yield* collect(sui.streamEventPages(undefined))
        const third = pages[2]
        const resumed = yield* collect(sui.streamEvents(undefined, { after: third?.endCursor ?? null }))
        return [pages, resumed] as const
      }),
      { transactions: ledger(1, 5), pageSize: 1 }
    )
    expect(pages).toHaveLength(5)
    expect(pages.every((page) => page.endCursor !== null)).toBe(true)
    expect(pages.slice(0, 4).every((page) => page.hasNextPage)).toBe(true)
    expect(resumed.map((entry) => entry.transactionDigest)).toEqual([fakeDigest(4), fakeDigest(5)] as never)
  })

  test("a full eventType is normalized before it reaches the node (gRPC refuses 0x2::…)", async () => {
    const calls = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        yield* collect(sui.streamEvents({ eventType: "0x2::coin::CoinMetadata<0x2::sui::SUI>" }))
        yield* collect(sui.streamEvents({ eventType: "0x2::coin" }))
        return yield* SuiTest.calls("listEvents")
      })
    )
    expect((calls[0]?.options as { filter?: unknown }).filter).toEqual({
      eventType: `${PADDED("2")}::coin::CoinMetadata<${PADDED("2")}::sui::SUI>`
    })
    expect((calls[1]?.options as { filter?: unknown }).filter).toEqual({ eventType: "0x2::coin" })
  })

  test("`before` implies a descending read, as in the SDK", async () => {
    const entries = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const pages = yield* collect(sui.streamEventPages(undefined, { order: "descending" }))
        return yield* collect(sui.streamEvents(undefined, { before: pages[1]?.endCursor ?? "" }))
      }),
      { transactions: ledger(1, 5), pageSize: 1 }
    )
    expect(entries.map((entry) => entry.transactionDigest)).toEqual(
      [fakeDigest(3), fakeDigest(2), fakeDigest(1)] as never
    )
  })

  test("a tail follows the ledger past the point it caught up, polling", async () => {
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const fiber = yield* Effect.forkChild(
        collect(sui.tailEvents(undefined, { poll: "5 seconds" }).pipe(Stream.take(4)))
      )
      yield* TestClock.adjust("1 second")
      yield* SuiTest.recordTransaction(fakeDigest(3), FakeOutcome.succeed({ sender: ALICE, events: [eventOf(Pong)] }))
      yield* SuiTest.recordTransaction(fakeDigest(4), FakeOutcome.succeed({ sender: ALICE, events: [eventOf(Ping)] }))
      yield* TestClock.adjust("5 seconds")
      return yield* Fiber.join(fiber)
    })
    const events = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.merge(layerTest({ chainId: CHAIN_ID, transactions: ledger(1, 2) }), TestClock.layer()),
        { local: true }
      )
    )
    expect(events.map((entry) => entry.transactionDigest)).toEqual(
      [fakeDigest(1), fakeDigest(2), fakeDigest(3), fakeDigest(4)] as never
    )
  })

  test("a caught-up filtered tail moves its cursor to the ledger head, read before the page", async () => {
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const fiber = yield* Effect.forkChild(
        collect(
          sui.tailEventPages({ eventType: Ping }, { poll: "1 second" }).pipe(Stream.take(2))
        )
      )
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    })
    // Only one Ping, at the start; three Pongs after it. The override answers a
    // filtered page the way gRPC does: `endCursor` at the last *match*, and
    // `null` for an empty final page, so only the head read can move it.
    const layer = overFake(
      { transactions: { ...ledger(2, 2), ...ledger(3, 3), ...ledger(5, 5), ...ledger(7, 7) } },
      (core) => ({
        listEvents: (options) =>
          options.filter === undefined
            ? core.listEvents(options)
            : Effect.map(core.listEvents(options), (page) => ({
              ...page,
              endCursor: page.events.length === 0 ? null : page.startCursor
            }))
      })
    )
    const pages = await Effect.runPromise(
      Effect.provide(program, Layer.merge(layer, TestClock.layer()), { local: true })
    )
    expect(pages[0]?.items.map((entry) => entry.eventType)).toEqual([Ping] as never)
    // The second page is empty and exists only to move the cursor to the head:
    // the newest event's position, so a pruning node cannot prune past it.
    expect(pages[1]?.items).toHaveLength(0)
    expect(pages[1]?.endCursor).toBe("3")
  })

  test("a tail retries a retryable failure from its last cursor instead of ending", async () => {
    let failures = 0
    const layer = overFake({ transactions: ledger(1, 3), pageSize: 1 }, (core) => ({
      listEvents: (options) =>
        Effect.suspend(() => {
          // Fail the second request (the one after the first page) twice.
          if (options.after === "0" && failures < 2) {
            failures += 1
            return Effect.fail(
              new TransportError({ method: "listEvents", retryable: true, status: "UNAVAILABLE", cause: "down" })
            )
          }
          return core.listEvents(options)
        })
    }))
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const fiber = yield* Effect.forkChild(
        collect(sui.tailEvents(undefined, { poll: "1 second" }).pipe(Stream.take(3)))
      )
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    })
    const events = await Effect.runPromise(
      Effect.provide(program, Layer.merge(layer, TestClock.layer()), { local: true })
    )
    expect(failures).toBe(2)
    expect(events.map((entry) => entry.transactionDigest)).toEqual(
      [fakeDigest(1), fakeDigest(2), fakeDigest(3)] as never
    )
  })

  test("tailTransactions follows the transaction ledger and refuses a module filter", async () => {
    const program = Effect.gen(function*() {
      const sui = yield* Sui
      const refused = yield* Effect.exit(collect(sui.tailTransactions({ function: PKG }).pipe(Stream.take(1))))
      const fiber = yield* Effect.forkChild(collect(sui.tailTransactions({ sender: SuiAddress.make(ALICE) }).pipe(Stream.take(2))))
      yield* TestClock.adjust("1 second")
      yield* SuiTest.recordTransaction(fakeDigest(2), FakeOutcome.succeed({ sender: ALICE }))
      yield* TestClock.adjust("1 second")
      return { refused, items: yield* Fiber.join(fiber) }
    })
    const { refused, items } = await Effect.runPromise(
      Effect.provide(
        program,
        Layer.merge(layerTest({ chainId: CHAIN_ID, transactions: ledger(1, 1) }), TestClock.layer()),
        { local: true }
      )
    )
    expect(Exit.isFailure(refused) && Cause.hasDies(refused.cause)).toBe(true)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item._tag === "Success")).toBe(true)
  })
})

describe("indexer#4: SuiCore.getServiceInfo", () => {
  test("reads gRPC LedgerService.GetServiceInfo, lowest available checkpoint included", async () => {
    const client = stubClient({}, {
      ledgerService: {
        getServiceInfo: async () => ({
          response: {
            chainId: CHAIN_ID,
            epoch: 7n,
            checkpointHeight: 120n,
            lowestAvailableCheckpoint: 80n,
            timestamp: { seconds: 2n, nanos: 5_000_000 }
          }
        })
      }
    })
    const info = await Effect.runPromise(
      Effect.flatMap(core, (core) => core.getServiceInfo()).pipe(
        Effect.provide(SuiCore.layerFromClient(client))
      )
    )
    expect(info).toEqual({
      chainId: CHAIN_ID,
      epoch: 7n,
      checkpointHeight: 120n,
      lowestAvailableCheckpoint: 80n,
      timestampMs: 2005
    })
  })

  test("a transport without it fails UNIMPLEMENTED, not retryable", async () => {
    const error = await run(
      Effect.flatMap(core, (core) => Effect.flip(core.getServiceInfo()))
    )
    expect(error.status).toBe("UNIMPLEMENTED")
    expect(error.retryable).toBe(false)
  })
})

describe("indexer#13: SuiNS on a network without it", () => {
  test("UNIMPLEMENTED is None from both Option faces", async () => {
    const unimplemented = Effect.fail(
      new TransportError({ method: "ns", retryable: false, status: "UNIMPLEMENTED", cause: "SuiNS not configured" })
    )
    const [address, name] = await Effect.runPromise(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.resolveNameServiceAddressOption("alice.sui"),
          yield* sui.defaultNameServiceNameOption(SuiAddress.make(ALICE))
        ] as const
      }).pipe(
        Effect.provide(
          overFake({}, () => ({
            resolveNameServiceAddress: () => unimplemented,
            defaultNameServiceName: () => unimplemented
          }))
        )
      )
    )
    expect(Option.isNone(address)).toBe(true)
    expect(Option.isNone(name)).toBe(true)
  })
})

describe("move#7 / move#8: dynamic-field keys and decoded values", () => {
  const PARENT = PADDED("aa")
  const PostKeyBcs = suiBcs.struct("PostKey", { index: suiBcs.u64() })
  const POST_KEY = `${PKG}::board::PostKey`
  const PostBcs = suiBcs.struct("Post", { author: suiBcs.Address, likes: suiBcs.u64() })
  const POST = `${PKG}::board::Post`
  const Post = bcs(PostBcs, POST)
  const keyBytes = PostKeyBcs.serialize({ index: 0 }).toBytes()
  const script: FakeScript = {
    dynamicFields: {
      [PARENT]: [{
        fieldId: PADDED("f0"),
        type: `0x2::dynamic_field::Field<${POST_KEY}, ${POST}>`,
        name: { type: POST_KEY, bcs: keyBytes },
        valueType: POST,
        $kind: "DynamicField"
      }]
    },
    dynamicFieldValues: {
      [PADDED("f0")]: { type: POST, bcs: PostBcs.serialize({ author: ALICE, likes: 3 }).toBytes() }
    }
  }

  test("SuiSchema.name builds the same key from a codec or from a layout and its input form", () => {
    const fromLayout = SuiSchema.name(PostKeyBcs, POST_KEY, { index: 0 })
    const fromCodec = SuiSchema.name(bcs(PostKeyBcs, POST_KEY), { index: "0" })
    expect(fromLayout).toEqual({ type: POST_KEY, bcs: keyBytes })
    expect(fromCodec).toEqual(fromLayout)
    // The type is normalized.
    expect(SuiSchema.name(suiBcs.u64(), "u64", 7).type).toBe("u64")
    expect(SuiSchema.name(PostKeyBcs, "0xabc::board::PostKey", { index: 0 }).type).toBe(POST_KEY)
    // A codec with no Move type cannot name a key.
    expect(() => SuiSchema.name(bcs(PostKeyBcs), { index: "0" })).toThrow("carries no Move type")
  })

  test("getDynamicFieldOption with a schema decodes the value after checking its type", async () => {
    const [found, missing, wrong, raw] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const key = SuiSchema.name(PostKeyBcs, POST_KEY, { index: 0 })
        return [
          yield* sui.getDynamicFieldOption(ObjectId.make(PARENT), key, { schema: Post }),
          yield* sui.getDynamicFieldOption(
            ObjectId.make(PARENT),
            SuiSchema.name(PostKeyBcs, POST_KEY, { index: 1 }),
            { schema: Post }
          ),
          yield* sui.getDynamicFieldOption(ObjectId.make(PARENT), key, {
            schema: bcs(PostBcs, `${PKG}::board::Other`)
          }).pipe(Effect.flip),
          yield* sui.getDynamicFieldOption(ObjectId.make(PARENT), key)
        ] as const
      }),
      script
    )
    const field = Option.getOrThrow(found)
    expect(field.content.likes).toBe("3")
    expect(field.fieldId).toBe(ObjectId.make(PADDED("f0")))
    expect(Option.isNone(missing)).toBe(true)
    expect(wrong._tag).toBe("DecodeError")
    if (wrong._tag === "DecodeError") expect(wrong.kind).toBe("type")
    expect(Option.getOrThrow(raw).value.bcs.length).toBeGreaterThan(0)
  })
})

describe("move#12: a package object", () => {
  test("has an empty content array, not undefined", async () => {
    const packageObject = {
      objectId: PKG,
      version: "1",
      digest: fakeDigest(5),
      owner: { $kind: "Immutable", Immutable: true },
      type: "package",
      content: undefined
    }
    const object = await Effect.runPromise(
      Effect.flatMap(sui, (sui) => sui.getObject(ObjectId.make(PKG))).pipe(
        Effect.provide(
          overFake({}, () => ({
            getObject: () => Effect.succeed({ object: packageObject }) as never
          }))
        )
      )
    )
    expect(object.type).toBe("package")
    expect(object.content).toBeInstanceOf(Uint8Array)
    expect(object.content).toHaveLength(0)
  })
})

describe("type-level: Executed.balanceChange takes a plain string", () => {
  test("compiles with a string literal", () => {
    const signature: (address: SuiAddress, coinType: string) => bigint = Executed.prototype.balanceChange
    expect(typeof signature).toBe("function")
    expect(typeof makeFromClient).toBe("function")
  })
})
