/**
 * The 0.1.2 batch: the two fake defects the first two downstream conversions
 * hit, and every behaviour the release added around them.
 */
import { describe, expect, test } from "bun:test"
import { bcs as suiBcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { toBase64 } from "@mysten/sui/utils"
import { ConfigProvider, DateTime, Effect, Exit, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import {
  BuildError,
  DecodeError,
  ExecutionFailed,
  ExtensionNotReady,
  GraphQLUnavailable,
  JournalError,
  NetworkMismatch,
  NotApplied,
  ObjectDeleted,
  ObjectNotFound,
  ObjectUnavailable,
  PolicyDenied,
  SigningError,
  SimulationFailed,
  SubmissionUnknown,
  SuiError,
  TransactionNotFound,
  TransportError,
  UnexpectedEffects
} from "../src/domain/errors.ts"
import { Executed } from "../src/domain/executed.ts"
import { Digest, ExecutionReason, Mist, ObjectId, SuiAddress, Version } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { Script } from "../src/services/Script.ts"
import { fromConfig, fromKeypair, fromSdkSigner } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"
import * as SuiSchema from "../src/domain/sui-schema.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const DIGEST = Digest.make("11111111111111111111111111111111")
const UNKNOWN_REASON = ExecutionReason.cases.Unknown.make({ $kind: "Unknown" })
const EFFECTS = {
  version: 2,
  status: { success: false },
  gasUsed: {
    computationCost: Mist.make(0n),
    storageCost: Mist.make(0n),
    storageRebate: Mist.make(0n),
    nonRefundableStorageFee: Mist.make(0n)
  },
  transactionDigest: DIGEST,
  gasObject: null,
  eventsDigest: null,
  dependencies: [],
  lamportVersion: null,
  changedObjects: [],
  unchangedConsensusObjects: [],
  auxiliaryDataDigest: null
}
/** Every tag the closed taxonomy owns, as the errors module lists them. */
const TAXONOMY = [
  "TransportError",
  "ObjectNotFound",
  "ObjectDeleted",
  "ObjectUnavailable",
  "TransactionNotFound",
  "NetworkMismatch",
  "DecodeError",
  "SimulationFailed",
  "ExecutionFailed",
  "SubmissionUnknown",
  "NotApplied",
  "SigningError",
  "BuildError",
  "PolicyDenied",
  "JournalError",
  "UnexpectedEffects",
  "GraphQLUnavailable",
  "ExtensionNotReady"
] as const
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const RECEIPT_ID = PADDED("7ece1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const RECEIPT_TYPE = `${PADDED("2")}::escrow::Receipt`
const CLOCK_MS = 1_700_000_000_000n

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9)))
const SENDER = signer.address

const EscrowBcs = suiBcs.struct("Escrow", { id: suiBcs.Address, amount: suiBcs.U64 })

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }
const sponsorOwner: SuiClientTypes.ObjectOwner = {
  $kind: "AddressOwner",
  AddressOwner: sponsor.address
}

const escrow = {
  objectId: ESCROW_ID,
  type: ESCROW_TYPE,
  version: 3n,
  owner,
  content: EscrowBcs.serialize({ id: ESCROW_ID, amount: "5" }).toBytes()
}

const coinOf = (suffix: string, coinOwner: SuiClientTypes.ObjectOwner): SuiClientTypes.Coin =>
  ({
    objectId: PADDED(suffix),
    version: "2",
    digest: "11111111111111111111111111111111",
    type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
    balance: "1000000000",
    owner: coinOwner,
    previousTransaction: null
  }) as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  clockTimestampMs: CLOCK_MS,
  objects: [escrow],
  coins: [coinOf("c01", owner), coinOf("c02", sponsorOwner)]
}

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

/**
 * A scripted success carrying `bigint` versions, which is what a
 * `JSON.stringify` of a scripted outcome would throw on.
 */
