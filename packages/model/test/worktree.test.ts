import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeCoverage, recordReviewed, workingTreeBlobIds } from "../src/index.ts";

/** A repository with committed files, then uncommitted changes, and a model of its working tree. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), "feynman-worktree-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init");
  const commit = git("rev-parse", "HEAD");
  const modelDir = join(root, ".feynman/model");
  write(".feynman/model/meta.json", JSON.stringify({ system: "x", summary: "x", source: { repository: ".", commit, worktree: true }, extraction: "bootstrap" }));
  return { root, write, commit, modelDir };
}

test("a model of the working tree requires untracked files and drops deleted ones", () => {
  const { root, write, modelDir } = setup();
  write("src/new.ts", "export const fresh = true;\n");
  execFileSync("rm", [join(root, "src/b.ts")]);
  const report = computeCoverage(root, modelDir);
  expect(report.worktree).toBe(true);
  expect(report.required).toEqual(["src/a.ts", "src/new.ts"]);
});

test("a read counts only while the file still has the content that was read", () => {
  const { root, write, commit, modelDir } = setup();
  write("src/a.ts", "export const a = 2;\n");
  const hash = workingTreeBlobIds(root, ["src/a.ts"]).get("src/a.ts");
  recordReviewed(modelDir, "s", commit, "x", [
    { path: "src/a.ts", outcome: "read", hash },
    // Recorded without a hash, as a clean extraction does: it stands for the committed content.
    { path: "src/b.ts", outcome: "read" },
  ]);
  expect(computeCoverage(root, modelDir).missing).toEqual([]);

  write("src/a.ts", "export const a = 3;\n");
  write("src/b.ts", "export const b = 2;\n");
  expect(computeCoverage(root, modelDir).missing).toEqual(["src/a.ts", "src/b.ts"]);
});
