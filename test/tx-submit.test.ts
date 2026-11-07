/**
 * Failure handling after a signature: `Tx.submit`, `Tx.submitVia`,
 * `Tx.resubmit`, `Tx.reconcile` and `Tx.reconcileAll`, and the journal each
 * leaves behind. The bytes are built offline; every node answer is a stub of
 * the one `SuiCore` method the path reads — an answer or a fault, never a
 * model of what a node would do.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { toBase58 } from "@mysten/sui/utils"
import { Effect, Fiber, Option } from "effect"
import { TestClock } from "effect/testing"
import { JournalError, ObjectNotFound, TransactionNotFound, TransportError } from "../src/domain/errors.ts"
import type { Digest } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeDigest } from "../src/testing.ts"
import { adjusted, bytes, CHAIN, digestOf, EPOCH, GAS, OWNED, resultOf, run, sequence, signer, type Stubs, transport } from "./support.ts"

const OTHER = fakeDigest(200)
const digestOfDefault = await bytes().then(digestOf)
const digestOfNonce = new Map<number, Digest>()
for (const nonce of [8, 9]) digestOfNonce.set(nonce, await bytes({ nonce }).then(digestOf))
const gets = sequence([() => Effect.fail(new TransactionNotFound({ digest: OTHER }))])
const aborted = { $kind: "MoveAbort", message: "x", command: 0, MoveAbort: { abortCode: "3" } } as unknown as SuiClientTypes.ExecutionError

const signedOf = (opts: Parameters<typeof bytes>[0] = {}) =>
  Effect.gen(function*() {
    const built = yield* Tx.fromBytes(yield* Effect.promise(() => bytes(opts)))
    return yield* Tx.sign(built, signer)
  })
const entryOf = (digest: Digest) => Effect.map(Effect.flatMap(Journal, (journal) => journal.get(digest)), Option.map((entry) => entry._tag))
const unresolved = Effect.map(Effect.flatMap(Journal, (journal) => journal.listUnresolved), (entries) => entries.map((entry) => entry._tag))

type Answer = "ok" | "failed" | "otherDigest" | TransportError
/** `executeTransaction` answering each send in turn, and a visibility wait that sees it at once. */
const sends = (...answers: ReadonlyArray<Answer>) => {
  const sent: Array<Uint8Array> = []
  let next = 0
  const answer = (transaction: Uint8Array) => {
    const a = answers[Math.min(next++, answers.length - 1)]!
    if (a instanceof TransportError) return Effect.fail(a)
    const digest = a === "otherDigest" ? OTHER : digestOf(transaction)
    return Effect.succeed(resultOf(digest, {}, a === "failed" ? aborted : undefined))
  }
  const stubs: Stubs = {
    executeTransaction: ((options: { transaction: Uint8Array }) =>
      Effect.suspend(() => {
        sent.push(options.transaction)
        return answer(options.transaction)
      })) as never,
    waitForTransaction: ((options: { digest: string }) => Effect.succeed(resultOf(options.digest))) as never
  }
  return { stubs, sent }
}
/** `getTransaction` answering by digest: `known` is found, anything else is not. */
const lookups = (known: Readonly<Record<string, ReturnType<typeof resultOf> | TransportError>> = {}): Stubs => ({
  getTransaction: ((options: { digest: string }) =>
    Effect.suspend((): Effect.Effect<unknown, unknown> => {
      const answer = known[options.digest]
      if (answer === undefined) return Effect.fail(new TransactionNotFound({ digest: options.digest as Digest }))
      return answer instanceof TransportError ? Effect.fail(answer) : Effect.succeed(answer)
    })) as never
})
const epochIs = (...epochs: ReadonlyArray<bigint>): Stubs => ({
  getCurrentSystemState: sequence(epochs.map((epoch) => () => Effect.succeed({ systemState: { epoch: String(epoch), referenceGasPrice: "1000" } }))).stub
})
/** The pinned objects as the node serves them now: version and the digest that last moved them, or absent. */
const objectsNow = (now: Readonly<Record<string, { readonly version: bigint; readonly by?: string } | "gone">>): Stubs => ({
  getObject: ((options: { objectId: string }) =>
    Effect.suspend(() => {
      const state = now[options.objectId]
      if (state === undefined || state === "gone") return Effect.fail(new ObjectNotFound({ objectId: options.objectId as never }))
      return Effect.succeed({ object: { objectId: options.objectId, version: String(state.version), digest: fakeDigest(1), previousTransaction: state.by ?? null } })
    })) as never
})
const consumedBy = (digest: string, objectId: string, inputVersion: bigint) =>
  resultOf(digest, { mutated: [{ objectId, type: "0x2::escrow::Escrow", version: inputVersion + 10n, inputVersion }] })