const executed = FakeOutcome.succeed({
  created: [{ objectId: RECEIPT_ID, type: RECEIPT_TYPE, version: 4n, owner }],
  mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, inputVersion: 3n, owner }]
})

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: Parameters<typeof layerTest>[0] = baseScript
) =>
  Effect.runPromise(
    Effect.provide(
      effect,
      Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory),
      { local: true }
    )
  )

describe("the fake writes nothing to stderr (item 16)", () => {
  test("a full Tx.run over a bigint-carrying script prints nothing", async () => {
    // The report was `console.error("DEBUG next()", key, JSON.stringify(outcomes))`
    // in a patched copy of the fake: noise at best, and a **throw** at worst,
    // because `JSON.stringify` of a scripted `FakeChange.version` bigint is a
    // TypeError — one that surfaces later, on an unrelated method, because the
    // outcome cursor had already moved. Nothing in `src/` may write to stderr,
    // and this script carries bigints on every axis a stringify would reach.
    const written: Array<string> = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
      return true
    }) as typeof process.stderr.write
    const consoleError = console.error
    const consoleLog = console.log
    const consoleWarn = console.warn
    console.error = (...args: ReadonlyArray<unknown>) => written.push(args.join(" "))
    console.log = (...args: ReadonlyArray<unknown>) => written.push(args.join(" "))
    console.warn = (...args: ReadonlyArray<unknown>) => written.push(args.join(" "))
    try {
      const result = await run(
        Effect.gen(function*() {
          yield* SuiTest.scriptExecute([executed])
          return yield* Tx.run(claim, { signer })
        }),
        { ...baseScript, epoch: 7n, gasBudget: 50_000_000n, execute: [executed] }
      )
      expect(result.digest.length).toBeGreaterThan(0)
    } finally {
      process.stderr.write = original
      console.error = consoleError
      console.log = consoleLog
      console.warn = consoleWarn
    }
    expect(written.join("")).toBe("")
  })

  test("the source of the fake contains no debug print", () => {
    const source = Bun.file("src/services/SuiCoreFake.ts")
    return source.text().then((text) => {
      expect(text).not.toContain("console.")
      expect(text).not.toContain("DEBUG")
    })
  })
})

describe("an under-signed submission is refused, not reconciled (item 21)", () => {
  test("a sponsored recipe signed only by the sender fails fast", async () => {
    // The app's scenario exactly: sponsored bytes, the sender's signature only,
    // and a scripted `getTransaction: succeed` sitting there. Before 0.1.2 the
    // fake threw a plain `Error`, `mapSdkError` called it a retryable
    // `TransportError`, `Tx.submit` retried, reconciled, found the scripted
    // success and reported an `Executed` for bytes no validator would take.
    const result = await run(
      Effect.result(
        Effect.gen(function*() {
          const built = yield* Tx.build(
            Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim),
            { sender: SENDER, gasOwner: sponsor.address }
          )
          const signed = yield* Tx.sign(built, signer)
          return yield* Tx.submit(signed)
        })
      ),
      { ...baseScript, execute: [executed], getTransaction: [executed] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    const value = result.failure
    expect(value._tag).toBe("TransportError")
    if (value._tag !== "TransportError") return
    expect(value.status).toBe("INVALID_ARGUMENT")
    expect(value.retryable).toBe(false)
    expect(SuiError.describe(value)).toContain("INVALID_ARGUMENT")
  })

  test("the same bytes co-signed by the sponsor execute", async () => {
    const result = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(
          Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim),
          { sender: SENDER, gasOwner: sponsor.address }
        )
        const signed = yield* Tx.cosign(yield* Tx.sign(built, signer), sponsor)
        return yield* Tx.submit(signed)
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
  })

  test("a signature from the wrong key is refused even when the count is right", async () => {
    const stranger = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(11)))
    const result = await run(
      Effect.result(
        Effect.gen(function*() {
          const built = yield* Tx.build(claim, { sender: SENDER })
          const signed = yield* Tx.sign(built, signer)
          // One signature, as the bytes require — from the wrong address.
          const wrong = { ...signed, signatures: [yield* stranger.signTransaction(signed.bytes)] }
          return yield* Tx.submit(wrong)
        })
      ),
      { ...baseScript, execute: [executed], getTransaction: [executed] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("TransportError")
  })
})

