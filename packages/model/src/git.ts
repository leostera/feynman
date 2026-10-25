import { execFileSync } from "node:child_process";

/** Run git in `repository` and return trimmed stdout; throws on failure. */
export function git(repository: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  }).trim();
}

/** Like `git`, but returns null instead of throwing. */
export function tryGit(repository: string, ...args: string[]): string | null {
  try {
    return git(repository, ...args);
  } catch {
    return null;
  }
}

export function lines(text: string): string[] {
  return text ? text.split("\n") : [];
}

/**
 * Every file git tracks at `commit`, i.e. every file the repository does not ignore,
 * leaving out paths matching the `exclude` pathspecs.
 */
export function trackedFiles(repository: string, commit: string, exclude: string[] = []): string[] {
  if (!exclude.length) return lines(git(repository, "-c", "core.quotePath=false", "ls-tree", "-r", "--full-tree", "--name-only", commit));
  // ls-tree does not take pathspec magic such as :(exclude); a diff against the empty tree does.
  const empty = git(repository, "hash-object", "-t", "tree", "/dev/null");
  const pathspecs = [":/", ...exclude.map((pattern) => `:(top,exclude)${pattern}`)];
  return lines(git(repository, "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames", empty, commit, "--", ...pathspecs));
}
