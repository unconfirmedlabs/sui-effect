/**
 * `Sui`, the convenience tier: decoded reads, the chain-id rules, batch
 * integrity, pagination, tails, simulate and view. Objects come from the
 * scripted responder; a method whose answer is the point of a test is stubbed.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Cause, Effect, Exit, Fiber, Layer, Option, Result, Stream } from "effect"
import { TestClock } from "effect/testing"
import { bcs } from "../src/domain/bcs.ts"
import { ObjectDeleted } from "../src/domain/errors.ts"
import { KNOWN_CHAIN_IDS, ObjectId, StructTag, SuiAddress } from "../src/domain/schemas.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { DEFAULT_CHAIN_ID, fakeDigest, FakeOutcome, ScriptedSuiCore, SuiTest } from "../src/testing.ts"
import { bytes, digestOf, fail, resultOf, run, sequence, signer, type Stubs, transport } from "./support.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = SuiAddress.make(PADDED("a11ce"))
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
const Escrow = bcs(EscrowBcs, ESCROW_TYPE)
const escrow = (suffix: string, amount: string) => ({
  objectId: PADDED(suffix),
  type: ESCROW_TYPE,
  version: 3n,
  owner: { $kind: "AddressOwner" as const, AddressOwner: ALICE },
  content: EscrowBcs.serialize({ id: PADDED(suffix), amount }).toBytes()
})
const objects = [escrow("e1", "5"), escrow("e2", "7")]
const id = (suffix: string) => ObjectId.make(PADDED(suffix))
const collect = <A, E, R>(stream: Stream.Stream<A, E, R>) => Effect.map(Stream.runCollect(stream), (chunk) => [...chunk])
const sui = Sui

/** A stub of one list method over a fixed (or growing) list, `limit` per page, cursors as indexes. */
const pager = <A>(items: () => ReadonlyArray<A>, key: string, limit = 2) => {
  const calls: Array<Record<string, unknown>> = []
  const stub = (options: Record<string, unknown> = {}) =>
    Effect.sync(() => {
      calls.push(options)
      const all = items()
      const after = options["after"] ?? options["cursor"]
      const start = after === undefined || after === null ? 0 : Number(after) + 1
      const page = all.slice(start, start + ((options["limit"] as number | undefined) ?? limit))
      const end = start + page.length
      return {
        [key]: page,
        hasNextPage: end < all.length,
        cursor: end < all.length ? String(end - 1) : null,
        startCursor: page.length > 0 ? String(start) : null,
        endCursor: page.length > 0 ? String(end - 1) : null
      }
    })
  return { stub: stub as never, calls }
}

const event = (n: number, type = `${PADDED("b0a")}::game::Ping`): SuiClientTypes.EventEntry => ({
  packageId: PADDED("b0a"),
  module: "game",
  sender: ALICE,
  eventType: type,
  bcs: suiBcs.U64.serialize(n).toBytes(),
  json: null,
  checkpoint: String(n),
  transactionDigest: fakeDigest(n),
  eventIndex: 0
} as unknown as SuiClientTypes.EventEntry)

describe("the layer", () => {
  test("reads the chain id once; mainnet and testnet must report theirs", async () => {
    const calls = await run(Effect.flatMap(sui, (s) => Effect.as(SuiTest.calls("getChainIdentifier"), s.chainId)), { objects })
    expect(calls).toBe(DEFAULT_CHAIN_ID)
    const mainnet = (chainId: string) =>
      Effect.runPromise(Effect.flip(Effect.provide(sui, Sui.layerNoDeps.pipe(Layer.provide(ScriptedSuiCore.layer({ network: "mainnet", chainId }))))))
    expect(KNOWN_CHAIN_IDS["mainnet"]).toBe(DEFAULT_CHAIN_ID)
    expect(await mainnet(fakeDigest(99))).toMatchObject({ _tag: "NetworkMismatch", expected: DEFAULT_CHAIN_ID, actual: fakeDigest(99) })
  })

  test("an explicit chainId is asserted on any network; localnet records what it observes", async () => {
    const layered = (chainId: string, network: SuiClientTypes.Network, expected?: string) =>
      Effect.runPromise(Effect.exit(Effect.map(sui, (s) => s.chainId).pipe(
        Effect.provide((expected === undefined ? Sui.layerNoDeps : Sui.layerNoDepsWith({ chainId: expected })).pipe(
          Layer.provide(ScriptedSuiCore.layer({ network, chainId }))
        ))
      )))
    expect(await layered(fakeDigest(77), "localnet")).toEqual(Exit.succeed(fakeDigest(77)))
    expect(await layered(fakeDigest(77), "mainnet", fakeDigest(77))).toEqual(Exit.succeed(fakeDigest(77)))
    expect(Exit.isFailure(await layered(fakeDigest(77), "localnet", fakeDigest(99)))).toBe(true)
  })
})