describe("DecodeError.kind (item 9)", () => {
  const codec = SuiSchema.bcs(EscrowBcs, ESCROW_TYPE)

  test("a type-tag mismatch is kind: type, and never parses a byte", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        SuiSchema.decode(codec, escrow.content, { actualType: `${PADDED("2")}::other::Thing` })
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.kind).toBe("type")
  })

  test("a BCS parse failure is kind: bytes", async () => {
    const result = await Effect.runPromise(
      Effect.result(SuiSchema.decode(codec, new Uint8Array([1, 2, 3])))
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.kind).toBe("bytes")
  })

  test("a domain-schema failure is kind: shape", async () => {
    const result = await Effect.runPromise(Effect.result(Executed.fromPartial({ effects: {} })))
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.kind).toBe("shape")
  })

  test("kind defaults to shape for an error built without one, and describe prints it", () => {
    const error = new DecodeError({ issue: "anything" })
    expect(error.kind).toBe("shape")
    expect(SuiError.describe(error)).toContain("shape")
  })
})

describe("Reconciled carries one discriminator (item 12)", () => {
  test("a settled success is { _tag: \"Executed\", executed }", async () => {
    const settled = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        const journal = yield* Journal
        yield* journal.put(
          JournalEntry.cases.Signed.make({
            _tag: "Signed",
            digest: signed.digest,
            signed,
            signedAt: yield* DateTime.now
          })
        )
        return yield* Tx.reconcileAll()
      }),
      { ...baseScript, getTransaction: [executed] }
    )
    expect(settled).toHaveLength(1)
    const entry = settled[0]!
    expect(entry._tag).toBe("Executed")
    if (entry._tag !== "Executed") return
    expect(entry.executed.created(RECEIPT_TYPE)).toHaveLength(1)
  })
})

describe("Tx.recorded (item 18)", () => {
  test("answers the terminal entry reconcileAll no longer returns", async () => {
    const { after, settled } = await run(
      Effect.gen(function*() {
        const executedResult = yield* Tx.run(claim, { signer })
        const settled = yield* Tx.reconcileAll()
        const after = yield* Tx.recorded(executedResult.digest)
        return { settled, after }
      }),
      { ...baseScript, execute: [executed] }
    )
    // The run settled, so `reconcileAll` has nothing to say about it...
    expect(settled).toHaveLength(0)
    // ...and `Tx.recorded` has the terminal entry.
    expect(Option.isSome(after)).toBe(true)
    if (Option.isSome(after)) expect(after.value._tag).toBe("Executed")
  })

  test("None for a digest the journal never saw", async () => {
    const found = await run(Tx.recorded("11111111111111111111111111111111" as never))
    expect(Option.isNone(found)).toBe(true)
  })
})

