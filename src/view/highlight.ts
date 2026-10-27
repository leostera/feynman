// Highlighting in the page, for values only the page has: payloads and inputs, as JSON. Source
// snippets are highlighted by the CLI (cli/highlight.ts), which knows every language; here only
// the JSON grammar is bundled, with Shiki's JavaScript regex engine (no WebAssembly), and the
// same GitHub themes, so both read alike. The built page must stay one script, so nothing here
// is loaded lazily from another chunk.
import json from "@shikijs/langs/json";
import githubDark from "@shikijs/themes/github-dark";
import githubLight from "@shikijs/themes/github-light";
import { createHighlighterCoreSync, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { CodeToken } from "./data";

let highlighter: HighlighterCore | null = null;

/** A JSON text as coloured tokens per line, both modes at once, like the CLI's snippets. */
export function highlightJson(code: string): CodeToken[][] {
  highlighter ??= createHighlighterCoreSync({ themes: [githubLight, githubDark], langs: [json], engine: createJavaScriptRegexEngine() });
  const { tokens } = highlighter.codeToTokens(code, { lang: "json", themes: { light: "github-light", dark: "github-dark" }, defaultColor: false });
  return tokens.map((line) =>
    line.map((token) => {
      const style = token.htmlStyle ?? {};
      return { t: token.content, ...(style["--shiki-light"] ? { c: style["--shiki-light"] } : {}), ...(style["--shiki-dark"] ? { d: style["--shiki-dark"] } : {}) };
    }),
  );
}
