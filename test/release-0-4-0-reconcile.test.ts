/**
 * The 0.4.0 dogfood fix round, package F2a: reconcile and submit correctness.
 *
 * - positive "applied by us" evidence vetoes the expiry rule, and a node that
 *   pruned into the validity window cannot prove expiry (indexer#1);
 * - a validator lock conflict on the first send is rechecked before it is
 *   answered, and every `SubmissionUnknown` from a send carries what the send
 *   said (sponsor#1, wallet#5);
 * - an execute answer is journalled before anything can interrupt (wallet#2);
 * - an answer for another digest is not an answer (indexer#8), and a relay
 *   reply with no effects is not an `Executed` (sponsor#9);
 * - `Tx.reconcile` journals what it settles (sponsor#7), and `Tx.resubmit` /
 *   `reconcileAll({ resubmit: true })` re-send identical bytes (sponsor#8,
 *   wallet#6).
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { DateTime, Duration, Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { SuiError } from "../src/domain/errors.ts"
import { EXECUTE_INCLUDE } from "../src/domain/executed.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { SubmitConfigService } from "../src/services/SubmitConfig.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, fakeDigest, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`
const COIN_ID = PADDED("c01")
/** A different, valid digest: the transaction that won a race. */
const OTHER_DIGEST = "11111111111111111111111111111111"

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const coin = {
  objectId: COIN_ID,
  version: "2",
  digest: OTHER_DIGEST,
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: 1_700_000_000_000n,
  epoch: 42n,
  objects: [{
    objectId: ESCROW_ID,
    type: ESCROW_TYPE,
    version: 3n,
    owner,
    content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
  }],
  coins: [coin]
}

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

/** The transaction that consumed the escrow at exactly the version our bytes pinned. */
const consumedByOther = FakeOutcome.succeed({
  digest: OTHER_DIGEST,
  mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, inputVersion: 3n, owner }]
})

const LOCK_CONFLICT = "Transaction is rejected as invalid by more than 1/3 of validators by stake" +
  " (non-retriable). Non-retriable errors: [Object (" + ESCROW_ID + ", SequenceNumber(3), o#…)" +
  ` already locked by a different transaction: TransactionDigest(${OTHER_DIGEST})]`

const config = (overrides: Partial<SubmitConfigService> = {}) =>
  Layer.succeed(SubmitConfig, {
    ...SubmitConfig.defaults,
    reconcileRecheck: Duration.zero,
    resubmitAttempts: 1,
    ...overrides
  })

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript,
  overrides: Partial<SubmitConfigService> = {},
  journal: Layer.Layer<never> = Journal.layerMemory
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(layerTest(script), TestClock.layer(), journal, config(overrides)),
      { local: true }
    )
  )

const signedClaim = Effect.gen(function*() {
  const built = yield* Tx.build(claim, { sender: SENDER })
  return yield* Tx.sign(built, signer)
})

const entryOf = (digest: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    return yield* journal.get(digest as never)
  })

/** Spins until the fake has recorded `count` calls of `method`. */
const awaitCalls = (method: string, count: number) =>
  Effect.gen(function*() {
    while ((yield* SuiTest.calls(method)).length < count) yield* Effect.yieldNow
  })

