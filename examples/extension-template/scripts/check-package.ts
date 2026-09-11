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
 * It runs offline: the peer dependencies are symlinked out of the repository's
 * own `node_modules`, and `sui-effect` out of the repository root, so nothing
 * here needs a registry.
 */
import { $ } from "bun"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const template = resolve(import.meta.dir, "..")
const repo = resolve(template, "..", "..")

const fail = (message: string): never => {
  console.error(`check-package: ${message}`)
  process.exit(1)
}

// The consumer resolves `sui-effect` out of the repository root, which must
// therefore have been built.
if (!existsSync(join(repo, "dist", "index.js"))) {
  fail("the sui-effect package is not built; run `bun run build` at the repository root first")
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
  const installed = join(modules, "@your-org", "example-extension")
  await mkdir(join(modules, "@your-org"), { recursive: true })
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

  await symlink(repo, join(modules, "sui-effect"), "dir")
  for (const peer of ["effect", "@mysten"]) {
    await symlink(join(repo, "node_modules", peer), join(modules, peer), "dir")
  }
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", private: true, type: "module" }, null, 2)
  )
  await writeFile(
    join(consumer, "consume.ts"),
    [
      `import { Escrow, escrow, receiptType } from "@your-org/example-extension"`,
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
