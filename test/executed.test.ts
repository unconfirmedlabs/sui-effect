import { describe, expect, test } from "bun:test"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Effect, Exit, Result } from "effect"
import { EXECUTE_INCLUDE, Executed, fromTransactionResult } from "../src/domain/executed.ts"
import { CoinType, SuiAddress } from "../src/domain/schemas.ts"
import { fakeDigest } from "../src/services/SuiCoreFake.ts"

const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ALICE = PADDED("a11ce")
const RECEIPT = PADDED("4ece")
const ESCROW = PADDED("e5c")
const COIN = PADDED("c01")
const ACCUMULATOR = PADDED("acc")
const PACKAGE = PADDED("9ac")
const DIGEST = fakeDigest(42)

const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: ALICE }

const change = (
  overrides: Partial<SuiClientTypes.ChangedObject> & { objectId: string }
): SuiClientTypes.ChangedObject => ({
  inputState: "DoesNotExist",
  inputVersion: null,
  inputDigest: null,
  inputOwner: null,
  outputState: "ObjectWrite",
  outputVersion: "9",
  outputDigest: fakeDigest(2),
  outputOwner: owner,
  idOperation: "Created",
  ...overrides
})

/** A response shaped exactly like a real `executeTransaction` with the execute include set. */
const result = (
  success: boolean
): SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE> => {
  const transaction = {
    digest: DIGEST,
    signatures: ["sig"],
    epoch: "412",
    timestampMs: 1_700_000_000_000,
    checkpoint: "88",
    status: success
      ? { success: true, error: null }
      : {
          success: false,
          error: {
            message: "MoveAbort",
            command: 1,
            $kind: "MoveAbort",
            MoveAbort: { abortCode: "3", location: { module: "escrow", functionName: "claim" } }
          }
        },
    balanceChanges: [
      { coinType: "0x2::sui::SUI", address: ALICE, amount: "-1000" },
      { coinType: "0x2::sui::SUI", address: ALICE, amount: "250" }
    ],
    effects: {
      bcs: null,
      version: 2,
      status: success ? { success: true, error: null } : { success: false, error: null },
      gasUsed: {
        computationCost: "1000000",
        storageCost: "2000000",
        storageRebate: "980000",
        nonRefundableStorageFee: "20000"
      },
      transactionDigest: DIGEST,
      gasObject: null,
      eventsDigest: null,
      dependencies: [],
      lamportVersion: "9",
      changedObjects: [
        change({ objectId: RECEIPT }),
        change({
          objectId: ESCROW,
          inputState: "Exists",
          inputVersion: "8",
          inputDigest: fakeDigest(3),
          inputOwner: owner,
          idOperation: "None"
        }),
        change({
          objectId: COIN,
          inputState: "Exists",
          inputVersion: "8",
          inputDigest: fakeDigest(4),
          inputOwner: owner,
          outputState: "DoesNotExist",
          outputVersion: null,
          outputDigest: null,
          outputOwner: null,
          idOperation: "Deleted"
        }),
        change({ objectId: ACCUMULATOR, outputState: "AccumulatorWriteV1" }),
        change({ objectId: PACKAGE, outputState: "PackageWrite" })
      ],
      unchangedConsensusObjects: [],
      auxiliaryDataDigest: null
    },
    events: [],
    objectTypes: {
      [RECEIPT]: "0x2::escrow::Receipt",
      [ESCROW]: "0x2::escrow::Escrow",
      [COIN]: "0x2::coin::Coin<0x2::sui::SUI>",
      [ACCUMULATOR]: "0x2::balance::Balance<0x2::sui::SUI>",
      [PACKAGE]: "0x2::package::Package"
    }
  }
  return (
    success
      ? { $kind: "Transaction", Transaction: transaction }
      : { $kind: "FailedTransaction", FailedTransaction: transaction }
  ) as unknown as SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
}

const decode = (success: boolean) =>
  Effect.runSync(Effect.result(fromTransactionResult(result(success))))

const executed = (): Executed => {
  const value = decode(true)
  if (!Result.isSuccess(value)) throw new Error(`fixture did not decode: ${JSON.stringify(value.failure)}`)
  return value.success
}

