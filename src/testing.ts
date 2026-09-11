/**
 * `sui-effect/testing`: the in-memory fake, the test layers built on it, and
 * the harness an extension's own tests need.
 *
 * Nothing here touches the network. `layerTest` is the real `Sui` over the
 * fake `SuiCore`, so a test exercises the production high tier.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Option } from "effect"
import type { NetworkMismatch, TransportError } from "./domain/errors.ts"
import { Sui } from "./services/Sui.ts"
import type { SuiCore } from "./services/SuiCore.ts"
import type { FakeObject, FakeOutcome, FakeScript, RecordedCall } from "./services/SuiCoreFake.ts"
import { SuiCoreFake } from "./services/SuiCoreFake.ts"

export * from "./services/SuiCoreFake.ts"

/**
 * The real `Sui` over the fake `SuiCore`, plus the fake's own handle so a test
 * can script outcomes and inspect what the fake received.
 *
 * This is `Sui.layerNoDeps`, the production layer, so the chain-id rules are
 * the production rules: a script whose `network` is `mainnet` or `testnet` must
 * report that network's identifier, and any other network asserts nothing. A
 * test that wants the assertion on a custom network builds
 * `Sui.layerNoDepsWith({ chainId })` over `SuiCoreFake.layer(script)` itself,
 * rather than having the fake compared against its own script.
 *
 * Fails with: `NetworkMismatch`, `TransportError` — both only when the script
 * asks for them.
 */
export const layerTest = (
  script: FakeScript = {}
): Layer.Layer<Sui | SuiCore | SuiCoreFake, NetworkMismatch | TransportError> =>
  Sui.layerNoDeps.pipe(Layer.provideMerge(SuiCoreFake.layer(script)))

/**
 * An extension's own layer over {@link layerTest}, which is the whole wiring an
 * extension test needs.
 *
 * `layerTest` provides `Sui`, `SuiCore` and `SuiCoreFake`, and an extension's
 * `layerTest` (or `layer`, for an extension with no fake of its own) may
 * require `Sui | SuiCore` and nothing else — the same requirement
 * `SuiExtension.fromService` satisfies in production. So composing the two is
 * the recipe, and everything the extension's layer provides plus the fake's
 * handle comes out the other side.
 *
 * Fails with: whatever the extension's layer fails with, plus `NetworkMismatch`
 * and `TransportError` when the script asks for them.
 *
 * @example
 * ```ts
 * import { layerExtensionTest } from "sui-effect/testing"
 *
 * const layer = layerExtensionTest(Escrow.layerTest(), { objects: [escrow] })
 * ```
 */
export const layerExtensionTest = <Self, E>(
  layer: Layer.Layer<Self, E, Sui | SuiCore>,
  script: FakeScript = {}
): Layer.Layer<
  Self | Sui | SuiCore | SuiCoreFake,
  E | NetworkMismatch | TransportError
> => layer.pipe(Layer.provideMerge(layerTest(script)))

const withFake = <A>(f: (fake: SuiCoreFake["Service"]) => Effect.Effect<A>) =>
  Effect.flatMap(SuiCoreFake, f)

/** Inserts or replaces an object the fake serves. Never fails. */
const putObject = (object: FakeObject): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setObject(object))

/**
 * Moves an object to its next version, optionally with new content, and
 * answers with the version it now has.
 *
 * The direct way to make `Tx.reconcile` see an owned input as consumed, and to
 * stand in for a transaction the test did not run. Dies when the fake has no
 * such object: a test that bumps something that is not there is a broken test,
 * not a failing one.
 */
const bumpVersion = (
  objectId: string,
  opts?: { readonly content?: Uint8Array }
): Effect.Effect<bigint, never, SuiCoreFake> =>
  withFake((fake) =>
    Effect.flatMap(fake.readObject(objectId), (found) => {
      if (Option.isNone(found)) {
        return Effect.die(
          new Error(`SuiTest.bumpVersion: the fake serves no object ${objectId}`)
        )
      }
      const next = found.value.version + 1n
      return fake.setObject({
        ...found.value,
        version: next,
        ...(opts?.content === undefined ? {} : { content: opts.content })
      }).pipe(Effect.as(next))
    })
  )

/** Removes an object, so every later read reports it deleted. Never fails. */
const deleteObject = (objectId: string): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.deleteObject(objectId))

/**
 * Moves the Clock object `0x6`, which is what `Sui.chainTime` reads and
 * therefore what `Tx.build` bounds a transaction against. Effect's `TestClock`
 * drives the program's own time; this drives the chain's. Never fails.
 */
const setClock = (timestampMs: bigint): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setClock(timestampMs))

/**
 * Replaces the outcomes `executeTransaction` will produce, oldest first; the
 * last one repeats forever. Never fails.
 */
const scriptExecute = (
  outcomes: ReadonlyArray<FakeOutcome>
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setOutcomes("execute", outcomes))

/** The same for `simulateTransaction`. Never fails. */
const scriptSimulate = (
  outcomes: ReadonlyArray<FakeOutcome>
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setOutcomes("simulate", outcomes))

/** The same for `getTransaction`, which is what `Tx.reconcile` asks. Never fails. */
const scriptGetTransaction = (
  outcomes: ReadonlyArray<FakeOutcome>
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setOutcomes("getTransaction", outcomes))

/**
 * Every call the fake has received, oldest first, optionally only those of one
 * method.
 *
 * This is how a test asserts what the extension sent rather than only what it
 * got back: the include set on a read, the fact that a recipe fragment reached
 * exactly one `executeTransaction`, the absence of a call the extension should
 * have cached. Never fails.
 */
const calls = (
  method?: string
): Effect.Effect<ReadonlyArray<RecordedCall>, never, SuiCoreFake> =>
  withFake((fake) =>
    Effect.map(
      fake.calls,
      (recorded) => method === undefined ? recorded : recorded.filter((call) => call.method === method)
    )
  )

/**
 * The harness: everything an extension's tests need to drive the fake from
 * inside an Effect, without reaching for the `SuiCoreFake` handle by hand.
 *
 * Every member requires `SuiCoreFake`, which {@link layerTest} and
 * {@link layerExtensionTest} provide.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiTest } from "sui-effect/testing"
 *
 * const program = Effect.gen(function*() {
 *   yield* SuiTest.bumpVersion("0x…")
 *   const sent = yield* SuiTest.calls("executeTransaction")
 *   return sent.length
 * })
 * ```
 */
export const SuiTest = {
  putObject,
  bumpVersion,
  deleteObject,
  setClock,
  scriptExecute,
  scriptSimulate,
  scriptGetTransaction,
  calls
} as const
