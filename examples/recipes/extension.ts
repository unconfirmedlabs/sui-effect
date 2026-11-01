// An extension: a service on `Sui`, and its Promise face derived for `$extend`.
import { Context, Effect, Layer } from "effect"
import { type GetObjectError, type ObjectId, Sui } from "../../src/index.ts"
import { SuiExtension } from "../../src/extension.ts"

export class Versions extends Context.Service<Versions, {
  readonly of: (id: ObjectId) => Effect.Effect<bigint, GetObjectError>
}>()("example/Versions") {
  static readonly layer = Layer.effect(Versions, Effect.map(Sui, (sui) => ({
    of: (id: ObjectId) => Effect.map(sui.getObject(id), (object) => object.version)
  })))
}

// `new SuiGrpcClient({ … }).$extend(versions)`, then `await client.versions.of(id)`.
export const versions = SuiExtension.fromService(Versions, { name: "versions", layer: Versions.layer })
