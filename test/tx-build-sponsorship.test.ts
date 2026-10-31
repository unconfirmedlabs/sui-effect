/**
 * The build and sponsorship half of the lifecycle, after the 0.4.0 dogfood
 * round: resolver refusals as `BuildError`, the gas ceiling as `PolicyDenied`,
 * the address-balance check, `Tx.fromBytes` / `Tx.attach`, `requireZeroGas`,
 * and `sdkRefOf` over a `Coin`.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import type { Transaction } from "@mysten/sui/transactions"
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { sdkRefOf } from "../src/domain/executed.ts"
import { Coin, CoinType, Mist, ObjectId, SuiAddress, Version } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import type { Sui } from "../src/services/Sui.ts"
import { FakeOutcome, type FakeScript, type SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const SUI = `${PADDED("2")}::sui::SUI`

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(31)))
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(32)))
const stranger = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(33)))
const SENDER = signer.address

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const coin = {
  objectId: PADDED("c01"),
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PADDED("2")}::coin::Coin<${SUI}>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const funded = (addressBalance: string, who?: string) => ({
  ...(who === undefined ? {} : { owner: who }),
  coinType: SUI,
  balance: addressBalance,
  coinBalance: "0",
  addressBalance
})

const baseScript: FakeScript = {
  chainId: CHAIN_ID,
  objects: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner, content: new Uint8Array() }],
  coins: [coin],
  balances: [funded("1000000000", sponsor.address)]
}

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

const sponsoredClaim = Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(claim)

const run = <A, E>(
  effect: Effect.Effect<A, E, Sui | SuiCoreFake | TestClock.TestClock>,
  script: FakeScript = baseScript
) =>
  Effect.runPromise(
    Effect.provide(effect, Layer.mergeAll(layerTest(script), TestClock.layer(), Journal.layerMemory), {
      local: true
    })
  )

describe("resolver refusals are BuildErrors (move#4, wallet#8, ext#4, sponsor#6)", () => {
  test("INVALID_ARGUMENT from the resolver is a BuildError with the node's message", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("INVALID_ARGUMENT")] }
    )
    expect(error._tag).toBe("BuildError")
    if (error._tag !== "BuildError") return
    expect(error.message).toBe(
      "the node refused to resolve the transaction (INVALID_ARGUMENT): fake transport error: INVALID_ARGUMENT"
    )
    // The transport failure is kept, so nothing is lost by the reclassification.
    expect((error.cause as { readonly _tag?: string })._tag).toBe("TransportError")
  })

  test("FAILED_PRECONDITION from the resolver is a BuildError too", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("FAILED_PRECONDITION")] }
    )
    expect(error._tag).toBe("BuildError")
  })

  test("a remaining TransportError is named Tx.build, not use", async () => {
    const error = await run(
      Tx.build(claim, { sender: SENDER }).pipe(Effect.flip),
      { ...baseScript, buildSimulate: [FakeOutcome.transportError("PERMISSION_DENIED")] }
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag !== "TransportError") return
    expect(error.method).toBe("Tx.build")
    expect(error.status).toBe("PERMISSION_DENIED")
    expect(error.retryable).toBe(false)
  })
})

describe("the SDK resolver's own refusal", () => {
  test("an intent the sender cannot fund is a BuildError, not a TransportError", async () => {
    const error = await run(
      Tx.build(
        Tx.gaslessStablecoinTransfer({
          coinType: CoinType.make(`${PADDED("2")}::usdc::USDC`),
          amount: 10_000n,
          recipient: SuiAddress.make(PADDED("a11ce"))
        }),
        { sender: SENDER }
      ).pipe(Effect.flip)
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("the SDK could not resolve the transaction: Insufficient balance")
  })
})

describe("the address-balance check (indexer#7)", () => {
  test("a sponsor whose address balance cannot cover the budget is a BuildError before signing", async () => {
    const { error, balanceReads } = await run(
      Effect.gen(function*() {
        const error = yield* Tx.run(sponsoredClaim, { signer, sponsor }).pipe(Effect.flip)
        const balanceReads = yield* SuiTest.calls("getBalance")
        const executes = yield* SuiTest.calls("executeTransaction")
        expect(executes).toHaveLength(0)
        return { error, balanceReads }
      }),
      // Plenty of SUI, all of it in coins: the faucet's shape.
      { ...baseScript, balances: [{ ...funded("0", sponsor.address), balance: "5000000000", coinBalance: "5000000000" }] }
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain(sponsor.address)
    expect(error.message).toContain("address balance, which holds 0 MIST")
    expect(error.message).toContain("gas budget 50000000 MIST")
    expect(balanceReads).toHaveLength(1)
  })

  test("a funded sponsor builds, and a coin-paid build reads no balance at all", async () => {
    const reads = await run(
      Effect.gen(function*() {
        yield* Tx.build(sponsoredClaim, { sender: SENDER })
        const sponsoredReads = (yield* SuiTest.calls("getBalance")).length
        yield* Tx.build(claim, { sender: SENDER })
        return [sponsoredReads, (yield* SuiTest.calls("getBalance")).length]
      })
    )
    expect(reads).toEqual([1, 1])
  })
})

describe("gasOwner on Built and Signed (sponsor#5)", () => {
  test("a gas owner the recipe set is recorded on Built and carried onto Signed", async () => {
    const { built, signed } = await run(
      Effect.gen(function*() {
        // No `gasOwner` option: only the recipe names the sponsor.
        const built = yield* Tx.build(sponsoredClaim, { sender: SENDER })
        const signed = yield* Tx.sign(built, signer)
        return { built, signed }
      })
    )
    expect(built.gasOwner).toBe(sponsor.address)
    expect(signed.gasOwner).toBe(sponsor.address)
  })

  test("a transaction the sender pays for carries no gasOwner, even when it was passed", async () => {
    const built = await run(Tx.build(claim, { sender: SENDER, gasOwner: SENDER }))
    expect(built.gasOwner).toBeUndefined()
  })
})

describe("Tx.fromBytes (sponsor#5)", () => {
  test("reads back exactly what Tx.build recorded", async () => {
    const { again, built } = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(sponsoredClaim, { sender: SENDER })
        const again = yield* Tx.fromBytes(built.bytes)
        return { built, again }
      })
    )
    expect(again).toEqual(built)
    expect(again.expiration?.$kind).toBe("ValidDuring")
    expect(again.chain).toBe(CHAIN_ID)
    expect(again.gasOwner).toBe(sponsor.address)
  })

  test("bytes bound to another chain are refused", async () => {
    const bytes = await run(Effect.map(Tx.build(claim, { sender: SENDER }), (built) => built.bytes))
    const error = await run(
      Tx.fromBytes(bytes).pipe(Effect.flip),
      { ...baseScript, chainId: "GAKP2kaWRjeYfbZz7ZJpXXbe7PswQRPGHHGWGsHdpQZx" }
    )
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain(`bound to chain ${CHAIN_ID}`)
  })

  test("bytes that are not a transaction are refused", async () => {
    const error = await run(Tx.fromBytes(new Uint8Array([1, 2, 3])).pipe(Effect.flip))
    expect(error._tag).toBe("BuildError")
  })
})

describe("Tx.attach (sponsor#5)", () => {
  test("a stateless sponsor: fromBytes, attach the sender's signature, cosign, submit", async () => {
    const executed = await run(
      Effect.gen(function*() {
        // The sender's side, in another process: build and sign.
        const built = yield* Tx.build(sponsoredClaim, { sender: SENDER })
        const senderSignature = (yield* signer.signTransaction(built.bytes))
        // The sponsor's side: only the bytes and the signature arrive.
        const received = yield* Tx.fromBytes(built.bytes)
        const withSender = yield* Tx.attach(received, senderSignature)
        expect(withSender.signatures).toEqual([senderSignature])
        // Attaching it again is attaching it once.
        const again = yield* Tx.attach(withSender, senderSignature)
        expect(again.signatures).toHaveLength(1)
        const signed = yield* Tx.cosign(withSender, sponsor)
        expect(signed.expiration).toEqual(built.expiration!)
        expect(signed.chain).toBe(CHAIN_ID)
        return yield* Tx.submit(signed)
      }),
      { ...baseScript, execute: [FakeOutcome.succeed()] }
    )
    expect(executed.digest.length).toBeGreaterThan(0)
  })

  test("a valid signature from an address the bytes do not accept is refused", async () => {
    const error = await run(
      Effect.gen(function*() {
        const built = yield* Tx.build(claim, { sender: SENDER })
        const signature = yield* stranger.signTransaction(built.bytes)
        return yield* Tx.attach(built, signature).pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("SigningError")
    expect(String(error.cause)).toContain(stranger.address)
  })

  test("a signature over other bytes is refused", async () => {
    const error = await run(
      Effect.gen(function*() {
        const first = yield* Tx.build(claim, { sender: SENDER })
        const second = yield* Tx.build(claim, { sender: SENDER })
        expect(second.digest).not.toBe(first.digest)
        const signature = yield* signer.signTransaction(first.bytes)
        return yield* Tx.attach(second, signature).pipe(Effect.flip)
      })
    )
    expect(error._tag).toBe("SigningError")
  })

  test("an empty signature is a SigningError, not a defect", async () => {
    const error = await run(
      Effect.flatMap(Tx.build(claim, { sender: SENDER }), (built) => Tx.attach(built, "").pipe(Effect.flip))
    )
    expect(error._tag).toBe("SigningError")
  })
})

describe("Tx.run with a sponsor named only by the recipe", () => {
  test("a missing sponsor is a SigningError before anything is built", async () => {
    const { error, simulates } = await run(
      Effect.gen(function*() {
        const error = yield* Tx.run(sponsoredClaim, { signer }).pipe(Effect.flip)
        return { error, simulates: yield* SuiTest.calls("simulateTransaction") }
      })
    )
    expect(error._tag).toBe("SigningError")
    expect(simulates).toHaveLength(0)
  })
})

describe("gaslessStablecoinTransfer({ requireZeroGas }) (sponsor#13)", () => {
  const USDC = CoinType.make(
    "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
  )
  const transfer = (requireZeroGas?: boolean) =>
    Tx.gaslessStablecoinTransfer({
      coinType: USDC,
      amount: 10_000n,
      recipient: SuiAddress.make(PADDED("a11ce")),
      ...(requireZeroGas === undefined ? {} : { requireZeroGas })
    })
  const usdcCoin = {
    ...coin,
    objectId: PADDED("c0d"),
    type: `${PADDED("2")}::coin::Coin<${USDC}>`
  } as unknown as SuiClientTypes.Coin
  const script: FakeScript = {
    ...baseScript,
    coins: [coin, usdcCoin],
    balances: [{ coinType: USDC, balance: "1000000000", coinBalance: "1000000000", addressBalance: "0" }]
  }

  test("a resolver that does not set zero gas fails the build", async () => {
    const error = await run(Tx.build(transfer(true), { sender: SENDER }).pipe(Effect.flip), script)
    expect(error._tag).toBe("BuildError")
    expect(error.message).toContain("required to be gasless")
    expect(error.message).toContain("gas price 1000 and budget 50000000")
  })

  test("zero gas price and budget pass", async () => {
    const built = await run(
      Tx.build(transfer(true), { sender: SENDER }),
      { ...script, referenceGasPrice: 0n, gasBudget: 0n }
    )
    const data = TransactionDataBuilder.fromBytes(built.bytes)
    expect(String(data.gasData.price)).toBe("0")
    expect(String(data.gasData.budget)).toBe("0")
  })

  test("without the option, a non-zero gas build stands", async () => {
    const built = await run(Tx.build(transfer(), { sender: SENDER }), script)
    expect(built.bytes.length).toBeGreaterThan(0)
  })
})

describe("sdkRefOf over a Coin (wallet#14)", () => {
  test("a Coin from listCoins converts to the SDK's object reference", () => {
    const value: Coin = {
      objectId: ObjectId.normalize("0xc01"),
      version: Version.make(7n),
      digest: "11111111111111111111111111111111",
      owner: { $kind: "AddressOwner", AddressOwner: SuiAddress.make(SENDER) },
      type: `${PADDED("2")}::coin::Coin<${SUI}>` as Coin["type"],
      balance: Mist.make(5n)
    }
    expect(sdkRefOf(value)).toEqual({
      objectId: PADDED("c01"),
      version: "7",
      digest: "11111111111111111111111111111111"
    })
  })
})

describe("the gas ceiling (sponsor#16)", () => {
  test("Tx.run reports it as PolicyDenied before anything is signed", async () => {
    const error = await run(
      Tx.run(claim, { signer }).pipe(Effect.flip, SubmitConfig.with({ maxGasBudget: Mist.make(1000n) }))
    )
    expect(error._tag).toBe("PolicyDenied")
    if (error._tag !== "PolicyDenied") return
    expect(error.rule).toBe("maxGasBudget")
  })
})
