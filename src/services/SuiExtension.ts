/**
 * `SuiExtension.fromService`: one implementation, two faces.
 *
 * An extension is an Effect service built on `Sui` and `Tx`. Promise consumers
 * — dapp-kit, third-party TypeScript, anything that has an SDK client and no
 * Effect — reach the same implementation through `client.$extend(...)`, where
 * every Effect member is a method returning a Promise and every Stream member
 * is an `AsyncIterable`.
 *
 * This is the one place in `src/` that runs Effects: the `ManagedRuntime` here
 * is the documented bridge between the Effect world and a Promise caller, and
 * it is built lazily, on the first call rather than at registration, so that
 * `$extend` stays synchronous and free.
 *
 * @since 0.1.0
 */
import type { ClientWithCoreApi, SuiClientRegistration } from "@mysten/sui/client"
import { normalizeSuiAddress } from "@mysten/sui/utils"
import type { Context } from "effect"
import { Effect, Layer, ManagedRuntime, Option, Semaphore, Stream } from "effect"
import type { TransportError } from "../domain/errors.ts"
import { ExtensionNotReady, NetworkMismatch } from "../domain/errors.ts"
import type { SuiAddress } from "../domain/schemas.ts"
import { KNOWN_CHAIN_IDS } from "../domain/schemas.ts"
import type { JournalService } from "./Journal.ts"
import { Journal } from "./Journal.ts"
import type { SubmitConfigOverrides } from "./SubmitConfig.ts"
import { SubmitConfig } from "./SubmitConfig.ts"
import type { Sui, SuiLayerOptions } from "./Sui.ts"
import { Sui as SuiService } from "./Sui.ts"
import { SuiCore } from "./SuiCore.ts"
import type { Reconciled } from "./Tx.ts"
import { reconcileAll } from "./Tx.ts"

/**
 * A member the Promise face must pass through **whole**, however it is typed.
 *
 * The face recurses into object-typed members — that is what makes
 * `client.miso.protocol.get(id)` work — and the recursion is by *type*, not by
 * declaration style, because an interface-typed namespace is the common case
 * and the old `Record<string, unknown>` bound skipped every one of them while
 * the runtime mapped them anyway. `Uint8Array`, `Date`, `Promise`, arrays and
 * BCS codecs (anything with both `parse` and `serialize`) are recognised
 * leaves. Everything else that is a class instance — a `Schema.Class`, a
 * domain object with Effect-returning methods — is marked by the extension
 * with {@link leaf}, which is the one way to say "this is a value, not a
 * namespace".
 *
 * @since 0.1.1
 */
export declare const LeafTypeId: unique symbol

/** The marker {@link Leaf} carries. Not constructible; {@link leaf} applies it. */
export interface LeafBrand {
  readonly [LeafTypeId]: true
}

/**
 * `T`, marked as a leaf of the Promise face: it is handed to a Promise consumer
 * exactly as the Effect service holds it.
 *
 * Declare the member as `Leaf<MyClass>` and build it with {@link leaf}. A
 * `Leaf<T>` is still a `T` — every consumer of the Effect face is unaffected.
 *
 * @since 0.1.1
 *
 * @example
 * ```ts
 * import { SuiExtension } from "@unconfirmed/sui-effect/extension"
 *
 * interface MyService {
 *   readonly policy: SuiExtension.Leaf<Policy>
 * }
 * // in the layer:
 * const service: MyService = { policy: SuiExtension.leaf(new Policy()) }
 * ```
 */
export type Leaf<T> = T & LeafBrand

const LEAVES = new WeakSet<object>()

/**
 * Marks a value as a {@link Leaf}: the Promise face passes it through untouched
 * instead of walking into it.
 *
 * The registry is a `WeakSet`, so a frozen value can be marked and nothing is
 * added to the value itself. Never fails.
 *
 * @since 0.1.1
 */
export const leaf = <T>(value: T): Leaf<T> => {
  if (typeof value === "object" && value !== null) LEAVES.add(value)
  return value as Leaf<T>
}

const isLeafValue = (value: unknown): boolean =>
  typeof value === "object" && value !== null && LEAVES.has(value)

/**
 * A BCS codec, recognised the way the runtime recognises one: both `parse` and
 * `serialize`. `BcsType` is a class instance and has no other stable marker,
 * and a namespace of members never has both of those names.
 */
interface CodecLike {
  readonly parse: (...args: ReadonlyArray<never>) => unknown
  readonly serialize: (...args: ReadonlyArray<never>) => unknown
}

/**
 * The object-typed members the face passes through instead of recursing into:
 * a marked {@link Leaf}, a `Uint8Array`, a `Date`, a `Promise`, an array, and a
 * BCS codec.
 */
type FaceLeaf = LeafBrand | Uint8Array | Date | Promise<unknown> | ReadonlyArray<unknown> | CodecLike

/**
 * What an `Effect` member's success becomes at the Promise boundary: an
 * `Option<A>` is `A | undefined`, everything else is itself.
 *
 * A Promise consumer has no `Option` and should not need one: a member that
 * answers `Option.none()` where absence is normal resolves to `undefined`, and
 * `Option.some(a)` resolves to `a`. Distributive, so `Option<A> | B` is
 * `A | undefined | B`. Stream items are not unwrapped.
 *
 * @since 0.4.0
 */
export type FaceValue<A> = A extends Option.Option<infer B> ? B | undefined : A

