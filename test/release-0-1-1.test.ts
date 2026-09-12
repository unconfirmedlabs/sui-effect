/**
 * The 0.1.1 patch, proved.
 *
 * Every test here is a fix a downstream conversion asked for: the face type
 * that lied about interface-typed namespaces, `outcome` missing from a
 * serialized extension error, a cold call that aborted the process, a warm
 * registration that degraded to cold after `$dispose()`, `instanceof` against a
 * second copy of `@mysten/sui`, and the test harness's missing dependency slot.
 */
import { describe, expect, test } from "bun:test"
import type { BcsType } from "@mysten/bcs"
import { bcs } from "@mysten/sui/bcs"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import type { Outcome } from "../src/domain/errors.ts"
import { ExtensionNotReady, SuiError } from "../src/domain/errors.ts"
import { ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import * as SuiSchema from "../src/domain/sui-schema.ts"
import { Sui } from "../src/services/Sui.ts"
import { mapSdkError } from "../src/services/SuiCore.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiGraphQL } from "../src/services/SuiGraphQL.ts"
import type { Leaf, PromiseFace } from "../src/services/SuiExtension.ts"
import { leaf, SuiExtension } from "../src/services/SuiExtension.ts"
import { layerExtensionTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"

/** Compile-time assignability, as a value a test can assert on. */
const assignableTo = <_A extends _B, _B>(): true => true

// ---------------------------------------------------------------------------
// 11. `PromiseFace` recurses into interfaces
// ---------------------------------------------------------------------------

/** Two levels deep, and every level an `interface` — the shape that broke. */
interface Inner {
  readonly count: (of: string) => Effect.Effect<number, never>
  readonly ids: Stream.Stream<string, never>
}

interface Protocol {
  readonly inner: Inner
  readonly status: Effect.Effect<string, never>
}

/** A class instance with `Effect` methods: a leaf only because it says so. */
class Policy {
  allow(id: string): Effect.Effect<boolean, never> {
    return Effect.succeed(id !== "no")
  }
}

interface Namespaced {
  readonly protocol: Protocol
  readonly codec: BcsType<string, string>
  readonly policy: Leaf<Policy>
  readonly deployment: { readonly packageId: string }
  readonly packageId: string
}

class Faced extends Context.Service<Faced, Namespaced>()("demo/Faced") {
  static readonly codec: BcsType<string, string> = bcs.string()
  static readonly policy = leaf(new Policy())

  static readonly layer: Layer.Layer<Faced, never, Sui> = Layer.effect(
    Faced,
    Effect.gen(function*() {
      yield* Sui
      return {
        protocol: {
          inner: {
            count: (of: string) => Effect.succeed(of.length),
            ids: Stream.make("a", "b")
          },
          status: Effect.succeed("ready")
        },
        codec: Faced.codec,
        policy: Faced.policy,
        deployment: { packageId: "0xabc" },
        packageId: "0xabc"
      }
    })
  )
}

const facedClient = (warm = true) => {
  const fake = Effect.runSync(
    Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID }), { local: true })
  )
  return SuiExtension.fromService(Faced, {
    name: "faced",
    layer: Faced.layer,
    ...(warm ? { warm: { chainId: CHAIN_ID } } : {})
  }).register(fake.client)
}

