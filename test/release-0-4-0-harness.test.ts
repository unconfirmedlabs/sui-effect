/**
 * The 0.4.0 fix round, package F4b: typed event and publish accessors on
 * `Executed`, and the testing harness — `fakeDigest` branded, `fakeCoin`,
 * `FakeEvent` without `json`, dynamic-field key types under the one Move type
 * rule, execute digests that must be the bytes' own, `visibilityDelay`, a fast
 * `SubmitConfig` in `layerTest`, and `SuiTest.provide`.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Cause, Clock, Effect, Exit, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Executed } from "../src/domain/executed.ts"
import { Digest, ObjectId } from "../src/domain/schemas.ts"
import { bcs as suiSchemaBcs } from "../src/domain/bcs.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import type { SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { FakeOutcome, type FakeScript } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, fakeDigest, layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const PKG = PADDED("b0a2d")
const BOARD_ID = PADDED("b0a")
const NEW_PKG = PADDED("9ac")
const CAP_ID = PADDED("ca9")
const COIN_ID = PADDED("c01")

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const PostedBcs = bcs.struct("Posted", { index: bcs.u64(), author: bcs.Address })
const Posted = suiSchemaBcs(PostedBcs, `${PKG}::board::Posted`)
/** A generic event: the codec names the bare tag, the event the instantiation. */
const Wrapped = suiSchemaBcs(bcs.struct("Wrapped", { value: bcs.u64() }), `${PKG}::board::Wrapped`)

/** No `json`: `FakeEvent` makes it optional (move#17). */
const postedEvent = (index: number) => ({
  packageId: PKG,
  module: "board",
  sender: SENDER,
  eventType: `${PKG}::board::Posted`,
  bcs: PostedBcs.serialize({ index: String(index), author: SENDER }).toBytes()
})

const wrappedEvent = {
  packageId: PKG,
  module: "board",
  sender: SENDER,
  eventType: `${PKG}::board::Wrapped<0x2::sui::SUI>`,
  bcs: bcs.u64().serialize("9").toBytes()
}

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{
    objectId: BOARD_ID,
    type: `${PKG}::board::Board`,
    version: 3n,
    owner,
    content: new Uint8Array()
  }],
  // ext#17: a gas coin with no cast and no extra field.
  coins: [fakeCoin({ objectId: COIN_ID, owner: SENDER, balance: 1_000_000_000n, version: 2n })]
}

const post = (tx: Transaction) => {
  tx.moveCall({ target: `${PKG}::board::post`, arguments: [tx.object(BOARD_ID)] })
}

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript
) => Effect.runPromise(effect.pipe(SuiTest.provide(layerTest(script))))

const runExit = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript
) => Effect.runPromise(Effect.exit(effect).pipe(SuiTest.provide(layerTest(script))))

const execute = (outcome: FakeOutcome, extra: Partial<FakeScript> = {}) =>
  run(Tx.run(post, { signer }), { ...baseScript, execute: [outcome], ...extra })

describe("Executed.eventsOf / expectEvent (move#9)", () => {
  test("selects by the codec's Move type and decodes, in emission order", async () => {
    const executed = await execute(
      FakeOutcome.succeed({ events: [postedEvent(1), wrappedEvent, postedEvent(2)] })
    )
    const posted = await Effect.runPromise(executed.eventsOf(Posted))
    expect(posted.map((event) => event.index)).toEqual(["1", "2"])
    expect(posted[0]?.author).toBe(SENDER)
    // A bare tag matches every instantiation of a generic event.
    const wrapped = await Effect.runPromise(executed.eventsOf(Wrapped))
    expect(wrapped.map((event) => event.value)).toEqual(["9"])
  })

  test("no match is an empty array; an eventType override selects by it", async () => {
    const executed = await execute(FakeOutcome.succeed({ events: [postedEvent(1)] }))
    expect(await Effect.runPromise(executed.eventsOf(Wrapped))).toEqual([])
    const untyped = suiSchemaBcs(PostedBcs)
    const viaOverride = await Effect.runPromise(
      executed.eventsOf(untyped, `${PKG}::board::Posted`)
    )
    expect(viaOverride).toHaveLength(1)
  })

  test("a codec with no Move type fails DecodeError { kind: type }", async () => {
    const executed = await execute(FakeOutcome.succeed({ events: [postedEvent(1)] }))
    const error = await Effect.runPromise(Effect.flip(executed.eventsOf(suiSchemaBcs(PostedBcs))))
    expect(error._tag).toBe("DecodeError")
    expect(error.kind).toBe("type")
  })

  test("bytes that do not parse fail DecodeError { kind: bytes }", async () => {
    const executed = await execute(
      FakeOutcome.succeed({ events: [{ ...postedEvent(1), bcs: new Uint8Array([1, 2]) }] })
    )
    const error = await Effect.runPromise(Effect.flip(executed.eventsOf(Posted)))
    expect(error._tag).toBe("DecodeError")
    expect(error.kind).toBe("bytes")
  })

  test("expectEvent: exactly one decodes; none or two is UnexpectedEffects with the count", async () => {
    const one = await execute(FakeOutcome.succeed({ events: [postedEvent(7)] }))
    expect((await Effect.runPromise(one.expectEvent(Posted))).index).toBe("7")

    const two = await execute(FakeOutcome.succeed({ events: [postedEvent(1), postedEvent(2)] }))
    const many = await Effect.runPromise(Effect.flip(two.expectEvent(Posted)))
    expect(many._tag).toBe("UnexpectedEffects")
    if (many._tag === "UnexpectedEffects") {
      expect(many.found).toHaveLength(2)
      expect(many.expected).toContain("::board::Posted")
    }
    const none = await Effect.runPromise(Effect.flip(one.expectEvent(Wrapped)))
    expect(none._tag).toBe("UnexpectedEffects")
    if (none._tag === "UnexpectedEffects") expect(none.found).toHaveLength(0)
  })
})

