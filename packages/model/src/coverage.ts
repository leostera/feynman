// Which files an extraction is responsible for, and which of them are covered.
//
//   bootstrap: every file in the snapshot (see snapshot.ts).
//   update:    every file added or modified between meta.source.base and the
//              snapshot (the base must be an ancestor of the commit), plus every
//              file an element was derived from whose content hash no longer
//              matches (see sources.ts). Those elements are reported as outdated.
//
// Files under `exclude` in `.feynman/config.json`, and the model itself, are never
// required. Covered files come from the ledgers in <model-dir>/coverage/*.json for
// the modelled commit.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "./config.ts";
import { tryGit } from "./git.ts";
import { loadModel, readCoverage } from "./model.ts";
import { changedFiles, commitBlobIds, snapshotBlobIds, snapshotFiles, snapshotOf, type Snapshot } from "./snapshot.ts";
import { outdatedElements, type OutdatedElement } from "./sources.ts";
import type { Ledger, LedgerEntry, Meta } from "./types.ts";

export class CoverageError extends Error {}

/** Where a repository keeps its model; never itself required for coverage. */
export const MODEL_ROOT = ".feynman/";

/** What an extraction covers: everything, or what changed since a base commit. */
export type Scope = { mode: "bootstrap" } | { mode: "update"; base: string };

export interface CoverageReport {
  snapshot: Snapshot;
  scope: Scope;
  required: string[];
  missing: string[];
  deleted: string[];
  /** Ledgers for other commits, ignored. */
  stale: string[];
  /** Ledger paths that are not files in the snapshot. */
  unknown: string[];
  /** Pathspecs excluded by .feynman/config.json. */
  exclude: string[];
  /** Update only: elements whose source files changed since they were derived. */
  outdated: OutdatedElement[];
  problems: string[];
}

export function computeCoverage(repository: string, modelDir: string): CoverageReport {
  if (!existsSync(join(modelDir, "meta.json"))) throw new CoverageError(`${modelDir}: no model. Bootstrap one first.`);
  const { meta } = loadModel(modelDir);
  const { exclude } = readConfig(modelDir);
  const snapshot = resolveSnapshot(repository, meta);
  const present = new Set(snapshotFiles(snapshot, exclude));
  const scope = resolveScope(snapshot, meta);
  const { required, deleted, outdated } =
    scope.mode === "update" ? updateScope(snapshot, scope.base, modelDir, exclude, present) : { required: [...present], deleted: [], outdated: [] };
  const ledgers = readLedgers(modelDir, snapshot.commit);
  const isCovered = coveredBy(ledgers, snapshot, present);
  const inScope = required.filter((path) => !path.startsWith(MODEL_ROOT));
  return {
    snapshot,
    scope,
    required: inScope,
    missing: inScope.filter((path) => !isCovered(path)),
    deleted,
    stale: ledgers.stale,
    unknown: [...ledgers.files.keys()].filter((path) => !present.has(path)),
    exclude,
    outdated,
    problems: ledgers.problems,
  };
}

function resolveSnapshot(repository: string, meta: Meta): Snapshot {
  const commit = tryGit(repository, "rev-parse", meta.source?.commit ?? "");
  if (!commit) throw new CoverageError(`meta.source.commit ${meta.source?.commit} is not a commit in ${repository}`);
  return snapshotOf(repository, { ...meta.source, commit });
}

function resolveScope(snapshot: Snapshot, meta: Meta): Scope {
  if (meta.extraction !== "update") return { mode: "bootstrap" };
  const baseRef = meta.source.base?.commit;
  if (!baseRef) throw new CoverageError("update without meta.source.base.commit: name the previously modelled commit.");
  const base = tryGit(snapshot.repository, "rev-parse", baseRef);
  if (!base || tryGit(snapshot.repository, "merge-base", "--is-ancestor", base, snapshot.commit) === null) {
    throw new CoverageError(`base ${baseRef} is not an ancestor of ${snapshot.commit.slice(0, 7)}.`);
  }
  return { mode: "update", base };
}

