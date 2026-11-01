/**
 * Generates `LLMS.md`: a hand-written "start here" head (`docs/llms-head.md`,
 * with its recipes and its index filled in), then the whole public surface of
 * sui-effect, with every exported symbol's signature and the error union its
 * JSDoc states, followed by every example in the repository verbatim.
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
  { name: "@unconfirmed/sui-effect", file: "dist/index.d.ts" },
  { name: "@unconfirmed/sui-effect/tx", file: "dist/tx.d.ts" },
  { name: "@unconfirmed/sui-effect/journal", file: "dist/journal.d.ts" },
  { name: "@unconfirmed/sui-effect/gate", file: "dist/gate.d.ts" },
  { name: "@unconfirmed/sui-effect/storage", file: "dist/storage.d.ts" },
  { name: "@unconfirmed/sui-effect/extension", file: "dist/extension.d.ts" },
  { name: "@unconfirmed/sui-effect/script", file: "dist/script.d.ts" },
  { name: "@unconfirmed/sui-effect/testing", file: "dist/testing.d.ts" }
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
  "src/extension.ts"
]

/**
 * Template files named by path rather than printed: the test suite alone is a
 * sixth of this document, and the template ships inside the package, so an
 * agent can open them from `node_modules` without a checkout.
 */
const WORKED_EXAMPLE_REFERENCED = [
  "test/escrow.test.ts",
  "test/durable-object.test.ts",
  "recipes/durable-object.ts",
  "package.json",
  "scripts/check-package.ts"
]

/** The hand-written head, with `<!-- recipe: path -->` and `<!-- index -->` filled in. */
const HEAD = "docs/llms-head.md"

/**
 * The relative `src/` imports a recipe file uses, spelled as the package
 * subpaths a consumer writes. A recipe is a file in this repository so that it
 * is typechecked and tested; this is the only change made to it on the way
 * into `LLMS.md`.
 */
const SUBPATH_OF_SOURCE: ReadonlyArray<readonly [string, string]> = [
  ["src/index.ts", "@unconfirmed/sui-effect"],
  ["src/tx.ts", "@unconfirmed/sui-effect/tx"],
  ["src/journal.ts", "@unconfirmed/sui-effect/journal"],
  ["src/gate.ts", "@unconfirmed/sui-effect/gate"],
  ["src/storage.ts", "@unconfirmed/sui-effect/storage"],
  ["src/extension.ts", "@unconfirmed/sui-effect/extension"],
  ["src/script.ts", "@unconfirmed/sui-effect/script"],
  ["src/testing.ts", "@unconfirmed/sui-effect/testing"]
]

/**
 * One recipe file with its imports rewritten. Throws when a relative import is
 * left over, which would be a recipe no consumer can paste.
 */
export const recipeOf = (path: string, source: string): string => {
  let text = source
  for (const [file, subpath] of SUBPATH_OF_SOURCE) {
    text = text.replace(new RegExp(`"(?:\\.\\./)+${file.replace(".", "\\.")}"`, "g"), () => `"${subpath}"`)
  }
  const relative = /from "\.{1,2}\/[^"]*"/.exec(text)
  if (relative !== null) throw new Error(`${path}: ${relative[0]} has no package subpath`)
  return text.trimEnd()
}

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
  declaration: ts.ClassDeclaration,
  checker: ts.TypeChecker
): string | undefined => {
  const declared = declaredFieldsOf(symbol, declaration, checker)
  // A class with a body and no schema is an ordinary class: its body is the
  // whole story. Only a schema class has fields the body does not show.
  if (declared === undefined && declaration.members.length > 0) return undefined
  const inBody = new Set(
    declaration.members.flatMap((member) => member.name === undefined ? [] : [member.name.getText()])
  )
  const instance = checker.getDeclaredTypeOfSymbol(symbol)
  const properties = instance.getProperties().filter((property) => {
    const name = property.getName()
    if (inBody.has(name)) return false
    if (declared !== undefined) return declared.has(name)
    // `__@iterator@302` and friends are how the emitter spells symbol-keyed
    // members; they are Effect machinery, not fields.
    return !name.startsWith("~") && !name.startsWith("[") && !name.startsWith("__@") &&
      !INHERITED.has(name)
  })
  if (properties.length === 0) return undefined
  return properties
    .map((property) =>
      `  readonly ${property.getName()}${(property.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : ""}: ${
        // The field itself is indented by two, so its own lines follow it.
        fieldTypeTextOf(property, declaration, checker).split("\n").join("\n  ")
      };`
    )
    .join("\n")
}