describe("indexer#1: expiry is never concluded against positive evidence", () => {
  test("an input that names our digest vetoes NotApplied { expired }", async () => {
    // The dogfood repro: getTransaction misses for good (a proxy dropping it, a
    // pruned node), the epoch moves past maxEpoch, and the live object still
    // names this transaction. That applied; it must not be `NotApplied`.
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: signed.digest })
        yield* SuiTest.setEpoch(99n)
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.describe(error)).toContain("names this transaction")
    expect(SuiError.outcome(error)).toBe("unknown")
  })

  test("a node that pruned into the window cannot prove expiry", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.setEpoch(99n)
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        // Epoch 42, where the window starts, began at checkpoint 100; the node
        // holds nothing below 500.
        ledger: { lowestAvailableCheckpoint: 500n, firstCheckpoints: { "42": 100n } }
      }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.describe(error)).toContain("pruned its history to checkpoint 500")
  })

  test("a node whose history covers the window still proves expiry", async () => {
    const { error, asked } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.setEpoch(99n)
        const error = yield* Effect.flip(Tx.reconcile(signed))
        return { error, asked: yield* SuiTest.calls("getEpoch") }
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        ledger: { lowestAvailableCheckpoint: 100n, firstCheckpoints: { "42": 100n } }
      }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("expired")
    // The window's start was asked for by epoch.
    expect((asked[0]?.options as { epoch?: bigint }).epoch).toBe(42n)
  })

  test("an epoch the node no longer serves is not evidence", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.setEpoch(99n)
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        ledger: { lowestAvailableCheckpoint: 500n, firstCheckpoints: {} }
      }
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("on a pruned node, inputConsumed is still evidence", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        yield* SuiTest.recordTransaction(OTHER_DIGEST, consumedByOther)
        yield* SuiTest.setEpoch(99n)
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        ledger: { lowestAvailableCheckpoint: 500n, firstCheckpoints: { "42": 100n } }
      }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("inputConsumed")
  })
})

describe("sponsor#1 / wallet#5: a lock conflict is rechecked, and the send's error is kept", () => {
  test("the winner becoming readable a moment later settles it as inputConsumed", async () => {
    const { error, entry } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const fiber = yield* Effect.forkChild(Effect.flip(Tx.submit(signed)))
        // The first reconcile round has read both pinned objects and found
        // nothing moved: the winner is still settling.
        yield* awaitCalls("getObject", 2)
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        yield* SuiTest.recordTransaction(OTHER_DIGEST, consumedByOther)
        yield* TestClock.adjust("2 seconds")
        const error = yield* Fiber.join(fiber)
        return { error, entry: yield* entryOf(signed.digest) }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("FAILED_PRECONDITION", LOCK_CONFLICT)],
        getTransaction: [FakeOutcome.notFound()]
      },
      { reconcileRecheck: Duration.seconds(2) }
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("inputConsumed")
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("NotApplied"))
  })

  test("still unknown after the rechecks: the cause carries the validator's text", async () => {
    const { error, lookups } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const error = yield* Effect.flip(Tx.submit(signed))
        return { error, lookups: yield* SuiTest.calls("getTransaction") }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("FAILED_PRECONDITION", LOCK_CONFLICT)],
        getTransaction: [FakeOutcome.notFound()]
      }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.describe(error)).toContain("already locked by a different transaction")
    // One reconcile, then three rechecks.
    expect(lookups).toHaveLength(4)
  })

  test("any send failure that ends unknown names what the send said", async () => {
    const { error, lookups } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const error = yield* Effect.flip(Tx.submit(signed))
        return { error, lookups: yield* SuiTest.calls("getTransaction") }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE", "upstream connect error")],
        getTransaction: [FakeOutcome.notFound()]
      }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(SuiError.describe(error)).toContain("upstream connect error")
    // Not a lock conflict: no rechecks.
    expect(lookups).toHaveLength(1)
  })
})

describe("wallet#2: an execute answer is journalled before anything can interrupt", () => {
  test("an interrupt during the Executed write leaves the journal saying Executed", async () => {
    const memory = Journal.makeMemoryUnsafe()
    let writing = false
    const slow = Layer.succeed(Journal, {
      ...memory,
      put: (entry: JournalEntry) =>
        entry._tag === "Executed"
          ? Effect.sync(() => {
            writing = true
          }).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.andThen(memory.put(entry)))
          : memory.put(entry)
    })
    const entry = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const fiber = yield* Effect.forkChild(Tx.submit(signed))
        while (!writing) yield* Effect.yieldNow
        // Interrupting waits for the uninterruptible write, which waits on the
        // clock: interrupt from the side and move the clock.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
        yield* TestClock.adjust("1 second")
        yield* Fiber.join(interrupting)
        return yield* memory.get(signed.digest)
      }),
      { ...baseScript, execute: [executed] },
      {},
      slow
    )
    expect(Option.map(entry, (e) => e._tag)).toEqual(Option.some("Executed"))
  })
})

