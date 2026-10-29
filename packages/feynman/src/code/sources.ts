// Sources: the code a step stands for, as `path#symbol` or `path:start-end`.
//
// A symbol is found by its definition in the file (function, method, class, constant,
// in the common languages), and its extent by matching braces or, for indentation
// languages, by indentation. The extent's content hash is what `feynman.lock` records,
// so a step is stale when the code it stands for changes, not when anything in its file
// does.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ParsedSource {
  source: string;
  path: string;
  symbol?: string;
  lines?: [number, number];
}

export interface ResolvedSource extends ParsedSource {
  /** 1-based, inclusive. */
  start: number;
  end: number;
  text: string;
  hash: string;
}

export type Resolution = { ok: true; resolved: ResolvedSource } | { ok: false; source: string; reason: string };

const RANGE = /^(.+):(\d+)-(\d+)$/;

export function parseSource(source: string): ParsedSource | null {
  const hash = source.indexOf("#");
  if (hash > 0) return { source, path: source.slice(0, hash), symbol: source.slice(hash + 1) };
  const range = RANGE.exec(source);
  if (range) return { source, path: range[1], lines: [Number(range[2]), Number(range[3])] };
  return null;
}

/** Resolve a source in a working tree; `read` can be replaced to read another commit. */
export function resolveSource(root: string, source: string, read: (path: string) => string | null = (path) => readFrom(root, path)): Resolution {
  const parsed = parseSource(source);
  if (!parsed) return { ok: false, source, reason: "is neither path#symbol nor path:start-end" };
  const text = read(parsed.path);
  if (text === null) return { ok: false, source, reason: `${parsed.path} does not exist` };
  const lines = text.split("\n");
  let start: number;
  let end: number;
  if (parsed.lines) {
    [start, end] = parsed.lines;
    if (start < 1 || end < start || end > lines.length) return { ok: false, source, reason: `lines ${start}-${end} are outside ${parsed.path} (${lines.length} lines)` };
  } else {
    const found = findSymbol(lines, parsed.symbol!);
    if (!found) {
      const close = closeSymbols(lines, parsed.symbol!).map((symbol) => `${parsed.path}#${symbol}`);
      return { ok: false, source, reason: `${parsed.symbol} is not defined in ${parsed.path}${close.length ? `; did you mean ${close.join(" or ")}?` : ""}` };
    }
    [start, end] = found;
  }
  const body = lines.slice(start - 1, end).join("\n");
  return { ok: true, resolved: { ...parsed, start, end, text: body, hash: hashText(body) } };
}

export function hashText(text: string): string {
  const normal = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
  return createHash("sha1").update(normal).digest("hex").slice(0, 12);
}

