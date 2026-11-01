/**
 * 0.5.0's prepare → verify → approve primitive and what `Built` learned
 * (DESIGN §4, §6, §17): `Tx.prepare`, `Tx.run`'s `approve`, `Built.gas` and
 * `Built.simulation`, the session bound (`Signer.maxEpoch` / `maxEpoch`),
 * `Simulation`'s accessors shared with `Executed`, `transferred()`,
 * `Executed.sender`, `Tx.foldCoins({ plan, approve })` with
 * `Tx.foldMovement`, and the fake serving `json`/`display`. All on
 * `layerTest`; `test/live.localnet.test.ts` holds the same claims to a chain.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Built } from "../src/domain/built.ts"
import { PolicyDenied, SigningError } from "../src/domain/errors.ts"
import { Executed, Simulation } from "../src/domain/executed.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Gate } from "../src/services/Gate.ts"
import { Journal } from "../src/services/Journal.ts"
import type { Signer } from "../src/services/Signer.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui as SuiNs } from "../src/services/Sui.ts"
import type { Sui } from "../src/services/Sui.ts"
import { DEFAULT_EPOCH, type FakeChange, FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SUI = `${PADDED("2")}::sui::SUI`
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const HERO_TYPE = `${PADDED("b0b")}::hero::Hero`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(41)))
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(42)))
const SENDER = signer.address
const SPONSOR = sponsor.address
const RECIPIENT = SuiAddress.make(PADDED("a11ce"))
const ownedBy = (address: string): SuiClientTypes.ObjectOwner => ({ $kind: "AddressOwner", AddressOwner: address })

const funded = (addressBalance: bigint, who: string = SENDER) => ({
  owner: who,
  coinType: SUI,
  balance: addressBalance.toString(),
  coinBalance: "0",
  addressBalance: addressBalance.toString()
})

const suiCoin = (n: number, balance: bigint, who: string = SENDER) =>
  fakeCoin({ objectId: PADDED(`c${n.toString(16).padStart(3, "0")}`), owner: who, balance })

/** One owned input: the bytes pin it, so the run keeps the sender lock. */
const claim = (tx: Transaction) => {
  tx.moveCall({ target: `${PADDED("2")}::escrow::claim`, arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)] })
}

/** Pure inputs only: with address-balance gas it pins nothing. */
const pinsNothing = (tx: Transaction) => {
  tx.moveCall({
    target: "0x2::balance::send_funds",
    typeArguments: [SUI],
    arguments: [tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] }), tx.pure.address(RECIPIENT)]
  })
}

/** Uses `tx.gas`: on a balance-holding payer with no coins, a coin reservation. */
const usesGas = (tx: Transaction) => {
  tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(5n)])], tx.pure.address(RECIPIENT))
}

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner: ownedBy(SENDER), content: new Uint8Array() }],
  coins: [suiCoin(1, 5_000_000_000n)],
  balances: [funded(1_000_000_000n), funded(1_000_000_000n, SPONSOR)],
  simulate: [FakeOutcome.succeed()],
  execute: [FakeOutcome.succeed()]
}

/** No address balance: the resolver pays with the coin. */
const coinsOnly: FakeScript = { ...baseScript, balances: [funded(0n), funded(0n, SPONSOR)] }
/** A folded account: no coins at all, one SUI in the balance. */
const foldedOnly: FakeScript = { ...baseScript, coins: [] }

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript = baseScript
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), {
      local: true
    })
  )

/** The simulates that were not the resolver's own: what the front half costs. */
const explicitSimulates = Effect.map(SuiTest.calls("simulateTransaction"), (calls) =>
  calls.filter((call) => (call.options as { readonly resolver?: boolean }).resolver !== true).length)

/** Lets other fibers run until `done` holds or a bounded number of turns passed. */
const settleUntil = <R>(done: Effect.Effect<boolean, never, R>, turns = 200): Effect.Effect<boolean, never, R> =>
  Effect.gen(function*() {
    for (let turn = 0; turn < turns; turn++) {
      if (yield* done) return true
      yield* Effect.yieldNow
    }
    return yield* done
  })

