// Mapping a Move abort to your own error. Match on `module` and `constant` (or `code`), not on
// `package`: after an upgrade the abort's location names the LATEST package id.
import { Effect, Schema } from "effect"
import { type ObjectId, SuiError } from "../../src/index.ts"
import { type Signer, Tx } from "../../src/tx.ts"

const PKG = "0x00000000000000000000000000000000000000000000000000000000000000e5"

export class AlreadyClaimed extends Schema.TaggedError<AlreadyClaimed>()("AlreadyClaimed", {
  escrow: Schema.String,
  // A simulated abort charged nothing; an executed one did. Declare which, for `Script.exitCode`.
  outcome: Schema.Literals(["applied", "not_applied"])
}) {}

export const claim = (signer: Signer, escrow: ObjectId) =>
  Tx.run((tx) => {
    tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(escrow)] })
  }, { signer }).pipe(
    Effect.catchIf(
      (error) => SuiError.isMoveAbort(error, { module: "escrow", constant: "EAlreadyClaimed" }),
      (error) => new AlreadyClaimed({ escrow, outcome: error._tag === "ExecutionFailed" ? "applied" : "not_applied" })
    )
  )
