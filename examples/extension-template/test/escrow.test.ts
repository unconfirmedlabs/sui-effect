/**
 * The extension's tests: the real service, over the real `Sui`, over the
 * in-memory `SuiCore`. No network, no mocks of our own — everything the test
 * needs comes from `sui-effect/testing`.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import {
  Cause,
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream
} from "effect"
import { TestClock } from "effect/testing"
import type { Sui, SuiCore } from "sui-effect"
import { KNOWN_CHAIN_IDS, ObjectId, SuiAddress, SuiSchema } from "sui-effect"
import { FakeOutcome, layerExtensionTest, layerTest, SuiCoreFake, SuiTest } from "sui-effect/testing"
import { Journal, Signer } from "sui-effect/tx"
import { DEPLOYMENTS, Escrow } from "../src/Escrow.ts"
import { escrow as escrowRegistration } from "../src/extension.ts"
import { EscrowNotFound, EscrowSettlementUnknown, EscrowUnsupportedNetwork } from "../src/errors.ts"
import { Platform, platform as platformRegistration } from "../src/Platform.ts"
import { ESCROW_PACKAGE, receiptType, Settlement, SettlementContent } from "../src/schema.ts"

/** The type constants under the package this test's fixtures use. */
const RECEIPT_TYPE = receiptType(ESCROW_PACKAGE)
const SETTLEMENT = SettlementContent(ESCROW_PACKAGE)

const padded = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = ObjectId.make(padded("e5c0"))
const RECEIPT_ID = padded("7ece17")
const MISSING_ID = ObjectId.make(padded("111"))

const keypair = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7))
const signer = Signer.fromKeypair(keypair)
const SENDER = signer.address
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const EscrowBcs = bcs.struct("Escrow", {
  id: bcs.Address,
  owner: bcs.Address,
  amount: bcs.u64()
})

const escrowObject = (amount: string) => ({
  objectId: ESCROW_ID,
  type: `${ESCROW_PACKAGE}::escrow::Escrow`,
  version: 3n,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, owner: SENDER, amount }).toBytes()
})

/** Everything the fake serves: one escrow, one gas coin, one scripted execution. */
const script = {
  objects: [escrowObject("5")],
  coins: [
    {
      objectId: padded("c01"),
      version: "2",
      digest: "11111111111111111111111111111111",
      type: `0x2::coin::Coin<0x2::sui::SUI>`,
      balance: "1000000000",
      owner,
      previousTransaction: null
    } as unknown as SuiClientTypes.Coin
  ],
  execute: [
    FakeOutcome.succeed({
      created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
      mutated: [{ objectId: ESCROW_ID, type: `${ESCROW_PACKAGE}::escrow::Escrow`, version: 4n, owner }]
    })
  ]
}

/**
 * One line of wiring: the extension's own test layer over `layerTest`, which is
 * the real `Sui` over the in-memory `SuiCore`. `{ local: true }` gives each
 * test a fresh fake.
 */
const provide = <A, E>(
  effect: Effect.Effect<A, E, Escrow | Sui | SuiCore | SuiCoreFake | TestClock.TestClock>,
  state: { readonly settled?: boolean } = {}
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(
        layerExtensionTest(Escrow.layerTest(state), script),
        // The program's own clock, for retries and timeouts. The chain's clock
        // is `SuiTest.setClock`.
        TestClock.layer(),
        // The default journal is a process-wide memory journal, so a test that
        // submits provides its own to stay isolated.
        Journal.layerMemory
      ),
      { local: true }
    )
  )

