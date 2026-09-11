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
import type { Context } from "effect"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import type { NetworkMismatch, TransportError } from "../domain/errors.ts"
import { ExtensionNotReady } from "../domain/errors.ts"
import { KNOWN_CHAIN_IDS } from "../domain/schemas.ts"
import type { Sui, SuiLayerOptions } from "./Sui.ts"
import { Sui as SuiService } from "./Sui.ts"
import { SuiCore } from "./SuiCore.ts"

/**
 * The Promise face of a service interface.
 *
 * An `Effect` member becomes a zero-argument method returning a Promise, a
 * function returning an `Effect` keeps its arguments and returns a Promise, a
 * `Stream` member becomes an `AsyncIterable`, a nested plain object of members
 * is mapped the same way (platform SDKs namespace their surface as
 * `client.miso.protocol.*`), and anything else passes through untouched.
 *
 * **A synchronous member stays synchronous**: a recipe builder
 * `(p: Params) => Recipe` is still `(p: Params) => Recipe` here, and a plain
 * value is still that value. The type says so and, once the runtime exists, the
 * runtime agrees — see `warm` and `$ready` on {@link fromService} for the
 * window before it does.
 *
 * **A class instance is a leaf.** The recursion is into plain object literals
 * only, which is what the runtime maps; a `BcsType`, a `Schema.Class` instance,
 * a `Date`, anything with a prototype of its own passes through whole, in the
 * type and at runtime alike. (An interface or class type is not assignable to
 * `Record<string, unknown>`, which is what keeps the two in step.)
 */
export type PromiseFace<S> = {
  readonly [K in keyof S]: S[K] extends Stream.Stream<infer A, infer _E, infer _R> ? AsyncIterable<A>
    : S[K] extends Effect.Effect<infer A, infer _E2, infer _R2> ? () => Promise<A>
    : S[K] extends (...args: infer Args) => Stream.Stream<infer A, infer _E3, infer _R3>
      ? (...args: Args) => AsyncIterable<A>
    : S[K] extends (...args: infer Args) => Effect.Effect<infer A, infer _E4, infer _R4>
      ? (...args: Args) => Promise<A>
    : S[K] extends Record<string, unknown> ? PromiseFace<S[K]>
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
  /** The name `$dispose` had first. The same function. */
  readonly dispose: () => Promise<void>
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
   * Two conditions, both enforced:
   *
   * - **The layer must not perform an asynchronous step.** A layer that reads
   *   the network, opens a connection or awaits anything cannot be built
   *   synchronously and `register` throws. This is the documented contract of
   *   `warm`, not an accident: an extension that needs the network at build is
   *   registered without it.
   * - **The chain identifier is not read.** `Sui` normally calls
   *   `getChainIdentifier` at layer build, which is a round trip. A warm
   *   registration takes `warm.chainId` (or `sui.chainId`, or the entry in the
   *   built-in table for `mainnet` and `testnet`) as the chain's identifier and
   *   asks nothing, so a node on another chain is not detected at
   *   registration. It is still detected by the chain: `Tx.build` stamps that
   *   id on the expiration and a validator refuses bytes signed for another
   *   chain. On `devnet`, `localnet` or a custom network there is no table
   *   entry, so `warm` without a `chainId` throws rather than guess.
   */
  readonly warm?: { readonly chainId?: string }
}

/** The names the face adds to every service, which a member cannot shadow. */
const RESERVED = ["$ready", "$dispose", "dispose"] as const

const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Effect.isEffect(value)

