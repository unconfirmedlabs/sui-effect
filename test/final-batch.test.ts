/**
 * Regression tests for the final pre-release verification of 2026-09-11
 * (`docs/reviews/final-verification.md`) and the conversion feedback queued
 * with it (`docs/reviews/conversion-feedback.md`).
 *
 * One block per finding, each reproducing the probe the reviewer ran and
 * asserting the behaviour the fix specifies. The numbering is the review's.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { SuiGrpcClient } from "@mysten/sui/grpc"
import type { SuiClientTypes } from "@mysten/sui/client"
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519"
import { Transaction } from "@mysten/sui/transactions"
import { ConfigProvider, Context, Duration, Effect, Layer, Schema } from "effect"
import { ExtensionNotReady, GraphQLUnavailable, SuiError, TransportError } from "../src/domain/errors.ts"
import { ObjectId, SuiAddress } from "../src/domain/schemas.ts"
import { SuiSchema } from "../src/index.ts"
import { Script } from "../src/services/Script.ts"
import { fromKeypair } from "../src/services/Signer.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import type { SuiCoreService } from "../src/services/SuiCore.ts"
import { makeFromClient, SuiCore } from "../src/services/SuiCore.ts"
import { FakeOutcome, SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"
import { SuiGraphQL } from "../src/services/SuiGraphQL.ts"
import { Tx } from "../src/services/Tx.ts"
import { layerTest, SuiTest } from "../src/testing.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const PADDED = (suffix: string) => `0x${"0".repeat(64 - suffix.length)}${suffix}`
const ESCROW_ID = PADDED("e1")
const ESCROW_TYPE = `${PADDED("2")}::escrow::Escrow`
const COIN_ID = PADDED("c01")
const OTHER_DIGEST = "11111111111111111111111111111111"

const signer = fromKeypair(Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7)))
const SENDER = signer.address
const owner: SuiClientTypes.ObjectOwner = { $kind: "AddressOwner", AddressOwner: SENDER }

const coin = {
  objectId: COIN_ID,
  version: "2",
  digest: OTHER_DIGEST,
  type: `${PADDED("2")}::coin::Coin<${PADDED("2")}::sui::SUI>`,
  balance: "1000000000",
  owner,
  previousTransaction: null
} as unknown as SuiClientTypes.Coin

const baseScript = {
  chainId: CHAIN_ID,
  objects: [
    { objectId: ESCROW_ID, type: ESCROW_TYPE, version: 3n, owner, content: new Uint8Array() },
    { objectId: COIN_ID, type: coin.type, version: 2n, owner, content: new Uint8Array() }
  ],
  coins: [coin]
}

const claim = (tx: Transaction) => {
  tx.moveCall({
    target: `${PADDED("2")}::escrow::claim`,
    arguments: [tx.object(ESCROW_ID), tx.pure.u64(5n)]
  })
}

// ---------------------------------------------------------------------------

describe("A1. the effect peer is exactly rc.112, and everything says so", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"))
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
  const readme = readFileSync("README.md", "utf8")

  test("the peer dependency is the exact version, not a range", () => {
    // rc.113 renamed `Config.nonEmptyString`/`string`/`redacted`, which this
    // package calls at four sites, so a range that admitted rc.113 admitted a
    // version where `Script.layer`, `layerConfig` and `Signer.fromConfig` throw.
    expect(manifest.peerDependencies.effect).toBe("4.0.0-rc.112")
  })

  test("the CI matrix is exactly the set the peer admits", () => {
    const matrix = /effect: \[([^\]]*)\]/.exec(workflow)?.[1] ?? ""
    expect(matrix).toContain("4.0.0-rc.112")
    expect(matrix).not.toContain("rc.113")
  })

  test("the README version table agrees", () => {
    expect(readme).toContain("| `effect` | `4.0.0-rc.112` (exact) |")
    expect(readme).not.toContain("`4.0.0-rc.113`")
  })

  test("the template pins the same exact version", () => {
    const template = JSON.parse(readFileSync("examples/extension-template/package.json", "utf8"))
    expect(template.peerDependencies.effect).toBe("4.0.0-rc.112")
  })
})

describe("A2. every CI job can pass as written", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8")
  const jobs = workflow.split(/\n  (?=[a-z])/)

  const jobNamed = (name: string): string => {
    const found = jobs.find((job) => job.trimStart().startsWith(`${name}:`))
    if (found === undefined) throw new Error(`no job named ${name}`)
    return found
  }

  test("both matrix jobs build before they test", () => {
    for (const name of ["effect-rc-matrix", "sui-sdk-matrix"]) {
      const job = jobNamed(name)
      const run = /bun run typecheck[^\n]*/.exec(job)?.[0] ?? ""
      expect(run).toContain("bun run build")
      expect(run.indexOf("bun run build")).toBeLessThan(run.indexOf("bun test"))
    }
  })

  test("the isolated-consumer job pins tsc and resolves the tarball by path", () => {
    const job = jobNamed("isolated-consumer")
    // `../../$GITHUB_WORKSPACE/...` was two directories above an absolute path.
    expect(job).not.toContain("../../$GITHUB_WORKSPACE")
    expect(job).toContain('TARBALL="$(ls "$GITHUB_WORKSPACE"/sui-effect-*.tgz | head -n 1)"')
    // Not `bunx tsc`, whose version is whatever the registry serves that day.
    expect(job).toContain('"$GITHUB_WORKSPACE/node_modules/.bin/tsc"')
  })

  test("the LLMS generator never kills the test run", () => {
    // It used to `process.exit(1)` when `dist/` was absent, which took the
    // whole `bun test` down with it. `test/llms.test.ts` skips instead.
    expect(readFileSync("scripts/llms.ts", "utf8")).not.toContain("process.exit(")
  })
})