describe("object reads", () => {
  test("getObject decodes with the schema after checking the type, asking for the fixed include set", async () => {
    const [object, call] = await run(Effect.gen(function*() {
      const object = yield* (yield* sui).getObject(id("e1"), { schema: Escrow })
      return [object, (yield* SuiTest.calls("getObjects"))[0]] as const
    }), { objects })
    expect(object.content.amount).toBe("5")
    expect(call?.options).toMatchObject({ include: { content: true } })
  })

  test("a schema for another type is DecodeError { type }; an expectedType overrides the codec's", async () => {
    const other = bcs(EscrowBcs, "0x2::other::Thing")
    const wrong = await fail(Effect.flatMap(sui, (s) => s.getObject(id("e1"), { schema: other })), { objects })
    expect([wrong._tag, wrong._tag === "DecodeError" && wrong.kind]).toEqual(["DecodeError", "type"])
    const overridden = await run(Effect.flatMap(sui, (s) => s.getObject(id("e1"), { schema: other, expectedType: ESCROW_TYPE })), { objects })
    expect(overridden.content.amount).toBe("5")
  })

  test("a bare codec decodes an instantiation; an expectedType with type arguments is compared in full", async () => {
    const GENERIC = `${PADDED("c0de")}::composition::Composition`
    const Composition = bcs(suiBcs.struct("Composition", { id: suiBcs.Address }), GENERIC)
    const instance = { objectId: PADDED("c1"), type: `${GENERIC}<0x2::sui::SUI>`, version: 1n, content: suiBcs.Address.serialize(PADDED("c1")).toBytes() }
    const object = await run(Effect.flatMap(sui, (s) => s.getObject(id("c1"), { schema: Composition })), { objects: [instance] })
    expect(object.type).toBe(StructTag.normalize(instance.type))
    const refused = await fail(Effect.flatMap(sui, (s) => s.getObject(id("c1"), { schema: Composition, expectedType: `${GENERIC}<u64>` })), { objects: [instance] })
    expect(refused._tag).toBe("DecodeError")
  })

  test("a package object is readable: its type is the literal `package`", async () => {
    const pkg = { objectId: PADDED("9ac"), type: "package", version: 1n, owner: { $kind: "Immutable" as const, Immutable: true as const }, content: new Uint8Array([1, 2, 3]) }
    const object = await run(Effect.flatMap(sui, (s) => s.getObject(id("9ac"))), { objects: [pkg] })
    expect([object.type, object.ref.type, Array.from(object.content)]).toEqual(["package", "package", [1, 2, 3]] as never)
  })

  test("getObjectOption is None for a missing or deleted object", async () => {
    const deleted: Stubs = { getObject: (() => Effect.fail(new ObjectDeleted({ objectId: id("e1") }))) as never }
    expect(Option.isNone(await run(Effect.flatMap(sui, (s) => s.getObjectOption(id("dead")))))).toBe(true)
    expect(Option.isNone(await run(Effect.flatMap(sui, (s) => s.getObjectOption(id("e1"))), { objects }, deleted))).toBe(true)
  })

  test("getObjects: one Result per id asked, in order, deduplicated and normalized on the wire", async () => {
    const [results, requested] = await run(Effect.gen(function*() {
      const results = yield* (yield* sui).getObjects([id("e1"), id("dead"), "0xe2" as ObjectId, id("e1")], { schema: Escrow })
      return [results, (yield* SuiTest.calls("getObjects"))[0]?.options] as const
    }), { objects })
    expect(results.map((r) => Result.isSuccess(r) ? r.success.content.amount : r.failure._tag)).toEqual(["5", "ObjectNotFound", "7", "5"])
    expect((requested as { objectIds: Array<string> }).objectIds).toHaveLength(3)
  })

  test("getObjects reads in chunks of 50", async () => {
    const many = Array.from({ length: 120 }, (_, i) => escrow((i + 0x100).toString(16), String(i)))
    const sizes = await run(Effect.gen(function*() {
      yield* (yield* sui).getObjects(many.map((o) => ObjectId.make(o.objectId)))
      return (yield* SuiTest.calls("getObjects")).map((call) => (call.options as { objectIds: Array<string> }).objectIds.length)
    }), { objects: many })
    expect(sizes).toEqual([50, 50, 20])
  })

  test("an answer for another id, or for too few, fails the whole read", async () => {
    const answering = (answer: ReadonlyArray<unknown>): Stubs => ({ getObjects: (() => Effect.succeed({ objects: answer })) as never })
    const other = await fail(Effect.flatMap(sui, (s) => s.getObjects([id("e1")])), {}, answering([{ ...escrow("e2", "7"), version: "3" }]))
    expect([other._tag, String(other.cause)]).toEqual(["TransportError", expect.stringContaining("answered for")])
    const short = await fail(Effect.flatMap(sui, (s) => s.getObjects([id("e1")])), {}, answering([]))
    expect(short._tag === "TransportError" && short.retryable).toBe(false)
  })

  test("getObjectsStrict answers in order, or fails with the first item error", async () => {
    const found = await run(Effect.flatMap(sui, (s) => s.getObjectsStrict([id("e2"), id("e1")], { schema: Escrow })), { objects })
    expect(found.map((o) => o.content.amount)).toEqual(["7", "5"])
    expect((await fail(Effect.flatMap(sui, (s) => s.getObjectsStrict([id("e1"), id("dead")])), { objects }))._tag).toBe("ObjectNotFound")
  })

  test("chainTime decodes the Clock object and is never cached", async () => {
    const times = await run(Effect.gen(function*() {
      const s = yield* sui
      const first = yield* s.chainTime
      yield* SuiTest.setClock(2_000n)
      return [first, yield* s.chainTime].map((t) => t.epochMilliseconds)
    }), { clockTimestampMs: 1_000n })
    expect(times).toEqual([1_000, 2_000])
  })

  test("getBalance decodes amounts as bigints and takes a plain coin type", async () => {
    const balance = await run(Effect.flatMap(sui, (s) => s.getBalance(ALICE, "0x2::sui::SUI")), { addressBalances: [{ owner: ALICE, amount: 4n }] })
    expect([balance.addressBalance, balance.coinBalance, balance.balance]).toEqual([4n, 0n, 4n] as never)
  })
})

