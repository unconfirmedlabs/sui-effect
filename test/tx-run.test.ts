/**
 * `Tx.run` and what it owns around build → sign → submit: `approve`,
 * `onSigned`, `preflight`, the sender lock and its policies, sponsors, the
 * alias check, the `maxEpoch` bound, interruption, and the fold planner. The
 * node's answers are scripted; nothing models what a transaction does.
 */
import { describe, expect, test } from "bun:test"
import type { Transaction } from "@mysten/sui/transactions"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ADDRESS_ALIASES_TYPE, AddressAliasesBcs, aliasesId } from "../src/domain/address-alias.ts"
import { BuildError, PolicyDenied, SigningError } from "../src/domain/errors.ts"
import { CoinType, Mist, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { alias } from "../src/services/MultiSigSigner.ts"
import type { Signer } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, type FakeObject, FakeOutcome, ScriptedSuiCore, SuiTest } from "../src/testing.ts"
import { EPOCH, fail, keypair, run, signer, sponsor, stranger, SUI } from "./support.ts"
import { fromKeypair } from "../src/services/Signer.ts"

const SENDER = signer.address
const pinsNothing = (tx: Transaction) => {
  tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] })
}
const usesGas = (tx: Transaction) => {
  const [coin] = tx.splitCoins(tx.gas, [1_000n])
  tx.transferObjects([coin!], stranger.address)
}
const coin = (owner: string, n: number, balance = 5_000_000_000n) => fakeCoin({ objectId: `0xc${n.toString(16).padStart(3, "0")}`, owner, balance, version: 2n })
const sends = Effect.map(SuiTest.calls("executeTransaction"), (calls) => calls.length)
const simulates = Effect.map(SuiTest.calls("simulateTransaction"), (calls) => calls.length)
const unresolved = Effect.map(Effect.flatMap(Journal, (journal) => journal.listUnresolved), (entries) => entries.map((e) => e._tag))

describe("around the signature", () => {
  test("onSigned runs once, after the last signature and before the first send", async () => {
    const seen: Array<number> = []
    const [executed, entries] = await run(Effect.gen(function*() {
      const { calls } = yield* ScriptedSuiCore
      const executes = Effect.map(calls, (all) => all.filter((call) => call.method === "executeTransaction").length)
      const executed = yield* Tx.run(pinsNothing, { signer, onSigned: (signed) => Effect.map(executes, (n) => void seen.push(n, signed.signatures.length)) })
      return [executed, yield* unresolved] as const
    }))
    expect(seen).toEqual([0, 1])
    expect([executed.sender, entries]).toEqual([SENDER, []] as never)
  })

  test("approve sees the built bytes and their simulation; refusing is the caller's error, nothing signed, sent or journalled", async () => {
    class Declined extends Error {
      readonly _tag = "Declined"
    }
    let signatures = 0
    const counting: Signer = { ...signer, signTransaction: (bytes) => Effect.suspend(() => (signatures++, signer.signTransaction(bytes))) }
    const [seen, error, sent, entries] = await run(Effect.gen(function*() {
      let seen: unknown
      const error = yield* Effect.flip(Tx.run(pinsNothing, {
        signer: counting,
        approve: (prepared) => Effect.suspend(() => {
          seen = [prepared.built.sender, prepared.built.gas.source, prepared.simulation.effects.status.success]
          return Effect.fail(new Declined())
        })
      }))
      return [seen, error, yield* sends, yield* unresolved] as const
    }))
    expect(seen).toEqual([SENDER, "addressBalance", true])
    expect([error instanceof Declined, signatures, sent, entries]).toEqual([true, 0, 0, []])
  })

  test("approve reuses the simulation Tx.build made of exactly these bytes", async () => {
    const preset = (tx: Transaction) => {
      pinsNothing(tx)
      tx.setGasBudget(5_000_000n)
    }
    expect(await run(Effect.andThen(Tx.run(preset, { signer, approve: () => Effect.void }), simulates))).toBe(1)
  })

  test("preflight denial stops before anything is signed; the gas ceiling likewise", async () => {
    const denied = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Tx.run(pinsNothing, { signer }).pipe(SubmitConfig.with({
        preflight: () => Effect.fail(new PolicyDenied({ rule: "spend", message: "no" }))
      })))
      return [error, yield* sends] as const
    }))
    expect([denied[0]._tag, denied[1]]).toEqual(["PolicyDenied", 0])
    const ceiling = await fail(Tx.run(pinsNothing, { signer }).pipe(SubmitConfig.with({ maxGasBudget: Mist.make(1_000n) })))
    expect(ceiling._tag === "PolicyDenied" && ceiling.rule).toBe("maxGasBudget")
  })

  test("a signer whose maxEpoch has passed is SigningError { expired } before anything resolves", async () => {
    const [error, sims] = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Tx.run(pinsNothing, { signer: { ...signer, maxEpoch: EPOCH - 1n } }))
      return [error, yield* simulates] as const
    }))
    expect([error instanceof SigningError && error.reason, sims]).toEqual(["expired", 0])
    let window: unknown
    await run(Tx.run(pinsNothing, { signer: { ...signer, maxEpoch: EPOCH }, approve: (p) => Effect.sync(() => (window = p.built.expiration)) }))
    expect(window).toMatchObject({ ValidDuring: { maxEpoch: EPOCH } })
  })

  test("interrupted mid-execute: the lock is released and the journal keeps Signed", async () => {
    const [entries, second] = await run(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Tx.run(pinsNothing, { signer }).pipe(SubmitConfig.with({ lockSender: "always" })))
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)
      const entries = yield* unresolved
      yield* SuiTest.scriptExecute([FakeOutcome.succeed()])
      return [entries, yield* Effect.exit(Tx.run(pinsNothing, { signer }).pipe(SubmitConfig.with({ lockSender: "always" })))] as const
    }), { execute: [FakeOutcome.hang()] })
    expect(entries).toEqual(["Signed"])
    expect(Exit.isSuccess(second)).toBe(true)
  })
})