describe("Escrow", () => {
  test("get decodes an escrow object through the BCS bridge", async () => {
    const escrow = await provide(Effect.flatMap(Escrow, (escrow) => escrow.get(ESCROW_ID)))
    expect(escrow.content.amount).toBe("5")
    expect(Number(escrow.version)).toBe(3)
  })

  test("get is EscrowNotFound when the object is not there", async () => {
    const error = await provide(
      Effect.flatMap(Escrow, (escrow) => Effect.flip(escrow.get(MISSING_ID)))
    )
    expect(error).toBeInstanceOf(EscrowNotFound)
    expect((error as EscrowNotFound).outcome).toBe("not_applied")
  })

  test("get is EscrowNotFound after the object is deleted", async () => {
    const error = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        yield* SuiTest.deleteObject(ESCROW_ID)
        return yield* Effect.flip(escrow.get(ESCROW_ID))
      })
    )
    expect(error).toBeInstanceOf(EscrowNotFound)
  })

  test("the recipe fragment composes into a consumer's transaction", async () => {
    const commands = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        const object = yield* escrow.get(ESCROW_ID)
        const tx = new Transaction()
        // A consumer composes fragments from several extensions and submits once.
        escrow.claim(object)(tx)
        escrow.claim(object)(tx)
        return tx.getData().commands
      })
    )
    expect(commands).toHaveLength(2)
    expect(commands[0]?.$kind).toBe("MoveCall")
  })

  test("claimFor submits once and returns the receipt", async () => {
    const { executes, receipt } = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        const receipt = yield* escrow.claimFor(ESCROW_ID, { signer })
        const executes = yield* SuiTest.calls("executeTransaction")
        return { receipt, executes: executes.length }
      })
    )
    expect(String(receipt.id)).toBe(RECEIPT_ID)
    expect(String(receipt.type)).toBe(RECEIPT_TYPE)
    expect(executes).toBe(1)
  })

  test("an unsettled claim is EscrowSettlementUnknown, which exits 3", async () => {
    const error = await provide(
      Effect.flatMap(Escrow, (escrow) =>
        Effect.flip(escrow.claimFor(ESCROW_ID, { signer }))),
      { settled: false }
    )
    expect(error).toBeInstanceOf(EscrowSettlementUnknown)
    expect((error as EscrowSettlementUnknown).outcome).toBe("unknown")
  })

  test("the nested namespace streams and counts owned escrows", async () => {
    const { ids, count } = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        const ids = yield* Stream.runCollect(
          Stream.map(escrow.owned.stream(SuiAddress.make(SENDER)), (object) => object.id)
        )
        const count = yield* escrow.owned.count(SuiAddress.make(SENDER))
        return { ids, count }
      })
    )
    expect(count).toBe(1)
    expect(ids).toEqual([ESCROW_ID])
  })

  test("the version the fake serves is the version the extension reads", async () => {
    const versions = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        const before = yield* escrow.get(ESCROW_ID)
        yield* SuiTest.bumpVersion(ESCROW_ID)
        const after = yield* escrow.get(ESCROW_ID)
        return [before.version, after.version]
      })
    )
    expect(versions.map(Number)).toEqual([3, 4])
  })
})

describe("Escrow under the two clocks", () => {
  test("the chain's epoch bounds the transaction the extension submits", async () => {
    const expiration = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        yield* SuiTest.setClock(1_000_000_000_000n)
        yield* escrow.claimFor(ESCROW_ID, { signer })
        const sent = yield* SuiTest.calls("executeTransaction")
        const options = sent[0]?.options as { readonly transaction: Uint8Array }
        return TransactionDataBuilder.fromBytes(options.transaction).expiration
      })
    )
    // Every transaction an extension submits through `Tx` is bounded to the
    // current epoch and the next, and carries the chain identifier, with no
    // wiring in the extension at all. The bound is epochs rather than a wall
    // clock because no Sui network accepts a timestamp expiration yet.
    expect(expiration?.$kind).toBe("ValidDuring")
    if (expiration?.$kind === "ValidDuring") {
      expect(String(expiration.ValidDuring.minEpoch)).toBe("100")
      expect(String(expiration.ValidDuring.maxEpoch)).toBe("101")
      expect(expiration.ValidDuring.maxTimestamp).toBeNull()
    }
  })

  test("a retryable transport failure re-sends the identical bytes", async () => {
    const { attempts, bytes } = await provide(
      Effect.gen(function*() {
        const escrow = yield* Escrow
        yield* SuiTest.scriptExecute([
          FakeOutcome.transportError("UNAVAILABLE"),
          FakeOutcome.succeed({
            created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }]
          })
        ])
        // The resubmit schedule sleeps, so the test drives the clock rather
        // than waiting.
        const fiber = yield* Effect.forkChild(escrow.claimFor(ESCROW_ID, { signer }))
        yield* TestClock.adjust("1 minute")
        yield* Fiber.join(fiber)
        const sent = yield* SuiTest.calls("executeTransaction")
        return {
          attempts: sent.length,
          bytes: new Set(
            sent.map((call) =>
              String((call.options as { readonly transaction: Uint8Array }).transaction)
            )
          ).size
        }
      })
    )
    expect(attempts).toBe(2)
    // The same bytes both times: `Tx.submit` never rebuilds.
    expect(bytes).toBe(1)
  })
})