/**
 * The Promise face of a service interface.
 *
 * An `Effect` member becomes a zero-argument method returning a Promise, a
 * function returning an `Effect` keeps its arguments and returns a Promise, a
 * `Stream` member becomes an `AsyncIterable`, a nested object of members is
 * mapped the same way (platform SDKs namespace their surface as
 * `client.miso.protocol.*`), and anything else passes through untouched.
 *
 * **An `Option` result is `A | undefined`** ({@link FaceValue}): `Effect<Option<A>>`
 * is `Promise<A | undefined>`, in the type and at runtime, so one service can
 * return `Option` to its Effect callers and `undefined` to its Promise ones.
 *
 * **A synchronous member stays synchronous**: a recipe builder
 * `(p: Params) => Recipe` is still `(p: Params) => Recipe` here, and a plain
 * value is still that value. The type says so and, once the runtime exists, the
 * runtime agrees — see `warm` and `$ready` on {@link fromService} for the
 * window before it does.
 *
 * **The recursion is by type, not by declaration style.** Every object-typed
 * member that is not a function, an array, an `Effect`, a `Stream`, a
 * `Uint8Array`, a `Date`, a `Promise`, a BCS codec (both `parse` and
 * `serialize`) or a {@link Leaf} is mapped as a namespace — an `interface`
 * exactly like a type alias. Before 0.1.1 the bound was
 * `Record<string, unknown>`, which an interface is not assignable to, so an
 * interface-typed namespace (`readonly protocol: ProtocolService`) kept its
 * `Effect` members **in the type** while the runtime mapped them to Promises.
 * The type lied; it no longer does.
 *
 * **A class instance that is a value, not a namespace, is marked.** The runtime
 * maps plain-prototype objects and passes class instances through, so a class
 * whose methods return `Effect`s would be typed as mapped and arrive unmapped.
 * Declare such a member `Leaf<T>` and build it with {@link leaf}: the type and
 * the runtime then agree that it is a value. `Uint8Array`, `Date`, `Promise`,
 * arrays and BCS codecs need no marker.
 *
 * **A plain-object *value* member is the one place the two faces cannot agree.**
 * `{ packageId: "0x…" }` is indistinguishable from a namespace of members, so
 * the type maps it as a value while the **cold** runtime treats it as a
 * namespace and hands back a placeholder for each key. Reading one throws
 * `ExtensionNotReady` naming the path (`deployment.packageId`) rather than
 * returning something the type says cannot be awaited — so the disagreement is
 * typed and named, not silent — but the cure is `warm` or `$ready()`, not a
 * retry. An extension that is registered lazily should expose such a value
 * through an `Effect` member instead.
 */
export type PromiseFace<S> = {
  readonly [K in keyof S]: S[K] extends Stream.Stream<infer A, infer _E, infer _R> ? AsyncIterable<A>
    : S[K] extends Effect.Effect<infer A, infer _E2, infer _R2> ? () => Promise<FaceValue<A>>
    : S[K] extends (...args: infer Args) => Stream.Stream<infer A, infer _E3, infer _R3>
      ? (...args: Args) => AsyncIterable<A>
    : S[K] extends (...args: infer Args) => Effect.Effect<infer A, infer _E4, infer _R4>
      ? (...args: Args) => Promise<FaceValue<A>>
    : S[K] extends FaceLeaf ? S[K]
    : S[K] extends (...args: ReadonlyArray<never>) => unknown ? S[K]
    : S[K] extends object ? PromiseFace<S[K]>
    : S[K]
}

/**
 * What every registration carries besides the service's own members, under
 * `$`-prefixed names so an extension is free to call a member `ready` or
 * `dispose` itself.
 */
export interface ExtensionFace {
  /**
   * Builds the runtime and resolves the service, so every member afterwards is
   * the real thing — synchronous members included.
   *
   * Call it once after `$extend` when the extension has synchronous members
   * (recipe builders, ids, codecs) and the registration is not `warm`. It is
   * idempotent and costs nothing after the first time.
   */
  readonly $ready: () => Promise<void>
  /**
   * Releases everything the layer acquired and forgets the runtime. Not final:
   * the next call builds a fresh one.
   */
  readonly $dispose: () => Promise<void>
  /**
   * `Tx.reconcileAll()` over this registration's runtime: settles every entry
   * the journal in force (the one {@link SuiExtensionOptions.journal} gave, or
   * the in-memory default) still holds unresolved, and answers what each one
   * turned out to be. The startup call for a Promise consumer with a durable
   * journal.
   *
   * Rejects with `JournalError` when the journal cannot be read, and with
   * whatever the layer fails with when the runtime cannot be built.
   *
   * @since 0.4.0
   */
  readonly $reconcileAll: () => Promise<ReadonlyArray<Reconciled>>
}