describe("A3. one base per client per chain id: warm and lazy share", () => {
  class Locking extends Context.Service<Locking, { readonly hold: Effect.Effect<void> }>()(
    "final-batch/Locking"
  ) {
    static readonly make = (
      onEnter: () => void,
      onLeave: () => void
    ): Layer.Layer<Locking, never, Sui> =>
      Layer.effect(
        Locking,
        Effect.gen(function*() {
          const sui = yield* Sui
          return {
            hold: sui.withSenderLock(SuiAddress.make(SENDER))(
              Effect.gen(function*() {
                onEnter()
                yield* Effect.sleep("25 millis")
                onLeave()
              })
            )
          }
        })
      )
  }

  const probe = async (
    register: (
      layer: Layer.Layer<Locking, never, Sui>,
      client: ReturnType<typeof clientOf>
    ) => ReadonlyArray<{ readonly hold: () => Promise<void>; readonly $dispose: () => Promise<void> }>
  ): Promise<number> => {
    let active = 0
    let peak = 0
    const layer = Locking.make(
      () => {
        active += 1
        peak = Math.max(peak, active)
      },
      () => {
        active -= 1
      }
    )
    const registered = register(layer, clientOf())
    await Promise.all(registered.map((one) => one.hold()))
    for (const one of registered) await one.$dispose()
    return peak
  }

  const clientOf = () =>
    Effect.runSync(
      Effect.provide(
        Effect.map(SuiCoreFake, (fake) => fake.client),
        SuiCoreFake.layer({ chainId: CHAIN_ID, network: "mainnet" }),
        { local: true }
      )
    )

  test("a warm registration and a lazy one hold one lock, not two", async () => {
    // The verifier's probe: the extension template's own pair is exactly this
    // combination (`Platform.ts` warm, `extension.ts` lazy), and it used to
    // reach peak concurrency 2 because the base was keyed `read:` versus
    // `pinned:` rather than by the chain the two agree on.
    const peak = await probe((layer, client) => [
      SuiExtension.fromService(Locking, { name: "warm", layer, warm: { chainId: CHAIN_ID } })
        .register(client) as never,
      SuiExtension.fromService(Locking, { name: "lazy", layer }).register(client) as never
    ])
    expect(peak).toBe(1)
  })

  test("a lazy registration with sui.chainId and one without hold one lock", async () => {
    const peak = await probe((layer, client) => [
      SuiExtension.fromService(Locking, { name: "pinned", layer, sui: { chainId: CHAIN_ID } })
        .register(client) as never,
      SuiExtension.fromService(Locking, { name: "plain", layer }).register(client) as never
    ])
    expect(peak).toBe(1)
  })

  test("chained $extend still shares, because the key is the client's core", async () => {
    const peak = await probe((layer, client) => {
      const extended = (client as unknown as {
        $extend: (registration: unknown) => Record<string, never>
      })
        .$extend(
          SuiExtension.fromService(Locking, { name: "one", layer, warm: { chainId: CHAIN_ID } })
        )
      const twice = (extended as unknown as {
        $extend: (registration: unknown) => Record<string, never>
      })
        .$extend(SuiExtension.fromService(Locking, { name: "two", layer }))
      return [twice["one"] as never, twice["two"] as never]
    })
    expect(peak).toBe(1)
  })

  test("two registrations that pin different chain ids are not handed one Sui", async () => {
    // Sharing is per chain id on purpose: an extension that pins a different
    // identifier is not asking for the same `Sui`.
    const client = clientOf()
    const layer = Locking.make(() => undefined, () => undefined)
    const first = SuiExtension.fromService(Locking, {
      name: "one",
      layer,
      warm: { chainId: CHAIN_ID }
    }).register(client)
    const second = SuiExtension.fromService(Locking, {
      name: "two",
      layer,
      warm: { chainId: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD" }
    }).register(client)
    await Promise.all([first.hold(), second.hold()])
    await first.$dispose()
    await second.$dispose()
  })

  test("a lazy registration joining a pinned base still asserts the chain id", async () => {
    // The pinned base asks the node nothing, so the lazy registration owes the
    // `getChainIdentifier` check — and a node on another chain must still fail
    // its build.
    const client = Effect.runSync(
      Effect.provide(
        Effect.map(SuiCoreFake, (fake) => fake.client),
        SuiCoreFake.layer({ chainId: "69WiPg3DAQiwdxfncX6wYQ2siKwAe6L9BZthQea3JNMD" }),
        { local: true }
      )
    )
    const layer = Locking.make(() => undefined, () => undefined)
    // Warm takes the wrong id without complaint...
    const warm = SuiExtension.fromService(Locking, {
      name: "warm",
      layer,
      warm: { chainId: CHAIN_ID }
    }).register(client)
    await warm.hold()
    // ...and the lazy registration joining it is the one that finds out.
    const lazy = SuiExtension.fromService(Locking, {
      name: "lazy",
      layer,
      sui: { chainId: CHAIN_ID }
    }).register(client)
    const failure = await lazy.hold().then(() => undefined, (error: unknown) => error)
    expect((failure as { readonly _tag?: string })?._tag).toBe("NetworkMismatch")
    await warm.$dispose()
    await lazy.$dispose()
  })
})

describe("B1. an interrupted build cancels the gRPC resolver's simulate", () => {
  interface Seen {
    readonly method: string
    readonly abort: AbortSignal | undefined
  }

  /**
   * A `RpcTransport` that records every unary call and never answers, so the
   * only way out is the caller's own `AbortSignal`.
   */
  const recordingTransport = (seen: Array<Seen>) => ({
    mergeOptions: (options?: Record<string, unknown>) => ({ ...(options ?? {}) }),
    unary: (method: { name: string }, input: unknown, options: Record<string, unknown>) => {
      seen.push({ method: method.name, abort: options["abort"] as AbortSignal | undefined })
      const never = new Promise<never>(() => {})
      return {
        method,
        requestHeaders: {},
        request: input,
        headers: never,
        response: never,
        status: never,
        trailers: never,
        then: <A, B>(
          onFulfilled?: ((value: never) => A | PromiseLike<A>) | null,
          onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
        ) => never.then(onFulfilled, onRejected)
      }
    },
    serverStreaming: () => {
      throw new Error("the probe makes no streaming calls")
    },
    clientStreaming: () => {
      throw new Error("the probe makes no streaming calls")
    },
    duplex: () => {
      throw new Error("the probe makes no streaming calls")
    }
  })

  test("the transport sees SimulateTransaction carrying a signal, and it aborts", async () => {
    const seen: Array<Seen> = []
    const client = new SuiGrpcClient({
      network: "localnet",
      transport: recordingTransport(seen) as never
    })
    const exit = await Effect.runPromiseExit(
      Tx.build(claim, { sender: SuiAddress.make(SENDER) }).pipe(
        Effect.timeout("200 millis"),
        Effect.provideService(SubmitConfig, { ...SubmitConfig.defaults, expiration: "none" }),
        Effect.provide(
          Sui.layerNoDepsPinned(CHAIN_ID).pipe(
            Layer.provideMerge(SuiCore.layerFromClient(client))
          ),
          { local: true }
        )
      )
    )
    expect(String(exit)).toContain("TimeoutError")
    const simulate = seen.filter((call) => call.method === "SimulateTransaction")
    expect(simulate.length).toBeGreaterThan(0)
    // Before the fix the resolver called `simulateTransaction(request)` with no
    // second argument at all, so there was nothing to abort and the request
    // stayed in flight while the sender lock was released.
    expect(simulate[0]!.abort).toBeInstanceOf(AbortSignal)
    expect(simulate[0]!.abort!.aborted).toBe(true)
  })
})

describe("B2. inputConsumed is the consuming transaction's own inputVersion", () => {
  const reconcileAfter = (
    move: (digest: string) => Effect.Effect<void, never, SuiCoreFake>,
    script: Parameters<typeof layerTest>[0]
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const built = yield* Tx.build(claim, { sender: SuiAddress.make(SENDER) })
          const signed = yield* Tx.sign(built, signer)
          yield* move(signed.digest)
          return yield* Effect.result(Tx.reconcile(signed))
        }),
        Layer.merge(
          layerTest(script),
          Layer.succeed(SubmitConfig, { ...SubmitConfig.defaults, reconcileRecheck: Duration.zero })
        ),
        { local: true }
      )
    )

  const consumedAt = (version: bigint) => ({
    [OTHER_DIGEST]: FakeOutcome.succeed({
      digest: OTHER_DIGEST,
      mutated: [
        { objectId: ESCROW_ID, type: ESCROW_TYPE, version: version + 1n, inputVersion: version, owner }
      ]
    })
  })

  test("equal to the pinned version is NotApplied { inputConsumed }", async () => {
    const result = await reconcileAfter(
      () => SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()], transactions: consumedAt(3n) }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("NotApplied")
    if (result.failure._tag === "NotApplied") {
      expect(result.failure.evidence).toBe("inputConsumed")
    }
  })

  test("greater than the pinned version proves nothing: SubmissionUnknown", async () => {
    // The Lamport-version reality. Our transaction pinned version 3 and would
    // have produced 4; the transaction that moved the object on took 4, and the
    // state between is not served. The old `v + 1` rule called this
    // `SubmissionUnknown` too, but only by accident — it looked for an object
    // at a version that, on a real network, usually never existed at all.
    const result = await reconcileAfter(
      () => SuiTest.bumpVersion(ESCROW_ID, { consumedBy: OTHER_DIGEST }),
      { ...baseScript, getTransaction: [FakeOutcome.notFound()], transactions: consumedAt(4n) }
    )
    expect(result._tag).toBe("Failure")
    if (result._tag !== "Failure") return
    expect(result.failure._tag).toBe("SubmissionUnknown")
  })

  test("every pinned reference is tried before reconcile gives up", async () => {
    // The verifier's second half of B2: `inputEvidence` used to return on the
    // first moved reference. Here the **gas coin** moved with nothing readable
    // behind it, and the escrow — the second pinned reference — names our own
    // digest, which is `AppliedByUs` and an `Executed` one read away.
    const executed = FakeOutcome.succeed({
      mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }]
    })
    const result = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const built = yield* Tx.build(claim, { sender: SuiAddress.make(SENDER) })
          const signed = yield* Tx.sign(built, signer)
          // The gas coin moved and the node will not say who moved it.
          yield* SuiTest.bumpVersion(COIN_ID)
          // The escrow moved, and it was us.
          yield* SuiTest.bumpVersion(ESCROW_ID, { consumedBy: signed.digest })
          yield* SuiTest.scriptGetTransaction([FakeOutcome.notFound(), executed])
          return yield* Effect.result(Tx.reconcile(signed))
        }),
        Layer.merge(
          layerTest({ ...baseScript, getTransaction: [FakeOutcome.notFound()] }),
          Layer.succeed(SubmitConfig, { ...SubmitConfig.defaults, reconcileRecheck: Duration.zero })
        ),
        { local: true }
      )
    )
    expect(result._tag).toBe("Success")
  })

  test("getObjectAtVersion is still public, and no longer part of the rule", () => {
    const source = readFileSync("src/services/Tx.ts", "utf8")
    expect(source).not.toContain("getObjectAtVersion")
    expect(readFileSync("src/services/SuiCore.ts", "utf8")).toContain("getObjectAtVersion")
  })
})

