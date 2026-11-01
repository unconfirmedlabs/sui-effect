/**
 * The sender lock and coin reservations under `lockSender: "whenPinned"`.
 *
 * A recipe that uses `tx.gas` on a payer with an address balance is given a
 * coin reservation of that **whole** balance as of its build. Any spend from
 * the balance that lands between the build and the send makes the node refuse
 * it at submit, so such a run holds the sender lock through submission, and a
 * `tx.gas` run first waits for the lock-free runs in flight on its payer. Both
 * race orders run here on the fake, from one sender with no SUI coins (a
 * folded account, where the payment is the reservation alone), and a plain
 * address-balance send must still overlap another one.
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SuiAddress } from "../src/domain/schemas.ts"
import { JournalError } from "../src/domain/errors.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = `${PADDED("2")}::sui::SUI`
const ONE_SUI = 1_000_000_000n

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41)))
const SENDER = signer.address
const RECIPIENT = SuiAddress.make(PADDED("a11ce"))

/** A folded account: no SUI coins, one SUI in the address balance. */
const script: FakeScript = {
  chainId: CHAIN_ID,
  objects: [],
  coins: [],
  balances: [{
    owner: SENDER,
    coinType: SUI,
    balance: ONE_SUI.toString(),
    coinBalance: "0",
    addressBalance: ONE_SUI.toString()
  }],
  simulate: [FakeOutcome.succeed()],
  execute: [FakeOutcome.succeed()]
}

const run = <A, E>(effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), {
      local: true
    })
  )

/** Uses `tx.gas`, so the resolver pays with a reservation of the whole balance. */
const usesGas = (tx: Transaction) => {
  tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(5n)])], tx.pure.address(RECIPIENT))
}

/** An address-balance send: a `FundsWithdrawal`, an empty payment, nothing pinned. */
const send = Tx.sendFunds({ amount: 1_000n, recipient: RECIPIENT })

const isReservation = (ref: { readonly version: string | number }) => String(ref.version) === "0"

/**
 * Lets every other fiber run until `done` answers `true`, or a bounded number
 * of scheduler turns has passed — no wall clock. A `false` at the end is the
 * evidence that something is (still) blocked.
 */
const settleUntil = <R>(done: Effect.Effect<boolean, never, R>, turns = 200): Effect.Effect<boolean, never, R> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < turns; turn++) {
      if (yield* done) return true
      yield* Effect.yieldNow
    }
    return yield* done
  })

/** Whether the fake has seen `count` executions. */
const executions = (count: number) =>
  Effect.map(SuiTest.calls("executeTransaction"), (calls) => calls.length >= count)

/** Resolver simulates (one per build) and executes, in the order the fake saw them. */
const buildAndExecuteOrder = Effect.map(SuiTest.calls(), (calls) =>
  calls
    .filter((call) =>
      call.method === "executeTransaction" ||
      (call.method === "simulateTransaction" && (call.options as { resolver?: boolean }).resolver === true)
    )
    .map((call) => call.method === "executeTransaction" ? "execute" : "build"))

/** An `onSigned` that signals `inside` and then waits for `gate`. */
const gated = (inside: Deferred.Deferred<void>, gate: Deferred.Deferred<void>) => () =>
  Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(gate))

