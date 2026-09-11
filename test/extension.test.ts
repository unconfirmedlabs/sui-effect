import { describe, expect, test } from "bun:test"
import type { BcsType } from "@mysten/bcs"
import { bcs } from "@mysten/sui/bcs"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ExtensionNotReady } from "../src/domain/errors.ts"
import type { PromiseFace } from "../src/services/SuiExtension.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

/** Compile-time assignability, as a value a test can assert on. */
const assignableTo = <_A extends _B, _B>(): true => true

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

/** A service whose surface is mostly synchronous, which is the common case. */
class Sync extends Context.Service<Sync, {
  /** A plain value. */
  readonly packageId: string
  /** A synchronous function: a recipe builder, in a real extension. */
  readonly claim: (id: string) => { readonly target: string }
  /** A class instance, which is a leaf: the face must not walk into it. */
  readonly codec: BcsType<string, string>
  /** And one Effect member, so the lazy path is exercised beside them. */
  readonly status: Effect.Effect<string, never>
}>()("demo/Sync") {
  static readonly codec: BcsType<string, string> = bcs.string()

  static readonly layer: Layer.Layer<Sync, never, Sui> = Layer.effect(
    Sync,
    Effect.gen(function*() {
      yield* Sui
      return {
        packageId: "0xabc",
        claim: (id: string) => ({ target: `0xabc::escrow::claim:${id}` }),
        codec: Sync.codec,
        status: Effect.succeed("ready")
      }
    })
  )
}

const syncClient = (
  options?: Partial<Parameters<typeof SuiExtension.fromService<Sync, Sync["Service"], never, "sync">>[1]>,
  network = "mainnet"
) => {
  const fake = Effect.runSync(
    Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID, network }), { local: true })
  )
  return SuiExtension.fromService(Sync, {
    name: "sync",
    layer: Sync.layer,
    ...options
  }).register(fake.client)
}

describe("SuiExtension.fromService: synchronous members", () => {
  test("a plain value read before the runtime exists throws ExtensionNotReady", () => {
    const api = syncClient()
    // The placeholder cannot be the string, and pretending otherwise is the
    // bug: any synchronous use of it says so instead.
    expect(() => `${api.packageId}`).toThrow(ExtensionNotReady)
    expect(() => JSON.stringify({ id: api.packageId })).toThrow(ExtensionNotReady)
  })

  test("a synchronous function called before the runtime exists rejects with ExtensionNotReady", async () => {
    const api = syncClient()
    const result = api.claim("0x1") as unknown as Promise<unknown>
    const error = await result.then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(ExtensionNotReady)
    expect((error as ExtensionNotReady).extension).toBe("sync")
    expect((error as ExtensionNotReady).member).toBe("claim")
  })

  test("$ready makes every member real, synchronous ones included", async () => {
    const api = syncClient()
    await api.$ready()
    expect(api.packageId).toBe("0xabc")
    expect(api.claim("0x1")).toEqual({ target: "0xabc::escrow::claim:0x1" })
    expect(await api.status()).toBe("ready")
    await api.$dispose()
  })

  test("$ready is idempotent and dispose is still its old name", async () => {
    const api = syncClient()
    await api.$ready()
    await api.$ready()
    expect(api.packageId).toBe("0xabc")
    expect(api.dispose).toBe(api.$dispose)
    await api.dispose()
  })

  test("warm builds the runtime inside register, so nothing has to be awaited", () => {
    const api = syncClient({ warm: {} })
    expect(api.packageId).toBe("0xabc")
    expect(api.claim("0x2")).toEqual({ target: "0xabc::escrow::claim:0x2" })
  })

  test("a class instance member survives untouched, warm or not", async () => {
    const warm = syncClient({ warm: {} })
    expect(warm.codec).toBe(Sync.codec)
    const lazy = syncClient()
    await lazy.$ready()
    expect(lazy.codec).toBe(Sync.codec)
    expect(lazy.codec.parse(Sync.codec.serialize("hello").toBytes())).toBe("hello")
    await lazy.$dispose()
  })

  test("warm on a network with no known chain id refuses rather than guessing", () => {
    expect(() => syncClient({ warm: {} }, "devnet")).toThrow(/chain id/)
    // With one given, it builds.
    const api = syncClient({ warm: { chainId: "whatever-this-devnet-is" } }, "devnet")
    expect(api.packageId).toBe("0xabc")
  })

  test("warm refuses a layer that needs an asynchronous step", () => {
    const asyncLayer: Layer.Layer<Sync, never, Sui> = Layer.effect(
      Sync,
      Effect.flatMap(Effect.promise(() => Promise.resolve("0xdef")), (packageId) =>
        Effect.map(Sui, () => ({
          packageId,
          claim: (id: string) => ({ target: id }),
          codec: Sync.codec,
          status: Effect.succeed("ready")
        })))
    )
    expect(() => syncClient({ warm: {}, layer: asyncLayer })).toThrow()
  })

  test("options.sui pins the chain id the node must report", async () => {
    const fake = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID, network: "devnet" }), {
        local: true
      })
    )
    const api = SuiExtension.fromService(Sync, {
      name: "sync",
      layer: Sync.layer,
      sui: { chainId: "a-different-chain" }
    }).register(fake.client)
    const error = await api.status().then(() => undefined, (cause: unknown) => cause)
    expect((error as { readonly _tag?: string })._tag).toBe("NetworkMismatch")
    await api.$dispose()
  })
})

/** The face's type, asserted rather than described. */
test("PromiseFace keeps synchronous members synchronous and class instances whole", () => {
  type Face = PromiseFace<Sync["Service"]>
  expect(assignableTo<Face["packageId"], string>()).toBe(true)
  expect(assignableTo<Face["claim"], (id: string) => { readonly target: string }>()).toBe(true)
  expect(assignableTo<Face["codec"], BcsType<string, string>>()).toBe(true)
  expect(assignableTo<Face["status"], () => Promise<string>>()).toBe(true)
})

test("awaiting a plain-value member before the runtime exists fails loudly", async () => {
  const api = syncClient()
  const error = await Promise.resolve(api.packageId as unknown as Promise<string>).then(
    () => undefined,
    (cause: unknown) => cause
  )
  expect(error).toBeInstanceOf(ExtensionNotReady)
})
