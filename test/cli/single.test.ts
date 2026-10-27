import { expect, test } from "bun:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressPage, outputFile, singlePage } from "../../src/cli/serve.ts";

test("the built page carries the view, the bundle and every module in one file", () => {
  const code = 'export default { note: "</script><!-- not the end" };';
  const bundle = { generatedAt: "", dev: false, repository: { name: "r", commit: "c", dirty: false, branch: null, fileUrl: null }, base: null, specs: [] };
  const page = singlePage({ bundle, modules: new Map([["specs/x.js", code]]) });
  expect(page).not.toMatch(/(src|href)="\.\/assets\//);
  // Only the page's own two scripts close: the module's "</script>" is escaped.
  expect(page.match(/<\/script>/g)).toHaveLength(2);
  const data = page.match(/<script type="application\/json" id="feynman">([\s\S]*?)<\/script>/)![1];
  expect(JSON.parse(data)).toEqual({ bundle, modules: { "specs/x.js": code } });
});

test("compressed build variants decompress to the standalone HTML", () => {
  const page = "<!doctype html><title>Feynman</title>" + "<p>self-contained explorer</p>".repeat(100);
  const compressed = compressPage(page);
  expect(gunzipSync(compressed.gzip).toString()).toBe(page);
  expect(brotliDecompressSync(compressed.brotli).toString()).toBe(page);
  expect(compressed.brotli.length).toBeLessThan(page.length);
});

test("build --out takes a file, or a directory to put index.html in", () => {
  const dir = mkdtempSync(join(tmpdir(), "feynman-out-"));
  expect(outputFile(dir, "page.html")).toBe(join(dir, "page.html"));
  expect(outputFile(dir, ".")).toBe(join(dir, "index.html"));
  expect(outputFile(dir, "site/")).toBe(join(dir, "site", "index.html"));
});