describe("Tx.submit", () => {
  test("an execute answer journals Signed then Executed, and the sender is read from the bytes", async () => {
    const [executed, entry, pending] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      const executed = yield* Tx.submit(signed)
      return [executed, yield* entryOf(signed.digest), yield* unresolved] as const
    }))
    expect([executed.sender, entry, pending]).toEqual([signer.address, Option.some("Executed"), []] as never)
  })

  test("an on-chain failure is ExecutionFailed and journals Failed", async () => {
    const [error, entry] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return [yield* Effect.flip(Tx.submit(signed)), yield* entryOf(signed.digest)] as const
    }), {}, sends("failed").stubs)
    expect([error._tag, entry]).toEqual(["ExecutionFailed", Option.some("Failed")] as never)
  })

  test("a retryable failure re-sends the identical bytes, resubmitAttempts times in all", async () => {
    const flaky = sends(transport("executeTransaction", "UNAVAILABLE", true), "ok")
    const executed = await run(Effect.flatMap(signedOf(), Tx.submit), {}, flaky.stubs)
    expect(flaky.sent).toHaveLength(2)
    expect(flaky.sent[1]).toEqual(flaky.sent[0]!)
    expect(executed.digest).toBe(digestOf(flaky.sent[0]!))
    const once = sends(transport("executeTransaction", "UNAVAILABLE", true))
    await run(Effect.flip(Effect.flatMap(signedOf(), Tx.submit)).pipe(SubmitConfig.with({ resubmitAttempts: 1 })), {}, { ...once.stubs, ...lookups() })
    expect(once.sent).toHaveLength(1)
  })

  test("a refusal on the first send is the TransportError, journalled NotApplied { refused }", async () => {
    const refused = sends(transport("executeTransaction", "INVALID_ARGUMENT"))
    const [error, entry] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return [yield* Effect.flip(Tx.submit(signed)), yield* entryOf(signed.digest)] as const
    }), {}, { ...refused.stubs, ...lookups() })
    expect([error._tag, error._tag === "TransportError" && error.status, entry]).toEqual(["TransportError", "INVALID_ARGUMENT", Option.some("NotApplied")] as never)
  })

  test("a refusal after an ambiguous send is reconciled: SubmissionUnknown carrying the bytes, journalled Unknown", async () => {
    const ambiguous = sends(transport("executeTransaction", "UNAVAILABLE", true), transport("executeTransaction", "INVALID_ARGUMENT"))
    const [error, entry] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return [yield* Effect.flip(Tx.submit(signed)), yield* entryOf(signed.digest)] as const
    }), {}, { ...ambiguous.stubs, ...lookups() })
    expect([error._tag, error._tag === "SubmissionUnknown" && error.signed !== undefined, entry]).toEqual(["SubmissionUnknown", true, Option.some("Unknown")] as never)
    expect(String(error._tag === "SubmissionUnknown" && error.cause)).toContain("the last send failed with")
  })

  test("a send that never answers times out at executeTimeout and is reconciled; found, it is Executed", async () => {
    const hang: Stubs = { executeTransaction: (() => Effect.never) as never, waitForTransaction: ((o: { digest: string }) => Effect.succeed(resultOf(o.digest))) as never }
    const executed = await run(adjusted(Effect.flatMap(signedOf(), Tx.submit).pipe(SubmitConfig.with({ resubmitAttempts: 1 }))), {}, {
      ...hang,
      getTransaction: ((options: { digest: string }) => Effect.succeed(resultOf(options.digest))) as never
    })
    expect(executed.digest.length).toBeGreaterThan(0)
  })

  test("an execute answer for another digest is not trusted: the chain is asked about ours", async () => {
    const [error, entry] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return [yield* Effect.flip(Tx.submit(signed)), yield* entryOf(signed.digest)] as const
    }), {}, { ...sends("otherDigest").stubs, ...lookups() })
    expect([error._tag, entry]).toEqual(["SubmissionUnknown", Option.some("Unknown")] as never)
  })

  test("a validator lock conflict is reconciled again, reconcileRecheck apart, until the winner is readable", async () => {
    let reads = 0
    const conflict = sends(new TransportError({ method: "executeTransaction", retryable: false, status: "FAILED_PRECONDITION", cause: new Error(`Object ${OWNED.objectId} already locked by a different transaction: ${OTHER}`) }))
    const winner: Stubs = {
      getObject: ((options: { objectId: string }) =>
        Effect.suspend((): Effect.Effect<unknown> => {
          reads += 1
          return reads < 4
            ? Effect.succeed({ object: { objectId: options.objectId, version: "3", digest: fakeDigest(1), previousTransaction: null } })
            : Effect.succeed({ object: { objectId: options.objectId, version: "13", digest: fakeDigest(1), previousTransaction: OTHER } })
        })) as never
    }
    const error = await run(adjusted(Effect.flip(Effect.flatMap(signedOf({ payment: [] }), Tx.submit))), {}, {
      ...conflict.stubs,
      ...winner,
      ...lookups({ [OTHER]: consumedBy(OTHER, OWNED.objectId, 3n) })
    })
    expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
  })

  test("the visibility wait never changes the outcome: a hung wait ends at visibilityTimeout and Executed stands", async () => {
    const hung: Stubs = { ...sends("ok").stubs, waitForTransaction: (() => Effect.never) as never }
    const executed = await run(adjusted(Effect.flatMap(signedOf(), Tx.submit)), {}, hung)
    expect(executed.digest.length).toBeGreaterThan(0)
    const skipped = await run(Effect.flatMap(signedOf(), Tx.submit).pipe(SubmitConfig.with({ awaitVisibility: false })), {}, hung)
    expect(skipped.digest).toBe(executed.digest)
  })

  test("a journal that cannot write Signed fails before anything is sent; one that breaks later does not change the answer", async () => {
    const send = sends("ok")
    const broken = (failAfter: number) =>
      Effect.gen(function*() {
        const memory = yield* Journal
        let writes = 0
        return {
          ...memory,
          put: (entry: Parameters<typeof memory.put>[0]) =>
            writes++ >= failAfter ? Effect.fail(new JournalError({ cause: "disk full" })) : memory.put(entry)
        }
      })
    const before = await run(Effect.gen(function*() {
      const journal = yield* broken(0)
      return yield* Effect.flip(Effect.provideService(Effect.flatMap(signedOf(), Tx.submit), Journal, journal))
    }), {}, send.stubs)
    expect([before._tag, send.sent.length]).toEqual(["JournalError", 0])
    const after = await run(Effect.gen(function*() {
      const journal = yield* broken(1)
      return yield* Effect.provideService(Effect.flatMap(signedOf(), Tx.submit), Journal, journal)
    }), {}, send.stubs)
    expect(after.digest.length).toBeGreaterThan(0)
  })
})

