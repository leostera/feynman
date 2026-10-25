import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkModelFile } from "../src/index.ts";

test("one model file is checked as it is written: JSON, schema, and name", () => {
  const modelDir = mkdtempSync(join(tmpdir(), "feynman-check-"));
  mkdirSync(join(modelDir, "limits"));
  const write = (file: string, content: string) => writeFileSync(join(modelDir, file), content);
  const limit = { kind: "size", subject: "request body", value: "1 KiB", anchors: ["src/server.ts:2"] };

  write("limits/body.json", JSON.stringify(limit));
  expect(checkModelFile(modelDir, "limits/body.json")).toEqual([]);
  write("limits/body.json", '{ "kind": "size",');
  expect(checkModelFile(modelDir, "limits/body.json")![0]).toStartWith("not valid JSON");
  write("limits/body.json", JSON.stringify({ ...limit, kind: "vibes" }));
  expect(checkModelFile(modelDir, "limits/body.json")!.join()).toContain("/kind");
  write("limits/Body.json", JSON.stringify(limit));
  expect(checkModelFile(modelDir, "limits/Body.json")).toEqual(["file name is not a kebab-case id"]);
  expect(checkModelFile(modelDir, "coverage/x.json")).toBeNull();
  expect(checkModelFile(modelDir, "notes.md")).toBeNull();
});