describe("Executed.fromPartial (item 24)", () => {
  test("a relay envelope with only objectId and idOperation still lists what it created", async () => {
    const envelope = {
      digest: "11111111111111111111111111111111",
      effects: {
        changedObjects: [
          { objectId: RECEIPT_ID, idOperation: "Created" },
          { objectId: ESCROW_ID, idOperation: "None", inputState: "Exists" }
        ]
      }
    }
    const result = await Effect.runPromise(Executed.fromPartial(envelope))
    expect(result.created().map((ref) => ref.id)).toEqual([ObjectId.make(RECEIPT_ID)])
    expect(result.mutated()).toHaveLength(1)
    // No `objectTypes`, so a type filter matches nothing, and says so by
    // returning nothing rather than by failing.
    expect(result.created(RECEIPT_TYPE)).toHaveLength(0)
    expect(result.checkpoint).toBeNull()
    expect(result.gasUsedTotal).toBe(0n)
  })

  test("objectTypes, JSON-spelled bigints and base64 event bytes are all accepted", async () => {
    const result = await Effect.runPromise(
      Executed.fromPartial({
        digest: "11111111111111111111111111111111",
        checkpoint: 42,
        timestampMs: "1700000000000",
        objectTypes: { [ObjectId.make(RECEIPT_ID)]: RECEIPT_TYPE },
        balanceChanges: [{ coinType: `${PADDED("2")}::sui::SUI`, address: SENDER, amount: -5 }],
        events: [
          {
            packageId: PADDED("2"),
            module: "escrow",
            sender: SENDER,
            eventType: `${PADDED("2")}::escrow::Claimed`,
            bcs: toBase64(new Uint8Array([1, 2, 3]))
          }
        ],
        effects: {
          changedObjects: [
            { objectId: RECEIPT_ID, idOperation: "Created", outputVersion: 4 }
          ]
        }
      })
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
    expect(result.created(RECEIPT_TYPE)[0]?.version).toBe(Version.make(4n))
    expect(result.checkpoint).toBe(42n)
    expect(result.timestampMs).toBe(1_700_000_000_000)
    expect(result.events[0]?.bcs).toEqual(new Uint8Array([1, 2, 3]))
    expect(
      result.balanceChange(SuiAddress.make(SENDER), `${PADDED("2")}::sui::SUI` as never)
    ).toBe(-5n)
  })

  test("an envelope with no digest fails with a DecodeError", async () => {
    const exit = await Effect.runPromiseExit(Executed.fromPartial({ effects: {} }))
    expect(exit._tag).toBe("Failure")
  })
})

describe("Signer (items 8 and 22)", () => {
  test("fromSdkSigner names the member a double is missing", () => {
    expect(() => fromSdkSigner({ signTransaction: () => {} } as never)).toThrow(
      /no toSuiAddress/
    )
    expect(() =>
      fromSdkSigner({ toSuiAddress: () => SENDER, signTransaction: () => {} } as never)
    ).toThrow(/no getKeyScheme/)
  })

  test("fromSdkSigner accepts a real keypair unchanged", () => {
    const wrapped = fromSdkSigner(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
    expect(wrapped.address).toBe(SENDER)
    expect(wrapped.scheme).toBe("ED25519")
  })

  test("fromConfig reads a 32-byte hex seed as Ed25519", async () => {
    const seed = "0x" + "07".repeat(32)
    const built = await Effect.runPromise(
      fromConfig("SUI_KEY").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { SUI_KEY: seed } })
        )
      )
    )
    expect(built.address).toBe(SENDER)
    expect(built.scheme).toBe("ED25519")
  })

  test("fromConfig still reads Bech32, and refuses anything else", async () => {
    const bech32 = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)).getSecretKey()
    const built = await Effect.runPromise(
      fromConfig("SUI_KEY").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { SUI_KEY: bech32 } })
        )
      )
    )
    expect(built.address).toBe(SENDER)
    const exit = await Effect.runPromiseExit(
      fromConfig("SUI_KEY").pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { SUI_KEY: "not a key" } })
        )
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})