describe("PromiseFace: the type recurses where the runtime recurses", () => {
  type Face = PromiseFace<Namespaced>

  test("an interface-typed namespace is mapped, not passed through", () => {
    // Before 0.1.1 the bound was `Record<string, unknown>`, which an interface
    // is not assignable to: `Face["protocol"]` was `Protocol` itself, so the
    // type said `status` was an `Effect` while the runtime handed back a
    // Promise-returning method. This assignment is the assertion.
    expect(assignableTo<Face["protocol"]["status"], () => Promise<string>>()).toBe(true)
  })

  test("a nested interface namespace, two levels deep, is mapped too", () => {
    expect(assignableTo<Face["protocol"]["inner"]["count"], (of: string) => Promise<number>>())
      .toBe(true)
    expect(assignableTo<Face["protocol"]["inner"]["ids"], AsyncIterable<string>>()).toBe(true)
  })

  test("a BCS codec is a leaf, recognised by parse plus serialize", () => {
    expect(assignableTo<Face["codec"], BcsType<string, string>>()).toBe(true)
  })

  test("a Leaf<T> class instance is a leaf", () => {
    expect(assignableTo<Face["policy"], Policy>()).toBe(true)
  })

  test("a plain-value object member keeps its value type", () => {
    expect(assignableTo<Face["deployment"]["packageId"], string>()).toBe(true)
  })

  test("the runtime agrees with all five", async () => {
    const api = facedClient()
    expect(await api.protocol.status()).toBe("ready")
    expect(await api.protocol.inner.count("abcd")).toBe(4)
    const ids: Array<string> = []
    for await (const id of api.protocol.inner.ids) ids.push(id)
    expect(ids).toEqual(["a", "b"])
    expect(api.codec).toBe(Faced.codec)
    // The marked leaf arrives as the instance, with its `Effect` method intact.
    expect(api.policy).toBe(Faced.policy)
    expect(Effect.runSync(api.policy.allow("yes"))).toBe(true)
    expect(api.deployment.packageId).toBe("0xabc")
    await api.$dispose()
  })
})

// ---------------------------------------------------------------------------
// 13. The cold placeholder
// ---------------------------------------------------------------------------

describe("a cold call is a real Promise", () => {
  test("it is instanceof Promise, and expect(...).rejects sees it", async () => {
    const api = facedClient(false)
    const cold = (api as unknown as { readonly packageId: () => Promise<unknown> }).packageId()
    expect(cold).toBeInstanceOf(Promise)
    await expect(cold).rejects.toBeInstanceOf(ExtensionNotReady)
    await api.$dispose()
  })

  test("a cold Stream call is still iterable", async () => {
    const api = facedClient(false)
    const ids: Array<string> = []
    for await (const id of api.protocol.inner.ids) ids.push(id)
    expect(ids).toEqual(["a", "b"])
    await api.$dispose()
  })

  test("an un-awaited cold call does not become an unhandled rejection", async () => {
    const unhandled: Array<unknown> = []
    const listener = (reason: unknown) => unhandled.push(reason)
    process.on("unhandledRejection", listener)
    try {
      const api = facedClient(false)
      // Nobody awaits this, and the type says it is a value, so the placeholder
      // rejects with `ExtensionNotReady`. Before 0.1.1 that killed the process.
      void (api as unknown as { readonly packageId: () => Promise<unknown> }).packageId()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
      await api.$dispose()
    } finally {
      process.off("unhandledRejection", listener)
    }
  })
})

// ---------------------------------------------------------------------------
// 14. A warm registration stays warm across $dispose()
// ---------------------------------------------------------------------------

test("$dispose does not degrade a warm registration to cold", async () => {
  const api = facedClient()
  expect(api.packageId).toBe("0xabc")
  await api.$dispose()
  // The next use re-runs the same warm build, so the synchronous member is the
  // value again rather than a placeholder that throws forever after.
  expect(api.packageId).toBe("0xabc")
  expect(await api.protocol.status()).toBe("ready")
  await api.$dispose()
})

test("a lazy registration is unchanged: cold again after dispose", async () => {
  const api = facedClient(false)
  await api.$ready()
  expect(api.packageId).toBe("0xabc")
  await api.$dispose()
  expect(() => `${api.packageId}`).toThrow(ExtensionNotReady)
  await api.$dispose()
})

// ---------------------------------------------------------------------------
// 12. `SuiError.toJson` keeps `outcome`
// ---------------------------------------------------------------------------

class SettlementUnknown extends Schema.TaggedError<SettlementUnknown>()(
  "escrow/SettlementUnknown",
  { escrowId: Schema.String, message: Schema.String }
) {
  readonly outcome: Outcome = "unknown"
}