describe("the fake refuses a stale coin reservation", () => {
  test("a spend that landed after the build makes the reservation refused at submit", async () => {
    const { payment, error } = await run(Effect.gen(function*() {
      const built = yield* Tx.build(usesGas, { sender: SENDER })
      const payment = TransactionDataBuilder.fromBytes(built.bytes).gasData.payment ?? []
      const signed = yield* Tx.sign(built, signer)
      // What a lock-free send landing in between does to the balance.
      yield* SuiTest.setAddressBalance(SENDER, ONE_SUI - 1_000n)
      return { payment, error: yield* Effect.flip(Tx.submit(signed)) }
    }))
    // The reservation alone: the account has no coins.
    expect(payment).toHaveLength(1)
    expect(isReservation(payment[0]!)).toBe(true)
    expect(error._tag).toBe("TransportError")
    if (error._tag !== "TransportError") return
    expect(error.status).toBe("INVALID_ARGUMENT")
    expect(String(error.cause)).toContain(
      `Invalid withdraw reservation: Insufficient address balance of coin type 0x2::sui::SUI for address ${SENDER}:` +
        ` the transaction requires ${ONE_SUI} but only ${ONE_SUI - 1_000n} is available`
    )
  })

  test("an untouched balance still covers it", async () => {
    const executed = await run(Effect.gen(function*() {
      const signed = yield* Tx.sign(yield* Tx.build(usesGas, { sender: SENDER }), signer)
      return yield* Tx.submit(signed)
    }))
    expect(typeof executed.digest).toBe("string")
  })
})

describe("lockSender: whenPinned with a coin reservation", () => {
  test("a reservation run holds the lock: a send started while it is signed waits for it to land", async () => {
    const { reservation, sendExit, order, overtook } = await run(Effect.gen(function*() {
      const inside = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const reservation = yield* Effect.forkChild(Tx.run(usesGas, { signer, onSigned: gated(inside, gate) }))
      yield* Deferred.await(inside)
      const sending = yield* Effect.forkChild(Tx.run(send, { signer }))
      // Before the fix the send built and executed here, with the reservation
      // released and not yet sent; with it, the send cannot even build.
      const overtook = yield* settleUntil(executions(1))
      yield* Deferred.succeed(gate, undefined)
      return {
        reservation: yield* Fiber.await(reservation),
        sendExit: yield* Fiber.await(sending),
        order: yield* buildAndExecuteOrder,
        overtook
      }
    }))
    expect(Exit.isSuccess(reservation)).toBe(true)
    expect(Exit.isSuccess(sendExit)).toBe(true)
    expect(overtook).toBe(false)
    expect(order).toEqual(["build", "execute", "build", "execute"])
  })

  test("a tx.gas run waits, before it builds, for a lock-free send in flight on its payer", async () => {
    const { reservation, sendExit, order, builtEarly } = await run(Effect.gen(function*() {
      const sendInside = yield* Deferred.make<void>()
      const sendGate = yield* Deferred.make<void>()
      const reservationInside = yield* Deferred.make<void>()
      const reservationGate = yield* Deferred.make<void>()
      const sending = yield* Effect.forkChild(Tx.run(send, { signer, onSigned: gated(sendInside, sendGate) }))
      yield* Deferred.await(sendInside)
      // The send released the lock and is in flight; the tx.gas run starts.
      const reservation = yield* Effect.forkChild(
        Tx.run(usesGas, { signer, onSigned: gated(reservationInside, reservationGate) })
      )
      // Before the fix it built here — reserving the balance the send is about
      // to draw from — and reached its own `onSigned`.
      const builtEarly = yield* settleUntil(Deferred.isDone(reservationInside))
      yield* Deferred.succeed(sendGate, undefined)
      const sendExit = yield* Fiber.await(sending)
      yield* Deferred.await(reservationInside)
      yield* Deferred.succeed(reservationGate, undefined)
      return {
        reservation: yield* Fiber.await(reservation),
        sendExit,
        order: yield* buildAndExecuteOrder,
        builtEarly
      }
    }))
    expect(Exit.isSuccess(sendExit)).toBe(true)
    expect(Exit.isSuccess(reservation)).toBe(true)
    expect(builtEarly).toBe(false)
    expect(order).toEqual(["build", "execute", "build", "execute"])
  })

  test("a lock-free run that fails is no longer in flight: a later tx.gas run does not wait for it", async () => {
    const { failed, later } = await run(Effect.gen(function*() {
      const failed = yield* Effect.exit(
        Tx.run(send, { signer, onSigned: () => Effect.fail(new JournalError({ cause: "outbox down" })) })
      )
      const later = yield* Effect.forkChild(Tx.run(usesGas, { signer }))
      yield* settleUntil(Effect.map(Effect.sync(() => later.pollUnsafe()), (exit) => exit !== undefined))
      return { failed, later: later.pollUnsafe() }
    }))
    expect(Exit.isFailure(failed)).toBe(true)
    expect(later !== undefined && Exit.isSuccess(later)).toBe(true)
  })

  test("a lock-free run that is interrupted in flight is no longer in flight either", async () => {
    const { later } = await run(Effect.gen(function*() {
      const inside = yield* Deferred.make<void>()
      const never = yield* Deferred.make<void>()
      const sending = yield* Effect.forkChild(Tx.run(send, { signer, onSigned: gated(inside, never) }))
      yield* Deferred.await(inside)
      yield* Fiber.interrupt(sending)
      const later = yield* Effect.forkChild(Tx.run(usesGas, { signer }))
      yield* settleUntil(Effect.map(Effect.sync(() => later.pollUnsafe()), (exit) => exit !== undefined))
      return { later: later.pollUnsafe() }
    }))
    expect(later !== undefined && Exit.isSuccess(later)).toBe(true)
  })

  test("two address-balance sends still overlap: both are in onSigned at once", async () => {
    const { overlapped, exits } = await run(Effect.gen(function*() {
      const firstInside = yield* Deferred.make<void>()
      const secondInside = yield* Deferred.make<void>()
      // The first waits, inside `onSigned`, for the second to get there too:
      // with the lock held through submission the second could not.
      const first = yield* Effect.forkChild(Tx.run(send, { signer, onSigned: gated(firstInside, secondInside) }))
      yield* Deferred.await(firstInside)
      const second = yield* Effect.forkChild(
        Tx.run(send, { signer, onSigned: () => Deferred.succeed(secondInside, undefined) })
      )
      const overlapped = yield* settleUntil(Deferred.isDone(secondInside))
      if (!overlapped) yield* Deferred.succeed(secondInside, undefined)
      return { overlapped, exits: [yield* Fiber.await(first), yield* Fiber.await(second)] }
    }))
    expect(overlapped).toBe(true)
    expect(exits.every(Exit.isSuccess)).toBe(true)
  })
})

