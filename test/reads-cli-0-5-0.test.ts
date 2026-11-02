/**
 * 0.5.0 work package W5: history reads and the cheap wallet findings.
 *
 * - `Sui.streamTransactions({ affectedAddress })` over the gRPC ledger's
 *   `affectedAddress` predicate (finding 5), on the fake's ledger service.
 * - `Script.layerStderrLogger`, effect/cli's `CliError` in `Script.exitCode`,
 *   and `Script.report({ applied })` (findings 6, 16).
 * - `CoinType.Strict` and the coin-agnostic `CoinAmount` (findings 7, 20).
 * - The fake's simulate fallback, a shared memory `KeyValueStore`, and
 *   `TestServices` (finding 18).
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { Cause, DateTime, Effect, Exit, Layer, Result, Schema, Stream } from "effect"
import { CliError } from "effect/cli"
import { KeyValueStore } from "effect/persistence"
import { TransportError } from "../src/domain/errors.ts"
import { Balance, CoinAmount, CoinType, Digest, Signature } from "../src/domain/schemas.ts"
import { layerKeyValueStore } from "../src/journal.ts"
import { Journal } from "../src/services/Journal.ts"
import { Script } from "../src/services/Script.ts"
import { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, fakeDigest } from "../src/services/SuiCoreFake.ts"
import { layerTest, SuiTest, type TestServices } from "../src/testing.ts"
import { SuiAddress } from "../src/domain/schemas.ts"
import { JournalEntry } from "../src/domain/journal-entry.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const BOB = PADDED("b0b")
const CAROL = PADDED("ca401")
const SUI_TYPE = PADDED("2") + "::sui::SUI"

const run = <A, E>(effect: Effect.Effect<A, E, TestServices>, script: FakeScript = {}) =>
  Effect.runPromise(Effect.provide(effect, layerTest(script), { local: true }))

const runExit = <A, E>(effect: Effect.Effect<A, E, TestServices>, script: FakeScript = {}) =>
  Effect.runPromiseExit(Effect.provide(effect, layerTest(script), { local: true }))

const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.map(Stream.runCollect(stream), (chunk) => [...chunk])

const digestsOf = (items: ReadonlyArray<Result.Result<{ readonly digest: string }, { readonly digest: string }>>) =>
  items.map((item) => Result.isSuccess(item) ? item.success.digest : item.failure.digest)

/**
 * Four transactions in ledger order: ALICE pays BOB (BOB is affected only by
 * a balance change), BOB sends to CAROL, ALICE gives CAROL an object, and one
 * that touches nobody here but fails.
 */
const history: FakeScript["transactions"] = {
  [fakeDigest(1)]: FakeOutcome.succeed({
    sender: ALICE,
    balanceChanges: [
      { coinType: SUI_TYPE, address: ALICE, amount: "-100" },
      { coinType: SUI_TYPE, address: BOB, amount: "100" }
    ]
  }),
  [fakeDigest(2)]: FakeOutcome.succeed({
    sender: BOB,
    balanceChanges: [
      { coinType: SUI_TYPE, address: BOB, amount: "-5" },
      { coinType: SUI_TYPE, address: CAROL, amount: "5" }
    ]
  }),
  [fakeDigest(3)]: FakeOutcome.succeed({
    sender: ALICE,
    mutated: [{
      objectId: PADDED("0b1"),
      type: `${PADDED("abc")}::nft::Nft`,
      inputOwner: { $kind: "AddressOwner", AddressOwner: ALICE },
      owner: { $kind: "AddressOwner", AddressOwner: CAROL }
    }]
  }),
  [fakeDigest(4)]: FakeOutcome.failWith(
    { $kind: "Unknown", message: "boom", Unknown: null } as never,
    { sender: CAROL }
  )
}

