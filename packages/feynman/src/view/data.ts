// What the CLI hands the explorer: `feynman.json` next to the page, and one browser
// module per spec (and per spec at the base commit, when comparing).
import type { Report } from "../check/index.ts";
import type { At, RunSource } from "../explain/index.ts";
import type { Event, World } from "../spec/index.ts";

/**
 * What `feynman build` writes into its single page, in `<script type="application/json"
 * id="feynman">`: the bundle, and each module's code by the page-relative path entries name.
 */
export interface Embedded {
  bundle: Bundle;
  modules: Record<string, string>;
  /** When the page is an explainer (RFD0013): the story, told around figures of the bundle's one spec. */
  explainer?: Explainer;
}

/** An explainer, as `feynman explain` resolved it: prose rendered, and every figure recorded from a run. */
export interface Explainer {
  title: string;
  lede: string;
  blocks: ExplainerBlock[];
  /** Page-relative URL of the explainer's own figures (`<spec>.explainer.tsx`), if it has some. */
  module: string | null;
  /** For each rule some property needs: the shortest way the design breaks without it. */
  runs: Record<string, BrokenRun>;
  /** What the figures were made from. */
  provenance: { commit: string; dirty: boolean; depth: number };
}

export interface BrokenRun {
  property: string;
  initial: World;
  events: Event[];
  worlds: World[];
  /** The event that broke the property, 1-based; for liveness, the last before it went wrong for good. */
  brokeAt: number;
  /** How a liveness counterexample ends: going round a loop, or stuck where it is. */
  ending: "loops" | "stays" | "breaks";
}

/** A run a figure draws from (src/explain/index.ts). */
export type FigureRun = RunSource;

export type ExplainerBlock =
  | { kind: "section"; id: string; number: number; title: string }
  | { kind: "prose"; html: string }
  | { kind: "callout"; tone: "decision" | "finding" | "incident" | "note"; html: string }
  /** The world at the start: the spec's, or after a scenario's setup, which adds who takes part. */
  | { kind: "map"; scenario?: string }
  /** The stage frozen at a moment of a run. */
  | { kind: "still"; run: FigureRun; at?: At }
  /** A run told in the events that matter, one line each. */
  | { kind: "steps"; run: FigureRun; at: At[] }
  /** The whole playground, to play with. */
  | { kind: "play"; run: FigureRun }
  | { kind: "flow"; run: FigureRun }
  /** A component the explainer file exports. */
  | { kind: "figure"; name: string }
  | { kind: "verdicts" }
  | { kind: "rules" };

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
