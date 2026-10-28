// Assemble public/, which is never committed: the hand-made files in static/, and every
// simulator in sims.json built into public/s/<slug>/ with its check report. Runs before
// every build, dev server and deploy.
//
// A simulator of another repository is built from a clone at the commit sims.json records,
// kept in .cache/repos/<slug> (`bun run sim` points it at a new commit). One marked
// "build": "deploy", such as the examples, is built from this repository as it is.
//
//   bun scripts/pages.ts
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSims, writeSims, type Sim } from "./sims.ts";

const site = resolve(import.meta.dirname, "..");
/** The package: its CLI, and its examples, which the site publishes as a simulator. */
const pkg = resolve(site, "../../packages/feynman");
const cli = join(pkg, "bin/feynman.ts");
const publicDir = join(site, "public");

/** Run the CLI in a checkout; NO_COLOR keeps the check report plain text. */
const feynman = (cwd: string, ...args: string[]) => spawnSync("bun", [cli, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 1 << 26 });

function git(cwd: string, ...args: string[]) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}:\n${out.stderr}`);
  return out.stdout.trim();
}

/** The cached clone of a simulator's repository, cloned on first use. */
export function cloneOf(sim: Sim): string {
  const dir = join(site, ".cache/repos", sim.slug);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, "clone", "--quiet", sim.repository, ".");
  }
  return dir;
}

/** Where a simulator's specs are: this repository's package, or its clone at the recorded commit. */
export function checkoutOf(sim: Sim): string {
  if (sim.build === "deploy") return pkg;
  if (!sim.commit) throw new Error(`${sim.slug} has no commit in sims.json; run bun run sim first`);
  const dir = cloneOf(sim);
  // The commit may be here already (bun run sim fetches it from a local checkout); else ask the remote.
  if (spawnSync("git", ["cat-file", "-e", `${sim.commit}^{commit}`], { cwd: dir }).status !== 0) git(dir, "fetch", "--quiet", "origin");
  git(dir, "checkout", "--quiet", "--force", sim.commit);
  if (!existsSync(join(dir, "node_modules")) && existsSync(join(dir, "package.json"))) spawnSync("bun", ["install", "--silent"], { cwd: dir, stdio: "inherit" });
  return dir;
}

/** The specs a checkout holds, as `feynman list` names them. */
export function specsIn(dir: string): Sim["specs"] {
  const list = feynman(dir, "list");
  if (list.status !== 0) throw new Error(`specs in ${dir} do not load:\n${list.stderr}`);
  return list.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(/\s{2,}/))
    .map(([path, title]) => ({ path, title }));
}

function buildPage(sim: Sim) {
  const dir = checkoutOf(sim);
  const out = join(publicDir, "s", sim.slug);
  mkdirSync(out, { recursive: true });
  const build = feynman(dir, "build", "--out", join(out, "index.html"));
  if (build.status !== 0) throw new Error(`feynman build failed for ${sim.slug}:\n${build.stdout}${build.stderr}`);
  // check exits non-zero when a rule breaks, as the buggy examples do; the report is what matters.
  writeFileSync(join(out, "check.txt"), feynman(dir, "check").stdout);
  if (sim.build === "deploy") sim.specs = specsIn(dir);
  console.log(`built /s/${sim.slug}/ (${sim.specs.length} spec(s))`);
}

if (import.meta.main) {
  rmSync(publicDir, { recursive: true, force: true });
  cpSync(join(site, "static"), publicDir, { recursive: true });
  const sims = readSims();
  for (const sim of sims) buildPage(sim);
  writeSims(sims);
}
