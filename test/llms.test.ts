/**
 * `LLMS.md` is generated, so the committed file must match what the generator
 * produces from the current sources. A stale file is worse than no file: it is
 * the one document an agent reads before the code.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { render } from "../scripts/llms.ts"

describe("LLMS.md", () => {
  test("is committed", () => {
    expect(existsSync("LLMS.md")).toBe(true)
  })

  test("is what `bun scripts/llms.ts` generates from the current sources", () => {
    const committed = readFileSync("LLMS.md", "utf8")
    const generated = render()
    if (committed !== generated) {
      throw new Error(
        "LLMS.md is stale. Run `bun run build && bun run llms` and commit the result."
      )
    }
    expect(committed.length).toBe(generated.length)
  })
})
