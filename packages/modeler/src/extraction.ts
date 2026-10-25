// Drive one agent through extracting a model, in three phases (see phases.ts),
// until every file it is responsible for is covered, the model is valid, and it is
// no longer thin.
//
// This is independent of any agent runtime. An adapter tells it which files the
// agent read, exposes `begin`, `skip`, and `status` as the agent's tools, and asks
// `onStop` what to do whenever the agent is about to stop.
import {
  checkModel,
  computeCoverage,
  describeCoverage,
  loadModel,
  measureModel,
  readCoverage,
  recordCoverage,
  workingTreeBlobIds,
  type CoverageReport,
  type LedgerEntry,
  type Model,
  type Snapshot,
} from "@feynman/model";
import { statSync } from "node:fs";
import { join } from "node:path";
import { Evidence, type Read } from "./evidence.ts";
import { continuation, kickoff, type Situation } from "./messages.ts";
import { within } from "./paths.ts";
import { actorGaps, depthGaps, nextGroup, type Phase } from "./phases.ts";
import { findWorkspace, startExtraction, type Workspace } from "./workspace.ts";

/** An extraction being driven; persisted by the adapter so a resumed session carries on. */
export interface DriveState {
  repository: string;
  modelDir: string;
  phase: Phase;
  /** Render the model and show it once the extraction is done. */
  explain: boolean;
}

/** What the adapter should do when the agent is about to stop. */
export type StopDecision =
  /** Show `message` to the agent and let it continue. */
  | { kind: "continue"; message: string }
  /** The extraction is complete; show `message`, and the rendered model when `explain`. */
  | { kind: "done"; message: string; explain: boolean }
  /** Stopped driving (no progress, or an error); tell the user `message`. */
  | { kind: "paused"; message: string };

/** Outcomes the agent may record without reading: files outside the system's behaviour. */
export const SKIP_OUTCOMES = ["development", "vendored", "generated"] as const;
export type SkipOutcome = (typeof SKIP_OUTCOMES)[number];

/** Stop driving after this many continuations without progress. */
const MAX_STALLS = 3;

export interface ExtractionOptions {
  /** Directory the agent works in. */
  cwd: string;
  /** Name of this session's coverage ledger (`coverage/<ledger>.json`). */
  ledger: string;
  /** Called whenever driving starts, changes phase, or stops (with null), so the adapter can persist it. */
  onStateChange?: (state: DriveState | null) => void;
}

/** What an extraction looks like right now, before deciding anything. */
interface Assessment {
  model: Model;
  report: CoverageReport;
  problems: string[];
}

/** Counts whose change means the agent made progress since the last stop. */
interface Progress {
  phase: Phase;
  missing: number;
  problems: number;
  gaps: number;
}

export class Extraction {
  readonly workspace: Workspace | null;
  private state: DriveState | null = null;
  private evidence: Evidence | null = null;
  /** What is modelled and the files required; computed once per drive. */
  private scope: { snapshot: Snapshot; required: Set<string> } | null = null;
  private last: Progress | null = null;
  private stalls = 0;

  constructor(private readonly options: ExtractionOptions) {
    this.workspace = findWorkspace(options.cwd);
  }

  get driving(): boolean {
    return this.state !== null;
  }

  /** Restore persisted state, e.g. when a session is resumed. Anything unrecognised means not driving. */
  restore(saved: unknown) {
    this.state = parseDriveState(saved);
    this.scope = null;
  }

  // What the agent did.

  /** A read; once a required file has been read in full, it is recorded in the ledger. */
  noteRead(cwd: string, path: string, read?: Read) {
    if (!this.workspace) return;
    const file = this.seen().read(cwd, path, read);
    if (file && this.driving) this.recordRead([file]);
  }

  /** Ledgers are written only by the extraction; adapters should block other writes. */
  isLedgerPath(cwd: string, path: string): boolean {
    return this.workspace !== null && within(join(this.workspace.modelDir, "coverage"), cwd, path) !== null;
  }

  // The agent's operations.

