import { expect, test } from "bun:test";
import { singlePage } from "../../src/cli/serve.ts";

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
