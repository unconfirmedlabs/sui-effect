/**
 * `sui-effect/testing`: the in-memory fake, the test layers built on it, and
 * the harness an extension's own tests need.
 *
 * Nothing here touches the network. `layerTest` is the real `Sui` over the
 * fake `SuiCore`, so a test exercises the production high tier.
 *
 * @since 0.1.0
 */
import { Effect, Layer, Option, Schedule } from "effect"
import { TestClock } from "effect/testing"
import type { NetworkMismatch, TransportError } from "./domain/errors.ts"
import { Journal } from "./services/Journal.ts"
import { SubmitConfig } from "./services/SubmitConfig.ts"
import { Sui } from "./services/Sui.ts"
import { SuiGraphQL } from "./services/SuiGraphQL.ts"
import type { SuiCore } from "./services/SuiCore.ts"
import type { FakeObject, FakeOutcome, FakeScript, RecordedCall } from "./services/SuiCoreFake.ts"
import { SuiCoreFake } from "./services/SuiCoreFake.ts"

export * from "./services/SuiCoreFake.ts"

/**
 * The lifecycle settings every test layer puts in force: `SubmitConfig.defaults`
 * with the re-send schedule a fake has no use for taken out: re-sends of
 * identical bytes follow each other with no delay (still `resubmitAttempts` of
 * them), so a test that drives a `SubmissionUnknown` takes milliseconds on the
 * real clock — it took seconds on the production schedule — and needs no
 * `TestClock.adjust` for the re-sends. Everything else — the execute timeout,
 * the expiry recheck, the visibility timeout, the gas ceiling — is the
 * production default.
 *
 * A test that is *about* one of these sets it with `SubmitConfig.with`.
 *
 * @since 0.4.0
 */
export const testSubmitConfig: Partial<typeof SubmitConfig.defaults> = {
  resubmit: Schedule.forever
}

/**
 * What {@link layerTest} provides, under one name: `Sui`, `SuiCore` and the
 * fake's handle, `SuiCoreFake`. A test helper that runs programs against the
 * fake takes `Effect.Effect<A, E, TestServices>` instead of spelling the union
 * out (an extension test adds its own service: `TestServices | Escrow`).
 *
 * @since 0.5.0
 */
export type TestServices = Sui | SuiCore | SuiCoreFake

/**
 * The real `Sui` over the fake `SuiCore`, plus the fake's own handle so a test
 * can script outcomes and inspect what the fake received.
 *
 * **It also puts {@link testSubmitConfig} in force** (a `Context.Reference`, so
 * it does not show in the layer's type): a resubmit path does not sleep
 * through the production schedule on the real clock. A `SubmitConfig` the
 * test provides *inside* — `SubmitConfig.with(...)` — wins over it.
 *
 * It does **not** provide a journal: the default one is process-wide, so a test
 * that submits provides `Journal.layerMemory` itself, or runs through
 * {@link SuiTest.provide}, which does.
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
): Layer.Layer<TestServices, NetworkMismatch | TransportError> =>
  Sui.layerNoDeps.pipe(
    Layer.provideMerge(SuiCoreFake.layer(script)),
    Layer.provideMerge(SubmitConfig.layer(testSubmitConfig))
  )

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
 * **`SuiGraphQL` is provided too**, as `SuiGraphQL.layerUnavailable`: an
 * extension that reads GraphQL requires the tag, its layer would otherwise not
 * build in a test, and "there is no endpoint" is the answer a test wants by
 * default — every GraphQL call fails with `GraphQLUnavailable`, which is a
 * failure the extension already handles. Pass `extra` to override it with a
 * real or scripted client, or to provide anything else the extension's layer
 * requires that the client could not have given it (an `HttpClient`, an
 * operator service, a sibling extension's test layer).
 *
 * Fails with: whatever the extension's layer fails with, whatever `extra` fails
 * with, plus `NetworkMismatch` and `TransportError` when the script asks for
 * them.
 *
 * @example
 * ```ts
 * import { layerExtensionTest } from "@unconfirmed/sui-effect/testing"
 *
 * const layer = layerExtensionTest(Escrow.layerTest(), { objects: [escrow] })
 *
 * // with a dependency of the extension's own:
 * const withGraphQL = layerExtensionTest(Escrow.layerTest(), {}, {
 *   extra: SuiGraphQL.layer(fakeGraphQLClient)
 * })
 * ```
 */