const isStream = (value: unknown): value is Stream.Stream<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Stream.isStream(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

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
 * Keyed by client, then by the base's own configuration, because two
 * extensions that pin different chain identifiers are not asking for the same
 * `Sui` and must not be handed one.
 *
 * **Only the base is shared.** Each registration still builds its own
 * extension layer with its own memoization, so "register once per client and
 * keep the extended client" is still the rule for whatever the extension's own
 * layer holds — a cache, a connection, a fake's state.
 */
type BaseLayer = Layer.Layer<Sui | SuiCore, NetworkMismatch | TransportError>

const SHARED_BASES = new WeakMap<ClientWithCoreApi, Map<string, BaseLayer>>()

const sharedBase = (
  client: ClientWithCoreApi,
  key: string,
  build: () => BaseLayer
): BaseLayer => {
  let byKey = SHARED_BASES.get(client)
  if (byKey === undefined) {
    byKey = new Map()
    SHARED_BASES.set(client, byKey)
  }
  const existing = byKey.get(key)
  if (existing !== undefined) return existing
  const raw = build()
  // One memo map for this client and this configuration, shared by every
  // registration: `Layer.effect` memoizes by layer identity, so building `raw`
  // through it hands the second registration the `Sui` the first one built —
  // one chain-id read, and one sender-lock map. The memo map is reference
  // counted by Effect, so the base is released when the last registration that
  // used it is disposed and rebuilt on the next call after that.
  const memoMap = Layer.makeMemoMapUnsafe()
  const shared: BaseLayer = Layer.fromBuild((_registrationMemo, scope) =>
    Layer.buildWithMemoMap(raw, memoMap, scope)
  )
  byKey.set(key, shared)
  return shared
}

/** What the Promise facade needs from the lazily built runtime. */
interface Bridge {
  readonly runPromise: <A>(effect: Effect.Effect<A, unknown, never>) => Promise<A>
  readonly iterate: <A>(stream: Stream.Stream<A, unknown, never>) => AsyncIterable<A>
}

const mapMember = (value: unknown, bridge: Bridge): unknown => {
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
 * `SuiCore.layerFromClient(client)`, `Sui.layerNoDepsWith(options.sui)` and the
 * extension's own layer is built on the first call and shared by every call
 * after it. A rejection carries the original tagged error instance, so a
 * Promise consumer can still switch on `_tag`.
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
 *   and forgets the runtime; the next call builds a fresh one. That is what a
 *   long-lived page wants (a disposed extension is usable again after a
 *   reconnect) and it does mean a `$dispose()` that races an in-flight call can
 *   leave the caller's Promise rejected while a new runtime starts behind it.
 *   Dispose when the consumer is done, not between calls. `dispose()` is the
 *   same function under the name it had first.
 * - **Each `register` is independent.** Registering the same extension on two
 *   clients — or twice on one — gives two runtimes, two layer builds and two
 *   copies of whatever the layer holds (a cache, a connection). Register once
 *   per client and keep the extended client.
 *
 * Never fails, except a `warm` registration, which throws out of `register`
 * when the layer needs an asynchronous step or when the network has no known
 * chain identifier and none was given. Otherwise the layer's own failures
 * surface as rejections of the first call that needs it.
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

    const baseOf = (): BaseLayer =>
      sharedBase(
        client,
        `read:${options.sui?.chainId ?? ""}`,
        () =>
          // `Sui` and `SuiCore` over the very client `$extend` was called on, so
          // the extension and the consumer share one transport, one chain-id
          // check and one sender-lock map.
          SuiService.layerNoDepsWith(options.sui ?? {}).pipe(
            Layer.provideMerge(SuiCore.layerFromClient(client))
          )
      )

    const runtimeOf = (): Runtime => {
      if (runtime === undefined) {
        runtime = ManagedRuntime.make(options.layer.pipe(Layer.provideMerge(baseOf())))
      }
      return runtime
    }

    const bridge: Bridge = {
      runPromise: (effect) => runtimeOf().runPromise(effect as Effect.Effect<never, never, never>),
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
    const warmUp = (warm: { readonly chainId?: string }): void => {
      const chainId = warm.chainId ?? options.sui?.chainId ?? KNOWN_CHAIN_IDS[client.network]
      if (chainId === undefined) {
        throw new Error(
          `${options.name}: a warm registration on network "${client.network}" needs an explicit ` +
            "chain id (warm: { chainId }), because there is no built-in identifier for it and a " +
            "warm build never asks the node"
        )
      }
      const base = sharedBase(
        client,
        `pinned:${chainId}`,
        () =>
          SuiService.layerNoDepsPinned(chainId).pipe(
            Layer.provideMerge(SuiCore.layerFromClient(client))
          )
      )
      const warmRuntime: Runtime = ManagedRuntime.make(
        options.layer.pipe(Layer.provideMerge(base))
      )
      runtime = warmRuntime
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
      const node = (...args: ReadonlyArray<unknown>) => {
        const settled = at().then((member) => {
          const mapped = mapMember(member, bridge)
          if (typeof mapped !== "function") {
            // The member was a plain value, and the caller used it as a
            // function because nothing knew what it was yet.
            throw notReady(path)
          }
          const result = (mapped as (...a: ReadonlyArray<unknown>) => unknown)(...args)
          // A member that returns an `Effect` or a `Stream` is typed as
          // Promise-returning or as an `AsyncIterable`, so answering with
          // either is the truth. A member that returns anything else is typed
          // as **synchronous**, and a Promise of its value is not the value:
          // say so instead of handing back something the type says cannot be
          // awaited.
          if (result instanceof Promise) return result
          if (typeof result === "object" && result !== null && Symbol.asyncIterator in result) {
            return result
          }
          throw notReady(path)
        })
        // Both faces at once, because until the runtime exists nothing knows
        // which one this member has. `PromiseFace` types an `Effect`-returning
        // method as `Promise` and a `Stream`-returning one as `AsyncIterable`;
        // a bare Promise of an `AsyncIterable` satisfies neither `for await`
        // nor the declared type, which is what a cold Stream call used to hand
        // back. So the returned value is a thenable **and** an async iterable:
        // awaited it is the Promise, iterated it awaits the runtime and then
        // delegates to the real stream.
        return {
          then: <A, B>(
            onFulfilled?: ((value: unknown) => A | PromiseLike<A>) | null,
            onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null
          ) => settled.then(onFulfilled, onRejected),
          catch: <B>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null) =>
            settled.catch(onRejected),
          finally: (onFinally?: (() => void) | null) => settled.finally(onFinally),
          [Symbol.asyncIterator]: async function*() {
            const value = await settled
            if (
              typeof value !== "object" || value === null || !(Symbol.asyncIterator in value)
            ) {
              throw notReady(path)
            }
            yield* value as AsyncIterable<unknown>
          }
        }
      }
      // Every synchronous use of a placeholder — a plain value read as a
      // string, a number, a JSON payload — lands on one of these, and each one
      // says the same thing: the runtime does not exist yet.
      const guard = () => {
        throw notReady(path)
      }
      return new Proxy(node, {
        get: (target, key) => {
          if (key === Symbol.asyncIterator) {
            return async function*() {
              const member = await at()
              const mapped = mapMember(member, bridge)
              yield* mapped as AsyncIterable<unknown>
            }
          }
          // Every synchronous use lands on one of these: a coercion, a
          // `JSON.stringify`, or an `await` of what the type says is a value.
          if (
            key === Symbol.toPrimitive || key === "toJSON" || key === "valueOf" ||
            key === "then"
          ) {
            return guard()
          }
          if (typeof key !== "string") return Reflect.get(target, key)
          return lazy([...path, key])
        }
      })
    }

    const ready = async (): Promise<void> => {
      await resolve()
    }

    const dispose = async () => {
      if (runtime !== undefined) await runtime.dispose()
      runtime = undefined
      instance = undefined
    }

    if (options.warm !== undefined) warmUp(options.warm)

    const own = (key: string): unknown => {
      if (key === "$ready") return ready
      if (key === "$dispose" || key === "dispose") return dispose
      return undefined
    }

    return new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, key) => {
        if (typeof key !== "string") return undefined
        const reserved = own(key)
        if (reserved !== undefined) return reserved
        if (instance !== undefined) {
          const member = (instance as Record<string, unknown>)[key]
          return member === undefined ? undefined : mapMember(member, bridge)
        }
        return lazy([key])
      },
      has: (_target, key) =>
        key === "$ready" || key === "$dispose" || key === "dispose" ||
        (instance !== undefined && typeof key === "string" && key in (instance as object)),
      ownKeys: () =>
        instance === undefined
          ? [...RESERVED]
          // A `Proxy` refuses duplicate keys, so a service member that happens
          // to be called `dispose` must not be listed twice.
          : [...new Set([...Object.keys(instance as object), ...RESERVED])],
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true })
    }) as PromiseFace<Shape> & ExtensionFace
  }
})

/** The namespace the spec spells: `SuiExtension.fromService(...)`. */
export const SuiExtension = { fromService } as const
