/**
 * The authoring guide's code blocks are copies, not prose.
 *
 * Every fenced `ts` or `json` block in `docs/extensions.md` is preceded by an
 * HTML comment naming the file it came from, and must appear verbatim in that
 * file — allowing for the block having been dedented out of a class or a
 * function body. So a change to the template that invalidates the guide fails
 * here rather than misleading a reader.
 *
 * The one exception is a block preceded by `<!-- inline -->`: a short,
 * self-contained illustration of an idiom that has no home in the template — a
 * two-line `Stream` pipeline, a call whose whole point is its signature. It is
 * declared rather than assumed, so "this block is not checked" is a visible
 * choice in the template and not an accident.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

const GUIDE = "docs/extensions.md"

/** The marker a self-contained illustration carries instead of a source file. */
const INLINE = "<inline>"

interface Block {
  readonly source: string | undefined
  readonly lang: string
  readonly code: string
  readonly line: number
}

const parse = (markdown: string): ReadonlyArray<Block> => {
  const lines = markdown.split("\n")
  const blocks: Array<Block> = []
  let source: string | undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ""
    if (line === "<!-- inline -->") {
      source = INLINE
      index += 1
      continue
    }
    const marker = /^<!-- from: (.+) -->$/.exec(line)
    if (marker !== null) {
      source = marker[1]
      index += 1
      continue
    }
    const fence = /^```(\w*)$/.exec(line)
    if (fence !== null) {
      const body: Array<string> = []
      let cursor = index + 1
      while (cursor < lines.length && lines[cursor] !== "```") {
        body.push(lines[cursor] ?? "")
        cursor += 1
      }
      blocks.push({ source, lang: fence[1] ?? "", code: body.join("\n"), line: index + 1 })
      source = undefined
      index = cursor + 1
      continue
    }
    index += 1
  }
  return blocks
}

/** The block, or the block indented by up to five levels, appears in the file. */
const containsBlock = (fileText: string, code: string): boolean => {
  if (fileText.includes(code)) return true
  const lines = code.split("\n")
  for (const width of [2, 4, 6, 8, 10]) {
    const pad = " ".repeat(width)
    const indented = lines.map((line) => (line === "" ? line : `${pad}${line}`)).join("\n")
    if (fileText.includes(indented)) return true
  }
  return false
}

const guide = readFileSync(GUIDE, "utf8")
const blocks = parse(guide)
const codeBlocks = blocks.filter(
  (block) => (block.lang === "ts" || block.lang === "json") && block.source !== INLINE
)
const inlineBlocks = blocks.filter((block) => block.source === INLINE)

describe("docs/extensions.md", () => {
  test("has code blocks at all", () => {
    expect(codeBlocks.length).toBeGreaterThan(15)
  })

  test("the inline illustrations stay few", () => {
    // They are the exception. A guide whose examples have drifted away from the
    // package they document is the failure mode this file exists to prevent.
    expect(inlineBlocks.length).toBeLessThanOrEqual(6)
  })

  test("every code block names the template file it came from", () => {
    const unmarked = codeBlocks.filter((block) => block.source === undefined)
    expect(unmarked.map((block) => `${GUIDE}:${block.line}`)).toEqual([])
  })

  test("every code block comes from examples/extension-template", () => {
    const foreign = codeBlocks.filter(
      (block) => !(block.source ?? "").startsWith("examples/extension-template/")
    )
    expect(foreign.map((block) => block.source)).toEqual([])
  })

  for (const block of codeBlocks) {
    test(`the block at ${GUIDE}:${block.line} is verbatim from ${block.source}`, () => {
      const fileText = readFileSync(block.source as string, "utf8")
      if (!containsBlock(fileText, block.code)) {
        throw new Error(
          `${GUIDE}:${block.line} does not appear in ${block.source}.\n` +
            `Regenerate with \`bun scripts/extensions.ts\` after editing docs/extensions.tpl.md.\n` +
            `--- block ---\n${block.code}`
        )
      }
    })
  }
})