describe("Settlement: a domain class over the BCS bridge", () => {
  const SettlementBcs = bcs.struct("Settlement", {
    escrow_id: bcs.Address,
    settled_at_ms: bcs.u64(),
    claimed_by: bcs.Address
  })

  test("snake_case Move fields decode into the camelCase domain class", async () => {
    const bytes = SettlementBcs.serialize({
      escrow_id: ESCROW_ID,
      settled_at_ms: "1700000000000",
      claimed_by: SENDER
    }).toBytes()
    const settlement = await Effect.runPromise(SuiSchema.decode(SETTLEMENT, bytes))
    expect(settlement).toBeInstanceOf(Settlement)
    expect(settlement.escrowId).toBe(ESCROW_ID)
    expect(settlement.claimedBy).toBe(SENDER)
    expect(DateTime.toEpochMillis(settlement.settledAt)).toBe(1_700_000_000_000)
  })

  test("the encode direction is the inverse mapper", async () => {
    const bytes = SettlementBcs.serialize({
      escrow_id: ESCROW_ID,
      settled_at_ms: "1700000000000",
      claimed_by: SENDER
    }).toBytes()
    const settlement = await Effect.runPromise(SuiSchema.decode(SETTLEMENT, bytes))
    const encoded = await Effect.runPromise(
      Schema.encodeUnknownEffect(SETTLEMENT)(settlement)
    )
    expect(Array.from(encoded)).toEqual(Array.from(bytes))
  })

  test("a failure inside the domain transform is still a DecodeError", async () => {
    const bytes = SettlementBcs.serialize({
      escrow_id: ESCROW_ID,
      // Beyond what a `Date` can be, so the domain mapping is what fails.
      settled_at_ms: "99999999999999999",
      claimed_by: SENDER
    }).toBytes()
    const error = await Effect.runPromise(
      Effect.flip(SuiSchema.decode(SETTLEMENT, bytes, { objectId: ESCROW_ID }))
    )
    expect(error._tag).toBe("DecodeError")
    expect(error.objectId).toBe(ESCROW_ID)
  })
})

describe("layerBundled: the deployment follows the client's network", () => {
  const apiKey = Redacted.make("test-key")

  test("picks the package id bundled for the network the client is on", async () => {
    const packageId = await Effect.runPromise(
      Effect.provide(
        Effect.map(Escrow, (escrow) => escrow.packageId),
        Layer.provide(Escrow.layerBundled({ apiKey }), layerTest({ network: "testnet", chainId: KNOWN_CHAIN_IDS["testnet"]! })),
        { local: true }
      )
    )
    expect(packageId).toBe(DEPLOYMENTS["testnet"]!.packageId)
  })

  test("a network this release does not bundle is a typed layer failure", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(
          Effect.map(Escrow, (escrow) => escrow.packageId),
          Layer.provide(Escrow.layerBundled({ apiKey }), layerTest({ network: "localnet" })),
          { local: true }
        )
      )
    )
    expect(exit._tag).toBe("Failure")
    const error = Exit.isFailure(exit)
      ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
      : undefined
    expect(error).toBeInstanceOf(EscrowUnsupportedNetwork)
    expect((error as EscrowUnsupportedNetwork).network).toBe("localnet")
  })
})

