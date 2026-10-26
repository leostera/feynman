// What the CLI hands the explorer: `feynman.json` next to the page, and one browser
// module per spec (and per spec at the base commit, when comparing).
import type { Report } from "@feynman/check";

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
  report: Report | null;
}

export interface SourceEntry {
  status: "fresh" | "new" | "stale" | "missing";
  reason?: string;
  start?: number;
  end?: number;
  text?: string;
  url?: string;
}

export interface CallNode {
  label: string;
  file?: string;
  line?: number;
  external?: boolean;
  children: CallNode[];
}
