// Build a repository's simulator into public/s/<slug>/index.html with `feynman build`, and
// record the commit it was built from in sims.json. The page is committed: the site deploys
// as static assets, until a Worker builds simulators on request.
//
//   bun run sim github.com/leostera/axo ../axo
//
// The repository must be a clean checkout whose origin is the one the slug names, so the
// page's code links point at the commit it was built from.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Sim {
  /** `<host>/<owner>/<repo>`: the page is served at /s/<slug>/. */
  slug: string;
  title: string;
  summary: string;
  repository: string;
  /** The commit the committed page was built from. */
  commit: string | null;
}

const [slug, checkout] = process.argv.slice(2);
if (!slug || !checkout) {
  console.error("usage: bun run sim <host/owner/repo> <path to a checkout>");
  process.exit(2);
}
const site = resolve(import.meta.dirname, "..");
const listed: Sim[] = JSON.parse(readFileSync(join(site, "sims.json"), "utf8"));
const sim = listed.find((s) => s.slug === slug);
if (!sim) {
  console.error(`${slug} is not in sims.json; add it there first`);
  process.exit(2);
}
const dir = resolve(checkout);
const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" }).stdout.trim();
if (git("status", "--porcelain")) {
  console.error(`${dir} has uncommitted changes; build from a clean checkout`);
  process.exit(1);
}
const cli = resolve(site, "../../packages/cli/bin/feynman.ts");
const out = join(site, "public/s", slug, "index.html");
const build = spawnSync("bun", [cli, "build", "--out", out], { cwd: dir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
sim.commit = git("rev-parse", "HEAD");
writeFileSync(join(site, "sims.json"), JSON.stringify(listed, null, 2) + "\n");
console.log(`published ${slug} at ${sim.commit.slice(0, 7)}`);
