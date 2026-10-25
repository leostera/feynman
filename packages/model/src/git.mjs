import { execFileSync } from "node:child_process";

/** Run git in `repository` and return trimmed stdout; throws on failure. */
export function git(repository, ...args) {
  return execFileSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 28,
  }).trim();
}

/** Like `git`, but returns null instead of throwing. */
export function tryGit(repository, ...args) {
  try {
    return git(repository, ...args);
  } catch {
    return null;
  }
}

export function lines(text) {
  return text ? text.split("\n") : [];
}

/** Every file git tracks at `commit`, i.e. every file the repository does not ignore. */
export function trackedFiles(repository, commit) {
  return lines(git(repository, "ls-tree", "-r", "--name-only", commit));
}
