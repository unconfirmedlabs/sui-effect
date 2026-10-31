/**
 * The recipes `docs/llms-head.md` quotes at the top of `LLMS.md`, run against
 * the fake. `scripts/llms.ts` copies each file verbatim (rewriting only the
 * relative `src/` imports to the package subpaths), and `test/llms.test.ts`
 * fails when the copy is stale, so a recipe an agent reads first is one that
 * typechecks and runs. `test/recipes/fake.test.ts` is a recipe and a test
 * itself.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { KeyValueStore } from "effect/persistence"
import { TestClock } from "effect/testing"
import { pay } from "../examples/recipes/build-and-submit.ts"
import { durableJournal, payOnce } from "../examples/recipes/durable-journal-script.ts"
import { postedIndices, thePost } from "../examples/recipes/events.ts"
import { Versions, versions } from "../examples/recipes/extension.ts"
import { indexPosts } from "../examples/recipes/indexer.ts"
import { AlreadyClaimed, claim } from "../examples/recipes/move-abort.ts"
import { counters, incrementCommand } from "../examples/recipes/promise-face.ts"
import { publish, upgrade } from "../examples/recipes/publish-and-upgrade.ts"
import { readCounter } from "../examples/recipes/read-object.ts"
import { payOrResend, startup } from "../examples/recipes/resubmit.ts"
import { sponsorBytes } from "../examples/recipes/sponsored-stateless.ts"
import { coinPaidIncrement, sponsoredIncrement } from "../examples/recipes/sponsored.ts"
import { type EventEntry, ObjectId, SuiAddress } from "../src/index.ts"
import { makeKeyValueStore } from "../src/journal.ts"
import { Script } from "../src/services/Script.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Tx } from "../src/services/Tx.ts"
import {
  fakeCoin,
  fakeDigest,
  FakeOutcome,
  type FakeScript,
  layerExtensionTest,
  layerTest,
  SuiCoreFake,
  SuiTest
} from "../src/testing.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const COUNTER = ObjectId.normalize("0xc0")
const CounterBcs = bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() })
const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(21)))
const sponsorKeypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(22))
const sponsor = fromKeypair(sponsorKeypair)
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: signer.address }

const counter = {
  objectId: COUNTER,
  type: `${PKG}::counter::Counter`,
  version: 3n,
  owner,
  content: CounterBcs.serialize({ id: COUNTER, value: 41n }).toBytes()
}

const script: FakeScript = {
  objects: [counter],
  coins: [
    fakeCoin({ objectId: "0xc01", owner: signer.address, balance: 1_000_000_000n, version: 2n }),
    fakeCoin({ objectId: "0xc02", owner: sponsor.address, balance: 1_000_000_000n, version: 2n })
  ],
  // `Tx.sponsored` pays from the sponsor's address balance, which `Tx.build`
  // checks covers the budget before anything is signed.
  balances: [{
    owner: sponsor.address,
    coinType: "0x2::sui::SUI",
    balance: "1000000000",
    coinBalance: "0",
    addressBalance: "1000000000"
  }],
  execute: [FakeOutcome.succeed({ mutated: [{ ...counter, version: 4n }] })]
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

const increment = (tx: Transaction) => {
  tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(COUNTER)] })
}

describe("docs/llms-head.md recipes", () => {
  test("read-object: a counter is Some(value), a missing one None", async () => {
    const provide = Effect.provide(layerTest(script))
    expect(await run(readCounter(COUNTER).pipe(provide))).toEqual(Option.some(41n))
    expect(await run(readCounter(ObjectId.normalize("0xc1")).pipe(provide))).toEqual(Option.none())
  })

  test("build-and-submit: Tx.run pays and answers the digest", async () => {
    const digest = await run(
      pay(signer, SuiAddress.normalize("0xa11ce"), 1_000n).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(digest.length).toBeGreaterThan(0)
  })

  test("build-and-submit: a budget over the ceiling is PolicyDenied maxGasBudget", async () => {
    const error = await run(
      pay(signer, SuiAddress.normalize("0xa11ce"), 1_000n).pipe(
        Effect.flip,
        SuiTest.provide(layerTest({ ...script, gasBudget: 2_000_000_000n }))
      )
    )
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag === "PolicyDenied") expect(error.rule).toBe("maxGasBudget")
  })

  test("sponsored: build, sign, cosign, submit with two signatures", async () => {
    const executed = await run(
      sponsoredIncrement(signer, sponsor, COUNTER).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(executed.mutated().map((ref) => ref.id)).toContain(COUNTER)
  })

  test("sponsored: without an address balance the build fails before signing", async () => {
    const error = await run(
      sponsoredIncrement(signer, sponsor, COUNTER).pipe(
        Effect.flip,
        SuiTest.provide(layerTest({ ...script, balances: [] }))
      )
    )
    expect(error._tag).toBe("BuildError")
  })

  test("sponsored: the coin-paid alternative spends the sponsor's coin, with both signatures", async () => {
    const [executed, sent] = await run(
      Effect.gen(function*() {
        const executed = yield* coinPaidIncrement(signer, sponsor, COUNTER)
        return [executed, yield* SuiTest.calls("executeTransaction")] as const
      }).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(executed.mutated().map((ref) => ref.id)).toContain(COUNTER)
    const options = sent[0]?.options as { readonly signatures: ReadonlyArray<string> }
    expect(options.signatures).toHaveLength(2)
  })

  test("sponsored-stateless: fromBytes, attach, cosign, submit", async () => {
    const executed = await run(
      Effect.gen(function*() {
        const parties = { sender: signer.address, gasOwner: sponsor.address }
        const built = yield* Tx.build(Tx.sponsored(parties)(increment), parties)
        const { signatures } = yield* Tx.sign(built, signer)
        return yield* sponsorBytes(sponsor)(built.bytes, signatures[0]!)
      }).pipe(SuiTest.provide(layerTest({ ...script, simulate: [FakeOutcome.succeed()] })))
    )
    expect(executed.mutated().map((ref) => ref.id)).toContain(COUNTER)
  })

  test("sponsored-stateless: bytes the sponsor does not pay for are refused", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(increment, { sender: signer.address })
        const { signatures } = yield* Tx.sign(built, signer)
        return yield* Effect.flip(sponsorBytes(sponsor)(built.bytes, signatures[0]!))
      }).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(error._tag).toBe("PolicyDenied")
  })

  test("extension: the Effect service and its derived Promise face agree", async () => {
    const viaEffect = await run(
      Effect.flatMap(Versions, (service) => service.of(COUNTER)).pipe(
        Effect.provide(layerExtensionTest(Versions.layer, script))
      )
    )
    expect(viaEffect).toBe(3n)

    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(script), { local: true }))
    const client = fake.client.$extend(versions)
    expect(await client.versions.of(COUNTER)).toBe(3n)
    await client.versions.$dispose()
  })

  test("promise-face: a typed id and a Signer in, a digest or one readable line out", async () => {
    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(script), { local: true }))
    const command = incrementCommand(fake.client, sponsorKeypair)
    expect(await command(COUNTER)).toMatch(/^incremented in \S+$/)
    // A shorthand is not what a person may type: Strict refuses it, and
    // describe turns the refusal into one line.
    const refused = await command("0xc0")
    expect(refused).not.toContain("incremented")
    expect(refused).not.toContain("\n")
    await fake.client.$extend(counters).counters.$dispose()
  })

  test("publish-and-upgrade: expectPublished answers the package and the cap", async () => {
    const PACKAGE = ObjectId.normalize("0xbeef")
    const UPGRADED = ObjectId.normalize("0xbeef2")
    const CAP = ObjectId.normalize("0xcab")
    const compiled = {
      modules: ["AA=="],
      dependencies: ["0x1", "0x2"],
      digest: Array.from({ length: 32 }, () => 1)
    }
    const [published, upgraded] = await run(
      Effect.gen(function*() {
        yield* SuiTest.scriptExecute([
          FakeOutcome.succeed({
            created: [
              { objectId: PACKAGE, type: "package", outputState: "PackageWrite" },
              { objectId: CAP, type: "0x2::package::UpgradeCap" }
            ]
          })
        ])
        const published = yield* publish(signer, compiled)
        // The fake runs no Move: the cap the publish created is put in place by hand.
        yield* SuiTest.putObject({
          objectId: CAP,
          type: "0x2::package::UpgradeCap",
          version: 5n,
          owner,
          content: new Uint8Array()
        })
        yield* SuiTest.scriptExecute([
          FakeOutcome.succeed({
            created: [{ objectId: UPGRADED, type: "package", outputState: "PackageWrite" }],
            mutated: [{ objectId: CAP, type: "0x2::package::UpgradeCap", version: 6n }]
          })
        ])
        const upgraded = yield* upgrade(signer, published.packageId, published.upgradeCap.id, compiled)
        return [published, upgraded] as const
      }).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(published.packageId).toBe(PACKAGE)
    expect(published.upgradeCap.id).toBe(CAP)
    expect(upgraded.packageId).toBe(UPGRADED)
    expect(upgraded.upgradeCap.id).toBe(CAP)
  })

  test("events: a v1 struct emitted by v2 code decodes under the original id", async () => {
    const ORIGINAL = "0x00000000000000000000000000000000000000000000000000000000000000b1"
    const V2 = "0x00000000000000000000000000000000000000000000000000000000000000b2"
    const board = ObjectId.normalize("0xb0a4d")
    const PostedBcs = bcs.struct("Posted", { board: bcs.Address, index: bcs.u64() })
    const event = (index: bigint) => ({
      packageId: V2,
      module: "board",
      sender: signer.address,
      eventType: `${ORIGINAL}::board::Posted`,
      bcs: PostedBcs.serialize({ board, index }).toBytes()
    })
    const transfer = (amount: bigint) =>
      Tx.run((tx) => {
        tx.transferObjects([tx.splitCoins(tx.gas, [amount])], signer.address)
      }, { signer })
    const [indices, error, single] = await run(
      Effect.gen(function*() {
        yield* SuiTest.scriptExecute([FakeOutcome.succeed({ events: [event(1n), event(2n)] })])
        const two = yield* transfer(1n)
        const indices = yield* postedIndices(two)
        const error = yield* Effect.flip(thePost(two))
        yield* SuiTest.scriptExecute([FakeOutcome.succeed({ events: [event(9n)] })])
        const single = yield* thePost(yield* transfer(2n))
        return [indices, error, single] as const
      }).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(indices).toEqual([1n, 2n])
    expect(error._tag).toBe("UnexpectedEffects")
    expect(single.index).toBe("9")
  })

  test("indexer: resumes after the committed cursor, then follows new events", async () => {
    const BOARD = "0x00000000000000000000000000000000000000000000000000000000000000b1"
    const posted = (seed: number) => ({
      sender: signer.address,
      checkpoint: String(seed),
      events: [{
        packageId: BOARD,
        module: "board",
        sender: signer.address,
        eventType: `${BOARD}::board::Posted`,
        bcs: bcs.u64().serialize(seed).toBytes()
      }]
    })
    const ledger = Object.fromEntries(
      [1, 2, 3].map((seed) => [fakeDigest(seed), FakeOutcome.succeed(posted(seed))])
    )
    const program = Effect.gen(function*() {
      const db = yield* Ref.make<{ readonly rows: ReadonlyArray<string>; readonly cursor: string | null }>({
        rows: [],
        cursor: null
      })
      const commit = (items: ReadonlyArray<EventEntry>, cursor: string | null) =>
        Ref.update(db, (state) => ({
          rows: [...state.rows, ...items.map((item) => item.transactionDigest)],
          cursor
        }))
      // The first run commits one page, then stops (a crash, a deploy).
      yield* Stream.runDrain(indexPosts(null, commit).pipe(Stream.take(1)))
      const afterCrash = yield* Ref.get(db)
      // The next run starts from the committed cursor and keeps following.
      const fiber = yield* Effect.forkChild(
        Stream.runDrain(indexPosts(afterCrash.cursor, commit).pipe(Stream.take(2)))
      )
      yield* TestClock.adjust("1 second")
      yield* SuiTest.recordTransaction(fakeDigest(4), FakeOutcome.succeed(posted(4)))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(fiber)
      return [afterCrash, yield* Ref.get(db)] as const
    })
    const [afterCrash, final] = await run(
      program.pipe(SuiTest.provide(layerTest({ transactions: ledger, pageSize: 2 })))
    )
    expect(afterCrash.rows).toEqual([fakeDigest(1), fakeDigest(2)])
    expect(final.rows).toEqual([fakeDigest(1), fakeDigest(2), fakeDigest(3), fakeDigest(4)])
  })

  test("durable-journal-script: entries land in the durable store, in a program and through Script.run", async () => {
    const kv = Effect.runSync(Effect.provide(KeyValueStore.KeyValueStore, KeyValueStore.layerMemory))
    const store = Layer.succeed(KeyValueStore.KeyValueStore, kv)
    const scriptLayer = Script.layerWithSigner(signer).pipe(Layer.provideMerge(layerTest(script)))
    const entry = await run(
      payOnce(SuiAddress.normalize("0xa11ce"), 1_000n).pipe(
        Effect.flatMap((digest) => makeKeyValueStore(kv).get(digest)),
        Effect.provide(Layer.merge(scriptLayer, durableJournal(store)))
      )
    )
    expect(Option.map(entry, (found) => found._tag)).toEqual(Option.some("Executed"))

    const lines: Array<string> = []
    const code = await Script.run(payOnce(SuiAddress.normalize("0xa11ce"), 2_000n), {
      layer: Layer.merge(scriptLayer, durableJournal(store)),
      exit: () => undefined,
      stderr: (line) => lines.push(line),
      signals: { on: () => undefined }
    })
    expect(code).toBe(0)
    expect(await run(Effect.map(kv.keys, (keys) => keys.length).pipe(Effect.orDie))).toBe(2)
  })

  test("resubmit: a lost submission is re-sent as the same bytes, and settled at startup", async () => {
    const lost = SubmitConfig.with({ resubmitAttempts: 1, reconcileRecheck: 0 })
    const [executed, swept] = await run(
      Effect.gen(function*() {
        yield* SuiTest.scriptExecute([FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()])
        yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound()])
        const executed = yield* payOrResend(signer, signer.address, 1_000n).pipe(lost)
        const sent = yield* SuiTest.calls("executeTransaction")
        const bytes = sent.map((call) => (call.options as { readonly transaction: Uint8Array }).transaction)
        expect(bytes).toHaveLength(2)
        expect(bytes[1]).toEqual(bytes[0]!)

        // A second one is left unknown, then settled by the startup sweep.
        yield* SuiTest.scriptExecute([FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()])
        const unknown = yield* Effect.flip(
          Tx.run((tx) => {
            tx.transferObjects([tx.splitCoins(tx.gas, [2_000n])], signer.address)
          }, { signer }).pipe(lost)
        )
        expect(unknown._tag).toBe("SubmissionUnknown")
        return [executed, yield* startup.pipe(lost)] as const
      }).pipe(SuiTest.provide(layerTest(script)))
    )
    expect(executed.digest.length).toBeGreaterThan(0)
    expect(swept.map((entry) => entry._tag)).toEqual(["Executed"])
  })

  test("move-abort: EAlreadyClaimed in simulation becomes AlreadyClaimed, not_applied", async () => {
    const error = await run(
      claim(signer, COUNTER).pipe(
        Effect.flip,
        SuiTest.provide(layerTest({
          ...script,
          buildSimulate: [FakeOutcome.failWith({
            $kind: "MoveAbort",
            MoveAbort: {
              abortCode: 2n,
              location: { package: "0xe5", module: "escrow", functionName: "claim" },
              cleverError: { constantName: "EAlreadyClaimed", errorCode: 2 }
            }
          })]
        }))
      )
    )
    expect(error).toBeInstanceOf(AlreadyClaimed)
    if (error instanceof AlreadyClaimed) expect(error.outcome).toBe("not_applied")
  })
})
