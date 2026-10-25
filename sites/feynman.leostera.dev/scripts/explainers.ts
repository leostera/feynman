// Build the explainers listed in explainers.json into public/explainers/<name>/ with
// `feynman build`, and list the ones built in public/explainers/index.json for the page.
// A repository whose specs do not build is skipped, so the site always builds.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Explainer {
  name: string;
  title: string;
  summary: string;
  /** The repository holding the specs, relative to this site. */
  repository: string;
}

const site = resolve(import.meta.dirname, "..");
const cli = resolve(site, "../../packages/cli/bin/feynman.ts");
const out = join(site, "public/explainers");
const listed: Explainer[] = JSON.parse(readFileSync(join(site, "explainers.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const published: Omit<Explainer, "repository">[] = [];
for (const { repository, ...explainer } of listed) {
  const dir = resolve(site, repository);
  if (!existsSync(dir)) {
    console.warn(`skipping ${explainer.name}: no repository at ${repository}`);
    continue;
  }
  const build = spawnSync("bun", [cli, "build", "--out", join(out, explainer.name)], { cwd: dir, encoding: "utf8" });
  if (build.status !== 0) {
    console.warn(`skipping ${explainer.name}: ${(build.stderr || build.stdout).trim().split("\n")[0]}`);
    continue;
  }
  published.push(explainer);
  console.log(`built ${explainer.name}`);
}
writeFileSync(join(out, "index.json"), JSON.stringify(published, null, 2) + "\n");