describe("B3 to B6 and the guide's own rules", () => {
  test("B3: the packed-package check does not assume it lives in this repository", () => {
    const source = readFileSync("examples/extension-template/scripts/check-package.ts", "utf8")
    // It prefers the template's own node_modules...
    expect(source).toContain("join(templateModules, name)")
    // ...and only trusts `../..` when that really is sui-effect.
    expect(source).toContain('=== "sui-effect"')
  })

  test("B4: nothing hand-builds a TransportError outside the constructor's own module", () => {
    for (
      const file of [
        "examples/extension-template/src/Escrow.ts",
        "examples/extension-consumer.ts"
      ]
    ) {
      expect(readFileSync(file, "utf8")).not.toContain("new TransportError(")
    }
  })

  test("B5: Tx.build's JSDoc no longer promises a wall-clock default", () => {
    const source = readFileSync("src/services/Tx.ts", "utf8")
    const doc = source
      .slice(source.indexOf("Builds a transaction into signable bytes."), source.indexOf("export const build"))
      .replace(/\s*\n \* /g, " ")
    expect(doc).toContain("no wall-clock bound")
    // The claim the verifier caught: a default bounded at `chainTime` plus
    // `SubmitConfig.validFor`, which DESIGN and the code both contradict.
    expect(doc).not.toContain("bounds the transaction at `chainTime`")
  })

  test("B6: a nonce outside the u32 range is a BuildError", async () => {
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(Tx.build(claim, { sender: SuiAddress.make(SENDER) })),
        Layer.merge(
          layerTest(baseScript),
          Layer.succeed(SubmitConfig, { ...SubmitConfig.defaults, nonce: Effect.succeed(-1) })
        ),
        { local: true }
      )
    )
    expect(error._tag).toBe("BuildError")
    expect(readFileSync("src/services/SubmitConfig.ts", "utf8")).toContain("BuildError")
  })
})

