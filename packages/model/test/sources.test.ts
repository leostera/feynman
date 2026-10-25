import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeCoverage, measureModel, outdatedElements } from "../src/index.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "feynman-sources-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const commit = (message: string) => {
    git("add", "-A", "--", ".", ":!.feynman");
    git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  return { root, write, git, commit, modelDir: join(root, ".feynman/model") };
}

test("elements record the content hash of the files they anchor, and go stale when one changes", () => {
  const { root, write, git, commit, modelDir } = setup();
  write("src/server.ts", "export const limit = 1024;\n");
  write("src/store.ts", "export const file = 'notes.log';\n");
  const first = commit("init");

  write(".feynman/model/meta.json", JSON.stringify({ system: "x", summary: "x", source: { repository: ".", commit: first }, extraction: "bootstrap" }));
  write(".feynman/model/limits/body-size.json", JSON.stringify({ subject: "body", value: "1 KiB", kind: "size", anchors: ["src/server.ts:1#limit"] }));
  write(".feynman/model/state/notes.json", JSON.stringify({ owner: "app", summary: "notes", lifetime: "disk", anchors: ["src/store.ts"] }));
  measureModel(root, modelDir);

  const limit = JSON.parse(readFileSync(join(modelDir, "limits/body-size.json"), "utf8"));
  expect(limit.sources).toEqual({ "src/server.ts": git("rev-parse", `${first}:src/server.ts`) });

  write("src/server.ts", "export const limit = 2048;\n");
  const second = commit("raise the limit");
  expect(outdatedElements(root, modelDir, second)).toEqual([{ kind: "limits", id: "body-size", files: ["src/server.ts"] }]);

  // Update mode requires the changed file and reports the element derived from it.
  const meta = JSON.parse(readFileSync(join(modelDir, "meta.json"), "utf8"));
  write(".feynman/model/meta.json", JSON.stringify({ ...meta, extraction: "update", source: { ...meta.source, base: { commit: first }, commit: second } }));
  const report = computeCoverage(root, modelDir);
  expect(report.required).toEqual(["src/server.ts"]);
  expect(report.outdated.map(({ id }) => id)).toEqual(["body-size"]);
});
