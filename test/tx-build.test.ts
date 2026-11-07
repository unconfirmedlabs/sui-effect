/**
 * Everything before a signature leaves the process: `Tx.build` (expiration,
 * gas policy and its checks, always simulating, the gas ceiling), the bytes
 * readers (`Built.gas`, `Tx.fromBytes`), `Tx.sign` / `cosign` / `attach`,
 * `verifySponsored` and the recipe shapes. Builds run the SDK's own resolver
 * over scripted reads; a test about a failure stubs the method that fails.
 */
import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Transaction, TransactionDataBuilder } from "@mysten/sui/transactions"
import { Duration, Effect } from "effect"
import { SigningError } from "../src/domain/errors.ts"
import { CoinType, Mist } from "../src/domain/schemas.ts"
import type { Built } from "../src/domain/built.ts"
import { verifySponsored } from "../src/services/Sponsored.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Simulation } from "../src/domain/executed.ts"
import { Tx } from "../src/services/Tx.ts"
import { fakeCoin, FakeOutcome, SuiTest } from "../src/testing.ts"
import { adjusted, bytes, CHAIN, EPOCH, fail, run, signer, sponsor, stranger, SUI } from "./support.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const SENDER = signer.address
const RECIPIENT = stranger.address
/** A recipe with nothing to resolve but gas: no inputs, so it pins nothing. */
const pinsNothing = (tx: Transaction) => {
  tx.moveCall({ target: "0x2::balance::zero", typeArguments: [SUI] })
}
const usesGas = (tx: Transaction) => {
  const [coin] = tx.splitCoins(tx.gas, [1_000n])
  tx.transferObjects([coin!], RECIPIENT)
}
const sponsoredRecipe = Tx.sponsored({ sender: SENDER, gasOwner: sponsor.address })(pinsNothing)
const dataOf = (built: { readonly bytes: Uint8Array }) => TransactionDataBuilder.fromBytes(built.bytes)
const unfunded = { addressBalances: [] }
const coinsOnly = { ...unfunded, objects: [fakeCoin({ objectId: "0xc001", owner: SENDER, balance: 5_000_000_000n, version: 2n })] }
const aborted = FakeOutcome.failWith({ $kind: "MoveAbort", message: "would abort", MoveAbort: { abortCode: "3" } } as unknown as SuiClientTypes.ExecutionError)
const window = (built: Built) => built.expiration?.$kind === "ValidDuring" ? built.expiration.ValidDuring : undefined

describe("the expiration", () => {
  test("defaults to ValidDuring over this epoch and the next, on this chain, with no clock bound", async () => {
    const built = await run(Tx.build(pinsNothing, { sender: SENDER }), { epoch: 42n })
    expect(window(built)).toMatchObject({ minEpoch: 42n, maxEpoch: 43n, maxTimestamp: null, chain: CHAIN })
    expect(built.chain).toBe(CHAIN)
  })

  test("validFor adds a wall-clock bound measured from the chain's clock", async () => {
    const built = await run(Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ validFor: Duration.minutes(2) })), { clockTimestampMs: 1_000n })
    expect(window(built)?.maxTimestamp).toBe(121_000n)
  })

  test("expiration epoch sets the Epoch variant; none reads no system state; a recipe's own is kept", async () => {
    const [epoch, none, own, methods] = await run(Effect.gen(function*() {
      const epoch = yield* Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ expiration: "epoch" }))
      yield* SuiTest.calls()
      const before = (yield* SuiTest.calls("getCurrentSystemState")).length
      const none = yield* Tx.build((tx) => {
        // Price and budget preset, so the SDK's resolver needs no system state either.
        pinsNothing(tx)
        tx.setGasPrice(1000)
        tx.setGasBudget(5_000_000n)
      }, { sender: SENDER }).pipe(SubmitConfig.with({ expiration: "none" }))
      const after = (yield* SuiTest.calls("getCurrentSystemState")).length
      const own = yield* Tx.build((tx) => {
        pinsNothing(tx)
        tx.setExpiration({ Epoch: 42 })
      }, { sender: SENDER })
      return [epoch, none, own, after - before] as const
    }), { ...coinsOnly, epoch: 77n })
    expect(epoch.expiration).toEqual({ $kind: "Epoch", Epoch: 77n } as never)
    expect(none.expiration?.$kind).toBe("None")
    expect(methods).toBe(0)
    expect(own.expiration).toEqual({ $kind: "Epoch", Epoch: 42n } as never)
  })

  test("a supplied nonce allocator lands in the expiration; one outside u32 fails the build", async () => {
    const built = await run(Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ nonce: Effect.succeed(4242) })))
    expect(window(built)?.nonce).toBe(4242)
    const error = await fail(Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ nonce: Effect.succeed(-1) })))
    expect([error._tag, error.message]).toEqual(["BuildError", expect.stringContaining("not a u32")])
  })
})

