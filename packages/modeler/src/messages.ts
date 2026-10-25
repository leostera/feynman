// What the driven agent is told.
import { describeCoverage, SCHEMA_DIR, type CoverageReport } from "@feynman/model";
import type { Group, Phase } from "./phases.ts";
import { MODEL_DIR, type Start } from "./workspace.ts";

const LISTED = 30;

const list = (items: string[], limit = LISTED) => [
  ...items.slice(0, limit).map((item) => `  ${item}`),
  ...(items.length > limit ? [`  … and ${items.length - limit} more`] : []),
];

export function kickoff(start: Start, report: CoverageReport, phase: Phase, group: Group | null): string {
  const scope =
    start.kind === "update"
      ? `an update from ${start.base.slice(0, 7)} to ${start.commit.slice(0, 7)}, covering the ${report.required.length} files changed since`
      : start.kind === "bootstrap"
        ? `a first snapshot at ${start.commit.slice(0, 7)}, covering ${report.required.length} tracked files`
        : `resuming the ${start.mode} at ${start.commit.slice(0, 7)}; ${report.missing.length} of ${report.required.length} files are still unread`;
  return [
    `Extract the Feynman model of this repository, following the modelling skill. This is ${scope}.`,
    `The model lives in ${MODEL_DIR}/, one JSON file per element; each kind's JSON Schema is in ${SCHEMA_DIR}.`,
    "",
    "The extraction runs in three phases, and I will tell you when each one is done:",
    "  1. Actors: a high-level map of the whole system.",
    "  2. Flows: groups of connected actors, one at a time, reading their code in full.",
    "  3. Depth: flows, protocols, invariants, claims, and limits, made precise.",
    "Files you read in full are recorded automatically. Use feynman_skip for vendored or generated files, and feynman_status to see where you are.",
    ...outdated(report),
    "",
    phase === 1 ? PHASE_1 : phase === 2 ? phase2(group) : PHASE_3,
  ].join("\n");
}

const PHASE_1 = [
  "Phase 1: actors. Survey the whole repository before reading anything in depth: list the tree, read manifests, READMEs, entrypoints, and configuration, and skim widely; partial reads are fine now.",
  "Then write meta.json (what the system is and does) and one file per actor:",
  "  - every first-party component that runs or is built on its own, with footprint.paths covering its code;",
  "  - every external party it interacts with: people, services, platforms, other programs.",
  "In each actor's talksTo, list the actors it communicates with. Don't write flows yet. Stop when the map covers the whole system.",
].join("\n");

const PHASE_2 = [
  "Phase 2: flows. Work through the system one group of connected actors at a time. For each group, read the listed files in full (continue truncated reads with offsets), then write the flows that run through these actors: what triggers each one, and step by step which actor does what to which other actor, over which protocol.",
  "Add the protocols, state, invariants, and limits you meet on the way; precision comes in phase 3. Fix the actor map whenever the code disagrees with it. Stop when the group is done, and I will give you the next one.",
].join("\n");

const PHASE_3 = [
  "Phase 3: depth. Every file has been read. Go back over the model as a whole and make it precise, re-reading code wherever you need to:",
  "  - flows: every step names its actor and target, and cross-actor steps their protocol; failures, retries, and recovery are flows too;",
  "  - protocols: messages with their fields and returns, framing, versioning, and compatibility;",
  "  - invariants: how each is enforced, the call path from trigger to check (enforcedAt), and the tests that cover it;",
  "  - claims: what docs, comments, and names promise, with evidence and whether the code bears it out;",
  "  - limits: sizes, timeouts, rates, and capacities, and where they are set;",
  "  - state machines, for state with a distinct lifecycle.",
  "Stop when the model explains how the system works; I will point out what is still thin.",
].join("\n");

function phase2(group: Group | null): string {
  return [PHASE_2, "", ...describeGroup(group)].join("\n");
}

function describeGroup(group: Group | null): string[] {
  if (!group) return [];
  const kb = Math.max(1, Math.round(group.bytes / 1000));
  const files = group.files.length === 1 ? "this file" : `these ${group.files.length} files`;
  const talk = group.actors.length === 1 ? "talks" : "talk";
  const head = group.actors.length
    ? `Next group: ${group.actors.join(", ")}${group.neighbours.length ? `, which ${talk} to ${group.neighbours.join(", ")}` : ""}. Read ${files} (~${kb} KB):`
    : `Last group: files outside every actor's footprint. Read them (~${kb} KB); they may belong in a footprint, or describe how the system is built, configured, or deployed:`;
  return [head, ...list(group.files, 80), ...(group.remaining ? [`(${group.remaining} more unread file${group.remaining === 1 ? "" : "s"} in later groups.)`] : [])];
}

/** Elements derived from files that changed: they must be re-examined, not just the files. */
function outdated(report: CoverageReport): string[] {
  if (!report.outdated?.length) return [];
  return [
    "",
    `${report.outdated.length} element(s) were derived from files that changed; re-examine each against its changed sources and update or remove it:`,
    ...list(report.outdated.map(({ kind, id, files }) => `${kind}/${id}: ${files.join(", ")}`)),
  ];
}

export interface Situation {
  phase: Phase;
  report: CoverageReport;
  problems: string[];
  /** Phase 1: what the actor map lacks. Phase 3: where the model is thin. */
  gaps: string[];
  group: Group | null;
  /** Whether the phase just changed, so its instructions are shown. */
  entered: boolean;
}

/** What the agent is told when it stops; `nudge` asks it to continue. */
export function continuation({ phase, report, problems, gaps, group, entered }: Situation, nudge = true): string {
  const out = [`Feynman, phase ${phase} of 3: ${describeCoverage(report).replace("reviewed", "read")}.`];
  if (entered) {
    out.push("", phase === 2 ? phase2(group) : phase === 3 ? PHASE_3 : PHASE_1);
    if (phase === 3 && gaps.length) out.push("", "To begin with, the model is thin here:", ...list(gaps));
  }
  else if (phase === 1 && gaps.length) out.push("", `The actor map is not done${nudge ? "; continue" : ""}:`, ...list(gaps));
  else if (phase === 2 || (phase === 3 && group)) out.push("", ...describeGroup(group));
  else if (phase === 3 && gaps.length) out.push("", `The model is still thin here${nudge ? "; continue" : ""}:`, ...list(gaps));
  if (problems.length) out.push("", `The model has ${problems.length} problem(s)${nudge ? "; fix them" : ""}:`, ...list(problems, 20));
  return out.join("\n");
}