describe("Executed", () => {
  test("decodes a successful execute response", () => {
    expect(executed().digest).toBe(DIGEST as never)
    expect(executed().checkpoint).toBe(88n)
    expect(executed().timestampMs).toBe(1_700_000_000_000)
  })

  test("created joins objectTypes and ignores accumulator writes and packages", () => {
    const created = executed().created()
    expect(created.map((ref) => ref.id)).toEqual([RECEIPT as never])
    expect(created[0]?.type).toBe("0x0000000000000000000000000000000000000000000000000000000000000002::escrow::Receipt" as never)
    expect(created[0]?.version).toBe(9n as never)
    expect(created[0]?.owner?.$kind).toBe("AddressOwner")
  })

  test("created filters by type after normalization", () => {
    expect(executed().created("0x2::escrow::Receipt")).toHaveLength(1)
    expect(
      executed().created(
        "0x0000000000000000000000000000000000000000000000000000000000000002::escrow::Receipt"
      )
    ).toHaveLength(1)
    expect(executed().created("0x2::escrow::Escrow")).toHaveLength(0)
  })

  test("mutated returns the objects changed in place", () => {
    const mutated = executed().mutated()
    expect(mutated.map((ref) => ref.id)).toEqual([ESCROW as never])
  })

  test("deleted returns refs carrying the input version", () => {
    const deleted = executed().deleted()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.version).toBe(8n as never)
  })

  test("packagesPublished returns full refs, not bare ids", () => {
    const published = executed().packagesPublished()
    expect(published).toHaveLength(1)
    expect(published[0]?.id).toBe(PACKAGE as never)
    expect(published[0]?.version).toBe(9n as never)
    expect(published[0]?.digest).toBe(fakeDigest(2))
  })

  test("a package whose type is the literal `package` still produces a ref", () => {
    const raw = result(true)
    const transaction = raw.$kind === "Transaction" ? raw.Transaction : raw.FailedTransaction
    const patched = {
      ...raw,
      Transaction: {
        ...transaction,
        objectTypes: { ...transaction.objectTypes, [PACKAGE]: "package" }
      }
    } as unknown as SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
    const value = Effect.runSync(Effect.result(fromTransactionResult(patched)))
    expect(Result.isSuccess(value)).toBe(true)
    if (Result.isSuccess(value)) {
      const published = value.success.packagesPublished()
      expect(published).toHaveLength(1)
      expect(published[0]?.type).toBe("package")
    }
  })

  test("expectCreated fails with UnexpectedEffects when many match", async () => {
    const raw = result(true)
    const transaction = raw.$kind === "Transaction" ? raw.Transaction : raw.FailedTransaction
    const second = PADDED("4ecf")
    const patched = {
      ...raw,
      Transaction: {
        ...transaction,
        effects: {
          ...transaction.effects,
          changedObjects: [...transaction.effects.changedObjects, change({ objectId: second })]
        },
        objectTypes: { ...transaction.objectTypes, [second]: "0x2::escrow::Receipt" }
      }
    } as unknown as SuiClientTypes.TransactionResult<typeof EXECUTE_INCLUDE>
    const value = Effect.runSync(Effect.result(fromTransactionResult(patched)))
    if (!Result.isSuccess(value)) throw new Error("fixture did not decode")
    const error = await Effect.runPromise(
      value.success.expectCreated("0x2::escrow::Receipt").pipe(Effect.flip)
    )
    expect(error._tag).toBe("UnexpectedEffects")
    expect(error.found).toHaveLength(2)
  })

  test("balanceChange sums every delta for an address and coin type", () => {
    expect(
      executed().balanceChange(SuiAddress.make(ALICE), CoinType.make("0x2::sui::SUI"))
    ).toBe(-750n)
  })

  test("gasUsedTotal is computation plus storage less rebate", () => {
    expect(executed().gasUsedTotal).toBe(2_020_000n)
  })

  test("expectCreated returns the single ref", async () => {
    const ref = await Effect.runPromise(executed().expectCreated("0x2::escrow::Receipt"))
    expect(ref.id).toBe(RECEIPT as never)
  })

  test("expectCreated fails with UnexpectedEffects when nothing matches", async () => {
    const exit = await Effect.runPromiseExit(executed().expectCreated("0x2::escrow::Missing"))
    expect(Exit.isFailure(exit)).toBe(true)
    const error = await Effect.runPromise(
      executed().expectCreated("0x2::escrow::Missing").pipe(Effect.flip)
    )
    expect(error._tag).toBe("UnexpectedEffects")
    expect(error.found).toEqual([])
  })

  test("a failed transaction becomes ExecutionFailed, never an Executed", () => {
    const value = decode(false)
    expect(Result.isFailure(value)).toBe(true)
    if (Result.isFailure(value)) {
      expect(value.failure._tag).toBe("ExecutionFailed")
      if (value.failure._tag === "ExecutionFailed") {
        expect(value.failure.command).toBe(1)
        expect(value.failure.reason.$kind).toBe("MoveAbort")
      }
    }
  })
})

/**
 * NB4: `DecodeError.issue` is one sentence; `issues` is the structured tree,
 * with every issue reported rather than only the first.
 */
describe("DecodeError.issues", () => {
  test("Executed.fromPartial reports one entry per bad field, with its path", async () => {
    const result = await Effect.runPromise(
      Effect.result(
        Executed.fromPartial({
          digest: DIGEST,
          objectTypes: { [RECEIPT]: 5, [ESCROW]: 7 },
          effects: {}
        })
      )
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure.kind).toBe("shape")
    expect(result.failure.issues).toHaveLength(2)
    expect(result.failure.issues?.map((issue) => issue.path)).toEqual([
      ["objectTypes", RECEIPT],
      ["objectTypes", ESCROW]
    ])
    // The sentence is unchanged: consumers reading `issue` are unaffected.
    expect(result.failure.issue).toContain("this is not an execute envelope")
  })
})
