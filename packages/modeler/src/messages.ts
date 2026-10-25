// What the driven agent is told.
import { describeCoverage, groupMissing, SCHEMA_DIR, type CoverageReport } from "@feynman/model";
import { MODEL_DIR, type Start } from "./workspace.ts";

/** How many unreviewed paths a continuation lists by name. */
const LISTED_PATHS = 40;

export function kickoff(start: Start, report: CoverageReport): string {
  const scope =
    start.kind === "update"
      ? `an update from ${start.base.slice(0, 7)} to ${start.commit.slice(0, 7)}: review the ${report.required.length} files changed since, and edit the elements they affect`
      : start.kind === "bootstrap"
        ? `a first snapshot at ${start.commit.slice(0, 7)}: review all ${report.required.length} tracked files`
        : `resuming the ${start.mode} at ${start.commit.slice(0, 7)}: ${report.missing.length} of ${report.required.length} files are still unreviewed`;
  return [
    `Extract the Feynman model of this repository, following the modelling skill. This is ${scope}.`,
    "",
    `The model lives in ${MODEL_DIR}/, one JSON file per element; each kind's JSON Schema is in ${SCHEMA_DIR}.`,
    "Work the way you would to understand the system: start from the entrypoints and follow the code across files, wherever it leads. As you go, write and refine model elements, and record the files you have read with feynman_reviewed. Use feynman_status to see what is left.",
    "Whenever you stop, I will check which files are still unreviewed and whether the model is valid, and ask you to continue until nothing is left.",
  ].join("\n");
}

/** Coverage and problems; `nudge` adds the request to continue. */
export function continuation(report: CoverageReport, problems: string[], nudge = true): string {
  const out = [`Feynman: ${describeCoverage(report)}.`];
  if (report.missing.length) {
    if (nudge) out.push(`${report.missing.length} files are still unreviewed. Continue: follow the code into them, update the model, and record them with feynman_reviewed.`);
    out.push("", "Unreviewed, by directory:");
    for (const [group, n] of groupMissing(report.missing).slice(0, 20)) out.push(`  ${String(n).padStart(4)}  ${group}`);
    out.push("", "Some of them:", ...report.missing.slice(0, LISTED_PATHS).map((path) => `  ${path}`));
  }
  if (problems.length) {
    out.push("", `The model has ${problems.length} problem(s)${nudge ? "; fix them" : ""}:`, ...problems.slice(0, 20).map((problem) => `  ${problem}`));
  }
  return out.join("\n");
}