describe("an execute answer is journalled before anything can interrupt", () => {
  test("an interrupt during the Executed write leaves the journal saying Executed", async () => {
    const entry = await run(Effect.gen(function*() {
      const memory = yield* Journal
      let writing = false
      const slow = {
        ...memory,
        put: (entry: Parameters<typeof memory.put>[0]) =>
          entry._tag === "Executed"
            ? Effect.sync(() => (writing = true)).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.andThen(memory.put(entry)))
            : memory.put(entry)
      }
      const signed = yield* signedOf()
      const fiber = yield* Effect.forkChild(Effect.provideService(Tx.submit(signed), Journal, slow))
      while (!writing) yield* Effect.yieldNow
      // Interrupting waits for the uninterruptible write, which waits on the clock.
      const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber))
      yield* TestClock.adjust("1 second")
      yield* Fiber.join(interrupting)
      return yield* memory.get(signed.digest)
    }))
    expect(Option.map(entry, (e) => e._tag)).toEqual(Option.some("Executed"))
  })
})

describe("Tx.reconcile", () => {
  test("a transaction the node knows is Executed (sender from the bytes) or ExecutionFailed", async () => {
    const [executed, failed] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      const failing = yield* signedOf({ nonce: 8 })
      return [yield* Tx.reconcile(signed), yield* Effect.flip(Tx.reconcile(failing))] as const
    }), {}, {
      getTransaction: ((options: { digest: string }) =>
        Effect.succeed(resultOf(options.digest, {}, options.digest === digestOfNonce.get(8)! ? aborted : undefined))) as never
    })
    expect(executed.sender).toBe(signer.address)
    expect(failed._tag).toBe("ExecutionFailed")
  })

  test("given only a digest, an unknown transaction is SubmissionUnknown with no bytes", async () => {
    const error = await run(Effect.flip(Tx.reconcile(OTHER)), {}, lookups())
    expect([error._tag, error._tag === "SubmissionUnknown" && error.signed]).toEqual(["SubmissionUnknown", undefined])
  })

  test("no read failure escapes: a dead node is SubmissionUnknown, never TransportError", async () => {
    const error = await run(Effect.flip(Effect.flatMap(signedOf(), Tx.reconcile)), {}, {
      getTransaction: (() => Effect.fail(transport("getTransaction", "UNAVAILABLE"))) as never
    })
    expect([error._tag, error._tag === "SubmissionUnknown" && error.signed !== undefined]).toEqual(["SubmissionUnknown", true])
  })

  test("an answer for another digest is not an answer: SubmissionUnknown, the entry left unresolved", async () => {
    const error = await run(Effect.flip(Effect.flatMap(signedOf(), Tx.reconcile)), {}, { getTransaction: (() => Effect.succeed(resultOf(OTHER))) as never })
    expect([error._tag, String(error._tag === "SubmissionUnknown" && error.cause)]).toEqual(["SubmissionUnknown", expect.stringContaining(OTHER)])
  })

  describe("expired", () => {
    const expiry = (stubs: Stubs, config: Partial<typeof SubmitConfig.defaults> = {}) =>
      run(adjusted(Effect.flip(Effect.flatMap(signedOf({ inputs: [], payment: [] }), Tx.reconcile).pipe(SubmitConfig.with(config)))), {}, { ...lookups(), ...stubs })

    test("the window observed closed around a miss, twice, reconcileRecheck apart, is NotApplied { expired }", async () => {
      const error = await expiry(epochIs(EPOCH + 2n))
      expect(error._tag === "NotApplied" && error.evidence).toBe("expired")
    })

    test("one observation is not evidence: a window that reads open on the recheck is SubmissionUnknown", async () => {
      expect((await expiry(epochIs(EPOCH + 2n, EPOCH)))._tag).toBe("SubmissionUnknown")
    })

    test("a window still open is SubmissionUnknown, and expiryEvidence: never disables the rule", async () => {
      expect((await expiry(epochIs(EPOCH)))._tag).toBe("SubmissionUnknown")
      expect((await expiry(epochIs(EPOCH + 2n), { expiryEvidence: "never" }))._tag).toBe("SubmissionUnknown")
    })

    test("a node that pruned into the window cannot prove expiry", async () => {
      const pruned: Stubs = {
        use: ((f: (client: never, signal: AbortSignal) => Promise<unknown>) =>
          Effect.promise((signal) => f({
            ledgerService: {
              getServiceInfo: () => ({ response: Promise.resolve({ lowestAvailableCheckpoint: 80n }) }),
              getEpoch: () => ({ response: Promise.resolve({ epoch: { firstCheckpoint: 10n } }) })
            }
          } as never, signal))) as never
      }
      const error = await expiry({ ...epochIs(EPOCH + 2n), ...pruned })
      expect([error._tag, String(error._tag === "SubmissionUnknown" && error.cause)]).toEqual(["SubmissionUnknown", expect.stringContaining("pruned")])
    })

    test("positive evidence vetoes it: an input naming our digest means it applied", async () => {
      const error = await run(adjusted(Effect.flip(Effect.flatMap(signedOf(), Tx.reconcile))), {}, {
        ...lookups(),
        ...epochIs(EPOCH + 2n),
        getObject: ((options: { objectId: string }) =>
          Effect.suspend(() => Effect.succeed({ object: { objectId: options.objectId, version: "9", digest: fakeDigest(1), previousTransaction: digestOfDefault } }))) as never
      })
      expect([error._tag, String(error._tag === "SubmissionUnknown" && error.cause)]).toEqual(["SubmissionUnknown", expect.stringContaining("names this transaction")])
    })
  })

  describe("inputConsumed", () => {
    const reconcileWith = (stubs: Stubs) => run(Effect.flip(Effect.flatMap(signedOf(), Tx.reconcile)), {}, { ...lookups(), ...stubs })

    test("a different transaction whose effects took exactly the pinned version is NotApplied { inputConsumed }", async () => {
      const error = await reconcileWith({ ...objectsNow({ [OWNED.objectId]: { version: 13n, by: OTHER } }), ...lookups({ [OTHER]: consumedBy(OTHER, OWNED.objectId, 3n) }) })
      expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
    })

    test("a consumer of a later version, an input that moved with no digest, or a deleted input proves nothing", async () => {
      const cases: ReadonlyArray<Stubs> = [
        { ...objectsNow({ [OWNED.objectId]: { version: 13n, by: OTHER } }), ...lookups({ [OTHER]: consumedBy(OTHER, OWNED.objectId, 4n) }) },
        objectsNow({ [OWNED.objectId]: { version: 13n } }),
        objectsNow({ [OWNED.objectId]: "gone" }),
        { ...objectsNow({ [OWNED.objectId]: { version: 13n, by: OTHER } }), ...lookups({ [OTHER]: consumedBy(fakeDigest(201), OWNED.objectId, 3n) }) }
      ]
      for (const stubs of cases) expect((await reconcileWith(stubs))._tag).toBe("SubmissionUnknown")
    })

    test("every pinned reference is tried: a gas coin consumed by another transaction is evidence too", async () => {
      const error = await reconcileWith({
        ...objectsNow({ [OWNED.objectId]: { version: 13n }, [GAS.objectId]: { version: 15n, by: OTHER } }),
        ...lookups({ [OTHER]: consumedBy(OTHER, GAS.objectId, 5n) })
      })
      expect(error._tag === "NotApplied" && error.evidence).toBe("inputConsumed")
    })

    test("a coin reservation in the payment is not a pinned object and is never read", async () => {
      const magic = new Uint8Array(32).fill(0xac)
      magic.fill(1, 0, 12)
      const reservation = { objectId: `0x${"cc".repeat(32)}`, version: "0", digest: toBase58(magic) }
      const read: Array<string> = []
      await run(Effect.flip(Effect.flatMap(signedOf({ inputs: [], payment: [reservation] }), Tx.reconcile)), {}, {
        ...lookups(),
        getObject: ((options: { objectId: string }) => Effect.suspend(() => (read.push(options.objectId), Effect.fail(new ObjectNotFound({ objectId: options.objectId as never }))))) as never
      })
      expect(read).toEqual([])
    })
  })

  test("bytes built for another chain are SubmissionUnknown naming both chains, before anything is asked", async () => {
    const OTHER_CHAIN = "GAKP2kaWRjeYfbZz7ZJpXXbe7PswQRPGHHGWGsHdpQZx"
    const error = await run(Effect.gen(function*() {
      const built = yield* Effect.promise(() => bytes({ chain: OTHER_CHAIN }))
      const signature = yield* signer.signTransaction(built)
      return yield* Effect.flip(Tx.reconcile({ digest: digestOf(built), bytes: built, signatures: [signature], sender: signer.address, chain: OTHER_CHAIN }))
    }), {}, lookups())
    expect([error._tag, String(error._tag === "SubmissionUnknown" && error.cause)]).toEqual(["SubmissionUnknown", expect.stringContaining(OTHER_CHAIN)])
    expect(String(error._tag === "SubmissionUnknown" && error.cause)).toContain(CHAIN)
  })

  test("a terminal answer replaces an unresolved journal entry; a digest the journal never held is not written", async () => {
    let landed = false
    const [held, never] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      yield* Effect.flip(Tx.submit(signed).pipe(SubmitConfig.with({ resubmitAttempts: 1 })))
      landed = true
      yield* Tx.reconcile(signed)
      const other = yield* signedOf({ nonce: 9 })
      yield* Tx.reconcile(other)
      return [yield* entryOf(signed.digest), yield* entryOf(other.digest)] as const
    }), {}, {
      ...sends(transport("executeTransaction", "UNAVAILABLE", true)).stubs,
      getTransaction: ((options: { digest: string }) =>
        Effect.suspend(() => landed ? Effect.succeed(resultOf(options.digest)) : Effect.fail(new TransactionNotFound({ digest: options.digest as Digest })))) as never
    })
    expect([held, never]).toEqual([Option.some("Executed"), Option.none()])
  })
})