describe("Sui.streamTransactions({ affectedAddress })", () => {
  test("lists incoming transfers a sender filter cannot find, in ledger order", async () => {
    const [bob, carol, bobSent] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return [
          yield* collect(sui.streamTransactions({ affectedAddress: BOB })),
          yield* collect(sui.streamTransactions({ affectedAddress: "0xca401" })),
          yield* collect(sui.streamTransactions({ sender: BOB }))
        ] as const
      }),
      { transactions: history, ledger: {} }
    )
    expect(digestsOf(bob)).toEqual([fakeDigest(1), fakeDigest(2)])
    // Received coins, received an object, and its own failed transaction (a
    // `Result` failure, as in every history).
    expect(digestsOf(carol)).toEqual([fakeDigest(2), fakeDigest(3), fakeDigest(4)])
    expect(Result.isFailure(carol[2]!)).toBe(true)
    expect(digestsOf(bobSent)).toEqual([fakeDigest(2)])
  })

  test("descending, paged, resumable from a committed cursor", async () => {
    const [descending, pages, resumed] = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        const descending = yield* collect(
          sui.streamTransactions({ affectedAddress: CAROL }, { order: "descending" })
        )
        const pages = yield* collect(sui.streamTransactionPages({ affectedAddress: CAROL }))
        const first = pages[0]!
        const resumed = yield* collect(
          sui.streamTransactions({ affectedAddress: CAROL }, { after: first.endCursor })
        )
        return [descending, pages, resumed] as const
      }),
      // One transaction examined per request: every page is short, the cursor
      // still makes progress.
      { transactions: history, ledger: {}, scanLimit: 1 }
    )
    expect(digestsOf(descending)).toEqual([fakeDigest(4), fakeDigest(3), fakeDigest(2)])
    expect(pages.flatMap((page) => digestsOf(page.items))).toEqual([fakeDigest(2), fakeDigest(3), fakeDigest(4)])
    expect(pages.every((page) => page.items.length <= 1)).toBe(true)
    expect(digestsOf(resumed)).toEqual(
      pages.slice(1).flatMap((page) => digestsOf(page.items))
    )
  })

  test("reads each listed digest with the read include set (execute's plus bcs)", async () => {
    const calls = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        yield* collect(sui.streamTransactions({ affectedAddress: BOB }))
        return [
          yield* SuiTest.calls("ledgerService.listTransactions"),
          yield* SuiTest.calls("getTransaction")
        ] as const
      }),
      { transactions: history, ledger: {} }
    )
    const [listings, reads] = calls
    expect(listings).toHaveLength(1)
    const request = listings[0]!.options as {
      readMask: { paths: ReadonlyArray<string> }
      filter: { terms: ReadonlyArray<{ literals: ReadonlyArray<{ predicate: { affectedAddress: { address: string } } }> }> }
      options: { limit: number; ordering: number }
    }
    expect(request.readMask.paths).toEqual(["digest"])
    expect(request.filter.terms[0]!.literals[0]!.predicate.affectedAddress.address).toBe(BOB)
    expect(request.options).toEqual({ limit: 51, ordering: 0 })
    expect(reads).toHaveLength(2)
    expect((reads[0]!.options as { include?: unknown }).include).toEqual({
      effects: true,
      events: true,
      balanceChanges: true,
      objectTypes: true,
      // 0.5.0: the transaction's BCS bytes, which is where `Executed.sender` is read from.
      bcs: true
    })
  })

  test("a transport without the gRPC ledger service refuses it, typed — never a sender-only answer", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* collect(sui.streamTransactions({ affectedAddress: BOB }))
      }),
      // No `ledger`: the fake looks like a JSON-RPC or GraphQL client.
      { transactions: history }
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = Cause.findErrorOption(exit.cause)
      expect(error._tag).toBe("Some")
      if (error._tag === "Some") {
        expect(error.value).toBeInstanceOf(TransportError)
        expect((error.value as TransportError).status).toBe("UNIMPLEMENTED")
        expect((error.value as TransportError).retryable).toBe(false)
      }
    }
  })

  test("a transaction the fake executed is affected for its sender", async () => {
    const signer = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(9))
    const sender = signer.toSuiAddress()
    const listed = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        yield* SuiTest.recordTransaction(fakeDigest(7), FakeOutcome.succeed({
          sender: CAROL,
          balanceChanges: [{ coinType: SUI_TYPE, address: sender, amount: "1" }]
        }))
        return yield* collect(sui.streamTransactions({ affectedAddress: sender }))
      }),
      { ledger: {} }
    )
    expect(digestsOf(listed)).toEqual([fakeDigest(7)])
  })
})

