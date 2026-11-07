/**
 * The sender's check on sponsored bytes somebody else assembled.
 *
 * @since 0.5.0
 */
import { TransactionDataBuilder } from "@mysten/sui/transactions"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Effect } from "effect"
import { PolicyDenied } from "../domain/errors.ts"
import type { Built } from "../domain/built.ts"

const kindOf = (build: () => TransactionDataBuilder): Uint8Array | undefined => {
  try {
    return build().build({ onlyTransactionKind: true })
  } catch {
    return undefined
  }
}

const dataOf = (bytes: Uint8Array): TransactionDataBuilder | undefined => {
  try {
    return TransactionDataBuilder.fromBytes(bytes)
  } catch {
    return undefined
  }
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

/**
 * Checks that sponsored bytes a service assembled are the transaction the
 * sender asked to have sponsored, before the sender signs them.
 *
 * A sponsorship service (a hosted sponsor such as Enoki, or an application's
 * own) takes a transaction **kind** and answers full
 * bytes with its gas data added. Those bytes are what the sender's signature
 * will authorize, so they are read back, not trusted:
 *
 * - the sender the bytes name is `expect.sender` (`sponsored.sender`);
 * - the bytes name a gas owner, it is not the sender, and it is
 *   `expect.gasOwner` when one is given (`sponsored.gasOwner`);
 * - when `expect.transactionKind` is given, the bytes' transaction kind is
 *   **exactly** those kind bytes (`sponsored.kind`): a service cannot add a
 *   command, swap an input or change an argument and still get a signature.
 *
 * The chain is `Tx.fromBytes`'s check, which made the `Built`. Simulating the
 * bytes before signing them (`sui.simulate(built.bytes)`) is still the
 * caller's job.
 *
 * Fails with: `PolicyDenied` (rule `sponsored.sender`, `sponsored.gasOwner` or
 * `sponsored.kind`).
 *
 * @since 0.5.0
 */
export const verifySponsored = Effect.fn("Tx.verifySponsored")(function*(
  built: Built,
  expect: {
    readonly sender: string
    readonly gasOwner?: string
    readonly transactionKind?: Uint8Array
  }
): Effect.fn.Return<Built, PolicyDenied> {
  const sender = normalizeSuiAddress(expect.sender)
  // Read out of the bytes, never off the value: `built.sender` and
  // `built.gasOwner` are fields, and a value spread or decoded from somewhere
  // else can name a sponsor the bytes do not, leaving the sender paying.
  const data = dataOf(built.bytes)
  const named = data === undefined || typeof data.sender !== "string" || data.sender.length === 0
    ? undefined
    : normalizeSuiAddress(data.sender)
  if (named !== sender) {
    return yield* new PolicyDenied({
      rule: "sponsored.sender",
      message: named === undefined
        ? "the sponsored bytes are not a transaction this SDK can read"
        : `the sponsored bytes name sender ${named}, not ${sender}`
    })
  }
  const owner = data?.gasData.owner
  const gasOwner = typeof owner === "string" && owner.length > 0 ? normalizeSuiAddress(owner) : undefined
  if (gasOwner === undefined || gasOwner === sender) {
    return yield* new PolicyDenied({
      rule: "sponsored.gasOwner",
      message: "the bytes are not sponsored: the sender pays its own gas"
    })
  }
  if (expect.gasOwner !== undefined && gasOwner !== normalizeSuiAddress(expect.gasOwner)) {
    return yield* new PolicyDenied({
      rule: "sponsored.gasOwner",
      message: `the bytes are sponsored by ${gasOwner}, not ${normalizeSuiAddress(expect.gasOwner)}`
    })
  }
  const expected = expect.transactionKind
  if (expected !== undefined) {
    const actual = kindOf(() => TransactionDataBuilder.fromBytes(built.bytes))
    const asked = kindOf(() => TransactionDataBuilder.fromKindBytes(expected)) ?? expected
    if (actual === undefined || !sameBytes(actual, asked)) {
      return yield* new PolicyDenied({
        rule: "sponsored.kind",
        message: "the sponsored bytes carry a different transaction than the one sent for sponsorship"
      })
    }
  }
  return built
})