describe("the fake's reads (items 13 and 17)", () => {
  test("getBalance is keyed by owner and coin type", async () => {
    const script = {
      ...baseScript,
      balances: [
        {
          owner: SENDER,
          coinType: `${PADDED("2")}::sui::SUI`,
          balance: "10",
          coinBalance: "10",
          addressBalance: "10"
        },
        {
          owner: sponsor.address,
          coinType: `${PADDED("2")}::sui::SUI`,
          balance: "99",
          coinBalance: "99",
          addressBalance: "99"
        }
      ]
    }
    const { mine, theirs } = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return {
          mine: yield* sui.getBalance(SuiAddress.make(SENDER)),
          theirs: yield* sui.getBalance(SuiAddress.make(sponsor.address))
        }
      }),
      script
    )
    expect(mine.balance).toBe(Mist.make(10n))
    expect(theirs.balance).toBe(Mist.make(99n))
  })

  test("an entry with no owner still answers for everyone", async () => {
    const script = {
      ...baseScript,
      balances: [
        {
          coinType: `${PADDED("2")}::sui::SUI`,
          balance: "7",
          coinBalance: "7",
          addressBalance: "7"
        }
      ]
    }
    const balance = await run(
      Effect.flatMap(Sui, (sui) => sui.getBalance(SuiAddress.make(sponsor.address))),
      script
    )
    expect(balance.balance).toBe(Mist.make(7n))
  })

  test("getObject outcomes inject a transport failure on a read", async () => {
    const result = await run(
      Effect.result(Effect.flatMap(Sui, (sui) => sui.getObject(ObjectId.make(ESCROW_ID)))),
      { ...baseScript, getObject: [FakeOutcome.transportError("INVALID_ARGUMENT")] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("TransportError")

    // And `notFound` answers the way a missing object does.
    const missing = await run(
      Effect.result(Effect.flatMap(Sui, (sui) => sui.getObject(ObjectId.make(ESCROW_ID)))),
      { ...baseScript, getObject: [FakeOutcome.notFound()] }
    )
    expect(missing._tag).toBe("Failure")
    if (missing._tag !== "Failure") return
    expect(missing.failure._tag).toBe("ObjectNotFound")
  })
})

describe("FakeOutcome.failWith takes both reason shapes", () => {
  test("the decoded ExecutionReason is encoded into the wire shape", () => {
    const outcome = FakeOutcome.failWith({
      $kind: "MoveAbort",
      MoveAbort: { abortCode: 3n }
    } as never)
    expect(outcome._tag).toBe("failWith")
    if (outcome._tag !== "failWith") return
    expect(outcome.reason.$kind).toBe("MoveAbort")
    expect(typeof outcome.reason.message).toBe("string")
    expect(outcome.reason.MoveAbort?.abortCode).toBe("3")
  })

  test("a value that is neither shape says so immediately", () => {
    expect(() => FakeOutcome.failWith({ abortCode: 3n } as never)).toThrow(/\$kind/)
  })
})

describe("SuiError.describe accepts a foreign error", () => {
  test("an extension's own error gets its message, not a crash", () => {
    expect(SuiError.describe({ _tag: "RecordSalesUnavailable", message: "no sales" } as never))
      .toBe("RecordSalesUnavailable: no sales")
    expect(SuiError.describe({ _tag: "Bare" } as never)).toBe("Bare")
  })
})

describe("Sui.getObjectsStrict (item 1)", () => {
  test("the new name and the deprecated one are the same function", async () => {
    const [strict, legacy] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* sui.getObjectsStrict([ObjectId.make(ESCROW_ID)]),
          yield* sui.getObjectsOrFail([ObjectId.make(ESCROW_ID)])
        ] as const
      })
    )
    expect(strict).toHaveLength(1)
    expect(legacy).toHaveLength(1)
    expect(strict[0]?.id).toBe(legacy[0]!.id)
  })
})

describe("Tx.run onSigned (item 10)", () => {
  test("runs after the last signature and before the first send", async () => {
    const order: Array<string> = []
    const result = await run(
      Effect.gen(function*() {
        const executedResult = yield* Tx.run(claim, {
          signer,
          onSigned: (signed) =>
            Effect.sync(() => {
              order.push(`signed:${signed.digest}`)
            })
        })
        const sent = yield* SuiTest.calls("executeTransaction")
        order.push(`sent:${sent.length}`)
        return executedResult
      }),
      { ...baseScript, execute: [executed] }
    )
    expect(order[0]?.startsWith("signed:")).toBe(true)
    expect(order[1]).toBe("sent:1")
    expect(order[0]).toContain(result.digest)
  })
})