/** What `fromService` needs to know beyond the service key itself. */
export interface SuiExtensionOptions<Self, E, Name extends string = string> {
  /**
   * The property the extension takes on the client: `client.<name>`.
   *
   * It is inferred as a string **literal**, which is what makes
   * `client.escrow` a property rather than an index signature. Widening it to
   * `string` is why the registered member used to arrive as `T | undefined`
   * under `noUncheckedIndexedAccess`.
   */
  readonly name: Name
  /**
   * The extension's layer.
   *
   * The bound is `Layer<Self, E, Sui | SuiCore>`: it may require either tier,
   * because this module builds both over the client `$extend` was called on,
   * and **nothing else**. An extension with a dependency of its own — an
   * `HttpClient`, a `SuiGraphQL` — provides it inside this layer
   * (`Layer.provide(SuiGraphQL.layerConfig)`) or in the function that builds
   * the registration. The rule is not "requires `Sui` and nothing else"; it is
   * "requires nothing the consumer's client could have provided".
   */
  readonly layer: Layer.Layer<Self, E, Sui | SuiCore>
  /**
   * Options for the `Sui` layer built under the extension's own.
   *
   * `sui.chainId` pins the chain identifier the node must report, overriding
   * the built-in table for `mainnet` and `testnet` and asserting one where
   * there is none — which is how an extension whose deployment names a custom
   * network's `chainIdentifier` refuses to run against a different chain.
   */
  readonly sui?: SuiLayerOptions
  /**
   * Build the runtime **inside `register`**, synchronously, instead of on the
   * first call.
   *
   * Give it when the extension has synchronous members — recipe builders, a
   * package id, a codec — that a consumer expects to read the moment it
   * registers. Every member is then the real thing immediately, and
   * `$ready()` has nothing left to do.
   *
   * **Every failure of the layer becomes a synchronous throw.** The whole
   * layer is built inside `register`, so a missing deployment, a bad
   * configuration, a `NetworkMismatch` — anything the layer can fail with —
   * comes out of `client.$extend(...)` as a thrown value rather than as the
   * rejection of a first call. That is the trade `warm` makes, and a consumer
   * has to catch it where it registers.
   *
   * After `$dispose()`, the next use re-runs this same build rather than
   * degrading to a cold registration.
   *
   * Two conditions, both enforced:
   *
   * - **The layer must not perform an asynchronous step.** A layer that reads
   *   the network, opens a connection or awaits anything cannot be built
   *   synchronously and `register` throws. This is the documented contract of
   *   `warm`, not an accident: an extension that needs the network at build is
   *   registered without it.
   * - **The chain identifier is not read — not at registration, and not
   *   later.** `Sui` normally calls `getChainIdentifier` at layer build, which
   *   is a round trip. A warm registration takes `warm.chainId` (or
   *   `sui.chainId`, or the entry in the built-in table for `mainnet` and
   *   `testnet`) as the chain's identifier and asks nothing. **The node is
   *   consulted for the first time when the extension itself makes a call**,
   *   and that call does not check the identifier either: the pinned id is what
   *   `Sui.chainId` reports for the life of the registration. A node on another
   *   chain is therefore never detected here — it is detected by the chain,
   *   because `Tx.build` stamps that id on the expiration and a validator
   *   refuses bytes signed for another chain. Register lazily when the
   *   assertion is what you want. On `devnet`, `localnet` or a custom network
   *   there is no table entry, so `warm` without a `chainId` throws rather than
   *   guess.
   *
   * A **lazy** registration that joins a chain id another registration already
   * pinned still performs its own `getChainIdentifier` assertion — once, shared
   * across every lazy registration on that base — so mixing the two on one
   * client neither loses the check nor duplicates it.
   */
  readonly warm?: { readonly chainId?: string }
  /**
   * Lifecycle overrides for every member call on this registration, the
   * `SubmitConfig.layer` of a Promise consumer: `maxGasBudget`, `resubmit`,
   * `executeTimeout: "10 seconds"` and the rest. Provided under the
   * extension's layer and to every call.
   *
   * @since 0.4.0
   */
  readonly submit?: SubmitConfigOverrides
  /**
   * The journal every member call on this registration records submissions
   * in, instead of the process-wide in-memory default — a durable one from
   * `@unconfirmed/sui-effect/journal` (`makeKeyValueStore(store)`) for a
   * consumer that must survive a restart. `$reconcileAll()` settles what it
   * holds.
   *
   * @since 0.4.0
   */
  readonly journal?: JournalService
}

/** The names the face adds to every service, which a member cannot shadow. */
const RESERVED = ["$ready", "$dispose", "$reconcileAll"] as const

const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Effect.isEffect(value)

const isStream = (value: unknown): value is Stream.Stream<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Stream.isStream(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/**
 * The sender locks every Promise-face registration uses, **process-wide** and
 * keyed by address alone.
 *
 * A sender lock exists so that two transactions from one address cannot pick
 * the same gas coin — which on a real network is equivocation, and locks the
 * coin until the epoch ends. The shared base below is keyed by client and
 * chain id, so two registrations that disagree about the chain id (a `warm`
 * one that pinned it and a lazy one that reads it), or two clients pointed at
 * one node, would otherwise hold two lock maps and race. Serializing one
 * address across unrelated clients costs throughput, never correctness.
 *
 * Reference counted: an entry lives while someone holds or waits for it.
 * Keyed on the normalized spelling, so the upper- and lower-case spellings of
 * one address (both valid `SuiAddress` brands) share one semaphore.
 */
const FACE_LOCKS = new Map<string, { readonly semaphore: Semaphore.Semaphore; holders: number }>()

const faceSenderLock = (address: SuiAddress) =>
  Effect.fn("Sui.withSenderLock")(function*<A, E, R>(
    effect: Effect.Effect<A, E, R>
  ): Effect.fn.Return<A, E, R> {
    yield* Effect.annotateCurrentSpan({ "sui.sender": address })
    const key = normalizeSuiAddress(address)
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        let entry = FACE_LOCKS.get(key)
        if (entry === undefined) {
          entry = { semaphore: Semaphore.makeUnsafe(1), holders: 0 }
          FACE_LOCKS.set(key, entry)
        }
        entry.holders += 1
        return entry
      }),
      (entry) => Semaphore.withPermits(entry.semaphore, 1)(effect),
      (entry) =>
        Effect.sync(() => {
          entry.holders -= 1
          if (entry.holders === 0 && FACE_LOCKS.get(key) === entry) FACE_LOCKS.delete(key)
        })
    )
  })

/** `Sui` with its sender lock replaced by the process-wide {@link FACE_LOCKS}. */
const withFaceLocks: Layer.Layer<Sui, never, Sui> = Layer.effect(
  SuiService,
  Effect.gen(function*() {
    const sui = yield* SuiService
    return { ...sui, withSenderLock: faceSenderLock }
  })
)

