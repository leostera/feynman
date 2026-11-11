// Where a definition ends, given the line it starts on.
//
// The lock hashes a definition's text, so an extent that stops short (at the end of a wrapped
// signature, say) leaves the body out of the hash, and a change to the body goes unseen. This
// reads the code as a scanner would, not line by line: strings, comments and brackets are
// told apart, so a brace in a string or a regex is not a block, and a `{ … }` in a parameter
// list is not the body.
//
// Three families of language, by how a block ends:
// - braces (TypeScript, Rust, Go, Swift, Java, C…): the header runs to the `{` that opens the
//   body, at bracket depth zero, and the definition ends at its match; or to a `;`, or to
//   where the next line is no continuation, for a definition without a body.
// - indentation (Python): the header runs to the `:` that ends it, at bracket depth zero, and
//   the body is every line after indented deeper than the definition's.
// - `end` (Ruby, Elixir, Lua): the block runs to the `end` at the definition's indentation.

type Family = "braces" | "indentation" | "end";

interface Language {
  family: Family;
  /** What starts a comment that runs to the end of the line. */
  lineComments: readonly string[];
  /** Whether `/* … *\/` is a comment. */
  blockComments: boolean;
  /** `'''` and `"""` strings, which span lines. */
  tripleQuotes: boolean;
  /** A `/…/` regex literal, where one can stand. */
  regexes: boolean;
  /** What a backtick opens: a template with `${…}` holes, a raw string, or nothing special. */
  backticks: "template" | "raw" | "none";
  /** `'a` is a lifetime and `'a'` a character, so a `'` only opens a literal that closes at once. */
  lifetimes: boolean;
}

const BRACES: Language = { family: "braces", lineComments: ["//"], blockComments: true, tripleQuotes: false, regexes: false, backticks: "none", lifetimes: false };
const SCRIPT: Language = { ...BRACES, regexes: true, backticks: "template" };
const PYTHON: Language = { family: "indentation", lineComments: ["#"], blockComments: false, tripleQuotes: true, regexes: false, backticks: "none", lifetimes: false };
const RUBY: Language = { family: "end", lineComments: ["#"], blockComments: false, tripleQuotes: false, regexes: false, backticks: "none", lifetimes: false };

const BY_EXTENSION: Record<string, Language> = {
  ...Object.fromEntries(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].map((e) => [e, SCRIPT])),
  rs: { ...BRACES, lifetimes: true },
  go: { ...BRACES, backticks: "raw" },
  swift: { ...BRACES, tripleQuotes: true },
  kt: { ...BRACES, tripleQuotes: true },
  scala: { ...BRACES, tripleQuotes: true },
  php: { ...BRACES, lineComments: ["//", "#"] },
  py: PYTHON,
  pyi: PYTHON,
  rb: RUBY,
  cr: RUBY,
  ex: { ...RUBY, tripleQuotes: true },
  exs: { ...RUBY, tripleQuotes: true },
  lua: { ...RUBY, lineComments: ["--"] },
};

/**
 * The language of a file, by its extension. Without one, by the look of the definition: a
 * `def` or `class` whose header ends in `:` is Python's, a `def` without one is Ruby's.
 */
