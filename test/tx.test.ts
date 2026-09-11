import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { DateTime, Deferred, Duration, Effect, Exit, Fiber, Layer, Option, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { PolicyDenied } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { maxTimestampMsOf, ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { SubmitConfigService } from "../src/services/SubmitConfig.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`
const CLOCK_MS = 1_700_000_000_000n

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7))
const signer = fromKeypair(keypair)
const SENDER = signer.address

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const escrow = (version: bigint) => ({
  objectId: ESCROW_ID,
  type: ESCROW_TYPE,
  version,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
})

const coin: SuiClientTypes.Coin = {
  objectId: PADDED("c01"),
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: CLOCK_MS,
  objects: [escrow(3n)],
  coins: [coin]
}

/** A transaction that consumes the escrow object, so it has one owned input. */
const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

const executed = FakeOutcome.succeed({
  created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
  mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }]
})

const moveAbort: SuiClientTypes.ExecutionError = {
  $kind: "MoveAbort",
  message: "claim aborted",
  command: 0,
  MoveAbort: {
    abortCode: "3",
    location: { package: PADDED("2"), module: "escrow", functionName: "claim" }
  }
} as unknown as SuiClientTypes.ExecutionError

const withConfig = (config: Partial<SubmitConfigService>) =>
  Layer.succeed(SubmitConfig, { ...SubmitConfig.defaults, ...config })

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript,
  extra?: Layer.Layer<never>
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      extra === undefined
        ? Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory)
        : Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory, extra),
      { local: true }
    )
  )

describe("Tx.build", () => {
  test("builds signable bytes and records a ValidDuring expiration", async () => {
    const built = await run(Tx.build(claim, { sender: SENDER }))
    expect(built.bytes.length).toBeGreaterThan(0)
    expect(built.sender).toBe(SENDER)
    expect(built.expiration?.$kind).toBe("ValidDuring")
    if (built.expiration?.$kind === "ValidDuring") {
      // chainTime plus the default two minutes, and the chain as a replay guard.
      expect(built.expiration.ValidDuring.maxTimestamp).toBe(CLOCK_MS + 120_000n)
      expect(built.expiration.ValidDuring.chain).toBe(CHAIN_ID)
    }
  })

  test("leaves an expiration the recipe set alone", async () => {
    const built = await run(
      Tx.build((tx) => {
        claim(tx)
        tx.setExpiration({ Epoch: 42 })
      }, { sender: SENDER })
    )
    expect(built.expiration?.$kind).toBe("Epoch")
    if (built.expiration?.$kind === "Epoch") expect(built.expiration.Epoch).toBe(42n)
  })

  test("sets no expiration of its own when the policy says none", async () => {
    const built = await run(
      Effect.provideService(Tx.build(claim, { sender: SENDER }), SubmitConfig, {
        ...SubmitConfig.defaults,
        expiration: "none"
      })
    )
    // The SDK's own builder writes the `None` variant, which bounds nothing:
    // there is no `maxTimestamp`, so `Tx.reconcile` can never call it expired.
    expect(built.expiration?.$kind).toBe("None")
    expect(maxTimestampMsOf(built.expiration)).toBeUndefined()
  })

  test("maps the resolver's SimulationError to SimulationFailed", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.failWith(moveAbort)] }
    )
    expect(error._tag).toBe("SimulationFailed")
    if (error._tag === "SimulationFailed") expect(error.reason.$kind).toBe("MoveAbort")
  })

  test("refuses a gas budget over the configured maximum", async () => {
    const error = await run(
      Effect.provideService(Tx.build(claim, { sender: SENDER }).pipe(Effect.flip), SubmitConfig, {
        ...SubmitConfig.defaults,
        maxGasBudget: 1n as typeof SubmitConfig.defaults.maxGasBudget
      })
    )
    expect(error._tag).toBe("BuildError")
  })

  test("a recipe that throws is a BuildError", async () => {
    const error = await run(
      Tx.build(() => {
        throw new Error("no")
      }, { sender: SENDER }).pipe(Effect.flip)
    )
    expect(error._tag).toBe("BuildError")
  })
})

describe("Tx.sign and Tx.cosign", () => {
  test("sign produces one signature over the built bytes", async () => {
    const signed = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        return yield* Tx.sign(built, signer)
      })
    )
    expect(signed.signatures).toHaveLength(1)
    expect(signed.digest.length).toBeGreaterThan(0)
    expect(signed.expiration?.$kind).toBe("ValidDuring")
  })

  test("cosign appends a signature and leaves the bytes alone", async () => {
    const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9)))
    const { after, before } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const before = yield* Tx.sign(built, signer)
        const after = yield* Tx.cosign(before, sponsor)
        return { before, after }
      })
    )
    expect(after.signatures).toHaveLength(2)
    expect(after.signatures[0]).toBe(before.signatures[0]!)
    expect(after.bytes).toEqual(before.bytes)
    expect(after.digest).toBe(before.digest)
  })
})