/** Changed files since `base`, plus the sources of outdated elements, which the diff can miss (say, after a rebase). */
function updateScope(snapshot: Snapshot, base: string, modelDir: string, exclude: string[], present: Set<string>) {
  const { changed, deleted } = changedFiles(snapshot, base, exclude);
  const required = new Set(changed);
  const gone = new Set(deleted);
  const outdated = outdatedElements(snapshot, modelDir);
  for (const file of outdated.flatMap(({ files }) => files)) (present.has(file) ? required : gone).add(file);
  return { required: [...required], deleted: [...gone], outdated };
}

interface Ledgers {
  /** Entries for single files, by path. */
  files: Map<string, LedgerEntry>;
  /** Development, vendored, and generated trees (paths ending in `/`). */
  trees: string[];
  stale: string[];
  problems: string[];
}

function readLedgers(modelDir: string, commit: string): Ledgers {
  const ledgers: Ledgers = { files: new Map(), trees: [], stale: [], problems: [] };
  for (const { batch, value } of readCoverage(modelDir)) {
    if (value.commit !== commit) {
      ledgers.stale.push(batch);
      continue;
    }
    for (const entry of value.files ?? []) {
      if (!entry.path.endsWith("/")) ledgers.files.set(entry.path, entry);
      else if (entry.outcome !== "read") ledgers.trees.push(entry.path);
      else ledgers.problems.push(`coverage/${batch}: ${entry.path} is a directory; only development, vendored, or generated trees may be listed whole`);
    }
  }
  return ledgers;
}

/**
 * Whether the ledgers cover a file. In the working tree, a read counts only while
 * the file has the content that was read: the hash its entry records, or its
 * content at the commit when the entry records none.
 */
function coveredBy(ledgers: Ledgers, snapshot: Snapshot, present: Set<string>): (path: string) => boolean {
  const current = snapshot.worktree ? snapshotBlobIds(snapshot, [...ledgers.files.keys()].filter((path) => present.has(path))) : null;
  const committed = snapshot.worktree ? commitBlobIds(snapshot.repository, snapshot.commit) : null;
  const stillRead = (entry: LedgerEntry) => !current || entry.outcome !== "read" || (entry.hash ?? committed!.get(entry.path)) === current.get(entry.path);
  return (path) => {
    const entry = ledgers.files.get(path);
    return (entry !== undefined && stillRead(entry)) || ledgers.trees.some((tree) => path.startsWith(tree));
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

/** "abc1234" or "abc1234 with uncommitted changes". */
export function describeSnapshot(snapshot: Snapshot): string {
  return `${snapshot.commit.slice(0, 7)}${snapshot.worktree ? " with uncommitted changes" : ""}`;
}

/** One line: "bootstrap at 66d8d86: 514 of 956 files covered". */
export function describeCoverage(report: CoverageReport): string {
  const at = describeSnapshot(report.snapshot);
  const where = report.scope.mode === "update" ? `update ${report.scope.base.slice(0, 7)}..${at}` : `bootstrap at ${at}`;
  const excluding = report.exclude.length ? ` (excluding ${report.exclude.join(", ")})` : "";
  return `${where}: ${report.required.length - report.missing.length} of ${report.required.length} files covered${excluding}`;
}

/**
 * Add entries to the ledger `coverage/<batch>.json` for `commit`, replacing earlier
 * entries for the same paths. Creates the ledger when needed.
 */
export function recordCoverage(modelDir: string, batch: string, commit: string, summary: string, entries: LedgerEntry[]): Ledger {
  const dir = join(modelDir, "coverage");
  const path = join(dir, `${batch}.json`);
  mkdirSync(dir, { recursive: true });
  const ledger: Ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { commit, summary, files: [] };
  if (ledger.commit !== commit) throw new CoverageError(`coverage/${batch}.json is for ${ledger.commit.slice(0, 7)}, not ${commit.slice(0, 7)}`);
  ledger.summary = summary;
  const byPath = new Map(ledger.files.map((entry) => [entry.path, entry]));
  for (const entry of entries) byPath.set(entry.path, entry);
  ledger.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n");
  return ledger;
}
