/**
 * The recipes `docs/llms-head.md` quotes at the top of `LLMS.md` whose point
 * is decoding, mapping or failure handling, run over scripted answers.
 * `scripts/llms.ts` copies each file verbatim and `test/llms.test.ts` fails
 * when the copy is stale. The recipes whose point is what a validator does —
 * build-and-submit, fold-coins, sponsored, sponsored-stateless, account-alias —
 * run against a localnet in `test/live.localnet-recipes.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Effect, Fiber, Layer, Option, Ref } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { durableJournal, payOnce } from "../examples/recipes/durable-journal.ts"
import { postedIndices, thePost } from "../examples/recipes/events.ts"
import { indexPosts } from "../examples/recipes/indexer.ts"
import { AlreadyClaimed, claim } from "../examples/recipes/move-abort.ts"
import { publish } from "../examples/recipes/publish-and-upgrade.ts"
import { readCounter } from "../examples/recipes/read-object.ts"
import { payOrResend, startup } from "../examples/recipes/resubmit.ts"
import { Executed } from "../src/domain/executed.ts"
import { SimulationFailed } from "../src/domain/errors.ts"
import { executionReasonOf, ObjectId } from "../src/domain/schemas.ts"
import { makeKeyValueStore } from "../src/journal.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeDigest, FakeOutcome, SuiTest } from "../src/testing.ts"
import { layer, run, signer, stranger } from "./support.ts"

describe("recipes over scripted answers", () => {
  test("read-object: a counter is Some(value), a missing one None", async () => {
    const COUNTER = ObjectId.normalize("0xc0")
    const Counter = bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() })
    const counter = { objectId: COUNTER, type: "0x2::counter::Counter", version: 3n, content: Counter.serialize({ id: COUNTER, value: 41n }).toBytes() }
    const [found, missing] = await run(Effect.zip(readCounter(COUNTER), readCounter(ObjectId.normalize("0xc1"))), { objects: [counter] })
    expect([found, missing]).toEqual([Option.some(41n), Option.none()])
  })

  test("events: a v1 struct emitted by v2 code decodes under the original id", async () => {
    const ORIGINAL = "0x00000000000000000000000000000000000000000000000000000000000000b1"
    const PostedBcs = bcs.struct("Posted", { board: bcs.Address, index: bcs.u64() })
    const event = (index: bigint) => ({
      packageId: "0x00000000000000000000000000000000000000000000000000000000000000b2",
      module: "board",
      sender: signer.address,
      eventType: `${ORIGINAL}::board::Posted`,
      bcs: PostedBcs.serialize({ board: ObjectId.normalize("0xb0a4d"), index }).toBytes()
    })
    const executedWith = (events: ReadonlyArray<ReturnType<typeof event>>) => Effect.runSync(Executed.fromPartial({ digest: fakeDigest(1), events }))
    const two = executedWith([event(1n), event(2n)])
    expect(await Effect.runPromise(postedIndices(two))).toEqual([1n, 2n])
    expect((await Effect.runPromise(Effect.flip(thePost(two))))._tag).toBe("UnexpectedEffects")
    expect((await Effect.runPromise(thePost(executedWith([event(9n)])))).index).toBe("9")
  })

  test("move-abort: EAlreadyClaimed in simulation becomes AlreadyClaimed, not_applied", async () => {
    const aborted = new SimulationFailed({
      reason: executionReasonOf({
        $kind: "MoveAbort",
        message: "x",
        MoveAbort: { abortCode: "2", location: { package: "0xe5", module: "escrow", functionName: "claim" }, cleverError: { constantName: "EAlreadyClaimed", errorCode: 2 } }
      } as unknown as SuiClientTypes.ExecutionError),
      message: "x"
    })
    // The build's resolver answers with the abort, as a node's simulation would.
    const error = await run(Effect.flip(claim(signer, ObjectId.normalize("0xe5c"))), {}, { use: (() => Effect.fail(aborted)) as never })
    expect(error instanceof AlreadyClaimed && error.outcome).toBe("not_applied")
  })

  test("publish-and-upgrade: expectPublished answers the package and the created cap", async () => {
    const PACKAGE = ObjectId.normalize("0xbeef")
    const CAP = ObjectId.normalize("0xcab")
    const published = await run(publish(signer, { modules: ["AA=="], dependencies: ["0x1", "0x2"], digest: [] }), {
      execute: [FakeOutcome.succeed({ created: [{ objectId: PACKAGE, type: "package", outputState: "PackageWrite" }, { objectId: CAP, type: "0x2::package::UpgradeCap" }] })]
    })
    expect([published.packageId, published.upgradeCap.id]).toEqual([PACKAGE, CAP])
  })

  test("indexer: resumes after the committed cursor, then follows new events", async () => {
    const ledger = [1, 2, 3].map((n) => ({
      packageId: "0xb1", module: "board", sender: signer.address, eventType: "0xb1::board::Posted", bcs: bcs.u64().serialize(n).toBytes(),
      json: null, checkpoint: String(n), transactionDigest: fakeDigest(n), eventIndex: 0
    }))
    const listEvents = (options: { readonly after?: string | null }) =>
      Effect.sync(() => {
        const start = options.after === undefined || options.after === null ? 0 : Number(options.after) + 1
        const page = ledger.slice(start, start + 2)
        return { events: page, hasNextPage: start + page.length < ledger.length, startCursor: String(start), endCursor: page.length === 0 ? null : String(start + page.length - 1) }
      })
    const [afterCrash, final] = await run(Effect.gen(function*() {
      const db = yield* Ref.make<{ readonly rows: ReadonlyArray<string>; readonly cursor: string | null }>({ rows: [], cursor: null })
      const commit = (items: ReadonlyArray<SuiClientTypes.EventEntry>, cursor: string | null) =>
        Ref.update(db, (state) => ({ rows: [...state.rows, ...items.map((item) => item.transactionDigest)], cursor }))
      // The first run commits one page, then crashes on its second commit.
      const commits = yield* Ref.make(0)
      yield* Effect.flip(indexPosts(null, (items, cursor) => Effect.flatMap(Ref.getAndUpdate(commits, (n) => n + 1), (n) => n === 0 ? commit(items, cursor) : Effect.fail("crash" as const))))
      const afterCrash = yield* Ref.get(db)
      const fiber = yield* Effect.forkChild(indexPosts(afterCrash.cursor, commit))
      yield* TestClock.adjust("1 second")
      ledger.push({ ...ledger[0]!, checkpoint: "4", transactionDigest: fakeDigest(4) })
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)
      return [afterCrash, yield* Ref.get(db)] as const
    }), {}, { listEvents: listEvents as never })
    expect(afterCrash.rows).toEqual([fakeDigest(1), fakeDigest(2)])
    expect(final.rows).toEqual([1, 2, 3, 4].map(fakeDigest))
  })

  test("resubmit: a lost submission is re-sent as the identical bytes, and the startup sweep settles another", async () => {
    const lost = SubmitConfig.with({ resubmitAttempts: 1, reconcileRecheck: 0 })
    const [sent, swept] = await run(Effect.gen(function*() {
      yield* payOrResend(signer, stranger.address, 1_000n).pipe(lost)
      const sent = (yield* SuiTest.calls("executeTransaction")).map((call) => (call.options as { transaction: Uint8Array }).transaction)
      // A second one is left unknown, then settled by the startup sweep, which re-sends it.
      yield* SuiTest.scriptExecute([FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()])
      yield* Effect.flip(Tx.run(Tx.sendFunds({ amount: 2_000n, recipient: stranger.address }), { signer }).pipe(lost))
      return [sent, (yield* startup.pipe(lost)).map((entry) => entry._tag)] as const
    }), { execute: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()] })
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0]!)
    expect(swept).toEqual(["Executed"])
  })

  test("durable-journal: entries land in the durable store, and the next run sweeps first", async () => {
    const kv = Effect.runSync(Effect.provide(KeyValueStore.KeyValueStore, KeyValueStore.layerMemory))
    const withJournal = Layer.merge(layer(), durableJournal(Layer.succeed(KeyValueStore.KeyValueStore, kv)))
    const runDurable = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
    const entry = await runDurable(payOnce(signer, stranger.address, 1_000n).pipe(Effect.flatMap((digest) => makeKeyValueStore(kv).get(digest)), Effect.provide(withJournal)))
    expect(Option.map(entry, (found) => found._tag)).toEqual(Option.some("Executed"))
    await runDurable(payOnce(signer, stranger.address, 2_000n).pipe(Effect.provide(withJournal)))
    expect(await runDurable(Effect.map(Effect.orDie(kv.keys), (keys) => keys.filter((key) => key.startsWith("entry:")).length))).toBe(2)
  })
})
