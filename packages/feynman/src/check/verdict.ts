// How a property is read out: from the report, the scenarios that break it, and `known`.
import type { PropertyResult, Report } from "./explore.ts";

/** A property's verdict, as `check` reads it out. */
export type Verdict =
  /** Holds in every state within the bounds; for a reachable property, some world gets there. */
  | "holds"
  /** Held in the states explored, but exploration stopped early, the depth bound cut paths off, or a step drew a random number. */
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
  const complete = result.report.exhaustive && !result.report.cutAtDepth && !result.report.chance?.length;
  // A reachable property: found is found, whatever the bounds. Not found is a ✗ only when every
  // world within them was explored; until then, it may be further on.
  if (property.kind === "reachable") {
    if (property.holds) return property.known !== undefined ? "fixed" : "holds";
    if (property.known !== undefined) return "known";
    return complete ? "broken" : "unfinished";
  }
  const broken = !property.holds || result.brokenBy.has(property.id);
  if (property.known !== undefined) return broken ? "known" : "fixed";
  if (broken) return "broken";
  if (property.tested === 0) return "untested";
  // Paths cut off at the depth bound may break it further on: held to that depth is not a proof.
  return complete && !property.unfinished ? "holds" : "unfinished";
}
