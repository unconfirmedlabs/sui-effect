/**
 * `LLMS.md` is generated, so the committed file must match what the generator
 * produces from the current sources. A stale file is worse than no file: it is
 * the one document an agent reads before the code.
 *
 * The generator reads the emitted declarations in `dist/`, which is a build
 * away. Without them this file **skips** with that sentence: a CI job that runs
 * `bun test` before `bun run build` must not have its whole run killed by one
 * missing directory, which is what the generator's `process.exit(1)` used to do.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test"

// The generators shell out to the TypeScript checker over dist/; five seconds is tight on a CI runner.
setDefaultTimeout(120_000)
import { existsSync, readFileSync } from "node:fs"
import { missingDeclaration, render } from "../scripts/llms.ts"

const missing = missingDeclaration()

describe("LLMS.md", () => {
  test("is committed", () => {
    expect(existsSync("LLMS.md")).toBe(true)
  })

  test.skipIf(missing !== undefined)(
    "is what `bun scripts/llms.ts` generates from the current sources",
    () => {
      const committed = readFileSync("LLMS.md", "utf8")
      const generated = render()
      if (committed !== generated) {
        const a = committed.split("\n")
        const b = generated.split("\n")
        let i = 0
        while (i < a.length && i < b.length && a[i] === b[i]) i++
        const context = (lines: ReadonlyArray<string>) =>
          lines.slice(Math.max(0, i - 2), i + 6).map((line, k) => `${Math.max(0, i - 2) + k + 1}: ${line}`).join("\n")
        throw new Error(
          "LLMS.md is stale. Run `bun run build && bun run llms` and commit the result.\n" +
            `First difference at line ${i + 1} (committed ${a.length} lines, generated ${b.length}).\n` +
            `--- committed\n${context(a)}\n--- generated\n${context(b)}`
        )
      }
      expect(committed.length).toBe(generated.length)
    }
  )

  test.skipIf(missing !== undefined)(
    "prints the lifecycle shapes by name in the `Tx` block (NB2)",
    () => {
      const lines = readFileSync("LLMS.md", "utf8").split("\n")
      const start = lines.findIndex((line) => line.startsWith("### `Tx` (const)"))
      expect(start).toBeGreaterThan(-1)
      const rest = lines.slice(start + 1)
      const end = rest.findIndex((line) => line.startsWith("### "))
      const block = rest.slice(0, end === -1 ? rest.length : end)

      expect(block.some((line) => line.includes("=> Effect.Effect<Built,"))).toBe(true)
      expect(block.some((line) => line.includes("=> Effect.Effect<Signed,"))).toBe(true)
      // The struct was expanded inline before NB2; the name is what a reader wants.
      expect(block.filter((line) => /readonly \$kind: "ValidDuring"/.test(line))).toEqual([])
    }
  )

  if (missing !== undefined) {
    test("skipped: the emitted declarations are not built", () => {
      console.warn(
        `LLMS.md staleness is not checked: ${missing} is missing. Run \`bun run build\` first.`
      )
      expect(missing.startsWith("dist/")).toBe(true)
    })
  }
})