/**
 * The base `Sui` + `SuiCore` over one client, shared by every registration on
 * that client.
 *
 * Two things have to be the same object for sharing to work: the base `Layer`
 * itself (a `Layer.effect` is memoized **by identity**, so a fresh
 * `Sui.layerNoDepsWith({})` per registration is a fresh `Sui` per registration)
 * and the `Layer.MemoMap` the runtimes build through. With both, two extensions
 * on one client get one `Sui`, one chain-id read and — the reason this matters
 * — **one sender-lock map**, so `Tx.run` from two different extensions for the
 * same address serializes.
 *
 * The memo map is reference counted by Effect: the base is built on the first
 * registration that needs it and released when the last registration that used
 * it disposes, after which the next call builds it again. That is exactly the
 * lifetime `$dispose()` documents, extended across registrations.
 *
 * Keyed by the client's `core`, then by the **effective chain id** — the one
 * `warm` names, the one `sui` pins, or the built-in entry for the client's
 * network. Two extensions that pin different chain identifiers are not asking
 * for the same `Sui` and must not be handed one; a `warm` registration and a
 * lazy one on the *same* chain are, and keying by the registration's style
 * rather than by the chain was why they never shared. A network with no known
 * id at all falls back to a single "read" key, where the base reads the
 * identifier itself.
 *
 * **Only the base is shared.** Each registration still builds its own
 * extension layer with its own memoization, so "register once per client and
 * keep the extended client" is still the rule for whatever the extension's own
 * layer holds — a cache, a connection, a fake's state.
 */
type BaseLayer = Layer.Layer<Sui | SuiCore, NetworkMismatch | TransportError>

/** One shared base, with everything a later registration needs to join it. */
interface SharedBase {
  /** The layer `raw` is always built through, so every joiner gets one `Sui`. */
  readonly memoMap: Layer.MemoMap
  /** The base itself, before any assertion is added to it. */
  readonly raw: BaseLayer
  /** The base as a registration uses it: `raw` through {@link memoMap}. */
  readonly shared: BaseLayer
  /** `raw` plus the one chain-id assertion, built once. */
  asserted?: BaseLayer
}

/**
 * Keyed by the client's `core`, not by the client.
 *
 * `client.$extend(a).$extend(b)` hands each `register` a **different** object:
 * the SDK's `$extend` returns a `Proxy` of the client, and the next `$extend`
 * proxies that. Those proxies are not equal as `WeakMap` keys, so keying by the
 * client meant two chained registrations shared nothing. Every one of them
 * reads through to the same `core` object, which is what "the same transport"
 * means here anyway.
 */
const SHARED_BASES = new WeakMap<object, Map<string, SharedBase>>()

const sharedBase = (
  client: ClientWithCoreApi,
  key: string,
  build: () => BaseLayer
): SharedBase => {
  const identity = client.core as unknown as object
  let byKey = SHARED_BASES.get(identity)
  if (byKey === undefined) {
    byKey = new Map()
    SHARED_BASES.set(identity, byKey)
  }
  const existing = byKey.get(key)
  if (existing !== undefined) return existing
  const raw = build()
  // One memo map for this client and this key, shared by every registration:
  // `Layer.effect` memoizes by layer identity, so building `raw` through it
  // hands the second registration the `Sui` the first one built — one chain-id
  // read, and one sender-lock map. The memo map is reference counted by Effect,
  // so the base is released when the last registration that used it is disposed
  // and rebuilt on the next call after that.
  const memoMap = Layer.makeMemoMapUnsafe()
  const entry: SharedBase = {
    memoMap,
    raw,
    shared: Layer.fromBuild((_registrationMemo, scope) =>
      Layer.buildWithMemoMap(raw, memoMap, scope)
    )
  }
  byKey.set(key, entry)
  return entry
}

/**
 * The chain-identifier check a **lazy** registration owes when it joins a base
 * that was pinned rather than read.
 *
 * The shared base for a known chain id is `Sui.layerNoDepsPinned`, because a
 * `warm` registration on that same id has to build it synchronously and cannot
 * await a round trip. A lazy registration promises the opposite — that the node
 * is asked once and a node on another chain fails the build — so it gets this
 * alongside the base. It is one `Layer` value per shared base, built through the
 * base's own memo map, so it runs **once** however many lazy registrations join.
 *
 * Fails with: `NetworkMismatch`, `TransportError`.
 */
const assertChainId = (
  expected: string
): Layer.Layer<never, NetworkMismatch | TransportError, SuiCore> =>
  Layer.effectDiscard(
    Effect.gen(function*() {
      const core = yield* SuiCore
      const { chainIdentifier } = yield* core.getChainIdentifier()
      if (chainIdentifier !== expected) {
        return yield* new NetworkMismatch({ expected, actual: chainIdentifier })
      }
    })
  )

/** The shared base with {@link assertChainId} attached, memoized on the entry. */
const assertedBase = (entry: SharedBase, chainId: string): BaseLayer => {
  if (entry.asserted === undefined) {
    const raw = Layer.merge(entry.raw, assertChainId(chainId).pipe(Layer.provide(entry.raw)))
    entry.asserted = Layer.fromBuild((_registrationMemo, scope) =>
      Layer.buildWithMemoMap(raw, entry.memoMap, scope)
    )
  }
  return entry.asserted
}

/** What the Promise facade needs from the lazily built runtime. */
interface Bridge {
  readonly runPromise: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
  readonly iterate: <A>(stream: Stream.Stream<A, unknown, never>) => AsyncIterable<A>
}

/**
 * The placeholder a **cold** member call returns.
 *
 * It is a real `Promise` subclass — `instanceof Promise` holds, and `bun:test`'s
 * `expect(...).rejects` recognises it — that also implements
 * `Symbol.asyncIterator`, because until the runtime exists nothing knows
 * whether the member was an `Effect` (a Promise) or a `Stream` (an
 * `AsyncIterable`). `Symbol.species` is `Promise`, so `.then`, `.catch` and
 * `.finally` produce plain Promises rather than more of these.
 */
class ColdCall<A> extends Promise<A> {
  static override get [Symbol.species](): PromiseConstructor {
    return Promise
  }
}

/** The key Node's and Bun's `util.inspect` (and so `console.log`) look for. */
const INSPECT = Symbol.for("nodejs.util.inspect.custom")

