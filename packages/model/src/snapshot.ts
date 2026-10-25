// What a model describes: the files at a commit, or the working tree on top of it
// (HEAD plus uncommitted changes, `meta.source.worktree`). Everything that lists,
// reads, or hashes the modelled files goes through here, so the two cases differ
// in one place.
//
// Content hashes are git blob ids. A working-tree file hashed with `git hash-object`
// gets the id git gives the same content when it is committed, so hashes taken from
// the working tree and from commits compare directly.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { git, lines, tryGit } from "./git.ts";
import type { Source } from "./types.ts";

export interface Snapshot {
  repository: string;
  /** The commit, or the commit the working tree is on. */
  commit: string;
  /** Whether uncommitted changes (untracked files included) are part of it. */
  worktree: boolean;
}

/** The snapshot a model's `meta.source` names. */
export function snapshotOf(repository: string, source: Pick<Source, "commit" | "worktree">): Snapshot {
  return { repository, commit: source.commit, worktree: source.worktree === true };
}

/** Pathspecs for the whole repository except `exclude` (git pathspecs relative to its root). */
export function pathspecs(exclude: string[]): string[] {
  return [":/", ...exclude.map((pattern) => `:(top,exclude)${pattern}`)];
}

const listing = (repository: string, ...args: string[]) => lines(git(repository, "-c", "core.quotePath=false", ...args));

/**
 * Every file in the snapshot, except `exclude`: the files git tracks at the commit,
 * or, for the working tree, tracked and untracked files that are not ignored and
 * exist on disk.
 */
export function snapshotFiles(snapshot: Snapshot, exclude: string[] = []): string[] {
  const { repository, commit } = snapshot;
  if (snapshot.worktree) {
    const listed = listing(repository, "ls-files", "--cached", "--others", "--exclude-standard", "--", ...pathspecs(exclude));
    return [...new Set(listed)].filter((file) => isFile(join(repository, file))).sort();
  }
  if (!exclude.length) return listing(repository, "ls-tree", "-r", "--full-tree", "--name-only", commit);
  // ls-tree takes no pathspec magic such as :(exclude); a diff against the empty tree does.
  const empty = git(repository, "hash-object", "-t", "tree", "/dev/null");
  return listing(repository, "diff", "--name-only", "--no-renames", empty, commit, "--", ...pathspecs(exclude));
}

/** Files added or modified, and files deleted, between `base` and the snapshot. */
export function changedFiles(snapshot: Snapshot, base: string, exclude: string[] = []): { changed: string[]; deleted: string[] } {
  const { repository } = snapshot;
  const target = snapshot.worktree ? [] : [snapshot.commit];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const row of listing(repository, "diff", "--name-status", "--no-renames", base, ...target, "--", ...pathspecs(exclude))) {
    const [status, path] = row.split("\t");
    (status === "D" ? deleted : changed).push(path);
  }
  if (snapshot.worktree) {
    for (const path of listing(repository, "ls-files", "--others", "--exclude-standard", "--", ...pathspecs(exclude))) {
      if (!changed.includes(path)) changed.push(path);
    }
  }
  return { changed, deleted };
}

/** Content hash of every file at `commit`. */
export function commitBlobIds(repository: string, commit: string): Map<string, string> {
  const blobs = new Map<string, string>();
  for (const row of listing(repository, "ls-tree", "-r", "--full-tree", commit)) {
    const tab = row.indexOf("\t");
    const [, type, id] = row.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(row.slice(tab + 1), id);
  }
  return blobs;
}

/** Content hash of each of `files` that exists on disk, as `git add` would compute it. */
export function workingTreeBlobIds(repository: string, files: string[]): Map<string, string> {
  const existing = [...new Set(files)].filter((file) => isFile(join(repository, file)));
  if (!existing.length) return new Map();
  const input = existing.join("\n") + "\n";
  const ids = execFileSync("git", ["-C", repository, "hash-object", "--stdin-paths"], { input, encoding: "utf8" }).trim().split("\n");
  return new Map(existing.map((file, i) => [file, ids[i]]));
}

/** Content hash of each of `files` in the snapshot. */
export function snapshotBlobIds(snapshot: Snapshot, files: string[]): Map<string, string> {
  return snapshot.worktree ? workingTreeBlobIds(snapshot.repository, files) : commitBlobIds(snapshot.repository, snapshot.commit);
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