class UserRejected extends Schema.TaggedError<UserRejected>()("UserRejected", {}) {
  readonly outcome = "not_applied" as const
}

describe("Built.gas: what the bytes pay with, read out of them", () => {
  test("address-balance gas: an empty payment, the sender pays", async () => {
    const built = await run(Tx.build(pinsNothing, { sender: SENDER }))
    expect(built.gas.source).toBe("addressBalance")
    expect(built.gas.payment).toEqual([])
    expect(built.gas.owner).toBe(SENDER)
    expect(built.gas.budget > 0n).toBe(true)
    expect<unknown>(built.gas.price).toBe(1_000n)
  })

  test("coin gas: the coin's ref, at the version the resolver picked", async () => {
    const built = await run(Tx.build(pinsNothing, { sender: SENDER }), coinsOnly)
    expect(built.gas.source).toBe("coins")
    expect<unknown>(built.gas.payment.map((ref) => ref.objectId)).toEqual([PADDED("c001")])
    expect(typeof built.gas.payment[0]?.version).toBe("bigint")
  })

  test("a tx.gas user on a folded account: a coin reservation", async () => {
    const built = await run(Tx.build(usesGas, { sender: SENDER }), foldedOnly)
    expect(built.gas.source).toBe("coinReservation")
    expect(built.gas.payment).toHaveLength(1)
    expect<unknown>(built.gas.payment[0]?.version).toBe(0n)
  })

  test("a sponsored build: the sponsor is the gas owner and pays from its balance", async () => {
    const built = await run(Tx.build(Tx.sponsored({ sender: SENDER, gasOwner: SPONSOR })(pinsNothing), { sender: SENDER }))
    expect(built.gasOwner).toBe(SPONSOR)
    expect(built.gas.owner).toBe(SPONSOR)
    expect(built.gas.source).toBe("addressBalance")
  })

  test("Tx.fromBytes reads the same gas out of the bytes, and never a simulation", async () => {
    const { built, again } = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return { built, again: yield* Tx.fromBytes(built.bytes) }
    }), coinsOnly)
    expect(again.gas).toEqual(built.gas)
    expect(again.simulation).toBeUndefined()
  })

  test("neither field reaches Signed", async () => {
    const signed = await run(Effect.gen(function*() {
      return yield* Tx.sign(yield* Tx.build((tx) => {
        pinsNothing(tx)
        tx.setGasBudget(5_000_000n)
      }, { sender: SENDER }), signer)
    }))
    expect("gas" in signed).toBe(false)
    expect("simulation" in signed).toBe(false)
  })
})

describe("Built.simulation: only a simulation of exactly the built bytes", () => {
  /** A preset budget: the fake's core resolver does not simulate, `Tx.build` does. */
  const preset = (tx: Transaction) => {
    pinsNothing(tx)
    tx.setGasBudget(5_000_000n)
  }

  test("present when Tx.build ran the explicit simulate, absent when the resolver simulated", async () => {
    const { explicit, resolved } = await run(Effect.gen(function*() {
      return {
        explicit: yield* Tx.build(preset, { sender: SENDER }),
        resolved: yield* Tx.build(pinsNothing, { sender: SENDER })
      }
    }))
    expect(explicit.simulation).toBeInstanceOf(Simulation)
    expect(explicit.simulation?.digest).toBe(explicit.digest)
    expect(resolved.simulation).toBeUndefined()
  })

  test("Tx.run with an intent and approve reuses it: no second simulate", async () => {
    const simulates = await run(Effect.gen(function*() {
      yield* Tx.run(preset, {
        signer,
        intent: { summary: "Send nothing to Alice.", author: "user", claims: { outflows: [], recipients: [RECIPIENT], objects: [] } },
        approve: () => Effect.void
      })
      return yield* explicitSimulates
    }))
    // The build's own, and nothing after it.
    expect(simulates).toBe(1)
  })

  test("a Built that went through JSON is simulated again: a decoded simulation is not trusted", async () => {
    const simulates = await run(Effect.gen(function*() {
      const built = yield* Tx.build(preset, { sender: SENDER })
      const decoded = Schema.decodeUnknownSync(Built)(Schema.encodeSync(Built)(built))
      expect(decoded.simulation).toBeInstanceOf(Simulation)
      yield* Tx.prepare(decoded, { sender: SENDER })
      return yield* explicitSimulates
    }))
    expect(simulates).toBe(2)
  })
})

