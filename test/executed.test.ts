/**
 * `Executed` and `Simulation`: decoding an SDK result and the one accessor
 * implementation both share.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { toBase64 } from "@mysten/sui/utils"
import { Effect, Result } from "effect"
import { bcs as suiSchemaBcs } from "../src/domain/bcs.ts"
import { Executed, fromTransactionResult } from "../src/domain/executed.ts"
import { ObjectId, SuiAddress, Version } from "../src/domain/schemas.ts"
import { fromSimulationResult } from "../src/services/Sui.ts"
import { type FakeChange, fakeDigest, type FakeExecution, FakeOutcome, transactionResultOf } from "../src/testing.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SENDER = PADDED("a11ce")
const RECIPIENT = PADDED("b0b")
const PKG = PADDED("b0a2d")
const SUI = `${PADDED("2")}::sui::SUI`
const DIGEST = fakeDigest(42)
const ownedBy = (address: string): SuiClientTypes.ObjectOwner => ({ $kind: "AddressOwner", AddressOwner: address })

const HERO = PADDED("4e70")
const HERO_TYPE = `${PKG}::hero::Hero`
const SWORD = PADDED("5a0d")
const SHIELD = PADDED("5e1d")
const GEM = PADDED("c41d")
const ESCROW = PADDED("e5c")
const GONE = PADDED("90e")
const accumulator: FakeChange = { objectId: PADDED("acc"), type: `${PADDED("2")}::accumulator::U128`, outputState: "AccumulatorWriteV1" }

const effects: FakeExecution = {
  created: [{ objectId: HERO, type: HERO_TYPE, version: 9n, owner: ownedBy(SENDER) }],
  mutated: [
    { objectId: SWORD, type: `${PKG}::hero::Sword`, version: 9n, inputOwner: ownedBy(SENDER), owner: ownedBy(RECIPIENT) },
    { objectId: SHIELD, type: `${PKG}::hero::Shield`, version: 9n, inputOwner: ownedBy(SENDER), owner: { $kind: "Immutable", Immutable: true } },
    { objectId: GEM, type: `${PKG}::hero::Gem`, version: 9n, inputOwner: ownedBy(SENDER), owner: { $kind: "ObjectOwner", ObjectOwner: HERO } },
    { objectId: ESCROW, type: `${PKG}::escrow::Escrow`, version: 9n, owner: ownedBy(SENDER) },
    accumulator
  ],
  deleted: [{ objectId: GONE, type: `${PKG}::hero::Potion`, version: 8n, inputVersion: 7n, owner: ownedBy(SENDER) }],
  balanceChanges: [{ coinType: SUI, address: SENDER, amount: "-1000" }, { coinType: SUI, address: SENDER, amount: "-5" }]
}

const executedOf = (execution: FakeExecution) =>
  Effect.runSync(fromTransactionResult(transactionResultOf(DIGEST, FakeOutcome.succeed(execution)) as never))
const simulationOf = (execution: FakeExecution) =>
  Effect.runSync(fromSimulationResult({ ...transactionResultOf(DIGEST, FakeOutcome.succeed(execution)), commandResults: [] } as never))

const view = (changes: ReturnType<typeof executedOf> | ReturnType<typeof simulationOf>) => ({
  created: changes.created().map((ref) => ref.id),
  createdHero: changes.created("0xb0a2d::hero::Hero").map((ref) => ref.id),
  mutated: changes.mutated().map((ref) => ref.id).sort(),
  deleted: changes.deleted().map((ref) => [ref.id, ref.version]),
  transferred: changes.transferred().map((ref) => [ref.id, ref.inputOwner.$kind, ref.owner.$kind]).sort(),
  balance: changes.balanceChange(SuiAddress.make(SENDER), "0x2::sui::SUI"),
  gas: changes.gasUsedTotal
})

describe("the shared accessors", () => {
  test("a Simulation and the Executed it predicted answer the same, accumulator writes skipped", () => {
    const executed = view(executedOf(effects))
    expect(view(simulationOf(effects))).toEqual(executed)
    expect(executed).toEqual({
      created: [HERO],
      createdHero: [HERO],
      mutated: [ESCROW, GEM, SHIELD, SWORD].sort(),
      deleted: [[GONE, 7n]],
      transferred: [[SWORD, "AddressOwner", "AddressOwner"], [SHIELD, "AddressOwner", "Immutable"], [GEM, "AddressOwner", "ObjectOwner"]].sort(),
      balance: -1005n,
      gas: 2_020_000n
    } as never)
  })

  test("expectCreated answers the one ref, and UnexpectedEffects for none or many", async () => {
    const executed = executedOf(effects)
    expect((await Effect.runPromise(executed.expectCreated(HERO_TYPE))).id).toBe(ObjectId.make(HERO))
    const none = await Effect.runPromise(Effect.flip(executed.expectCreated(`${PKG}::hero::Missing`)))
    expect([none._tag, none.found]).toEqual(["UnexpectedEffects", []])
    const two = executedOf({ created: [effects.created![0]!, { objectId: PADDED("4e71"), type: HERO_TYPE }] })
    expect((await Effect.runPromise(Effect.flip(two.expectCreated(HERO_TYPE)))).found).toHaveLength(2)
  })

  test("transferred: a consensus object whose start version moved, or an owner that stayed, is not a transfer", () => {
    const change = (inputOwner: unknown, outputOwner: unknown) => ({
      objectId: PADDED("1"), inputState: "Exists", inputVersion: "1", inputDigest: "d", inputOwner,
      outputState: "ObjectWrite", outputVersion: "2", outputDigest: "e", outputOwner, idOperation: "None"
    })
    const consensus = (startVersion: string) => ({ $kind: "ConsensusAddressOwner", ConsensusAddressOwner: { startVersion, owner: SENDER } })
    const transferred = (changes: ReadonlyArray<unknown>) =>
      Effect.runSync(Executed.fromPartial({ digest: DIGEST, effects: { changedObjects: changes } })).transferred()
    expect(transferred([change(ownedBy(SENDER), ownedBy(SENDER))])).toEqual([])
    expect(transferred([change(consensus("1"), consensus("2"))])).toEqual([])
    expect(transferred([change(ownedBy(SENDER), consensus("2"))])).toHaveLength(1)
  })

  test("a wrapped object is deleted() and wrapped(); a deletion only deleted()", () => {
    const wrap = {
      objectId: ESCROW, inputState: "Exists", inputVersion: "3", inputDigest: DIGEST, inputOwner: ownedBy(SENDER),
      outputState: "DoesNotExist", outputVersion: null, outputDigest: null, outputOwner: null, idOperation: "None"
    }
    const of = (change: unknown) => Effect.runSync(Executed.fromPartial({ digest: DIGEST, effects: { changedObjects: [change] } }))
    expect([of(wrap).deleted().length, of(wrap).wrapped().length]).toEqual([1, 1])
    const deletion = { ...wrap, idOperation: "Deleted" }
    expect([of(deletion).deleted().length, of(deletion).wrapped().length]).toEqual([1, 0])
  })
})

describe("events", () => {
  const PostedBcs = bcs.struct("Posted", { index: bcs.u64(), author: bcs.Address })
  const Posted = suiSchemaBcs(PostedBcs, `${PKG}::board::Posted`)
  const Wrapped = suiSchemaBcs(bcs.struct("Wrapped", { value: bcs.u64() }), `${PKG}::board::Wrapped`)
  const posted = (index: number) => ({
    packageId: PKG, module: "board", sender: SENDER, eventType: `${PKG}::board::Posted`,
    bcs: PostedBcs.serialize({ index: String(index), author: SENDER }).toBytes()
  })
  const wrapped = { packageId: PKG, module: "board", sender: SENDER, eventType: `${PKG}::board::Wrapped<0x2::sui::SUI>`, bcs: bcs.u64().serialize("9").toBytes() }

  test("eventsOf selects by the codec's type, a bare tag matching every instantiation, in emission order", async () => {
    const executed = executedOf({ events: [posted(1), wrapped, posted(2)] })
    expect((await Effect.runPromise(executed.eventsOf(Posted))).map((event) => event.index)).toEqual(["1", "2"])
    expect((await Effect.runPromise(executed.eventsOf(Wrapped))).map((event) => event.value)).toEqual(["9"])
    expect(await Effect.runPromise(executedOf({}).eventsOf(Posted))).toEqual([])
    expect(await Effect.runPromise(executed.eventsOf(suiSchemaBcs(PostedBcs), `${PKG}::board::Posted`))).toHaveLength(2)
  })

  test("a codec with no Move type is DecodeError { type }; bad bytes DecodeError { bytes }", async () => {
    const executed = executedOf({ events: [posted(1)] })
    expect((await Effect.runPromise(Effect.flip(executed.eventsOf(suiSchemaBcs(PostedBcs))))).kind).toBe("type")
    const garbled = executedOf({ events: [{ ...posted(1), bcs: new Uint8Array([1, 2]) }] })
    expect((await Effect.runPromise(Effect.flip(garbled.eventsOf(Posted)))).kind).toBe("bytes")
  })

  test("expectEvent: exactly one, or UnexpectedEffects with the count", async () => {
    expect((await Effect.runPromise(executedOf({ events: [posted(7)] }).expectEvent(Posted))).index).toBe("7")
    const many = await Effect.runPromise(Effect.flip(executedOf({ events: [posted(1), posted(2)] }).expectEvent(Posted)))
    expect(many._tag === "UnexpectedEffects" && many.found).toHaveLength(2)
  })
})

describe("expectPublished", () => {
  const NEW_PKG = PADDED("9ac")
  const CAP = PADDED("ca9")
  test("a publish answers the package and the created cap; an upgrade the mutated cap; neither is UnexpectedEffects", async () => {
    const published = (capOperation: string, types: Record<string, string>) =>
      Effect.runSync(Executed.fromPartial({
        digest: DIGEST,
        effects: {
          changedObjects: [
            { objectId: NEW_PKG, idOperation: "Created", outputState: "PackageWrite", outputVersion: "1" },
            { objectId: CAP, idOperation: capOperation, inputState: capOperation === "None" ? "Exists" : "DoesNotExist", outputState: "ObjectWrite" }
          ]
        },
        objectTypes: types
      }))
    const types = { [NEW_PKG]: "package", [CAP]: "0x2::package::UpgradeCap" }
    for (const operation of ["Created", "None"]) {
      const answer = await Effect.runPromise(published(operation, types).expectPublished())
      expect([answer.packageId, answer.upgradeCap.id, answer.package.type]).toEqual([ObjectId.make(NEW_PKG), ObjectId.make(CAP), "package"] as never)
    }
    expect((await Effect.runPromise(Effect.flip(executedOf({}).expectPublished()))).expected).toBe("exactly one published package")
    expect((await Effect.runPromise(Effect.flip(published("Created", { [NEW_PKG]: "package" }).expectPublished()))).expected).toBe(
      "exactly one 0x2::package::UpgradeCap"
    )
  })
})

describe("decoding", () => {
  test("a failed transaction is ExecutionFailed with its reason and command, never an Executed", () => {
    const failed = Effect.runSync(Effect.result(fromTransactionResult(transactionResultOf(DIGEST, FakeOutcome.failWith({
      $kind: "MoveAbort", message: "MoveAbort", command: 1, MoveAbort: { abortCode: "3", location: { module: "escrow", functionName: "claim" } }
    } as unknown as SuiClientTypes.ExecutionError)) as never)))
    const error = Result.isFailure(failed) ? failed.failure : undefined
    expect(error?._tag === "ExecutionFailed" && [error.reason.$kind, error.command]).toEqual(["MoveAbort", 1])
  })

  test("fromPartial accepts a relay's reduced envelope, leaving what it was not told Unknown", async () => {
    const executed = await Effect.runPromise(Executed.fromPartial({
      digest: DIGEST,
      sender: "0x2",
      checkpoint: 42,
      timestampMs: "1700000000000",
      objectTypes: { [HERO]: HERO_TYPE },
      balanceChanges: [{ coinType: SUI, address: SENDER, amount: -5 }],
      events: [{ packageId: PKG, module: "board", sender: SENDER, eventType: `${PKG}::board::Posted`, bcs: toBase64(new Uint8Array([1, 2, 3])) }],
      effects: { changedObjects: [{ objectId: HERO, idOperation: "Created", outputVersion: 4 }] }
    }))
    expect(executed.created(HERO_TYPE)[0]?.version).toBe(Version.make(4n))
    expect(executed.effects.changedObjects[0]?.inputState).toBe("Unknown")
    expect([executed.sender, executed.checkpoint, executed.timestampMs]).toEqual([SuiAddress.make(PADDED("2")), 42n, 1_700_000_000_000])
    expect(executed.events[0]?.bcs).toEqual(new Uint8Array([1, 2, 3]))
    expect(executed.balanceChange(SuiAddress.make(SENDER), SUI)).toBe(-5n)
  })

  test("fromPartial reports every bad field in issues, and one sentence in issue", async () => {
    const error = await Effect.runPromise(Effect.flip(Executed.fromPartial({ digest: DIGEST, objectTypes: { [HERO]: 5, [ESCROW]: 7 }, effects: {} })))
    expect(error.kind).toBe("shape")
    expect(error.issues?.map((issue) => issue.path)).toEqual([["objectTypes", HERO], ["objectTypes", ESCROW]])
    expect(error.issue.split("\n")).toHaveLength(2)
    expect((await Effect.runPromiseExit(Executed.fromPartial({ effects: {} })))._tag).toBe("Failure")
  })
})