/**
 * The emitted text of a class without its `private` members, **and the JSDoc
 * above each one**.
 *
 * `Executed` is a `Schema.Class` with private helpers, and the emitter writes
 * them into the `.d.ts` as `private typeOf;` under their JSDoc — a name with no
 * type and no meaning to a caller. Dropping only the line left the comment
 * orphaned over the next public member, which then read as if it said
 * something else. A member's full start includes its leading trivia, so
 * cutting from there removes the comment with it. Never fails.
 */
const withoutPrivateMembers = (declaration: ts.ClassDeclaration): string => {
  const start = declaration.getStart()
  let text = declaration.getText()
  const cuts = declaration.members
    .filter((member) =>
      ts.canHaveModifiers(member) &&
      (ts.getModifiers(member) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword)
    )
    .map((member) => [member.getFullStart() - start, member.getEnd() - start] as const)
    .reverse()
  for (const [from, to] of cuts) text = text.slice(0, from) + text.slice(to)
  return text
}

/** Where a class body opens, in the declaration's own text: just past its `{`. */
const bodyOpenOf = (declaration: ts.ClassDeclaration): number => declaration.members.pos - declaration.getStart()

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

/**
 * The object-shaped schemas `@unconfirmed/sui-effect` exports, by the name a
 * caller writes for what they decode to. Filled by `renderApi` before anything
 * is printed.
 */
const namedSchemaTypes: Array<{ readonly name: string; readonly type: ts.Type }> = []

const sameType = (checker: ts.TypeChecker, left: ts.Type, right: ts.Type): boolean =>
  checker.isTypeAssignableTo(left, right) && checker.isTypeAssignableTo(right, left)

/**
 * A field's type by the exported schema name it decodes to, when it is one.
 *
 * The emitter inlines every nested schema into a class's `X_base`, so
 * `Executed.effects` would otherwise print as the whole `TransactionEffects`
 * structure — two hundred lines with the field names lost in them. A type
 * equal to an exported schema's decoded type is that schema's name; an array
 * of one, or a union containing one, is spelled with it. Anything else is the
 * checker's full text.
 */
const fieldTypeTextOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string => {
  const nameOf = (type: ts.Type): string | undefined =>
    namedSchemaTypes.find((entry) => sameType(checker, entry.type, type))?.name
  const spell = (type: ts.Type): string | undefined => {
    const named = nameOf(type)
    if (named !== undefined) return named
    if (checker.isArrayType(type)) {
      const [element] = checker.getTypeArguments(type as ts.TypeReference)
      const inner = element === undefined ? undefined : spell(element)
      return inner === undefined ? undefined : `ReadonlyArray<${inner}>`
    }
    if (type.isUnion()) {
      // An optional field's `undefined` is already said by its `?`.
      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0
      const parts = type.types
        .filter((member) => !(optional && (member.flags & ts.TypeFlags.Undefined) !== 0))
        .map((member) => ({ member, named: spell(member) }))
      if (parts.every((part) => part.named === undefined)) return undefined
      return parts
        .map((part) => part.named ?? withBrandNames(checker.typeToString(part.member, declaration, TYPE_FLAGS)))
        .join(" | ")
    }
    return undefined
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  return spell(type) ?? typeTextOf(symbol, declaration, checker)
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
  checker: ts.TypeChecker,
  exportedName: string
): string => asExported(rawSignatureOf(symbol, declaration, checker), declaration, exportedName)

/**
 * A signature spelled with the name it is exported under.
 *
 * `SuiSchema.decode` is `decodeContent as decode` and `SuiSchema.matchesType`
 * is `typeMatches as matchesType`; the heading says the exported name, and a
 * declaration under it that says the other one reads as a different function.
 * Only the first occurrence — the declared name — is rewritten.
 */
const asExported = (text: string, declaration: ts.Declaration, exportedName: string): string => {
  const name = ts.getNameOfDeclaration(declaration)
  if (name === undefined || !ts.isIdentifier(name)) return text
  const declared = name.getText()
  if (declared === exportedName) return text
  return text.replace(new RegExp(`\\b${declared}\\b`), () => exportedName)
}

const rawSignatureOf = (
  symbol: ts.Symbol,
  declaration: ts.Declaration,
  checker: ts.TypeChecker
): string => {
  if (ts.isClassDeclaration(declaration)) {
    // A `Schema.Class` / `Schema.TaggedError` extends a base the emitter names
    // `X_base`, so the fields it was defined with are only visible on the type
    // — and a body (`get message()`, the accessors on `Executed`) does not
    // change that. They are written at the top of the body.
    const body = withoutPrivateMembers(declaration)
    const fields = fieldsOf(symbol, declaration, checker)
    const open = bodyOpenOf(declaration)
    const text = fields === undefined
      ? body
      : declaration.members.length === 0
      ? `${body.replace(/\s*{\s*}$/, "")} {\n${fields}\n}`
      : `${body.slice(0, open)}\n${fields.replace(/^ {2}/gm, "    ")}${body.slice(open)}`
    return withoutLinks(withBrandNames(text))
  }
  const text = withoutLinks(withBrandNames(declaration.getText()))
  if (!ts.isVariableDeclaration(declaration)) return text
  const statement = declaration.parent.parent
  const prefix = ts.isVariableStatement(statement) ? "declare const " : ""
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration)
  const decoded = type.getProperty("Type")
  if (decoded === undefined) return `${prefix}${text}`
  // A schema's own declaration is pages of `Schema.Struct` combinator soup —
  // most of the 7,468 lines this file used to be — and none of it is what a
  // caller holds. What a caller holds is the type it decodes to, so that is all
  // that is printed: the name, and the decoded type under it.
  return [
    `${prefix}${declaration.name.getText()}: Schema`,
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

/** `{@link X}` is for an IDE, not for a reader of plain markdown. */
const withoutLinks = (text: string): string => text.replace(/\{@link\s+([^}]+)\}/g, "`$1`")

const FAILS_WITH = /Fails with:[\s\S]*?(?:\.\s*$|\.\n|\.$)/m

/**
 * A "never fails" sentence in any of the spellings the sources use: the bare
 * "Never fails.", and the qualified "Never fails; …", "Never fails, except …",
 * "Never fails to build; …", "Otherwise never fails: …". It runs to the first
 * period followed by whitespace, so a dotted name like `Tx.run` inside it does
 * not end it.
 */
const NEVER_FAILS = /(?:Otherwise never|Never) fails\b[\s\S]*?\.(?=\s|$)/

/**
 * The error sentence every public function's JSDoc carries — "Fails with: …",
 * or one of the "never fails" spellings — as one line, whole.
 *
 * A qualified sentence is printed whole rather than as a bare **Never fails.**:
 * `fromService` says "Never fails, except a `warm` registration …", and the
 * bare form under it would contradict the paragraph directly above.
 */
export const errorsOf = (doc: string): string | undefined => {
  const found = FAILS_WITH.exec(doc) ?? NEVER_FAILS.exec(doc)
  return found === null ? undefined : withoutLinks(found[0].replace(/\s+/g, " ").trim())
}

/**
 * Where a JSDoc's prose ends: the first block tag. Only a known tag counts,
 * so a prose line that happens to start with `@` — a scoped package name —
 * does not cut the summary short.
 */
const FIRST_TAG = /\n@(?:example|since|deprecated|param|returns|throws|see|remarks|internal|template)\b/

/** The JSDoc without the error sentence, which is printed on its own. */
export const summaryOf = (doc: string): string => {
  const sentence = FAILS_WITH.exec(doc) ?? NEVER_FAILS.exec(doc)
  // The space that followed the sentence goes with it, so the prose after it on
  // the same line does not start with one.
  const withoutErrors = sentence === null
    ? doc
    : doc.slice(0, sentence.index) + doc.slice(sentence.index + sentence[0].length).replace(/^[ \t]+/, "")
  // A bare trailing "Never fails." beside a "Fails with:" sentence says the
  // same thing twice; drop it too.
  const withoutNeverFails = withoutErrors.replace(/\s*Never fails\.(?=\s*$)/, "")
  const tag = FIRST_TAG.exec(withoutNeverFails)
  const prose = tag === null ? withoutNeverFails : withoutNeverFails.slice(0, tag.index)
  return withoutLinks(prose.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n")).trim()
}

/**
 * Where each declaration was printed in full, so the second subpath that
 * re-exports it says so in one line instead of repeating it.
 *
 * `Built`, `chainOf`, `maxEpochOf`, `maxTimestampMsOf`, `Signature` and
 * `TransactionExpiration` are all `sui-effect` names that `sui-effect/tx`
 * re-exports, and `Journal` is in both `sui-effect/tx` and
 * `sui-effect/journal`. The key is the declaration, not the name: `Tx.run` and
 * `Script.run` are two different functions that happen to share one.
 */
type Rendered = Map<ts.Declaration, string>

const renderSymbol = (
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  depth: number,
  rendered: Rendered,
  subpath: string
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
      .map((member) => renderSymbol(member, checker, depth + 1, rendered, subpath))
      .filter((section): section is string => section !== undefined)
    return [`${"#".repeat(depth)} \`${symbol.getName()}\` (namespace)`, "", ...members].join("\n")
  }

  const first = rendered.get(declaration)
  if (first !== undefined && first !== subpath) {
    return [
      `${"#".repeat(depth)} \`${symbol.getName()}\` (${kindOf(declaration)})`,
      "",
      `Re-exported from \`${first}\`.`,
      ""
    ].join("\n")
  }
  rendered.set(declaration, subpath)

  const shown = shownDeclarations(target, checker)
  const lines = [`${"#".repeat(depth)} \`${symbol.getName()}\` (${kindsOf(shown)})`, ""]
  for (const group of groupsOf(shown)) {
    lines.push(
      "```ts",
      group.map((member) => signatureOf(target, member, checker, symbol.getName())).join("\n"),
      "```",
      ""
    )
    // Overloads usually share one comment; print each distinct one once.
    const docs = [...new Set(group.map(docOfDeclaration).filter((doc) => doc !== ""))]
    for (const doc of docs) {
      const summary = summaryOf(doc)
      const errors = errorsOf(doc)
      if (summary !== "") lines.push(summary, "")
      if (errors !== undefined) lines.push(`**${errors}**`, "")
    }
  }
  return lines.join("\n")
}

/**
 * A type declaration that only names what a schema value next to it decodes
 * to — `type Digest = typeof Digest.Type`, `interface Coin extends
 * CoinSchemaType {}` — and so says nothing the schema's own entry does not.
 */
const isSchemaAlias = (declaration: ts.Declaration): boolean =>
  (ts.isTypeAliasDeclaration(declaration) && /^typeof [\w$]+\.Type$/.test(declaration.type.getText())) ||
  (ts.isInterfaceDeclaration(declaration) && declaration.members.length === 0)

/**
 * Every declaration a name has, in source order, except a schema's redundant
 * type alias.
 *
 * Printing only the first one is how `SuiError`, `FakeOutcome`, `Signer` and
 * `Signed` used to lose half of themselves: each is a type **and** a value
 * under one name, and whichever the emitter wrote first hid the other — the
 * `SuiError` helpers, the `FakeOutcome` constructors, the `Signer` namespace
 * and the `Signed` schema had no entry at all.
 */
const shownDeclarations = (target: ts.Symbol, checker: ts.TypeChecker): ReadonlyArray<ts.Declaration> => {
  const all = target.declarations ?? []
  const hasSchemaValue = all.some((declaration) =>
    ts.isVariableDeclaration(declaration) &&
    checker.getTypeOfSymbolAtLocation(target, declaration).getProperty("Type") !== undefined
  )
  return hasSchemaValue && all.length > 1 ? all.filter((declaration) => !isSchemaAlias(declaration)) : all
}

/**
 * Declarations grouped the way they are printed: consecutive declarations of
 * one kind share a block, so a function's overloads read as one signature set
 * (they used to render only the first), and an interface and the const beside
 * it are two blocks with their own comments.
 */
const groupsOf = (declarations: ReadonlyArray<ts.Declaration>): ReadonlyArray<ReadonlyArray<ts.Declaration>> => {
  const groups: Array<Array<ts.Declaration>> = []
  for (const declaration of declarations) {
    const last = groups[groups.length - 1]
    if (last !== undefined && kindOf(last[0]!) === kindOf(declaration)) last.push(declaration)
    else groups.push([declaration])
  }
  return groups
}

/** The heading's kind: `const`, or `interface + const` for a name that is both. */
const kindsOf = (declarations: ReadonlyArray<ts.Declaration>): string =>
  [...new Set(declarations.map(kindOf))].join(" + ")

/**
 * The emitted declarations this generator reads, or the first one that is
 * missing.
 *
 * `render` needs `dist/`, and `dist/` is a build away. A test that calls
 * `render` in a tree that was never built has to *skip* with that sentence
 * rather than kill the whole `bun test` run, which is what exiting the process
 * from in here used to do. Never fails.
 */
export const missingDeclaration = (): string | undefined => {
  for (const { file } of SUBPATHS) {
    try {
      statSync(file)
    } catch {
      return file
    }
  }
  return undefined
}

/** One line per exported name: the subpath index in the head. */
type IndexLine = { readonly name: string; readonly summary: string }

/**
 * The first sentence of a summary, on one line. A period inside a dotted name
 * (`Tx.run`) does not end it; a period followed by whitespace does.
 */
const firstSentence = (summary: string): string => {
  const flat = summary.replace(/\s+/g, " ").trim()
  const end = /\.(?=\s|$)/.exec(flat)
  return end === null ? flat : flat.slice(0, end.index + 1)
}

const renderApi = (): { readonly api: string; readonly index: string } => {
  const files = SUBPATHS.map((subpath) => subpath.file)
  const missing = missingDeclaration()
  if (missing !== undefined) {
    throw new Error(`${missing} is missing: run \`bun run build\` first.`)
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
  namedSchemaTypes.length = 0
  const root = program.getSourceFile(SUBPATHS[0]!.file)
  const rootSymbol = root === undefined ? undefined : checker.getSymbolAtLocation(root)
  for (const exported of rootSymbol === undefined ? [] : checker.getExportsOfModule(rootSymbol)) {
    const target = (exported.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported
    const value = target.declarations?.find(ts.isVariableDeclaration)
    if (value === undefined) continue
    const decoded = checker.getTypeOfSymbolAtLocation(target, value).getProperty("Type")
    if (decoded === undefined) continue
    const type = checker.getTypeOfSymbolAtLocation(decoded, value)
    // Brands are spelled by `withBrandNames`; only structures need a name.
    if ((type.flags & ts.TypeFlags.Object) !== 0 || type.isUnion()) {
      namedSchemaTypes.push({ name: exported.getName(), type })
    }
  }
  const sections: Array<string> = []
  const indexSections: Array<string> = []
  const printed: Rendered = new Map()
  for (const subpath of SUBPATHS) {
    const source = program.getSourceFile(subpath.file)
    if (source === undefined) throw new Error(`${subpath.file} is not in the program`)
    const moduleSymbol = checker.getSymbolAtLocation(source)
    const moduleDoc = moduleSymbol === undefined ? "" : summaryOf(docOf(moduleSymbol, checker))
    const exports = moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)
    const sorted = [...exports]
      .sort((left, right) => (left.getName() < right.getName() ? -1 : left.getName() > right.getName() ? 1 : 0))
    // Read before rendering: `renderSymbol` records where each declaration was
    // first printed, and the index has to know that from the state before.
    const lines = sorted.map((symbol) => indexLineOf(symbol, checker, printed, subpath.name))
    const rendered = sorted
      .map((symbol) => renderSymbol(symbol, checker, 3, printed, subpath.name))
      .filter((section): section is string => section !== undefined)
    indexSections.push(
      [
        `### \`${subpath.name}\``,
        "",
        ...lines
          .filter((line): line is IndexLine => line !== undefined)
          .map(({ name, summary }) => `- \`${name}\`${summary === "" ? "" : ` — ${summary}`}`),
        ""
      ].join("\n")
    )
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
  return { api: sections.join("\n"), index: indexSections.join("\n") }
}

/** The index line of one exported name, read off the same declaration `renderSymbol` prints. */
const indexLineOf = (
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  printed: Rendered,
  subpath: string
): IndexLine | undefined => {
  const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0
    ? checker.getAliasedSymbol(symbol)
    : symbol
  const declaration = target.declarations?.[0]
  if (declaration === undefined) return undefined
  const name = symbol.getName()
  if (ts.isSourceFile(declaration)) return { name, summary: "a namespace; its members are listed under it below." }
  const first = printed.get(declaration)
  if (first !== undefined && first !== subpath) return { name, summary: `re-exported from \`${first}\`.` }
  const documented = shownDeclarations(target, checker).map(docOfDeclaration).find((doc) => doc !== "") ?? ""
  return { name, summary: withoutLinks(firstSentence(summaryOf(documented))) }
}

/** `docs/llms-head.md` with its recipes quoted and its index filled in. */
const renderHead = (index: string): string => {
  const head = readFileSync(HEAD, "utf8")
  if (!head.includes("<!-- index -->")) throw new Error(`${HEAD} has no <!-- index --> marker`)
  return head
    .replace(/<!-- recipe: ([^ ]+) -->/g, (_, path: string) =>
      ["```ts", recipeOf(path, readFileSync(path, "utf8")), "```"].join("\n"))
    // A function, never a replacement string: the index is JSDoc prose, and a
    // "$`" in it (the `ExtensionFace` summary says "`$`-prefixed") would paste
    // in everything before the marker — the whole head, a second time.
    .replace("<!-- index -->", () => index.trimEnd())
    .trimEnd()
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
  const { api, index } = renderApi()
  const examples = EXAMPLE_DIRS.flatMap(listFiles)
  const worked = WORKED_EXAMPLE_FILES.map((file) => `${WORKED_EXAMPLE}/${file}`)
  return [
    renderHead(index),
    "",
    "# API",
    "",
    api,
    "# Examples",
    "",
    "Every file below is typechecked, and each one is exercised by a test against",
    "the in-memory fake.",
    "",
    renderFiles(examples),
    "# The extension worked example",
    "",
    "`examples/extension-template/` is a complete, copyable extension package, and",
    "the source of every code block in `docs/extensions.md`. It ships inside this",
    "package (`node_modules/@unconfirmed/sui-effect/examples/extension-template/`).",
    "Its source files are below; these are in the template too and are not",
    `reprinted here: ${WORKED_EXAMPLE_REFERENCED.map((file) => `\`${file}\``).join(", ")}.`,
    "",
    renderFiles(worked)
  ].join("\n")
}

if (import.meta.main) {
  const output = render()
  writeFileSync("LLMS.md", output)
  console.error(`LLMS.md: ${output.length} characters`)
}
