/**
 * Property tests with Effect's own `Arbitrary`, derived from the schemas.
 *
 * What derivation can reach, and what it cannot: `Arbitrary.schema` builds
 * values for a schema's decoded type, but a branded string with a refinement
 * (`Digest`, `ObjectId`, `SuiAddress`, `Signature`) is generated as a random
 * string and filtered, and essentially none survive. So over
 * `SuiErrorSchema` it generates the ten taxonomy tags whose fields carry no
 * such brand, and never the eight that name a digest or an object id; and a
 * `JournalEntry` (every variant carries a `Digest` and signed bytes) cannot be
 * derived at all — its KV round trip stays covered by the example tests in
 * `journal.test.ts` and `journal-compat.test.ts` rather than by a hand-built
 * generator here.
 */
import { describe, expect, test } from "bun:test"
import { Arbitrary, Effect, Schema } from "effect"
import { SuiError, SuiErrorSchema } from "../src/domain/errors.ts"

const decodeError = Schema.decodeUnknownEffect(SuiErrorSchema)

/** Fails the test with the runner's own account of a falsified property. */
const passes = <A, E>(result: Arbitrary.CheckResult<A, E>): void => {
  const failure = Arbitrary.formatCheckFailure(result)
  if (failure !== undefined) throw new Error(failure)
  expect(result._tag).toBe("Passed")
}

const errors = Arbitrary.schema(SuiErrorSchema)

describe("SuiError.toJson", () => {
  test("derivation reaches at least the ten unbranded tags", async () => {
    const sample = await Effect.runPromise(Arbitrary.sampleEffect(errors, { count: 1000, seed: 7 }))
    const tags = new Set<string>(sample.map((error) => error._tag))
    for (
      const tag of [
        "TransportError",
        "NetworkMismatch",
        "DecodeError",
        "SimulationFailed",
        "SigningError",
        "BuildError",
        "PolicyDenied",
        "JournalError",
        "GraphQLUnavailable"
      ]
    ) {
      expect([tag, tags.has(tag)]).toEqual([tag, true])
    }
  })

  test("round-trips through SuiErrorSchema, keeps the tag, and always carries a message", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        errors,
        (error) =>
          Effect.gen(function*() {
            const json = SuiError.toJson(error)
            if (json["_tag"] !== error._tag) return false
            if (typeof json["message"] !== "string" || json["message"].length === 0) return false
            if (json["outcome"] !== undefined && json["outcome"] !== SuiError.outcome(error)) return false
            const decoded = yield* decodeError(json)
            if (decoded._tag !== error._tag) return false
            // The second encoding is the first: nothing is lost or invented.
            return JSON.stringify(SuiError.toJson(decoded)) === JSON.stringify(json)
          }),
        { runs: 300, seed: 11 }
      )
    )
    passes(result)
  })
})
