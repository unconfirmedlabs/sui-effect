// Read one object, decoded. Absence is `None`; a wrong Move type is `DecodeError`.
import { bcs } from "@mysten/sui/bcs"
import { Effect, Option } from "effect"
import { type ObjectId, Sui, SuiSchema } from "../../src/index.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const Counter = SuiSchema.bcs(bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() }), `${PKG}::counter::Counter`)

export const readCounter = (id: ObjectId) =>
  Effect.gen(function*() {
    const sui = yield* Sui
    // Positional: `sui.getObject(id, { schema })`, not the SDK's `{ objectId }`.
    const counter = yield* sui.getObjectOption(id, { schema: Counter })
    return Option.map(counter, (object) => BigInt(object.content.value))
  })