export const layerExtensionTest = <Self, E, RExtra = never, EExtra = never>(
  layer: Layer.Layer<Self, E, Sui | SuiCore | SuiGraphQL | RExtra>,
  script: FakeScript = {},
  options: { readonly extra?: Layer.Layer<RExtra, EExtra> } = {}
): Layer.Layer<
  Self | Sui | SuiCore | SuiCoreFake,
  E | EExtra | NetworkMismatch | TransportError
> => {
  // `extra` last, so a caller that provides its own `SuiGraphQL` wins over the
  // unavailable default rather than racing it.
  const deps = options.extra === undefined
    ? SuiGraphQL.layerUnavailable
    : Layer.merge(SuiGraphQL.layerUnavailable, options.extra)
  // The cast is the one thing the checker cannot do for itself: `deps` provides
  // exactly `RExtra` (plus `SuiGraphQL`), but `Exclude<RExtra, …>` does not
  // reduce to `never` for an unresolved type parameter. Everything the layer
  // requires is provided here or by `layerTest`.
  return layer.pipe(
    Layer.provide(deps),
    Layer.provideMerge(layerTest(script))
  ) as unknown as Layer.Layer<
    Self | Sui | SuiCore | SuiCoreFake,
    E | EExtra | NetworkMismatch | TransportError
  >
}

const withFake = <A>(f: (fake: SuiCoreFake["Service"]) => Effect.Effect<A>) =>
  Effect.flatMap(SuiCoreFake, f)

/** Inserts or replaces an object the fake serves. Never fails. */
const putObject = (object: FakeObject): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setObject(object))

/**
 * Moves an object to its next version, optionally with new content and with the
 * digest of the transaction that moved it, and answers with the version it now
 * has.
 *
 * The direct way to stand in for a transaction the test did not run. Pass
 * `consumedBy` to say who moved it: `Tx.reconcile` reads that digest back as
 * the object's `previousTransaction`, and it is the start of every answer a
 * bumped input can produce — **the transaction's own** digest means it applied
 * after all, and **no digest** means the node proved nothing and the outcome is
 * `SubmissionUnknown`.
 *
 * A **different** digest is only `NotApplied { inputConsumed }` when that
 * transaction's own effects say it took the object at exactly the version the
 * bytes pinned, so a test that wants that answer also scripts the consuming
 * transaction — `FakeScript.transactions` or {@link recordTransaction} — with
 * an explicit `inputVersion`. Without it the answer is `SubmissionUnknown`,
 * which is what a real network gives for almost every stuck submission.
 *
 * Dies when the fake has no such object: a test that bumps something that is
 * not there is a broken test, not a failing one.
 */
const bumpVersion = (
  objectId: string,
  opts?: { readonly content?: Uint8Array; readonly consumedBy?: string }
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
        ...(opts?.content === undefined ? {} : { content: opts.content }),
        ...(opts?.consumedBy === undefined ? {} : { previousTransaction: opts.consumedBy })
      }).pipe(Effect.as(next))
    })
  )

/**
 * Teaches the fake what the node says about one transaction, **by digest**.
 *
 * The ordered `scriptGetTransaction` answers "what comes back the next time
 * `getTransaction` is called", which is what drives a reconcile. This answers
 * "what does the node say about *that* transaction", which is what
 * `Tx.reconcile` asks when it follows a moved object's `previousTransaction` to
 * find out which version the consuming transaction took. Never fails.
 */
const recordTransaction = (
  digest: string,
  outcome: FakeOutcome
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.recordTransaction(digest, outcome))

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
 * Moves the epoch `getCurrentSystemState` reports, which is what `Tx.build`
 * bounds a transaction to and what `Tx.reconcile` compares a transaction's
 * `maxEpoch` against. The direct way to make a transaction provably expired.
 * Never fails.
 */
const setEpoch = (epoch: bigint): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setEpoch(epoch))

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

/**
 * The same for `getObject`, which is how a test injects a transport failure or
 * a missing object into a **read**. An empty script (the default) means every
 * read is served from the object map. Never fails.
 *
 * @since 0.1.2
 */