describe("the maxEpoch bound", () => {
  test("caps the default window, and a bound below the current epoch is refused before anything resolves", async () => {
    const capped = await run(Tx.build(pinsNothing, { sender: SENDER, maxEpoch: EPOCH }))
    expect(window(capped)?.maxEpoch).toBe(EPOCH)
    const [error, simulates] = await run(Effect.gen(function*() {
      const error = yield* Effect.flip(Tx.build(pinsNothing, { sender: SENDER, maxEpoch: EPOCH - 1n }))
      return [error, (yield* SuiTest.calls("simulateTransaction")).length] as const
    }))
    expect(error._tag).toBe("BuildError")
    expect(error._tag === "BuildError" && error.cause instanceof SigningError && error.cause.reason).toBe("expired")
    expect(simulates).toBe(0)
  })

  test("a recipe's own expiration is still checked against the bound", async () => {
    const error = await fail(Tx.build((tx) => {
      pinsNothing(tx)
      tx.setExpiration({ Epoch: 5 })
    }, { sender: SENDER, maxEpoch: EPOCH - 1n }))
    expect(error._tag).toBe("BuildError")
  })
})

describe("building always simulates", () => {
  test("a transaction the resolver must budget is simulated once, by the resolver", async () => {
    const [built, simulates] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER })
      return [built, yield* SuiTest.calls("simulateTransaction")] as const
    }))
    expect(simulates).toHaveLength(1)
    expect(built.simulation).toBeUndefined()
  })

  test("a preset budget the core resolver will not simulate gets Tx.build's own simulate of the built bytes", async () => {
    const preset = (tx: Transaction) => {
      pinsNothing(tx)
      tx.setGasBudget(5_000_000n)
    }
    const [built, simulates] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(preset, { sender: SENDER })
      return [built, yield* SuiTest.calls("simulateTransaction")] as const
    }))
    expect(simulates).toHaveLength(1)
    expect((simulates[0]!.options as { transaction: unknown }).transaction).toBeInstanceOf(Uint8Array)
    expect(built.simulation).toBeInstanceOf(Simulation)
    expect(built.simulation?.digest).toBe(built.digest)
    const error = await fail(Tx.build(preset, { sender: SENDER }), { simulate: [aborted] })
    expect(error._tag).toBe("SimulationFailed")
  })

  test("a simulation that aborts is SimulationFailed, with the reason", async () => {
    const error = await fail(Tx.build(pinsNothing, { sender: SENDER }), { simulate: [aborted] })
    expect(error._tag === "SimulationFailed" && error.reason.$kind).toBe("MoveAbort")
  })

  test("a recipe that throws is a BuildError naming what it threw", async () => {
    const error = await fail(Tx.build(() => {
      throw new TypeError("coin is undefined")
    }, { sender: SENDER }))
    expect([error._tag, error.message]).toEqual(["BuildError", expect.any(String)])
    expect(String(error._tag === "BuildError" && error.cause)).toContain("coin is undefined")
  })
})