describe("SuiCoreFake: the simulate after a build", () => {
  const sender = PADDED("5e9d")
  const coins: FakeScript["coins"] = [{
    objectId: PADDED("c01"),
    version: "2",
    digest: "11111111111111111111111111111111",
    type: "0x2::coin::Coin<0x2::sui::SUI>",
    balance: "1000000000",
    owner: { $kind: "AddressOwner", AddressOwner: sender }
  }]
  const recipe = (tx: Transaction) => {
    tx.transferObjects([tx.splitCoins(tx.gas, [1n])[0]!], BOB)
  }

  test("answers like the scripted build simulation when `simulate` is not scripted", async () => {
    const simulation = await run(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.simulate(recipe, { sender: SuiAddress.normalize(sender) })
      }),
      { coins, buildSimulate: [FakeOutcome.succeed()] }
    )
    expect(simulation.digest).toBeDefined()
  })

  test("with neither script, dies naming the script to add", async () => {
    const exit = await runExit(
      Effect.gen(function*() {
        const sui = yield* Sui
        return yield* sui.simulate(recipe, { sender: SuiAddress.normalize(sender) })
      }),
      { coins }
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("SuiTest.scriptSimulate")
  })
})

describe("Script at a CLI edge", () => {
  const failed = <E>(error: E) => Exit.fail(error)

  test("effect/cli: --help exits 0, a bad command line 2, a UserError as its cause", () => {
    expect(Script.exitCode(failed(new CliError.ShowHelp({ commandPath: ["wallet"], errors: [] })))).toBe(0)
    expect(
      Script.exitCode(
        failed(new CliError.ShowHelp({ commandPath: ["wallet"], errors: [new CliError.MissingOption({ option: "to" })] }))
      )
    ).toBe(2)
    expect(Script.exitCode(failed(new CliError.MissingOption({ option: "to" })))).toBe(2)
    const transport = TransportError.fromUnknown("getObject", new Error("down"), false)
    expect(Script.exitCode(failed(new CliError.UserError({ cause: transport })))).toBe(4)
    // The same applied/unresolved rules as for any other would-be 2.
    expect(Script.exitCode(failed(new CliError.MissingOption({ option: "to" })), { applied: 1 })).toBe(5)
  })

  test("Script.report: `applied` turns a later failure into 5, and a CliError prints nothing", async () => {
    const lines: Array<string> = []
    const journal = Journal.makeMemoryUnsafe()
    const transport = TransportError.fromUnknown("getObject", new Error("down"), false)
    const code = await Script.report(failed(transport), {
      stderr: (line) => lines.push(line),
      applied: 2,
      journal
    })
    expect(code).toBe(5)
    expect(lines.length).toBeGreaterThan(0)
    lines.length = 0
    const help = await Script.report(failed(new CliError.MissingOption({ option: "to" })), {
      stderr: (line) => lines.push(line),
      journal
    })
    expect(help).toBe(2)
    expect(lines).toEqual([])
  })

  test("layerStderrLogger: library log lines go to the writer, never to stdout", async () => {
    const lines: Array<string> = []
    const stdout: Array<unknown> = []
    const original = console.log
    console.log = (...args: Array<unknown>) => {
      stdout.push(args)
    }
    try {
      await Effect.runPromise(
        Effect.logWarning("the transaction executed but did not become visible").pipe(
          Effect.provide(Script.layerStderrLogger({ stderr: (line) => lines.push(line) }))
        )
      )
    } finally {
      console.log = original
    }
    expect(stdout).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("level=WARN")
    expect(lines[0]).toContain("did not become visible")
  })
})

