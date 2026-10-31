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
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { errorsOf, missingDeclaration, recipeOf, render, summaryOf } from "../scripts/llms.ts"

const missing = missingDeclaration()

describe("the error sentence", () => {
  test("Fails with: is printed whole and taken out of the prose", () => {
    const doc = "Reads one object.\n\nFails with: `ObjectNotFound`,\n`TransportError`."
    expect(errorsOf(doc)).toBe("Fails with: `ObjectNotFound`, `TransportError`.")
    expect(summaryOf(doc)).toBe("Reads one object.")
  })

  test("a qualified never-fails sentence is printed whole, not as a bare Never fails.", () => {
    const doc = "Builds a recipe.\n\nNever fails; the recipe it returns throws only if\nthe SDK does, which `Tx.build` reports.\n\nMore prose."
    expect(errorsOf(doc)).toBe("Never fails; the recipe it returns throws only if the SDK does, which `Tx.build` reports.")
    expect(summaryOf(doc)).toBe("Builds a recipe.\n\nMore prose.")
    expect(errorsOf("Wraps it. Otherwise never fails: a bad key is a `SigningError`.")).toBe(
      "Otherwise never fails: a bad key is a `SigningError`."
    )
    expect(errorsOf("Never fails, except a {@link warm} one.")).toBe("Never fails, except a `warm` one.")
  })

  test("a prose line starting with @ does not truncate the summary; a block tag does", () => {
    expect(summaryOf("The durable journal lives in\n@unconfirmed/sui-effect/journal.")).toBe(
      "The durable journal lives in\n@unconfirmed/sui-effect/journal."
    )
    expect(summaryOf("Prose.\n@example\n```ts\nx\n```")).toBe("Prose.")
  })
})

describe("the start-here head", () => {
  test("a recipe's relative src imports become the package subpaths", () => {
    const source = [
      `import { Sui } from "../../src/index.ts"`,
      `import { Tx } from "../../src/tx.ts"`,
      `import { layerTest } from "../src/testing.ts"`,
      ""
    ].join("\n")
    expect(recipeOf("x.ts", source)).toBe([
      `import { Sui } from "@unconfirmed/sui-effect"`,
      `import { Tx } from "@unconfirmed/sui-effect/tx"`,
      `import { layerTest } from "@unconfirmed/sui-effect/testing"`
    ].join("\n"))
  })

  test("a relative import with no subpath is refused, not printed", () => {
    expect(() => recipeOf("x.ts", `import { x } from "../src/services/Tx.ts"`)).toThrow("no package subpath")
  })

  test("every recipe the head names is a file, and every recipe file is named", () => {
    const head = readFileSync("docs/llms-head.md", "utf8")
    const named = [...head.matchAll(/<!-- recipe: ([^ ]+) -->/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const path of named) expect(existsSync(path)).toBe(true)
    const files = [
      ...readdirSync("examples/recipes").map((file) => `examples/recipes/${file}`),
      ...readdirSync("test/recipes").map((file) => `test/recipes/${file}`)
    ]
    expect([...files].sort()).toEqual([...named].sort())
  })
})

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

  /** The block under one `### \`name\`` (or deeper) heading, up to the next heading. */
  const blockOf = (heading: string): ReadonlyArray<string> => {
    const lines = readFileSync("LLMS.md", "utf8").split("\n")
    const start = lines.findIndex((line) => /^#{3,} /.test(line) && line.includes(heading))
    if (start === -1) throw new Error(`no heading ${heading}`)
    const rest = lines.slice(start + 1)
    const end = rest.findIndex((line) => /^#{2,} /.test(line))
    return rest.slice(0, end === -1 ? rest.length : end)
  }

  test.skipIf(missing !== undefined)(
    "the head appears once: dynamic text is never a replacement string",
    () => {
      // A "$`" in the index (the `ExtensionFace` summary has one) used to paste
      // the whole head in a second time.
      const text = readFileSync("LLMS.md", "utf8")
      expect(text.split("\n").filter((line) => line === "## Start here")).toHaveLength(1)
      expect(text.split("\n").filter((line) => line === "## Index")).toHaveLength(1)
    }
  )

  test.skipIf(missing !== undefined)(
    "a name that is a type and a value prints both",
    () => {
      expect(blockOf("`SuiError` (type + const)").some((line) => line.includes("readonly describe:"))).toBe(true)
      expect(blockOf("`FakeOutcome` (type + const)").some((line) => line.includes("succeed:"))).toBe(true)
      expect(blockOf("`Signer` (interface + const)").some((line) => line.includes("fromKeypair"))).toBe(true)
    }
  )

  test.skipIf(missing !== undefined)(
    "every overload of a function is printed",
    () => {
      const block = blockOf("`name` (function)")
      expect(block.filter((line) => line.startsWith("export declare function name"))).toHaveLength(2)
    }
  )

  test.skipIf(missing !== undefined)(
    "a schema class lists its fields, by schema name, and no private member or its comment",
    () => {
      const executed = blockOf("`Executed` (class)")
      for (const field of ["digest: Digest", "effects: TransactionEffects", "events: ReadonlyArray<Event>", "timestampMs"]) {
        expect(executed.some((line) => line.includes(`readonly ${field}`))).toBe(true)
      }
      expect(executed.some((line) => /\bprivate\b/.test(line))).toBe(false)
      // `typeOf`'s comment, which used to sit orphaned above `created`.
      expect(executed.join("\n")).not.toContain("A published\n     * package reports the literal")
      const unknown = blockOf("`SubmissionUnknown` (class)")
      expect(unknown.some((line) => line.includes("readonly signed?: SignedTransaction"))).toBe(true)
      expect(unknown.some((line) => line.includes("get message()"))).toBe(true)
    }
  )

  test.skipIf(missing !== undefined)(
    "a renamed export is printed under the name it is exported as",
    () => {
      expect(blockOf("`decode` (const)").some((line) => line.startsWith("declare const decode:"))).toBe(true)
      expect(blockOf("`matchesType` (const)").some((line) => line.startsWith("declare const matchesType:"))).toBe(true)
    }
  )

  test.skipIf(missing !== undefined)(
    "a name a public signature uses is itself documented",
    () => {
      // `Executed.fromTransactionResult` is typed over `typeof EXECUTE_INCLUDE`.
      expect(blockOf("`EXECUTE_INCLUDE` (const)").length).toBeGreaterThan(0)
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
