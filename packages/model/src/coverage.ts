// Which files an extraction is responsible for, and which of them are reviewed.
//
//   bootstrap: every file tracked at the modelled commit (that is, every file git
//              does not ignore), vendored and generated trees included.
//   update:    every file added, modified, or renamed between meta.source.base and
//              meta.source.commit (the base must be an ancestor of the commit), plus
//              every file an element was derived from whose content hash no longer
//              matches (see sources.ts). Those elements are reported as outdated.
//
// Reviewed files come from the ledgers in <model-dir>/coverage/*.json whose
// `commit` is the modelled commit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, lines, tryGit, trackedFiles } from "./git.ts";
import { excludePathspecs, readConfig } from "./config.ts";
import { loadModel, readCoverage, type Ledger, type LedgerEntry } from "./model.ts";
import { outdatedElements, type OutdatedElement } from "./sources.ts";

export class CoverageError extends Error {}

/** Where a repository keeps its model; never itself required for coverage. */
export const MODEL_ROOT = ".feynman/";

export interface CoverageReport {
  mode: "bootstrap" | "update";
  commit: string;
  /** Update only: the previously modelled commit. */
  base?: string;
  required: string[];
  missing: string[];
  deleted: string[];
  /** Ledgers for other commits, ignored. */
  stale: string[];
  /** Ledger paths that are not files at the commit. */
  unknown: string[];
  /** Pathspecs excluded by .feynman/config.json. */
  exclude: string[];
  /** Update only: elements whose source files changed since they were derived. */
  outdated: OutdatedElement[];
  problems: string[];
}

/** Files under `exclude` in `.feynman/config.json` are never required. */
export function computeCoverage(repository: string, modelDir: string): CoverageReport {
  if (!existsSync(join(modelDir, "meta.json"))) throw new CoverageError(`${modelDir}: no model. Bootstrap one first.`);
  const { meta } = loadModel(modelDir);
  const { exclude } = readConfig(modelDir);
  const commit = tryGit(repository, "rev-parse", meta.source?.commit ?? "");
  if (!commit) throw new CoverageError(`meta.source.commit ${meta.source?.commit} is not a commit in ${repository}`);

  let mode: CoverageReport["mode"] = "bootstrap";
  let base: string | undefined;
  let required: string[];
  const deleted: string[] = [];
  let outdated: OutdatedElement[] = [];
  if (meta.extraction === "update") {
    mode = "update";
    const baseRef = meta.source.base?.commit;
    if (!baseRef) throw new CoverageError("update without meta.source.base.commit: name the previously modelled commit.");
    base = tryGit(repository, "rev-parse", baseRef) ?? undefined;
    const resolved = base;
    if (!resolved || tryGit(repository, "merge-base", "--is-ancestor", resolved, commit) === null) {
      throw new CoverageError(`base ${baseRef} is not an ancestor of ${commit.slice(0, 7)}.`);
    }
    required = [];
    const pathspecs = exclude.length ? ["--", ...excludePathspecs(exclude)] : [];
    for (const row of lines(git(repository, "diff", "--name-status", "--no-renames", resolved, commit, ...pathspecs))) {
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

  const files = new Set<string>();
  const trees: string[] = [];
  const stale: string[] = [];
  const problems: string[] = [];
  for (const { batch, value } of readCoverage(modelDir)) {
    if (value.commit !== commit) {
      stale.push(batch);
      continue;
    }
    for (const entry of value.files ?? []) {
      if (!entry.path.endsWith("/")) files.add(entry.path);
      else if (entry.outcome === "vendored" || entry.outcome === "generated" || entry.outcome === "development") trees.push(entry.path);
      else problems.push(`coverage/${batch}: ${entry.path} is a directory; only development, vendored, or generated trees may be listed whole`);
    }
  }
  const covered = (path: string) => files.has(path) || trees.some((tree) => path.startsWith(tree));
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
export function groupMissing(missing: string[]): [string, number][] {
  const groups = new Map<string, number>();
  for (const path of missing) {
    const key = path.split("/").slice(0, 2).join("/");
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** One line: "bootstrap at 66d8d86: 514 of 956 files reviewed". */
export function describeCoverage(report: CoverageReport): string {
  const where =
    report.mode === "update" ? `update ${report.base!.slice(0, 7)}..${report.commit.slice(0, 7)}` : `bootstrap at ${report.commit.slice(0, 7)}`;
  const excluding = report.exclude?.length ? ` (excluding ${report.exclude.join(", ")})` : "";
  return `${where}: ${report.required.length - report.missing.length} of ${report.required.length} files reviewed${excluding}`;
}

/**
 * Add entries to the ledger `coverage/<batch>.json` for `commit`, replacing earlier
 * entries for the same paths. Creates the ledger when needed.
 */
export function recordReviewed(modelDir: string, batch: string, commit: string, summary: string, entries: LedgerEntry[]): Ledger {
  const dir = join(modelDir, "coverage");
  const path = join(dir, `${batch}.json`);
  mkdirSync(dir, { recursive: true });
  const ledger: Ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { commit, summary, files: [] };
  if (ledger.commit !== commit) throw new CoverageError(`coverage/${batch}.json is for ${ledger.commit.slice(0, 7)}, not ${commit.slice(0, 7)}`);
  if (summary) ledger.summary = summary;
  const byPath = new Map(ledger.files.map((entry) => [entry.path, entry]));
  for (const entry of entries) byPath.set(entry.path, entry);
  ledger.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
  return ledger;
}
