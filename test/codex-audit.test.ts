/**
 * Regression tests for the codex audit of 2026-09-11
 * (`docs/reviews/codex-astra-audit.md`).
 *
 * One block per finding, each reproducing the scenario the audit verified and
 * asserting the behaviour the fix specifies. The numbering is the audit's.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { SimulationError } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import {
  ConfigProvider,
  Context,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import { KeyValueStore } from "effect/unstable/persistence"
import { SuiError, UnexpectedEffects } from "../src/domain/errors.ts"
import { Executed, sdkRefOf } from "../src/domain/executed.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import { ObjectId, SuiAddress, TransactionExpiration } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { make as makeKeyValueJournal } from "../src/services/JournalKeyValueStore.ts"
import { Script } from "../src/services/Script.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import type { SubmitConfigService } from "../src/services/SubmitConfig.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { mapSdkError } from "../src/services/SuiCore.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const OTHER_CHAIN = "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`
const COIN_ID = PADDED("c01")
const SECOND_COIN_ID = PADDED("c02")
const OTHER_DIGEST = "11111111111111111111111111111111"
const CLOCK_MS = 1_700_000_000_000n

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9)))

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }
const sponsorOwner: SuiClientTypes.ObjectOwner = {
  $kind: "AddressOwner",
  AddressOwner: sponsor.address
}

const escrow = (version: bigint) => ({
  objectId: ESCROW_ID,
  type: ESCROW_TYPE,
  version,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
})

const coinOf = (
  objectId: string,
  version: string,
  coinOwner: SuiClientTypes.ObjectOwner = owner
): SuiClientTypes.Coin =>
  ({
    objectId,
    version,
    digest: OTHER_DIGEST,
    type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
    balance: "1000000000",
    owner: coinOwner
  }) as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: CLOCK_MS,
  objects: [escrow(3n)],
  coins: [coinOf(COIN_ID, "2")]
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

const withConfig = (config: Partial<SubmitConfigService>) =>
  Layer.succeed(SubmitConfig, { ...SubmitConfig.defaults, ...config })

/** Under `TestClock`, the way the lifecycle tests run. */
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

/** On the real clock, for the tests that time out for real. */
const runLive = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake>,
  script: Parameters<typeof layerTest>[0] = baseScript
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), Journal.layerMemory), {
      local: true
    })
  )

/** The recheck delay off, so the ordered expiry rule can conclude in a test. */
const noRecheck = withConfig({ reconcileRecheck: Duration.zero })

describe("1. expiration is not proof on its own", () => {
  test("one epoch observation and one miss is SubmissionUnknown, not NotApplied", async () => {
    // The audit's reproduction: submit, script a missing lookup, advance the
    // epoch, and receive `NotApplied { expired }`. A closed window proves the
    // bytes cannot execute *later*; the transaction can have executed between
    // the lookup and the epoch read. The rule is now ordered and repeated, and
    // a lookup that finds the transaction on the second pass wins.
    const result = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* SuiTest.setEpoch(99n)
        // Miss, then the node catches up: the second lookup finds it, so the
        // expiry rule never gets its second observation.
        yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound(), executed])
        return yield* Effect.result(Tx.reconcile(signed))
      }),
      { ...baseScript, epoch: 42n },
      noRecheck
    )
    expect(result._tag).toBe("Success")
  })

  test("expiryEvidence: never leaves an expired transaction unknown", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* SuiTest.setEpoch(99n)
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      { ...baseScript, epoch: 42n, getTransaction: [FakeOutcome.notFound()] },
      withConfig({ expiryEvidence: "never", reconcileRecheck: Duration.zero })
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("the recheck goes through the Clock, so it is drivable", async () => {
    const settled = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* SuiTest.setEpoch(99n)
        const done: Array<string> = []
        const fiber = yield* Effect.forkChild(
          Effect.flip(Tx.reconcile(signed)).pipe(
            Effect.tap((error) => Effect.sync(() => done.push(error._tag)))
          )
        )
        // Nothing settles until the configured recheck delay has passed.
        yield* TestClock.adjust("1 second")
        const early = [...done]
        yield* TestClock.adjust("5 seconds")
        return { early, error: yield* Fiber.join(fiber) }
      }),
      { ...baseScript, epoch: 42n, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(settled.early).toEqual([])
    expect(settled.error._tag).toBe("NotApplied")
  })
})

