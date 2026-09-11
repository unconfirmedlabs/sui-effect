/**
 * `SuiGraphQL`: one tag for the SDK's GraphQL client.
 *
 * sui-effect does **not** wrap the GraphQL API. There is no Effect-native
 * GraphQL tier here, no per-query error union, no fake: what this module owns
 * is the *tag*, so that two extensions that both read GraphQL — and the
 * application that configures the endpoint — agree on one client instead of
 * each opening its own and each inventing a name for the failure.
 *
 * The service value is the SDK's own `SuiGraphQLClient`. An extension reaches
 * it, calls `query` or `execute` inside `Effect.tryPromise`, and maps whatever
 * comes back into its own error union — `GraphQLUnavailable` for an endpoint
 * that is not usable, `TransportError.fromUnknown` for a call that failed.
 *
 * @since 0.1.0
 */
import { SuiGraphQLClient } from "@mysten/sui/graphql"
import { Config, Context, Effect, Layer } from "effect"
import { GraphQLUnavailable } from "../domain/errors.ts"

/**
 * A client whose every method rejects with {@link GraphQLUnavailable}.
 *
 * A `Proxy` rather than a subclass: `SuiGraphQLClient` is a class with private
 * fields and a `core` sub-client, and an application that has no endpoint wants
 * every path through it to fail the same way, including the ones a later SDK
 * release adds.
 */
const unavailableClient = (reason: string): SuiGraphQLClient =>
  new Proxy({} as Record<string | symbol, unknown>, {
    get: (_target, key) => {
      const method = typeof key === "string" ? key : String(key)
      return () => Promise.reject(new GraphQLUnavailable({ method, reason }))
    },
    has: () => true
  }) as unknown as SuiGraphQLClient

/**
 * The SDK's GraphQL client as a service, so an extension can require it
 * without constructing one.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { SuiGraphQL, TransportError } from "sui-effect"
 *
 * const names = Effect.gen(function*() {
 *   const graphql = yield* SuiGraphQL
 *   return yield* Effect.tryPromise({
 *     try: () => graphql.query({ query: "{ chainIdentifier }" }),
 *     catch: (cause) => TransportError.fromUnknown("graphql.query", cause)
 *   })
 * })
 * ```
 */
export class SuiGraphQL extends Context.Service<SuiGraphQL, SuiGraphQLClient>()(
  "sui-effect/SuiGraphQL"
) {
  /**
   * The tag over a client the caller built. Never fails.
   */
  static readonly layer = (client: SuiGraphQLClient): Layer.Layer<SuiGraphQL> =>
    Layer.succeed(SuiGraphQL, client)

  /**
   * A client pointed at `SUI_GRAPHQL_URL`, on the network `SUI_NETWORK` names —
   * the same variable `SuiCore.layerConfig` reads, because a GraphQL endpoint
   * for one chain and a node for another is a misconfiguration no error can
   * describe after the fact.
   *
   * Fails with: `ConfigError` when either variable is missing or empty.
   */
  static readonly layerConfig: Layer.Layer<SuiGraphQL, Config.ConfigError> = Layer.effect(
    SuiGraphQL,
    Effect.gen(function*() {
      const url = yield* Config.nonEmptyString("SUI_GRAPHQL_URL")
      const network = yield* Config.nonEmptyString("SUI_NETWORK")
      return new SuiGraphQLClient({ url, network })
    })
  )

  /**
   * The tag over a client whose every call rejects with `GraphQLUnavailable`.
   *
   * This is what an application provides when it has no GraphQL endpoint and
   * still wants to build an extension that can use one. The alternative — no
   * layer at all — is a compile error in code that may never run the GraphQL
   * path; this turns the absence into the failure the extension already
   * handles, at the call it would have made.
   *
   * Never fails to build; every call through it fails.
   */
  static readonly layerUnavailable: Layer.Layer<SuiGraphQL> = Layer.succeed(
    SuiGraphQL,
    unavailableClient("no SuiGraphQL endpoint is configured (SuiGraphQL.layerUnavailable)")
  )

  /**
   * `layerUnavailable` with the caller's own wording, for an application that
   * knows why the endpoint is missing. Never fails to build.
   */
  static readonly layerUnavailableWith = (reason: string): Layer.Layer<SuiGraphQL> =>
    Layer.succeed(SuiGraphQL, unavailableClient(reason))
}
