// Drive one agent through extracting a model, in three phases (see phases.ts),
// until every file it is responsible for has been read, the model is valid, and
// it is no longer thin.
//
// This is independent of any agent runtime. An adapter tells it which files the
// agent read, exposes `begin`, `skip`, and `status` as the agent's tools, and asks
// `onStop` what to do whenever the agent is about to stop.
import {
  checkModel,
  computeCoverage,
  describeCoverage,
  git,
  lines,
  loadModel,
  measureModel,
  readCoverage,
  recordReviewed,
  type CoverageReport,
  type LedgerEntry,
} from "@feynman/model";
import { join } from "node:path";
import { Evidence, type Read } from "./evidence.ts";
import { continuation, kickoff, type Situation } from "./messages.ts";
import { within } from "./paths.ts";
import { actorGaps, depthGaps, nextGroup, type Phase } from "./phases.ts";
import { findWorkspace, startExtraction, type Workspace } from "./workspace.ts";

/** Whether an extraction is being driven, and in which phase; persisted by the adapter. */
export interface DriveState {
  active: boolean;
  repository: string;
  modelDir: string;
  /** Absent in states saved before phases existed: treated as phase 2. */
  phase?: Phase;
}

/** What the adapter should do when the agent is about to stop. */
export type StopDecision =
  /** Show `message` to the agent and let it continue. */
  | { kind: "continue"; message: string }
  /** The extraction is complete; show `message`. */
  | { kind: "done"; message: string }
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
  /** Called whenever the drive state changes, so the adapter can persist it. */
  onStateChange?: (state: DriveState) => void;
}

export class Extraction {
  readonly workspace: Workspace | null;
  private state: DriveState | null = null;
  private evidence: Evidence | null = null;
  /** Files required at the modelled commit, and that commit; computed once per drive. */
  private scope: { commit: string; required: Set<string> } | null = null;
  private last: string | null = null;
  private stalls = 0;

  constructor(private readonly options: ExtractionOptions) {
    this.workspace = findWorkspace(options.cwd);
  }

  get driving(): boolean {
    return this.state?.active ?? false;
  }