describe("Tx.prepare", () => {
  test("a recipe: built, simulated, nothing signed or sent", async () => {
    const { prepared, executes } = await run(Effect.gen(function*() {
      const prepared = yield* Tx.prepare(pinsNothing, { sender: SENDER })
      return { prepared, executes: (yield* SuiTest.calls("executeTransaction")).length }
    }))
    expect(prepared.simulation).toBeInstanceOf(Simulation)
    expect(prepared.simulation.digest).toBe(prepared.built.digest)
    expect(prepared.verified).toBeUndefined()
    expect(executes).toBe(0)
  })

  test("bytes from Tx.fromBytes are not rebuilt, and are what Tx.sign signs", async () => {
    const { built, prepared, signed, resolves } = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      const before = (yield* SuiTest.calls("simulateTransaction")).filter((call) =>
        (call.options as { readonly resolver?: boolean }).resolver === true).length
      const prepared = yield* Tx.prepare(yield* Tx.fromBytes(built.bytes), { sender: SENDER })
      const after = (yield* SuiTest.calls("simulateTransaction")).filter((call) =>
        (call.options as { readonly resolver?: boolean }).resolver === true).length
      const signed = yield* Tx.sign(prepared.built, signer)
      return { built, prepared, signed, resolves: after - before }
    }))
    expect(prepared.built.bytes).toEqual(built.bytes)
    expect(signed.digest).toBe(built.digest)
    expect(resolves).toBe(0)
  })

  test("someone else's bytes are refused: prepare.sender", async () => {
    const error = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return yield* Effect.flip(Tx.prepare(built, { sender: RECIPIENT }))
    }))
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag === "PolicyDenied") expect(error.rule).toBe("prepare.sender")
  })

  test("bytes paid for by someone else than claimed are refused: prepare.gasOwner", async () => {
    const error = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return yield* Effect.flip(Tx.prepare(built, { sender: SENDER, gasOwner: SPONSOR }))
    }))
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag === "PolicyDenied") expect(error.rule).toBe("prepare.gasOwner")
  })

  test("a sponsored prepare shows the sponsor as gas owner, and the sponsor co-signs later", async () => {
    const executed = await run(Effect.gen(function*() {
      const prepared = yield* Tx.prepare(Tx.sponsored({ sender: SENDER, gasOwner: SPONSOR })(pinsNothing), {
        sender: SENDER,
        gasOwner: SPONSOR
      })
      expect(prepared.built.gasOwner).toBe(SPONSOR)
      expect(prepared.built.gas.owner).toBe(SPONSOR)
      // The two parties sign separately: the sponsor's signature is attached.
      const withSender = yield* Tx.sign(prepared.built, signer)
      const sponsorSignature = yield* sponsor.signTransaction(prepared.built.bytes)
      return yield* Tx.submit(yield* Tx.attach(withSender, sponsorSignature))
    }))
    expect(executed.sender).toBe(SENDER)
  })

  test("an intent is verified; requireIntent does not bind a prepare", async () => {
    const { plain, declared } = await run(Effect.gen(function*() {
      const plain = yield* Tx.prepare(pinsNothing, { sender: SENDER })
      const declared = yield* Tx.prepare(pinsNothing, {
        sender: SENDER,
        intent: { summary: "Send nothing to Alice.", author: "user", claims: { outflows: [], recipients: [RECIPIENT], objects: [] } }
      })
      return { plain, declared }
    }).pipe(Gate.with({ requireIntent: true })))
    expect(plain.verified).toBeUndefined()
    expect(declared.verified?.verdict._tag).toBe("Unscreened")
    expect(declared.verified?.digest).toBe(declared.built.digest)
  })

  test("preflight runs on the prepared simulation", async () => {
    const error = await run(
      Tx.prepare(pinsNothing, { sender: SENDER }).pipe(
        Effect.flip,
        SubmitConfig.with({ preflight: () => Effect.fail(new PolicyDenied({ rule: "spend", message: "no" })) })
      )
    )
    expect(error._tag).toBe("PolicyDenied")
  })
})

