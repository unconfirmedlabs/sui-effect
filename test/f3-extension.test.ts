/**
 * Fix round F3, the `SuiExtension` and `SubmitConfig` half: a cold recipe
 * builder is callable and throws `ExtensionNotReady` (ext#1), a cold value
 * placeholder does not pass for a value (ext#2), `Option` is `A | undefined`
 * on the Promise face (ext#3), one sender lock across registrations (ext#5),
 * `submit` / `journal` / `$reconcileAll` on a registration (ext#14), and
 * `SubmitConfig` durations and merging (indexer#11, F4b's note).
 */
import { describe, expect, test } from "bun:test"
import { Transaction } from "@mysten/sui/transactions"
import { Context, Deferred, Duration, Effect, Layer, Option } from "effect"
import { ExtensionNotReady } from "../src/domain/errors.ts"
import { Mist, SuiAddress } from "../src/domain/schemas.ts"
import type { JournalService } from "../src/services/Journal.ts"
import { Journal } from "../src/services/Journal.ts"
import { SubmitConfig } from "../src/services/SubmitConfig.ts"
import { Sui } from "../src/services/Sui.ts"
import { SuiCoreFake } from "../src/services/SuiCoreFake.ts"
import { SuiExtension } from "../src/services/SuiExtension.ts"

const CHAIN_ID = "4btiuiMPvEENsttpZC7CZ53DruC3MAgfznDbASZ7DR6S"
const ADDRESS = SuiAddress.normalize("0xa11ce")

const fakeClient = (network = "localnet") =>
  Effect.runSync(
    Effect.provide(SuiCoreFake, SuiCoreFake.layer({ chainId: CHAIN_ID, network }), { local: true })
  ).client

class Probe extends Context.Service<Probe, {
  readonly packageId: string
  readonly tx: { readonly create: (name: string) => (tx: Transaction) => void }
  readonly find: (key: string) => Effect.Effect<Option.Option<string>>
  readonly maxGasBudget: Effect.Effect<Mist>
  readonly executeTimeout: Effect.Effect<number>
  readonly journal: Effect.Effect<JournalService>
  readonly hold: (label: string, release: Deferred.Deferred<void>) => Effect.Effect<void>
}>()("f3/Probe") {}

const log: Array<string> = []

/** The config in force, as an `Effect` to pipe. */
const currentConfig = Effect.map(SubmitConfig, (config) => ({ ...config }))
const currentJournal = Effect.map(Journal, (journal) => journal)

const probeLayer: Layer.Layer<Probe, never, Sui> = Layer.effect(
  Probe,
  Effect.gen(function*() {
    const sui = yield* Sui
    return {
      packageId: "0xabc",
      tx: {
        create: (name: string) => (tx: Transaction) => {
          tx.moveCall({ target: `0xabc::probe::${name}` })
        }
      },
      find: (key: string) => Effect.succeed(key === "here" ? Option.some("found") : Option.none()),
      maxGasBudget: Effect.map(currentConfig, (config) => config.maxGasBudget),
      executeTimeout: Effect.map(
        currentConfig,
        (config) => Duration.toMillis(config.executeTimeout)
      ),
      journal: currentJournal,
      hold: (label: string, release: Deferred.Deferred<void>) =>
        sui.withSenderLock(ADDRESS)(
          Effect.gen(function*() {
            log.push(`${label}:in`)
            yield* Deferred.await(release)
            log.push(`${label}:out`)
          })
        )
    }
  })
)

const probe = (options: Partial<Parameters<typeof SuiExtension.fromService<Probe, Probe["Service"], never, "probe">>[1]> = {}) =>
  SuiExtension.fromService(Probe, { name: "probe", layer: probeLayer, ...options })

describe("ext#1: a cold recipe builder", () => {
  test("is callable, and applying it throws ExtensionNotReady naming the member", async () => {
    const face = probe().register(fakeClient())
    const recipe = face.tx.create("x")
    expect(typeof recipe).toBe("function")
    let thrown: unknown
    try {
      recipe(new Transaction())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ExtensionNotReady)
    expect((thrown as ExtensionNotReady).member).toBe("tx.create")
    await face.$dispose()
  })

  test("is still the real Promise of the cold call: instanceof, await, iteration", async () => {
    const face = probe().register(fakeClient())
    const cold = face.find("here")
    expect(cold).toBeInstanceOf(Promise)
    expect(await cold).toBe("found")
    await face.$dispose()
  })

  test("once ready, the builder is the real one", async () => {
    const face = probe().register(fakeClient())
    await face.$ready()
    const tx = new Transaction()
    face.tx.create("y")(tx)
    expect(tx.getData().commands).toHaveLength(1)
    await face.$dispose()
  })
})