const scriptGetObject = (
  outcomes: ReadonlyArray<FakeOutcome>
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setOutcomes("getObject", outcomes))

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
 * Holds `waitForTransaction` for transactions the fake executed — real
 * milliseconds, or `"never"` (until the caller's signal fires); `undefined`
 * makes them visible at once again. See `FakeScript.visibilityDelay`. Never
 * fails.
 *
 * @since 0.4.0
 */
const setVisibilityDelay = (
  delay: number | "never" | undefined
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setVisibilityDelay(delay))

/** The SUI coin type, the default of the address-balance helpers. */
const SUI_COIN_TYPE = "0x2::sui::SUI"

/**
 * Sets the fake's address balance of `owner` in `coinType` (default SUI) to
 * `amount` MIST, replacing the scripted seed and anything an execution moved.
 *
 * The fake's resolver pays gas from it when it covers the budget, an execution
 * with an empty payment is refused when it does not, and the SDK's
 * `tx.coin`/`tx.balance` intents redeem from it — so this is how a test moves
 * a payer from coin gas to address-balance gas, or drains it, mid-test. Never
 * fails.
 *
 * @since 0.4.0
 */
const setAddressBalance = (
  owner: string,
  amount: bigint,
  coinType: string = SUI_COIN_TYPE
): Effect.Effect<void, never, SuiCoreFake> =>
  withFake((fake) => fake.setAddressBalance(owner, coinType, amount))

/**
 * The fake's current address balance of `owner` in `coinType` (default SUI),
 * in MIST: what an execution or {@link setAddressBalance} last left there, else
 * the scripted `FakeBalance.addressBalance` seed, else 0. What a test reads to
 * assert a gas charge, a `FundsWithdrawal` debit or a `send_funds` deposit.
 * Never fails.
 *
 * @since 0.4.0
 */
const addressBalance = (
  owner: string,
  coinType: string = SUI_COIN_TYPE
): Effect.Effect<bigint, never, SuiCoreFake> =>
  withFake((fake) => fake.readAddressBalance(owner, coinType))

/**
 * The whole wiring of one test, as one `.pipe` step: provides `layer` (a
 * {@link layerTest} or {@link layerExtensionTest}) plus a **fresh**
 * `Journal.layerMemory` and `TestClock.layer()`, built **locally** —
 * `{ local: true }`, so nothing is shared with another test through Effect's
 * global layer memo map, however the layer value was shared.
 *
 * The journal is why: the default one is process-wide, and a test that forgets
 * its own reads every other test's submissions from `listUnresolved`. The
 * `TestClock` means the program's own sleeps (`executeTimeout`,
 * `visibilityTimeout`, `reconcileRecheck`, a `Schedule` of your own) wait for
 * `TestClock.adjust` instead of the real clock; the chain's clock is still
 * `SuiTest.setClock`. Run the result with `Effect.runPromise` in the test.
 *
 * Fails with: whatever the program and the layer fail with.
 *
 * @since 0.4.0
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { layerExtensionTest, SuiTest } from "@unconfirmed/sui-effect/testing"
 *
 * const run = <A, E>(program: Effect.Effect<A, E, Escrow | Sui | SuiCoreFake>) =>
 *   program.pipe(SuiTest.provide(layerExtensionTest(Escrow.layerTest(), script)), Effect.runPromise)
 * ```
 */
const provide =
  <ROut, E>(layer: Layer.Layer<ROut, E>) =>
  <A, E2, R>(
    effect: Effect.Effect<A, E2, R>
  ): Effect.Effect<A, E | E2, Exclude<R, ROut | TestClock.TestClock>> =>
    Effect.provide(
      effect,
      Layer.mergeAll(layer, Layer.sync(Journal, Journal.makeMemoryUnsafe), TestClock.layer()),
      { local: true }
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
 * import { SuiTest } from "@unconfirmed/sui-effect/testing"
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
  recordTransaction,
  deleteObject,
  setClock,
  setEpoch,
  scriptExecute,
  scriptSimulate,
  scriptGetTransaction,
  scriptGetObject,
  setVisibilityDelay,
  setAddressBalance,
  addressBalance,
  calls,
  provide
} as const