describe("SuiError.toJson", () => {
  test("includes the outcome an extension error declares as a class field", () => {
    const error = new SettlementUnknown({ escrowId: "0xe5", message: "no answer" })
    const json = SuiError.toJson(error)
    expect(json).toEqual({
      _tag: "escrow/SettlementUnknown",
      escrowId: "0xe5",
      message: "no answer",
      outcome: "unknown"
    })
    // The field a wrapper script acts on is the field the log line carries.
    expect(json["outcome"]).toBe(SuiError.outcome(error))
  })

  test("a foreign tag with an outcome and no schema still carries it", () => {
    const json = SuiError.toJson({ _tag: "Foreign", outcome: "applied" } as never)
    expect(json["outcome"]).toBe("applied")
  })

  test("a taxonomy error is unchanged", () => {
    const json = SuiError.toJson(
      new ExtensionNotReady({ extension: "demo", member: "packageId" })
    )
    expect(json["_tag"]).toBe("ExtensionNotReady")
    expect(json["outcome"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 15. Two copies of @mysten/sui
// ---------------------------------------------------------------------------

/** The SDK's `ObjectError`, as a second copy of the package would define it. */
class OtherCopyObjectError extends Error {
  readonly reason: string
  readonly objectId: string
  constructor(reason: string, objectId: string) {
    super(`object ${objectId}: ${reason}`)
    this.name = "ObjectError"
    this.reason = reason
    this.objectId = objectId
  }
}

class OtherCopyTransactionError extends Error {
  readonly reason = "notFound"
  readonly digest: string
  constructor(digest: string) {
    super(`transaction ${digest} not found`)
    this.name = "TransactionError"
    this.digest = digest
  }
}

class OtherCopySimulationError extends Error {
  readonly executionError: SuiClientTypes.ExecutionError | undefined
  constructor(message: string, executionError?: SuiClientTypes.ExecutionError) {
    super(message)
    this.name = "SimulationError"
    this.executionError = executionError
  }
}

describe("mapSdkError duck-types the SDK's error classes", () => {
  const OBJECT = `0x${"0".repeat(63)}7`

  test("an ObjectError from another copy is still ObjectNotFound", () => {
    const error = mapSdkError("getObject", new OtherCopyObjectError("notFound", OBJECT))
    expect(error._tag).toBe("ObjectNotFound")
  })

  test("deleted and unknown map the same way instanceof would", () => {
    expect(mapSdkError("getObject", new OtherCopyObjectError("deleted", OBJECT))._tag)
      .toBe("ObjectDeleted")
    expect(mapSdkError("getObject", new OtherCopyObjectError("unknown", OBJECT))._tag)
      .toBe("ObjectUnavailable")
  })

  test("a TransactionError from another copy is TransactionNotFound", () => {
    const error = mapSdkError("getTransaction", new OtherCopyTransactionError("1".repeat(32)))
    expect(error._tag).toBe("TransactionNotFound")
  })

  test("a SimulationError from another copy is SimulationFailed", () => {
    const error = mapSdkError("simulate", new OtherCopySimulationError("aborted"))
    expect(error._tag).toBe("SimulationFailed")
  })

  test("anything else is still a TransportError", () => {
    expect(mapSdkError("getObject", new Error("boom"))._tag).toBe("TransportError")
    // A `reason` with no object id and no digest is not one of the SDK's.
    expect(mapSdkError("getObject", { reason: "notFound" })._tag).toBe("TransportError")
  })
})

// ---------------------------------------------------------------------------
// 16. `layerExtensionTest` takes extra dependency layers
// ---------------------------------------------------------------------------

class NeedsGraphQL extends Context.Service<NeedsGraphQL, {
  /** What the endpoint answers, or the tag of the failure it produced. */
  readonly endpoint: Effect.Effect<string, never>
}>()("demo/NeedsGraphQL") {
  static readonly layer: Layer.Layer<NeedsGraphQL, never, Sui | SuiGraphQL> = Layer.effect(
    NeedsGraphQL,
    Effect.gen(function*() {
      yield* Sui
      const graphql = yield* SuiGraphQL
      return {
        endpoint: Effect.promise(() =>
          (graphql.query({ query: "{ chainIdentifier }", variables: {} }) as Promise<unknown>).then(
            (answer) => String((answer as { readonly marker?: string }).marker),
            (cause: unknown) => String((cause as { readonly _tag?: string })._tag)
          )
        )
      }
    })
  )
}

describe("layerExtensionTest", () => {
  test("provides SuiGraphQL.layerUnavailable by default", async () => {
    const layer = layerExtensionTest(NeedsGraphQL.layer, { chainId: CHAIN_ID })
    const endpoint = await Effect.runPromise(
      Effect.provide(Effect.flatMap(NeedsGraphQL, (service) => service.endpoint), layer, {
        local: true
      })
    )
    // No endpoint is configured, so every call fails the way the extension
    // already handles it.
    expect(endpoint).toBe("GraphQLUnavailable")
  })

  test("extra overrides it", async () => {
    // `SuiGraphQL["Service"]` is the SDK's client itself, which is what makes a
    // scripted stand-in a one-liner.
    const client = {
      query: () => Promise.resolve({ marker: "scripted" })
    } as unknown as SuiGraphQL["Service"]
    const layer = layerExtensionTest(NeedsGraphQL.layer, { chainId: CHAIN_ID }, {
      extra: SuiGraphQL.layer(client)
    })
    const endpoint = await Effect.runPromise(
      Effect.provide(Effect.flatMap(NeedsGraphQL, (service) => service.endpoint), layer, {
        local: true
      })
    )
    expect(endpoint).toBe("scripted")
  })
})

// ---------------------------------------------------------------------------
// 1, 2, 5. The helpers
// ---------------------------------------------------------------------------

describe("the shorthand helpers", () => {
  test("SuiAddress.normalize takes every spelling .make refuses", () => {
    expect(SuiAddress.normalize("0x1")).toBe(SuiAddress.make(`0x${"0".repeat(63)}1`))
    expect(() => SuiAddress.make("0x1" as never)).toThrow()
    expect(() => SuiAddress.normalize("not an address")).toThrow()
  })

  test("ObjectId.normalize is its object-id twin", () => {
    expect(ObjectId.normalize("0x6")).toBe(ObjectId.make(`0x${"0".repeat(63)}6`))
  })

  test("SuiSchema.decodeWith parses and maps in one codec", () => {
    const layout = bcs.struct("Thing", { id: bcs.Address, amount: bcs.u64() })
    const codec = SuiSchema.decodeWith(
      layout,
      "0x2::thing::Thing",
      (raw) => ({ id: ObjectId.normalize(raw.id), amount: BigInt(raw.amount) })
    )
    const bytes = layout.serialize({ id: `0x${"0".repeat(63)}9`, amount: "12" }).toBytes()
    const decoded = Effect.runSync(Schema.decodeUnknownEffect(codec)(bytes))
    expect(decoded.amount).toBe(12n)
    expect(decoded.id).toBe(ObjectId.normalize("0x9"))
  })

  test("a throwing mapper is a DecodeError, not a defect", () => {
    const layout = bcs.struct("Thing", { id: bcs.Address })
    const codec = SuiSchema.decodeWith(layout, "0x2::thing::Thing", () => {
      throw new Error("that is not a thing")
    })
    const bytes = layout.serialize({ id: `0x${"0".repeat(63)}9` }).toBytes()
    const failure = Effect.runSync(
      Effect.flip(SuiSchema.decode(codec, bytes))
    )
    expect(failure._tag).toBe("DecodeError")
    expect(failure.issue).toContain("that is not a thing")
  })

  test("FakeScript.coinMetadata answers getCoinMetadata", async () => {
    const metadata: SuiClientTypes.CoinMetadata = {
      id: `0x${"0".repeat(63)}2`,
      decimals: 9,
      name: "Sui",
      symbol: "SUI",
      description: "",
      iconUrl: null
    }
    const answers = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const sui = yield* Sui
          const known = yield* sui.core.getCoinMetadata({ coinType: "0x2::sui::SUI" })
          const unknown = yield* sui.core.getCoinMetadata({ coinType: "0x9::pop::POP" })
          return [known.coinMetadata?.symbol, unknown.coinMetadata] as const
        }),
        layerExtensionTest(Layer.empty, {
          chainId: CHAIN_ID,
          coinMetadata: { "0x2::sui::SUI": metadata }
        }),
        { local: true }
      )
    )
    expect(answers).toEqual(["SUI", null])
  })
})