describe("dynamic fields", () => {
  const PARENT = PADDED("aa")
  const Post = bcs(suiBcs.struct("Post", { likes: suiBcs.u64() }), `${PADDED("b0a")}::board::Post`)
  const name = { type: "u64", bcs: suiBcs.u64().serialize(7).toBytes() }
  const script = {
    dynamicFields: {
      [PARENT]: [
        { $kind: "DynamicField" as const, fieldId: PADDED("f0"), type: `0x2::dynamic_field::Field<u64, ${PADDED("b0a")}::board::Post>`, name, valueType: `${PADDED("b0a")}::board::Post` },
        { $kind: "DynamicObject" as const, fieldId: PADDED("f1"), type: "0x2::dynamic_field::Field<u8, ID>", name: { type: "u8", bcs: new Uint8Array([1]) }, valueType: "ID", childId: PADDED("e1") }
      ]
    },
    dynamicFieldValues: { [PADDED("f0")]: { type: `${PADDED("b0a")}::board::Post`, bcs: suiBcs.u64().serialize(3).toBytes() } },
    objects
  }

  test("getDynamicFieldOption decodes the value after checking its type, and is None when absent", async () => {
    const [found, wrong, missing] = await run(Effect.gen(function*() {
      const s = yield* sui
      return [
        yield* s.getDynamicFieldOption(ObjectId.make(PARENT), name, { schema: Post }),
        yield* Effect.flip(s.getDynamicFieldOption(ObjectId.make(PARENT), name, { schema: Escrow })),
        yield* s.getDynamicFieldOption(ObjectId.make(PARENT), { type: "u64", bcs: new Uint8Array(8) })
      ] as const
    }), script)
    expect(Option.getOrThrow(found).content).toEqual({ likes: "3" })
    expect(wrong._tag === "DecodeError" && wrong.kind).toBe("type")
    expect(Option.isNone(missing)).toBe(true)
  })

  test("getDynamicObjectFieldOption decodes the child object", async () => {
    const child = await run(Effect.flatMap(sui, (s) => s.getDynamicObjectFieldOption(ObjectId.make(PARENT), { type: "u8", bcs: new Uint8Array([1]) }, { schema: Escrow })), script)
    expect(Option.getOrThrow(child).content.amount).toBe("5")
  })
})