describe("indexer#8 / sponsor#9: an answer must be about these bytes", () => {
  test("submitVia: an SDK result for another digest reconciles instead of returning it", async () => {
    // The fake refuses to script an execute answer whose digest differs from
    // the bytes', so the foreign answer is a real one: another transaction's
    // own execute result, handed back by a confused relay.
    const { error, entry } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const other = yield* signedClaim
        expect(other.digest).not.toBe(signed.digest)
        const sui = yield* Sui
        const foreign = yield* sui.core.executeTransaction({
          transaction: other.bytes,
          signatures: [...other.signatures],
          include: EXECUTE_INCLUDE
        })
        yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound()])
        const error = yield* Effect.flip(Tx.submitVia(signed, () => Effect.succeed(foreign)))
        return { error, entry: yield* entryOf(signed.digest) }
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("Unknown"))
  })

  test("submitVia: a reply with a digest and no effects asks the chain", async () => {
    const result = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        return yield* Tx.submitVia(signed, () => Effect.succeed({ digest: signed.digest }))
      }),
      { ...baseScript, getTransaction: [executed] }
    )
    // A hollow `Executed` would have created nothing.
    expect(result.created(RECEIPT_TYPE as never)).toHaveLength(1)
  })

  test("submitVia: a reduced envelope that reports failure asks the chain for the reason", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        return yield* Effect.flip(
          Tx.submitVia(signed, () =>
            Effect.succeed({ digest: signed.digest, effects: { status: { success: false } } }))
        )
      }),
      {
        ...baseScript,
        getTransaction: [
          FakeOutcome.failWith({ $kind: "MoveAbort", message: "aborted", MoveAbort: { abortCode: "3" } } as never)
        ]
      }
    )
    expect(error._tag).toBe("ExecutionFailed")
  })
})

describe("sponsor#7: Tx.reconcile journals what it settles", () => {
  test("an Unknown entry becomes NotApplied when reconcile proves it", async () => {
    const { before, after } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* Effect.flip(Tx.submit(signed))
        const before = yield* entryOf(signed.digest)
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        yield* SuiTest.recordTransaction(OTHER_DIGEST, consumedByOther)
        yield* Effect.flip(Tx.reconcile(signed))
        return { before, after: yield* entryOf(signed.digest) }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE")],
        getTransaction: [FakeOutcome.notFound()]
      }
    )
    expect(Option.map(before, (e: JournalEntry) => e._tag)).toEqual(Option.some("Unknown"))
    expect(Option.map(after, (e: JournalEntry) => e._tag)).toEqual(Option.some("NotApplied"))
  })

  test("a digest the journal never held is not written", async () => {
    const entry = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* Tx.reconcile(signed)
        return yield* entryOf(signed.digest)
      }),
      { ...baseScript, getTransaction: [executed] }
    )
    expect(Option.isNone(entry)).toBe(true)
  })
})

