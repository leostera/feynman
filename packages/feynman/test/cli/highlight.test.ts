import { expect, test } from "bun:test";
import { highlightLines } from "../../src/cli/highlight.ts";

test("snippets are highlighted per line, with colours for both modes", async () => {
  const lines = await highlightLines("src/server.ts", "export function say(text: string) {\n  return text;\n}");
  expect(lines).toHaveLength(3);
  expect(lines![0].map((token) => token.t).join("")).toBe("export function say(text: string) {");
  const keyword = lines![0].find((token) => token.t === "export")!;
  expect(keyword.c).toMatch(/^#/);
  expect(keyword.d).toMatch(/^#/);
  expect(keyword.c).not.toBe(keyword.d);
});

test("files in a language without a grammar stay plain", async () => {
  expect(await highlightLines("notes.unknown", "just text")).toBeNull();
});
