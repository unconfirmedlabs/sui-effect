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
import { describe, expect, test } from "bun:test"
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
        throw new Error(
          "LLMS.md is stale. Run `bun run build && bun run llms` and commit the result."
        )
      }
      expect(committed.length).toBe(generated.length)
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
