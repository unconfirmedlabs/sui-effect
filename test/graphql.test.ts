import { describe, expect, test } from "bun:test"
import { SuiGraphQLClient } from "@mysten/sui/graphql"
import { ConfigProvider, Effect, Layer } from "effect"
import { GraphQLUnavailable } from "../src/domain/errors.ts"
import { SuiGraphQL } from "../src/services/SuiGraphQL.ts"

const run = <A, E>(effect: Effect.Effect<A, E, SuiGraphQL>, layer: Layer.Layer<SuiGraphQL, E>) =>
  Effect.runPromise(Effect.provide(effect, layer, { local: true }))

describe("SuiGraphQL", () => {
  test("is the SDK client under one tag, so two extensions share it", async () => {
    const client = new SuiGraphQLClient({
      url: "https://sui-testnet.mystenlabs.com/graphql",
      network: "testnet"
    })
    const resolved = await run(SuiGraphQL, SuiGraphQL.layer(client))
    expect(resolved).toBe(client)
  })

  test("layerUnavailable rejects every call with GraphQLUnavailable", async () => {
    const error = await run(
      Effect.gen(function*() {
        const graphql = yield* SuiGraphQL
        return yield* Effect.tryPromise({
          try: () => graphql.query({ query: "{ chainIdentifier }", variables: {} }),
          catch: (cause) => cause as GraphQLUnavailable
        }).pipe(Effect.flip)
      }),
      SuiGraphQL.layerUnavailable
    )
    expect(error).toBeInstanceOf(GraphQLUnavailable)
    expect(error.method).toBe("query")
    expect(error.reason).toContain("layerUnavailable")
    // `not_applied`, through the taxonomy default: a read that did not happen
    // changed nothing.
  })

  test("layerUnavailableWith carries the application's own wording", async () => {
    const error = await run(
      Effect.gen(function*() {
        const graphql = yield* SuiGraphQL
        // `execute` is typed against the client's registered queries, which an
        // unavailable client has none of; the point is that the call rejects.
        const execute = graphql.execute as unknown as (
          query: string,
          options: Record<string, unknown>
        ) => Promise<unknown>
        return yield* Effect.tryPromise({
          try: () => execute("anything", {}),
          catch: (cause) => cause as GraphQLUnavailable
        }).pipe(Effect.flip)
      }),
      SuiGraphQL.layerUnavailableWith("this deployment has no indexer")
    )
    expect(error.reason).toBe("this deployment has no indexer")
    expect(error.method).toBe("execute")
  })

  test("layerConfig reads SUI_GRAPHQL_URL and SUI_NETWORK", async () => {
    const env = ConfigProvider.layer(
      ConfigProvider.fromEnvRecord({
        SUI_GRAPHQL_URL: "https://sui-testnet.mystenlabs.com/graphql",
        SUI_NETWORK: "testnet"
      })
    )
    const client = await Effect.runPromise(
      Effect.provide(SuiGraphQL, SuiGraphQL.layerConfig.pipe(Layer.provide(env)), { local: true })
    )
    expect(client).toBeInstanceOf(SuiGraphQLClient)
  })

  test("layerConfig fails with ConfigError when the URL is missing", async () => {
    const env = ConfigProvider.layer(ConfigProvider.fromEnvRecord({ SUI_NETWORK: "testnet" }))
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.provide(SuiGraphQL, SuiGraphQL.layerConfig.pipe(Layer.provide(env)), { local: true })
      )
    )
    expect(exit._tag).toBe("Failure")
  })
})