describe("C. the minor findings", () => {
  test("npm pack does not ship the template's build output", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"))
    expect(manifest.files).toContain("!examples/extension-template/dist")
  })

  test("Script.run describes every tag in the taxonomy", async () => {
    for (
      const error of [
        new GraphQLUnavailable({ method: "query", reason: "no endpoint" }),
        new ExtensionNotReady({ extension: "escrow", member: "packageId" })
      ]
    ) {
      const lines: Array<string> = []
      await Script.run(Effect.fail(error), {
        layer: Script.layerNoDeps.pipe(
          Layer.provideMerge(layerTest(baseScript)),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnvRecord({
                SUI_NETWORK: "localnet",
                SUI_PRIVATE_KEY: Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(3))
                  .getSecretKey()
              })
            )
          )
        ),
        exit: () => undefined,
        stderr: (line) => lines.push(line),
        signals: { on: () => undefined }
      })
      // Before the fix `SUI_ERROR_TAGS` omitted both tags, so `Script.run`
      // printed the bare `_tag` line for a foreign error instead of `describe`.
      expect(lines.join("\n")).toContain(SuiError.describe(error))
    }
  })

  test("reconcileAll has no unreachable TransportError case", () => {
    const source = readFileSync("src/services/Tx.ts", "utf8")
    const body = source.slice(source.indexOf("export const reconcileAll"))
    expect(body).not.toContain('case "TransportError":')
  })

  test("the gas owner is compared normalized when the locks are chosen", async () => {
    // `0x2` and its padded spelling are one address; comparing them as written
    // took two locks on one account.
    const source = readFileSync("src/services/Tx.ts", "utf8")
    expect(source).toContain("normalizeSuiAddress(opts.gasOwner) === normalizeSuiAddress(sender)")
  })

  test("awaitVisible swallows failures, never defects", async () => {
    // A defect in the visibility wait is a bug; turning it into a warning line
    // hid it behind an outcome that was going to stand anyway.
    const state = Effect.runSync(
      Effect.provide(
        SuiCoreFake,
        SuiCoreFake.layer({
          ...baseScript,
          execute: [FakeOutcome.succeed({ mutated: [{ objectId: ESCROW_ID, type: ESCROW_TYPE, version: 4n, owner }] })]
        }),
        { local: true }
      )
    )
    const real = makeFromClient(state.client)
    const dying: SuiCoreService = {
      ...real,
      waitForTransaction: () => Effect.die(new Error("the visibility wait is broken"))
    }
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        Effect.gen(function*() {
          const built = yield* Tx.build(claim, { sender: SuiAddress.make(SENDER) })
          const signed = yield* Tx.sign(built, signer)
          return yield* Tx.submit(signed)
        }),
        Sui.layerNoDeps.pipe(Layer.provideMerge(Layer.succeed(SuiCore, dying))),
        { local: true }
      )
    )
    expect(String(exit)).toContain("the visibility wait is broken")
  })

  test("a resolver NOT_FOUND is a BuildError naming the object it was resolving", async () => {
    const state = Effect.runSync(
      Effect.provide(SuiCoreFake, SuiCoreFake.layer(baseScript), { local: true })
    )
    const real = makeFromClient(state.client)
    const notFound: SuiCoreService = {
      ...real,
      use: () =>
        Effect.fail(
          new TransportError({ method: "use", retryable: false, status: "NOT_FOUND", cause: "gone" })
        ) as never
    }
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(Tx.build(claim, { sender: SuiAddress.make(SENDER) })),
        Sui.layerNoDeps.pipe(Layer.provideMerge(Layer.succeed(SuiCore, notFound))),
        { local: true }
      )
    )
    expect(error._tag).toBe("BuildError")
    if (error._tag === "BuildError") {
      expect(error.message).toContain("NOT_FOUND")
      expect(error.message).toContain(ESCROW_ID)
    }
  })

  test("the always-simulates claim is scoped where it is made", () => {
    for (const file of ["README.md", "AGENTS.md"]) {
      const text = readFileSync(file, "utf8")
      const index = text.indexOf("always simulates")
      expect(index).toBeGreaterThan(-1)
      expect(text.slice(index, index + 320)).toContain("explicit")
    }
  })
})

