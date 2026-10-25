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
import { tryGit } from "./git.ts";
import { readConfig } from "./config.ts";
import { changedFiles, snapshotBlobIds, snapshotFiles, snapshotOf } from "./snapshot.ts";
import { loadModel, readCoverage, type Ledger, type LedgerEntry } from "./model.ts";
import { blobIds, outdatedElements, type OutdatedElement } from "./sources.ts";

export class CoverageError extends Error {}

/** Where a repository keeps its model; never itself required for coverage. */
export const MODEL_ROOT = ".feynman/";

export interface CoverageReport {
  mode: "bootstrap" | "update";
  commit: string;
  /** Whether the model includes uncommitted changes on top of `commit`. */
  worktree: boolean;
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

/**
 * Files under `exclude` in `.feynman/config.json` are never required. For a model
 * of the working tree, a file counts as read only while it still has the content
 * that was read: the hash its ledger entry records, or its content at the commit
 * when the entry records none.
 */
export function computeCoverage(repository: string, modelDir: string): CoverageReport {
  if (!existsSync(join(modelDir, "meta.json"))) throw new CoverageError(`${modelDir}: no model. Bootstrap one first.`);
  const { meta } = loadModel(modelDir);
  const { exclude } = readConfig(modelDir);
  const commit = tryGit(repository, "rev-parse", meta.source?.commit ?? "");
  if (!commit) throw new CoverageError(`meta.source.commit ${meta.source?.commit} is not a commit in ${repository}`);
  const snapshot = snapshotOf(repository, { ...meta.source, commit });
  const present = new Set(snapshotFiles(snapshot, exclude));

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
    const diff = changedFiles(snapshot, resolved, exclude);
    required = diff.changed;
    deleted.push(...diff.deleted);
    // Hashes catch what the diff cannot, e.g. a base rewritten by a rebase.
    outdated = outdatedElements(repository, modelDir, snapshot.worktree ? null : commit);
    for (const { files } of outdated) {
      for (const file of files) {
        if (present.has(file)) {
          if (!required.includes(file)) required.push(file);
        } else if (!deleted.includes(file)) deleted.push(file);
      }
    }
  } else {
    required = [...present];
  }
  // The model describes the repository; it is not part of what it describes.
  required = required.filter((path) => !path.startsWith(MODEL_ROOT));

  const entries = new Map<string, LedgerEntry>();
  const trees: string[] = [];
  const stale: string[] = [];
  const problems: string[] = [];
  for (const { batch, value } of readCoverage(modelDir)) {
    if (value.commit !== commit) {
      stale.push(batch);
      continue;
    }
    for (const entry of value.files ?? []) {
      if (!entry.path.endsWith("/")) entries.set(entry.path, entry);
      else if (entry.outcome === "vendored" || entry.outcome === "generated" || entry.outcome === "development") trees.push(entry.path);
      else problems.push(`coverage/${batch}: ${entry.path} is a directory; only development, vendored, or generated trees may be listed whole`);
    }
  }
  // In the working tree, a read only counts for the content that was read.
  const current = snapshot.worktree ? snapshotBlobIds(snapshot, [...entries.keys()].filter((path) => present.has(path))) : null;
  const committed = snapshot.worktree ? blobIds(repository, commit) : null;
  const unchanged = (entry: LedgerEntry) =>
    !current || entry.outcome !== "read" || (entry.hash ?? committed!.get(entry.path)) === current.get(entry.path);
  const covered = (path: string) => {
    const entry = entries.get(path);
    return (entry !== undefined && unchanged(entry)) || trees.some((tree) => path.startsWith(tree));
  };
  return {
    mode,
    commit,
    worktree: snapshot.worktree,
    base,
    required,
    missing: required.filter((path) => !covered(path)),
    deleted,
    stale,
    unknown: [...entries.keys()].filter((path) => !present.has(path)),
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
  const at = `${report.commit.slice(0, 7)}${report.worktree ? " with uncommitted changes" : ""}`;
  const where = report.mode === "update" ? `update ${report.base!.slice(0, 7)}..${at}` : `bootstrap at ${at}`;
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