function languageOf(path: string | undefined, lines: string[], start: number): Language {
  const known = path === undefined ? undefined : BY_EXTENSION[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
  if (known) return known;
  if (path !== undefined || !/^\s*(?:async\s+)?(?:def|class)\b/.test(lines[start])) return BRACES;
  const header = headerEnd(textFrom(lines, start), PYTHON);
  if (header.colon) return PYTHON;
  return /^\s*def\b/.test(lines[start]) ? RUBY : BRACES;
}

/** A definition's last line (1-based) and whether it has a body, from the 0-based line it starts on. */
export function extentOf(lines: string[], start: number, path?: string): { end: number; body: boolean } {
  const language = languageOf(path, lines, start);
  const text = textFrom(lines, start);
  const line = (offset: number) => start + countNewlines(text, Math.min(offset, text.length)) + 1;
  if (language.family === "indentation") return indented(lines, start, text, language, line);
  if (language.family === "end") return untilEnd(lines, start);
  const found = braced(text, language, indentOf(lines[start]));
  return { end: Math.min(line(found.at), lines.length), body: found.body };
}

function textFrom(lines: string[], start: number): string {
  return lines.slice(start).join("\n");
}

function countNewlines(text: string, to: number): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < to; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// Scanning ----------------------------------------------------------------------------------------------

const OPEN = "([{";
const CLOSE = ")]}";

/**
 * If a comment or a string starts at `i`, the offset just past it; else `i`. `before` is the
 * last character of code before `i`, which says whether a `/` can open a regex.
 */
function skip(text: string, i: number, language: Language, before: string): number {
  const ch = text[i];
  for (const start of language.lineComments) {
    if (text.startsWith(start, i)) {
      const end = text.indexOf("\n", i);
      return end < 0 ? text.length : end;
    }
  }
  if (language.blockComments && text.startsWith("/*", i)) {
    const end = text.indexOf("*/", i + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (language.tripleQuotes && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
    const end = text.indexOf(text.slice(i, i + 3), i + 3);
    return end < 0 ? text.length : end + 3;
  }
  if (ch === '"') return quoted(text, i, '"') ?? i + 1;
  if (ch === "'") {
    if (!language.lifetimes) return quoted(text, i, "'") ?? i + 1;
    const literal = /^'(?:\\u\{[0-9a-fA-F]+\}|\\.|[^\\'\n])'/.exec(text.slice(i, i + 16));
    return literal ? i + literal[0].length : i + 1;
  }
  if (ch === "`") {
    if (language.backticks === "template") return template(text, i, language);
    if (language.backticks === "raw") {
      const end = text.indexOf("`", i + 1);
      return end < 0 ? text.length : end + 1;
    }
    return quoted(text, i, "`") ?? i + 1;
  }
  if (ch === "/" && language.regexes && regexMayStart(text, i, before)) return regex(text, i) ?? i;
  return i;
}

/** Past a quoted string that closes on its own line; undefined when it does not (an apostrophe in prose, say). */
function quoted(text: string, i: number, quote: string): number | undefined {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "\n") return undefined;
    else if (ch === quote) return j + 1;
  }
  return undefined;
}

/** Past a template literal, whose `${ … }` holes hold code, which may hold templates. */
function template(text: string, i: number, language: Language): number {
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "`") return j + 1;
    else if (ch === "$" && text[j + 1] === "{") j = matching(text, j + 1, language) ?? text.length;
  }
  return text.length;
}

const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^", "\n"]);
const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

function regexMayStart(text: string, i: number, before: string): boolean {
  if (text[i + 1] === "/" || text[i + 1] === "*") return false;
  if (REGEX_AFTER.has(before)) return true;
  return /[\w$]/.test(before) && REGEX_AFTER_WORD.test(text.slice(Math.max(0, i - 12), i).trimEnd());
}

/** Past a regex literal on one line; undefined when it is a division after all. */
function regex(text: string, i: number): number | undefined {
  let inClass = false;
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === "\\") j++;
    else if (ch === "\n") return undefined;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) return j + 1;
  }
  return undefined;
}

/** The offset of the bracket that closes the one at `open`; undefined when none does. */
function matching(text: string, open: number, language: Language): number | undefined {
  let depth = 0;
  let before = "";
  for (let i = open; i < text.length; i++) {
    const next = skip(text, i, language, before);
    if (next !== i) {
      i = next - 1;
      before = "x";
      continue;
    }
    const ch = text[i];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch) && --depth === 0) return i;
    if (!/\s/.test(ch)) before = ch;
    else if (ch === "\n") before = "\n";
  }
  return undefined;
}

// Braces ------------------------------------------------------------------------------------------------

/** After a `{ … }` at depth zero: what shows it was a type or a default, with the body still to come. */
const GOES_ON_AFTER_GROUP = /^(?:\{|=>|=(?!=)|\||&|\[|>|\)|extends\b|implements\b|where\b)/;
/** What a line starts with when it carries the line before it on, rather than starting something new. */
const CONTINUES = /^(?:\{|\)|\]|where\b|->|=>|:|\||&|\.|,|\?|=|\+|-|\*|extends\b|implements\b|throws\b|rethrows\b|async\b)/;

/**
 * Where a definition in a brace language ends, as an offset: the match of the `{` that opens
 * its body; else the `;` that ends it; else the end of the last line that the next does not
 * carry on (a Swift protocol's `func f() -> T`, a `const x = 1` without a semicolon).
 */
