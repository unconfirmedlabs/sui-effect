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
import { Arbitrary, Cause, Effect, Exit, Schema } from "effect"
import { SuiError, SuiErrorSchema } from "../src/domain/errors.ts"
import { exitCode } from "../src/services/Script.ts"

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
        "GraphQLUnavailable",
        "ExtensionNotReady"
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

describe("Script.exitCode is total", () => {
  /** One reason a cause can carry: a taxonomy failure, any failure value, a defect, an interrupt. */
  const reason = Arbitrary.flatMap(
    Arbitrary.schema(Schema.Literals(["taxonomy", "foreign", "die", "interrupt"])),
    (kind): Arbitrary.Arbitrary<Cause.Cause<unknown>> => {
      switch (kind) {
        case "taxonomy":
          return Arbitrary.map(errors, (error) => Cause.fail(error))
        case "foreign":
          return Arbitrary.map(Arbitrary.schema(Schema.Unknown), (value) => Cause.fail(value))
        case "die":
          return Arbitrary.map(Arbitrary.schema(Schema.Unknown), (value) => Cause.die(value))
        case "interrupt":
          return Arbitrary.Constant(Cause.interrupt())
      }
    }
  )
  const input = Arbitrary.all({
    reasons: Arbitrary.array(reason, { minLength: 1, maxLength: 3 }),
    unresolved: Arbitrary.schema(Schema.Literals([0, 1])),
    applied: Arbitrary.schema(Schema.Literals([0, 1]))
  })

  test("every failing cause exits with an integer from 1 to 255, and never 0", async () => {
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        input,
        ({ applied, reasons, unresolved }) => {
          const cause = reasons.reduce((all, one) => Cause.combine(all, one))
          const code = exitCode(Exit.failCause(cause), { unresolved, applied })
          return Number.isInteger(code) && code >= 1 && code <= 255
        },
        { runs: 500, seed: 13 }
      )
    )
    passes(result)
  })

  test("a lone taxonomy failure exits on its outcome axis", async () => {
    const expected = { applied: 5, unknown: 3, not_applied: 4 } as const
    const result = await Effect.runPromise(
      Arbitrary.checkEffect(
        errors,
        (error) => {
          const code = exitCode(Exit.fail(error))
          // Configuration is not on the outcome axis.
          if (error._tag === "NetworkMismatch") return code === 2
          return code === expected[SuiError.outcome(error)]
        },
        { runs: 300, seed: 17 }
      )
    )
    passes(result)
  })
})