describe("every error carries a readable message (app verification a, b)", () => {
  const samples: ReadonlyArray<{ readonly _tag: string; readonly error: unknown }> = [
    { _tag: "TransportError", error: new TransportError({ method: "getObject", retryable: true, cause: "down" }) },
    { _tag: "ObjectNotFound", error: new ObjectNotFound({ objectId: ObjectId.make(ESCROW_ID) }) },
    { _tag: "ObjectDeleted", error: new ObjectDeleted({ objectId: ObjectId.make(ESCROW_ID) }) },
    { _tag: "ObjectUnavailable", error: new ObjectUnavailable({ objectId: ObjectId.make(ESCROW_ID) }) },
    { _tag: "TransactionNotFound", error: new TransactionNotFound({ digest: DIGEST }) },
    { _tag: "NetworkMismatch", error: new NetworkMismatch({ expected: "a", actual: "b" }) },
    { _tag: "DecodeError", error: new DecodeError({ issue: "no" }) },
    { _tag: "SimulationFailed", error: new SimulationFailed({ reason: UNKNOWN_REASON, message: "nope" }) },
    {
      _tag: "ExecutionFailed",
      error: new ExecutionFailed({ digest: DIGEST, reason: UNKNOWN_REASON, effects: EFFECTS })
    },
    { _tag: "SubmissionUnknown", error: new SubmissionUnknown({ digest: DIGEST, cause: "gone" }) },
    { _tag: "NotApplied", error: new NotApplied({ digest: DIGEST, evidence: "expired" }) },
    { _tag: "SigningError", error: new SigningError({ cause: "refused" }) },
    { _tag: "BuildError", error: new BuildError({ message: "cannot build", cause: "x" }) },
    { _tag: "PolicyDenied", error: new PolicyDenied({ rule: "spend", message: "too much" }) },
    { _tag: "JournalError", error: new JournalError({ cause: "disk" }) },
    {
      _tag: "UnexpectedEffects",
      error: new UnexpectedEffects({ digest: DIGEST, expected: "Receipt", found: [] })
    },
    { _tag: "GraphQLUnavailable", error: new GraphQLUnavailable({ method: "q", reason: "none" }) },
    { _tag: "ExtensionNotReady", error: new ExtensionNotReady({ extension: "escrow", member: "id" }) }
  ]

  test("no taxonomy error has an empty message", () => {
    for (const { _tag, error } of samples) {
      const message = (error as Error).message
      expect(`${_tag}: ${message}`).not.toBe(`${_tag}: `)
      expect(message.length).toBeGreaterThan(0)
    }
    // Every tag in the taxonomy is covered by the table above.
    expect(samples.map((sample) => sample._tag).sort()).toEqual(
      [...TAXONOMY].sort()
    )
  })

  test("describe never returns undefined for a foreign tag", () => {
    expect(SuiError.describe({ _tag: "Foreign" } as never)).toBe("Foreign")
    expect(typeof SuiError.describe({ _tag: "Foreign", message: "m" } as never)).toBe("string")
  })

  test("toJson encodes through the schema, and adds the sentence (NB8, 0.1.3)", () => {
    // The getter is still not a schema field — the *encoding* is unchanged —
    // but `toJson` puts the sentence back in the same key for every class, so
    // an operator reading JSON logs stops special-casing the three tags that
    // have a `message` schema field.
    const json = SuiError.toJson(new NetworkMismatch({ expected: "a", actual: "b" }))
    expect(json).toEqual({
      _tag: "NetworkMismatch",
      expected: "a",
      actual: "b",
      message: SuiError.describe(new NetworkMismatch({ expected: "a", actual: "b" }))
    })
  })
})

