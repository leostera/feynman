#!/usr/bin/env node
// Fill the mechanical parts of a model from git: source links, commit age, position
// relative to main, and code footprints (files and lines) for actors and the repository.
//
// Usage: node tools/measure.mjs <repository> <model-dir> [--main <ref>]
//
// Agents decide which paths belong to an actor (`actors/<id>.json` → `footprint.paths`); this tool
// only counts. Counts are taken at the model's commit, not the working tree.
import { execFileSync } from "node:child_process";
import { KINDS, loadModel, writeElement, writeMeta } from "./model.mjs";

// Paths never counted, unless the model lists its own `meta.source.footprint.excludes`.
const DEFAULT_EXCLUDES = ["vendor/", "third_party/", "*.lock", "package-lock.json", "*.lock.json"];

const [repository, modelDir, ...rest] = process.argv.slice(2);
if (!repository || !modelDir) {
  console.error("usage: measure <repository> <model-dir> [--main <ref>]");
  process.exit(2);
}
const mainRef = rest[0] === "--main" && rest[1] ? rest[1] : "main";

const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const tryGit = (...args) => {
  try {
    return git(...args);
  } catch {
    return null;
  }
};

const model = loadModel(modelDir);
const source = model.meta.source;
const excludes = source.footprint?.excludes ?? DEFAULT_EXCLUDES;
const EXCLUDES = excludes.map((pattern) => `:!${pattern}`);
const commit = git("rev-parse", source.commit);
source.commit = commit;
source.committedAt = git("log", "-1", "--format=%cI", commit);

const web = webUrl(tryGit("remote", "get-url", "origin"));
if (web) {
  source.url = web;
  source.commitUrl = `${web}/commit/${commit}`;
  source.fileUrl = `${web}/blob/${commit}/{path}`;
}

const main = tryGit("rev-parse", mainRef);
if (main) {
  const [behind, ahead] = git("rev-list", "--left-right", "--count", `${main}...${commit}`).split(/\s+/).map(Number);
  source.main = { ref: mainRef, commit: main, ahead, behind, checkedAt: new Date().toISOString() };
}

source.footprint = { ...count(["."]), excludes };
for (const actor of model.actors) {
  if (!actor.footprint?.paths?.length) continue;
  Object.assign(actor.footprint, count(actor.footprint.paths));
}

writeMeta(modelDir, model.meta);
const actorKind = KINDS.find((kind) => kind.key === "actors");
for (const actor of model.actors) if (actor.footprint) writeElement(modelDir, actorKind, actor);
console.log(
  `measured ${model.actors.filter((actor) => actor.footprint).length} actors; repository ${source.footprint.lines} lines` +
    (source.main ? `; ${source.main.behind} behind / ${source.main.ahead} ahead of ${mainRef}` : ""),
);

/** Text files and lines under `paths` at the model's commit. */
function count(paths) {
  // `git grep -c ''` prints `<commit>:<path>:<lines>` for every non-binary file.
  const out = tryGit("grep", "-I", "-c", "", commit, "--", ...paths, ...EXCLUDES) ?? "";
  let files = 0;
  let lines = 0;
  for (const row of out.split("\n")) {
    const n = Number(row.slice(row.lastIndexOf(":") + 1));
    if (!row || Number.isNaN(n)) continue;
    files += 1;
    lines += n;
  }
  return { files, lines };
}

/** A browsable https URL for common git remotes, or null. */
function webUrl(remote) {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}
