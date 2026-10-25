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
  const at = `${start.commit.slice(0, 7)}${start.worktree ? " with your uncommitted changes" : ""}`;
  const scope =
    start.kind === "update"
      ? `an update from ${start.base.slice(0, 7)} to ${at}, covering the ${report.required.length} files changed since`
      : start.kind === "bootstrap"
        ? `a first snapshot at ${at}, covering ${report.required.length} files`
        : `resuming the ${start.mode} at ${at}; ${report.missing.length} of ${report.required.length} files are still unread`;
  return [
    `Extract the Feynman model of this repository, following the modelling skill. This is ${scope}.`,
    `The model lives in ${MODEL_DIR}/, one JSON file per element; each kind's JSON Schema is in ${SCHEMA_DIR}.`,
    "",
    "The extraction runs in three phases, and I will tell you when each one is done:",
    "  1. Actors: who and what takes part in the system, and the components inside them.",
    "  2. Flows: groups of connected actors, one at a time, reading their code in full.",
    "  3. Depth: flows, protocols, invariants, claims, and limits, made precise.",
    SCOPE,
    "Files you read in full are recorded automatically. Use feynman_skip to set aside development, vendored, and generated files, and feynman_status to see where you are.",
    ...outdated(report),
    "",
    phase === 1 ? PHASE_1 : phase === 2 ? phase2(group) : PHASE_3,
  ].join("\n");
}

const SCOPE = [
  "",
  "Scope: the model explains how the system behaves for the people and programs that use it, as it runs: what its actors do, how they talk, what they keep and enforce. It does not explain how the system is developed. Before anything else, decide what the system is: what ships, and what runs when it is used.",
  "Files about developing the system are not part of it: tests, CI, build, release, and publishing scripts, workspace and tooling setup, project websites, and docs for contributors. Set them aside with feynman_skip as development, saying what each is for, without reading them in full; they never become actors, components, flows, or protocols. Code that runs when the system is used is part of it, even inside a build or scripts directory. Tests may still be cited as evidence for invariants.",
].join("\n");

const PHASE_1 = [
  "Phase 1: actors. Survey the whole repository before reading anything in depth: list the tree, read manifests, READMEs, entrypoints, and configuration, and skim widely; partial reads are fine now. Set aside the development files as you find them.",
  "Then write meta.json (what the system is and does) and the actors: things with a runtime identity that take part in its behaviour. Start from whoever uses the system (a person, or another program such as a client), then follow what it talks to:",
  "  - people (kind person) and programs or services that use the system or that it calls;",
  "  - the processes this repository ships (first-party), such as a CLI, a server, a browser page, or a plugin running inside a host program (the host is its own actor).",
  "Packages, modules, and libraries are not actors. Write them as components: each with footprint.paths covering its code, the actors it runs in, and the components it depends on. Every first-party actor needs at least one component.",
  "In each actor's talksTo, list the actors it communicates with. Don't write flows yet. Stop when the map covers the whole system.",
].join("\n");

const PHASE_2 = [
  "Phase 2: flows. Work through the system one group of connected actors at a time. For each group, read the listed files in full (continue truncated reads with offsets), then write the flows that run through these actors.",
  "A flow is a behaviour of the system, a job it does for an actor: what triggers it, step by step which actor does what to which other actor (over which protocol, by which component), and the outcome. Loading a plugin or installing dependencies is how the system starts or is built, not something it does.",
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
    ? `Next group: ${group.actors.join(", ")}${group.neighbours.length ? `, which ${talk} to ${group.neighbours.join(", ")}` : ""}; components ${group.components.join(", ")}. Read ${files} (~${kb} KB):`
    : `Last group: files outside every component's footprint (~${kb} KB). Set aside the ones about developing the system as development; read the rest, which belong to a component or configure how the system runs:`;
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
