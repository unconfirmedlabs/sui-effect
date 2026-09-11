/**
 * Generates `LLMS.md`: the whole public surface of sui-effect, with every
 * exported symbol's signature and the error union its JSDoc states, followed by
 * every example in the repository verbatim.
 *
 * It is mechanical on purpose. Signatures come from the emitted `.d.ts` in
 * `dist/` through the TypeScript compiler API, and prose comes from the JSDoc
 * already in `src/`, so the file cannot describe an API the package does not
 * have. Effect's own `LLMS.md` is generated the same way, from source plus
 * examples; this is that idea at our scale.
 *
 * Run with `bun scripts/llms.ts` (after `bun run build`).
 * `test/llms.test.ts` fails if the committed file is stale.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import ts from "typescript"

/** One public subpath, in the order the `exports` map declares them. */
const SUBPATHS: ReadonlyArray<{ readonly name: string; readonly file: string }> = [
  { name: "sui-effect", file: "dist/index.d.ts" },
  { name: "sui-effect/tx", file: "dist/tx.d.ts" },
  { name: "sui-effect/journal", file: "dist/journal.d.ts" },
  { name: "sui-effect/extension", file: "dist/extension.d.ts" },
  { name: "sui-effect/script", file: "dist/script.d.ts" },
  { name: "sui-effect/testing", file: "dist/testing.d.ts" }
]

/** Files appended verbatim, after the API. */
const EXAMPLE_DIRS = ["examples"]
const WORKED_EXAMPLE = "examples/extension-template"
const WORKED_EXAMPLE_FILES = [
  "src/index.ts",
  "src/schema.ts",
  "src/errors.ts",
  "src/Escrow.ts",
  "src/upstream.ts",
  "src/extension.ts",
  "test/escrow.test.ts",
  "package.json"
]

const kindOf = (declaration: ts.Declaration): string => {
  if (ts.isClassDeclaration(declaration)) return "class"
  if (ts.isInterfaceDeclaration(declaration)) return "interface"
  if (ts.isTypeAliasDeclaration(declaration)) return "type"
  if (ts.isFunctionDeclaration(declaration)) return "function"
  if (ts.isVariableDeclaration(declaration)) return "const"
  if (ts.isModuleDeclaration(declaration)) return "namespace"
  if (ts.isEnumDeclaration(declaration)) return "enum"
  return "value"
}

/** Properties every tagged error inherits, which say nothing about the error. */
const INHERITED = new Set([
  "pipe",
  "toJSON",
  "toString",
  "stack",
  "name",
  "asEffect",
  "_op",
  "_tag",
  "Type",
  "Encoded",
  "DecodingServices",
  "EncodingServices"
])

/** The declared fields of a class, for classes whose emitted body is empty. */
const fieldsOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string | undefined => {
  const instance = checker.getDeclaredTypeOfSymbol(symbol)
  const properties = instance.getProperties().filter((property) => {
    const name = property.getName()
    // `__@iterator@302` and friends are how the emitter spells symbol-keyed
    // members; they are Effect machinery, not fields.
    return !name.startsWith("~") && !name.startsWith("[") && !name.startsWith("__@") &&
      !INHERITED.has(name)
  })
  if (properties.length === 0) return undefined
  return properties
    .map((property) =>
      `  readonly ${property.getName()}: ${
        checker.typeToString(checker.getTypeOfSymbolAtLocation(property, declaration))
      }`
    )
    .join("\n")
}

/**
 * How much of a schema's inferred type is worth printing before it stops being
 * a signature and starts being noise.
 */
const MAX_SCHEMA_SIGNATURE = 400

/**
 * And how much of any other `const`'s signature is worth printing. A function's
 * signature is the point, so this is generous; past it, the checker's own
 * summary reads better than an inlined page of structural types, and the error
 * union is in the "Fails with" line either way.
 */
const MAX_SIGNATURE = 1200

/**
 * The declaration as it appears in the `.d.ts`, without its JSDoc block.
 *
 * Interfaces and classes are printed whole: their bodies are the member list,
 * which is exactly what a reader wants. A `const` whose inferred type runs to
 * pages — every `Schema` in the package does — is printed as the checker
 * summarizes it, plus the type it decodes to, which is the part a caller uses.
 */
const signatureOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string => {
  const text = declaration.getText()
  if (ts.isClassDeclaration(declaration) && declaration.members.length === 0) {
    // A `Schema.TaggedError` class has an empty body and an extends clause the
    // emitter names `X_base`, so the fields are only visible on the type.
    const fields = fieldsOf(symbol, declaration, checker)
    return fields === undefined ? text : `${text.replace(/\s*{\s*}$/, "")} {\n${fields}\n}`
  }
  if (!ts.isVariableDeclaration(declaration)) return text
  const statement = declaration.parent.parent
  const prefix = ts.isVariableStatement(statement) ? "declare const " : ""
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const decoded = type.getProperty("Type")
  // Only a `Schema` is compressed: a function's signature is worth printing in
  // full however long it is, but a schema's inferred type is pages of
  // combinator soup whose useful half is the type it decodes to.
  const limit = decoded === undefined ? MAX_SIGNATURE : MAX_SCHEMA_SIGNATURE
  if (text.length <= limit) return `${prefix}${text}`
  const summary = `${prefix}${symbol.getName()}: ${checker.typeToString(type)}`
  return decoded === undefined ? summary : [
    summary,
    `// decodes to: ${checker.typeToString(checker.getTypeOfSymbolAtLocation(decoded, declaration))}`
  ].join("\n")
}

const docOf = (symbol: ts.Symbol, checker: ts.TypeChecker): string =>
  ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()