  /** Restore persisted state, e.g. when a session is resumed. */
  restore(state: DriveState | null) {
    this.state = state?.active ? { ...state, phase: state.phase ?? 2 } : null;
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

  /** Prepare the model at HEAD, start driving, and return the agent's instructions. */
  begin(): string {
    const ws = this.requireWorkspace();
    const start = startExtraction(ws);
    // A fresh snapshot starts by mapping actors; with actors already modelled, by reading groups.
    const phase: Phase = loadModel(ws.modelDir).actors.some((actor) => actor.provenance === "first-party") ? 2 : 1;
    this.scope = null;
    this.setState({ active: true, repository: ws.repository, modelDir: ws.modelDir, phase });
    // Files read before the extraction started count too.
    this.recordRead(this.seen().files());
    const { report, group } = this.situation(ws, false);
    return kickoff(start, report, phase, group);
  }

  /** Record development, vendored, or generated files or trees (a path ending in `/`), which need not be read. */
  skip(paths: string[], outcome: SkipOutcome, note: string): { text: string; recorded: number; rejected: string[] } {
    const ws = this.requireWorkspace();
    const { commit, required } = this.requireScope(ws);
    const accepted: LedgerEntry[] = [];
    const rejected: string[] = [];
    for (const raw of paths) {
      const path = raw.replace(/^\.\//, "");
      if (!note.trim()) rejected.push(`${path}: say in note ${outcome === "development" ? "what it is for" : "where it comes from"}`);
      else if (path.endsWith("/") ? ![...required].some((file) => file.startsWith(path)) : !required.has(path)) {
        rejected.push(`${path}: not a file this extraction needs (untracked, excluded by .feynman/config.json, or unchanged)`);
      } else accepted.push({ path, outcome, note });
    }
    if (accepted.length) recordReviewed(ws.modelDir, this.options.ledger, commit, "Recorded in an agent session.", accepted);
    const report = computeCoverage(ws.repository, ws.modelDir);
    const text = [
      `Recorded ${accepted.length} path(s) as ${outcome}. ${describeCoverage(report).replace("reviewed", "read")}.`,
      ...(rejected.length ? ["Rejected:", ...rejected.map((reason) => `  ${reason}`)] : []),
    ].join("\n");
    return { text, recorded: accepted.length, rejected };
  }

  /** Phase, coverage, the current group or gaps, and problems; every unread path when `listMissing`. */
  status(listMissing = false): { text: string; missing: number; problems: number } {
    const ws = this.requireWorkspace();
    const situation = this.situation(ws, false);
    const { report, problems } = situation;
    const text = listMissing
      ? [describeCoverage(report), ...report.missing, ...(problems.length ? ["", `${problems.length} problem(s):`, ...problems] : [])].join("\n")
      : continuation(situation, false);
    return { text, missing: report.missing.length, problems: problems.length };
  }

  /** One line for the user. */
  summary(): string {
    const { report, problems, phase } = this.situation(this.requireWorkspace(), false);
    const validity = problems.length ? `${problems.length} model problem(s)` : "model valid";
    return `${describeCoverage(report).replace("reviewed", "read")}; ${validity}${this.driving ? `; driving, phase ${phase} of 3` : ""}`;
  }

  /** Stop driving. */
  stop() {
    if (this.state) this.setState({ ...this.state, active: false });
  }

  /** The agent is about to stop: decide whether it continues. Null when not driving. */
  onStop(): StopDecision | null {
    if (!this.state?.active) return null;
    let situation: Situation;
    try {
      situation = this.situation(this.state, true);
    } catch (error) {
      this.stop();
      return { kind: "paused", message: `Feynman stopped: ${(error as Error).message}` };
    }
    const { report, problems, gaps, phase } = situation;

    if (phase === 3 && !situation.entered && report.missing.length === 0 && problems.length === 0 && gaps.length === 0) {
      const { repository, modelDir } = this.state;
      const measured = measureModel(repository, modelDir);
      this.stop();
      return { kind: "done", message: `Feynman: ${describeCoverage(report).replace("reviewed", "read")} (${breakdown(modelDir, report)}), and the model is valid. ${measured}.` };
    }

    const progress = JSON.stringify([phase, report.missing.length, problems.length, gaps.length]);
    this.stalls = this.last === progress ? this.stalls + 1 : 0;
    this.last = progress;
    if (this.stalls >= MAX_STALLS) {
      this.stop();
      return { kind: "paused", message: `Feynman paused in phase ${phase}: no progress after ${MAX_STALLS} reminders. ${describeCoverage(report)}.` };
    }
    return { kind: "continue", message: continuation(situation) };
  }

  // Internals.

  /**
   * Where the extraction stands. With `advance`, move to the next phase when the
   * current one is done: phase 1 when the actor map has no gaps, phase 2 when every
   * file is read. Phases only move forward.
   */
  private situation(ws: Workspace, advance: boolean): Situation {
    const report = computeCoverage(ws.repository, ws.modelDir);
    const problems = [...report.problems, ...checkModel(ws.modelDir, ws.repository)];
    const model = loadModel(ws.modelDir);
    let phase: Phase = this.state?.phase ?? 2;
    let entered = false;
    if (advance && this.state) {
      if (phase === 1 && problems.length === 0 && actorGaps(model).length === 0) phase = 2;
      if (phase === 2 && report.missing.length === 0 && problems.length === 0) phase = 3;
      if (phase !== this.state.phase) {
        entered = true;
        this.setState({ ...this.state, phase });
      }
    }
    const group = phase >= 2 ? nextGroup(model, report.missing, fileSizes(ws.repository, report.commit)) : null;
    const gaps = phase === 1 ? actorGaps(model) : phase === 3 ? depthGaps(model) : [];
    return { phase, report, problems, gaps, group, entered };
  }

  private recordRead(files: string[]) {
    const ws = this.requireWorkspace();
    const { commit, required } = this.requireScope(ws);
    const entries = files.filter((file) => required.has(file)).map((path): LedgerEntry => ({ path, outcome: "read" }));
    if (entries.length) recordReviewed(ws.modelDir, this.options.ledger, commit, "Read in an agent session.", entries);
  }

  private requireScope(ws: Workspace) {
    if (!this.scope) {
      const report = computeCoverage(ws.repository, ws.modelDir);
      this.scope = { commit: report.commit, required: new Set(report.required) };
    }
    return this.scope;
  }

  private setState(state: DriveState) {
    this.state = state.active ? state : null;
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

/** Size in bytes of every file at `commit`. */
function fileSizes(repository: string, commit: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const row of lines(git(repository, "-c", "core.quotePath=false", "ls-tree", "-r", "-l", "--full-tree", commit))) {
    const tab = row.indexOf("\t");
    const size = Number(row.slice(0, tab).trim().split(/\s+/)[3]);
    if (!Number.isNaN(size)) sizes.set(row.slice(tab + 1), size);
  }
  return sizes;
}

/** "120 read, 3 generated": ledger outcomes at the report's commit. */
function breakdown(modelDir: string, report: CoverageReport): string {
  const outcomes = new Map<string, number>();
  for (const { value } of readCoverage(modelDir)) {
    if (value.commit === report.commit) for (const entry of value.files) outcomes.set(entry.outcome, (outcomes.get(entry.outcome) ?? 0) + 1);
  }
  return [...outcomes].map(([outcome, n]) => `${n} ${outcome}`).join(", ");
}

