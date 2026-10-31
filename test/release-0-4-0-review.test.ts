/**
 * The 0.4.0 review batch: sender locks keyed on the normalized address, the
 * `SuiError` helpers total over foreign values, and the Promise face's cold
 * edges (awaiting the face, `$ready`/`$reconcileAll` after `$dispose`,
 * `call`/`apply`/`bind`, `"prototype" in` a cold call).
 */
import { describe, expect, test } from "bun:test"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import { Context, Deferred, Effect, Fiber, Layer, Option, Schema } from "effect"
import { JournalError, SigningError, SubmissionUnknown, SuiError, TransportError } from "../src/domain/errors.ts"
import { Digest, SuiAddress } from "../src/domain/schemas.ts"
import { Journal } from "../src/services/Journal.ts"
import { fromKeypair, type Signer } from "../src/services/Signer.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { Tx } from "../src/services/Tx.ts"
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

  test("Tx.run takes a sender/gas-owner pair in normalized order, whatever the spelling", async () => {
    // Normalized, the sponsor (0xa0cc…) sorts before the sender (0xd64f…);
    // spelled upper-case, "0xD…" sorts before "0xa…". Both locks are keyed on
    // the normalized address, so two runs ordering the same pair by spelling
    // could each hold one and wait for the other.
    const real = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3)))
    const sender: Signer = { ...real, address: SuiAddress.make(`0x${real.address.slice(2).toUpperCase()}`) }
    const sponsor = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
    expect(sender.address < sponsor.address).toBe(true)
    expect(normalizeSuiAddress(sender.address) > sponsor.address).toBe(true)
    const taken: Array<string> = []
    const spied = Effect.updateService(
      Tx.run((tx) => {
        tx.transferObjects([tx.splitCoins(tx.gas, [1])], sponsor.address)
      }, { signer: sender, gasOwner: sponsor.address, sponsor }),
      Sui,
      (sui) => ({
        ...sui,
        withSenderLock: (address) => (effect) =>
          Effect.andThen(
            Effect.sync(() => taken.push(normalizeSuiAddress(address))),
            sui.withSenderLock(address)(effect)
          )
      })
    )
    // How the run ends does not matter here (the fake holds no coins for
    // either party); only the order in which the locks were asked for.
    await Effect.runPromiseExit(
      Effect.provide(spied, Layer.merge(Journal.layerMemory, layerTest({ chainId: CHAIN_ID })))
    )
    expect(taken).toEqual([sponsor.address, normalizeSuiAddress(sender.address)])
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

const DIGEST = Digest.make("11111111111111111111111111111111")

/** Every helper documented "Never fails", run over one value. */
const neverThrows = (value: unknown): Record<string, string> => {
  const results: Record<string, string> = {}
  const helpers: ReadonlyArray<readonly [string, () => unknown]> = [
    ["describe", () => SuiError.describe(value)],
    ["describe(tag: false)", () => SuiError.describe(value, { tag: false })],
    ["toJson", () => SuiError.toJson(value)],
    ["outcome", () => SuiError.outcome(value)],
    ["outcome(pre-submit)", () => SuiError.outcome(value, { phase: "pre-submit" })],
    ["isRetryable", () => SuiError.isRetryable(value)],
    ["isTaxonomy", () => SuiError.isTaxonomy(value)],
    ["digestOf", () => SuiError.digestOf(value)],
    ["moveAbort", () => SuiError.moveAbort(value)],
    ["isMoveAbort", () => SuiError.isMoveAbort(value, { code: 1 })]
  ]
  for (const [name, run] of helpers) {
    try {
      const out = run()
      results[name] = name.startsWith("describe") && typeof out !== "string" ? "not a string" : "ok"
    } catch (error) {
      results[name] = `threw ${String((error as Error)?.message).slice(0, 80)}`
    }
  }
  return results
}

const allOk = {
  describe: "ok",
  "describe(tag: false)": "ok",
  toJson: "ok",
  outcome: "ok",
  "outcome(pre-submit)": "ok",
  isRetryable: "ok",
  isTaxonomy: "ok",
  digestOf: "ok",
  moveAbort: "ok",
  isMoveAbort: "ok"
}