describe("ext#2: a cold value placeholder does not pass for a value", () => {
  test("names only a value has throw ExtensionNotReady naming the value", async () => {
    const face = probe().register(fakeClient())
    const id = face.packageId
    for (const use of [() => id.length, () => id.startsWith("0x"), () => id.toString(), () => [...id]]) {
      let thrown: unknown
      try {
        use()
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(ExtensionNotReady)
      expect((thrown as ExtensionNotReady).member).toBe("packageId")
    }
    await face.$dispose()
  })

  test("console.log shows what it is", async () => {
    const face = probe().register(fakeClient())
    expect(Bun.inspect(face.packageId)).toContain("ExtensionNotReady probe.packageId")
    await face.$dispose()
  })
})

describe("ext#3: Option at the Promise boundary", () => {
  test("Effect<Option<A>> is Promise<A | undefined>, in the type and at runtime", async () => {
    const face = probe().register(fakeClient())
    const some: Promise<string | undefined> = face.find("here")
    const none: Promise<string | undefined> = face.find("gone")
    expect(await some).toBe("found")
    expect(await none).toBeUndefined()
    await face.$dispose()
  })
})

describe("ext#5: one sender lock across registrations", () => {
  test("a warm registration and a lazy one on different keys serialize one address", async () => {
    log.length = 0
    const client = fakeClient()
    const warm = probe({ warm: { chainId: CHAIN_ID } }).register(client)
    // Lazy on localnet with no chain id: a *different* shared base ("read").
    const lazy = SuiExtension.fromService(Probe, { name: "probe", layer: probeLayer }).register(client)
    const first = Effect.runSync(Deferred.make<void>())
    const second = Effect.runSync(Deferred.make<void>())
    const a = warm.hold("a", first)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const b = lazy.hold("b", second)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // `b` is waiting for the lock `a` holds.
    expect(log).toEqual(["a:in"])
    Effect.runSync(Deferred.succeed(first, undefined))
    await a
    Effect.runSync(Deferred.succeed(second, undefined))
    await b
    expect(log).toEqual(["a:in", "a:out", "b:in", "b:out"])
    await Promise.all([warm.$dispose(), lazy.$dispose()])
  })

  test("two clients share the lock too", async () => {
    log.length = 0
    const one = probe().register(fakeClient())
    const two = probe().register(fakeClient())
    const first = Effect.runSync(Deferred.make<void>())
    const second = Effect.runSync(Deferred.make<void>())
    const a = one.hold("a", first)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const b = two.hold("b", second)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(log).toEqual(["a:in"])
    Effect.runSync(Deferred.succeed(first, undefined))
    Effect.runSync(Deferred.succeed(second, undefined))
    await Promise.all([a, b])
    expect(log).toEqual(["a:in", "a:out", "b:in", "b:out"])
    await Promise.all([one.$dispose(), two.$dispose()])
  })
})

describe("ext#14: submit, journal and $reconcileAll on a registration", () => {
  test("submit overrides are in force for every call; durations take Duration.Input", async () => {
    const face = probe({
      submit: { maxGasBudget: Mist.make(7n), executeTimeout: "3 seconds" }
    }).register(fakeClient())
    expect(await face.maxGasBudget()).toBe(Mist.make(7n))
    expect(await face.executeTimeout()).toBe(3000)
    await face.$dispose()
  })

  test("the journal given is the journal calls see, and $reconcileAll reads it", async () => {
    const journal = Journal.makeMemoryUnsafe()
    const face = probe({ journal }).register(fakeClient())
    expect(await face.journal()).toBe(journal)
    expect(await face.$reconcileAll()).toEqual([])
    expect("$reconcileAll" in face).toBe(true)
    await face.$dispose()
  })
})

describe("SubmitConfig", () => {
  test("with merges over the config in force, not over the defaults", async () => {
    const config = await Effect.runPromise(
      currentConfig.pipe(
        SubmitConfig.with({ executeTimeout: "2 seconds" }),
        Effect.provide(SubmitConfig.layer({ resubmitAttempts: 9 }))
      )
    )
    expect(config.resubmitAttempts).toBe(9)
    expect(Duration.toMillis(config.executeTimeout)).toBe(2000)
  })

  test("nested withs compose", async () => {
    const config = await Effect.runPromise(
      currentConfig.pipe(
        SubmitConfig.with({ reconcileRecheck: 0 }),
        SubmitConfig.with({ resubmitAttempts: 2 })
      )
    )
    expect(config.resubmitAttempts).toBe(2)
    expect(Duration.toMillis(config.reconcileRecheck)).toBe(0)
    expect(config.maxGasBudget).toBe(SubmitConfig.defaults.maxGasBudget)
  })
})