describe("the resolver's failures", () => {
  test("a refusal (INVALID_ARGUMENT, FAILED_PRECONDITION) is a BuildError keeping the TransportError; anything else is TransportError named Tx.build", async () => {
    for (const status of ["INVALID_ARGUMENT", "FAILED_PRECONDITION"]) {
      const error = await fail(Tx.build(pinsNothing, { sender: SENDER }), { simulate: [FakeOutcome.transportError(status)] })
      expect([error._tag, error._tag === "BuildError" && (error.cause as { _tag?: string })._tag]).toEqual(["BuildError", "TransportError"])
    }
    const other = await fail(Tx.build(pinsNothing, { sender: SENDER }), { simulate: [FakeOutcome.transportError("PERMISSION_DENIED")] })
    expect(other._tag === "TransportError" && [other.method, other.status, other.retryable]).toEqual(["Tx.build", "PERMISSION_DENIED", false])
  })

  test("an input the node does not know is a BuildError naming it", async () => {
    const missing = `0x${"de".repeat(32)}`
    const error = await fail(Tx.build((tx) => {
      tx.transferObjects([tx.object(missing)], RECIPIENT)
    }, { sender: SENDER }))
    expect([error._tag, error.message]).toEqual(["BuildError", expect.stringContaining(missing)])
  })

  test("a retryable failure inside the resolver is retried on the read policy, and the build succeeds", async () => {
    const built = await run(adjusted(Tx.build(pinsNothing, { sender: SENDER })), { simulate: [FakeOutcome.transportError("UNAVAILABLE"), FakeOutcome.succeed()] })
    expect(built.bytes.length).toBeGreaterThan(0)
  })

})

describe("the gas policy and its checks", () => {
  test("Built.gas reads the payment out of the bytes: address balance, coins, or a coin reservation", async () => {
    const balance = await run(Tx.build(pinsNothing, { sender: SENDER }))
    expect([balance.gas.source, balance.gas.payment, balance.gas.owner, balance.gas.price]).toEqual(["addressBalance", [], SENDER, 1_000n] as never)
    const coins = await run(Tx.build(pinsNothing, { sender: SENDER }), coinsOnly)
    expect([coins.gas.source, coins.gas.payment.map((ref) => ref.objectId)]).toEqual(["coins", [PADDED("c001")]] as never)
    const reservation = await run(Tx.build(usesGas, { sender: SENDER }))
    expect([reservation.gas.source, reservation.gas.payment[0]?.version]).toEqual(["coinReservation", 0n] as never)
  })

  test("requireAddressBalance pins the payment before the build and refuses an uncovered payer or coins", async () => {
    const [pinned, coinReads] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ gasPayment: "requireAddressBalance" }))
      return [built, (yield* SuiTest.calls("listCoins")).length] as const
    }))
    expect([dataOf(pinned).gasData.payment, coinReads]).toEqual([[], 0])
    const uncovered = await fail(Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ gasPayment: "requireAddressBalance" })), coinsOnly)
    expect([uncovered._tag, uncovered.message]).toEqual(["BuildError", expect.stringContaining("Tx.foldCoins")])
    const coinsChosen = await fail(Tx.build(usesGas, { sender: SENDER }).pipe(SubmitConfig.with({ gasPayment: "requireAddressBalance" })), coinsOnly)
    expect([coinsChosen._tag, coinsChosen.message]).toEqual(["BuildError", expect.stringContaining("coin objects")])
  })

  test("an explicit empty payment: the payer's balance must cover the budget plus its SUI withdrawals", async () => {
    const withdrawing = (tx: Transaction) => {
      const [coin] = tx.moveCall({ target: "0x2::coin::redeem_funds", typeArguments: [SUI], arguments: [tx.withdrawal({ amount: 9_999_000_000n })] })
      tx.transferObjects([coin!], RECIPIENT)
      tx.setGasPayment([])
    }
    const error = await fail(Tx.build(withdrawing, { sender: SENDER }))
    expect([error._tag, error.message]).toEqual(["BuildError", expect.stringContaining("the transaction withdraws from it")])
    const sponsorShort = await fail(Tx.build(sponsoredRecipe, { sender: SENDER }), { addressBalances: [] })
    expect(sponsorShort._tag).toBe("BuildError")
  })

  test("an explicit empty payment needs ValidDuring with nothing address-owned, and must not use tx.gas", async () => {
    const epochOnly = await fail(Tx.build((tx) => {
      pinsNothing(tx)
      tx.setGasPayment([])
    }, { sender: SENDER }).pipe(SubmitConfig.with({ expiration: "epoch" })))
    expect([epochOnly._tag, epochOnly.message]).toEqual(["BuildError", expect.stringContaining("ValidDuring")])
    const gasUser = await fail(Tx.build((tx) => {
      usesGas(tx)
      tx.setGasPayment([])
    }, { sender: SENDER }))
    expect([gasUser._tag, gasUser.message]).toEqual(["BuildError", expect.stringContaining("uses tx.gas but pays for gas from an address balance")])
  })

  test("the gas ceiling refuses a budget over SubmitConfig.maxGasBudget with PolicyDenied", async () => {
    const error = await fail(Tx.build(pinsNothing, { sender: SENDER }).pipe(SubmitConfig.with({ maxGasBudget: Mist.make(1n) })))
    expect(error._tag === "PolicyDenied" && error.rule).toBe("maxGasBudget")
  })

  test("requireZeroGas fails a build whose resolved price or budget is not zero", async () => {
    const USDC = CoinType.make(`${PADDED("dba3")}::usdc::USDC`)
    const transfer = (requireZeroGas: boolean) => Tx.gaslessStablecoinTransfer({ coinType: USDC, amount: 10_000n, recipient: RECIPIENT, requireZeroGas })
    const usdc = { addressBalances: [{ owner: SENDER, coinType: USDC, amount: 1_000_000n }, { owner: SENDER, amount: 10_000_000_000n }] }
    const error = await fail(Tx.build(transfer(true), { sender: SENDER }), usdc)
    expect([error._tag, error.message]).toEqual(["BuildError", expect.stringContaining("required to be gasless")])
    expect((await run(Tx.build(transfer(false), { sender: SENDER }), usdc)).bytes.length).toBeGreaterThan(0)
    const zero = { ...usdc, referenceGasPrice: 0n, simulate: [FakeOutcome.succeed({ gasUsed: { computationCost: "0", storageCost: "0", storageRebate: "0", nonRefundableStorageFee: "0" } })] }
    const free = await run(Tx.build(transfer(true), { sender: SENDER }), zero)
    expect([String(dataOf(free).gasData.price), String(dataOf(free).gasData.budget)]).toEqual(["0", "0"])
  })
})