/**
 * The cold placeholder, with its rejection **pre-handled**, and **callable**.
 *
 * A cold call that nobody awaits — `client.ext.doThing()` as a statement —
 * still rejects with `ExtensionNotReady`, and an unhandled rejection aborts the
 * process under Bun and Node. Attaching a no-op `catch` marks it handled
 * without changing what `await` does: the caller's own `await` still throws.
 *
 * It is a `Proxy` over a function, because until the runtime exists nothing
 * knows whether the member was a recipe builder — `tx.createFor(name, to)`,
 * typed as returning a `Recipe` — and a `Recipe` is applied: `recipe(tx)`. So
 * applying the placeholder throws `ExtensionNotReady` naming the member,
 * rather than `TypeError: recipe is not a function`. Everything else reads
 * through to the real `ColdCall` Promise: `then`/`catch`/`finally` are its
 * own, `instanceof Promise` holds (the prototype is `ColdCall.prototype`), and
 * `Symbol.asyncIterator` is the cold iteration. `typeof` is `"function"`.
 * `applied` gets the arguments, so a placeholder that really is a function
 * (`face.m.bind(null, id)`) can answer the call. Never fails.
 */
const coldCall = (
  settled: Promise<unknown>,
  iterate: () => AsyncGenerator<unknown, void, undefined>,
  applied: (args: ReadonlyArray<unknown>) => unknown,
  label: string
): Promise<unknown> & AsyncIterable<unknown> => {
  const placeholder = new ColdCall<unknown>((resolve, reject) => {
    settled.then(resolve, reject)
  })
  // Handled, so an un-awaited cold call is a no-op rather than a process abort.
  void placeholder.catch(() => {})
  // A **bound** function: callable and constructible like a plain one, but
  // with no own `prototype`. A plain function's `prototype` is
  // non-configurable, so the `has` trap below answering `false` for it is a
  // Proxy-invariant `TypeError` on `"prototype" in coldCall`.
  const target = function coldCall() {}.bind(null)
  return new Proxy(target, {
    apply: (_target, _this, args: ReadonlyArray<unknown>) => applied(args),
    construct: (_target, args: ReadonlyArray<unknown>) => {
      applied(args)
      throw new TypeError(`${label} is not a constructor`)
    },
    getPrototypeOf: () => ColdCall.prototype,
    has: (_target, key) => key === Symbol.asyncIterator || Reflect.has(placeholder, key),
    get: (_target, key) => {
      if (key === Symbol.asyncIterator) return iterate
      if (key === INSPECT) return () => `ColdCall<${label}>`
      const value: unknown = Reflect.get(placeholder, key, placeholder)
      return typeof value === "function" ? value.bind(placeholder) : value
    }
  }) as unknown as Promise<unknown> & AsyncIterable<unknown>
}

/**
 * The names a cold placeholder refuses outright, because reading one means
 * the caller took the placeholder for a **value** — a string, a number — and
 * no namespace of members plausibly has a member by that name.
 *
 * A namespace member is read the same way a property of a value is
 * (`client.ext.protocol` and `client.ext.packageId.length` are both one `get`),
 * so the cold face cannot tell them apart in general. These are the names
 * where it can: `packageId.length`, `packageId.startsWith("0x")`,
 * `amount.toFixed(2)` throw `ExtensionNotReady` naming the value, instead of
 * answering a placeholder that is truthy and says nothing.
 *
 * `call`, `apply` and `bind` are **not** here: a placeholder is a function
 * too, and `face.claim.bind(null, id)` (a React `onClick`, a debounce) has to
 * work cold the way `face.claim(id)` does. See `functionMethod` below.
 */
const VALUE_ONLY = new Set<string>([
  "length",
  "startsWith",
  "endsWith",
  "toLowerCase",
  "toUpperCase",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "trim",
  "trimStart",
  "trimEnd",
  "padStart",
  "padEnd",
  "charAt",
  "charCodeAt",
  "codePointAt",
  "substring",
  "substr",
  "indexOf",
  "lastIndexOf",
  "localeCompare",
  "toFixed",
  "toPrecision",
  "toExponential",
  "toString",
  "toLocaleString",
  "valueOf",
  "toJSON",
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable"
])

/** The `Function.prototype` methods a cold placeholder answers as a function would. */
type FunctionMethod = "call" | "apply" | "bind"

const isFunctionMethod = (key: string): key is FunctionMethod =>
  key === "call" || key === "apply" || key === "bind"

/** The runtime half of {@link FaceValue}. */
const faceValue = (value: unknown): unknown =>
  Option.isOption(value) ? Option.getOrUndefined(value) : value

const mapMember = (value: unknown, bridge: Bridge): unknown => {
  // A marked leaf is a value, whatever it looks like: the one way an extension
  // says "do not walk into this".
  if (isLeafValue(value)) return value
  if (isStream(value)) return bridge.iterate(value as Stream.Stream<unknown, unknown, never>)
  if (isEffect(value)) return () => bridge.runPromise(value as Effect.Effect<unknown, unknown, never>)
  if (typeof value === "function") {
    return (...args: ReadonlyArray<unknown>) => {
      const result = (value as (...a: ReadonlyArray<unknown>) => unknown)(...args)
      if (isStream(result)) return bridge.iterate(result as Stream.Stream<unknown, unknown, never>)
      if (isEffect(result)) return bridge.runPromise(result as Effect.Effect<unknown, unknown, never>)
      return result
    }
  }
  if (isPlainObject(value)) {
    const mapped: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) mapped[key] = mapMember(member, bridge)
    return mapped
  }
  return value
}