describe("Tx.resubmit and Tx.reconcileAll", () => {
  test("a SubmissionUnknown resubmitted re-sends the identical bytes and journals the answer", async () => {
    const flaky = sends(transport("executeTransaction", "UNAVAILABLE", true), transport("executeTransaction", "UNAVAILABLE", true), "ok")
    const [executed, entry] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      const unknown = yield* Effect.flip(Tx.submit(signed).pipe(SubmitConfig.with({ resubmitAttempts: 2 })))
      if (unknown._tag !== "SubmissionUnknown") return yield* Effect.die(unknown)
      return [yield* Tx.resubmit(unknown), yield* entryOf(signed.digest)] as const
    }), {}, { ...flaky.stubs, ...lookups() })
    expect(flaky.sent).toHaveLength(3)
    expect(flaky.sent.every((sent) => sent.every((byte, i) => byte === flaky.sent[0]![i]))).toBe(true)
    expect([executed.digest, entry]).toEqual([digestOf(flaky.sent[0]!), Option.some("Executed")] as never)
  })

  test("a refusal on the re-send is not taken as nothing executed", async () => {
    const error = await run(Effect.flip(Effect.flatMap(signedOf(), Tx.resubmit)), {}, { ...sends(transport("executeTransaction", "INVALID_ARGUMENT")).stubs, ...lookups() })
    expect(error._tag).toBe("SubmissionUnknown")
  })

  test("bytes whose window has closed are not sent, and a digest settled NotApplied is not sent again", async () => {
    const closed = sends("ok")
    const error = await run(adjusted(Effect.flip(Effect.flatMap(signedOf({ inputs: [], payment: [] }), Tx.resubmit))), {}, { ...closed.stubs, ...lookups(), ...epochIs(EPOCH + 2n) })
    expect([error._tag, closed.sent.length]).toEqual(["NotApplied", 0])
    const refused = sends(transport("executeTransaction", "INVALID_ARGUMENT"))
    const again = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      yield* Effect.flip(Tx.submit(signed))
      return yield* Effect.flip(Tx.resubmit(signed))
    }), {}, { ...refused.stubs, ...lookups() })
    expect([again._tag, refused.sent.length]).toEqual(["NotApplied", 1])
  })

  test("reconcileAll settles what the journal left unresolved, and with resubmit re-sends what is still unknown", async () => {
    const flaky = sends(transport("executeTransaction", "UNAVAILABLE", true), "ok")
    const [plain, resent, pending] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      yield* Effect.flip(Tx.submit(signed).pipe(SubmitConfig.with({ resubmitAttempts: 1 })))
      const plain = yield* Tx.reconcileAll()
      const resent = yield* Tx.reconcileAll({ resubmit: true })
      return [plain.map((r) => r._tag), resent.map((r) => r._tag), yield* unresolved] as const
    }), {}, { ...flaky.stubs, ...lookups() })
    expect([plain, resent, pending]).toEqual([["SubmissionUnknown"], ["Executed"], []])
  })
})

