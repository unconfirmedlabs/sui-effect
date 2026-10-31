/**
 * The recipes `docs/llms-head.md` quotes at the top of `LLMS.md`, run against
 * the fake. `scripts/llms.ts` copies each file verbatim (rewriting only the
 * relative `src/` imports to the package subpaths), and `test/llms.test.ts`
 * fails when the copy is stale, so a recipe an agent reads first is one that
 * typechecks and runs. The fifth recipe, `test/recipes/fake.test.ts`, is a test
 * itself.
 */
import { describe, expect, test } from "bun:test"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Effect, Layer, Option } from "effect"
import { pay } from "../examples/recipes/build-and-submit.ts"
import { Versions, versions } from "../examples/recipes/extension.ts"
import { readCounter } from "../examples/recipes/read-object.ts"
import { sponsoredIncrement } from "../examples/recipes/sponsored.ts"
import { ObjectId, SuiAddress } from "../src/index.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { FakeOutcome, type FakeScript, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { layerExtensionTest, layerTest } from "../src/testing.ts"

const PKG = "0x0000000000000000000000000000000000000000000000000000000000000002"
const COUNTER = ObjectId.normalize("0xc0")
const CounterBcs = bcs.struct("Counter", { id: bcs.Address, value: bcs.u64() })
const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(21)))
const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(22)))
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: signer.address }

const counter = {
  objectId: COUNTER,
  type: `${PKG}::counter::Counter`,
  version: 3n,
  owner,
  content: CounterBcs.serialize({ id: COUNTER, value: 41n }).toBytes()
}

const coin = {
  objectId: ObjectId.normalize("0xc01"),
  version: "2",
  digest: "11111111111111111111111111111111",
  type: `${PKG}::coin::Coin<${PKG}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const script: FakeScript = {
  objects: [counter],
  coins: [coin],
  // Gas for the sponsored paths comes from an address balance, which
  // `Tx.build` checks covers the budget before anything is signed.
  balances: [{ coinType: "0x2::sui::SUI", balance: "1000000000", coinBalance: "0", addressBalance: "1000000000" }],
  execute: [FakeOutcome.succeed({ mutated: [{ ...counter, version: 4n }] })]
}

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("docs/llms-head.md recipes", () => {
  test("read-object: a counter is Some(value), a missing one None", async () => {
    const provide = Effect.provide(layerTest(script))
    expect(await run(readCounter(COUNTER).pipe(provide))).toEqual(Option.some(41n))
    expect(await run(readCounter(ObjectId.normalize("0xc1")).pipe(provide))).toEqual(Option.none())
  })

  test("build-and-submit: Tx.run pays and answers the digest", async () => {
    const digest = await run(
      pay(signer, SuiAddress.normalize("0xa11ce"), 1_000n).pipe(
        Effect.provide(Layer.merge(layerTest(script), Journal.layerMemory))
      )
    )
    expect(digest.length).toBeGreaterThan(0)
  })

  test("sponsored: build, sign, cosign, submit with two signatures", async () => {
    const executed = await run(
      sponsoredIncrement(signer, sponsor, COUNTER).pipe(
        Effect.provide(Layer.merge(layerTest(script), Journal.layerMemory))
      )
    )
    expect(executed.mutated().map((ref) => ref.id)).toContain(COUNTER)
  })

  test("extension: the Effect service and its derived Promise face agree", async () => {
    const viaEffect = await run(
      Effect.flatMap(Versions, (service) => service.of(COUNTER)).pipe(
        Effect.provide(layerExtensionTest(Versions.layer, script))
      )
    )
    expect(viaEffect).toBe(3n)

    const fake = Effect.runSync(Effect.provide(SuiCoreFake, SuiCoreFake.layer(script), { local: true }))
    const client = fake.client.$extend(versions)
    expect(await client.versions.of(COUNTER)).toBe(3n)
    await client.versions.$dispose()
  })
})
