import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureCalls, type Model } from "../src/index.ts";

test("anchored steps get the call tree of their function: repository calls expanded, the rest external leaves", () => {
  const root = mkdtempSync(join(tmpdir(), "feynman-calls-"));
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src/notes.ts"),
    [
      "export function save(body: string) {",
      "  if (body.length > 1024) throw new Error('too large');",
      "  store(body);",
      "  store(body);",
      "}",
      "function store(body: string) {",
      "  writeFileSync('notes.txt', body);",
      "}",
      "",
    ].join("\n"),
  );
  execFileSync("git", ["-C", root, "init", "-q"]);
  const step = (symbol: string) => ({ actor: "app", action: "saves", component: "notes", anchor: `src/notes.ts#${symbol}` });
  const model = {
    components: [{ id: "notes", summary: "", actors: [], footprint: { paths: ["src/"] }, anchors: [] }],
    flows: [{ id: "save-note", summary: "", trigger: "", steps: [step("save"), step("missing"), step("store")], anchors: [] }],
  } as unknown as Model;

  const { trees, problems } = measureCalls(root, model);
  expect(trees.get("save-note#0")).toEqual({
    label: "save(body)",
    file: "src/notes.ts",
    line: 1,
    children: [
      { label: "new Error()", file: "src/notes.ts", line: 2, external: true, children: [] },
      { label: "store(body)", file: "src/notes.ts", line: 3, children: [{ label: "writeFileSync()", file: "src/notes.ts", line: 7, external: true, children: [] }] },
    ],
  });
  // Several entries in one scope each get their tree.
  expect(trees.get("save-note#2")?.label).toBe("store(body)");
  expect(problems).toEqual(["flows/save-note step 2: no call tree for src/notes.ts#missing (Entrypoint not found: missing)"]);
});
