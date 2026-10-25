// Anchors: where model elements point into the repository. Safe to import from
// browser code (no Node APIs), so the renderer shares this parser.
import type { Anchor, Position, ResolvedAnchor, Source } from "./types.ts";

const SHORTHAND = /^([^#:]+)(?::(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?)?(?:#(.+))?$/;

/** Either anchor form as `{ file, symbol?, span? }`. */
export function resolveAnchor(anchor: Anchor): ResolvedAnchor {
  if (typeof anchor !== "string") return anchor;
  const match = SHORTHAND.exec(anchor);
  if (!match) return { file: anchor };
  const [, file, startLine, startColumn, endLine, endColumn, symbol] = match;
  const position = (line: string, column?: string): Position => ({ line: Number(line), ...(column ? { column: Number(column) } : {}) });
  return {
    file,
    ...(symbol ? { symbol } : {}),
    ...(startLine ? { span: { start: position(startLine, startColumn), ...(endLine ? { end: position(endLine, endColumn) } : {}) } } : {}),
  };
}

/** `10-42` or `10:5-42:2`, for display. */
export function spanLabel(span: ResolvedAnchor["span"]): string | null {
  if (!span) return null;
  const at = (p: Position) => (p.column ? `${p.line}:${p.column}` : `${p.line}`);
  return span.end ? `${at(span.start)}-${at(span.end)}` : at(span.start);
}

/** Browsable URL for an anchor at the modelled commit, with a line range when known. */
export function anchorUrl(source: Source, anchor: Anchor): string | null {
  if (!source.fileUrl) return null;
  const { file, span } = resolveAnchor(anchor);
  const end = span?.end && span.end.line !== span.start.line ? `-L${span.end.line}` : "";
  return source.fileUrl.replace("{path}", file) + (span ? `#L${span.start.line}${end}` : "");
}

/** Every anchor in a model or element (anchors, evidence, tests, definitions, step and frame anchors, stage entries), resolved. */
export function modelAnchors(value: unknown): ResolvedAnchor[] {
  const anchors: ResolvedAnchor[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(collect);
    else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      for (const key of ["anchors", "evidence", "tests", "definitions"]) {
        const list = record[key];
        if (Array.isArray(list)) for (const anchor of list) anchors.push(resolveAnchor(anchor as Anchor));
      }
      for (const key of ["anchor", "entry"]) if (record[key]) anchors.push(resolveAnchor(record[key] as Anchor));
      Object.values(record).forEach(collect);
    }
  };
  collect(value);
  return anchors.filter((anchor) => anchor.file);
}

/** Files a model or element anchors directly (footprints do not count). */
export function anchoredFiles(value: unknown): Set<string> {
  return new Set(modelAnchors(value).map((anchor) => anchor.file));
}
