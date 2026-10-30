// The repository a spec lives in: where it is, which commit, and how to link to its files.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, tryGit } from "./git.ts";

export interface Repository {
  /** Absolute path of the working tree's root. */
  root: string;
  commit: string;
  /** Whether the working tree has uncommitted changes; explainers then describe the working tree. */
  dirty: boolean;
  branch: string | null;
  /** `https://host/org/repo/blob/<commit>/{path}`, for remotes on common hosts. */
  fileUrl: string | null;
}

/**
 * The repository `dir` is in, or null outside one. Only the root is asked for up front: each
 * of the rest is another git command, run when first read (`check` reads none of them).
 */
export function repositoryAt(dir: string): Repository | null {
  const root = tryGit(dir, "rev-parse", "--show-toplevel");
  if (!root) return null;
  const once = <T>(get: () => T) => {
    let value: { v: T } | undefined;
    return () => (value ??= { v: get() }).v;
  };
  const commit = once(() => tryGit(root, "rev-parse", "HEAD") ?? "0000000");
  const dirty = once(() => (tryGit(root, "status", "--porcelain") ?? "") !== "");
  const branch = once(() => tryGit(root, "symbolic-ref", "--short", "HEAD"));
  const fileUrl = once(() => {
    const web = webUrl(tryGit(root, "remote", "get-url", "origin"));
    return web ? `${web}${/gitlab/.test(web) ? "/-" : ""}/blob/${commit()}/{path}` : null;
  });
  return {
    root,
    get commit() {
      return commit();
    },
    get dirty() {
      return dirty();
    },
    get branch() {
      return branch();
    },
    get fileUrl() {
      return fileUrl();
    },
  };
}

export function webUrl(remote: string | null): string | null {
  if (!remote) return null;
  const ssh = remote.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/);
  return https ? `https://${https[1]}/${https[2]}` : null;
}

/** Run `f` with a checkout of `ref` in a temporary worktree, removed afterwards. */
export async function withWorktree<T>(repository: string, ref: string, f: (dir: string) => Promise<T> | T): Promise<T> {
  const commit = git(repository, "rev-parse", "--verify", `${ref}^{commit}`);
  const dir = join(mkdtempSync(join(tmpdir(), "feynman-base-")), "tree");
  git(repository, "worktree", "add", "--detach", "--quiet", dir, commit);
  try {
    return await f(dir);
  } finally {
    tryGit(repository, "worktree", "remove", "--force", dir);
    rmSync(dir, { recursive: true, force: true });
  }
}