describe("bytes from elsewhere", () => {
  test("Tx.fromBytes reads back what Tx.build recorded, with no simulation", async () => {
    const [built, again] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(sponsoredRecipe, { sender: SENDER })
      return [built, yield* Tx.fromBytes(built.bytes)] as const
    }))
    expect({ ...again, simulation: undefined }).toEqual({ ...built, simulation: undefined })
    expect([again.gasOwner, again.chain, again.simulation]).toEqual([sponsor.address, CHAIN, undefined] as never)
  })

  test("Tx.fromBytes refuses bytes bound to another chain, and bytes that are not a transaction", async () => {
    const other = await fail(Effect.flatMap(Effect.promise(() => bytes({ chain: "GAKP2kaWRjeYfbZz7ZJpXXbe7PswQRPGHHGWGsHdpQZx" })), Tx.fromBytes))
    expect([other._tag, other.message]).toEqual(["BuildError", expect.stringContaining("bound to chain GAKP2")])
    expect((await fail(Tx.fromBytes(new Uint8Array([1, 2, 3]))))._tag).toBe("BuildError")
  })

  test("verifySponsored reads sender, gas owner and kind from the bytes", async () => {
    const sponsored = { bytes: await bytes({ gasOwner: sponsor.address }) } as Built
    const selfPaid = { bytes: await bytes() } as Built
    const kind = await Transaction.from(sponsored.bytes).build({ onlyTransactionKind: true })
    const rule = (built: Built, expect_: Parameters<typeof verifySponsored>[1]) =>
      Effect.runPromise(Effect.match(verifySponsored(built, expect_), { onFailure: (e) => e.rule, onSuccess: () => "ok" }))
    expect(await rule(sponsored, { sender: SENDER, gasOwner: sponsor.address, transactionKind: kind })).toBe("ok")
    expect(await rule(sponsored, { sender: RECIPIENT })).toBe("sponsored.sender")
    expect(await rule(selfPaid, { sender: SENDER })).toBe("sponsored.gasOwner")
    expect(await rule(sponsored, { sender: SENDER, gasOwner: RECIPIENT })).toBe("sponsored.gasOwner")
    const otherKind = await Transaction.from(await bytes({ gasOwner: sponsor.address, inputs: [] })).build({ onlyTransactionKind: true })
    expect(await rule(sponsored, { sender: SENDER, transactionKind: otherKind })).toBe("sponsored.kind")
  })
})