describe("2. the consumer of a pinned version, not the latest mutation", () => {
  test("T applied, U mutated afterwards: T is not NotApplied", async () => {
    // The audit's reproduction: T consumes version 3, U consumes version 4, the
    // live object names U, and reconciling T reported `NotApplied
    // { inputConsumed }` for a transaction that applied. The consumer of
    // version 3 is named by the object at version 4.
    const result = await run(
      Effect.gen(function*() {
        const executedTx = yield* Tx.run(claim, { signer })
        // U moves the escrow on again.
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        // And this node has forgotten T.
        yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound()])
        return yield* Effect.result(Tx.reconcile(executedTx.digest))
      }),
      { ...baseScript, execute: [executed] },
      noRecheck
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
  })

  test("with the bytes, our own digest on the live object means it applied", async () => {
    const result = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        const outcome = yield* Effect.result(Tx.submit(signed))
        // The escrow now names our digest as the transaction that last mutated
        // it, and the node asked for the receipt has not caught up.
        yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound(), executed])
        return { outcome, settled: yield* Effect.result(Tx.reconcile(signed)) }
      }),
      { ...baseScript, execute: [executed] },
      noRecheck
    )
    expect(result.settled._tag).toBe("Success")
  })

  test("a later transaction that consumed a version we did not pin proves nothing", async () => {
    // The Lamport-version reality (final verification B2): our transaction
    // pinned version 3 and produced version 4, and the transaction that moved
    // the object on took version 4, not 3. It says nothing about ours, and the
    // object "one version on from 3" is the one our own transaction produced.
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        transactions: {
          [OTHER_DIGEST]: FakeOutcome.succeed({
            digest: OTHER_DIGEST,
            mutated: [
              { objectId: ESCROW_ID, type: ESCROW_TYPE, version: 5n, inputVersion: 4n, owner }
            ]
          })
        }
      },
      noRecheck
    )
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("a different transaction that consumed the pinned version is inputConsumed", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        // Someone else took the escrow at version 3 — exactly the version these
        // bytes pinned — so these bytes can never execute.
        yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST })
        return yield* Tx.reconcile(signed).pipe(Effect.flip)
      }),
      {
        ...baseScript,
        getTransaction: [FakeOutcome.notFound()],
        transactions: {
          [OTHER_DIGEST]: FakeOutcome.succeed({
            digest: OTHER_DIGEST,
            mutated: [
              { objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, inputVersion: 3n, owner }
            ]
          })
        }
      },
      noRecheck
    )
    expect(error._tag).toBe("NotApplied")
    if (error._tag === "NotApplied") expect(error.evidence).toBe("inputConsumed")
  })
})

describe("3. UnexpectedEffects comes from a transaction that applied", () => {
  test("outcome is applied", () => {
    expect(
      SuiError.outcome(
        new UnexpectedEffects({
          digest: Schema.decodeUnknownSync(JournalEntry.cases.Signed.fields.digest)(OTHER_DIGEST),
          expected: ESCROW_TYPE,
          found: []
        })
      )
    ).toBe("applied")
  })

  test("a successful run whose receipt is missing does not say not_applied", async () => {
    const error = await run(
      Effect.gen(function*() {
        const done = yield* Tx.run(claim, { signer })
        return yield* done.expectCreated(`${PADDED("2")}::escrow::Missing`).pipe(Effect.flip)
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(error._tag).toBe("UnexpectedEffects")
    expect(SuiError.outcome(error)).toBe("applied")
  })
})

describe("4. public reconcile never leaks a read failure as not-applied", () => {
  test("a dead node during recovery is SubmissionUnknown, not TransportError", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        const fiber = yield* Effect.forkChild(Tx.reconcile(signed).pipe(Effect.flip))
        // `SuiCore` retries a retryable read before giving up.
        yield* TestClock.adjust("5 minutes")
        return yield* Fiber.join(fiber)
      }),
      { ...baseScript, getTransaction: [FakeOutcome.transportError("UNAVAILABLE")] },
      noRecheck
    )
    expect(error._tag).toBe("SubmissionUnknown")
    if (error._tag === "SubmissionUnknown") {
      expect(error.signed?.bytes.length).toBeGreaterThan(0)
    }
  })
})

describe("5. an outer timeout after the bytes were sent", () => {
  const env = () =>
    ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({ SUI_NETWORK: "localnet" })
    )

  test("exits 3, not 4, when the journal still holds the submission", async () => {
    const lines: Array<string> = []
    const codes: Array<number> = []
    const layer = Layer.mergeAll(
      Script.layerWithSigner(signer).pipe(
        Layer.provideMerge(
          layerTest({
            ...baseScript,
            // The execute never answers; the outer timeout interrupts it.
            execute: [FakeOutcome.timeoutThen(false)]
          })
        )
      ),
      Journal.layerMemory
    ).pipe(Layer.provide(env()))
    const code = await Script.run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        return yield* Tx.submit(signed).pipe(Effect.timeout("30 millis"))
      }),
      {
        layer,
        exit: (value) => codes.push(value),
        stderr: (line) => lines.push(line),
        signals: { on: () => undefined, off: () => undefined }
      }
    )
    expect(code).toBe(3)
    expect(codes).toEqual([3])
    // And the unresolved dump runs on a typed failure exit too.
    expect(lines.join("\n")).toContain("unresolved")
  })
})

