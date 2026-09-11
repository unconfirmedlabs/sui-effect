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
import type { Sui } from "./Sui.ts"
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

/** What `fromService` needs to know beyond the service key itself. */
export interface SuiExtensionOptions<Self, E> {
  /** The property the extension takes on the client: `client.<name>`. */
  readonly name: string
  /**
   * The extension's layer. It may require `Sui` and `SuiCore`, which this
   * module builds over the client `$extend` was called on, and nothing else.
   */
  readonly layer: Layer.Layer<Self, E, Sui | SuiCore>
}

const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Effect.isEffect(value)

const isStream = (value: unknown): value is Stream.Stream<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Stream.isStream(value)

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

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
 * `register(client)` does no work: the `ManagedRuntime` over
 * `SuiCore.layerFromClient(client)`, `Sui.layerNoDeps` and the extension's own
 * layer is built on the first call and shared by every call after it. A
 * rejection carries the original tagged error instance, so a Promise consumer
 * can still switch on `_tag`. `dispose()` releases everything the layer
 * acquired.
 *
 * Until the runtime has been built once, a member that is a plain value cannot
 * be read as a value — nothing knows what it is yet — and comes back as a
 * callable, iterable placeholder that resolves on use. After the first
 * `await`, every member is the real thing.
 *
 * Never fails; the layer's own failures surface as rejections of the first
 * call that needs it.
 */
export const fromService = <Self, Shape, E>(
  service: Context.Key<Self, Shape>,
  options: SuiExtensionOptions<Self, E>
): SuiClientRegistration<
  ClientWithCoreApi,
  string,
  PromiseFace<Shape> & { readonly dispose: () => Promise<void> }
> => ({
  name: options.name,
  register: (client: ClientWithCoreApi) => {
    type Runtime = ManagedRuntime.ManagedRuntime<
      Self | Sui | SuiCore,
      E | NetworkMismatch | TransportError
    >
    let runtime: Runtime | undefined
    let instance: Shape | undefined

    const runtimeOf = (): Runtime => {
      if (runtime === undefined) {
        // `Sui` and `SuiCore` over the very client `$extend` was called on, so
        // the extension and the consumer share one transport and one chain-id
        // check.
        const base = SuiService.layerNoDeps.pipe(
          Layer.provideMerge(SuiCore.layerFromClient(client))
        )
        runtime = ManagedRuntime.make(options.layer.pipe(Layer.provideMerge(base)))
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

    const resolve = async (): Promise<Shape> => {
      if (instance === undefined) {
        instance = await runtimeOf().runPromise(
          service as unknown as Effect.Effect<Shape, never, Self>
        )
      }
      return instance
    }

    const lazy = (path: ReadonlyArray<string>): unknown => {
      const at = async () => {
        const resolved = await resolve()
        let current: unknown = resolved
        for (const key of path) current = (current as Record<string, unknown>)[key]
        return current
      }
      const node = (...args: ReadonlyArray<unknown>) =>
        at().then((member) => {
          const mapped = mapMember(member, bridge)
          return typeof mapped === "function"
            ? (mapped as (...a: ReadonlyArray<unknown>) => unknown)(...args)
            : mapped
        })
      return new Proxy(node, {
        get: (target, key) => {
          if (key === Symbol.asyncIterator) {
            return async function*() {
              const member = await at()
              const mapped = mapMember(member, bridge)
              yield* mapped as AsyncIterable<unknown>
            }
          }
          if (typeof key !== "string") return Reflect.get(target, key)
          return lazy([...path, key])
        }
      })
    }

    const dispose = async () => {
      if (runtime !== undefined) await runtime.dispose()
      runtime = undefined
      instance = undefined
    }

    return new Proxy({} as Record<string | symbol, unknown>, {
      get: (_target, key) => {
        if (key === "dispose") return dispose
        if (typeof key !== "string") return undefined
        if (instance !== undefined) {
          const member = (instance as Record<string, unknown>)[key]
          return member === undefined ? undefined : mapMember(member, bridge)
        }
        return lazy([key])
      },
      has: (_target, key) =>
        key === "dispose" ||
        (instance !== undefined && typeof key === "string" && key in (instance as object)),
      ownKeys: () => (instance === undefined ? ["dispose"] : [...Object.keys(instance as object), "dispose"]),
      getOwnPropertyDescriptor: () => ({ configurable: true, enumerable: true })
    }) as PromiseFace<Shape> & { readonly dispose: () => Promise<void> }
  }
})

/** The namespace the spec spells: `SuiExtension.fromService(...)`. */
export const SuiExtension = { fromService } as const