function braced(text: string, language: Language, base: number): { at: number; body: boolean } {
  let depth = 0;
  let before = "";
  for (let i = 0; i < text.length; i++) {
    const next = skip(text, i, language, before);
    if (next !== i) {
      i = next - 1;
      before = "x";
      continue;
    }
    const ch = text[i];
    if (depth === 0 && ch === "{") {
      const close = matching(text, i, language);
      if (close === undefined) return { at: i, body: false };
      if (!GOES_ON_AFTER_GROUP.test(text.slice(close + 1, close + 200).trimStart())) return { at: close, body: true };
      i = close;
      before = "}";
      continue;
    }
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) {
      // A bracket that closes what the definition did not open: the definition ended before it.
      if (depth === 0) return { at: Math.max(0, i - 1), body: false };
      depth--;
    } else if (depth === 0 && ch === ";") return { at: i, body: false };
    else if (depth === 0 && ch === "\n") {
      const rest = text.slice(i + 1);
      const line = /^[ \t]*\n/.test(rest) ? "" : rest.slice(0, rest.indexOf("\n") < 0 ? rest.length : rest.indexOf("\n"));
      const blank = line.trim() === "";
      // A blank line, or a line no deeper than the definition that does not carry it on, starts something else.
      if (blank ? !CONTINUES.test(rest.trimStart()) : indentOf(line) <= base && !CONTINUES.test(line.trimStart())) return { at: i - 1, body: false };
    }
    if (!/\s/.test(ch)) before = ch;
    else if (ch === "\n") before = "\n";
  }
  return { at: text.length, body: false };
}

// Indentation -------------------------------------------------------------------------------------------

/** Where a header ends: the newline, at bracket depth zero, that ends its logical line; `colon` when a `:` is the last thing on it. */
function headerEnd(text: string, language: Language): { at: number; colon: boolean } {
  let depth = 0;
  let last = "";
  for (let i = 0; i < text.length; i++) {
    const next = skip(text, i, language, "");
    if (next !== i) {
      // A comment says nothing; a string is code.
      if (!language.lineComments.some((c) => text.startsWith(c, i))) last = "x";
      i = next - 1;
      continue;
    }
    const ch = text[i];
    if (OPEN.includes(ch)) depth++;
    else if (CLOSE.includes(ch)) depth--;
    else if (depth <= 0 && ch === "\n") return { at: i, colon: last === ":" };
    if (!/\s/.test(ch)) last = ch;
  }
  return { at: text.length, colon: last === ":" };
}

/**
 * A Python definition: its header, however many lines it wraps over, then every line indented
 * deeper than the definition. Lines inside a string or an open bracket belong to the line that
 * opened it, whatever their own indentation.
 */
function indented(lines: string[], start: number, text: string, language: Language, line: (offset: number) => number): { end: number; body: boolean } {
  const header = headerEnd(text, language);
  if (!header.colon) return { end: Math.min(line(header.at), lines.length), body: false };
  const base = indentOf(lines[start]);
  let last = header.at;
  let depth = 0;
  let i = header.at;
  while (i < text.length) {
    // At the start of a line, outside any string or bracket.
    const from = i + 1;
    const stop = text.indexOf("\n", from);
    const body = text.slice(from, stop < 0 ? text.length : stop);
    if (body.trim() !== "" && indentOf(body) <= base) break;
    // Scan this logical line: it ends at the first newline outside strings and brackets.
    let j = from;
    for (; j < text.length; j++) {
      const next = skip(text, j, language, "");
      if (next !== j) {
        j = next - 1;
        continue;
      }
      const ch = text[j];
      if (OPEN.includes(ch)) depth++;
      else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1);
      else if (ch === "\n" && depth === 0) break;
    }
    if (body.trim() !== "") last = Math.min(j, text.length) - 1;
    i = j;
  }
  return { end: Math.min(line(last), lines.length), body: true };
}

// `end` ---------------------------------------------------------------------------------------------------

/** A Ruby-like block: to the `end` at the definition's indentation; one line when it closes itself or needs none. */
function untilEnd(lines: string[], start: number): { end: number; body: boolean } {
  const first = lines[start];
  if (/\bend\s*$/.test(first) || /^\s*def\s+[\w.?!]+(?:\([^)]*\))?\s*=/.test(first)) return { end: start + 1, body: true };
  const base = indentOf(first);
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const indent = indentOf(lines[i]);
    if (indent === base && /^\s*end\b/.test(lines[i])) return { end: i + 1, body: true };
    if (indent <= base) break;
    last = i;
  }
  return { end: last + 1, body: last > start };
}
