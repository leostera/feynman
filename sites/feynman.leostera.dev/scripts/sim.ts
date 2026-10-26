// Point a simulator at a new commit: record the commit and the specs it holds in sims.json,
// and fetch the commit into the clone scripts/pages.ts builds from, so a commit not yet
// pushed builds too. The page itself is built by pages.ts, on every build and deploy.
//
//   bun run sim github.com/leostera/axo ../axo
//
// The checkout must be clean, so the page's code links point at exactly what it was built from.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { checkoutOf, cloneOf, specsIn } from "./pages.ts";
import { readSims, writeSims } from "./sims.ts";

const [slug, checkout] = process.argv.slice(2);
if (!slug || !checkout) {
  console.error("usage: bun run sim <host/owner/repo> <path to a checkout>");
  process.exit(2);
}
const sims = readSims();
const sim = sims.find((s) => s.slug === slug);
if (!sim) {
  console.error(`${slug} is not in sims.json; add it there first`);
  process.exit(2);
}
const dir = resolve(checkout);
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });
if (git(dir, "status", "--porcelain").stdout.trim()) {
  console.error(`${dir} has uncommitted changes; point at a clean checkout`);
  process.exit(1);
}
sim.commit = git(dir, "rev-parse", "HEAD").stdout.trim();
if (git(cloneOf(sim), "fetch", "--quiet", dir, sim.commit).status !== 0) process.exit(1);
sim.specs = specsIn(checkoutOf(sim));
writeSims(sims);
console.log(`${slug} now at ${sim.commit.slice(0, 7)}, ${sim.specs.length} spec(s); bun run build to see it`);