describe("Platform: one extension composed on another", () => {
  test("the dependency's surface is a namespace on the composition", async () => {
    const amount = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Platform, (platform) => platform.escrow.get(ESCROW_ID)),
        Layer.mergeAll(
          // The composition's own test layer over the harness: one fake for the
          // chain, and the dependency's own fake for its operator service.
          layerExtensionTest(Platform.layerTest({ settled: true }), script),
          Journal.layerMemory
        ),
        { local: true }
      ).pipe(Effect.map((escrow) => escrow.content.amount))
    )
    expect(amount).toBe("5")
  })

  test("an operation that spans the composed packages keeps the union honest", async () => {
    const claimed = await Effect.runPromise(
      Effect.provide(
        Effect.flatMap(Platform, (platform) =>
          platform.claimEverything([ESCROW_ID], { signer })),
        Layer.mergeAll(
          layerExtensionTest(Platform.layerTest({ settled: true }), script),
          Journal.layerMemory
        ),
        { local: true }
      )
    )
    expect(claimed).toHaveLength(1)
    expect(claimed[0]?.id).toBe(ObjectId.make(RECEIPT_ID))
  })
})

/**
 * Regression tests for the codex audit of 2026-09-11, findings 18 and 23.
 */
describe("configuring a package moves the codecs with it", () => {
  const OTHER_PACKAGE = padded("beef")

  const underOtherPackage = {
    ...script,
    objects: [
      {
        ...escrowObject("5"),
        // A correctly encoded escrow, published to the *configured* package.
        type: `${OTHER_PACKAGE}::escrow::Escrow`
      }
    ]
  }

  const withPackage = <A, E>(
    effect: Effect.Effect<A, E, Escrow | Sui | SuiCore | SuiCoreFake | TestClock.TestClock>,
    packageId: string
  ) =>
    Effect.runPromise(
      Effect.provide(
        effect,
        Layer.mergeAll(
          layerExtensionTest(
            Escrow.layer({
              packageId,
              url: "https://settlement.example",
              apiKey: Redacted.make("key")
            }),
            underOtherPackage
          ),
          TestClock.layer(),
          Journal.layerMemory
        ),
        { local: true }
      )
    )

  test("a valid object under the configured package decodes", async () => {
    // Before the fix the codec and the receipt type came from the module-level
    // constant, so configuring a package id made every read fail with
    // `DecodeError` and every claim report a missing receipt.
    const escrow = await withPackage(
      Effect.flatMap(Escrow, (service) => service.get(ESCROW_ID)),
      OTHER_PACKAGE
    )
    expect(escrow.content.amount).toBe("5")
    expect(String(escrow.type)).toBe(`${OTHER_PACKAGE}::escrow::Escrow`)
  })

  test("the service reports the type origin it was built with", async () => {
    const origin = await withPackage(
      Effect.map(Escrow, (service) => service.typeOrigin),
      OTHER_PACKAGE
    )
    expect(origin).toBe(OTHER_PACKAGE)
  })

  test("the default package still refuses an object of another package", async () => {
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(Effect.flatMap(Escrow, (service) => service.get(ESCROW_ID))),
        Layer.mergeAll(
          layerExtensionTest(Escrow.layerTest(), underOtherPackage),
          TestClock.layer(),
          Journal.layerMemory
        ),
        { local: true }
      )
    )
    expect(error._tag).toBe("DecodeError")
  })
})

describe("the test fee collector", () => {
  test("resolves to a normalized address instead of failing", async () => {
    // `SuiAddress.make("0x1")` validates the decoded representation and does
    // not normalize it, so the abbreviated form threw inside the fake API and
    // arrived as a `TransportError` from a member that never touched a network.
    const address = await provide(Effect.flatMap(Escrow, (service) => service.feeCollector))
    expect(String(address)).toBe(padded("1"))
  })
})