/**
 * Turns an Effect service into a `SuiClientRegistration` a Promise consumer
 * passes to `client.$extend(...)`.
 *
 * `register(client)` does no work by default: the `ManagedRuntime` over
 * `SuiCore.layerFromClient(client)`, a `Sui` for the client's effective chain
 * id and the extension's own layer is built on the first call and shared by
 * every call after it. The `Sui` and `SuiCore` underneath are shared with every
 * other registration on that client that names the same chain id — one
 * transport and one chain identity — and the sender lock is **process-wide**:
 * every registration, on every client, takes the same lock per address, so a
 * warm and a lazy registration (or two clients) cannot race one gas coin. A
 * rejection carries
 * the original tagged error instance, so a Promise consumer can still switch on
 * `_tag`.
 *
 * `name` is generic in a string literal, so `client.escrow` is a property of
 * the extended client's type and not an index lookup: no cast, and no
 * `| undefined` under `noUncheckedIndexedAccess`.
 *
 * **The window before the runtime exists.** Until then nothing knows what a
 * member *is*, so a member read off the face is a placeholder. An `Effect` or
 * `Stream` member behaves exactly as its type says — the call returns a
 * Promise, the iteration works — because that is what the face promises for
 * them anyway. A **synchronous** member does not: `PromiseFace` types a recipe
 * builder as returning a `Recipe` and a plain value as that value, and a
 * placeholder has neither. So a synchronous member used in that window fails
 * with `ExtensionNotReady` naming itself, rather than quietly handing back a
 * Promise where the type says `Recipe` — which is a bug that only shows up on
 * the *second* call, when the member has become real. Two cures:
 *
 * - `await client.<name>.$ready()` once after `$extend`, which builds the
 *   runtime and resolves the service; every member is real from then on;
 * - register with `warm`, which does the same synchronously inside `register`,
 *   for a layer that needs no network.
 *
 * Two lifetimes worth knowing:
 *
 * - **`$dispose()` is not final.** It releases everything the layer acquired
 *   and forgets the runtime; the next call builds a fresh one — and a `warm`
 *   registration re-runs its **warm** build, with the same options, on the next
 *   use, so it does not silently degrade to cold with every synchronous member
 *   throwing `ExtensionNotReady`. That is what a
 *   long-lived page wants (a disposed extension is usable again after a
 *   reconnect) and it does mean a `$dispose()` that races an in-flight call can
 *   leave the caller's Promise rejected while a new runtime starts behind it.
 *   Dispose when the consumer is done, not between calls.
 * - **Each `register` is independent.** Registering the same extension on two
 *   clients — or twice on one — gives two runtimes, two layer builds and two
 *   copies of whatever the layer holds (a cache, a connection). Register once
 *   per client and keep the extended client.
 *
 * **A cold call is a callable Promise.** The placeholder a member call returns
 * before the runtime exists is a `Proxy` over a function whose prototype is a
 * `Promise` subclass that also implements `Symbol.asyncIterator`:
 * `instanceof Promise` holds, `await` and `then` work, iteration works, and
 * applying it — a cold recipe builder's result used as `recipe(tx)` — throws
 * `ExtensionNotReady` naming the member. `typeof` is `"function"`, so
 * `bun:test`'s `expect(...).rejects`, which wants a native Promise, takes
 * `Promise.resolve(cold)`. Its rejection is **pre-handled** (a no-op `catch`
 * is attached at creation), so a cold call nobody awaits —
 * `client.ext.doThing()` as a statement — cannot abort the process with an
 * unhandled rejection; an `await` of it still throws `ExtensionNotReady`.
 *
 * **A cold value placeholder refuses value-only use.** A plain value member
 * read before the runtime exists throws `ExtensionNotReady` on the names only
 * a value has (`.length`, `.startsWith`, `toString`, `valueOf`, `toJSON`, …),
 * on spread and on string conversion, and prints as
 * `<ExtensionNotReady ext.member>`.
 *
 * Never fails, except that a `warm` registration throws any failure of its
 * layer synchronously out of `register`. A warm registration builds the
 * **whole layer** synchronously inside `register`, so **any** failure of that
 * layer — a missing deployment for the network, a configuration error, a
 * `NetworkMismatch`, not only an asynchronous step or an unknown chain
 * identifier — is thrown synchronously out of `register`, which means out of
 * `client.$extend(...)`. Catch it where you register. A lazy registration has
 * nowhere to put such a failure at registration time, so it surfaces as the
 * rejection of the first call that needs the layer.
 */