describe("6. reconciliation refuses evidence from another chain", () => {
  test("bytes built on chain A are SubmissionUnknown against chain B", async () => {
    const built = await run(
      Effect.gen(function*() {
        const draft = yield* Tx.build(claim, { sender: SENDER })
        return yield* Tx.sign(draft, signer)
      }),
      { ...baseScript, epoch: 1n }
    )
    const error = await run(
      Tx.reconcile(built).pipe(Effect.flip),
      {
        ...baseScript,
        chainId: OTHER_CHAIN,
        network: "testnet",
        epoch: 100n,
        getTransaction: [FakeOutcome.notFound()]
      },
      noRecheck
    )
    expect(error._tag).toBe("SubmissionUnknown")
    if (error._tag === "SubmissionUnknown") {
      expect(String(error.cause)).toContain(CHAIN_ID)
      expect(String(error.cause)).toContain(OTHER_CHAIN)
    }
  })

  test("an Epoch expiration, which names no chain, still records one", async () => {
    const built = await run(
      Tx.build(claim, { sender: SENDER }).pipe(
        Effect.provideService(SubmitConfig, { ...SubmitConfig.defaults, expiration: "epoch" })
      )
    )
    expect(built.expiration?.$kind).toBe("Epoch")
    expect(built.chain).toBe(CHAIN_ID)
  })
})

describe("7. the durable journal writes terminal entries before de-indexing", () => {
  test("a store that fails the index write keeps the terminal entry readable", async () => {
    // Fault injection, the audit's own: the failure lands between the two
    // writes. Writing the index first left the store holding a stale `Signed`
    // entry with no index membership, which startup recovery could never find.
    const store = new Map<string, string>()
    let failIndex = false
    const kv = KeyValueStore.makeStringOnly({
      get: (key: string) => Effect.succeed(store.get(key)),
      set: (key: string, value: string) =>
        key.endsWith("index") && failIndex
          ? Effect.fail(
            new KeyValueStore.KeyValueStoreError({ method: "set", message: "the disk is gone" })
          )
          : Effect.sync(() => {
            store.set(key, value)
          }),
      remove: (key: string) =>
        Effect.sync(() => {
          store.delete(key)
        }),
      clear: Effect.sync(() => store.clear()),
      size: Effect.sync(() => store.size)
    })
    const journal = makeKeyValueJournal(kv)
    const digest = Schema.decodeUnknownSync(JournalEntry.cases.Signed.fields.digest)(OTHER_DIGEST)
    const at = DateTime.makeUnsafe(0)
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        yield* journal.put(
          JournalEntry.cases.Signed.make({
            _tag: "Signed",
            digest,
            signed: {
              digest,
              bytes: new Uint8Array([1, 2, 3]),
              signatures: [],
              sender: SuiAddress.make(SENDER)
            },
            signedAt: at
          })
        )
        failIndex = true
        const crashed = yield* Effect.result(
          journal.put(
            JournalEntry.cases.Executed.make({ _tag: "Executed", digest, at })
          )
        )
        failIndex = false
        return { crashed, entry: yield* journal.get(digest), unresolved: yield* journal.listUnresolved }
      })
    )
    expect(outcome.crashed._tag).toBe("Failure")
    // The terminal answer is durable even though the index write failed …
    expect(outcome.entry._tag).toBe("Some")
    if (outcome.entry._tag === "Some") expect(outcome.entry.value._tag).toBe("Executed")
    // … and `listUnresolved` filters it out, so nothing is lost either way.
    expect(outcome.unresolved).toHaveLength(0)
  })

  test("two journals over one prefix share a write permit", async () => {
    // The semaphore is module-level per prefix, so two layer instances in one
    // process cannot interleave their index read-modify-writes.
    const store = new Map<string, string>()
    const kv = KeyValueStore.makeStringOnly({
      get: (key: string) => Effect.succeed(store.get(key)),
      set: (key: string, value: string) =>
        // A yield in the middle of every write is what lets two interleaving
        // writers lose an index entry.
        Effect.andThen(Effect.yieldNow, Effect.sync(() => {
          store.set(key, value)
        })),
      remove: (key: string) =>
        Effect.sync(() => {
          store.delete(key)
        }),
      clear: Effect.sync(() => store.clear()),
      size: Effect.sync(() => store.size)
    })
    const first = makeKeyValueJournal(kv, { prefix: "shared:" })
    const second = makeKeyValueJournal(kv, { prefix: "shared:" })
    const entry = (suffix: string) => {
      const digest = Schema.decodeUnknownSync(JournalEntry.cases.Signed.fields.digest)(
        `${"1".repeat(31)}${suffix}`
      )
      return JournalEntry.cases.Signed.make({
        _tag: "Signed",
        digest,
        signed: {
          digest,
          bytes: new Uint8Array([1]),
          signatures: [],
          sender: SuiAddress.make(SENDER)
        },
        signedAt: DateTime.makeUnsafe(0)
      })
    }
    const unresolved = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.all([first.put(entry("2")), second.put(entry("3"))], {
          concurrency: "unbounded"
        })
        return yield* first.listUnresolved
      })
    )
    expect(unresolved).toHaveLength(2)
  })
})