describe("Tx.sponsored", () => {
  test("sets the sender, the gas owner and address-balance gas payment", () => {
    const tx = new Transaction()
    Tx.sponsored({ sender: SENDER, gasOwner: SuiAddress.make(PADDED("5b0")) })(claim)(tx)
    const data = tx.getData()
    expect(data.sender).toBe(SENDER)
    expect(data.gasData.owner).toBe(PADDED("5b0"))
    expect(data.gasData.payment).toEqual([])
  })
})

describe("Tx.run", () => {
  test("the happy path returns Executed and journals Signed then Executed", async () => {
    const { entry, result } = await run(
      Effect.gen(function*() {
        const result = yield* Tx.run(claim, { signer })
        const journal = yield* Journal
        const entry = yield* journal.get(result.digest)
        return { result, entry }
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(result.created(RECEIPT_TYPE).map((ref) => ref.id)).toEqual([RECEIPT_ID as never])
    expect(Option.isSome(entry)).toBe(true)
    if (Option.isSome(entry)) expect(entry.value._tag).toBe("Executed")
  })

  test("an on-chain failure is ExecutionFailed and journals Failed", async () => {
    const { entry, error } = await run(
      Effect.gen(function*() {
        const error = yield* Tx.run(claim, { signer }).pipe(Effect.flip)
        const journal = yield* Journal
        const entry = yield* journal.get("digest" in error ? error.digest : ("" as never))
        return { error, entry }
      }),
      { ...baseScript, execute: [FakeOutcome.failWith(moveAbort)] }
    )
    expect(error._tag).toBe("ExecutionFailed")
    if (error._tag === "ExecutionFailed") {
      expect(error.reason.$kind).toBe("MoveAbort")
      expect(error.command).toBe(0)
    }
    expect(Option.isSome(entry)).toBe(true)
    if (Option.isSome(entry)) expect(entry.value._tag).toBe("Failed")
  })

  test("a retryable transport error resends the identical bytes and succeeds", async () => {
    const { bytesPerAttempt, result } = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }))
        yield* TestClock.adjust("1 minute")
        const result = yield* Fiber.join(fiber)
        const calls = yield* fake.calls
        const bytesPerAttempt = calls
          .filter((call) => call.method === "executeTransaction")
          .map((call) => (call.options as { transaction: Uint8Array }).transaction)
        return { result, bytesPerAttempt }
      }),
      { ...baseScript, execute: [FakeOutcome.transportError("UNAVAILABLE"), executed] }
    )
    expect(bytesPerAttempt).toHaveLength(2)
    expect(bytesPerAttempt[0]).toEqual(bytesPerAttempt[1]!)
    expect(result.digest.length).toBeGreaterThan(0)
  })

  test("preflight denial stops before anything is signed", async () => {
    const error = await run(
      Effect.provideService(Tx.run(claim, { signer }).pipe(Effect.flip), SubmitConfig, {
        ...SubmitConfig.defaults,
        preflight: () => Effect.fail(new PolicyDenied({ rule: "spend", message: "too much" }))
      }),
      { ...baseScript, simulate: [FakeOutcome.succeed()], execute: [executed] }
    )
    expect(error._tag).toBe("PolicyDenied")
  })

  test("two runs from one sender are serialized by the sender lock", async () => {
    const order = await run(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const inside = yield* Deferred.make<void>()
        const order: Array<string> = []
        let held = false
        // `preflight` runs inside the sender lock, so holding it there holds
        // the lock itself.
        const config: SubmitConfigService = {
          ...SubmitConfig.defaults,
          preflight: () =>
            Effect.gen(function*() {
              if (held) return
              held = true
              yield* Deferred.succeed(inside, undefined)
              yield* Deferred.await(gate)
            })
        }
        const start = (name: string) =>
          Effect.forkChild(
            Tx.run(claim, { signer }).pipe(
              Effect.tap(() => Effect.sync(() => order.push(name))),
              Effect.provideService(SubmitConfig, config)
            )
          )
        const first = yield* start("first")
        yield* Deferred.await(inside)
        const second = yield* start("second")
        yield* TestClock.adjust("1 second")
        expect(order).toEqual([])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return order
      }),
      { ...baseScript, simulate: [FakeOutcome.succeed()], execute: [executed] }
    )
    expect(order).toEqual(["first", "second"])
  })
})