export const fromService = <Self, Shape, E, const Name extends string>(
  service: Context.Key<Self, Shape>,
  options: SuiExtensionOptions<Self, E, Name>
): SuiClientRegistration<ClientWithCoreApi, Name, PromiseFace<Shape> & ExtensionFace> => ({
  name: options.name,
  register: (client: ClientWithCoreApi) => {
    type Runtime = ManagedRuntime.ManagedRuntime<
      Self | Sui | SuiCore,
      E | NetworkMismatch | TransportError
    >
    let runtime: Runtime | undefined
    let instance: Shape | undefined

    /**
     * The chain identifier this registration knows before it asks anyone: the
     * one `warm` names, the one `sui` pins, or the built-in entry for the
     * client's network. `undefined` on `devnet`, `localnet` or a custom network
     * with neither, which is the only case where the base is keyed by "read".
     */
    const knownChainId = options.warm?.chainId ?? options.sui?.chainId ??
      KNOWN_CHAIN_IDS[client.network]

    /**
     * The base every registration on this client and this chain shares.
     *
     * The key is the **effective chain id**, not the registration's own style,
     * so a `warm` registration and a lazy one on the same chain get one `Sui`,
     * one transport and — the reason this matters — one sender-lock map. When
     * the id is known the base is pinned (a `warm` registration must build it
     * synchronously and cannot await a round trip) and a lazy registration adds
     * {@link assertChainId} on top, which asks the node once. Only a network
     * with no known id at all falls back to a base that reads it.
     */
    const baseEntry = (): SharedBase =>
      sharedBase(
        client,
        knownChainId === undefined ? "read" : `chain:${knownChainId}`,
        () =>
          // `Sui` and `SuiCore` over the very client `$extend` was called on, so
          // the extension and the consumer share one transport, one chain-id
          // check and one sender-lock map.
          // The sender lock is the process-wide one, whatever the key.
          withFaceLocks.pipe(
            Layer.provide(
              knownChainId === undefined
                ? SuiService.layerNoDepsWith(options.sui ?? {})
                : SuiService.layerNoDepsPinned(knownChainId)
            ),
            Layer.provideMerge(SuiCore.layerFromClient(client))
          )
      )

    const baseOf = (): BaseLayer => {
      const entry = baseEntry()
      return knownChainId === undefined ? entry.shared : assertedBase(entry, knownChainId)
    }

    /**
     * The registration's own lifecycle references, `submit` and `journal`,
     * under the extension's layer (so its build sees them) and in the runtime
     * (so every call does).
     */
    const references: Layer.Layer<never> = Layer.mergeAll(
      options.submit === undefined ? Layer.empty : SubmitConfig.layer(options.submit),
      options.journal === undefined ? Layer.empty : Layer.succeed(Journal, options.journal)
    )

    const runtimeLayer = (base: BaseLayer) =>
      options.layer.pipe(Layer.provideMerge(Layer.merge(base, references)))

    const runtimeOf = (): Runtime => {
      // A warm registration re-warms (see `ensureWarm`) rather than building a
      // lazy runtime: a lazy one here would be replaced by the next member
      // read's re-warm, which is how `$reconcileAll()` after `$dispose()` used
      // to leak a runtime.
      if (runtime === undefined) ensureWarm()
      if (runtime === undefined) runtime = ManagedRuntime.make(runtimeLayer(baseOf()))
      return runtime
    }

    const bridge: Bridge = {
      // An `Option` is `A | undefined` at the Promise boundary (`FaceValue`).
      runPromise: (effect) =>
        runtimeOf().runPromise(effect as Effect.Effect<never, never, never>).then(faceValue) as never,
      iterate: <A>(stream: Stream.Stream<A, unknown, never>): AsyncIterable<A> => ({
        async *[Symbol.asyncIterator]() {
          const context = await runtimeOf().context()
          yield* Stream.toAsyncIterableWith(stream, context)
        }
      })
    }

    /**
     * The warm path: one synchronous build inside `register`.
     *
     * `ManagedRuntime.runSync` forces the layer and resolves the service in one
     * go; a layer with an asynchronous step throws out of it, which is the
     * documented contract. The chain identifier is taken, never read.
     */
    const warmUp = (_warm: { readonly chainId?: string }): void => {
      if (knownChainId === undefined) {
        throw new Error(
          `${options.name}: a warm registration on network "${client.network}" needs an explicit ` +
            "chain id (warm: { chainId }), because there is no built-in identifier for it and a " +
            "warm build never asks the node"
        )
      }
      // The **pinned** base, not the asserted one: a warm build is synchronous
      // and `getChainIdentifier` is a round trip. It is the same base object a
      // lazy registration on this chain joins.
      const base = baseEntry().shared
      const warmRuntime: Runtime = ManagedRuntime.make(runtimeLayer(base))
      // A runtime this replaces (a lazy one, or a warm build that threw) is
      // released, not dropped: dropped, it would pin the shared base forever.
      const previous = runtime
      runtime = warmRuntime
      if (previous !== undefined) void previous.dispose()
      instance = warmRuntime.runSync(service as unknown as Effect.Effect<Shape, never, Self>)
    }

    const resolve = async (): Promise<Shape> => {
      if (instance === undefined) {
        instance = await runtimeOf().runPromise(
          service as unknown as Effect.Effect<Shape, never, Self>
        )
      }
      return instance
    }

    const notReady = (member: ReadonlyArray<string>): ExtensionNotReady =>
      new ExtensionNotReady({
        extension: options.name,
        member: member.length === 0 ? "<the service>" : member.join(".")
      })

    const lazy = (path: ReadonlyArray<string>): unknown => {
      const at = async () => {
        const resolved = await resolve()
        let current: unknown = resolved
        for (const key of path) current = (current as Record<string, unknown>)[key]
        return current
      }
      /**
       * Calls the resolved member at `at` with `args`, as the cold call of it.
       *
       * A member that returns an `Effect` or a `Stream` is typed as
       * Promise-returning or as an `AsyncIterable`, so answering with either
       * is the truth. A member that returns anything else is typed as
       * **synchronous**, and a Promise of its value is not the value: say so
       * instead of handing back something the type says cannot be awaited.
       */
      const invoke = (
        member: unknown,
        args: ReadonlyArray<unknown>,
        at: ReadonlyArray<string>
      ): unknown => {
        const mapped = mapMember(member, bridge)
        if (typeof mapped !== "function") {
          // The member was a plain value, and the caller used it as a
          // function because nothing knew what it was yet.
          throw notReady(at)
        }
        const result = (mapped as (...a: ReadonlyArray<unknown>) => unknown)(...args)
        if (result instanceof Promise) return result
        if (typeof result === "object" && result !== null && Symbol.asyncIterator in result) {
          return result
        }
        throw notReady(at)
      }
      // Both faces at once, because until the runtime exists nothing knows
      // which one this member has. `PromiseFace` types an `Effect`-returning
      // method as `Promise` and a `Stream`-returning one as `AsyncIterable`; a
      // bare Promise of an `AsyncIterable` satisfies neither `for await` nor
      // the declared type, which is what a cold Stream call used to hand back.
      // So the returned value is a **real `Promise`** and an async iterable:
      // awaited it is the Promise, iterated it awaits the runtime and then
      // delegates to the real stream.
      const cold = (
        settled: Promise<unknown>,
        at: ReadonlyArray<string>,
        applied: (args: ReadonlyArray<unknown>) => unknown = () => {
          throw notReady(at)
        }
      ) =>
        coldCall(
          settled,
          async function*() {
            const value = await settled
            if (typeof value !== "object" || value === null || !(Symbol.asyncIterator in value)) {
              throw notReady(at)
            }
            yield* value as AsyncIterable<unknown>
          },
          applied,
          label
        )
      const node = (...args: ReadonlyArray<unknown>) => cold(at().then((member) => invoke(member, args, path)), path)
      /**
       * `node.call`, `node.apply`, `node.bind`, cold.
       *
       * Nothing knows yet whether `path` is a function — then these are
       * `Function.prototype`'s, and `face.claim.bind(null, id)` must work the
       * way `face.claim(id)` does — or a namespace with a member of that name
       * (`face.coupons.apply(code)`). So the answer is decided once the
       * member is resolved: a function gets the `Function.prototype` method,
       * a namespace gets its own member called with these arguments. A cold
       * `bind` is also callable at once: applied, it is the cold call of
       * `path` with the bound arguments first.
       */
      const functionMethod = (key: FunctionMethod) => (...args: ReadonlyArray<unknown>) => {
        const settled = at().then((member) => {
          if (typeof mapMember(member, bridge) !== "function") {
            return invoke((member as Record<string, unknown>)[key], args, [...path, key])
          }
          switch (key) {
            case "call":
              return invoke(member, args.slice(1), path)
            case "apply": {
              const spread = args[1]
              return invoke(member, spread === undefined || spread === null ? [] : Array.from(spread as ArrayLike<unknown>), path)
            }
            case "bind": {
              const bound = args.slice(1)
              const mapped = mapMember(member, bridge) as (...a: ReadonlyArray<unknown>) => unknown
              return (...rest: ReadonlyArray<unknown>) => mapped(...bound, ...rest)
            }
          }
        })
        return key === "bind"
          ? cold(settled, [...path, key], (rest) => node(...args.slice(1), ...rest))
          : cold(settled, [...path, key])
      }
      const label = `${options.name}.${path.join(".")}`
      // Inspectors that read the proxy's target rather than its traps (Bun's
      // `console.log` does) still see what this is.
      const rendered = `<ExtensionNotReady ${label}>`
      Object.defineProperty(node, "name", { value: rendered, configurable: true })
      Object.defineProperty(node, INSPECT, { value: () => rendered, configurable: true })
      // Every synchronous use of a placeholder — a plain value read as a
      // string, a number, a JSON payload — lands on one of these, and each one
      // says the same thing: the runtime does not exist yet.
      const guard = () => {
        throw notReady(path)
      }
      return new Proxy(node, {
        get: (_target, key) => {
          if (key === Symbol.asyncIterator) {
            return async function*() {
              const member = await at()
              const mapped = mapMember(member, bridge)
              yield* mapped as AsyncIterable<unknown>
            }
          }
          // Every synchronous use lands on one of these: a coercion, a
          // `JSON.stringify`, a spread, an `await` of what the type says is a
          // value, or a name only a value has (`packageId.length`).
          if (
            key === Symbol.toPrimitive || key === Symbol.iterator || key === "then" ||
            (typeof key === "string" && VALUE_ONLY.has(key))
          ) {
            return guard()
          }
          // `console.log(packageId)` shows what it is, not `[Function: node]`.
          if (key === INSPECT) return () => rendered
          if (key === Symbol.toStringTag) return "ExtensionNotReady"
          if (typeof key !== "string") return undefined
          if (isFunctionMethod(key)) return functionMethod(key)
          return lazy([...path, key])
        }
      })
    }

    const ready = async (): Promise<void> => {
      ensureWarm()
      await resolve()
    }

    const dispose = async () => {
      if (runtime !== undefined) await runtime.dispose()
      runtime = undefined
      instance = undefined
    }

    if (options.warm !== undefined) warmUp(options.warm)

    /**
     * A warm registration stays warm across `$dispose()`.
     *
     * `$dispose()` releases the runtime and forgets the service; a lazy
     * registration builds a fresh one on the next call, which is what it does
     * from the start. A **warm** one used to degrade to cold instead — every
     * synchronous member throwing `ExtensionNotReady` forever after, which is
     * exactly what `warm` was chosen to avoid. So the next use re-runs the same
     * warm build, with the same options: synchronous inside this read, over the
     * shared base, taking the same pinned chain id.
     *
     * It throws what `register` would have thrown, at the property read rather
     * than at registration, for the same two reasons (an asynchronous layer, an
     * unknown chain id) — neither of which can appear here without having
     * appeared at `register` already.
     */
    const ensureWarm = (): void => {
      if (instance === undefined && options.warm !== undefined) warmUp(options.warm)
    }

    const reconcile = (): Promise<ReadonlyArray<Reconciled>> => {
      ensureWarm()
      return runtimeOf().runPromise(reconcileAll())
    }

    const own = (key: string): unknown => {
      if (key === "$ready") return ready
      if (key === "$dispose") return dispose
      if (key === "$reconcileAll") return reconcile
      return undefined
    }

    return new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined
        const reserved = own(key)
        if (reserved !== undefined) return reserved
        // The face is never a Promise. Answering a lazy node for `then` made
        // `await client.ext` (an `async` function returning the face,
        // `Promise.resolve(face)`) call it, build the runtime, and never
        // settle.
        if (key === "then") return undefined
        ensureWarm()
        if (instance !== undefined) {
          const member = (instance as Record<string, unknown>)[key]
          return member === undefined ? undefined : mapMember(member, bridge)
        }
        return lazy([key])
      },
      has: (_target, key) => {
        if ((RESERVED as ReadonlyArray<string | symbol>).includes(key)) return true
        ensureWarm()
        return instance !== undefined && typeof key === "string" && key in (instance as object)
      },
      ownKeys: () => (
        ensureWarm(),
        instance === undefined
          ? [...RESERVED]
          : [...Object.keys(instance as object), ...RESERVED]
      ),
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true })
    }) as PromiseFace<Shape> & ExtensionFace
  }
})

/**
 * The namespace the spec spells: `SuiExtension.fromService(...)`, plus the
 * leaf marker a service uses to say "this member is a value, not a namespace"
 * (`SuiExtension.leaf(value)`, typed `SuiExtension.Leaf<T>`).
 */
export const SuiExtension = { fromService, leaf } as const

export declare namespace SuiExtension {
  /** {@link Leaf} under the namespace the spec spells. */
  export type Leaf<T> = T & LeafBrand
}
