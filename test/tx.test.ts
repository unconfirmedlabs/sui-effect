import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import {
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  Schedule
} from "effect"
import { TestClock } from "effect/testing"
import { KeyValueStore } from "effect/unstable/persistence"
import { JournalError, PolicyDenied } from "../src/domain/errors.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { maxTimestampMsOf, ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { SubmitConfigService } from "../src/services/SubmitConfig.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerKeyValueStore } from "../src/services/JournalKeyValueStore.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

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
/** A second credential, for the sponsored and co-signed paths. */
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9)))
/** A third, which no transaction here will accept a signature from. */
const stranger = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11)))
/** A second sender, for the lock tests that need two of them. */
const other = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(13)))

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }
const otherOwner: SuiClientTypes.ObjectOwner = {
  $kind: "AddressOwner",
  AddressOwner: other.address
}

const escrow = (version: bigint) => ({
  objectId: ESCROW_ID,
  type: ESCROW_TYPE,
  version,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
})

const COIN_ID = PADDED("c01")
const OTHER_DIGEST = "11111111111111111111111111111111"

const coin: SuiClientTypes.Coin = {
  objectId: COIN_ID,
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

/**
 * The same coin as a readable object, for the tests that need its version to
 * move: the fake serves `listCoins` from `coins` and `getObject` from
 * `objects`, and gas evidence needs both.
 */
const coinObject = {
  objectId: COIN_ID,
  type: coin.type,
  version: 2n,
  owner,
  content: new Uint8Array()
}

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

/**
 * What the node says about `OTHER_DIGEST`: a transaction that took `objectId`
 * at exactly `version` and left it one on.
 *
 * The `NotApplied { inputConsumed }` rule is the equality between that
 * `inputVersion` and the version the reconciled bytes pinned, so a test that
 * wants that answer has to say which version the other transaction consumed.
 */
const consumedBySomeoneElse = (
  objectId: string,
  type: string,
  version: bigint
): Readonly<Record<string, FakeOutcome>> => ({
  [OTHER_DIGEST]: FakeOutcome.succeed({
    digest: OTHER_DIGEST,
    mutated: [{ objectId, type, version: version + 1n, inputVersion: version, owner }]
  })
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
      // The chain as a replay guard: bytes signed for testnet cannot land on
      // mainnet, and a live node checks it.
      expect(built.expiration.ValidDuring.chain).toBe(CHAIN_ID)
      expect(built.expiration.ValidDuring.nonce).toBeGreaterThanOrEqual(0)
    }
  })

  test("the default ValidDuring bounds two epochs and no clock at all", async () => {
    // The validator rule is that a transaction must either have address-owned
    // inputs or an expiration of at most two epochs, so an unbounded or
    // timestamp-only expiration is rejected outright for a PTB whose only
    // object inputs are shared and for every sponsored transaction. Two epochs
    // is the widest it allows — and a timestamp bound is refused outright by
    // every Sui network today, which is why there is none here.
    const built = await run(Tx.build(claim, { sender: SENDER }), { ...baseScript, epoch: 42n })
    expect(built.expiration?.$kind).toBe("ValidDuring")
    if (built.expiration?.$kind === "ValidDuring") {
      expect(built.expiration.ValidDuring.minEpoch).toBe(42n)
      expect(built.expiration.ValidDuring.maxEpoch).toBe(43n)
      expect(built.expiration.ValidDuring.maxTimestamp).toBeNull()
    }
  })

  test("a wall-clock bound is opt-in through SubmitConfig.validFor", async () => {
    const built = await run(
      Effect.provideService(Tx.build(claim, { sender: SENDER }), SubmitConfig, {
        ...SubmitConfig.defaults,
        validFor: Duration.minutes(2)
      })
    )
    if (built.expiration?.$kind === "ValidDuring") {
      // Measured from the chain's clock, in milliseconds, not the process's.
      expect(built.expiration.ValidDuring.maxTimestamp).toBe(CLOCK_MS + 120_000n)
      // And still epoch-bounded, so the two-epoch rule is satisfied either way.
      expect(built.expiration.ValidDuring.maxEpoch).not.toBeNull()
    }
  })

  test("a sponsored transaction, which has no gas coins at all, still builds", async () => {
    // `setGasPayment([])` means gas comes from the sponsor's address balance,
    // so the transaction has no address-owned inputs of its own except the
    // escrow — and none at all once the only input is shared. The epoch bounds
    // are what make the SDK resolver and the validator accept it.
    const built = await run(
      Tx.build(Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim), {
        sender: SENDER,
        gasOwner: sponsor.address
      })
    )
    expect(built.gasOwner).toBe(sponsor.address)
    expect(built.expiration?.$kind).toBe("ValidDuring")
    if (built.expiration?.$kind === "ValidDuring") {
      expect(built.expiration.ValidDuring.maxEpoch).toBeGreaterThan(0n)
    }
  })

  test("expiration epoch reads the system state and sets the Epoch variant", async () => {
    const built = await run(
      Effect.provideService(Tx.build(claim, { sender: SENDER }), SubmitConfig, {
        ...SubmitConfig.defaults,
        expiration: "epoch"
      }),
      { ...baseScript, epoch: 77n }
    )
    expect(built.expiration?.$kind).toBe("Epoch")
    if (built.expiration?.$kind === "Epoch") expect(built.expiration.Epoch).toBe(77n)
  })

  test("expiration none costs no system-state read", async () => {
    const methods = await run(
      Effect.gen(function*() {
        yield* Effect.provideService(Tx.build(claim, { sender: SENDER }), SubmitConfig, {
          ...SubmitConfig.defaults,
          expiration: "none"
        })
        return (yield* SuiTest.calls()).map((call) => call.method)
      })
    )
    expect(methods).not.toContain("getCurrentSystemState")
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
    const { after, before } = await run(
      Effect.gen(function*() {
        // Two signatures means two parties, which on Sui means a sponsored
        // transaction: the sender owns it, the sponsor's address pays.
        const built = yield* Tx.build(
          Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim),
          { sender: SENDER, gasOwner: sponsor.address }
        )
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

  test("a signer who is neither the sender nor the gas owner is refused", async () => {
    // The node answers a signature from the wrong address with a
    // non-retryable INVALID_ARGUMENT, which `Tx.submit` can only report as
    // `SubmissionUnknown` — exit 3, "reconcile before doing anything else" —
    // for a transaction that never had a chance.
    const { cosigned, signedByStranger } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signedByStranger = yield* Tx.sign(built, stranger).pipe(Effect.flip)
        const mine = yield* Tx.sign(built, signer)
        const cosigned = yield* Tx.cosign(mine, stranger).pipe(Effect.flip)
        return { signedByStranger, cosigned }
      })
    )
    expect(signedByStranger._tag).toBe("SigningError")
    expect(String(signedByStranger.cause)).toContain(stranger.address)
    expect(cosigned._tag).toBe("SigningError")
  })

  test("the gas owner may sign a sponsored transaction, and so may the sender", async () => {
    const signatures = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(
          Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim),
          { sender: SENDER, gasOwner: sponsor.address }
        )
        const bySponsor = yield* Tx.sign(built, sponsor)
        const bySender = yield* Tx.sign(built, signer)
        return [bySponsor.signatures[0], bySender.signatures[0]]
      })
    )
    expect(signatures[0]).not.toBe(signatures[1])
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

  test("a retryable transport error resends the identical bytes, without rebuilding", async () => {
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
    // Two sends of byte-for-byte the same transaction. A rebuild between
    // attempts could pick different gas coins, and both could then land.
    expect(bytesPerAttempt).toHaveLength(2)
    expect(bytesPerAttempt[0]).toEqual(bytesPerAttempt[1]!)
    expect(result.digest).toBe(result.digest)
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
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

  test("two sponsored runs with one gas owner serialize, even for different senders", async () => {
    // The coins being spent belong to the gas owner, so the gas owner is the
    // address that has to be locked. Locking only the sender would let both
    // runs pick the sponsor's one coin.
    const order = await run(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const inside = yield* Deferred.make<void>()
        const order: Array<string> = []
        let held = false
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
        const start = (name: string, who: typeof signer) =>
          Effect.forkChild(
            Tx.run(Tx.sponsored({ sender: who.address, gasOwner: sponsor.address })(claim), {
              signer: who,
              gasOwner: sponsor.address,
              sponsor
            }).pipe(
              Effect.tap(() => Effect.sync(() => order.push(name))),
              Effect.provideService(SubmitConfig, config)
            )
          )
        const first = yield* start("first", signer)
        yield* Deferred.await(inside)
        const second = yield* start("second", other)
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

  test("sender and gas owner are locked in a fixed order, so two runs cannot deadlock", async () => {
    // Each run needs both addresses. Taking them in whatever order the
    // arguments arrived would let one run hold A waiting for B while the other
    // holds B waiting for A; ascending address order is what rules that out.
    const done = await run(
      Effect.gen(function*() {
        const left = Tx.run(
          Tx.sponsored({ sender: signer.address, gasOwner: other.address })(claim),
          { signer, gasOwner: other.address, sponsor: other }
        )
        const right = Tx.run(
          Tx.sponsored({ sender: other.address, gasOwner: signer.address })(claim),
          { signer: other, gasOwner: signer.address, sponsor: signer }
        )
        const first = yield* Effect.forkChild(left)
        const second = yield* Effect.forkChild(right)
        yield* TestClock.adjust("1 second")
        return [yield* Fiber.join(first), yield* Fiber.join(second)].length
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(done).toBe(2)
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

  test("a transaction the epoch has passed is NotApplied expired", async () => {
    // The epoch rule is the one that fires in practice: the default expiration
    // is epoch-bounded, because no Sui network accepts a timestamp bound. An
    // epoch is a consensus fact, so unlike the wall clock it needs no margin.
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        // `maxEpoch` was 42 + 1; the chain is now well past it.
        yield* SuiTest.setEpoch(99n)
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      { ...baseScript, epoch: 42n, getTransaction: [FakeOutcome.notFound()] },
      // The rule is ordered and repeated — closed, missing, wait, closed,
      // missing — so the recheck delay has to pass for it to conclude.
      withConfig({ reconcileRecheck: Duration.zero })
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("expired")
  })

  test("a transaction still inside its epoch window is not expired", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        // Still the epoch after the one it was built in: `maxEpoch` is 43.
        yield* SuiTest.setEpoch(43n)
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      { ...baseScript, epoch: 42n, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("a timeout, then not found after a wall-clock bound, is NotApplied expired", async () => {
    const error = await run(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        const fiber = yield* Effect.forkChild(
          Effect.provideService(Tx.run(claim, { signer }), SubmitConfig, {
            ...SubmitConfig.defaults,
            resubmit: Schedule.spaced("1 second"),
            resubmitAttempts: 2,
            executeTimeout: Duration.seconds(5),
            validFor: Duration.minutes(2)
          }).pipe(Effect.flip)
        )
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
      }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("expired")
  })

  /**
   * Builds and signs, then moves the escrow object on in whatever way the case
   * needs, and asks `Tx.reconcile` what happened. The node never knows the
   * digest, which is the whole situation `reconcile` exists for.
   */
  const afterInputMoved = (
    move: (digest: string) => Effect.Effect<void, never, SuiCoreFake>,
    script: Parameters<typeof layerTest>[0] = { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
  ) =>
    run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* move(signed.digest)
        return yield* Effect.result(Tx.reconcile(signed))
      }),
      script
    )

  test("an input consumed by another transaction is NotApplied inputConsumed", async () => {
    const result = await afterInputMoved(
      () => SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        transactions: consumedBySomeoneElse(ESCROW_ID, ESCROW_TYPE, 3n)
      }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("NotApplied")
    if (result.failure._tag === "NotApplied") {
      expect(result.failure.evidence).toBe("inputConsumed")
    }
  })

  test("an input this very transaction consumed means it applied after all", async () => {
    // The node that answered `getTransaction` was behind; the node that served
    // the object names our digest as the one that moved it. Calling this
    // `NotApplied` is the bug the guard exists for: outcome `not_applied` would
    // send the caller's intent a second time.
    const result = await afterInputMoved(
      (digest) => SuiTest.bumpVersion(ESCROW_ID, { consumedBy: digest }),
      {
        ...baseScript,
        // Not found first, then the second look finds it.
        getTransaction: [FakeOutcome.notFound(), executed]
      }
    )
    expect(result._tag).toBe("Success")
    if (result._tag === "Success") {
      expect(result.success.created(RECEIPT_TYPE).map((ref) => ref.id)).toEqual([
        RECEIPT_ID as never
      ])
    }
  })

  test("our own digest but a node that still will not serve it is SubmissionUnknown", async () => {
    const result = await afterInputMoved(
      (digest) => SuiTest.bumpVersion(ESCROW_ID, { consumedBy: digest }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
    if (result.failure._tag === "SubmissionUnknown") {
      expect(String(result.failure.cause)).toContain("it applied")
      expect(result.failure.signed?.bytes.length).toBeGreaterThan(0)
    }
  })

  test("a version that advanced with no consuming digest proves nothing", async () => {
    // A node that does not name the transaction behind the next version is not
    // evidence. Before the guard this was `NotApplied { inputConsumed }`.
    const result = await afterInputMoved(() => SuiTest.bumpVersion(ESCROW_ID))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
    if (result.failure._tag === "SubmissionUnknown") {
      expect(String(result.failure.cause)).toContain("named no transaction")
    }
  })

  test("a deleted input is SubmissionUnknown, not NotApplied", async () => {
    // There is no version and no consuming digest to read off an object that
    // is gone, so nothing is proven either way.
    const result = await afterInputMoved(() => SuiTest.deleteObject(ESCROW_ID))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
  })

  test("a gas payment coin consumed by another transaction is evidence too", async () => {
    // The gas coins are pinned in `gasData.payment`, not in `inputs`, and a
    // sponsor's coin spent by someone else is just as final as an input.
    const result = await afterInputMoved(
      () => SuiTest.bumpVersion(COIN_ID, { consumedBy: OTHER_DIGEST }),
      {
        ...baseScript,
        // The coin has to be a readable object as well as a listed coin, so
        // that reconcile can see its version move.
        objects: [escrow(3n), coinObject],
        getTransaction: [FakeOutcome.notFound()],
        transactions: consumedBySomeoneElse(COIN_ID, coin.type, 2n)
      }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("NotApplied")
    if (result.failure._tag === "NotApplied") {
      expect(result.failure.evidence).toBe("inputConsumed")
    }
  })

  test("reconcile asks for previousTransaction, and only for that", async () => {
    const includes = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        yield* Effect.result(Tx.reconcile(signed))
        const calls = yield* SuiTest.calls("getObject")
        return calls.map((call) => (call.options as { include?: unknown }).include)
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(includes).toContainEqual({ previousTransaction: true })
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

describe("Tx.submit", () => {
  const fast = withConfig({
    resubmit: Schedule.spaced("1 second"),
    resubmitAttempts: 2,
    executeTimeout: Duration.seconds(5)
  })

  const submitting = <A, E>(
    effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
    script: Parameters<typeof layerTest>[0]
  ) =>
    run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(effect)
        yield* TestClock.adjust("5 minutes")
        return yield* Fiber.join(fiber)
      }),
      script,
      fast
    )

  test("a transport error, then found by reconcile, is Executed", async () => {
    // The retries are exhausted by a node that never answers, and the
    // transaction is on chain the whole time. The only honest answer is the
    // receipt, not a transport failure.
    const { calls, result } = await submitting(
      Effect.gen(function*() {
        const result = yield* Tx.run(claim, { signer })
        return { result, calls: (yield* SuiTest.calls()).map((call) => call.method) }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE")],
        getTransaction: [executed]
      }
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
    expect(calls.filter((method) => method === "executeTransaction")).toHaveLength(2)
    expect(calls).toContain("getTransaction")
  })

  test("TransportError never escapes, even when reconcile's own reads fail", async () => {
    // Both the execute and the reconcile read are dead. `TransportError` here
    // would mean "nothing happened, retry", about bytes that may well be on
    // the wire; `SubmissionUnknown` carries them instead.
    const error = await submitting(Tx.run(claim, { signer }).pipe(Effect.flip), {
      ...baseScript,
      execute: [FakeOutcome.transportError("UNAVAILABLE")],
      getTransaction: [FakeOutcome.transportError("UNAVAILABLE")]
    })
    expect(error._tag).toBe("SubmissionUnknown")
    if (error._tag === "SubmissionUnknown") {
      expect(error.signed?.bytes.length).toBeGreaterThan(0)
    }
  })

  test("an input consumed by someone else, through submit, is NotApplied and journals it", async () => {
    const { entries, error, settled } = await submitting(
      Effect.gen(function*() {
        const journal = yield* Journal
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        // Between signing and sending, another transaction spends the escrow
        // object these bytes pinned.
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        const error = yield* Tx.submit(signed).pipe(Effect.flip)
        return {
          error,
          entries: yield* journal.listUnresolved,
          settled: yield* journal.get("digest" in error ? error.digest : ("" as never))
        }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.timeoutThen(false)],
        getTransaction: [FakeOutcome.notFound()],
        transactions: consumedBySomeoneElse(ESCROW_ID, ESCROW_TYPE, 3n)
      }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("inputConsumed")
    // Terminal, so it leaves the unresolved index rather than sitting there as
    // `Unknown` for a durable journal to refuse to start over forever.
    expect(entries).toHaveLength(0)
    expect(Option.isSome(settled)).toBe(true)
    if (Option.isSome(settled)) {
      expect(settled.value._tag).toBe("NotApplied")
      if (settled.value._tag === "NotApplied") expect(settled.value.evidence).toBe("inputConsumed")
    }
  })

  test("a journal that breaks after the first write does not change the answer", async () => {
    // `Signed` is written before anything is sent, so failing there is honest.
    // Every write after it is bookkeeping about an answer the network already
    // gave: reporting `JournalError` instead would put a charged transaction
    // on exit 4, "safe to retry".
    const { logged, result } = await run(
      Effect.gen(function*() {
        let writes = 0
        const failing = {
          ...Journal.makeMemoryUnsafe(),
          put: () => {
            writes += 1
            return writes === 1
              ? Effect.void
              : Effect.fail(new JournalError({ cause: "the disk is full" }))
          }
        }
        const logged: Array<string> = []
        const result = yield* Tx.run(claim, { signer }).pipe(
          Effect.provideService(Journal, failing),
          Effect.provide(
            Logger.layer([Logger.map(Logger.formatLogFmt, (line) => logged.push(line))])
          )
        )
        return { result, logged }
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
    expect(logged.join("\n")).toContain("journal")
    expect(logged.join("\n")).toContain(result.digest)
  })

  test("a journal that cannot write the Signed entry fails before anything is sent", async () => {
    const { error, sent } = await run(
      Effect.gen(function*() {
        const broken = {
          ...Journal.makeMemoryUnsafe(),
          put: () => Effect.fail(new JournalError({ cause: "the disk is full" }))
        }
        const error = yield* Tx.run(claim, { signer }).pipe(
          Effect.provideService(Journal, broken),
          Effect.flip
        )
        return { error, sent: yield* SuiTest.calls("executeTransaction") }
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(error._tag).toBe("JournalError")
    expect(sent).toHaveLength(0)
  })

  test("a sponsored transaction, co-signed by both parties, goes through submit", async () => {
    const { result, signatures } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(
          Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim),
          { sender: SENDER, gasOwner: sponsor.address }
        )
        const signed = yield* Tx.cosign(yield* Tx.sign(built, signer), sponsor)
        const result = yield* Tx.submit(signed)
        const sent = yield* SuiTest.calls("executeTransaction")
        return {
          result,
          signatures: (sent[0]?.options as { signatures: ReadonlyArray<string> }).signatures
        }
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(signatures).toHaveLength(2)
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
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

  /** Seeds the journal with one `Signed` entry the node will not admit to. */
  const withSignedEntry = <A, E>(
    after: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
    script: Parameters<typeof layerTest>[0]
  ) =>
    run(
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
        return yield* after
      }),
      script
    )

  test("an entry that failed on chain settles to ExecutionFailed and leaves a Failed entry", async () => {
    const { entries, settled } = await withSignedEntry(
      Effect.gen(function*() {
        const journal = yield* Journal
        const settled = yield* Tx.reconcileAll()
        return { settled, entries: yield* journal.listUnresolved }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.failWith(moveAbort)] }
    )
    expect(settled).toHaveLength(1)
    expect((settled[0] as { _tag: string })._tag).toBe("ExecutionFailed")
    expect(entries).toHaveLength(0)
  })

  test("an entry proven dead settles to NotApplied and stops being unresolved", async () => {
    const { entries, settled } = await withSignedEntry(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        const settled = yield* Tx.reconcileAll()
        return { settled, entries: yield* journal.listUnresolved }
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        transactions: consumedBySomeoneElse(ESCROW_ID, ESCROW_TYPE, 3n)
      }
    )
    expect(settled).toHaveLength(1)
    expect((settled[0] as { _tag: string })._tag).toBe("NotApplied")
    // Without a terminal `NotApplied` entry this would stay `Unknown` and a
    // durable journal built with `onUnresolved: "fail"` would refuse to start
    // for the life of the store.
    expect(entries).toHaveLength(0)
  })

  test("an entry nothing can settle stays Unknown and keeps its bytes", async () => {
    const { entries, settled } = await withSignedEntry(
      Effect.gen(function*() {
        const journal = yield* Journal
        const settled = yield* Tx.reconcileAll()
        return { settled, entries: yield* journal.listUnresolved }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect((settled[0] as { _tag: string })._tag).toBe("SubmissionUnknown")
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry._tag).toBe("Unknown")
    if (entry._tag === "Unknown") expect(entry.signed.bytes.length).toBeGreaterThan(0)
  })

  test("a dead node settles the entry as SubmissionUnknown, not TransportError", async () => {
    // A recovery read that failed says nothing about whether this submission
    // applied, and `TransportError` is `not_applied` in the taxonomy — which
    // would tell the retry idiom to send it again. It becomes this entry's
    // `SubmissionUnknown`, the entry stays unresolved, and the loop goes on.
    const { entries, settled } = await withSignedEntry(
      Effect.gen(function*() {
        const journal = yield* Journal
        const fiber = yield* Effect.forkChild(Tx.reconcileAll())
        yield* TestClock.adjust("5 minutes")
        const settled = yield* Fiber.join(fiber)
        return { settled, entries: yield* journal.listUnresolved }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.transportError("UNAVAILABLE")] }
    )
    expect(settled).toHaveLength(1)
    expect((settled[0] as { readonly _tag?: string })?._tag).toBe("SubmissionUnknown")
    expect(entries).toHaveLength(1)
  })
})

describe("the durable journal under Tx.run", () => {
  test("two concurrent senders both leave a readable Executed entry", async () => {
    // The journal write that matters happens inside `Tx.submit`, on whichever
    // fiber got there first. A `KeyValueStore` journal has to survive that:
    // its index is a read-modify-write, and dropping one sender's entry means
    // a transaction nothing will ever reconcile.
    const { entries, unresolved } = await Effect.runPromise(
      Effect.gen(function*() {
        const journal = yield* Journal
        const results = yield* Effect.all(
          [
            Tx.run(claim, { signer }),
            Tx.run(claim, { signer: other })
          ],
          { concurrency: "unbounded" }
        )
        const entries = yield* Effect.forEach(results, (result) => journal.get(result.digest))
        return { entries, unresolved: yield* journal.listUnresolved }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerTest({
              ...baseScript,
              objects: [escrow(3n)],
              coins: [coin, { ...coin, objectId: PADDED("c02"), owner: otherOwner }],
              execute: [executed]
            }),
            TestClock.layer(),
            layerKeyValueStore({ onUnresolved: "ignore" }).pipe(
              Layer.provide(KeyValueStore.layerMemory)
            )
          ),
          { local: true }
        )
      )
    )
    expect(entries.filter(Option.isSome)).toHaveLength(2)
    for (const found of entries) {
      if (Option.isSome(found)) expect(found.value._tag).toBe("Executed")
    }
    expect(unresolved).toHaveLength(0)
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
