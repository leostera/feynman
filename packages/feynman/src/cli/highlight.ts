// Source snippets are highlighted when the bundle is prepared, not in the browser: the page
// gets coloured tokens per line, both modes at once (the dark colour as --shiki-dark, which
// index.css switches on), so the view stays small and the snippets keep their line numbers.
import { extname } from "node:path";
import { createHighlighter, type BundledLanguage, type Highlighter } from "shiki";
import type { CodeToken } from "../view/data.ts";

const LANGUAGES: Record<string, BundledLanguage> = {
  ".ts": "typescript", ".mts": "typescript", ".cts": "typescript", ".tsx": "tsx",
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "jsx",
  ".rs": "rust", ".go": "go", ".py": "python", ".rb": "ruby", ".swift": "swift",
  ".kt": "kotlin", ".java": "java", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
  ".ml": "ocaml", ".mli": "ocaml", ".c": "c", ".h": "c", ".cc": "cpp", ".cpp": "cpp", ".hpp": "cpp",
  ".cs": "csharp", ".php": "php", ".sql": "sql", ".sh": "bash", ".zig": "zig",
  ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
};
const THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighter: Promise<Highlighter> | null = null;

/** The snippet as coloured tokens per line; null for a language we do not know, shown plain. */
export async function highlightLines(path: string, code: string): Promise<CodeToken[][] | null> {
  const lang = LANGUAGES[extname(path).toLowerCase()];
  if (!lang) return null;
  highlighter ??= createHighlighter({ themes: Object.values(THEMES), langs: [] });
  const shiki = await highlighter;
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(lang);
  const { tokens } = shiki.codeToTokens(code, { lang, themes: THEMES, defaultColor: false });
  return tokens.map((line) =>
    line.map((token) => {
      const style = token.htmlStyle ?? {};
      const light = style["--shiki-light"];
      const dark = style["--shiki-dark"];
      return { t: token.content, ...(light ? { c: light } : {}), ...(dark ? { d: dark } : {}) };
    }),
  );
}