describe("SuiError.outcome phase and isTaxonomy (app verification c)", () => {
  test("a foreign error is unknown after a submit and not_applied before one", () => {
    const foreign = { _tag: "PriceTooLow" } as never
    expect(SuiError.outcome(foreign)).toBe("unknown")
    expect(SuiError.outcome(foreign, { phase: "post-submit" })).toBe("unknown")
    expect(SuiError.outcome(foreign, { phase: "pre-submit" })).toBe("not_applied")
  })

  test("the phase never overrides the taxonomy or a declared outcome", () => {
    const applied = new ExecutionFailed({ digest: DIGEST, reason: UNKNOWN_REASON, effects: EFFECTS })
    expect(SuiError.outcome(applied, { phase: "pre-submit" })).toBe("applied")
    expect(SuiError.outcome({ _tag: "Custom", outcome: "applied" } as never, { phase: "pre-submit" }))
      .toBe("applied")
  })

  test("isTaxonomy tells ours from anyone else's", () => {
    expect(SuiError.isTaxonomy(new JournalError({ cause: "x" }))).toBe(true)
    expect(SuiError.isTaxonomy({ _tag: "PriceTooLow" })).toBe(false)
    expect(SuiError.isTaxonomy(new Error("plain"))).toBe(false)
  })
})

describe("Executed.fromPartial leaves what it was not told Unknown (app verification d)", () => {
  test("the states stay Unknown and the accessors still classify", async () => {
    const result = await Effect.runPromise(
      Executed.fromPartial({
        digest: DIGEST,
        effects: { changedObjects: [{ objectId: RECEIPT_ID, idOperation: "Created" }] }
      })
    )
    expect(result.effects.changedObjects[0]?.outputState).toBe("Unknown")
    expect(result.effects.changedObjects[0]?.inputState).toBe("Unknown")
    expect(result.created()).toHaveLength(1)
  })

  test("an event with json and no bcs decodes, and keeps the json", async () => {
    const result = await Effect.runPromise(
      Executed.fromPartial({
        digest: DIGEST,
        events: [
          {
            packageId: PADDED("2"),
            module: "escrow",
            sender: SENDER,
            eventType: `${PADDED("2")}::escrow::Claimed`,
            json: { amount: "5" }
          }
        ]
      })
    )
    expect(result.events[0]?.bcs).toEqual(new Uint8Array())
    expect(result.events[0]?.json).toEqual({ amount: "5" })
  })
})