describe("Tx.run({ approve })", () => {
  test("a refusal is the caller's error: nothing signed, nothing sent, nothing journalled", async () => {
    let seen: string | undefined
    let signatures = 0
    const counting: Signer = {
      ...signer,
      signTransaction: (bytes) => {
        signatures += 1
        return signer.signTransaction(bytes)
      }
    }
    const { error, executes, recorded } = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Tx.run(pinsNothing, {
        signer: counting,
        approve: (prepared) => {
          seen = prepared.built.digest
          return Effect.fail(new UserRejected())
        }
      }))
      const executes = (yield* SuiTest.calls("executeTransaction")).length
      const recorded = seen === undefined ? Option.none() : yield* Tx.recorded(seen as never)
      return { error, executes, recorded }
    }))
    expect(error).toBeInstanceOf(UserRejected)
    expect(signatures).toBe(0)
    expect(executes).toBe(0)
    expect(Option.isNone(recorded)).toBe(true)
  })

  test("approve sees the built bytes, their gas and the simulation before the first signature", async () => {
    const executed = await run(Tx.run(claim, {
      signer,
      approve: (prepared) =>
        Effect.sync(() => {
          expect(prepared.simulation.digest).toBe(prepared.built.digest)
          expect(prepared.built.gas.owner).toBe(SENDER)
        })
    }))
    expect(executed.sender).toBe(SENDER)
  })

  /** Whether another fiber can take the sender lock while `approve` is waiting. */
  const lockFreeDuringApprove = (recipe: (tx: Transaction) => void, script: FakeScript) =>
    run(Effect.gen(function*() {
      const sui = yield* SuiNs
      const inside = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      const taken = yield* Deferred.make<void>()
      const running = yield* Effect.forkChild(Tx.run(recipe, {
        signer,
        approve: () => Effect.andThen(Deferred.succeed(inside, undefined), Deferred.await(gate))
      }))
      yield* Deferred.await(inside)
      const other = yield* Effect.forkChild(sui.withSenderLock(SENDER)(Deferred.succeed(taken, undefined)))
      const free = yield* settleUntil(Deferred.isDone(taken))
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)
      yield* Fiber.join(other)
      return free
    }), script)

  test("pinned bytes: approve runs under the sender lock", async () => {
    expect(await lockFreeDuringApprove(claim, baseScript)).toBe(false)
  })

  test("bytes that pin nothing: approve runs with the lock released", async () => {
    expect(await lockFreeDuringApprove(pinsNothing, baseScript)).toBe(true)
  })

  test("a sponsored run approves: built.gasOwner is the sponsor", async () => {
    let gasOwner: string | undefined
    const executed = await run(Tx.run(Tx.sponsored({ sender: SENDER, gasOwner: SPONSOR })(pinsNothing), {
      signer,
      sponsor,
      approve: (prepared) => Effect.sync(() => (gasOwner = prepared.built.gas.owner))
    }))
    expect(gasOwner).toBe(SPONSOR)
    expect(executed.sender).toBe(SENDER)
  })
})