describe("sponsor#8 / wallet#6: Tx.resubmit re-sends the identical bytes", () => {
  const unknownThenResubmit = (outcomes: ReadonlyArray<FakeOutcome>) =>
    Effect.gen(function*() {
      const signed = yield* signedClaim
      const unknown = yield* Effect.flip(Tx.submit(signed))
      const result = yield* Effect.result(Tx.resubmit(unknown as never))
      const sends = yield* SuiTest.calls("executeTransaction")
      return { signed, unknown, result, sends, entry: yield* entryOf(signed.digest) }
    }).pipe((effect) =>
      run(effect, {
        ...baseScript,
        execute: outcomes,
        getTransaction: [FakeOutcome.notFound()]
      })
    )

  test("a SubmissionUnknown resubmitted lands, and the journal says Executed", async () => {
    const { unknown, result, sends, entry } = await unknownThenResubmit([
      FakeOutcome.transportError("UNAVAILABLE"),
      executed
    ])
    expect(unknown._tag).toBe("SubmissionUnknown")
    expect(result._tag).toBe("Success")
    expect(sends).toHaveLength(2)
    const bytes = sends.map((call) => (call.options as { transaction: Uint8Array }).transaction)
    expect(bytes[1]).toEqual(bytes[0])
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("Executed"))
  })

  test("a refusal on the re-send is not taken as 'nothing executed'", async () => {
    const { result, entry } = await unknownThenResubmit([
      FakeOutcome.transportError("UNAVAILABLE"),
      FakeOutcome.transportError("INVALID_ARGUMENT")
    ])
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("SubmissionUnknown")
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("Unknown"))
  })

  test("bytes whose window has closed are not sent; they are reconciled", async () => {
    const { result, sends } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.setEpoch(99n)
        const result = yield* Effect.result(Tx.resubmit(signed))
        return { result, sends: yield* SuiTest.calls("executeTransaction") }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(sends).toHaveLength(0)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("NotApplied")
  })

  test("a digest the journal holds as NotApplied is not sent again", async () => {
    const { result, sends } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* Effect.flip(Tx.submit(signed))
        const result = yield* Effect.result(Tx.resubmit(signed))
        return { result, sends: yield* SuiTest.calls("executeTransaction") }
      }),
      { ...baseScript, execute: [FakeOutcome.transportError("INVALID_ARGUMENT")] }
    )
    expect(sends).toHaveLength(1)
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("NotApplied")
  })

  test("reconcileAll({ resubmit: true }) re-sends what is still unknown", async () => {
    const { plain, resent, sends, entry } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* Effect.flip(Tx.submit(signed))
        const plain = yield* Tx.reconcileAll()
        const resent = yield* Tx.reconcileAll({ resubmit: true })
        return {
          plain,
          resent,
          sends: yield* SuiTest.calls("executeTransaction"),
          entry: yield* entryOf(signed.digest)
        }
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE"), executed],
        getTransaction: [FakeOutcome.notFound()]
      }
    )
    expect(plain.map((r) => r._tag)).toEqual(["SubmissionUnknown"])
    expect(resent.map((r) => r._tag)).toEqual(["Executed"])
    expect(sends).toHaveLength(2)
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("Executed"))
  })
})

describe("a reconcile answer for another digest is not an answer", () => {
  /** A digest that is neither ours nor {@link OTHER_DIGEST}. */
  const THIRD_DIGEST = fakeDigest(201)

  test("getTransaction answering another digest is SubmissionUnknown, and the entry stays unresolved", async () => {
    const { result, entry, foreign } = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        const journal = yield* Journal
        yield* journal.put(JournalEntry.cases.Signed.make({
          _tag: "Signed",
          digest: signed.digest,
          signed,
          signedAt: yield* DateTime.now
        }))
        const result = yield* Effect.result(Tx.reconcile(signed))
        return { result, entry: yield* entryOf(signed.digest), foreign: yield* entryOf(OTHER_DIGEST) }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.succeed({ digest: OTHER_DIGEST })] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("SubmissionUnknown")
      expect(SuiError.describe(result.failure)).toContain(OTHER_DIGEST)
    }
    expect(Option.map(entry, (e: JournalEntry) => e._tag)).toEqual(Option.some("Signed"))
    expect(Option.isNone(foreign)).toBe(true)
  })

  test("an ExecutionFailed for another digest is not trusted either", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.failWith(
          { $kind: "MoveAbort", message: "aborted", MoveAbort: { abortCode: "3" } } as never,
          { digest: OTHER_DIGEST }
        )]
      }
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("a consumer whose answer carries the wrong digest is not inputConsumed evidence", async () => {
    const error = await run(
      Effect.gen(function*() {
        const signed = yield* signedClaim
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        // Asked about OTHER_DIGEST, the node answers for a third transaction
        // whose effects would otherwise prove our pinned version consumed.
        yield* SuiTest.recordTransaction(
          OTHER_DIGEST,
          FakeOutcome.succeed({
            digest: THIRD_DIGEST,
            mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, inputVersion: 3n, owner }]
          })
        )
        return yield* Effect.flip(Tx.reconcile(signed))
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })
})
