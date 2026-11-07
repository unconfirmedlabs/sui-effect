/**
 * `@unconfirmed/sui-effect/testing`: what the scripted responder answers, what
 * it refuses to answer, and the layers built on it. It serves plain values
 * and the scripted execute/simulate answers; it never applies a transaction.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCore } from "../src/services/SuiCore.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, FakeOutcome, type FakeScript, layerTest, ScriptedSuiCore, SuiTest } from "../src/testing.ts"
import { bytes, digestOf, signer } from "./support.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const OWNER = SuiAddress.make(PADDED("a11ce"))
const THING = `${PADDED("b0a")}::thing::Thing`
const thing = (suffix: string, type = THING) => ({
  objectId: PADDED(suffix),
  type,
  version: 4n,
  owner: { $kind: "AddressOwner" as const, AddressOwner: OWNER },
  content: new Uint8Array([1, 2, 3]),
  json: { a: 1 }
})
const on = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore | ScriptedSuiCore>, script: FakeScript = {}) =>
  Effect.runPromise(SuiTest.provide(layerTest(script))(effect))
const exitOn = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCore | ScriptedSuiCore>, script: FakeScript = {}) =>
  Effect.runPromise(Effect.exit(SuiTest.provide(layerTest(script))(effect)))
const core = SuiCore

describe("reads it serves", () => {
  test("an object with its exact type and bytes; json and display only when asked for; a missing one is ObjectNotFound", async () => {
    const [plain, withJson, missing] = await on(Effect.gen(function*() {
      const c = yield* core
      return [
        (yield* c.getObject({ objectId: PADDED("e1"), include: { content: true } })).object,
        (yield* c.getObject({ objectId: PADDED("e1"), include: { json: true, display: true } })).object,
        yield* Effect.flip(c.getObject({ objectId: PADDED("e2") }))
      ] as const
    }), { objects: [thing("e1")] })
    expect([plain.type, Array.from(plain.content as Uint8Array), plain.json]).toEqual([THING, [1, 2, 3], undefined] as never)
    expect([withJson.json, withJson.display]).toEqual([{ a: 1 }, null] as never)
    expect(missing._tag).toBe("ObjectNotFound")
  })

  test("owned objects by owner, filtered by type under the one Move type rule", async () => {
    const generic = thing("e2", `${THING}<0x2::sui::SUI>`)
    const listed = await on(Effect.gen(function*() {
      const c = yield* core
      return [
        (yield* c.listOwnedObjects({ owner: OWNER, type: THING })).objects.map((o) => o.objectId),
        (yield* c.listOwnedObjects({ owner: PADDED("b0b") })).objects.length
      ] as const
    }), { objects: [thing("e1"), generic, thing("e3", `${PADDED("b0a")}::thing::Other`)] })
    expect(listed).toEqual([[PADDED("e1"), PADDED("e2")], 0])
  })

  test("a dynamic field matched on the key's type and bytes; one scripted without bytes matches any key of its type", async () => {
    const PARENT = PADDED("aa")
    const field = (fieldId: string, key?: Uint8Array) => ({
      $kind: "DynamicField" as const,
      fieldId: PADDED(fieldId),
      type: `0x2::dynamic_field::Field<${PADDED("2")}::object::ID, u64>`,
      name: { type: `${PADDED("2")}::object::ID`, ...(key === undefined ? {} : { bcs: key }) },
      valueType: "u64"
    }) as never
    const one = bcs.Address.serialize(PADDED("1")).toBytes()
    const two = bcs.Address.serialize(PADDED("2")).toBytes()
    const script: FakeScript = {
      dynamicFields: { [PARENT]: [field("f1", one), field("f2", two)], [PADDED("bb")]: [field("f3")] },
      dynamicFieldValues: { [PADDED("f2")]: { type: "u64", bcs: bcs.u64().serialize(9).toBytes() } }
    }
    const found = await on(Effect.gen(function*() {
      const c = yield* core
      const get = (parentId: string, key: Uint8Array) => Effect.map(c.getDynamicField({ parentId, name: { type: "0x2::object::ID", bcs: key } }), (r) => r.dynamicField)
      return [
        (yield* get(PARENT, two)).fieldId,
        Array.from((yield* get(PARENT, two)).value.bcs),
        (yield* get(PADDED("bb"), one)).fieldId,
        (yield* Effect.flip(get(PARENT, new Uint8Array(32))))._tag,
        (yield* c.listDynamicFields({ parentId: PARENT })).dynamicFields.length
      ] as const
    }), script)
    expect(found).toEqual([PADDED("f2"), [9, 0, 0, 0, 0, 0, 0, 0], PADDED("f3"), "ObjectNotFound", 2])
  })

  test("address balances, coins as the Coin<T> objects among the objects, and the clock", async () => {
    const [balance, coins, set, time] = await on(Effect.gen(function*() {
      const sui = yield* Sui
      const balance = yield* sui.getBalance(OWNER)
      const coins = (yield* (yield* core).listCoins({ owner: OWNER })).objects.map((c) => c.balance)
      yield* SuiTest.setAddressBalance(OWNER, 600n)
      yield* SuiTest.setClock(2_000n)
      return [balance, coins, yield* sui.getBalance(OWNER), yield* sui.chainTime] as const
    }), { addressBalances: [{ owner: OWNER, amount: 4n }], objects: [fakeCoin({ objectId: "0xc1", owner: OWNER, balance: 50n })] })
    expect([balance.addressBalance, balance.coinBalance, balance.balance]).toEqual([4n, 50n, 54n] as never)
    expect(coins).toEqual(["50"])
    expect(set.addressBalance).toBe(600n as never)
    expect(time.epochMilliseconds).toBe(2_000)
  })
})

describe("answers it gives only when scripted", () => {
  const executeBytes = (transaction: Uint8Array) => Effect.flatMap(core, (c) => c.executeTransaction({ transaction, signatures: [], include: { effects: true } }))

  test("execute answers in order, the last repeating, each stamped with the digest of the bytes it was handed; getTransaction serves them", async () => {
    const first = await bytes()
    const second = await bytes({ nonce: 9 })
    const [a, b, c, read] = await on(Effect.gen(function*() {
      const a = yield* Effect.flip(executeBytes(first))
      const b = yield* executeBytes(first)
      const c = yield* executeBytes(second)
      return [a, b, c, yield* (yield* core).getTransaction({ digest: digestOf(second) })] as const
    }), { execute: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()] })
    expect([a._tag, a._tag === "TransportError" && a.status]).toEqual(["TransportError", "UNAVAILABLE"])
    expect([b.Transaction?.digest, c.Transaction?.digest, read.Transaction?.digest]).toEqual([digestOf(first), digestOf(second), digestOf(second)])
  })

  test("a failure answer is a FailedTransaction; a hang answers nothing until the caller gives up", async () => {
    const raw = await bytes()
    const failed = await on(executeBytes(raw), { execute: [FakeOutcome.failWith({ $kind: "MoveAbort", MoveAbort: { abortCode: 3n, location: { module: "m" } } } as never)] })
    expect(failed.$kind).toBe("FailedTransaction")
    const hung = await on(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.timeout(executeBytes(raw), "1 second"))
      yield* TestClock.adjust("2 seconds")
      return yield* Fiber.await(fiber)
    }), { execute: [FakeOutcome.hang()] })
    expect(Exit.isFailure(hung)).toBe(true)
  })

  test("anything unscripted dies naming the method — never a silent pass", async () => {
    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = await Promise.all<Exit.Exit<unknown, unknown>>([
      exitOn(executeBytes(await bytes())),
      exitOn(Effect.flatMap(core, (c) => c.getCoinMetadata({ coinType: "0x2::sui::SUI" }))),
      exitOn(Effect.flatMap(core, (c) => c.listEvents({})))
    ])
    const deaths = exits.map((exit) => Exit.isFailure(exit) && Cause.hasDies(exit.cause) ? Cause.pretty(exit.cause) : "")
    expect(deaths[0]).toContain("executeTransaction")
    expect(deaths[1]).toContain("getCoinMetadata")
    expect(deaths[2]).toContain("listEvents")
  })

  test("its client builds with the SDK's own resolver, and runs an SDK client extension", async () => {
    const [built, extended] = await on(Effect.gen(function*() {
      const { client } = yield* ScriptedSuiCore
      const tx = new Transaction()
      tx.setSender(signer.address)
      tx.moveCall({ target: "0x2::balance::zero", typeArguments: ["0x2::sui::SUI"] })
      const built = yield* Effect.promise(() => tx.build({ client }))
      const extended = client.$extend({ name: "probe", register: (c) => ({ network: c.network }) })
      return [TransactionDataBuilder.fromBytes(built), extended.probe.network] as const
    }), { addressBalances: [{ owner: signer.address, amount: 10_000_000_000n }], simulate: [FakeOutcome.succeed()] })
    expect([built.gasData.payment, extended]).toEqual([[], "localnet"])
  })
})

describe("the layers", () => {
  test("SuiTest.provide gives each run a fresh journal and the TestClock", async () => {
    const script: FakeScript = { addressBalances: [{ owner: signer.address, amount: 10_000_000_000n }], simulate: [FakeOutcome.succeed()], execute: [FakeOutcome.transportError("UNAVAILABLE")] }
    const unresolved = Effect.map(Effect.flatMap(Journal, (journal) => journal.listUnresolved), (entries) => entries.length)
    const first = await on(Effect.andThen(Effect.flip(Tx.run((tx) => {
      tx.moveCall({ target: "0x2::balance::zero", typeArguments: ["0x2::sui::SUI"] })
    }, { signer }).pipe(SubmitConfig.with({ resubmitAttempts: 1 }))), unresolved), script)
    const second = await on(Effect.zip(unresolved, Clock.currentTimeMillis), script)
    expect([first, second]).toEqual([1, [0, 0]])
  })

  test("a service built on Sui composes over layerTest, and the layer's own failure comes through typed", async () => {
    class Reader extends Context.Service<Reader, { readonly read: (id: ObjectId) => Effect.Effect<boolean, never> }>()("test/Reader") {
      static readonly layer = Layer.effect(Reader, Effect.map(Sui, (sui) => ({ read: (id: ObjectId) => Effect.map(Effect.orDie(sui.getObjectOption(id)), Option.isSome) })))
    }
    const found = await Effect.runPromise(Effect.flatMap(Reader, (r) => r.read(ObjectId.make(PADDED("e1")))).pipe(SuiTest.provide(Reader.layer.pipe(Layer.provideMerge(layerTest({ objects: [thing("e1")] }))))))
    expect(found).toBe(true)
    const exit = await Effect.runPromiseExit(Effect.map(Sui, (s) => s.chainId).pipe(SuiTest.provide(layerTest({ network: "mainnet", chainId: "not-the-mainnet-chain" }))))
    expect(Exit.isFailure(exit) && Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("NetworkMismatch")
  })
})