describe("the sender lock", () => {
  /**
   * Two runs, the first held inside `preflight` (after its build); answers
   * whether the second finished first. Held through submission, it cannot.
   */
  const race = (first: (tx: Transaction) => void, opts: { readonly lockSender?: "whenPinned" | "always" | "never"; readonly second?: Signer; readonly objects?: ReadonlyArray<FakeObject>; readonly funded?: boolean } = {}) =>
    run(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const inside = yield* Deferred.make<void>()
      const order: Array<string> = []
      let held = false
      const start = (name: string, recipe: (tx: Transaction) => void, who: Signer) =>
        Effect.forkChild(Tx.run(recipe, { signer: who }).pipe(
          Effect.tap(() => Effect.sync(() => order.push(name))),
          SubmitConfig.with({
            lockSender: opts.lockSender ?? "whenPinned",
            preflight: () => held ? Effect.void : Effect.andThen(Effect.sync(() => (held = true)), Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(gate)))
          })
        ))
      const one = yield* start("first", first, signer)
      yield* Deferred.await(inside)
      const two = yield* start("second", pinsNothing, opts.second ?? signer)
      yield* TestClock.adjust("1 second")
      const overtaken = [...order]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(one)
      yield* Fiber.join(two)
      return overtaken
    }), opts.funded === false ? { addressBalances: [], objects: opts.objects ?? [] } : { objects: opts.objects ?? [] })

  test("whenPinned: bytes that pin nothing release the lock after the build", async () => {
    expect(await race(pinsNothing)).toEqual(["second"])
  })

  test("whenPinned: bytes that pin a gas coin hold it through submission; always holds it whatever they pin", async () => {
    expect(await race(pinsNothing, { funded: false, objects: [coin(SENDER, 1), coin(SENDER, 2)] })).toEqual([])
    expect(await race(pinsNothing, { lockSender: "always" })).toEqual([])
  })

  test("two senders never wait for each other", async () => {
    expect(await race(pinsNothing, { lockSender: "always", second: sponsor })).toEqual(["second"])
  })

  test("a sender and a coin-paying gas owner are locked in one order, so two runs sponsoring each other cannot deadlock", async () => {
    const both = await run(Effect.all([
      Tx.run(pinsNothing, { signer, sponsor, gasOwner: sponsor.address }),
      Tx.run(pinsNothing, { signer: sponsor, sponsor: signer, gasOwner: signer.address })
    ], { concurrency: "unbounded" }).pipe(SubmitConfig.with({ lockSender: "always" })), {
      addressBalances: [],
      objects: [coin(signer.address, 1), coin(sponsor.address, 2)]
    })
    expect(both).toHaveLength(2)
  })

  test("withSenderLock is one lock per normalized address", async () => {
    const order = await run(Effect.gen(function*() {
      const order: Array<string> = []
      const gate = yield* Deferred.make<void>()
      const lower = SuiAddress.make(SENDER)
      const upper = `0x${SENDER.slice(2).toUpperCase()}` as SuiAddress
      const first = yield* Effect.forkChild(Tx.withSenderLock(lower)(Effect.andThen(Deferred.await(gate), Effect.sync(() => order.push("first")))))
      yield* TestClock.adjust("1 second")
      const second = yield* Effect.forkChild(Tx.withSenderLock(upper)(Effect.sync(() => order.push("second"))))
      yield* TestClock.adjust("1 second")
      const before = [...order]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      return [before, order]
    }))
    expect(order).toEqual([[], ["first", "second"]])
  })

  test("a tx.gas run waits, before it builds, for a lock-free run in flight on its payer", async () => {
    const [builtEarly, exits] = await run(Effect.gen(function*() {
      const inside = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const reserving = yield* Deferred.make<void>()
      const send = yield* Effect.forkChild(Tx.run(pinsNothing, { signer, onSigned: () => Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(gate)) }))
      yield* Deferred.await(inside)
      const reservation = yield* Effect.forkChild(Tx.run(usesGas, { signer, onSigned: () => Deferred.succeed(reserving, undefined) }))
      yield* TestClock.adjust("1 second")
      const builtEarly = yield* Deferred.isDone(reserving)
      yield* Deferred.succeed(gate, undefined)
      return [builtEarly, [yield* Fiber.await(send), yield* Fiber.await(reservation)]] as const
    }))
    expect(builtEarly).toBe(false)
    expect(exits.every(Exit.isSuccess)).toBe(true)
  })
})