describe("streams", () => {
  test("streamOwnedObjects follows hasNextPage, passing the type filter and the include set", async () => {
    const owned = pager(() => [escrow("f1", "1"), escrow("f2", "2"), escrow("f3", "3")].map((o) => ({ ...o, version: "3", digest: fakeDigest(1) })), "objects")
    const items = await run(Effect.flatMap(sui, (s) => collect(s.streamOwnedObjects(ALICE, { type: StructTag.make(ESCROW_TYPE) }))), {}, { listOwnedObjects: owned.stub })
    expect(items.map((o) => o.id)).toEqual([id("f1"), id("f2"), id("f3")])
    expect(owned.calls).toHaveLength(2)
    expect(owned.calls[0]).toMatchObject({ include: { content: true }, type: ESCROW_TYPE })
  })

  test("streamEvents continues past an empty page that has a next page, and normalizes a full eventType", async () => {
    const pages = sequence([
      () => Effect.succeed({ events: [event(1)], hasNextPage: true, endCursor: "0" }),
      () => Effect.succeed({ events: [], hasNextPage: true, endCursor: "5" }),
      () => Effect.succeed({ events: [event(2)], hasNextPage: false, endCursor: "6" })
    ])
    const items = await run(Effect.flatMap(sui, (s) => collect(s.streamEvents({ eventType: "0x2::coin::CoinMetadata<0x2::sui::SUI>" }))), {}, { listEvents: pages.stub })
    expect(items.map((e) => e.transactionDigest)).toEqual([fakeDigest(1), fakeDigest(2)])
    expect(pages.calls[0]).toMatchObject({ filter: { eventType: `${PADDED("2")}::coin::CoinMetadata<${PADDED("2")}::sui::SUI>` } })
    expect(pages.calls.map((call) => (call as { after?: string }).after)).toEqual([undefined, "0", "5"])
  })

  test("`after` starts at a cursor; `before` reads from that cursor down, as the SDK does", async () => {
    const events = pager(() => [1, 2, 3, 4].map((n) => event(n)), "events")
    const resumed = await run(Effect.flatMap(sui, (s) => collect(s.streamEvents(undefined, { after: "1" }))), {}, { listEvents: events.stub })
    expect(resumed.map((e) => e.transactionDigest)).toEqual([fakeDigest(3), fakeDigest(4)])
    const descending = sequence([() => Effect.succeed({ events: [], hasNextPage: false, endCursor: null })])
    await run(Effect.flatMap(sui, (s) => collect(s.streamEvents(undefined, { before: "3" }))), {}, { listEvents: descending.stub })
    expect(descending.calls[0]).toEqual({ before: "3" })
  })

  test("streamTransactions yields an on-chain failure as a Result failure, with the read include set", async () => {
    const failed = { $kind: "MoveAbort", message: "x", MoveAbort: { abortCode: "3" } } as unknown as SuiClientTypes.ExecutionError
    const pages = sequence([() => Effect.succeed({ transactions: [resultOf(fakeDigest(1)), resultOf(fakeDigest(2), {}, failed)], hasNextPage: false, endCursor: "1" })])
    const items = await run(Effect.flatMap(sui, (s) => collect(s.streamTransactions({ sender: ALICE }))), {}, { listTransactions: pages.stub })
    expect(items.map((item) => item._tag)).toEqual(["Success", "Failure"])
    expect(pages.calls[0]).toMatchObject({ filter: { sender: ALICE }, include: { effects: true, bcs: true } })
  })

  test("a function filter that cannot be paginated is refused before the first request", async () => {
    const pages = sequence([() => Effect.succeed({ transactions: [], hasNextPage: false, endCursor: null })])
    const exit = await run(Effect.exit(Effect.flatMap(sui, (s) => collect(s.streamTransactions({ function: `${PADDED("b0a")}::vault` })))), {}, { listTransactions: pages.stub })
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause) && Cause.pretty(exit.cause)).toContain("package::module::function")
    expect(pages.calls).toHaveLength(0)
  })

  test("affectedAddress on a transport without the gRPC ledger is UNIMPLEMENTED, never a sender-only answer", async () => {
    const error = await fail(Effect.flatMap(sui, (s) => collect(s.streamTransactions({ affectedAddress: ALICE }))))
    expect(error._tag === "TransportError" && [error.status, error.retryable]).toEqual(["UNIMPLEMENTED", false])
  })
})

