// Decode a transaction's events with the codec you read objects with.
//
// Upgrades: an event struct (like an object type) keeps the id of the package that FIRST
// defined it, even when v2 code emits it, so a codec or filter for a v1 type names the original
// id. A struct added in v2 lives under the v2 id. A Move abort's `package` is the LATEST id.
import { bcs } from "@mysten/sui/bcs"
import { Effect } from "effect"
import { type Executed, SuiSchema } from "../../src/index.ts"

const ORIGINAL = "0x00000000000000000000000000000000000000000000000000000000000000b1"

export const Posted = SuiSchema.bcs(
  bcs.struct("Posted", { board: bcs.Address, index: bcs.u64() }),
  `${ORIGINAL}::board::Posted`
)

// Every `Posted` the transaction emitted, decoded, in emission order; none is `[]`.
export const postedIndices = (executed: Executed) =>
  Effect.map(executed.eventsOf(Posted), (events) => events.map((event) => BigInt(event.index)))

// Exactly one, or `UnexpectedEffects`; a second argument selects by another type than the codec's.
export const thePost = (executed: Executed) => executed.expectEvent(Posted)
