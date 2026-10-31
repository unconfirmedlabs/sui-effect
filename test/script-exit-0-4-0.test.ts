/**
 * The 0.4.0 Effect-usage audit, `Script` half: an error declaring Effect's own
 * `[Runtime.errorExitCode]` marker exits with it under `Script.exitCode` (as
 * it would under `Runtime.makeRunMain`), beside the plain `exitCode` field; and
 * the interrupt rule is `Cause.hasInterruptsOnly`.
 */
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Runtime, Schema } from "effect"
import { exitCode } from "../src/services/Script.ts"

const fail = (error: unknown) => Effect.runSyncExit(Effect.fail(error))

describe("Runtime.errorExitCode is a declared exit code", () => {
  class Marked extends Schema.TaggedError<Marked>()("Marked", {}) {
    readonly outcome = "not_applied" as const
    readonly [Runtime.errorExitCode] = 2
  }

  test("an error carrying the marker exits with it, before its outcome", () => {
    expect(exitCode(fail(new Marked()))).toBe(2)
    // The same number `Runtime`'s own teardown would read.
    expect(Runtime.getErrorExitCode(new Marked())).toBe(2)
  })

  test("the plain exitCode field wins when both are declared", () => {
    expect(exitCode(fail({ _tag: "Both", exitCode: 7, [Runtime.errorExitCode]: 9 }))).toBe(7)
  })

  test("a marker outside 1–255, or not an integer, is no declaration", () => {
    for (const declared of [0, 1.5, 256, -1, "2"]) {
      expect(exitCode(fail({ _tag: "Odd", outcome: "not_applied", [Runtime.errorExitCode]: declared }))).toBe(4)
    }
  })

  test("once this run applied a transaction, a declared 2 is still 5", () => {
    expect(exitCode(fail(new Marked()), { applied: 1 })).toBe(5)
  })
})

describe("the interrupt rule", () => {
  test("interrupts only is 130, or 3 with an unresolved entry", () => {
    expect(exitCode(Exit.failCause(Cause.interrupt()))).toBe(130)
    expect(exitCode(Exit.failCause(Cause.interrupt()), { unresolved: 1 })).toBe(3)
  })

  test("an interrupt beside a failure is the failure", () => {
    const both = Cause.combine(Cause.interrupt(), Cause.fail({ _tag: "X", outcome: "applied" }))
    expect(exitCode(Exit.failCause(both))).toBe(5)
  })

  test("an interrupt beside a defect is a defect", () => {
    const both = Cause.combine(Cause.interrupt(), Cause.die(new Error("boom")))
    expect(exitCode(Exit.failCause(both))).toBe(1)
  })
})