describe("tails", () => {
  const tail = <A>(stream: (s: Sui["Service"]) => Stream.Stream<A, unknown>, take: number, between: Effect.Effect<void>, stubs: Stubs) =>
    run(Effect.gen(function*() {
      const s = yield* sui
      const fiber = yield* Effect.forkChild(collect(stream(s).pipe(Stream.take(take))))
      yield* TestClock.adjust("1 second")
      yield* between
      yield* TestClock.adjust("1 second")
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }), {}, stubs)

  test("a tail follows the ledger past the point it caught up, polling", async () => {
    const ledger = [event(1), event(2)]
    const events = pager(() => ledger, "events")
    const items = await tail((s) => s.tailEvents(), 4, Effect.sync(() => ledger.push(event(3), event(4))), { listEvents: events.stub })
    expect(items.map((e) => e.transactionDigest)).toEqual([1, 2, 3, 4].map(fakeDigest))
  })

  test("a tail retries a retryable failure from its last cursor instead of ending", async () => {
    let failures = 0
    const events = pager(() => [event(1), event(2), event(3)], "events", 1)
    const flaky = (options: { readonly after?: string }) =>
      Effect.suspend(() =>
        options.after === "0" && failures < 2
          ? Effect.sync(() => failures++).pipe(Effect.andThen(Effect.fail(transport("listEvents", "UNAVAILABLE", true))))
          : (events.stub as (o: unknown) => Effect.Effect<unknown>)(options)
      )
    const items = await tail((s) => s.tailEvents(undefined, { poll: "1 second" }), 3, Effect.void, { listEvents: flaky as never })
    expect(failures).toBe(2)
    expect(items).toHaveLength(3)
  })

  test("a caught-up filtered tail moves its cursor to the unfiltered head, read before the page", async () => {
    const afters: Array<unknown> = []
    const listEvents = (options: { readonly filter?: unknown; readonly after?: string; readonly order?: string }) =>
      Effect.sync(() => {
        if (options.order === "descending") return { events: [event(9)], hasNextPage: true, startCursor: "8", endCursor: "8" }
        afters.push(options.after)
        return afters.length === 1
          ? { events: [event(1)], hasNextPage: false, startCursor: "0", endCursor: "0" }
          : { events: [], hasNextPage: false, startCursor: null, endCursor: null }
      })
    await run(Effect.gen(function*() {
      const s = yield* sui
      const fiber = yield* Effect.forkChild(collect(s.tailEvents({ eventType: `${PADDED("b0a")}::game::Ping` })))
      for (let i = 0; i < 3; i++) yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)
    }), {}, { listEvents: listEvents as never })
    expect(afters.slice(0, 3)).toEqual([undefined, "0", "8"])
  })
})

describe("simulate and view", () => {
  const U64 = bcs(suiBcs.U64, "u64")
  const results = (...values: ReadonlyArray<number>) =>
    FakeOutcome.succeed({ commandResults: values.map((v) => ({ returnValues: [{ bcs: suiBcs.U64.serialize(v).toBytes() }] })) })

  test("simulate asks for the fixed include set with checks enabled; view decodes a return value with checks off", async () => {
    const [simulation, last, first, calls] = await run(Effect.gen(function*() {
      const s = yield* sui
      return [yield* s.simulate(() => {}), yield* s.view(() => {}, U64), yield* s.view(() => {}, suiBcs.U64, { command: 0 }), yield* SuiTest.calls("simulateTransaction")] as const
    }), { simulate: [results(1, 42)] })
    expect(simulation.effects.status.success).toBe(true)
    expect([last, first]).toEqual(["42", "1"])
    expect(calls[0]?.options).toMatchObject({
      include: { effects: true, events: true, balanceChanges: true, objectTypes: true, commandResults: true },
      checksEnabled: true
    })
    expect(calls[1]?.options).toMatchObject({ checksEnabled: false })
  })

  test("an on-chain failure is SimulationFailed, a throwing recipe BuildError, a missing return value DecodeError", async () => {
    const aborted = FakeOutcome.failWith({ $kind: "MoveAbort", message: "x", command: 0, MoveAbort: { abortCode: "3" } } as unknown as SuiClientTypes.ExecutionError)
    expect((await fail(Effect.flatMap(sui, (s) => s.simulate(() => {})), { simulate: [aborted] }))._tag).toBe("SimulationFailed")
    expect((await fail(Effect.flatMap(sui, (s) => s.simulate(() => {
      throw new Error("bad recipe")
    })), { simulate: [results()] }))._tag).toBe("BuildError")
    expect((await fail(Effect.flatMap(sui, (s) => s.view(() => {}, U64)), { simulate: [results()] }))._tag).toBe("DecodeError")
  })

  test("a reply whose top-level and effects digests differ is a TransportError", async () => {
    const twoDigests: Stubs = {
      simulateTransaction: (() => {
        const result = resultOf(fakeDigest(53)) as { Transaction: { effects: object } }
        return Effect.succeed({ ...result, Transaction: { ...result.Transaction, effects: { ...result.Transaction.effects, transactionDigest: fakeDigest(54) } }, commandResults: [] })
      }) as never
    }
    const error = await fail(Effect.flatMap(sui, (s) => s.simulate(() => {})), {}, twoDigests)
    expect([error._tag, String(error._tag === "TransportError" && error.cause)]).toEqual(["TransportError", expect.stringContaining(fakeDigest(54))])
  })
})

