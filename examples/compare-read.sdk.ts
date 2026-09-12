/**
 * Reads one Escrow object and an optional dynamic field on it, written
 * against the canonical 2.30 SDK: a gRPC client, the Core API, manual BCS.
 *
 * Compare with `examples/compare-read.effect.ts`. Both print identical
 * output for the same id.
 *
 * Run with `SUI_NETWORK=testnet ESCROW_ID=0x… bun examples/compare-read.sdk.ts`.
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import { ObjectError } from "@mysten/sui/client"
import { SuiGrpcClient } from "@mysten/sui/grpc"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const ESCROW_TYPE = `${PKG}::escrow::Escrow`
const EscrowBcs = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() })
// A note some escrows carry, keyed by the literal index 0. The key is a
// primitive `u64`, not a struct tag, so nothing here parses it as one.
const NOTE_NAME = { type: "u64", bcs: bcs.u64().serialize(0).toBytes() }

/** Reads the escrow at `id` plus its optional note. */
export const readEscrow = async (
  client: ClientWithCoreApi,
  id: string
): Promise<{ id: string; amount: string; note: string | undefined }> => {
  let object
  try {
    ;({ object } = await client.core.getObject({ objectId: id, include: { content: true } }))
  } catch (error) {
    // `getObject` throws rather than returning a value that says which of
    // "missing", "deleted" or "unreachable" happened; that three-way split
    // is `ObjectError.reason`, read by hand.
    if (error instanceof ObjectError) {
      if (error.reason === "notFound") throw new Error(`escrow ${id} does not exist`)
      if (error.reason === "deleted") throw new Error(`escrow ${id} was deleted`)
      throw new Error(`escrow ${id}: node could not say what happened to it`, { cause: error })
    }
    throw error
  }
  // No type parameters on this tag, so a plain string comparison is honest;
  // a generic type would need to be parsed and compared piece by piece,
  // which is what sui-effect's bridge does for every caller.
  if (object.type !== ESCROW_TYPE) {
    throw new Error(`${id} is a ${object.type}, not ${ESCROW_TYPE}`)
  }
  const { id: escrowId, amount } = EscrowBcs.parse(object.content)

  let note: string | undefined
  try {
    const { dynamicField } = await client.core.getDynamicField({ parentId: id, name: NOTE_NAME })
    note = bcs.u64().parse(dynamicField.value.bcs)
  } catch (error) {
    // Absence is normal here; only a reason other than "notFound"/"deleted"
    // is a real problem.
    if (!(error instanceof ObjectError) || error.reason === "unknown") throw error
  }

  return { id: escrowId, amount, note }
}

if (import.meta.main) {
  const id = process.env.ESCROW_ID
  if (!id) throw new Error("ESCROW_ID is required")
  const client = new SuiGrpcClient({
    network: (process.env.SUI_NETWORK ?? "testnet") as "testnet",
    baseUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443"
  })
  const escrow = await readEscrow(client, id)
  console.log(`${escrow.id} holds ${escrow.amount}, note: ${escrow.note ?? "none"}`)
}
