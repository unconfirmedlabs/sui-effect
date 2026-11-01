/**
 * The 0.4.0 Effect-usage audit, `Script` half: an error declaring Effect's own
 * `[Runtime.errorExitCode]` marker exits with it under `Script.exitCode` (as
 * it would under `Runtime.makeRunMain`), beside the plain `exitCode` field; and
 * the interrupt rule is `Cause.hasInterruptsOnly`; and `SUI_LOG_LEVEL` sets the
 * run's minimum log level.
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

describe("SUI_LOG_LEVEL", () => {
  /**
   * A real `Script.run` in a child process, under one `SUI_LOG_LEVEL`. A child
   * because Effect's default `ConfigProvider` snapshots `process.env` the first
   * time it is resolved, process-wide, so setting the variable inside this
   * test process would prove nothing.
   */
  const runWith = (level: string | undefined) => {
    const program = [
      `import { Effect, Layer } from "effect"`,
      `import { Script } from ${JSON.stringify(`${import.meta.dir}/../src/services/Script.ts`)}`,
      `Script.run(`,
      `  Effect.gen(function*() {`,
      `    yield* Effect.logDebug("a debug line")`,
      `    yield* Effect.logWarning("a warning line")`,
      `  }),`,
      `  { layer: Layer.empty }`,
      `)`
    ].join("\n")
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined && key !== "SUI_LOG_LEVEL") env[key] = value
    }
    if (level !== undefined) env["SUI_LOG_LEVEL"] = level
    const child = Bun.spawnSync([process.execPath, "-e", program], { env, cwd: `${import.meta.dir}/..` })
    return { code: child.exitCode, printed: child.stderr.toString() }
  }

  test("unset, debug lines are filtered as Effect's default does", () => {
    const { code, printed } = runWith(undefined)
    expect(code).toBe(0)
    expect(printed).not.toContain("a debug line")
    expect(printed).toContain("a warning line")
  })

  test("Debug shows them", () => {
    const { code, printed } = runWith("Debug")
    expect(code).toBe(0)
    expect(printed).toContain("a debug line")
  })

  test("Error hides the warning too", () => {
    const { printed } = runWith("Error")
    expect(printed).not.toContain("a warning line")
  })

  test("a value that is not a level is a configuration error, exit 2", () => {
    const { code, printed } = runWith("loud")
    expect(code).toBe(2)
    expect(printed).toContain("SUI_LOG_LEVEL")
  })
})