describe("the SuiError helpers are total over foreign values", () => {
  const cases: ReadonlyArray<readonly [string, () => unknown]> = [
    ["a null-prototype object", () => Object.create(null)],
    ["an object whose toString throws", () => ({
      toString: () => {
        throw new Error("nope")
      }
    })],
    ["a revoked Proxy", () => {
      const { proxy, revoke } = Proxy.revocable({}, {})
      revoke()
      return proxy
    }],
    ["a Proxy whose get trap throws", () =>
      new Proxy({}, {
        get: () => {
          throw new Error("trap")
        }
      })],
    ["an object with a throwing _tag getter", () => ({
      get _tag(): string {
        throw new Error("tag")
      }
    })],
    ["a foreign tag with a throwing message getter", () => ({
      _tag: "Foreign",
      get message(): string {
        throw new Error("msg")
      }
    })],
    ["ExecutionFailed with no fields", () => ({ _tag: "ExecutionFailed" })],
    ["SimulationFailed with only a message", () => ({ _tag: "SimulationFailed", message: "x" })],
    ["UnexpectedEffects without found", () => ({ _tag: "UnexpectedEffects", digest: DIGEST })],
    ["a cyclic taxonomy-tagged cause", () => {
      const error: Record<string, unknown> = { _tag: "SigningError" }
      error["cause"] = error
      return error
    }],
    ["a cycle through real instances", () => {
      const inner: Record<string, unknown> = { _tag: "JournalError" }
      const outer = new SigningError({ cause: inner })
      inner["cause"] = outer
      return outer
    }],
    ["a cyclic ConfigError", () => {
      const error: Record<string, unknown> = { _tag: "ConfigError" }
      error["cause"] = { _tag: "ConfigError", cause: error }
      return error
    }],
    ["a cyclic foreign Error cause", () => {
      const error = new Error("outer") as Error & { cause?: unknown }
      error.cause = error
      return error
    }]
  ]
  for (const [label, make] of cases) {
    test(label, () => {
      expect(neverThrows(make())).toEqual(allOk)
    })
  }

  test("a description is one line, and falls back to the tag", () => {
    expect(SuiError.describe({ _tag: "ExecutionFailed" })).toBe("ExecutionFailed")
    expect(SuiError.describe({ _tag: "Foreign", get message(): string { throw new Error("msg") } })).toBe("Foreign")
    expect(SuiError.describe(Object.create(null))).toBe("[object Object]")
  })

  test("a throwing cause message leaves the house getter readable", () => {
    const error = new JournalError({ cause: { get message(): string { throw new Error("boom") } } })
    expect(error.message).toBe("JournalError")
  })

  test("isMoveAbort with a non-integer code is false, not a RangeError", () => {
    const error = {
      _tag: "ExecutionFailed",
      reason: { $kind: "MoveAbort", MoveAbort: { abortCode: 1n } }
    }
    expect(SuiError.isMoveAbort(error, { code: 1 })).toBe(true)
    expect(SuiError.isMoveAbort(error, { code: 1.5 })).toBe(false)
    expect(Option.isSome(SuiError.moveAbort(error))).toBe(true)
  })
})

describe("an extension error that copies the house message getter", () => {
  // What docs/extensions.md says sui-effect's own classes do.
  class EscrowDenied extends Schema.TaggedError<EscrowDenied>()("escrow/Denied", { rule: Schema.String }) {
    readonly outcome = "not_applied" as const
    override get message(): string {
      return SuiError.describe(this)
    }
  }

  test("describe, .message and toJson terminate with a one-line description", () => {
    const error = new EscrowDenied({ rule: "spend" })
    expect(SuiError.describe(error)).toBe("escrow/Denied")
    expect(error.message).toBe("escrow/Denied")
    expect(SuiError.toJson(error)).toEqual({
      _tag: "escrow/Denied",
      rule: "spend",
      outcome: "not_applied",
      message: "escrow/Denied"
    })
  })

  test("as a cause of a house error", () => {
    const error = new SigningError({ cause: new EscrowDenied({ rule: "spend" }) })
    expect(SuiError.describe(error)).toBe("SigningError: escrow/Denied")
  })

  test("a getter that calls toJson terminates too", () => {
    class Logged extends Schema.TaggedError<Logged>()("escrow/Logged", {}) {
      override get message(): string {
        return JSON.stringify(SuiError.toJson(this))
      }
    }
    expect(neverThrows(new Logged())).toEqual(allOk)
  })
})