describe("8. extensions on one client share the sender lock", () => {
  class Locking extends Context.Service<Locking, {
    readonly hold: Effect.Effect<void>
  }>()("codex/Locking") {
    static readonly make = (
      onEnter: () => void,
      onLeave: () => void
    ): Layer.Layer<Locking, never, Sui> =>
      Layer.effect(
        Locking,
        Effect.gen(function*() {
          const sui = yield* Sui
          return {
            hold: sui.withSenderLock(SuiAddress.make(SENDER))(
              Effect.gen(function*() {
                onEnter()
                yield* Effect.sleep("25 millis")
                onLeave()
              })
            )
          }
        })
      )
  }

  test("two registrations on one client never hold the same sender lock at once", async () => {
    // The audit's reproduction: two registrations entered the same-sender
    // critical section simultaneously, because each built its own `Sui` and
    // therefore its own lock map.
    let active = 0
    let peak = 0
    const layer = Locking.make(
      () => {
        active += 1
        peak = Math.max(peak, active)
      },
      () => {
        active -= 1
      }
    )
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const registration = (name: string) =>
      SuiExtension.fromService(Locking, { name, layer }).register(fake.client)
    const first = registration("one")
    const second = registration("two")
    await Promise.all([first.hold(), second.hold()])
    expect(peak).toBe(1)
    await first.$dispose()
    await second.$dispose()
  })

  test("disposing one registration leaves the other working", async () => {
    // The shared base is reference counted, so `$dispose()` on one extension
    // must not tear the transport out from under another on the same client.
    const layer = Locking.make(() => undefined, () => undefined)
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const first = SuiExtension.fromService(Locking, { name: "one", layer }).register(fake.client)
    const second = SuiExtension.fromService(Locking, { name: "two", layer }).register(fake.client)
    await first.hold()
    await second.hold()
    await first.$dispose()
    await second.hold()
    await second.$dispose()
    // And it is not final: a fresh base is built on the next call.
    await second.hold()
    await second.$dispose()
  })
})

describe("9. Tx.run completes a sponsorship or refuses it", () => {
  const sponsoredScript = {
    ...baseScript,
    coins: [coinOf(COIN_ID, "2", sponsorOwner)]
  }

  test("a gas owner with no sponsor is a SigningError before anything is built", async () => {
    const error = await run(
      Tx.run(claim, { signer, gasOwner: SuiAddress.make(sponsor.address) }).pipe(Effect.flip),
      sponsoredScript
    )
    expect(error._tag).toBe("SigningError")
    expect(String((error as { cause: unknown }).cause)).toContain(sponsor.address)
  })

  test("a sponsor cosigns, and the submission carries both signatures", async () => {
    const signatures = await run(
      Effect.gen(function*() {
        yield* Tx.run(claim, {
          signer,
          gasOwner: SuiAddress.make(sponsor.address),
          sponsor
        })
        const sent = yield* SuiTest.calls("executeTransaction")
        return (sent[0]?.options as { signatures: ReadonlyArray<string> }).signatures
      }),
      { ...sponsoredScript, execute: [executed] }
    )
    expect(signatures).toHaveLength(2)
  })

  test("Tx.sponsored's own gas owner is caught too, from the bytes", async () => {
    const error = await run(
      Tx.run(
        Tx.sponsored({
          sender: SuiAddress.make(SENDER),
          gasOwner: SuiAddress.make(sponsor.address)
        })(claim),
        { signer }
      ).pipe(Effect.flip),
      sponsoredScript
    )
    expect(error._tag).toBe("SigningError")
  })

  test("the fake refuses a submission with fewer signatures than signers", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(
          Tx.sponsored({
            sender: SuiAddress.make(SENDER),
            gasOwner: SuiAddress.make(sponsor.address)
          })(claim),
          { sender: SuiAddress.make(SENDER), gasOwner: SuiAddress.make(sponsor.address) }
        )
        const signed = yield* Tx.sign(built, signer)
        return yield* Tx.submit(signed).pipe(Effect.flip)
      }),
      { ...sponsoredScript, execute: [executed], getTransaction: [FakeOutcome.notFound()] },
      noRecheck
    )
    // A validator would refuse it; the fake now does too, so it never settles
    // as an ordinary success.
    expect(error._tag).not.toBe("ExecutionFailed")
  })
})