describe("sponsors", () => {
  const sponsoredRecipe = Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(pinsNothing)

  test("a sponsor co-signs: the submission carries both signatures", async () => {
    const signatures = await run(Effect.gen(function*() {
      yield* Tx.run(sponsoredRecipe, { signer, sponsor })
      return ((yield* SuiTest.calls("executeTransaction"))[0]?.options as { signatures: ReadonlyArray<string> }).signatures.length
    }))
    expect(signatures).toBe(2)
  })

  test("a gas owner with no sponsor, or a sponsor signing as someone else, is SigningError before anything is built", async () => {
    for (const opts of [{ signer }, { signer, sponsor: stranger }, { signer, gasOwner: sponsor.address }]) {
      const [error, sims] = await run(Effect.gen(function*() {
        return [yield* Effect.flip(Tx.run(opts.gasOwner === undefined ? sponsoredRecipe : pinsNothing, opts)), yield* simulates] as const
      }))
      expect([error._tag, sims]).toEqual(["SigningError", 0])
    }
  })
})

describe("signing as an aliased account", () => {
  const A = fromKeypair(keypair(10))
  const aliasesOf = (account: string, members: ReadonlyArray<string>): FakeObject => ({
    objectId: aliasesId(account),
    type: ADDRESS_ALIASES_TYPE,
    version: 2n,
    owner: { $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { owner: account, startVersion: "2" } },
    content: AddressAliasesBcs.serialize({ id: aliasesId(account), aliases: { contents: [...members] } }).toBytes()
  })
  const funded = { addressBalances: [{ owner: A.address, amount: 10_000_000_000n }] }

  test("Tx.run as A signed by M: A is the sender, the journal names A, the alias set is read once", async () => {
    const [executed, sender, reads] = await run(Effect.gen(function*() {
      yield* SuiTest.putObject(aliasesOf(A.address, [signer.address]))
      let sender: unknown
      const executed = yield* Tx.run(pinsNothing, { signer: alias(A.address, signer), onSigned: (signed) => Effect.sync(() => (sender = signed.sender)) })
      const reads = (yield* SuiTest.calls("getObjects")).filter((call) => (call.options as { objectIds: ReadonlyArray<string> }).objectIds.includes(aliasesId(A.address))).length
      return [executed, sender, reads] as const
    }), funded)
    expect([executed.sender, sender, reads]).toEqual([A.address, A.address, 1] as never)
  })

  test("a key A's set does not list is PolicyDenied { alias.signer } before anything is built", async () => {
    for (const set of [[stranger.address], undefined]) {
      const [error, sims] = await run(Effect.gen(function*() {
        if (set !== undefined) yield* SuiTest.putObject(aliasesOf(A.address, set))
        return [yield* Effect.flip(Tx.run(pinsNothing, { signer: alias(A.address, signer) })), yield* simulates] as const
      }), funded)
      expect([error._tag === "PolicyDenied" && error.rule, sims]).toEqual(["alias.signer", 0])
    }
  })

  test("the lock is A's: two runs for A through different keys serialize", async () => {
    const overtaken = await run(Effect.gen(function*() {
      yield* SuiTest.putObject(aliasesOf(A.address, [signer.address, sponsor.address]))
      const gate = yield* Deferred.make<void>()
      const inside = yield* Deferred.make<void>()
      const order: Array<string> = []
      const first = yield* Effect.forkChild(Tx.run(pinsNothing, { signer: alias(A.address, signer), approve: () => Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(gate)) }).pipe(
        Effect.tap(() => Effect.sync(() => order.push("first"))),
        SubmitConfig.with({ lockSender: "always" })
      ))
      yield* Deferred.await(inside)
      const second = yield* Effect.forkChild(Tx.run(pinsNothing, { signer: alias(A.address, sponsor) }).pipe(Effect.tap(() => Effect.sync(() => order.push("second"))), SubmitConfig.with({ lockSender: "always" })))
      yield* TestClock.adjust("1 second")
      const overtaken = [...order]
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      return overtaken
    }), funded)
    expect(overtaken).toEqual([])
  })
})