describe("the session bound: Signer.maxEpoch and Tx.build's maxEpoch", () => {
  const session = (maxEpoch: bigint): Signer => ({ ...signer, maxEpoch })
  const maxEpochOfBuilt = (built: Built) =>
    built.expiration?.$kind === "ValidDuring" ? built.expiration.ValidDuring.maxEpoch : undefined

  test("the default window is capped at the bound", async () => {
    const { capped, open } = await run(Effect.gen(function*() {
      return {
        capped: yield* Tx.build(pinsNothing, { sender: SENDER, maxEpoch: DEFAULT_EPOCH }),
        open: yield* Tx.build(pinsNothing, { sender: SENDER })
      }
    }))
    expect(maxEpochOfBuilt(capped)).toBe(DEFAULT_EPOCH)
    expect(maxEpochOfBuilt(open)).toBe(DEFAULT_EPOCH + 1n)
  })

  test("Tx.run caps the window at the signer's session", async () => {
    let window: bigint | null | undefined
    await run(Tx.run(pinsNothing, {
      signer: session(DEFAULT_EPOCH),
      approve: (prepared) => Effect.sync(() => (window = maxEpochOfBuilt(prepared.built)))
    }))
    expect(window).toBe(DEFAULT_EPOCH)
  })

  test("an ended session is SigningError { reason: expired } from Tx.run, before anything resolves", async () => {
    const { error, simulates } = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Tx.run(pinsNothing, { signer: session(DEFAULT_EPOCH - 1n) }))
      return { error, simulates: (yield* SuiTest.calls("simulateTransaction")).length }
    }))
    expect(error).toBeInstanceOf(SigningError)
    if (error instanceof SigningError) expect(error.reason).toBe("expired")
    expect(simulates).toBe(0)
  })

  test("a sponsor's session bounds the window too", async () => {
    let window: bigint | null | undefined
    await run(Tx.run(Tx.sponsored({ sender: SENDER, gasOwner: SPONSOR })(pinsNothing), {
      signer,
      sponsor: { ...sponsor, maxEpoch: DEFAULT_EPOCH },
      approve: (prepared) => Effect.sync(() => (window = maxEpochOfBuilt(prepared.built)))
    }))
    expect(window).toBe(DEFAULT_EPOCH)
  })

  test("Tx.build and Tx.prepare refuse an ended bound as BuildError carrying the SigningError", async () => {
    const { built, prepared } = await run(Effect.gen(function*() {
      return {
        built: yield* Effect.flip(Tx.build(pinsNothing, { sender: SENDER, maxEpoch: DEFAULT_EPOCH - 1n })),
        prepared: yield* Effect.flip(Tx.prepare(pinsNothing, { sender: SENDER, maxEpoch: DEFAULT_EPOCH - 1n }))
      }
    }))
    for (const error of [built, prepared]) {
      expect(error._tag).toBe("BuildError")
      if (error._tag === "BuildError") {
        expect(error.cause).toBeInstanceOf(SigningError)
        expect((error.cause as SigningError).reason).toBe("expired")
      }
    }
  })

  test("a bound with a recipe-set expiration is still checked, with one epoch read", async () => {
    const error = await run(Effect.flip(Tx.build((tx) => {
      pinsNothing(tx)
      tx.setExpiration({ Epoch: 5 })
    }, { sender: SENDER, maxEpoch: DEFAULT_EPOCH - 1n })))
    expect(error._tag).toBe("BuildError")
  })
})