describe("a lockSender that is not one of the three policies", () => {
  const runWith = (lockSender: unknown) =>
    run(Effect.gen(function*() {
      const executed = yield* Tx.run(send, { signer }).pipe(
        Effect.provideService(SubmitConfig, { ...SubmitConfig.defaults, lockSender: lockSender as never })
      )
      return { executed, sent: (yield* SuiTest.calls("executeTransaction")).length }
    }))

  test("true, false and anything unrecognized still build and send", async () => {
    for (const value of [true, false, "sometimes", undefined]) {
      const { executed, sent } = await runWith(value)
      // Before the fix `Tx.run` answered `undefined` here, sending nothing.
      expect(typeof executed?.digest).toBe("string")
      expect(sent).toBe(1)
    }
  })

  test("an unrecognized value holds the lock through submission, like true", async () => {
    for (const value of [true, "sometimes"]) {
      const overtook = await run(Effect.gen(function*() {
        const inside = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const config = { ...SubmitConfig.defaults, lockSender: value as never }
        const first = yield* Effect.forkChild(
          Tx.run(send, { signer, onSigned: gated(inside, gate) }).pipe(Effect.provideService(SubmitConfig, config))
        )
        yield* Deferred.await(inside)
        const second = yield* Effect.forkChild(
          Tx.run(send, { signer }).pipe(Effect.provideService(SubmitConfig, config))
        )
        const overtook = yield* settleUntil(executions(1))
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return overtook
      }))
      expect(overtook).toBe(false)
    }
  })
})
