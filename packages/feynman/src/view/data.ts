// What the CLI hands the explorer: `feynman.json` next to the page, and one browser
// module per spec (and per spec at the base commit, when comparing).
import type { Report } from "../check/index.ts";

/**
 * What `feynman build` writes into its single page, in `<script type="application/json"
 * id="feynman">`: the bundle, and each module's code by the page-relative path entries name.
 */
export interface Embedded {
  bundle: Bundle;
  modules: Record<string, string>;
}

export interface Bundle {
  generatedAt: string;
  /** Served by `feynman dev`: the page reloads when specs change. */
  dev: boolean;
  repository: {
    name: string;
    commit: string;
    dirty: boolean;
    branch: string | null;
    /** `https://host/org/repo/blob/<commit>/{path}`. */
    fileUrl: string | null;
  };
  /** The commit flows are compared with, if any. */
  base: { ref: string; commit: string } | null;
  specs: SpecEntry[];
}

export interface SpecEntry {
  /** The file name without `.ts`; unique within a bundle. */
  id: string;
  /** Repository-relative path of the spec file. */
  path: string;
  /** Page-relative URL of the spec's browser module. */
  module: string | null;
  /** Page-relative URL of the spec's playground module (`<name>.play.tsx`), if it has one. */
  playModule: string | null;
  /** The spec at the base commit, when it existed there. */
  baseModule: string | null;
  /** Why the spec could not be loaded or bundled. */
  error: string | null;
  sources: Record<string, SourceEntry>;
  /** Call trees under `path#symbol` sources. */
  calls: Record<string, CallNode>;
  /** The code of each function the call trees reach, by `functionId(def)`; each once, however often it is called. */
  functions: Record<string, FunctionCode>;
  report: Report | null;
}

export interface SourceEntry {
  status: "fresh" | "new" | "stale" | "missing";
  reason?: string;
  start?: number;
  end?: number;
  text?: string;
  /** `text` highlighted, one array of tokens per line; absent for languages shown plain. */
  lines?: CodeToken[][];
  url?: string;
}

/** A run of highlighted code: its text, and its colour in light and dark mode. */
export interface CodeToken {
  t: string;
  c?: string;
  d?: string;
}

export interface CallNode {
  label: string;
  /** The root: where it is defined. A call: where it is made, in its caller. */
  file?: string;
  line?: number;
  /** calldiff's name for the function: "foo", "Class.method". */
  key?: string;
  /** For a call: where the function it calls is defined, when it is in our own code. */
  def?: { file: string; line: number; endLine: number };
  external?: boolean;
  children: CallNode[];
}

/** A function's code, as the Code view shows it when its call is opened. */
export interface FunctionCode {
  file: string;
  start: number;
  end: number;
  text: string;
  lines?: CodeToken[][];
  url?: string;
}

/** The key a function's code is kept under: where it is defined. */
export function functionId(def: { file: string; line: number }): string {
  return `${def.file}:${def.line}`;
}