  /**
   * Prepare the model at HEAD, start driving, and return the agent's instructions.
   * With `explain`, finishing asks the adapter to render and show the model. Beginning
   * again while driving (the agent calls the extract tool after `/feynman-explain`)
   * keeps that request.
   */
  begin({ explain = false }: { explain?: boolean } = {}): string {
    explain ||= this.state?.explain ?? false;
    const ws = this.requireWorkspace();
    const start = startExtraction(ws);
    // A fresh model starts by mapping actors; with actors already modelled, by reading groups.
    const phase: Phase = loadModel(ws.modelDir).actors.some((actor) => actor.provenance === "first-party") ? 2 : 1;
    this.scope = null;
    this.setState({ repository: ws.repository, modelDir: ws.modelDir, phase, explain });
    // Files read before the extraction started count too.
    this.recordRead(this.seen().files());
    const situation = this.situation(ws, this.assess(ws), phase, false);
    return kickoff(start, situation.report, phase, situation.group);
  }

  /** Record development, vendored, or generated files or trees (a path ending in `/`), which need not be read. */
  skip(paths: string[], outcome: SkipOutcome, note: string): { text: string; recorded: number; rejected: string[] } {
    const ws = this.requireWorkspace();
    const { snapshot, required } = this.requireScope(ws);
    const accepted: LedgerEntry[] = [];
    const rejected: string[] = [];
    for (const raw of paths) {
      const path = raw.replace(/^\.\//, "");
      const known = path.endsWith("/") ? [...required].some((file) => file.startsWith(path)) : required.has(path);
      if (!note.trim()) rejected.push(`${path}: say in note ${outcome === "development" ? "what it is for" : "where it comes from"}`);
      else if (!known) rejected.push(`${path}: not a file this extraction covers (ignored, excluded by .feynman/config.json, or unchanged)`);
      else accepted.push({ path, outcome, note });
    }
    if (accepted.length) recordCoverage(ws.modelDir, this.options.ledger, snapshot.commit, "Covered in an agent session.", accepted);
    const text = [
      `Recorded ${accepted.length} path(s) as ${outcome}. ${describeCoverage(computeCoverage(ws.repository, ws.modelDir))}.`,
      ...(rejected.length ? ["Rejected:", ...rejected.map((reason) => `  ${reason}`)] : []),
    ].join("\n");
    return { text, recorded: accepted.length, rejected };
  }

  /** Phase, coverage, the current group or gaps, and problems; every uncovered path when `listMissing`. */
  status(listMissing = false): { text: string; missing: number; problems: number } {
    const ws = this.requireWorkspace();
    const situation = this.situation(ws, this.assess(ws), this.state?.phase ?? 2, false);
    const { report, problems } = situation;
    const text = listMissing
      ? [describeCoverage(report), ...report.missing, ...(problems.length ? ["", `${problems.length} problem(s):`, ...problems] : [])].join("\n")
      : continuation(situation, false);
    return { text, missing: report.missing.length, problems: problems.length };
  }

  /** One line for the user. */
  summary(): string {
    const { report, problems } = this.assess(this.requireWorkspace());
    const validity = problems.length ? `${problems.length} model problem(s)` : "model valid";
    return `${describeCoverage(report)}; ${validity}${this.state ? `; driving, phase ${this.state.phase} of 3` : ""}`;
  }

  /** Stop driving. */
  stop() {
    if (this.state) this.setState(null);
  }

  /** The agent is about to stop: decide whether it continues. Null when not driving. */
  onStop(): StopDecision | null {
    const state = this.state;
    if (!state) return null;
    let situation: Situation;
    try {
      const assessment = this.assess(state);
      const phase = nextPhase(state.phase, assessment);
      if (phase !== state.phase) this.setState({ ...state, phase });
      situation = this.situation(state, assessment, phase, phase !== state.phase);
    } catch (error) {
      this.stop();
      return { kind: "paused", message: `Feynman stopped: ${(error as Error).message}` };
    }
    if (isDone(situation)) return this.finish(state, situation.report);
    if (this.stalled(situation)) {
      this.stop();
      return { kind: "paused", message: `Feynman paused in phase ${situation.phase}: no progress after ${MAX_STALLS} reminders. ${describeCoverage(situation.report)}.` };
    }
    return { kind: "continue", message: continuation(situation) };
  }

  // Internals.

  private assess(ws: Workspace): Assessment {
    const report = computeCoverage(ws.repository, ws.modelDir);
    return { model: loadModel(ws.modelDir), report, problems: [...report.problems, ...checkModel(ws.modelDir, ws.repository)] };
  }

  /** What the agent is told in `phase`: the next group to read, or what the model lacks. */
  private situation(ws: Workspace, { model, report, problems }: Assessment, phase: Phase, entered: boolean): Situation {
    const group = phase >= 2 ? nextGroup(model, report.missing, fileSizes(ws.repository, report.missing)) : null;
    const gaps = phase === 1 ? actorGaps(model) : phase === 3 ? depthGaps(model, report.required) : [];
    return { phase, report, problems, gaps, group, entered };
  }

  private finish(state: DriveState, report: CoverageReport): StopDecision {
    const measured = measureModel(state.repository, state.modelDir);
    this.stop();
    const message = `Feynman: ${describeCoverage(report)} (${outcomes(state.modelDir, report)}), and the model is valid. ${measured}.`;
    return { kind: "done", explain: state.explain, message };
  }

  /** Whether this stop shows no progress since the last; true after MAX_STALLS such stops in a row. */
  private stalled({ phase, report, problems, gaps }: Situation): boolean {
    const progress: Progress = { phase, missing: report.missing.length, problems: problems.length, gaps: gaps.length };
    const same = this.last !== null && (Object.keys(progress) as (keyof Progress)[]).every((key) => this.last![key] === progress[key]);
    this.stalls = same ? this.stalls + 1 : 0;
    this.last = progress;
    return this.stalls >= MAX_STALLS;
  }

  private recordRead(files: string[]) {
    const ws = this.requireWorkspace();
    const { snapshot, required } = this.requireScope(ws);
    const read = files.filter((file) => required.has(file));
    if (!read.length) return;
    // In the working tree, record what was read, so later edits make the file unread again.
    const hashes = snapshot.worktree ? workingTreeBlobIds(ws.repository, read) : null;
    const entries = read.map((path): LedgerEntry => {
      const hash = hashes?.get(path);
      return hash ? { path, outcome: "read", hash } : { path, outcome: "read" };
    });
    recordCoverage(ws.modelDir, this.options.ledger, snapshot.commit, "Covered in an agent session.", entries);
  }

  private requireScope(ws: Workspace) {
    if (!this.scope) {
      const report = computeCoverage(ws.repository, ws.modelDir);
      this.scope = { snapshot: report.snapshot, required: new Set(report.required) };
    }
    return this.scope;
  }

  private setState(state: DriveState | null) {
    this.state = state;
    this.last = null;
    this.stalls = 0;
    this.options.onStateChange?.(state);
  }

  private requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error("Not inside a git repository.");
    return this.workspace;
  }