describe("coin types and amounts", () => {
  const strict = Schema.decodeUnknownEffect(CoinType.Strict)

  test("CoinType.Strict decodes a coin type, padded, with the CoinType brand", async () => {
    const decoded = await Effect.runPromise(strict("0x2::sui::SUI"))
    expect(decoded).toBe(CoinType.SUI)
    const usdc = `0x${"a".repeat(64)}::usdc::USDC`
    expect(await Effect.runPromise(strict(usdc))).toBe(CoinType.normalize(usdc))
  })

  test("CoinType.Strict refuses user input as a decode failure, never a throw", async () => {
    for (const input of ["WCOIN", "SUI", " 0x2::sui::SUI", "2::sui::SUI", "0x2::sui", "0x2::coin::Coin<0x2::sui::SUI>", ""]) {
      const result = await Effect.runPromise(Effect.result(strict(input)))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(Schema.isSchemaError(result.failure)).toBe(true)
    }
    const symbol = await Effect.runPromise(Effect.result(strict("WCOIN")))
    if (Result.isFailure(symbol)) expect(symbol.failure.message).toContain("a symbol is not a coin type")
    const object = await Effect.runPromise(Effect.result(strict("0x2::coin::Coin<0x2::sui::SUI>")))
    if (Result.isFailure(object)) expect(object.failure.message).toContain("not the coin object type")
    // `normalize` keeps its contract: it throws, for literals a caller controls.
    expect(() => CoinType.normalize("WCOIN")).toThrow()
  })

  test("Balance amounts are CoinAmounts: plain bigints in the coin's own unit", () => {
    const usdc = `0x${"a".repeat(64)}::usdc::USDC`
    const balance = Schema.decodeUnknownSync(Balance)({
      coinType: usdc,
      balance: "1500000",
      coinBalance: "1000000",
      addressBalance: "500000"
    })
    const amount: CoinAmount = balance.balance
    const plain: bigint = amount
    expect(plain).toBe(1_500_000n)
    expect(() => Schema.decodeUnknownSync(CoinAmount)("-1")).toThrow()
  })

  test("Sui.layer takes a custom network name with no cast", () => {
    const name: string = "my-devnet"
    const layer = Sui.layer({ network: name, baseUrl: "http://127.0.0.1:9000" })
    expect(Layer.isLayer(layer)).toBe(true)
  })
})

describe("two journal layers over one memory KeyValueStore", () => {
  test("build the store once and hand both layers the value", async () => {
    // The tag is itself the Effect that reads the service: there is no
    // `.asEffect()` on it (that is a runtime TypeError).
    const store = await Effect.runPromise(
      Effect.provide(KeyValueStore.KeyValueStore, KeyValueStore.layerMemory)
    )
    const shared = Layer.succeed(KeyValueStore.KeyValueStore, store)
    const journalA = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(shared))
    const journalB = layerKeyValueStore({ onUnresolved: "ignore" }).pipe(Layer.provide(shared))
    const digest = Digest.make(fakeDigest(42))
    const entry = JournalEntry.cases.Signed.make({
      _tag: "Signed",
      digest,
      signed: {
        digest,
        bytes: new Uint8Array([1, 2, 3]),
        signatures: [Signature.make("sig")],
        sender: SuiAddress.make(ALICE)
      },
      signedAt: DateTime.makeUnsafe(0)
    })
    await Effect.runPromise(
      Effect.flatMap(Journal, (journal) => journal.put(entry)).pipe(Effect.provide(journalA))
    )
    const [read, unresolved] = await Effect.runPromise(
      Effect.flatMap(Journal, (journal) => Effect.all([journal.get(digest), journal.listUnresolved])).pipe(
        Effect.provide(journalB)
      )
    )
    expect(read._tag).toBe("Some")
    expect(unresolved.map((e) => e.digest)).toEqual([digest])
  })
})
