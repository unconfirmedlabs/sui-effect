/**
 * The check the template's own tests cannot do: build the package, pack the
 * tarball, install it into a throwaway consumer, and import it.
 *
 * `tsc --noEmit` and `bun test` both import `src/`, so both pass for a package
 * whose `exports` point at a `dist/` that is never built and whose `files` list
 * therefore ships nothing. That is exactly the state this template was in. The
 * only way to catch it is to look at what `npm pack` produces and to load it
 * the way a consumer will.
 *
 * It runs offline, and it works **after you copy the template out**: the
 * consumer's `sui-effect`, `effect` and `@mysten/*` are symlinked out of this
 * package's own `node_modules` when it has them, which is what a copied-out
 * package has after `bun install`. Only when neither is there does it fall back
 * to the sui-effect repository two directories up, which is how it runs inside
 * that repository with no install of its own. Keep the script when you copy;
 * you should not have to rewrite it.
 */
import { $ } from "bun"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const template = resolve(import.meta.dir, "..")
const templateModules = join(template, "node_modules")

/**
 * The sui-effect checkout this template lives inside, or `undefined` when it
 * has been copied out.
 *
 * Two directories up is only the library when it really is: a copied-out
 * template's grandparent is somebody's `projects/` directory, and symlinking
 * that in as `sui-effect` is how a copier's first `bun run check` failed with a
 * message about a `dist` that was never going to exist.
 */
const repoOf = (): string | undefined => {
  const candidate = resolve(template, "..", "..")
  const manifest = join(candidate, "package.json")
  if (!existsSync(manifest)) return undefined
  try {
    return JSON.parse(readFileSync(manifest, "utf8")).name === "sui-effect" ? candidate : undefined
  } catch {
    return undefined
  }
}

const repo = repoOf()

const fail = (message: string): never => {
  console.error(`check-package: ${message}`)
  process.exit(1)
}

/**
 * Where the consumer's copy of one package comes from: this template's own
 * `node_modules` first, the sui-effect repository's second.
 */
const sourceOf = (name: string): string | undefined => {
  const own = join(templateModules, name)
  if (existsSync(own)) return own
  if (repo === undefined) return undefined
  const inRepo = name === "sui-effect" ? repo : join(repo, "node_modules", name)
  return existsSync(inRepo) ? inRepo : undefined
}

const suiEffect = sourceOf("sui-effect")
if (suiEffect === undefined) {
  fail(
    "no sui-effect to check against: run `bun install` in this package, or run the script " +
      "from inside the sui-effect repository"
  )
}
// Whichever copy it is, the consumer imports its `exports` map, so it must be
// built. A published tarball always is; a repository checkout may not be.
if (!existsSync(join(suiEffect!, "dist", "index.js"))) {
  fail(
    `the sui-effect at ${suiEffect} is not built; run \`bun run build\` there first`
  )
}

await rm(join(template, "dist"), { recursive: true, force: true })
await $`bun x tsc -p ${join(template, "tsconfig.build.json")}`.cwd(template).quiet()

const work = await mkdtemp(join(tmpdir(), "sui-effect-template-"))
try {
  await $`bun pm pack --destination ${work}`.cwd(template).quiet()
  const packed = (await readdir(work)).filter((name) => name.endsWith(".tgz"))
  const tarball = packed[0]
  if (tarball === undefined) fail("bun pm pack produced no tarball")

  // Extracted straight into the consumer's `node_modules`, where a real
  // install would put it: a package resolves its own dependencies from where it
  // lives, so unpacking it elsewhere and linking it in would fail on `effect`
  // for reasons that have nothing to do with the package.
  const consumer = join(work, "consumer")
  const modules = join(consumer, "node_modules")
  const name = JSON.parse(readFileSync(join(template, "package.json"), "utf8")).name as string
  const [scope, bare] = name.startsWith("@") ? name.split("/") : [undefined, name]
  const installed = join(modules, ...(scope === undefined ? [bare!] : [scope, bare!]))
  await mkdir(scope === undefined ? modules : join(modules, scope), { recursive: true })
  const extracted = join(work, "extracted")
  await mkdir(extracted, { recursive: true })
  await $`tar -xzf ${join(work, tarball!)} -C ${extracted}`.quiet()
  await $`mv ${join(extracted, "package")} ${installed}`.quiet()

  // What a consumer actually gets: the files the `files` list shipped, at the
  // paths the `exports` map names.
  for (const required of ["dist/index.js", "dist/index.d.ts", "package.json", "README.md"]) {
    if (!existsSync(join(installed, required))) {
      fail(`the packed tarball has no ${required}; check "files" and the build script`)
    }
  }

  await symlink(suiEffect!, join(modules, "sui-effect"), "dir")
  for (const peer of ["effect", "@mysten"]) {
    const source = sourceOf(peer)
    if (source === undefined) {
      fail(`no ${peer} to link into the consumer: run \`bun install\` in this package first`)
    }
    await symlink(source!, join(modules, peer), "dir")
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)
  )
  await writeFile(
    join(consumer, "consume.ts"),
    [
      `import { Escrow, escrow, receiptType } from "${name}"`,
      `if (typeof Escrow.layerTest !== "function") throw new Error("Escrow.layerTest is missing")`,
      `if (typeof escrow !== "function") throw new Error("the registration factory is missing")`,
      `if (!receiptType("0x2").endsWith("::escrow::Receipt")) throw new Error("receiptType is wrong")`,
      `console.log("ok")`,
      ""
    ].join("\n")
  )
  const ran = await $`bun run ${join(consumer, "consume.ts")}`.cwd(consumer).quiet().nothrow()
  if (ran.exitCode !== 0) {
    fail(`the packed package did not import in a consumer:\n${ran.stderr.toString()}`)
  }
  console.log("check-package: the packed tarball imports in a fresh consumer")
} finally {
  await rm(work, { recursive: true, force: true })
}
