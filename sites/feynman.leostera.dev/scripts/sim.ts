// Build a repository's simulator into public/s/<slug>/index.html with `feynman build`, write
// its check report beside it as check.txt (for agents), and record the commit and specs in
// sims.json. The pages are committed: the site deploys as static assets, until a Worker
// builds simulators on request.
//
//   bun run sim github.com/leostera/axo ../axo
//
// The repository must be a clean checkout whose origin is the one the slug names, so the
// page's code links point at the commit it was built from.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSims, writeSims } from "./sims.ts";

const [slug, checkout] = process.argv.slice(2);
if (!slug || !checkout) {
  console.error("usage: bun run sim <host/owner/repo> <path to a checkout>");
  process.exit(2);
}
const site = resolve(import.meta.dirname, "..");
const sims = readSims();
const sim = sims.find((s) => s.slug === slug);
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
const feynman = (...args: string[]) => spawnSync("bun", [cli, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 1 << 26 });
const out = join(site, "public/s", slug);
const build = spawnSync("bun", [cli, "build", "--out", join(out, "index.html")], { cwd: dir, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);
// check exits non-zero when a rule breaks; the report is what matters.
writeFileSync(join(out, "check.txt"), feynman("check").stdout);
sim.commit = git("rev-parse", "HEAD");
sim.specs = feynman("list")
  .stdout.trim()
  .split("\n")
  .map((line) => line.split(/\s{2,}/))
  .map(([path, title]) => ({ path, title }));
writeSims(sims);
console.log(`published ${slug} at ${sim.commit.slice(0, 7)}`);