function readFrom(root: string, path: string): string | null {
  const full = join(root, path);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

/**
 * The 1-based line range of a symbol's definition, `name` or `Outer.name` (`Outer::name`).
 * An outer name can have several definitions (a Rust struct and its impl blocks); the
 * first one that contains the rest of the symbol wins.
 */
/**
 * Symbols defined in the file whose name is close to the last part of `symbol`: the same
 * in another case, one inside the other, or a few letters apart. The closest few first.
 */
export function closeSymbols(lines: string[], symbol: string): string[] {
  const last = symbol.split(/\.|::/).at(-1)!;
  const prefix = symbol.slice(0, symbol.length - last.length);
  const wanted = last.toLowerCase();
  const ids = new Set(lines.join("\n").match(/[A-Za-z_$][\w$]*/g) ?? []);
  const distance = (id: string) => {
    const lower = id.toLowerCase();
    if (lower === wanted) return 0;
    if (Math.min(lower.length, wanted.length) >= 4 && (lower.includes(wanted) || wanted.includes(lower))) return 1;
    return editDistance(lower, wanted) + 1;
  };
  const most = Math.max(1, Math.floor(wanted.length / 4)) + 1;
  return [...ids]
    .filter((id) => id !== last)
    .map((id) => [id, distance(id)] as const)
    .filter(([, d]) => d <= most)
    .sort(([a, x], [b, y]) => x - y || a.localeCompare(b))
    .map(([id]) => prefix + id)
    .filter((candidate) => findSymbol(lines, candidate) !== null)
    .slice(0, 3);
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

export function findSymbol(lines: string[], symbol: string): [number, number] | null {
  const search = (parts: string[], from: number, to: number): [number, number] | null => {
    const [first, ...rest] = parts;
    for (const at of findDefinitions(lines, first, from, to)) {
      const end = extent(lines, at);
      if (!rest.length) return [at + 1, end];
      const inner = search(rest, at + 1, end);
      if (inner) return inner;
    }
    return null;
  };
  return search(symbol.split(/\.|::/), 0, lines.length);
}

const KEYWORDS =
  "(?:export\\s+)?(?:default\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:public\\s+|private\\s+|protected\\s+|internal\\s+|fileprivate\\s+|open\\s+)?(?:static\\s+|final\\s+|override\\s+|abstract\\s+)*(?:async\\s+|unsafe\\s+|const\\s+|extern\\s+\"[^\"]*\"\\s+)*";

/** Type parameters, `<T>` or `<M extends Keys<Map<string, T>>>`: nested up to three deep, as a regex can. */
const GENERICS = "<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>";

function definitionPatterns(name: string): RegExp[] {
  const n = name.replace(/[$]/g, "\\$");
  return [
    // function name, fn name, def name, func name, fun name
    new RegExp(`^\\s*${KEYWORDS}(?:function\\*?|fn|def|func|fun|sub|proc)\\s+${n}\\b`),
    // class, struct, enum, trait, interface, impl, type, protocol, extension, mod, module, record
    new RegExp(`^\\s*${KEYWORDS}(?:class|struct|enum|trait|interface|impl(?:<[^>]*>)?|type|protocol|extension|mod|module|record|object|actor)\\s+${n}\\b`),
    // const name =, let name =, var name =, static NAME:, name: Type =
    new RegExp(`^\\s*${KEYWORDS}(?:const|let|var|val|static)\\s+(?:mut\\s+)?${n}\\b`),
    // impl Type for Trait … { / impl Trait for Type
    new RegExp(`^\\s*impl(?:<[^>]*>)?\\s+[\\w:<>, ]*\\bfor\\s+${n}\\b`),
    // method: name(…) {   or   async name(…) {   or   name = (…) =>   or   name: function
    new RegExp(`^\\s*${KEYWORDS}(?:get\\s+|set\\s+)?${n}\\s*(?:${GENERICS})?\\s*\\([^;]*$`),
    new RegExp(`^\\s*${KEYWORDS}${n}\\s*[:=]\\s*(?:async\\s*)?(?:function|(?:${GENERICS}\\s*)?\\(|[A-Za-z_$][\\w$]*\\s*=>)`),
  ];
}

/** Lines (0-based) that define `name`, most specific patterns first. */
function findDefinitions(lines: string[], name: string, from: number, to: number): number[] {
  const found: number[] = [];
  for (const pattern of definitionPatterns(name)) {
    for (let i = from; i < to; i++) {
      if (!found.includes(i) && pattern.test(lines[i]) && !/^\s*(?:\/\/|#|\*|--)/.test(lines[i])) found.push(i);
    }
  }
  return found;
}

/** The 1-based last line of the definition starting at 0-based `start`. */
function extent(lines: string[], start: number): number {
  // Braces: from the first `{` within a few lines, to its match.
  for (let i = start; i < Math.min(lines.length, start + 6); i++) {
    if (lines[i].includes("{")) return matchBraces(lines, i) ?? i + 1;
    if (i > start && /[;]\s*$/.test(lines[i - 1])) break;
    if (/:\s*$/.test(lines[i]) && !lines[i].includes("{")) return byIndentation(lines, start);
  }
  // A one-line definition (`const X = 1;`) or an indentation block.
  return /[;,)]\s*$/.test(lines[start]) ? start + 1 : byIndentation(lines, start);
}

function matchBraces(lines: string[], from: number): number | null {
  let depth = 0;
  let opened = false;
  for (let i = from; i < lines.length; i++) {
    for (const ch of stripStrings(lines[i])) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") depth--;
    }
    if (opened && depth <= 0) return i + 1;
  }
  return null;
}

function byIndentation(lines: string[], start: number): number {
  const indent = (line: string) => line.length - line.trimStart().length;
  const base = indent(lines[start]);
  let last = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    if (indent(lines[i]) <= base) break;
    last = i;
  }
  return last + 1;
}

/** A line without string and character literals and line comments, for brace counting. */
function stripStrings(line: string): string {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}
