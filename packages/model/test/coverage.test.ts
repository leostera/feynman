import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { computeCoverage, describeCoverage, measureModel } from "../src/index.ts";

/** A committed git repository with `files`, and a bootstrap model at HEAD. */
function repository(files: Record<string, string>, config?: object) {
  const root = mkdtempSync(join(tmpdir(), "feynman-model-"));
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "init");
  const meta = { system: "x", summary: "x", source: { repository: ".", commit: git("rev-parse", "HEAD") }, extraction: "bootstrap" };
  write(".feynman/model/meta.json", JSON.stringify(meta));
  if (config) write(".feynman/config.json", JSON.stringify(config));
  return { root, modelDir: join(root, ".feynman/model") };
}

const FILES = { "src/app.ts": "export const a = 1;\n", "examples/demo/model.json": "{}\n", "examples/demo/index.html": "<p></p>\n" };

test("every tracked file is required without a config", () => {
  const { root, modelDir } = repository(FILES);
  expect(computeCoverage(root, modelDir).required.sort()).toEqual(["examples/demo/index.html", "examples/demo/model.json", "src/app.ts"]);
});

test("excluded paths are not required, and the report says so", () => {
  const { root, modelDir } = repository(FILES, { exclude: ["examples/"] });
  const report = computeCoverage(root, modelDir);
  expect(report.required).toEqual(["src/app.ts"]);
  expect(describeCoverage(report)).toContain("(excluding examples/)");
});

test("excluded paths are not counted in footprints", () => {
  const { root, modelDir } = repository(FILES, { exclude: ["examples/"] });
  measureModel(root, modelDir);
  const meta = JSON.parse(execFileSync("cat", [join(modelDir, "meta.json")], { encoding: "utf8" }));
  expect(meta.source.footprint.files).toBe(1);
  expect(meta.source.footprint.excludes).toContain("examples/");
});