describe("Tx.reconcile", () => {
  const fast = withConfig({
    resubmit: Schedule.spaced("1 second"),
    resubmitAttempts: 2,
    executeTimeout: Duration.seconds(5)
  })

  test("a timeout with the transaction still findable returns Executed", async () => {
    const result = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }))
        yield* TestClock.adjust("1 minute")
        return yield* Fiber.join(fiber)
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(true), FakeOutcome.timeoutThen(true)],
        getTransaction: [executed]
      },
      fast
    )
    expect(result.digest.length).toBeGreaterThan(0)
  })

  test("a timeout, then not found before the bound, is SubmissionUnknown", async () => {
    const error = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }).pipe(Effect.flip))
        yield* TestClock.adjust("1 minute")
        return yield* Fiber.join(fiber)
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(false)],
        getTransaction: [FakeOutcome.notFound()]
      },
      fast
    )
    expect(error._tag).toBe("SubmissionUnknown")
    if (error._tag === "SubmissionUnknown") {
      expect(error.signed?.bytes.length).toBeGreaterThan(0)
    }
  })

  test("an unknown submission leaves an Unknown entry carrying the bytes", async () => {
    const entries = await run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }).pipe(Effect.flip))
        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(fiber)
        return yield* journal.listUnresolved
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(false)],
        getTransaction: [FakeOutcome.notFound()]
      },
      fast
    )
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry._tag).toBe("Unknown")
    if (entry._tag === "Unknown") {
      expect(entry.signed.bytes.length).toBeGreaterThan(0)
      expect(entry.attempts).toBe(2)
    }
  })

  test("a timeout, then not found after the bound, is NotApplied expired", async () => {
    const error = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const fiber = yield* Effect.forkChild(Tx.run(claim, { signer }).pipe(Effect.flip))
        yield* TestClock.adjust("1 second")
        // The chain clock passes the recorded bound plus the margin while the
        // submission is in flight.
        yield* fake.setClock(CLOCK_MS + 600_000n)
        yield* TestClock.adjust("1 minute")
        return yield* Fiber.join(fiber)
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(false)],
        getTransaction: [FakeOutcome.notFound()]
      },
      fast
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("expired")
  })

  test("an owned input whose version advanced is NotApplied inputConsumed", async () => {
    const error = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        // Something else spent the escrow object in the meantime.
        yield* fake.setObject(escrow(9n))
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("inputConsumed")
  })

  test("given only a digest, an unknown transaction is SubmissionUnknown with no bytes", async () => {
    const error = await run(
      Tx.reconcile("11111111111111111111111111111111" as never).pipe(Effect.flip),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    if (error._tag === "SubmissionUnknown") expect(error.signed).toBeUndefined()
  })
})

describe("Tx.reconcileAll", () => {
  test("settles what the journal left unresolved and rewrites the entries", async () => {
    const { entries, settled } = await run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* journal.put(
          JournalEntry.cases.Signed.make({
            _tag: "Signed",
            digest: signed.digest,
            signed,
            signedAt: yield* DateTime.now
          })
        )
        const settled = yield* Tx.reconcileAll()
        const entries = yield* journal.listUnresolved
        return { settled, entries }
      }),
      { ...baseScript, getTransaction: [executed] }
    )
    expect(settled).toHaveLength(1)
    expect(entries).toHaveLength(0)
  })
})

describe("Executed accessors over a real run", () => {
  test("createdWhere replaces substring matching", async () => {
    const result = await run(Tx.run(claim, { signer }), { ...baseScript, execute: [executed] })
    const receipts = result.createdWhere((ref) => ref.type?.endsWith("::Receipt") === true)
    expect(receipts.map((ref) => ref.id)).toEqual([RECEIPT_ID as never])
    expect(result.mutated(ESCROW_TYPE).map((ref) => ref.id)).toEqual([ESCROW_ID as never])
  })

  test("expectCreated finds the one object of a type", async () => {
    const ref = await run(
      Effect.gen(function*() {
        const done = yield* Tx.run(claim, { signer })
        return yield* done.expectCreated(RECEIPT_TYPE)
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(ref.id).toBe(ObjectId.make(RECEIPT_ID))
    expect(ref.version).toBe(4n as never)
  })
})

describe("the escrow example's shape", () => {
  test("Exit of a run against the fake is a success", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.provide(Tx.run(claim, { signer }), layerTest({ ...baseScript, execute: [executed] }), {
        local: true
      })
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