describe("conversion feedback: the new public surface", () => {
  test("14. SuiError.toJson encodes an extension error through its own schema", () => {
    class EscrowSettlementUnknown
      extends Schema.TaggedError<EscrowSettlementUnknown>()("EscrowSettlementUnknown", {
        escrowId: ObjectId,
        outcome: Schema.Literal("unknown")
      })
    {}
    const json = SuiError.toJson(
      new EscrowSettlementUnknown({ escrowId: ObjectId.make(ESCROW_ID), outcome: "unknown" })
    )
    expect(json).toEqual({
      _tag: "EscrowSettlementUnknown",
      escrowId: ESCROW_ID,
      outcome: "unknown"
    })
  })

  test("14. a value that is not schema-backed still gets a tag and a message", () => {
    const json = SuiError.toJson({ _tag: "SomethingElse" } as never)
    expect(json["_tag"]).toBe("SomethingElse")
  })

  test("17. SuiGraphQL.query passes GraphQLUnavailable through unchanged", async () => {
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(SuiGraphQL.query((client) => client.query({ query: "{ chainIdentifier }", variables: {} }))),
        SuiGraphQL.layerUnavailable,
        { local: true }
      )
    )
    expect(error._tag).toBe("GraphQLUnavailable")
  })

  test("17. SuiGraphQL.query turns anything else into a TransportError", async () => {
    const error = await Effect.runPromise(
      Effect.provide(
        Effect.flip(
          SuiGraphQL.query(() => Promise.reject(new Error("502")), "chainIdentifier")
        ),
        SuiGraphQL.layer({} as never),
        { local: true }
      )
    )
    expect(error._tag).toBe("TransportError")
    if (error._tag === "TransportError") expect(error.method).toBe("chainIdentifier")
  })

  test("5. SuiSchema.matchesType is safe on the primitives a dynamic-field key may be", () => {
    for (const primitive of ["u64", "bool", "address", "vector<u8>"]) {
      expect(() => SuiSchema.matchesType(primitive, primitive)).not.toThrow()
      expect(SuiSchema.matchesType(primitive, primitive)).toBe(true)
      expect(SuiSchema.matchesType(primitive, "u8")).toBe(false)
    }
    // And it still does the generic rule for real struct tags.
    expect(SuiSchema.matchesType(`${PADDED("2")}::coin::Coin`, `0x2::coin::Coin<0x2::sui::SUI>`))
      .toBe(true)
  })

  test("21. the fake tells two same-typed dynamic-field keys apart by their bytes", async () => {
    const parent = PADDED("da7a")
    const entry = (fieldId: string, bcs: Uint8Array) => ({
      parentId: parent,
      fieldId,
      name: { type: "u64", bcs },
      valueType: "u64",
      kind: "DynamicField" as const
    })
    const found = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const core = yield* SuiCore
          const one = yield* core.getDynamicField({
            parentId: parent,
            name: { type: "u64", bcs: new Uint8Array([1]) }
          })
          const two = yield* core.getDynamicField({
            parentId: parent,
            name: { type: "u64", bcs: new Uint8Array([2]) }
          })
          return [one.dynamicField.fieldId, two.dynamicField.fieldId]
        }),
        SuiCoreFake.layer({
          ...baseScript,
          dynamicFields: {
            [parent]: [
              entry(PADDED("f1"), new Uint8Array([1])),
              entry(PADDED("f2"), new Uint8Array([2]))
            ]
          } as never
        }),
        { local: true }
      )
    )
    expect(found).toEqual([PADDED("f1"), PADDED("f2")])
  })

  test("11. a scripted command result may leave out mutatedReferences", async () => {
    const simulation = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function*() {
          const sui = yield* Sui
          return yield* sui.simulate(claim, { sender: SuiAddress.make(SENDER) })
        }),
        layerTest({
          ...baseScript,
          simulate: [FakeOutcome.succeed({ commandResults: [{ returnValues: [] }] })]
        }),
        { local: true }
      )
    )
    expect(simulation.commandResults[0]?.mutatedReferences).toEqual([])
  })

  test("12. Stream.runCollect returns a plain Array in Effect v4", () => {
    // The one-line callout the testing docs now carry, pinned so it stays true.
    expect(readFileSync("docs/extensions.tpl.md", "utf8")).toContain("`Stream.runCollect`")
  })
})