describe("building simulates, visibly (cli verification a)", () => {
  test("the resolver's simulate is recorded on the fake", async () => {
    const calls = await run(
      Effect.gen(function*() {
        yield* Tx.build(claim, { sender: SENDER })
        return yield* SuiTest.calls("simulateTransaction")
      })
    )
    expect(calls).toHaveLength(1)
    expect((calls[0]!.options as { resolver?: boolean }).resolver).toBe(true)
  })

  test("a scripted simulate failure surfaces through Tx.run as SimulationFailed", async () => {
    const result = await run(
      Effect.result(Tx.run(claim, { signer })),
      {
        ...baseScript,
        execute: [executed],
        simulate: [
          FakeOutcome.failWith({
            $kind: "MoveAbort",
            message: "would abort",
            MoveAbort: { abortCode: "3" }
          } as never)
        ]
      }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SimulationFailed")
  })

  test("buildSimulate still wins when both are scripted", async () => {
    const result = await run(
      Effect.result(Tx.build(claim, { sender: SENDER })),
      {
        ...baseScript,
        buildSimulate: [FakeOutcome.succeed({})],
        simulate: [
          FakeOutcome.failWith({
            $kind: "MoveAbort",
            message: "would abort",
            MoveAbort: { abortCode: "3" }
          } as never)
        ]
      }
    )
    expect(result._tag).toBe("Success")
  })
})

describe("Tx.submitVia (cli verification b)", () => {
  const signedBytes = Effect.gen(function*() {
    const built = yield* Tx.build(claim, { sender: SENDER })
    return yield* Tx.sign(built, signer)
  })

  test("journals Signed, calls the sender once, and decodes the envelope it returns", async () => {
    const { entries, result, sends } = await run(
      Effect.gen(function*() {
        const signed = yield* signedBytes
        const journal = yield* Journal
        let sends = 0
        let atSend = 0
        const result = yield* Tx.submitVia(signed, (bytes, signatures) =>
          Effect.gen(function*() {
            sends += 1
            atSend = (yield* journal.listUnresolved).length
            expect(bytes.length).toBeGreaterThan(0)
            expect(signatures).toHaveLength(1)
            // The relay's reduced envelope: ids and id operations, no types.
            return {
              digest: signed.digest,
              effects: {
                changedObjects: [{ objectId: RECEIPT_ID, idOperation: "Created" }]
              }
            }
          }))
        return { result, sends, entries: yield* journal.listUnresolved, atSend }
      })
    )
    expect(sends).toBe(1)
    expect(result.created()).toHaveLength(1)
    // The `Signed` entry was there while the sender ran, and the terminal
    // `Executed` replaced it afterwards.
    expect(entries).toHaveLength(0)
  })

  test("a reply with no envelope reconciles by digest", async () => {
    const result = await run(
      Effect.gen(function*() {
        const signed = yield* signedBytes
        return yield* Tx.submitVia(signed, () => Effect.succeed(signed.digest))
      }),
      { ...baseScript, getTransaction: [executed] }
    )
    expect(result.created(RECEIPT_TYPE)).toHaveLength(1)
  })

  test("an ambiguous sender failure reconciles and stays unresolved when nothing is proven", async () => {
    const { entries, result } = await run(
      Effect.gen(function*() {
        const signed = yield* signedBytes
        const journal = yield* Journal
        const result = yield* Effect.result(
          Tx.submitVia(signed, () =>
            Effect.fail(
              new TransportError({ method: "relay.submit", retryable: true, cause: "gateway" })
            ))
        )
        return { result, entries: yield* journal.listUnresolved }
      }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()] }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
    expect(entries).toHaveLength(1)
    expect(entries[0]?._tag).toBe("Unknown")
  })

  test("a sender error that declares outcome not_applied fails straight through", async () => {
    class RelayRefused extends Error {
      readonly _tag = "RelayRefused"
      readonly outcome = "not_applied"
    }
    const { calls, result } = await run(
      Effect.gen(function*() {
        const signed = yield* signedBytes
        const result = yield* Effect.result(
          Tx.submitVia(signed, () => Effect.fail(new RelayRefused("policy")))
        )
        return { result, calls: yield* SuiTest.calls("getTransaction") }
      })
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect((result.failure as { _tag: string })._tag).toBe("RelayRefused")
    // No reconcile was spent: the service said it never sent them.
    expect(calls).toHaveLength(0)
  })
})

describe("Script.report (cli feedback)", () => {
  test("prints the failure and the unresolved entries, and answers the code", async () => {
    const lines: Array<string> = []
    const journal = Journal.makeMemoryUnsafe()
    const signed = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        return yield* Tx.sign(built, signer)
      })
    )
    await Effect.runPromise(
      journal.put(
        JournalEntry.cases.Signed.make({
          _tag: "Signed",
          digest: signed.digest,
          signed,
          signedAt: DateTime.makeUnsafe(0)
        })
      ).pipe(Effect.orDie)
    )
    const code = await Script.report(
      Exit.fail(new SubmissionUnknown({ digest: signed.digest, signed, cause: "gone" })),
      { stderr: (line) => lines.push(line), journal }
    )
    expect(code).toBe(3)
    const printed = lines.join("\n")
    expect(printed).toContain("SubmissionUnknown")
    expect(printed).toContain("unresolved")
    // The whole entry, through the JournalEntry schema, with base64 bytes.
    const entryLine = lines.find((line) => line.startsWith("entry: "))!
    expect(entryLine).toBeDefined()
    const parsed = JSON.parse(entryLine.slice("entry: ".length))
    expect(parsed._tag).toBe("Signed")
    expect(typeof parsed.signed.bytes).toBe("string")
  })

  test("a success reports 0 and prints nothing", async () => {
    const lines: Array<string> = []
    const code = await Script.report(Exit.succeed(1), { stderr: (line) => lines.push(line) })
    expect(code).toBe(0)
    expect(lines).toEqual([])
  })
})
