// How check reads a property out: from the report, the scenarios that break it, and `known`.
import type { PropertyResult, Report } from "../check/index.ts";

/** A property's verdict, as `check` reads it out. */
export type Verdict =
  /** Holds in every state within the bounds. */
  | "holds"
  /** Held in the states explored, but exploration stopped early, or (liveness) a loop may lie past the depth bound. */
  | "unfinished"
  /** No explored world got to where it applies. */
  | "untested"
  | "broken"
  /** Broken, and marked `known`: expected until the bug is fixed. */
  | "known"
  /** Marked `known`, but holds now: the mark is stale. */
  | "fixed";

/** A property's verdict. A scenario that breaks it counts, whatever exploration found. */
export function verdictOf(property: PropertyResult, result: { report: Report; brokenBy: Map<string, string> }): Verdict {
  const broken = !property.holds || result.brokenBy.has(property.id);
  if (property.known !== undefined) return broken ? "known" : "fixed";
  if (broken) return "broken";
  if (property.tested === 0) return "untested";
  return result.report.exhaustive && !property.unfinished ? "holds" : "unfinished";
}