describe("signing", () => {
  test("sign and cosign: one signature each over unchanged bytes; a party the bytes do not name is refused", async () => {
    const [signed, cosigned, byStranger, cosignedByStranger] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(sponsoredRecipe, { sender: SENDER })
      const signed = yield* Tx.sign(built, signer)
      return [signed, yield* Tx.cosign(signed, sponsor), yield* Effect.flip(Tx.sign(built, stranger)), yield* Effect.flip(Tx.cosign(signed, stranger))] as const
    }))
    expect(signed.signatures).toHaveLength(1)
    expect([cosigned.signatures.length, cosigned.signatures[0], cosigned.digest]).toEqual([2, signed.signatures[0], signed.digest] as never)
    expect([byStranger._tag, String(byStranger.cause)]).toEqual(["SigningError", expect.stringContaining(stranger.address)])
    expect(cosignedByStranger._tag).toBe("SigningError")
    expect("gas" in signed || "simulation" in signed).toBe(false)
  })

  test("attach adds a verified signature by the sender once, and refuses other bytes, a stranger and an empty signature", async () => {
    const [attached, again, otherBytes, byStranger, empty] = await run(Effect.gen(function*() {
      const built = yield* Tx.build(sponsoredRecipe, { sender: SENDER })
      const other = yield* Tx.build(pinsNothing, { sender: SENDER })
      const signature = yield* signer.signTransaction(built.bytes)
      const attached = yield* Tx.attach(yield* Tx.fromBytes(built.bytes), signature)
      return [
        attached,
        yield* Tx.attach(attached, signature),
        yield* Effect.flip(Tx.attach(other, signature)),
        yield* Effect.flip(Tx.attach(built, yield* stranger.signTransaction(built.bytes))),
        yield* Effect.flip(Tx.attach(built, ""))
      ] as const
    }))
    expect([attached.signatures.length, again.signatures.length]).toEqual([1, 1])
    expect(otherBytes._tag).toBe("SigningError")
    expect(byStranger._tag === "PolicyDenied" && [byStranger.rule, byStranger.message]).toEqual(["alias.signer", expect.stringContaining(stranger.address)])
    expect(empty._tag).toBe("SigningError")
  })
})

describe("recipe shapes", () => {
  test("sponsored sets sender, gas owner and an empty payment", () => {
    const tx = new Transaction()
    sponsoredRecipe(tx)
    expect([tx.getData().sender, tx.getData().gasData.owner, tx.getData().gasData.payment]).toEqual([SENDER, sponsor.address, []])
  })

  test("sendFunds is a FundsWithdrawal, redeem_funds and send_funds: address balance only", () => {
    const tx = new Transaction()
    Tx.sendFunds({ amount: 5n, recipient: RECIPIENT })(tx)
    const data = tx.getData()
    expect(data.inputs[0]?.$kind).toBe("FundsWithdrawal")
    expect(data.commands.map((c) => c.MoveCall && `${c.MoveCall.module}::${c.MoveCall.function}`)).toEqual(["balance::redeem_funds", "balance::send_funds"])
  })

  test("gaslessStablecoinTransfer is the SDK's balance intent then balance::send_funds, gas left to the resolver", () => {
    const USDC = CoinType.make(`${PADDED("dba3")}::usdc::USDC`)
    const tx = new Transaction()
    Tx.gaslessStablecoinTransfer({ coinType: USDC, amount: 10_000n, recipient: RECIPIENT })(tx)
    const data = tx.getData()
    expect(data.gasData).toEqual({ budget: null, price: null, owner: null, payment: null })
    expect(data.commands[0]).toMatchObject({ $kind: "$Intent", $Intent: { name: "CoinWithBalance", data: { type: USDC, balance: 10_000n, outputKind: "balance" } } })
    expect(data.commands[1]?.MoveCall).toMatchObject({ module: "balance", function: "send_funds", typeArguments: [USDC] })
  })

})
