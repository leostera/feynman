// Code on the page is highlighted when the site is built, not in the browser: importing
// `./snippets/x.ts?highlight` gives `{ code, html }`, with the colours of both modes in the
// HTML (the dark ones as --shiki-dark variables, switched on by index.css).
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { createHighlighter, type BundledLanguage } from "shiki";

export interface Snippet {
  code: string;
  html: string;
}

const LANGUAGES: Record<string, BundledLanguage> = { ".ts": "typescript", ".tsx": "tsx", ".sh": "bash", ".md": "markdown", ".json": "json" };
const THEMES = { light: "github-light", dark: "github-dark" } as const;
const highlighter = createHighlighter({ themes: Object.values(THEMES), langs: [...new Set(Object.values(LANGUAGES))] });

/** The snippet in `path`, highlighted by its extension; `.txt` and others stay plain. */
export async function highlight(path: string): Promise<Snippet> {
  const code = readFileSync(path, "utf8").replace(/\n+$/, "");
  const lang = LANGUAGES[extname(path)] ?? "text";
  const html = (await highlighter).codeToHtml(code, { lang, themes: THEMES, defaultColor: "light" });
  return { code, html };
}

export const QUERY = "?highlight";

/** The module an import of `path?highlight` stands for. */
export async function highlightModule(path: string): Promise<string> {
  return `export default ${JSON.stringify(await highlight(path))};`;
}