describe("10. visibility before the lock is released", () => {
  test("a successful submit waits for the transaction to be visible", async () => {
    const waits = await run(
      Effect.gen(function*() {
        yield* Tx.run(claim, { signer })
        return yield* SuiTest.calls("waitForTransaction")
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(waits).toHaveLength(1)
  })

  test("awaitVisibility: false skips it", async () => {
    const waits = await run(
      Effect.gen(function*() {
        yield* Tx.run(claim, { signer })
        return yield* SuiTest.calls("waitForTransaction")
      }),
      { ...baseScript, execute: [executed] },
      withConfig({ awaitVisibility: false })
    )
    expect(waits).toHaveLength(0)
  })

  test("a wait that never answers does not change the outcome", async () => {
    const result = await runLive(
      Effect.gen(function*() {
        // The wait is bounded; the execution already happened, so the answer
        // stands whatever the wait does.
        const done = yield* Tx.run(claim, { signer })
        return done.digest
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(result.length).toBeGreaterThan(0)
  })
})

describe("11. the cold Promise face tells the truth about its member kinds", () => {
  class Faces extends Context.Service<Faces, {
    readonly value: string
    readonly status: Effect.Effect<string>
    readonly listing: (n: number) => Stream.Stream<number>
  }>()("codex/Faces") {
    static readonly layer: Layer.Layer<Faces, never, Sui> = Layer.succeed(Faces, {
      value: "cold",
      status: Effect.succeed("ok"),
      listing: (n: number) => Stream.fromIterable([n, n + 1])
    })
  }

  const registration = () => {
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    return SuiExtension.fromService(Faces, { name: "faces", layer: Faces.layer })
      .register(fake.client)
  }

  test("a cold Stream method is an AsyncIterable, not a Promise of one", async () => {
    const client = registration()
    const seen: Array<number> = []
    for await (const value of client.listing(1)) seen.push(value)
    expect(seen).toEqual([1, 2])
    await client.$dispose()
  })

  test("a cold Effect method is a Promise", async () => {
    const client = registration()
    expect(await client.status()).toBe("ok")
    await client.$dispose()
  })

  test("the declared types hold cold and warm, for all three member kinds", async () => {
    const client = registration()
    // Compile-time: the face types a Stream method as `AsyncIterable`, an
    // Effect method as Promise-returning, and a plain value as itself. These
    // annotations fail to typecheck if any of the three drifts.
    const cold: AsyncIterable<number> = client.listing(1)
    const coldStatus: Promise<string> = client.status()
    expect(await coldStatus).toBe("ok")
    const seenCold: Array<number> = []
    for await (const value of cold) seenCold.push(value)
    await client.$ready()
    const warm: AsyncIterable<number> = client.listing(3)
    const warmStatus: Promise<string> = client.status()
    const warmValue: string = client.value
    const seenWarm: Array<number> = []
    for await (const value of warm) seenWarm.push(value)
    expect({ seenCold, seenWarm, warmValue, warmStatus: await warmStatus }).toEqual({
      seenCold: [1, 2],
      seenWarm: [3, 4],
      warmValue: "cold",
      warmStatus: "ok"
    })
    await client.$dispose()
  })

  test("a cold synchronous member fails with ExtensionNotReady, and $ready fixes it", async () => {
    const client = registration()
    expect(() => JSON.stringify(client.value)).toThrow()
    await client.$ready()
    expect(client.value).toBe("cold")
    await client.$dispose()
  })
})

describe("12. an interrupted build cancels the request it started", () => {
  test("the fake sees an aborted signal", async () => {
    const aborted = await runLive(
      Effect.gen(function*() {
        const fake = yield* SuiCoreFake
        yield* Effect.result(
          Tx.build(claim, { sender: SuiAddress.make(SENDER) }).pipe(Effect.timeout("30 millis"))
        )
        return yield* fake.aborted
      }),
      { ...baseScript, buildSimulate: [FakeOutcome.timeoutThen(false)] }
    )
    expect(aborted).toBeGreaterThan(0)
  })
})

describe("13. a resolver's transport failure is a transport failure", () => {
  test("a SimulationError wrapping an RpcError maps to TransportError", () => {
    const rpc = Object.assign(new Error("connection refused"), {
      code: "UNAVAILABLE",
      name: "RpcError"
    })
    const error = mapSdkError(
      "build",
      new SimulationError("Transaction resolution failed", { cause: rpc })
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag === "TransportError") {
      expect(error.retryable).toBe(true)
      expect(error.status).toBe("UNAVAILABLE")
    }
  })

  test("a SimulationError wrapping an HTTP status error maps to TransportError", () => {
    const http = Object.assign(new Error("bad gateway"), { status: 502 })
    const error = mapSdkError("build", new SimulationError("resolution failed", { cause: http }))
    expect(error._tag).toBe("TransportError")
    if (error._tag === "TransportError") expect(error.retryable).toBe(true)
  })

  test("a SimulationError carrying an executionError stays SimulationFailed", () => {
    const error = mapSdkError(
      "build",
      new SimulationError("aborted", {
        cause: Object.assign(new Error("x"), { code: "UNAVAILABLE" }),
        executionError: {
          $kind: "MoveAbort",
          message: "aborted",
          MoveAbort: { abortCode: "3" }
        } as unknown as SuiClientTypes.ExecutionError
      })
    )
    expect(error._tag).toBe("SimulationFailed")
  })
})

describe("14. building always simulates", () => {
  /** A transaction with nothing left to resolve, which the SDK builds offline. */
  const resolved = (tx: Transaction) => {
    tx.setGasPrice(1000)
    tx.setGasBudget(50_000_000)
    tx.setGasPayment([{ objectId: COIN_ID, version: "2", digest: OTHER_DIGEST }])
    tx.moveCall({ target: `${PADDED("2")}::escrow::ping`, arguments: [] })
  }

  test("a fully resolved transaction still fails on a simulation that aborts", async () => {
    const error = await run(
      Tx.build(resolved, { sender: SuiAddress.make(SENDER) }).pipe(Effect.flip),
      {
        ...baseScript,
        simulate: [
          FakeOutcome.failWith({
            $kind: "MoveAbort",
            message: "would abort",
            MoveAbort: { abortCode: "3" }
          } as unknown as SuiClientTypes.ExecutionError)
        ]
      }
    )
    expect(error._tag).toBe("SimulationFailed")
  })

  test("a transaction the SDK has to resolve costs no extra simulate", async () => {
    const simulates = await run(
      Effect.gen(function*() {
        yield* Tx.build(claim, { sender: SuiAddress.make(SENDER) })
        return yield* SuiTest.calls("simulateTransaction")
      })
    )
    // Exactly one, and it is the **resolver's** — the budget simulation the
    // SDK's resolve plugin makes, which `Tx.build` does not duplicate. Since
    // 0.1.2 the fake records it, so "building always simulates" is visible on
    // the harness instead of being a claim a test could not check.
    expect(simulates).toHaveLength(1)
    expect((simulates[0]!.options as { resolver?: boolean }).resolver).toBe(true)
  })
})

describe("15. the fake's transaction and gas invariants", () => {
  test("re-executing identical bytes does not reapply the changes", async () => {
    // The audit's reproduction: submitting identical signed bytes twice
    // advanced an object from version 3 to version 5.
    const version = await run(
      Effect.gen(function*() {
        const core = yield* Effect.map(Sui, (sui) => sui.core)
        const built = yield* Tx.build(claim, { sender: SuiAddress.make(SENDER) })
        const signed = yield* Tx.sign(built, signer)
        yield* core.executeTransaction({
          transaction: signed.bytes,
          signatures: [...signed.signatures]
        })
        yield* core.executeTransaction({
          transaction: signed.bytes,
          signatures: [...signed.signatures]
        })
        const fake = yield* SuiCoreFake
        const found = yield* fake.readObject(ESCROW_ID)
        return found._tag === "Some" ? found.value.version : -1n
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(version).toBe(4n)
  })

  test("gas selection excludes a coin that is an object input", async () => {
    const payment = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(
          (tx: Transaction) => {
            tx.moveCall({
              target: `${PADDED("2")}::coin::burn`,
              arguments: [tx.object(COIN_ID)]
            })
          },
          { sender: SuiAddress.make(SENDER) }
        )
        return (TransactionDataBuilder.fromBytes(built.bytes).gasData.payment ?? []).map((ref) =>
          ref.objectId
        )
      }),
      {
        ...baseScript,
        objects: [escrow(3n), { objectId: COIN_ID, type: coinOf(COIN_ID, "2").type, version: 2n, owner, content: new Uint8Array() }],
        coins: [coinOf(COIN_ID, "2"), coinOf(SECOND_COIN_ID, "2")]
      }
    )
    expect(payment.map((id) => id.toLowerCase())).not.toContain(COIN_ID)
    expect(payment).toHaveLength(1)
  })

  test("a spent coin leaves the coin set and a gas coin's version moves", async () => {
    const coins = await run(
      Effect.gen(function*() {
        const core = yield* Effect.map(Sui, (sui) => sui.core)
        yield* Tx.run(claim, { signer })
        const { objects } = yield* core.listCoins({ owner: SENDER })
        return objects.map((coin) => ({
          id: coin.objectId,
          version: coin.version,
          balance: coin.balance
        }))
      }),
      {
        ...baseScript,
        coins: [coinOf(COIN_ID, "2"), coinOf(SECOND_COIN_ID, "2")],
        execute: [
          FakeOutcome.succeed({
            created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
            mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }],
            deleted: [
              { objectId: SECOND_COIN_ID, type: coinOf(SECOND_COIN_ID, "2").type, version: 3n }
            ]
          })
        ]
      }
    )
    expect(coins.map((coin) => coin.id.toLowerCase())).not.toContain(SECOND_COIN_ID)
    // The gas coins were mutated by paying for the transaction.
    expect(coins.every((coin) => coin.version === "3")).toBe(true)
  })

  test("a split rewrites the coin's balance, which the next gas selection sees", async () => {
    const balances = await run(
      Effect.gen(function*() {
        const core = yield* Effect.map(Sui, (sui) => sui.core)
        yield* Tx.run(claim, { signer })
        const { objects } = yield* core.listCoins({ owner: SENDER })
        return objects.map((coin) => coin.balance)
      }),
      {
        ...baseScript,
        coins: [coinOf(COIN_ID, "2")],
        execute: [
          FakeOutcome.succeed({
            created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
            mutated: [
              { objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner },
              {
                objectId: COIN_ID,
                type: coinOf(COIN_ID, "2").type,
                version: 3n,
                owner,
                balance: 42n
              }
            ]
          })
        ]
      }
    )
    expect(balances).toEqual(["42"])
  })
})

describe("16. the nonce is configurable", () => {
  test("a supplied allocator is what lands in the expiration", async () => {
    const built = await run(
      Tx.build(claim, { sender: SuiAddress.make(SENDER) }),
      baseScript,
      withConfig({ nonce: Effect.succeed(4242) })
    )
    expect(built.expiration?.$kind).toBe("ValidDuring")
    if (built.expiration?.$kind === "ValidDuring") {
      expect(built.expiration.ValidDuring.nonce).toBe(4242)
    }
  })

  test("an allocator outside the u32 range fails the build rather than the validator", async () => {
    const error = await run(
      Tx.build(claim, { sender: SuiAddress.make(SENDER) }).pipe(Effect.flip),
      baseScript,
      withConfig({ nonce: Effect.succeed(-1) })
    )
    // A `BuildError`: nothing was sent and no node was asked, so calling it a
    // transport failure put a configuration mistake on the retry path.
    expect(error._tag).toBe("BuildError")
    if (error._tag === "BuildError") expect(error.message).toContain("not a u32")
  })
})

describe("17. malformed persisted u64s are typed decode failures", () => {
  const decode = Schema.decodeUnknownEffect(TransactionExpiration)

  test("an epoch that is not a number is a schema failure, not a defect", async () => {
    const exit = await Effect.runPromiseExit(decode({ $kind: "Epoch", Epoch: "not-a-number" }))
    expect(exit._tag).toBe("Failure")
    // A defect would have escaped the declared error channel entirely.
    expect(String(exit)).not.toContain("Cannot convert")
  })

  test("a value above 2^64 is refused", async () => {
    const exit = await Effect.runPromiseExit(
      decode({ $kind: "Epoch", Epoch: "18446744073709551616" })
    )
    expect(exit._tag).toBe("Failure")
  })

  test("a malformed journal entry is a JournalError, not a defect", async () => {
    const store = new Map<string, string>()
    const kv = KeyValueStore.makeStringOnly({
      get: (key: string) => Effect.succeed(store.get(key)),
      set: (key: string, value: string) =>
        Effect.sync(() => {
          store.set(key, value)
        }),
      remove: (key: string) =>
        Effect.sync(() => {
          store.delete(key)
        }),
      clear: Effect.sync(() => store.clear()),
      size: Effect.sync(() => store.size)
    })
    const journal = makeKeyValueJournal(kv)
    const digest = Schema.decodeUnknownSync(JournalEntry.cases.Signed.fields.digest)(OTHER_DIGEST)
    store.set(
      `entry:${digest}`,
      JSON.stringify({
        _tag: "Signed",
        digest,
        signed: {
          digest,
          bytes: "AQID",
          signatures: [],
          sender: SENDER,
          expiration: { $kind: "Epoch", Epoch: "not-a-number" }
        },
        signedAt: 0
      })
    )
    const exit = await Effect.runPromiseExit(journal.get(digest))
    expect(exit._tag).toBe("Failure")
    const error = await Effect.runPromise(Effect.flip(journal.get(digest)))
    expect(error._tag).toBe("JournalError")
  })

  test("a nonce outside the u32 range is refused", async () => {
    const exit = await Effect.runPromiseExit(
      decode({
        $kind: "ValidDuring",
        ValidDuring: {
          minEpoch: "1",
          maxEpoch: "2",
          minTimestamp: null,
          maxTimestamp: null,
          chain: CHAIN_ID,
          nonce: 4_294_967_296
        }
      })
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("20. an ObjectRef the SDK builder accepts", () => {
  test("sdkRefOf renames the id and stringifies the version", () => {
    const executedValue = Schema.decodeUnknownSync(Executed)({
      digest: OTHER_DIGEST,
      effects: {
        version: 2,
        status: { success: true },
        gasUsed: {
          computationCost: "1",
          storageCost: "1",
          storageRebate: "1",
          nonRefundableStorageFee: "0"
        },
        transactionDigest: OTHER_DIGEST,
        gasObject: null,
        eventsDigest: null,
        dependencies: [],
        lamportVersion: null,
        changedObjects: [
          {
            objectId: RECEIPT_ID,
            inputState: "DoesNotExist",
            inputVersion: null,
            inputDigest: null,
            inputOwner: null,
            outputState: "ObjectWrite",
            outputVersion: "4",
            outputDigest: OTHER_DIGEST,
            outputOwner: { $kind: "AddressOwner", AddressOwner: SENDER },
            idOperation: "Created"
          }
        ],
        unchangedConsensusObjects: [],
        auxiliaryDataDigest: null
      },
      events: [],
      balanceChanges: [],
      objectTypes: { [RECEIPT_ID]: RECEIPT_TYPE },
      checkpoint: null,
      timestampMs: null
    })
    const created = executedValue.created()[0]
    expect(created).toBeDefined()
    const ref = sdkRefOf(created!)
    expect(ref).toEqual({ objectId: ObjectId.make(RECEIPT_ID), version: "4", digest: OTHER_DIGEST })
    // And it is what `Transaction#objectRef` takes.
    const tx = new Transaction()
    expect(() => tx.objectRef(ref!)).not.toThrow()
  })

  test("a ref with no version has no SDK form", () => {
    expect(sdkRefOf({ id: ObjectId.make(RECEIPT_ID) })).toBeUndefined()
  })
})

describe("21. wrapped objects", () => {
  const withChange = (change: Record<string, unknown>) =>
    Schema.decodeUnknownSync(Executed)({
      digest: OTHER_DIGEST,
      effects: {
        version: 2,
        status: { success: true },
        gasUsed: {
          computationCost: "1",
          storageCost: "1",
          storageRebate: "1",
          nonRefundableStorageFee: "0"
        },
        transactionDigest: OTHER_DIGEST,
        gasObject: null,
        eventsDigest: null,
        dependencies: [],
        lamportVersion: null,
        changedObjects: [change],
        unchangedConsensusObjects: [],
        auxiliaryDataDigest: null
      },
      events: [],
      balanceChanges: [],
      objectTypes: { [ESCROW_ID]: ESCROW_TYPE },
      checkpoint: null,
      timestampMs: null
    })

  /** The SDK's effects converter shape for a wrap. */
  const wrap = {
    objectId: ESCROW_ID,
    inputState: "Exists",
    inputVersion: "3",
    inputDigest: OTHER_DIGEST,
    inputOwner: { $kind: "AddressOwner", AddressOwner: SENDER },
    outputState: "DoesNotExist",
    outputVersion: null,
    outputDigest: null,
    outputOwner: null,
    idOperation: "None"
  }

  test("deleted() includes a wrapped object", () => {
    expect(withChange(wrap).deleted().map((ref) => ref.id)).toEqual([ObjectId.make(ESCROW_ID)])
  })

  test("wrapped() returns only those", () => {
    expect(withChange(wrap).wrapped().map((ref) => ref.id)).toEqual([ObjectId.make(ESCROW_ID)])
    const deletion = { ...wrap, idOperation: "Deleted" }
    expect(withChange(deletion).wrapped()).toHaveLength(0)
    expect(withChange(deletion).deleted()).toHaveLength(1)
  })

  test("a mutation is neither", () => {
    const mutation = { ...wrap, outputState: "ObjectWrite", outputVersion: "4", outputDigest: OTHER_DIGEST, outputOwner: wrap.inputOwner }
    expect(withChange(mutation).deleted()).toHaveLength(0)
    expect(withChange(mutation).wrapped()).toHaveLength(0)
  })
})

describe("22. an explicit expectedType with no schema", () => {
  test("a conflicting type is a DecodeError", async () => {
    const error = await runLive(
      Effect.flatMap(Sui, (sui) =>
        Effect.flip(
          sui.getObject(ObjectId.make(ESCROW_ID), { expectedType: `${PADDED("2")}::other::Thing` })
        ))
    )
    expect(error._tag).toBe("DecodeError")
  })

  test("the object's own type still passes", async () => {
    const object = await runLive(
      Effect.flatMap(Sui, (sui) =>
        sui.getObject(ObjectId.make(ESCROW_ID), { expectedType: ESCROW_TYPE }))
    )
    expect(String(object.type)).toBe(ESCROW_TYPE)
  })
})
