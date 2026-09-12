/**
 * Claims an escrow through a PTB, written against the canonical 2.30 SDK.
 *
 * Compare with `examples/compare-write.effect.ts`, which does the same thing
 * through `Tx.run` and notes what that adds over this file. Both sign with
 * `SUI_PRIVATE_KEY` and print the created receipt's object id.
 *
 * Run with:
 * SUI_NETWORK=testnet SUI_PRIVATE_KEY=suiprivkey1… ESCROW_ID=0x… bun examples/compare-write.sdk.ts
 */
import { bcs } from "@mysten/sui/bcs"
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { Keypair } from "@mysten/sui/cryptography"
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Secp256k1Keypair } from "@mysten/sui/keypairs/secp256k1"
import { Secp256r1Keypair } from "@mysten/sui/keypairs/secp256r1"
import { Transaction } from "@mysten/sui/transactions"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const RECEIPT_TYPE = `${PKG}::escrow::Receipt`
const EscrowBcs = bcs.struct("Escrow", { id: bcs.Address, amount: bcs.u64() })

// The scheme flag on a Bech32 key names one of three keypair classes;
// nothing else decodes it, and a fourth scheme has no keypair class at all.
const KEYPAIR_FOR: Record<string, undefined | ((secretKey: Uint8Array) => Keypair)> = {
  ED25519: Ed25519Keypair.fromSecretKey,
  Secp256k1: Secp256k1Keypair.fromSecretKey,
  Secp256r1: Secp256r1Keypair.fromSecretKey
}

/**
 * Reads the escrow, claims it, and returns the created receipt's object id.
 *
 * Builds, signs and executes as three explicit steps rather than the
 * one-call `signAndExecuteTransaction`, so this can run against an in-memory
 * client with no live network or signer behind it.
 */
export const claimEscrow = async (
  client: ClientWithCoreApi,
  escrowId: string,
  keypair: Keypair
): Promise<string> => {
  const { object } = await client.core.getObject({ objectId: escrowId, include: { content: true } })
  const { amount } = EscrowBcs.parse(object.content)

  const tx = new Transaction()
  tx.setSenderIfNotSet(keypair.toSuiAddress())
  tx.moveCall({ target: `${PKG}::escrow::claim`, arguments: [tx.object(escrowId), tx.pure.u64(amount)] })
  const bytes = await tx.build({ client })
  const { signature } = await keypair.signTransaction(bytes)

  const result = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [signature],
    include: { effects: true, objectTypes: true }
  })
  const digest = (result.Transaction ?? result.FailedTransaction).digest
  await client.core.waitForTransaction({ digest })

  if (result.$kind === "FailedTransaction") {
    const { error } = result.FailedTransaction.status
    if (error?.$kind === "MoveAbort") {
      const { abortCode, cleverError } = error.MoveAbort
      throw new Error(`claim aborted: code ${abortCode}${cleverError?.constantName ? ` (${cleverError.constantName})` : ""}`)
    }
    throw new Error(`claim failed: ${error?.message}`)
  }

  // Effects list every changed object by id; only the `objectTypes` join
  // says which one is the receipt. sui-effect's `expectCreated` is this join,
  // plus a check that exactly one match exists.
  const { changedObjects } = result.Transaction.effects
  const created = changedObjects.find(
    (change) => change.idOperation === "Created" && result.Transaction.objectTypes[change.objectId] === RECEIPT_TYPE
  )
  if (created === undefined) throw new Error(`claim applied (${digest}) but created no ${RECEIPT_TYPE}`)
  return created.objectId
}

if (import.meta.main) {
  const escrowId = process.env.ESCROW_ID
  const key = process.env.SUI_PRIVATE_KEY
  if (!escrowId || !key) throw new Error("ESCROW_ID and SUI_PRIVATE_KEY are required")
  const parsed = decodeSuiPrivateKey(key)
  const fromSecretKey = KEYPAIR_FOR[parsed.scheme]
  if (!fromSecretKey) throw new Error(`${parsed.scheme} has no keypair class here (use a remote signer)`)
  const client = new SuiGrpcClient({
    network: (process.env.SUI_NETWORK ?? "testnet") as "testnet",
    baseUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443"
  })
  console.log(await claimEscrow(client, escrowId, fromSecretKey(parsed.secretKey)))
}