describe("toJson over awkward causes", () => {
  test("a SubmissionUnknown with a cyclic cause and a TransportError with a bigint cause", () => {
    const cause: Record<string, unknown> = { a: 1 }
    cause["self"] = cause
    expect(neverThrows(new SubmissionUnknown({ digest: DIGEST, cause }))).toEqual(allOk)
    expect(neverThrows(new TransportError({ method: "m", retryable: false, cause: { n: 1n } }))).toEqual(allOk)
  })
})

class Probe extends Context.Service<Probe, {
  readonly find: (key: string) => Effect.Effect<string>
  readonly coupons: {
    readonly apply: (code: string) => Effect.Effect<string>
    readonly call: (code: string) => Effect.Effect<string>
    readonly bind: (code: string) => Effect.Effect<string>
  }
}>()("review/Probe") {}

let built = 0
let released = 0
const probeLayer: Layer.Layer<Probe, never, Sui> = Layer.effect(
  Probe,
  Effect.gen(function*() {
    yield* Sui
    built += 1
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        released += 1
      })
    )
    return {
      find: (key: string) => Effect.succeed(`found ${key}`),
      coupons: {
        apply: (code: string) => Effect.succeed(`applied ${code}`),
        call: (code: string) => Effect.succeed(`called ${code}`),
        bind: (code: string) => Effect.succeed(`bound ${code}`)
      }
    }
  })
)

const probe = (warm?: { readonly chainId: string }) =>
  SuiExtension.fromService(Probe, {
    name: "probe",
    layer: probeLayer,
    ...(warm === undefined ? {} : { warm })
  })

/** Whether `p` settles within `ms`, and how. */
const settles = <A>(p: PromiseLike<A>, ms = 300) =>
  Promise.race([
    Promise.resolve(p).then(() => "resolved", () => "rejected"),
    new Promise<string>((resolve) => setTimeout(() => resolve("pending"), ms))
  ])

describe("the cold Promise face", () => {
  test("awaiting the face itself settles, and builds nothing", async () => {
    built = 0
    const face = probe().register(fakeClient())
    expect(await settles(Promise.resolve(face))).toBe("resolved")
    expect(await settles((async () => face)())).toBe("resolved")
    expect(built).toBe(0)
    await face.$dispose()
  })

  test("awaiting a cold namespace settles rather than hanging", async () => {
    const face = probe().register(fakeClient())
    expect(await settles(Promise.resolve(face.coupons))).not.toBe("pending")
    await face.$dispose()
  })

  test("a cold Effect member works through call, apply and bind", async () => {
    const face = probe().register(fakeClient())
    expect(await face.find.call(null, "a")).toBe("found a")
    expect(await face.find.apply(null, ["b"])).toBe("found b")
    const bound = face.find.bind(null, "c")
    expect(typeof bound).toBe("function")
    expect(await bound()).toBe("found c")
    // A bound function that takes the rest of its arguments later.
    expect(await face.find.bind(null)("d")).toBe("found d")
    await face.$dispose()
  })

  test("a namespace member named apply, call or bind is still that member", async () => {
    const face = probe().register(fakeClient())
    expect(await face.coupons.apply("X")).toBe("applied X")
    expect(await face.coupons.call("Y")).toBe("called Y")
    expect(await face.coupons.bind("Z")).toBe("bound Z")
    await face.$dispose()
  })

  test("call, apply and bind behave the same once warm", async () => {
    const face = probe().register(fakeClient())
    await face.$ready()
    expect(await face.find.call(null, "a")).toBe("found a")
    expect(await face.find.apply(null, ["b"])).toBe("found b")
    expect(await face.find.bind(null, "c")()).toBe("found c")
    expect(await face.coupons.apply("X")).toBe("applied X")
    await face.$dispose()
  })

  test("'prototype' in a cold call answers instead of breaking a Proxy invariant", async () => {
    const face = probe().register(fakeClient())
    const cold = face.find("here")
    expect(typeof ("prototype" in (cold as object))).toBe("boolean")
    expect(await cold).toBe("found here")
    await face.$dispose()
  })
})

describe("a warm registration after $dispose", () => {
  for (const use of ["$ready", "$reconcileAll"] as const) {
    test(`${use} then a member read builds one runtime, and every build is released`, async () => {
      built = 0
      released = 0
      const face = probe({ chainId: CHAIN_ID }).register(fakeClient())
      expect(built).toBe(1)
      await face.$dispose()
      expect(released).toBe(1)
      await face[use]()
      expect(await face.find("here")).toBe("found here")
      await face.$dispose()
      expect({ built, released }).toEqual({ built: 2, released: 2 })
    })
  }
})
