// Render the explainers listed in explainers.json into public/explainers/<name>/,
// and list the ones rendered in public/explainers/index.json for the page.
// Models that do not exist yet, or are not valid (say, mid-extraction), are skipped,
// so the site always builds and never publishes a broken explainer.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkModel } from "@feynman/model";
import { renderModel } from "@feynman/modeler";

interface Explainer {
  name: string;
  title: string;
  summary: string;
  /** Model directory, relative to this site. */
  model: string;
}

const site = resolve(import.meta.dirname, "..");
const out = join(site, "public/explainers");
const listed: Explainer[] = JSON.parse(readFileSync(join(site, "explainers.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const published: Omit<Explainer, "model">[] = [];
for (const { model, ...explainer } of listed) {
  const dir = resolve(site, model);
  if (!existsSync(join(dir, "meta.json"))) {
    console.warn(`skipping ${explainer.name}: no model at ${model}`);
    continue;
  }
  const problems = checkModel(dir);
  if (problems.length) {
    console.warn(`skipping ${explainer.name}: ${problems.length} model problem(s), e.g. ${problems[0]}`);
    continue;
  }
  await renderModel(dir, join(out, explainer.name, "index.html"));
  published.push(explainer);
  console.log(`rendered ${explainer.name}`);
}
writeFileSync(join(out, "index.json"), JSON.stringify(published, null, 2) + "\n");