/**
 * The "Fails with: …" sentence every public function's JSDoc carries, or the
 * "Never fails." it carries instead, as one line.
 */
const errorsOf = (doc: string): string | undefined => {
  const fails = /Fails with:[\s\S]*?(?:\.\s*$|\.\n|\.$)/m.exec(doc)
  if (fails !== null) return fails[0].replace(/\s+/g, " ").trim()
  return /Never fails\.?/.test(doc) ? "Never fails." : undefined
}

/** The JSDoc without the error sentence, which is printed on its own. */
const summaryOf = (doc: string): string => {
  const withoutErrors = doc.replace(/Fails with:[\s\S]*?(?:\.\s*$|\.\n|\.$)/m, "").trim()
  const withoutExamples = withoutErrors.split("\n@")[0] ?? withoutErrors
  // `{@link X}` is for an IDE, not for a reader of plain markdown.
  return withoutExamples.replace(/\{@link\s+([^}]+)\}/g, "`$1`").trim()
}

const renderSymbol = (
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  depth: number
): string | undefined => {
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol
  const declaration = target.declarations?.[0]
  if (declaration === undefined) return undefined

  // `export * as SuiSchema from "..."` aliases a whole module: list what it
  // holds rather than printing the file.
  if (ts.isSourceFile(declaration)) {
    const members = checker
      .getExportsOfModule(target)
      .map((member) => renderSymbol(member, checker, depth + 1))
      .filter((section): section is string => section !== undefined)
    return [`${"#".repeat(depth)} \`${symbol.getName()}\` (namespace)`, "", ...members].join("\n")
  }

  const doc = docOf(target, checker)
  const summary = summaryOf(doc)
  const errors = errorsOf(doc)
  const lines = [
    `${"#".repeat(depth)} \`${symbol.getName()}\` (${kindOf(declaration)})`,
    "",
    "```ts",
    signatureOf(target, declaration, checker),
    "```",
    ""
  ]
  if (summary !== "") lines.push(summary, "")
  if (errors !== undefined) lines.push(`**${errors}**`, "")
  return lines.join("\n")
}

const renderApi = (): string => {
  const files = SUBPATHS.map((subpath) => subpath.file)
  for (const file of files) {
    try {
      statSync(file)
    } catch {
      console.error(`${file} is missing: run \`bun run build\` first.`)
      process.exit(1)
    }
  }
  const program = ts.createProgram({
    rootNames: [...files],
    options: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      skipLibCheck: true,
      noEmit: true
    }
  })
  const checker = program.getTypeChecker()
  const sections: Array<string> = []
  for (const subpath of SUBPATHS) {
    const source = program.getSourceFile(subpath.file)
    if (source === undefined) {
      console.error(`${subpath.file} is not in the program`)
      process.exit(1)
    }
    const moduleSymbol = checker.getSymbolAtLocation(source)
    const moduleDoc = moduleSymbol === undefined ? "" : summaryOf(docOf(moduleSymbol, checker))
    const exports = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)
    const rendered = [...exports]
      .sort((left, right) => left.getName().localeCompare(right.getName()))
      .map((symbol) => renderSymbol(symbol, checker, 3))
      .filter((section): section is string => section !== undefined)
    sections.push(
      [
        `## \`${subpath.name}\``,
        "",
        moduleDoc === "" ? "" : `${moduleDoc}\n`,
        `${rendered.length} exported symbols.`,
        "",
        ...rendered
      ].join("\n")
    )
  }
  return sections.join("\n")
}

const listFiles = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => `${dir}/${entry}`)

const fenceOf = (path: string): string => (path.endsWith(".json") ? "json" : "ts")

const renderFiles = (paths: ReadonlyArray<string>): string =>
  paths
    .map((path) =>
      [`### \`${path}\``, "", `\`\`\`${fenceOf(path)}`, readFileSync(path, "utf8").trimEnd(), "```", ""]
        .join("\n")
    )
    .join("\n")

/** The whole file, as a string, so a test can compare it with what is committed. */
export const render = (): string => {
  const head = [
    "# sui-effect for agents",
    "",
    "This file is generated by `bun scripts/llms.ts` from the emitted type",
    "declarations and the JSDoc in `src/`, plus every example in the repository.",
    "Do not edit it by hand; a test fails when it is stale.",
    "",
    "sui-effect is an opinionated Effect v4 layer over `@mysten/sui`. Two client",
    "tiers (`SuiCore` mirrors the SDK, `Sui` makes the decisions), a closed error",
    "union on every function, the transaction lifecycle as functions with typed",
    "outcomes, and an in-memory fake so every test runs with no network.",
    "",
    "`AGENTS.md` has the invariants, `README.md` the tour, `docs/extensions.md` the",
    "contract for building an extension package on top of it.",
    "",
    "# API",
    ""
  ].join("\n")
  const examples = EXAMPLE_DIRS.flatMap(listFiles)
  const worked = WORKED_EXAMPLE_FILES.map((file) => `${WORKED_EXAMPLE}/${file}`)
  return [
    head,
    renderApi(),
    "# Examples",
    "",
    "Every file below is typechecked, and each one is exercised by a test against",
    "the in-memory fake.",
    "",
    renderFiles(examples),
    "# The extension worked example",
    "",
    "`examples/extension-template/` is a complete, copyable extension package, and",
    "the source of every code block in `docs/extensions.md`.",
    "",
    renderFiles(worked)
  ].join("\n")
}

if (import.meta.main) {
  const output = render()
  writeFileSync("LLMS.md", output)
  console.error(`LLMS.md: ${output.length} characters`)
}