describe("Executed.expectPublished (move#10)", () => {
  const publishEffects = {
    effects: {
      version: 2,
      status: { success: true },
      changedObjects: [
        { objectId: NEW_PKG, idOperation: "Created", outputState: "PackageWrite", outputVersion: "1" },
        { objectId: CAP_ID, idOperation: "Created", outputState: "ObjectWrite", outputVersion: "4" }
      ]
    }
  }

  test("a publish answers the package id and the created UpgradeCap", async () => {
    const executed = await Effect.runPromise(Executed.fromPartial({
      digest: fakeDigest(3),
      ...publishEffects,
      objectTypes: { [NEW_PKG]: "package", [CAP_ID]: "0x2::package::UpgradeCap" }
    }))
    const published = await Effect.runPromise(executed.expectPublished())
    expect(published.packageId).toBe(ObjectId.make(NEW_PKG))
    expect(published.upgradeCap.id).toBe(ObjectId.make(CAP_ID))
    expect(published.package.type).toBe("package")
  })

  test("an upgrade answers the new package and the mutated cap", async () => {
    const executed = await Effect.runPromise(Executed.fromPartial({
      digest: fakeDigest(3),
      effects: {
        changedObjects: [
          { objectId: NEW_PKG, idOperation: "Created", outputState: "PackageWrite" },
          { objectId: CAP_ID, idOperation: "None", inputState: "Exists", outputState: "ObjectWrite" }
        ]
      },
      objectTypes: { [NEW_PKG]: "package", [CAP_ID]: `${PADDED("2")}::package::UpgradeCap` }
    }))
    const published = await Effect.runPromise(executed.expectPublished())
    expect(published.packageId).toBe(ObjectId.make(NEW_PKG))
    expect(published.upgradeCap.id).toBe(ObjectId.make(CAP_ID))
  })

  test("no package, or no cap, is UnexpectedEffects", async () => {
    const executed = await execute(FakeOutcome.succeed({}))
    const error = await Effect.runPromise(Effect.flip(executed.expectPublished()))
    expect(error._tag).toBe("UnexpectedEffects")
    expect(error.expected).toBe("exactly one published package")

    const capless = await Effect.runPromise(Executed.fromPartial({
      digest: fakeDigest(3),
      ...publishEffects,
      objectTypes: { [NEW_PKG]: "package" }
    }))
    const noCap = await Effect.runPromise(Effect.flip(capless.expectPublished()))
    expect(noCap.expected).toBe("exactly one 0x2::package::UpgradeCap")
  })
})

