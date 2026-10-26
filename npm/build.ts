// Stage @leostera/feynman in dist/npm: one package holding the workspace's spec, check, code,
// cli and play sources, the prebuilt view, and the skill. It runs on Bun, which runs the
// TypeScript as shipped; the CLI needs the sources anyway, to bundle and type-check specs.
//
//   bun npm/build.ts && (cd dist/npm && npm publish --access public)
//
// Workspace imports (`@feynman/spec`) become subpaths of the package (`@leostera/feynman/spec`),
// which resolve to the package itself through its exports.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const NAME = "@leostera/feynman";
const VERSION = "0.1.0";
const root = join(import.meta.dirname, "..");
const out = join(root, "dist", "npm");
/** Workspace packages shipped as sources, without their tests. */
const SOURCES = ["spec", "check", "code", "cli", "play"] as const;
/** Libraries the CLI needs at run time, besides the shipped packages' own dependencies: React's types type-check playgrounds. */
const EXTRA: Record<string, string> = { "@types/react": "^19.3.0" };

type Manifest = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const manifest = (pkg: string): Manifest => JSON.parse(readFileSync(join(root, "packages", pkg, "package.json"), "utf8"));

function stage() {
  rmSync(out, { recursive: true, force: true });
  for (const pkg of SOURCES) {
    for (const dir of ["src", "bin"]) {
      const from = join(root, "packages", pkg, dir);
      if (existsSync(from)) cpSync(from, join(out, pkg, dir), { recursive: true });
    }
    writeFileSync(join(out, pkg, "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  }
  // The view ships built; the CLI reads its data types from its one source file.
  const view = join(root, "packages", "view");
  const built = spawnSync("bun", ["run", "build"], { cwd: view, stdio: "inherit" });
  if (built.status !== 0) throw new Error("the view did not build");
  cpSync(join(view, "dist"), join(out, "view", "dist"), { recursive: true });
  mkdirSync(join(out, "view", "src"), { recursive: true });
  cpSync(join(view, "src", "data.ts"), join(out, "view", "src", "data.ts"));
  writeFileSync(join(out, "view", "package.json"), JSON.stringify({ type: "module", private: true }) + "\n");
  cpSync(join(root, "skills", "feynman"), join(out, "skills", "feynman"), { recursive: true });
  cpSync(join(import.meta.dirname, "README.md"), join(out, "README.md"));
}

/** `from "@feynman/x"`, `import("@feynman/x")`, `resolveSync("@feynman/x…")` → the package's own subpath. */
function rewriteImports(dir: string) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) rewriteImports(path);
    else if (/\.tsx?$/.test(entry)) {
      const code = readFileSync(path, "utf8");
      const next = code.replace(/((?:\bfrom|\bimport\(|resolveSync\()\s*)"@feynman\//g, `$1"${NAME}/`);
      if (next !== code) writeFileSync(path, next);
    }
  }
}

function dependencies(): Record<string, string> {
  const all: Record<string, string> = { ...EXTRA };
  for (const pkg of SOURCES)
    for (const [name, range] of Object.entries(manifest(pkg).dependencies ?? {})) if (!range.startsWith("workspace:")) all[name] = range;
  return Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
}

function packageJson() {
  const sub = (pkg: string, file = "src/index.ts") => `./${pkg}/${file}`;
  return {
    name: NAME,
    version: VERSION,
    description: "Executable specs of how a system behaves: a simulator, a model checker, flows and their diffs, derived from one TypeScript file.",
    type: "module",
    homepage: "https://feynman.leostera.dev",
    keywords: ["specification", "model-checking", "simulation", "distributed-systems", "pi-package"],
    engines: { bun: ">=1.3" },
    bin: { feynman: "./cli/bin/feynman.ts" },
    exports: {
      ".": sub("spec"),
      "./play": sub("play"),
      "./config": sub("cli"),
      ...Object.fromEntries(SOURCES.map((pkg) => [`./${pkg}`, sub(pkg)])),
      ...Object.fromEntries(SOURCES.map((pkg) => [`./${pkg}/package.json`, `./${pkg}/package.json`])),
      "./view/data": "./view/src/data.ts",
      "./view/package.json": "./view/package.json",
    },
    pi: { skills: ["./skills"] },
    dependencies: dependencies(),
  };
}

stage();
rewriteImports(out);
const left = spawnSync("grep", ["-rln", '"@feynman/', out], { encoding: "utf8" }).stdout.trim();
if (left) console.log(`still naming @feynman/ (alias tables and docs are expected):\n${left.split("\n").map((p) => `  ${relative(out, p)}`).join("\n")}`);
writeFileSync(join(out, "package.json"), JSON.stringify(packageJson(), null, 2) + "\n");
console.log(`staged ${NAME}@${VERSION} in ${relative(process.cwd(), out) || "."}`);