describe("folding coins", () => {
  const USDC = CoinType.make(`0x${"0".repeat(60)}dba3::usdc::USDC`)
  const unfunded = { addressBalances: [] }

  test("planFold: SUI first and paying for its own fold, largest coins first, then every other coin type", async () => {
    const plan = await run(Tx.planFold({ owner: SENDER }), {
      ...unfunded,
      objects: [coin(SENDER, 1, 3_000_000_000n), coin(SENDER, 2, 9_000_000_000n), fakeCoin({ objectId: "0xd01", owner: SENDER, balance: 5_000n, coinType: USDC })]
    })
    expect(plan.batches.map((batch) => [batch.coinType, batch.gas, batch.amount])).toEqual([[CoinType.SUI, "foldedCoins", 12_000_000_000n], [USDC, "auto", 5_000n]] as never)
    expect(plan.batches[0]!.coins.map((c) => c.balance)).toEqual([9_000_000_000n, 3_000_000_000n] as never)
  })

  test("planFold: maxCoinsPerTransaction batches (clamped to 1..500); dust is paid from a balance or skipped", async () => {
    const five = { ...unfunded, objects: [1, 2, 3, 4, 5].map((n) => coin(SENDER, n, 1_000_000_000n)) }
    expect((await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI, maxCoinsPerTransaction: 2 }), five)).batches.map((b) => b.coins.length)).toEqual([2, 2, 1])
    expect((await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI, maxCoinsPerTransaction: 0 }), five)).batches).toHaveLength(5)
    const dust = [coin(SENDER, 1, 1_000n), coin(SENDER, 2, 2_000n)]
    expect((await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI }), { objects: dust })).batches.map((b) => b.gas)).toEqual(["addressBalance"])
    const stranded = await run(Tx.planFold({ owner: SENDER, coinType: CoinType.SUI }), { ...unfunded, objects: dust })
    expect([stranded.batches.length, stranded.skipped.length]).toEqual([0, 2])
  })

  test("fold: foldedCoins makes the coins the payment (256 at most) and deposits the gas coin; addressBalance makes them inputs", async () => {
    const many = Array.from({ length: 300 }, (_, n) => coin(SENDER, n + 1, 1_000_000_000n))
    const [folded, inputs] = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER, coinType: CoinType.SUI, maxCoinsPerTransaction: 300 })
      const folded = yield* Tx.build(Tx.fold(plan.batches[0]!), { sender: SENDER })
      const asInputs = yield* Tx.build(Tx.fold({ ...plan.batches[0]!, coins: plan.batches[0]!.coins.slice(0, 3), gas: "addressBalance" }), { sender: SENDER })
      return [TransactionDataBuilder.fromBytes(folded.bytes), TransactionDataBuilder.fromBytes(asInputs.bytes)] as const
    }), { objects: many })
    expect(folded.gasData.payment).toHaveLength(256)
    expect([folded.commands[0]?.MergeCoins?.sources.length, folded.commands[1]?.MoveCall?.function]).toEqual([44, "send_funds"])
    expect(inputs.gasData.payment).toEqual([])
    expect(inputs.inputs.filter((input) => input.Object?.ImmOrOwnedObject !== undefined)).toHaveLength(3)
  })

  test("fold refuses an empty batch and foldedCoins for a coin that is not SUI; foldCoins refuses a batch of another owner", async () => {
    const [empty, notSui, forged, sent] = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER, coinType: CoinType.SUI })
      const batch = plan.batches[0]!
      return [
        yield* Effect.flip(Tx.build(Tx.fold({ ...batch, coins: [], gas: "auto" }), { sender: SENDER })),
        yield* Effect.flip(Tx.build(Tx.fold({ ...batch, coinType: USDC }), { sender: SENDER })),
        yield* Effect.flip(Tx.foldCoins({ signer, plan: { ...plan, batches: [{ ...batch, owner: stranger.address }] } })),
        yield* sends
      ] as const
    }), { ...unfunded, objects: [coin(SENDER, 1)] })
    expect([empty._tag, notSui._tag, forged instanceof BuildError, sent]).toEqual(["BuildError", "BuildError", true, 0])
  })

  test("foldCoins runs a plan as given, and approve sees every batch", async () => {
    const seen: Array<string> = []
    const result = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER, maxCoinsPerTransaction: 1 })
      return yield* Tx.foldCoins({ signer, plan, approve: (_prepared, batch) => Effect.sync(() => void seen.push(batch.coinType)) })
    }), { ...unfunded, objects: [coin(SENDER, 1), coin(SENDER, 2)] })
    expect([result.executed.length, seen.length]).toEqual([2, 2])
  })
})