  private seen(): Evidence {
    this.evidence ??= new Evidence(this.requireWorkspace().repository);
    return this.evidence;
  }
}

/** Phases only move forward: past actors once the map has no gaps, past flows once every file is covered. */
function nextPhase(phase: Phase, { model, report, problems }: Assessment): Phase {
  if (problems.length) return phase;
  if (phase === 1 && actorGaps(model).length === 0) return 2;
  if (phase === 2 && report.missing.length === 0) return 3;
  return phase;
}

/** Done in phase 3, after its instructions were shown, with nothing missing, wrong, or thin. */
function isDone({ phase, entered, report, problems, gaps }: Situation): boolean {
  return phase === 3 && !entered && report.missing.length === 0 && problems.length === 0 && gaps.length === 0;
}

function parseDriveState(saved: unknown): DriveState | null {
  if (!saved || typeof saved !== "object") return null;
  const { repository, modelDir, phase, explain, active } = saved as Record<string, unknown>;
  // Entries written before the state became null when stopped say `active: false`.
  if (active === false) return null;
  if (typeof repository !== "string" || typeof modelDir !== "string" || (phase !== 1 && phase !== 2 && phase !== 3)) return null;
  return { repository, modelDir, phase, explain: explain === true };
}

/** Size in bytes of each file on disk, which is what the agent reads. */
function fileSizes(repository: string, files: string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const file of files) {
    try {
      sizes.set(file, statSync(join(repository, file)).size);
    } catch {
      // Gone from disk; it counts as empty.
    }
  }
  return sizes;
}

/** "120 read, 3 generated": ledger outcomes for the report's commit. */
function outcomes(modelDir: string, report: CoverageReport): string {
  const counts = new Map<string, number>();
  for (const { value } of readCoverage(modelDir)) {
    if (value.commit !== report.snapshot.commit) continue;
    for (const entry of value.files) counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);
  }
  return [...counts].map(([outcome, n]) => `${n} ${outcome}`).join(", ");
}