describe("Simulation and Executed share one accessor implementation", () => {
  const HERO = PADDED("4e70")
  const SWORD = PADDED("5a0d")
  const SHIELD = PADDED("5e1d")
  const GONE = PADDED("90e")
  const CHILD = PADDED("c41d")
  const accumulator: FakeChange = { objectId: PADDED("acc"), type: `${PADDED("2")}::accumulator::U128`, outputState: "AccumulatorWriteV1" }
  const effects = {
    created: [{ objectId: HERO, type: HERO_TYPE, version: 9n, owner: ownedBy(SENDER) }],
    mutated: [
      // Transferred to the recipient.
      { objectId: SWORD, type: `${PADDED("b0b")}::hero::Sword`, version: 9n, inputOwner: ownedBy(SENDER), owner: ownedBy(RECIPIENT) },
      // Frozen.
      { objectId: SHIELD, type: `${PADDED("b0b")}::hero::Shield`, version: 9n, inputOwner: ownedBy(SENDER), owner: { $kind: "Immutable", Immutable: true } as SuiClientTypes.ObjectOwner },
      // Moved under a dynamic object field.
      { objectId: CHILD, type: `${PADDED("b0b")}::hero::Gem`, version: 9n, inputOwner: ownedBy(SENDER), owner: { $kind: "ObjectOwner", ObjectOwner: HERO } as SuiClientTypes.ObjectOwner },
      // Mutated in place.
      { objectId: ESCROW_ID, type: ESCROW_TYPE, version: 9n, owner: ownedBy(SENDER) },
      accumulator
    ],
    deleted: [{ objectId: GONE, type: `${PADDED("b0b")}::hero::Potion`, version: 8n, owner: ownedBy(SENDER) }],
    balanceChanges: [{ coinType: SUI, address: SENDER, amount: "-1000" }, { coinType: SUI, address: SENDER, amount: "-5" }]
  }
  const script: FakeScript = { ...baseScript, simulate: [FakeOutcome.succeed(effects)], execute: [FakeOutcome.succeed(effects)] }

  const view = (changes: Simulation | Executed) => ({
    created: changes.created().map((ref) => ref.id),
    createdHero: changes.created(HERO_TYPE).map((ref) => ref.id),
    mutated: changes.mutated().map((ref) => ref.id).sort(),
    deleted: changes.deleted().map((ref) => ref.id),
    wrapped: changes.wrapped().map((ref) => ref.id),
    transferred: changes.transferred().map((ref) => [ref.id, ref.inputOwner.$kind, ref.owner.$kind]).sort(),
    packages: changes.packagesPublished().length,
    balance: changes.balanceChange(SENDER, "0x2::sui::SUI"),
    gas: changes.gasUsedTotal
  })

  test("the same answers from a simulation and from the execution it predicted", async () => {
    const { simulation, executed } = await run(Effect.gen(function*() {
      const prepared = yield* Tx.prepare(claim, { sender: SENDER })
      const executed = yield* Tx.submit(yield* Tx.sign(prepared.built, signer))
      return { simulation: prepared.simulation, executed }
    }), script)
    expect(view(simulation)).toEqual(view(executed))
    const seen = view(simulation)
    expect<unknown>(seen.created).toEqual([HERO])
    expect<unknown>(seen.createdHero).toEqual([HERO])
    expect<unknown>(seen.deleted).toEqual([GONE])
    expect(seen.balance).toBe(-1005n)
    // The accumulator write is nobody's object and appears nowhere.
    expect(seen.mutated).not.toContain(PADDED("acc"))
    expect<unknown>(seen.mutated).toContain(ESCROW_ID)
    expect<unknown>(seen.transferred).toEqual([
      [SWORD, "AddressOwner", "AddressOwner"],
      [SHIELD, "AddressOwner", "Immutable"],
      [CHILD, "AddressOwner", "ObjectOwner"]
    ].sort())
    expect(await Effect.runPromise(simulation.expectCreated(HERO_TYPE))).toMatchObject({ id: HERO })
  })

  test("transferred(type) filters by type, and names the owners on both sides", async () => {
    const simulation = await run(Effect.map(Tx.prepare(claim, { sender: SENDER }), (p) => p.simulation), script)
    const swords = simulation.transferred(`${PADDED("b0b")}::hero::Sword`)
    expect(swords).toHaveLength(1)
    expect(swords[0]?.inputOwner).toEqual({ $kind: "AddressOwner", AddressOwner: SENDER })
    expect(swords[0]?.owner).toEqual({ $kind: "AddressOwner", AddressOwner: RECIPIENT })
  })

  test("an owner that stayed put, or a consensus object whose start version moved, is not transferred", () => {
    const change = (inputOwner: unknown, outputOwner: unknown) => ({
      objectId: PADDED("1"),
      inputState: "Exists",
      inputVersion: "1",
      inputDigest: "d",
      inputOwner,
      outputState: "ObjectWrite",
      outputVersion: "2",
      outputDigest: "e",
      outputOwner,
      idOperation: "None"
    })
    const executedWith = (changes: ReadonlyArray<unknown>) =>
      Effect.runSync(Executed.fromPartial({ digest: "11111111111111111111111111111111", effects: { changedObjects: changes } }))
    const consensus = (startVersion: string) => ({
      $kind: "ConsensusAddressOwner",
      ConsensusAddressOwner: { startVersion, owner: SENDER }
    })
    expect(executedWith([change(ownedBy(SENDER), ownedBy(SENDER))]).transferred()).toEqual([])
    expect(executedWith([change(consensus("1"), consensus("2"))]).transferred()).toEqual([])
    expect(executedWith([change(null, ownedBy(SENDER))]).transferred()).toEqual([])
    expect(executedWith([change(ownedBy(SENDER), consensus("2"))]).transferred()).toHaveLength(1)
  })

  test("a Simulation can be assembled by hand with new, and the pure checks take its fields", async () => {
    const simulation = await run(Effect.map(Tx.prepare(claim, { sender: SENDER }), (p) => p.simulation), script)
    const copy = new Simulation({ ...simulation })
    expect<unknown>(copy.created().map((ref) => ref.id)).toEqual([HERO])
  })
})

