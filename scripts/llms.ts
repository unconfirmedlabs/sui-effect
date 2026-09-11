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

/**
 * How every type in this file is rendered.
 *
 * `NoTruncation` is the important one: without it the checker stops at 160
 * characters and writes `... 7 more ...`, which hides exactly the fields a
 * reader came for. The alias flags ask the checker to name a type it can name
 * instead of expanding it structurally.
 */
const TYPE_FLAGS = ts.TypeFormatFlags.NoTruncation |
  ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope |
  ts.TypeFormatFlags.InTypeAlias

/**
 * The branded schema types, printed by the name they are exported under.
 *
 * `SuiAddress` is `Schema.String.pipe(Schema.brand("SuiAddress"))`, so its
 * decoded type is an anonymous intersection `string & Brand<"SuiAddress">` that
 * carries no alias symbol for the checker to print — `type SuiAddress = typeof
 * SuiAddress.Type` names it, but nothing on the type points back at that name.
 * The brand string is that name, so the intersection can be spelled back as the
 * alias mechanically, and `SuiAddress` is what a caller writes.
 *
 * Also collapses the `import("effect/Brand").` qualifier the emitter adds when a
 * type is written from a declaration in another file.
 */
const withBrandNames = (text: string): string =>
  text
    .replace(/import\("[^"]*\/Brand"\)\./g, "")
    .replace(
      /\(?\b(?:string|number|bigint|boolean|symbol)\s*&\s*Brand<"([A-Za-z0-9_$]+)">\)?/g,
      "$1"
    )

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
  "message",
  "cause",
  "asEffect",
  "_op",
  "_tag",
  "Type",
  "Encoded",
  "DecodingServices",
  "EncodingServices"
])

/**
 * The field names a `Schema.TaggedError` actually declares, read off the
 * schema's own `Encoded` type.
 *
 * The instance type is not enough: it also carries everything `Error` brings —
 * `message`, `stack`, `name` — and a declared `cause` is indistinguishable from
 * the inherited one, because the two declarations merge. `Encoded` is the
 * schema, so it holds exactly the fields the error was defined with.
 */
const declaredFieldsOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): ReadonlySet<string> | undefined => {
  const statics = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const encoded = statics.getProperty("Encoded")
  if (encoded === undefined) return undefined
  const names = checker
    .getTypeOfSymbolAtLocation(encoded, declaration)
    .getProperties()
    .map((property) => property.getName())
    .filter((name) => name !== "_tag")
  return names.length === 0 ? undefined : new Set(names)
}

/** The declared fields of a class, for classes whose emitted body is empty. */
const fieldsOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string | undefined => {
  const declared = declaredFieldsOf(symbol, declaration, checker)
  const instance = checker.getDeclaredTypeOfSymbol(symbol)
  const properties = instance.getProperties().filter((property) => {
    const name = property.getName()
    if (declared !== undefined) return declared.has(name)
    // `__@iterator@302` and friends are how the emitter spells symbol-keyed
    // members; they are Effect machinery, not fields.
    return !name.startsWith("~") && !name.startsWith("[") && !name.startsWith("__@") &&
      !INHERITED.has(name)
  })
  if (properties.length === 0) return undefined
  return properties
    .map((property) =>
      `  readonly ${property.getName()}: ${
        // The field itself is indented by two, so its own lines follow it.
        typeTextOf(property, declaration, checker).split("\n").join("\n  ")
      }`
    )
    .join("\n")
}

/** Past this, a one-line type is broken across lines the way the emitter does. */
const MAX_INLINE_TYPE = 200

/**
 * A type the checker wrote on one line, laid out on several.
 *
 * `typeToString` has no pretty-printer — `MultilineObjectLiterals` indents but
 * never breaks the line — so an untruncated decoded type arrives as one 4000
 * character string. This is the emitter's own layout, applied afterwards: a
 * brace opens a block, a semicolon ends a member, and text inside a string
 * literal is left alone.
 */
const indented = (text: string): string => {
  if (text.length <= MAX_INLINE_TYPE) return text
  let out = ""
  let depth = 0
  let quote: string | undefined
  // A line break owed before the next character that is not a space.
  let pending = false
  const flush = (): void => {
    if (!pending) return
    out += `\n${"    ".repeat(depth)}`
    pending = false
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote !== undefined) {
      out += char
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'") {
      flush()
      quote = char
      out += char
      continue
    }
    if (char === " " && pending) continue
    if (char === "{" && text[index + 1] === "}") {
      flush()
      out += "{}"
      index++
      continue
    }
    if (char === "{") {
      flush()
      out += "{"
      depth++
      pending = true
      continue
    }
    if (char === "}") {
      depth = Math.max(0, depth - 1)
      pending = true
      flush()
      out += "}"
      continue
    }
    flush()
    out += char
    if (char === ";") pending = true
  }
  return out
}

/** The type of one symbol, untruncated and with branded aliases named. */
const typeTextOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string =>
  indented(
    withBrandNames(
      checker.typeToString(
        checker.getTypeOfSymbolAtLocation(symbol, declaration),
        declaration,
        TYPE_FLAGS
      )
    )
  )

/** The decoded type of a schema, as the comment printed under its declaration. */
const decodesTo = (type: string): string =>
  type.includes("\n")
    ? ["// decodes to:", ...type.split("\n").map((line) => `// ${line}`)].join("\n")
    : `// decodes to: ${type}`

/**
 * The declaration as it appears in the `.d.ts`, without its JSDoc block.
 *
 * Everything is printed whole. The emitted declaration is already the whole
 * member list, line by line and indented, so a long one costs lines rather than
 * legibility — and every earlier attempt to compress a long signature ended in
 * the checker's `... 6 more ...`, which drops the members a caller needs. A
 * `Schema` also gets the type it decodes to, which is the part a caller holds.
 */
const signatureOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string => {
  const text = withBrandNames(declaration.getText())
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
  // A schema's declaration is pages of combinator soup, and the half a caller
  // uses is the type it decodes to, so that is printed underneath it.
  return decoded === undefined ? `${prefix}${text}` : [
    `${prefix}${text}`,
    decodesTo(typeTextOf(decoded, declaration, checker))
  ].join("\n")
}

const docOf = (symbol: ts.Symbol, checker: ts.TypeChecker): string =>
  ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim()

/**
 * The JSDoc of **one** declaration.
 *
 * `symbol.getDocumentationComment` concatenates every declaration a name has,
 * which for the `interface Signer` / `const Signer` pair glued the namespace's
 * blurb onto the end of the interface's. The constructors that blurb names are
 * exported and documented on their own, so printing the declaration that is
 * actually being shown is both shorter and true.
 */
const docOfDeclaration = (declaration: ts.Declaration): string =>
  ts
    .getJSDocCommentsAndTags(declaration)
    .filter((node) => ts.isJSDoc(node))
    // `getTextOfJSDocComment` is what flattens the mixed text-and-`{@link}`
    // node array a JSDoc comment becomes once it contains a link.
    .map((doc) => ts.getTextOfJSDocComment(doc.comment) ?? "")
    .join("\n\n")
    .trim()

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
  // A bare trailing "Never fails." is printed on its own as the error line;
  // leaving it in the prose too said it twice. "Never fails: …" and
  // "Never fails; …" carry more than the line does and stay.
  const withoutNeverFails = withoutErrors.replace(/\s*Never fails\.(?=\s*$)/, "").trim()
  const withoutExamples = withoutNeverFails.split("\n@")[0] ?? withoutNeverFails
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

  const doc = docOfDeclaration(declaration)
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