describe("the fake", () => {
  test("fakeDigest is a Digest (indexer#10)", async () => {
    const digest: Digest = fakeDigest(1)
    expect(Digest.make(digest)).toBe(digest)
    const executed = await Effect.runPromise(Executed.fromPartial({ digest: fakeDigest(5) }))
    // Compiles without a cast, which is the point.
    expect(executed.digest).toBe(fakeDigest(5))
  })

  test("getDynamicField compares key types under typeMatches (move#16)", async () => {
    const parent = PADDED("9a4e47")
    const key = bcs.Address.serialize(PADDED("1d")).toBytes()
    const names = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const short = yield* sui.core.getDynamicField({
          parentId: parent,
          name: { type: "0x2::object::ID", bcs: key }
        })
        const padded = yield* sui.core.getDynamicField({
          parentId: parent,
          name: { type: `${PADDED("2")}::object::ID`, bcs: key }
        })
        return [short.dynamicField.fieldId, padded.dynamicField.fieldId]
      }),
      {
        ...baseScript,
        dynamicFields: {
          [parent]: [{
            $kind: "DynamicField",
            fieldId: PADDED("f1e1d"),
            type: "0x2::dynamic_field::Field<0x2::object::ID, u64>",
            name: { type: "0x2::object::ID", bcs: key },
            valueType: "u64"
          } as SuiClientTypes.DynamicFieldEntry]
        }
      }
    )
    expect(names).toEqual([PADDED("f1e1d"), PADDED("f1e1d")])
  })

  test("an execute scripted with a digest that is not the bytes' own dies naming both (indexer#8)", async () => {
    const exit = await runExit(
      Tx.run(post, { signer }),
      { ...baseScript, execute: [FakeOutcome.succeed({ digest: fakeDigest(77) })] }
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.pretty(exit.cause)).toContain(`the script answers digest ${fakeDigest(77)}`)
    }
  })

  test("an execute scripted with the bytes' own digest is accepted", async () => {
    const executed = await run(
      Effect.gen(function*() {
        const signed = yield* Tx.sign(yield* Tx.build(post, { sender: SENDER }), signer)
        yield* SuiTest.scriptExecute([FakeOutcome.succeed({ digest: signed.digest })])
        return { executed: yield* Tx.submit(signed), digest: signed.digest }
      }),
      baseScript
    )
    expect(executed.executed.digest).toBe(executed.digest)
  })
})

describe("visibilityDelay (wallet#2 fake gap)", () => {
  test("\"never\" holds the visibility wait until visibilityTimeout, and the outcome stands", async () => {
    const result = await run(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Tx.run(post, { signer }))
        // Let the submit reach its visibility wait.
        for (let i = 0; i < 50; i++) {
          const waits = yield* SuiTest.calls("waitForTransaction")
          if (waits.length > 0) break
          yield* Effect.yieldNow
        }
        const waits = (yield* SuiTest.calls("waitForTransaction")).length
        const early = fiber.pollUnsafe()
        yield* TestClock.adjust("15 seconds")
        const executed = yield* Fiber.join(fiber)
        return { waits, early, executed }
      }),
      { ...baseScript, execute: [FakeOutcome.succeed({})], visibilityDelay: "never" }
    )
    expect(result.waits).toBe(1)
    expect(result.early).toBeUndefined()
    expect(result.executed).toBeInstanceOf(Executed)
  })

  test("a numeric delay is real milliseconds, and setVisibilityDelay changes it", async () => {
    const elapsed = await Effect.runPromise(
      Effect.gen(function*() {
        yield* SuiTest.setVisibilityDelay(40)
        const started = Date.now()
        yield* Tx.run(post, { signer })
        return Date.now() - started
      }).pipe(
        Effect.provide(
          Layer.merge(layerTest({ ...baseScript, execute: [FakeOutcome.succeed({})] }), Journal.layerMemory),
          { local: true }
        )
      )
    )
    expect(elapsed).toBeGreaterThanOrEqual(35)
  })
})

describe("layerTest's fast SubmitConfig (wallet#13)", () => {
  test("a SubmissionUnknown on the real clock re-sends resubmitAttempts times in well under a second", async () => {
    const started = Date.now()
    const { error, sends } = await Effect.runPromise(
      Effect.gen(function*() {
        const error = yield* Effect.flip(Tx.run(post, { signer }))
        const sends = (yield* SuiTest.calls("executeTransaction")).length
        return { error, sends }
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerTest({
              ...baseScript,
              execute: [FakeOutcome.transportError("UNAVAILABLE")],
              getTransaction: [FakeOutcome.notFound()]
            }),
            Journal.layerMemory
          ),
          { local: true }
        )
      )
    )
    expect(error._tag).toBe("SubmissionUnknown")
    expect(sends).toBe(5)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe("SuiTest.provide (ext#18)", () => {
  test("a fresh journal per run, and the TestClock in force", async () => {
    const first = await run(
      Effect.gen(function*() {
        yield* Effect.flip(Tx.run(post, { signer }))
        return (yield* (yield* Journal).listUnresolved).length
      }),
      {
        ...baseScript,
        execute: [FakeOutcome.transportError("UNAVAILABLE")],
        getTransaction: [FakeOutcome.notFound()]
      }
    )
    expect(first).toBe(1)
    const second = await run(
      Effect.gen(function*() {
        const unresolved = (yield* (yield* Journal).listUnresolved).length
        const now = yield* Clock.currentTimeMillis
        return { unresolved, now }
      }),
      baseScript
    )
    expect(second).toEqual({ unresolved: 0, now: 0 })
  })

  test("the layer's own failure comes through typed", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(Sui, (sui) => Effect.succeed(sui.chainId)).pipe(
        SuiTest.provide(layerTest({ network: "mainnet", chainId: "not-the-mainnet-chain" }))
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(error) && error.value._tag).toBe("NetworkMismatch")
    }
  })
})