describe("getTransaction", () => {
  test("an Executed with the execute include set, ExecutionFailed for an on-chain failure, TransactionNotFound for none", async () => {
    const answers = sequence<unknown, never>([
      () => Effect.succeed(resultOf(fakeDigest(31), { created: [{ objectId: PADDED("4ece"), type: "0x2::escrow::Receipt" }] })),
      () => Effect.succeed(resultOf(fakeDigest(32), {}, { $kind: "MoveAbort", message: "x", MoveAbort: { abortCode: "3" } } as never))
    ])
    const [executed, failed, missing] = await run(Effect.gen(function*() {
      const s = yield* sui
      return [
        yield* s.getTransaction(fakeDigest(31)),
        yield* Effect.flip(s.getTransaction(fakeDigest(32))),
        yield* Effect.flip(Effect.provideService(s.getTransaction(fakeDigest(33)), SuiCore, s.core))
      ] as const
    }), {}, { getTransaction: answers.stub })
    expect(executed.created("0x2::escrow::Receipt")).toHaveLength(1)
    expect(answers.calls[0]).toMatchObject({ include: { effects: true, events: true, balanceChanges: true, objectTypes: true } })
    expect(failed._tag).toBe("ExecutionFailed")
    expect(missing._tag).toBe("ExecutionFailed")
    expect((await fail(Effect.flatMap(sui, (s) => s.getTransaction(fakeDigest(33)))))._tag).toBe("TransactionNotFound")
  })
})

describe("Executed.sender on a read", () => {
  test("getTransaction asks for the transaction's bcs and reads the sender out of it", async () => {
    const raw = await bytes()
    const withBcs = (() => {
      const result = resultOf(digestOf(raw)) as { Transaction: object }
      return { ...result, Transaction: { ...result.Transaction, bcs: raw } }
    })()
    const read = sequence([() => Effect.succeed(withBcs)])
    const executed = await run(Effect.flatMap(sui, (s) => s.getTransaction(digestOf(raw))), {}, { getTransaction: read.stub })
    expect(read.calls[0]).toMatchObject({ include: { bcs: true } })
    expect(executed.sender).toBe(signer.address)
  })
})

describe("name service and coin metadata", () => {
  test("UNIMPLEMENTED or NOT_FOUND is None from the Option faces", async () => {
    const none: Stubs = {
      resolveNameServiceAddress: (() => Effect.fail(transport("resolveNameServiceAddress", "UNIMPLEMENTED"))) as never,
      defaultNameServiceName: (() => Effect.fail(transport("defaultNameServiceName", "NOT_FOUND"))) as never
    }
    const [address, name] = await run(Effect.gen(function*() {
      const s = yield* sui
      return [yield* s.resolveNameServiceAddressOption("alice.sui"), yield* s.defaultNameServiceNameOption(ALICE)] as const
    }), {}, none)
    expect([Option.isNone(address), Option.isNone(name)]).toEqual([true, true])
  })

  test("getCoinMetadataOption is Some for a known type and None for one with no metadata", async () => {
    const metadata = { id: PADDED("ee"), decimals: 9, name: "Sui", symbol: "SUI", description: "", iconUrl: null }
    const stub: Stubs = {
      getCoinMetadata: ((options: { coinType: string }) =>
        Effect.succeed({ coinMetadata: options.coinType.endsWith("::sui::SUI") ? metadata : null })) as never
    }
    const [sui_, other] = await run(Effect.gen(function*() {
      const s = yield* sui
      return [yield* s.getCoinMetadataOption("0x2::sui::SUI"), yield* s.getCoinMetadataOption("0x2::other::X")] as const
    }), {}, stub)
    expect([Option.getOrThrow(sui_).decimals, Option.isNone(other)]).toEqual([9, true])
  })
})
