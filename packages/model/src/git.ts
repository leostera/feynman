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
