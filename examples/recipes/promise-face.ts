// A Promise face from plain TypeScript: a `Signer` value, a branded id decoded from user input,
// and one readable line on rejection. `SuiError.describe` takes any value, so no cast.
import type { ClientWithCoreApi } from "@mysten/sui/client"
import type { Keypair } from "@mysten/sui/cryptography"
import { Context, Effect, Layer, Schema } from "effect"
import { type Digest, ObjectId, Sui, SuiError } from "../../src/index.ts"
import { SuiExtension } from "../../src/extension.ts"
import { type RunError, Signer, Tx } from "../../src/tx.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"

export class Counters extends Context.Service<Counters, {
  readonly increment: (signer: Signer, counter: ObjectId) => Effect.Effect<Digest, RunError>
}>()("example/Counters") {
  static readonly layer = Layer.effect(Counters, Effect.map(Sui, (sui) => ({
    increment: (signer: Signer, counter: ObjectId) =>
      Tx.run((tx) => {
        tx.moveCall({ target: `${PKG}::counter::increment`, arguments: [tx.object(counter)] })
      }, { signer }).pipe(Effect.map((executed) => executed.digest), Effect.provideService(Sui, sui))
  })))
}

export const counters = SuiExtension.fromService(Counters, { name: "counters", layer: Counters.layer })

export const incrementCommand = (client: ClientWithCoreApi, keypair: Keypair) => {
  const face = client.$extend(counters).counters
  const signer = Signer.fromKeypair(keypair)
  // `ObjectId.Strict` for what a person typed: exactly 64 hex digits, never padded.
  return (input: string): Promise<string> =>
    Schema.decodeUnknownPromise(ObjectId.Strict)(input)
      .then((counter) => face.increment(signer, counter))
      .then((digest) => `incremented in ${digest}`)
      .catch((error) => SuiError.describe(error))
}
