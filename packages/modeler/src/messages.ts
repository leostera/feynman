// What the driven agent is told.
import { describeCoverage, describeSnapshot, SCHEMA_DIR, type CoverageReport } from "@feynman/model";
import type { Group, Phase } from "./phases.ts";
import { MODEL_DIR, type Start } from "./workspace.ts";

const LISTED = 30;

const list = (items: string[], limit = LISTED) => [
  ...items.slice(0, limit).map((item) => `  ${item}`),
  ...(items.length > limit ? [`  … and ${items.length - limit} more`] : []),
];

export function kickoff(start: Start, report: CoverageReport, phase: Phase, group: Group | null): string {
  const at = describeSnapshot(report.snapshot);
  const scope =
    start.kind === "update"
      ? `an update from ${start.base.slice(0, 7)} to ${at}, covering the ${report.required.length} files changed since`
      : start.kind === "bootstrap"
        ? `a first snapshot at ${at}, covering ${report.required.length} files`
        : `resuming the ${start.mode} at ${at}; ${report.missing.length} of ${report.required.length} files are not covered yet`;
  return [
    `Extract the Feynman model of this repository, following the modelling skill. This is ${scope}.`,
    `The model lives in ${MODEL_DIR}/, one JSON file per element; each kind's JSON Schema is in ${SCHEMA_DIR}.`,
    "It runs in three phases (actors, flows, depth), and I will tell you when each is done.",
    "",
    SCOPE,
    ...outdated(report),
    "",
    phase === 1 ? PHASE_1 : phase === 2 ? phase2(group) : PHASE_3,
  ].join("\n");
}

const SCOPE = [
  "Scope: model how the system behaves as it runs, for the people and programs that use it; not how it is developed. First decide what ships and what runs when it is used.",
  "- Development files (CI, build, release and publishing scripts, tooling, project websites, contributor docs): set aside with feynman_skip as development, saying what each is for. They never become elements. Code that runs when the system is used is in scope wherever it lives.",
  "- Tests are in scope: read them, and record what they check as invariants (with their tests), claims (with tests as evidence), and limits.",
  "- Files you read in full are recorded automatically. Skip vendored and generated files too, with their origin.",
  "",
  "Write what a newcomer needs to understand the system, and stop there: fewer, essential elements explain better and are extracted faster. A few journeys for what the system exists to do; one flow per distinct behaviour behind a stage (variants that behave alike are one flow; error paths only when the user sees them differently); limits a user can hit (input sizes, timeouts, rates), not internal buffers or display caps; invariants the system's correctness depends on; one sentence per step.",
  "",
  "How to work: Feynman checks each model file as you write it, and coverage, validity, and what is still thin whenever you stop; feynman_status shows the same. Don't run check, coverage, measure, tests, or your own scripts over the model. Write each element once, completely, rather than revising it. The schemas are fixed: if one cannot express something, say so in your last message instead of changing it. If a Feynman tool reports something that looks wrong, tell the user.",
].join("\n");

const PHASE_1 = [
  "Phase 1: actors. Survey the whole repository shallowly: the tree, manifests, READMEs, entrypoints, configuration. Partial reads are fine now.",
  "Write meta.json (what the system is and does), then the actors, things with a runtime identity, starting from whoever uses the system:",
  "  - the people who use it (kind person), and what they touch to do so;",
  "  - the processes this repository ships (first-party): a CLI, a server, a browser page, a plugin. A plugin or page names the program it runs inside as its host (Pi, the browser); people talk to the host;",
  "  - external services whose behaviour shapes what the system does: a database it stores in, an API it depends on, a program it exists to run.",
  "Keep the map to what you would draw explaining the system to a newcomer. Runtimes, the OS, shells, and tools the code merely calls (git, bun, a compiler) are how it is built, not actors: mention them in components or flow steps. Connect only actors where one end is first-party or a person; how two external programs talk is not this system.",
  "Packages and modules are components, not actors: each with footprint.paths, the actors it runs in, and what it dependsOn. Every first-party actor needs one.",
  "Fill each actor's talksTo. Then write the journeys: the jobs the system does for the people (or client programs) that use it, told from their side. Each names who it is for, their need, the value they end with, and the stages they go through: what they do and what they see (\"Runs /feynman-explain in Pi\", \"The explainer opens in the browser\"). Start from what the README, commands, CLIs, and routes offer; a few journeys that cover what the system is for beat many small ones.",
  "No flows yet; stop when the map and the journeys cover the whole system.",
].join("\n");

const PHASE_2 = [
  "Phase 2: flows. For each group of connected actors, read the listed files in full (continue truncated reads with offsets), including tests, then write the flows that run through them.",
  "A flow is how the system carries out a journey stage: a trigger, steps saying which actor does what to which (with component and protocol), and an outcome. Add each flow to the stage it implements (stage.flows), or call it from a flow that does (step.ref). Anchor every step in a first-party actor to the function that does it, as path#symbol (ClassName.method for methods): its call tree is measured from there. Starting up or being built is not a flow.",
  "Add the protocols, state, invariants, claims, and limits you meet, each complete when first written: protocols with their messages, fields, results, framing, and versioning; invariants with enforcement, the call path from trigger to check (enforcedAt), and their tests; claims with evidence; limits with where they are set. Include failure, retry, and recovery flows.",
  "Fix the actor map when the code disagrees. Stop when the group is done, and I will give you the next one.",
].join("\n");

const PHASE_3 = "Phase 3: depth. Every file is covered. Fix what is listed below, re-reading code where needed, then stop; the extraction is done when nothing is listed. Don't polish beyond it.";

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
    : `Last group: files outside every component's footprint (~${kb} KB). Set aside the ones about developing the system as development; read the rest (tests included), which belong to a component, check its behaviour, or configure how it runs:`;
  return [head, ...list(group.files, 80), ...(group.remaining ? [`(${group.remaining} more unread file${group.remaining === 1 ? "" : "s"} in later groups.)`] : [])];
}

/** Elements derived from files that changed: they must be re-examined, not just the files. */
function outdated(report: CoverageReport): string[] {
  if (!report.outdated.length) return [];
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
export function continuation(situation: Situation, nudge = true): string {
  const { phase, report, problems } = situation;
  const out = [`Feynman, phase ${phase} of 3: ${describeCoverage(report)}.`, ...progress(situation, nudge)];
  if (problems.length) out.push("", `The model has ${problems.length} problem(s)${nudge ? "; fix them" : ""}:`, ...list(problems, 20));
  return out.join("\n");
}

/** A new phase's instructions; otherwise what remains in the current one. */
function progress({ phase, gaps, group, entered }: Situation, nudge: boolean): string[] {
  const more = nudge ? "; continue" : "";
  if (entered && phase === 3) return ["", PHASE_3, ...(gaps.length ? ["", "The model is thin here:", ...list(gaps)] : [])];
  if (entered) return ["", phase === 2 ? phase2(group) : PHASE_1];
  if (phase === 1) return gaps.length ? ["", `The actor map is not done${more}:`, ...list(gaps)] : [];
  // Files edited after they were read come back as a group in phase 3 too.
  if (group) return ["", ...describeGroup(group)];
  return phase === 3 && gaps.length ? ["", `The model is still thin here${more}:`, ...list(gaps)] : [];
}
