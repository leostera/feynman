// Build the simulators that come from this repository (sims.json entries with "build":
// "deploy"), such as the examples, into public/s/<slug>/: the page and its check report.
// Run before every build, dev server and deploy, so the site always carries the examples as
// they are in this tree. The output is gitignored; sims.json keeps the list of specs.
//
//   bun scripts/examples.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readSims, writeSims } from "./sims.ts";

const site = resolve(import.meta.dirname, "..");
const root = resolve(site, "../..");
const cli = join(root, "bin/feynman.ts");
const feynman = (...args: string[]) => spawnSync("bun", [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, maxBuffer: 1 << 26 });

const sims = readSims();
for (const sim of sims.filter((s) => s.build === "deploy")) {
  const out = join(site, "public/s", sim.slug);
  mkdirSync(out, { recursive: true });
  const build = feynman("build", "--out", join(out, "index.html"));
  if (build.status !== 0) {
    console.error(build.stdout, build.stderr);
    process.exit(build.status ?? 1);
  }
  // check exits non-zero when a rule breaks, as every buggy example does; the report is what matters.
  writeFileSync(join(out, "check.txt"), feynman("check").stdout);
  sim.specs = feynman("list")
    .stdout.trim()
    .split("\n")
    .map((line) => line.split(/\s{2,}/))
    .map(([path, title]) => ({ path, title }));
  console.log(`built ${sim.slug} (${sim.specs.length} specs)`);
}
writeSims(sims);
