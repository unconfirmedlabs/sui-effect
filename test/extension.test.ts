import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { PromiseFace } from "../src/services/SuiExtension.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

/** An extension's own error, to prove a rejection keeps the instance. */
class EscrowClosed extends Schema.TaggedError<EscrowClosed>()("EscrowClosed", {
  id: Schema.String
}) {
  readonly outcome = "not_applied" as const
}

/** A small in-test extension with a nested namespace and a Stream member. */
class Demo extends Context.Service<Demo, {
  readonly chainId: string
  readonly status: Effect.Effect<string, never>
  readonly claim: (id: string) => Effect.Effect<string, EscrowClosed>
  readonly events: Stream.Stream<number, never>
  readonly escrow: {
    readonly count: (of: string) => Effect.Effect<number, never>
    readonly ids: Stream.Stream<string, never>
  }
}>()("demo/Demo") {
  static readonly layer: Layer.Layer<Demo, never, Sui> = Layer.effect(
    Demo,
    Effect.gen(function*() {
      const sui = yield* Sui
      return {
        chainId: sui.chainId,
        status: Effect.succeed("ready"),
        claim: (id: string) =>
          id === "closed" ? Effect.fail(new EscrowClosed({ id })) : Effect.succeed(`claimed ${id}`),
        events: Stream.make(1, 2, 3),
        escrow: {
          count: (of: string) => Effect.succeed(of.length),
          ids: Stream.make("a", "b")
        }
      }
    })
  )
}

const registration = SuiExtension.fromService(Demo, { name: "demo", layer: Demo.layer })

const client = () => {
  const fake = Effect.runSync(
    Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
  )
  return registration.register(fake.client)
}

describe("SuiExtension.fromService", () => {
  test("Effect members become Promise methods", async () => {
    const demo = client()
    expect(await demo.status()).toBe("ready")
    expect(await demo.claim("0x1")).toBe("claimed 0x1")
    await demo.dispose()
  })

  test("a rejection is the original tagged error instance", async () => {
    const demo = client()
    const error = await demo.claim("closed").then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(EscrowClosed)
    expect((error as EscrowClosed)._tag).toBe("EscrowClosed")
    expect((error as EscrowClosed).outcome).toBe("not_applied")
    await demo.dispose()
  })

  test("Stream members become AsyncIterables, before and after the first call", async () => {
    const demo = client()
    const lazy: Array<number> = []
    for await (const event of demo.events) lazy.push(event)
    expect(lazy).toEqual([1, 2, 3])

    const again: Array<number> = []
    for await (const event of demo.events) again.push(event)
    expect(again).toEqual([1, 2, 3])
    await demo.dispose()
  })

  test("nested namespaces are mapped recursively", async () => {
    const demo = client()
    expect(await demo.escrow.count("abcd")).toBe(4)
    const ids: Array<string> = []
    for await (const id of demo.escrow.ids) ids.push(id)
    expect(ids).toEqual(["a", "b"])
    await demo.dispose()
  })

  test("non-function values pass through once the runtime is up", async () => {
    const demo = client()
    await demo.status()
    expect(demo.chainId).toBe(CHAIN_ID)
    await demo.dispose()
  })

  test("the runtime is built once and lazily", async () => {
    let built = 0
    const counted = Layer.effect(
      Demo,
      Effect.gen(function*() {
        built += 1
        return yield* Demo.layer.pipe(Layer.build, Effect.map((context) => Context.get(context, Demo)))
      })
    )
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const demo = SuiExtension.fromService(Demo, { name: "demo", layer: counted }).register(
      fake.client
    )
    expect(built).toBe(0)
    await demo.status()
    await demo.status()
    expect(built).toBe(1)
    await demo.dispose()
  })

  test("the registration has the name $extend will use", () => {
    expect(registration.name).toBe("demo")
  })

  test("a layer that fails rejects with the original instance, on the first call", async () => {
    // The runtime is built lazily, so a layer's failure has nowhere to go at
    // registration time. It surfaces as the rejection of whatever call needed
    // it — as the very error the layer failed with, not a wrapper.
    const broken = new EscrowClosed({ id: "the layer" })
    const failing: Layer.Layer<Demo, EscrowClosed, Sui> = Layer.effect(
      Demo,
      Effect.fail(broken)
    )
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const demo = SuiExtension.fromService(Demo, { name: "demo", layer: failing }).register(
      fake.client
    )
    const error = await demo.status().then(() => undefined, (cause: unknown) => cause)
    expect(error).toBe(broken)
    expect(error).toBeInstanceOf(EscrowClosed)
    await demo.dispose()
  })

  test("the registered property is typed, with no cast and no undefined", () => {
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const extended = fake.client.$extend(registration)
    // `fromService` is generic in a string literal, so this is a property of
    // the extended client's type rather than an index signature — which is
    // what `noUncheckedIndexedAccess` used to widen with `undefined`. The
    // assignment is the assertion: it does not compile otherwise.
    const api: PromiseFace<Demo["Service"]> & { readonly dispose: () => Promise<void> } =
      extended.demo
    expect(typeof api.dispose).toBe("function")
  })

  test("dispose is not final: the next call builds a fresh runtime", async () => {
    let built = 0
    const counted: Layer.Layer<Demo, never, Sui> = Layer.effect(
      Demo,
      Effect.gen(function*() {
        built += 1
        return yield* Demo.layer.pipe(Layer.build, Effect.map((context) => Context.get(context, Demo)))
      })
    )
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const demo = SuiExtension.fromService(Demo, { name: "demo", layer: counted }).register(
      fake.client
    )
    expect(await demo.status()).toBe("ready")
    await demo.dispose()
    expect(await demo.status()).toBe("ready")
    expect(built).toBe(2)
    await demo.dispose()
  })

  test("registering twice gives two independent runtimes", async () => {
    let built = 0
    const counted: Layer.Layer<Demo, never, Sui> = Layer.effect(
      Demo,
      Effect.gen(function*() {
        built += 1
        return yield* Demo.layer.pipe(Layer.build, Effect.map((context) => Context.get(context, Demo)))
      })
    )
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
    )
    const registrationOf = () =>
      SuiExtension.fromService(Demo, { name: "demo", layer: counted }).register(fake.client)
    const first = registrationOf()
    const second = registrationOf()
    await first.status()
    await second.status()
    // Two layer builds, so two copies of whatever the layer holds. Register
    // once per client and keep the extended client.
    expect(built).toBe(2)
    await first.dispose()
    await second.dispose()
  })
})
