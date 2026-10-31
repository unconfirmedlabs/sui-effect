/**
 * The 0.4.0 review batch: sender locks keyed on the normalized address, the
 * `SuiError` helpers total over foreign values, and the Promise face's cold
 * edges (awaiting the face, `$ready`/`$reconcileAll` after `$dispose`,
 * `call`/`apply`/`bind`, `"prototype" in` a cold call).
 */
import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer } from "effect"
import { SuiAddress } from "../src/domain/schemas.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { layerTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const LOWER = `0x${"a".repeat(64)}`
const UPPER = `0x${"A".repeat(64)}`

const fakeClient = () =>
  Effect.runSync(
    Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID, network: "localnet" }), { local: true })
  ).client

/**
 * Runs two `withSenderLock` bodies under the two spellings of one address and
 * answers whether the second entered while the first was still inside.
 */
const overlaps = (sui: Sui["Service"]) =>
  Effect.gen(function*() {
    // `make` validates without decoding, so an upper-case spelling is a valid,
    // non-canonical `SuiAddress`.
    const upper = SuiAddress.make(UPPER)
    const lower = SuiAddress.make(LOWER)
    const release = yield* Deferred.make<void>()
    const holder = yield* Effect.forkChild(sui.withSenderLock(lower)(Deferred.await(release)))
    for (let i = 0; i < 20; i++) yield* Effect.yieldNow
    const second = yield* Effect.forkChild(sui.withSenderLock(upper)(Effect.succeed(true)))
    for (let i = 0; i < 50; i++) yield* Effect.yieldNow
    const entered = second.pollUnsafe() !== undefined
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(holder)
    yield* Fiber.join(second)
    return entered
  })

describe("sender locks are keyed on the normalized address", () => {
  test("Sui.withSenderLock serializes the upper- and lower-case spellings of one sender", async () => {
    const entered = await Effect.runPromise(
      Effect.provide(Effect.flatMap(Sui, overlaps), layerTest({ chainId: CHAIN_ID }), { local: true })
    )
    expect(entered).toBe(false)
  })

  test("the Promise face's process-wide lock does too", async () => {
    class Holder extends Context.Service<Holder, {
      readonly overlaps: () => Effect.Effect<boolean>
    }>()("review/Holder") {}
    const layer: Layer.Layer<Holder, never, Sui> = Layer.effect(
      Holder,
      Effect.map(Sui, (sui) => ({ overlaps: () => overlaps(sui) }))
    )
    const face = SuiExtension.fromService(Holder, { name: "holder", layer }).register(fakeClient())
    expect(await face.overlaps()).toBe(false)
    await face.$dispose()
  })
})