describe("the Promise face: registering on a client", () => {
  const apiKey = Redacted.make("test-key")
  const options = { packageId: ESCROW_PACKAGE, url: "https://settlement.example", apiKey }
  /** devnet has no built-in chain identifier, which is the whole point here. */
  const LOCAL_CHAIN = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

  /** The fake's own SDK client, which implements `$extend`. */
  const fakeClientOf = (network: SuiClientTypes.Network, chainId: string) =>
    Effect.runSync(
      Effect.provide(
        Effect.map(SuiCoreFake, (fake) => fake.client),
        // The fake `SuiCore` alone, not `layerTest`: `layerTest` builds `Sui`,
        // which reads the chain identifier, and the whole point here is a
        // registration that builds synchronously.
        SuiCoreFake.layer({ ...script, network, chainId }),
        { local: true }
      )
    )

  test("a warm registration on a network with no built-in chain id needs one", () => {
    // `warm` takes the chain identifier rather than asking the node for it, and
    // devnet's is regenerated, so there is nothing to take. Without
    // `options.chainId` this throws out of `register` — which is the failure a
    // copier hits the first time they point the template at a local network.
    const client = fakeClientOf("devnet", LOCAL_CHAIN)
    expect(() => client.$extend(escrowRegistration(options))).toThrow(/chain id/)
  })

  test("threading options.chainId makes the warm face work on devnet", async () => {
    const client = fakeClientOf("devnet", LOCAL_CHAIN)
    const extended = client.$extend(escrowRegistration({ ...options, chainId: LOCAL_CHAIN }))
    // A synchronous member is the real value immediately: that is what `warm`
    // buys, and reading it off a lazy registration would throw
    // `ExtensionNotReady`.
    expect(extended.escrow.packageId).toBe(ESCROW_PACKAGE)
    const found = await extended.escrow.get(ESCROW_ID)
    expect(found.content.amount).toBe("5")
    await extended.escrow.$dispose()
  })

  test("two registrations naming one chain id both work off one client", async () => {
    // The rule from `docs/extensions.md`: the base `Sui`, its transport and its
    // sender-lock map are shared per client **per chain id**. Registering the
    // escrow extension and the platform that composes it with the same id is
    // what keeps two `Tx.run`s for one address serialized.
    const client = fakeClientOf("devnet", LOCAL_CHAIN)
    const extended = client
      .$extend(escrowRegistration({ ...options, chainId: LOCAL_CHAIN }))
      .$extend(platformRegistration({ ...options, chainId: LOCAL_CHAIN }))
    expect(extended.escrow.packageId).toBe(ESCROW_PACKAGE)
    expect(extended.platform.escrow.packageId).toBe(ESCROW_PACKAGE)
    await extended.escrow.$dispose()
    await extended.platform.$dispose()
  })
})

describe("layerConfig validates through the typed deployment path", () => {
  /**
   * `Effect.withConfigProvider` does not exist in Effect v4 rc.112. A test
   * provides the `ConfigProvider` the way it provides anything else — here with
   * `ConfigProvider.layer`, which is `Effect.provideService(…,
   * ConfigProvider.ConfigProvider, …)` as a layer.
   */
  const withEnvironment = (values: Record<string, string>) =>
    Effect.runPromiseExit(
      Effect.provide(
        Effect.map(Escrow, (service) => service.packageId),
        Layer.mergeAll(
          Escrow.layerConfig.pipe(
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(values)))
          ),
          Layer.empty
        ).pipe(Layer.provide(layerTest(script))),
        { local: true }
      )
    )

  test("a well-formed package id builds the layer", async () => {
    const exit = await withEnvironment({
      ESCROW_PACKAGE_ID: padded("abc"),
      ESCROW_URL: "https://settlement.example",
      ESCROW_API_KEY: "secret"
    })
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value).toBe(padded("abc"))
  })

  test("a malformed package id is a ConfigError, not a Move abort three calls later", async () => {
    const exit = await withEnvironment({
      ESCROW_PACKAGE_ID: "not-an-object-id",
      ESCROW_URL: "https://settlement.example",
      ESCROW_API_KEY: "secret"
    })
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(exit)).toContain("PACKAGE_ID")
    expect(String(exit)).toContain("32-byte Sui object id")
  })
})
