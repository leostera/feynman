// Which files an extraction is responsible for, and which of them are reviewed.
//
//   bootstrap: every file tracked at the modelled commit (that is, every file git
//              does not ignore), vendored and generated trees included.
//   update:    every file added, modified, or renamed between meta.source.base and
//              meta.source.commit (the base must be an ancestor of the commit), plus
//              every file an element was derived from whose content hash no longer
//              matches (see sources.mjs). Those elements are reported as outdated.
//
// Reviewed files come from the ledgers in <model-dir>/coverage/*.json whose
// `commit` is the modelled commit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, lines, tryGit, trackedFiles } from "./git.mjs";
import { excludePathspecs, readConfig } from "./config.mjs";
import { loadModel, readCoverage } from "./model.mjs";
import { outdatedElements } from "./sources.mjs";

export class CoverageError extends Error {}

/** Where a repository keeps its model; never itself required for coverage. */
export const MODEL_ROOT = ".feynman/";

/**
 * Files under `exclude` in `.feynman/config.json` are never required.
 *
 * @returns {{ mode: "bootstrap" | "update", commit: string, base?: string, required: string[],
 *   missing: string[], deleted: string[], stale: string[], unknown: string[], exclude: string[],
 *   outdated: { kind: string, id: string, files: string[] }[], problems: string[] }}
 */
export function computeCoverage(repository, modelDir) {
  if (!existsSync(join(modelDir, "meta.json"))) throw new CoverageError(`${modelDir}: no model. Bootstrap one first.`);
  const { meta } = loadModel(modelDir);
  const { exclude } = readConfig(modelDir);
  const commit = tryGit(repository, "rev-parse", meta.source?.commit ?? "");
  if (!commit) throw new CoverageError(`meta.source.commit ${meta.source?.commit} is not a commit in ${repository}`);

  let mode = "bootstrap";
  let base;
  let required;
  const deleted = [];
  let outdated = [];
  if (meta.extraction === "update") {
    mode = "update";
    const baseRef = meta.source.base?.commit;
    if (!baseRef) throw new CoverageError("update without meta.source.base.commit: name the previously modelled commit.");
    base = tryGit(repository, "rev-parse", baseRef);
    if (!base || tryGit(repository, "merge-base", "--is-ancestor", base, commit) === null) {
      throw new CoverageError(`base ${baseRef} is not an ancestor of ${commit.slice(0, 7)}.`);
    }
    required = [];
    const pathspecs = exclude.length ? ["--", ...excludePathspecs(exclude)] : [];
    for (const row of lines(git(repository, "diff", "--name-status", "--no-renames", base, commit, ...pathspecs))) {
      const [status, path] = row.split("\t");
      if (status === "D") deleted.push(path);
      else required.push(path);
    }
    // Hashes catch what the diff cannot, e.g. a base rewritten by a rebase.
    outdated = outdatedElements(repository, modelDir, commit);
    const present = new Set(trackedFiles(repository, commit, exclude));
    for (const { files } of outdated) {
      for (const file of files) {
        if (present.has(file)) {
          if (!required.includes(file)) required.push(file);
        } else if (!deleted.includes(file)) deleted.push(file);
      }
    }
  } else {
    required = trackedFiles(repository, commit, exclude);
  }
  // The model describes the repository; it is not part of what it describes.
  required = required.filter((path) => !path.startsWith(MODEL_ROOT));

  const files = new Set();
  const trees = [];
  const stale = [];
  const problems = [];
  for (const { batch, value } of readCoverage(modelDir)) {
    if (value.commit !== commit) {
      stale.push(batch);
      continue;
    }
    for (const entry of value.files ?? []) {
      if (!entry.path.endsWith("/")) files.add(entry.path);
      else if (entry.outcome === "vendored" || entry.outcome === "generated") trees.push(entry.path);
      else problems.push(`coverage/${batch}: ${entry.path} is a directory; only vendored or generated trees may be listed whole`);
    }
  }
  const covered = (path) => files.has(path) || trees.some((tree) => path.startsWith(tree));
  const known = new Set(trackedFiles(repository, commit, exclude));
  return {
    mode,
    commit,
    base,
    required,
    missing: required.filter((path) => !covered(path)),
    deleted,
    stale,
    unknown: [...files].filter((path) => !known.has(path)),
    exclude,
    outdated,
    problems,
  };
}

/** Missing paths grouped by their first two segments, largest group first. */
export function groupMissing(missing) {
  const groups = new Map();
  for (const path of missing) {
    const key = path.split("/").slice(0, 2).join("/");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** One line: "bootstrap at 66d8d86: 514 of 956 files reviewed". */
export function describeCoverage(report) {
  const where =
    report.mode === "update" ? `update ${report.base.slice(0, 7)}..${report.commit.slice(0, 7)}` : `bootstrap at ${report.commit.slice(0, 7)}`;
  const excluding = report.exclude?.length ? ` (excluding ${report.exclude.join(", ")})` : "";
  return `${where}: ${report.required.length - report.missing.length} of ${report.required.length} files reviewed${excluding}`;
}

/**
 * Add entries to the ledger `coverage/<batch>.json` for `commit`, replacing earlier
 * entries for the same paths. Creates the ledger when needed.
 */
export function recordReviewed(modelDir, batch, commit, summary, entries) {
  const dir = join(modelDir, "coverage");
  const path = join(dir, `${batch}.json`);
  mkdirSync(dir, { recursive: true });
  const ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { commit, summary, files: [] };
  if (ledger.commit !== commit) throw new CoverageError(`coverage/${batch}.json is for ${ledger.commit.slice(0, 7)}, not ${commit.slice(0, 7)}`);
  if (summary) ledger.summary = summary;
  const byPath = new Map(ledger.files.map((entry) => [entry.path, entry]));
  for (const entry of entries) byPath.set(entry.path, entry);
  ledger.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
  return ledger;
}
