#!/usr/bin/env node
// Check that an extraction reviewed every file it had to.
//
//   bootstrap: every file tracked at the modelled commit (that is, every file git
//              does not ignore), vendored and generated trees included.
//   update:    every file added, modified, or renamed between meta.source.base and
//              meta.source.commit. The base must be an ancestor of the commit.
//
// Reviewed files come from the ledgers in <model-dir>/coverage/*.json whose
// `commit` is the modelled commit. Exits non-zero while anything is unreviewed.
//
// Usage: node tools/coverage.mjs <repository> <model-dir> [--missing]
//   --missing  print every unreviewed path, one per line, for batching work.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadModel, readCoverage } from "./model.mjs";

const [repository, modelDir, ...flags] = process.argv.slice(2);
if (!repository || !modelDir) {
  console.error("usage: coverage <repository> <model-dir> [--missing]");
  process.exit(2);
}
const git = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const lines = (text) => (text ? text.split("\n") : []);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

if (!existsSync(join(modelDir, "meta.json"))) fail(`${modelDir}: no model. Bootstrap one first.`);
const { meta } = loadModel(modelDir);
const commit = git("rev-parse", meta.source.commit);

// Files this extraction is responsible for.
let required;
let deleted = [];
if (meta.extraction === "update") {
  const baseRef = meta.source.base?.commit;
  if (!baseRef) fail("update without meta.source.base.commit: name the previously modelled commit.");
  const base = git("rev-parse", baseRef);
  try {
    git("merge-base", "--is-ancestor", base, commit);
  } catch {
    fail(`base ${base.slice(0, 7)} is not an ancestor of ${commit.slice(0, 7)}.`);
  }
  required = [];
  for (const row of lines(git("diff", "--name-status", "--no-renames", base, commit))) {
    const [status, path] = row.split("\t");
    if (status === "D") deleted.push(path);
    else required.push(path);
  }
} else {
  required = lines(git("ls-tree", "-r", "--name-only", commit));
}

// What the ledgers for this commit say was reviewed.
const files = new Set();
const trees = [];
const stale = [];
for (const { batch, value } of readCoverage(modelDir)) {
  if (value.commit !== commit) {
    stale.push(batch);
    continue;
  }
  for (const entry of value.files) {
    if (entry.path.endsWith("/")) {
      if (entry.outcome === "vendored" || entry.outcome === "generated") trees.push(entry.path);
      else console.error(`coverage/${batch}: ${entry.path} is a directory; only vendored or generated trees may be listed whole`);
    } else files.add(entry.path);
  }
}
const covered = (path) => files.has(path) || trees.some((tree) => path.startsWith(tree));
const missing = required.filter((path) => !covered(path));
const known = new Set(lines(git("ls-tree", "-r", "--name-only", commit)));
const unknown = [...files].filter((path) => !known.has(path));

if (flags.includes("--missing")) {
  for (const path of missing) console.log(path);
  process.exit(missing.length ? 1 : 0);
}

const mode = meta.extraction === "update" ? `update ${meta.source.base.commit.slice(0, 7)}..${commit.slice(0, 7)}` : `bootstrap at ${commit.slice(0, 7)}`;
console.log(`${mode}: ${required.length - missing.length} of ${required.length} files reviewed`);
if (deleted.length) console.log(`${deleted.length} deleted; check-model reports any anchor still pointing at them`);
if (stale.length) console.log(`ignored ledgers for other commits: ${stale.join(", ")}`);
if (unknown.length) console.log(`ledgers name ${unknown.length} paths not in the commit, e.g. ${unknown.slice(0, 3).join(", ")}`);
if (missing.length) {
  // Group by the first two path segments so work can be split into batches.
  const groups = new Map();
  for (const path of missing) {
    const key = path.split("/").slice(0, 2).join("/");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  console.log("unreviewed:");
  for (const [group, n] of [...groups].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${group}`);
  process.exit(1);
}