describe("Executed.sender", () => {
  test("filled from the bytes by Tx.run, Tx.submit and Tx.reconcile", async () => {
    const { ran, reconciled } = await run(Effect.gen(function*() {
      const ran = yield* Tx.run(pinsNothing, { signer })
      const signed = yield* Tx.sign(yield* Tx.build(claim, { sender: SENDER }), signer)
      yield* SuiTest.recordTransaction(signed.digest, FakeOutcome.succeed())
      return { ran, reconciled: yield* Tx.reconcile(signed) }
    }))
    expect(ran.sender).toBe(SENDER)
    expect(reconciled.sender).toBe(SENDER)
  })

  test("fromPartial keeps a sender the envelope names", () => {
    const executed = Effect.runSync(Executed.fromPartial({
      digest: "11111111111111111111111111111111",
      sender: "0x2",
      effects: {}
    }))
    expect(executed.sender).toBe(SuiAddress.make(PADDED("2")))
  })
})

describe("Tx.foldCoins({ plan, approve }) and Tx.foldMovement", () => {
  const coins = [suiCoin(1, 600_000_000_000n), suiCoin(2, 400_000_000_000n)]
  const deposit: FakeChange[] = coins.map((coin) => ({ objectId: coin.objectId, type: `0x2::coin::Coin<${SUI}>`, version: 2n, owner: ownedBy(SENDER) }))
  const foldEffects = {
    deleted: deposit,
    mutated: [{ objectId: PADDED("acc"), type: `${PADDED("2")}::accumulator::U128`, outputState: "AccumulatorWriteV1" as const }],
    // What a node reports for a fold: the net, which the rebate makes positive.
    balanceChanges: [{ coinType: SUI, address: SENDER, amount: "3939506" }]
  }
  const script: FakeScript = {
    ...baseScript,
    coins,
    balances: [{ owner: SENDER, coinType: SUI, balance: "1000000000000", coinBalance: "1000000000000", addressBalance: "0" }],
    simulate: [FakeOutcome.succeed(foldEffects)],
    execute: [FakeOutcome.succeed(foldEffects)]
  }

  test("the previewed plan runs as given, approve sees every batch, and the movement is the coins", async () => {
    const { result, movements, balanceListings } = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER })
      const before = (yield* SuiTest.calls("listBalances")).length
      const movements: Array<ReturnType<typeof Tx.foldMovement>> = []
      const result = yield* Tx.foldCoins({
        signer,
        plan,
        approve: (prepared, batch) => Effect.sync(() => movements.push(Tx.foldMovement(batch, prepared.simulation)))
      })
      const after = (yield* SuiTest.calls("listBalances")).length
      return { result, movements, balanceListings: after - before }
    }), script)
    // Not re-planned.
    expect(balanceListings).toBe(0)
    expect(result.executed).toHaveLength(1)
    expect(movements).toHaveLength(1)
    const moved = movements[0]!
    expect<unknown>(moved.consumed.map((coin) => coin.objectId)).toEqual(coins.map((coin) => coin.objectId))
    expect(moved.fromCoins).toBe(1_000_000_000_000n)
    expect(moved.netChange).toBe(3_939_506n)
    expect(moved.toAddressBalance).toBe(1_000_003_939_506n)
    expect(moved.exact).toBe(true)
    expect(Tx.foldMovement(result.plan.batches[0]!, result.executed[0]!)).toEqual(moved)
  })

  test("approve refusing a batch stops the fold with the caller's error", async () => {
    const error = await run(Effect.flip(Tx.foldCoins({ signer, approve: () => Effect.fail(new UserRejected()) })), script)
    expect(error).toBeInstanceOf(UserRejected)
  })

  test("a plan for another owner is a BuildError before anything runs", async () => {
    const error = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER })
      return yield* Effect.flip(Tx.foldCoins({ signer: sponsor, plan }))
    }), script)
    expect(error._tag).toBe("BuildError")
  })

  test("a coin the effects do not consume makes the movement inexact", async () => {
    const simulation = await run(Effect.gen(function*() {
      const plan = yield* Tx.planFold({ owner: SENDER })
      return { plan, prepared: yield* Tx.prepare(Tx.fold(plan.batches[0]!), { sender: SENDER }) }
    }), { ...script, simulate: [FakeOutcome.succeed({ ...foldEffects, deleted: deposit.slice(0, 1) })] })
    const moved = Tx.foldMovement(simulation.plan.batches[0]!, simulation.prepared.simulation)
    expect(moved.missing).toHaveLength(1)
    expect(moved.fromCoins).toBe(600_000_000_000n)
    expect(moved.exact).toBe(false)
  })

  test("under Gate.requireIntent a fold declares its own claim-free intent and runs", async () => {
    const { result, verdicts } = await run(Gate.with({ requireIntent: true })(Effect.gen(function*() {
      const verdicts: Array<string | undefined> = []
      const result = yield* Tx.foldCoins({
        signer,
        approve: (prepared) => Effect.sync(() => verdicts.push(prepared.verified?.verdict._tag))
      })
      return { result, verdicts }
    })), script)
    expect(result.executed).toHaveLength(1)
    expect(verdicts).toEqual(["Unscreened"])
  })

  test("the fold's own intent refuses a batch whose simulation pays someone else", async () => {
    const leaking = {
      ...foldEffects,
      balanceChanges: [
        { coinType: SUI, address: SENDER, amount: "-5000000" },
        { coinType: SUI, address: RECIPIENT, amount: "5000000" }
      ]
    }
    const error = await run(
      Gate.with({ requireIntent: true })(Effect.flip(Tx.foldCoins({ signer }))),
      { ...script, simulate: [FakeOutcome.succeed(leaking)], execute: [FakeOutcome.succeed(leaking)] }
    )
    expect(error._tag).toBe("PolicyDenied")
    expect(error._tag === "PolicyDenied" ? error.rule : "").toMatch(/^intent\.(outflow|recipient)$/)
  })

  test("without a gate a fold checks no intent and runs no extra simulate", async () => {
    const simulates = await run(Effect.gen(function*() {
      yield* Tx.foldCoins({ signer })
      return (yield* SuiTest.calls("simulateTransaction")).filter((call) => !JSON.stringify(call).includes("resolver")).length
    }), script)
    expect(simulates).toBe(0)
  })
})

describe("the fake serves json and display when asked", () => {
  const object = {
    objectId: PADDED("d15"),
    type: HERO_TYPE,
    version: 1n,
    content: new Uint8Array(),
    json: { name: "Hero" },
    display: { output: { name: "Hero #1" }, errors: null }
  }
  test("served when included, null when the object has none, absent when not asked for", async () => {
    const { asked, plain, none } = await run(Effect.gen(function*() {
      const core = (yield* SuiNs).core
      const asked = yield* core.getObject({ objectId: object.objectId, include: { json: true, display: true } })
      const plain = yield* core.getObject({ objectId: object.objectId })
      const none = yield* core.getObject({ objectId: ESCROW_ID, include: { json: true, display: true } })
      return { asked, plain, none }
    }), { ...baseScript, objects: [...(baseScript.objects ?? []), object] })
    expect(asked.object.json).toEqual({ name: "Hero" })
    expect(asked.object.display).toEqual({ output: { name: "Hero #1" }, errors: null })
    expect(plain.object.json).toBeUndefined()
    expect(none.object.json).toBeNull()
    expect(none.object.display).toBeNull()
  })
})
