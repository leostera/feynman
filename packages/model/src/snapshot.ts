// What a model describes: the files at a commit, or the working tree on top of it
// (HEAD plus uncommitted changes, `meta.source.worktree`). Everything that lists,
// reads, or hashes the modelled files goes through here, so the two cases differ
// in one place.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git, lines, tryGit, trackedFiles } from "./git.ts";
import { blobIds, workingTreeBlobIds } from "./sources.ts";

export interface Snapshot {
  repository: string;
  /** The commit, or the commit the working tree is on. */
  commit: string;
  /** Whether uncommitted changes are included. */
  worktree: boolean;
}

/** The snapshot a model's `meta.source` names. */
export function snapshotOf(repository: string, source: { commit: string; worktree?: boolean }): Snapshot {
  return { repository, commit: source.commit, worktree: source.worktree === true };
}

const pathspecs = (exclude: string[]) => [":/", ...exclude.map((pattern) => `:(top,exclude)${pattern}`)];

/**
 * Every file in the snapshot, except `exclude` pathspecs: the files git tracks at
 * the commit, or, for the working tree, tracked and untracked files that are not
 * ignored and exist on disk.
 */
export function snapshotFiles(snapshot: Snapshot, exclude: string[] = []): string[] {
  if (!snapshot.worktree) return trackedFiles(snapshot.repository, snapshot.commit, exclude);
  const listed = lines(
    git(snapshot.repository, "-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs(exclude)),
  );
  return [...new Set(listed)].filter((file) => isFile(join(snapshot.repository, file))).sort();
}

/** Files added or modified, and files deleted, between `base` and the snapshot. */
export function changedFiles(snapshot: Snapshot, base: string, exclude: string[] = []): { changed: string[]; deleted: string[] } {
  const target = snapshot.worktree ? [] : [snapshot.commit];
  const changed: string[] = [];
  const deleted: string[] = [];
  const rows = git(snapshot.repository, "-c", "core.quotePath=false", "diff", "--name-status", "--no-renames", base, ...target, "--", ...pathspecs(exclude));
  for (const row of lines(rows)) {
    const [status, path] = row.split("\t");
    (status === "D" ? deleted : changed).push(path);
  }
  if (snapshot.worktree) {
    const untracked = git(snapshot.repository, "-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", ...pathspecs(exclude));
    for (const path of lines(untracked)) if (!changed.includes(path)) changed.push(path);
  }
  return { changed, deleted };
}

/** Content hash (git blob id) of each of `files` in the snapshot. */
export function snapshotBlobIds(snapshot: Snapshot, files: string[]): Map<string, string> {
  return snapshot.worktree ? workingTreeBlobIds(snapshot.repository, files) : blobIds(snapshot.repository, snapshot.commit);
}

/** Whether a file or directory exists in the snapshot. */
export function existsInSnapshot(snapshot: Snapshot, path: string): boolean {
  const clean = path.replace(/\/$/, "");
  if (snapshot.worktree) return existsSync(join(snapshot.repository, clean));
  return tryGit(snapshot.repository, "cat-file", "-e", `${snapshot.commit}:${clean}`) !== null;
}

/** A file's text in the snapshot, or null when it is missing. */
export function readInSnapshot(snapshot: Snapshot, file: string): string | null {
  if (!snapshot.worktree) return tryGit(snapshot.repository, "show", `${snapshot.commit}:${file}`);
  try {
    return readFileSync(join(snapshot.repository, file), "utf8");
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