describe("Tx.submitVia", () => {
  test("journals Signed before calling the sender once, and decodes a reduced envelope", async () => {
    let calls = 0
    let atSend: ReadonlyArray<string> = []
    const executed = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return yield* Tx.submitVia(signed, () =>
        Effect.gen(function*() {
          calls += 1
          atSend = yield* unresolved
          return { digest: signed.digest, effects: { changedObjects: [{ objectId: OWNED.objectId, idOperation: "Created" }] } }
        }))
    }))
    expect([calls, atSend, executed.created().length]).toEqual([1, ["Signed"], 1])
  })

  test("a reply with no envelope, or for another digest, is reconciled by our digest", async () => {
    const [bare, foreign] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      return [yield* Tx.submitVia(signed, () => Effect.succeed(signed.digest)), yield* Tx.submitVia(signed, () => Effect.succeed(resultOf(OTHER)))] as const
    }), {}, { getTransaction: ((options: { digest: string }) => Effect.succeed(resultOf(options.digest))) as never })
    expect(bare.digest).toBe(foreign.digest)
  })

  test("an ambiguous sender failure reconciles; one declaring not_applied fails straight through, settled refused", async () => {
    class RelayRefused extends Error {
      readonly _tag = "RelayRefused"
      readonly outcome = "not_applied"
    }
    const [ambiguous, refused, entry, lookupsMade] = await run(Effect.gen(function*() {
      const signed = yield* signedOf()
      const other = yield* signedOf({ nonce: 9 })
      const ambiguous = yield* Effect.flip(Tx.submitVia(signed, () => Effect.fail(transport("relay.submit", "UNAVAILABLE", true))))
      const before = gets.calls.length
      const refused = yield* Effect.flip(Tx.submitVia(other, () => Effect.fail(new RelayRefused("policy"))))
      return [ambiguous, refused, yield* entryOf(other.digest), gets.calls.length - before] as const
    }), {}, { getTransaction: gets.stub })
    expect([ambiguous._tag, (refused as { _tag: string })._tag, entry, lookupsMade]).toEqual(["SubmissionUnknown", "RelayRefused", Option.some("NotApplied"), 0] as never)
  })
})

