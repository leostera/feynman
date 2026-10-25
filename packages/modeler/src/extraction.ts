// Drive one agent through extracting a model until every file it is responsible
// for has been reviewed and the model is valid.
//
// This is independent of any agent runtime. An adapter tells it what the agent
// did (files read, commands run), exposes `begin`, `review`, and `status` as the
// agent's tools, and asks `onStop` what to do whenever the agent is about to stop.
import {
  checkModel,
  computeCoverage,
  describeCoverage,
  measureModel,
  recordReviewed,
  trackedFiles,
  type CoverageReport,
  type LedgerEntry,
  type Outcome,
} from "@feynman/model";
import { join, resolve, sep } from "node:path";
import { Evidence } from "./evidence.ts";
import { continuation, kickoff } from "./messages.ts";
import { findWorkspace, startExtraction, type Workspace } from "./workspace.ts";

/** Whether an extraction is being driven; persisted by the adapter. */
export interface DriveState {
  active: boolean;
  repository: string;
  modelDir: string;
}

/** What the adapter should do when the agent is about to stop. */
export type StopDecision =
  /** Show `message` to the agent and let it continue. */
  | { kind: "continue"; message: string }
  /** The extraction is complete; show `message`. */
  | { kind: "done"; message: string }
  /** Stopped driving (no progress, or an error); tell the user `message`. */
  | { kind: "paused"; message: string };

export const OUTCOMES: readonly Outcome[] = ["modelled", "no-behaviour", "vendored", "generated"];

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
  private headFiles: Set<string> | null = null;
  private last: { missing: number; problems: number } | null = null;
  private stalls = 0;

  constructor(private readonly options: ExtractionOptions) {
    this.workspace = findWorkspace(options.cwd);
  }

  get driving(): boolean {
    return this.state?.active ?? false;
  }

  /** Restore persisted state, e.g. when a session is resumed. */
  restore(state: DriveState | null) {
    this.state = state?.active ? state : null;
  }

  // What the agent did. Files count as seen when read, or named in a command.

  noteRead(cwd: string, path: string) {
    if (this.workspace) this.seen().read(cwd, path);
  }

  noteCommand(cwd: string, command: string) {
    if (this.workspace) this.seen().bash(cwd, command, this.tracked());
  }

  /** Ledgers are written only through `review`; adapters should block other writes. */
  isLedgerPath(cwd: string, path: string): boolean {
    return this.workspace !== null && resolve(cwd, path).startsWith(join(this.workspace.modelDir, "coverage") + sep);
  }

  // The agent's operations.

  /** Prepare the model at HEAD, start driving, and return the agent's instructions. */
  begin(): string {
    const ws = this.requireWorkspace();
    const start = startExtraction(ws);
    this.setState({ active: true, repository: ws.repository, modelDir: ws.modelDir });
    return kickoff(start, computeCoverage(ws.repository, ws.modelDir));
  }

  /** Record files as reviewed. Only files seen in this session are accepted. */
  review(files: LedgerEntry[], summary?: string): { text: string; recorded: number; rejected: string[] } {
    const ws = this.requireWorkspace();
    const { commit } = computeCoverage(ws.repository, ws.modelDir);
    const tracked = new Set(trackedFiles(ws.repository, commit));
    const accepted: LedgerEntry[] = [];
    const rejected: string[] = [];
    for (const entry of files) {
      const path = entry.path.replace(/^\.\//, "");
      if (path.endsWith("/")) {
        if (entry.outcome !== "vendored" && entry.outcome !== "generated") rejected.push(`${path}: only vendored or generated trees may be recorded whole`);
        else if (![...tracked].some((file) => file.startsWith(path))) rejected.push(`${path}: no tracked files under it`);
        else accepted.push({ ...entry, path });
      } else if (!tracked.has(path)) rejected.push(`${path}: not tracked at ${commit.slice(0, 7)}`);
      else if (!this.seen().has(path)) rejected.push(`${path}: not read in this session; read it first`);
      else accepted.push({ ...entry, path });
    }
    if (accepted.length) recordReviewed(ws.modelDir, this.options.ledger, commit, summary ?? "Reviewed in an agent session.", accepted);
    const after = computeCoverage(ws.repository, ws.modelDir);
    const text = [
      `Recorded ${accepted.length} file(s). ${describeCoverage(after)}; ${after.missing.length} unreviewed.`,
      ...(rejected.length ? ["Rejected:", ...rejected.map((reason) => `  ${reason}`)] : []),
    ].join("\n");
    return { text, recorded: accepted.length, rejected };
  }

  /** Coverage and model problems; every unreviewed path when `listMissing`. */
  status(listMissing = false): { text: string; missing: number; problems: number } {
    const { report, problems } = this.evaluate(this.requireWorkspace());
    const text = listMissing
      ? [describeCoverage(report), ...report.missing, ...(problems.length ? ["", `${problems.length} problem(s):`, ...problems] : [])].join("\n")
      : continuation(report, problems, false);
    return { text, missing: report.missing.length, problems: problems.length };
  }

  /** One line for the user. */
  summary(): string {
    const { report, problems } = this.evaluate(this.requireWorkspace());
    const validity = problems.length ? `${problems.length} model problem(s)` : "model valid";
    return `${describeCoverage(report)}; ${validity}${this.driving ? "; driving" : ""}`;
  }

  /** Stop driving. */
  stop() {
    if (this.state) this.setState({ ...this.state, active: false });
  }

  /** The agent is about to stop: decide whether it continues. Null when not driving. */
  onStop(): StopDecision | null {
    if (!this.state?.active) return null;
    let evaluation;
    try {
      evaluation = this.evaluate(this.state);
    } catch (error) {
      this.stop();
      return { kind: "paused", message: `Feynman stopped: ${(error as Error).message}` };
    }
    const { report, problems } = evaluation;

    if (report.missing.length === 0 && problems.length === 0) {
      const measured = measureModel(this.state.repository, this.state.modelDir);
      this.stop();
      return { kind: "done", message: `Feynman: ${describeCoverage(report)}, and the model is valid. ${measured}.` };
    }

    const progress = { missing: report.missing.length, problems: problems.length };
    this.stalls = this.last && this.last.missing === progress.missing && this.last.problems === progress.problems ? this.stalls + 1 : 0;
    this.last = progress;
    if (this.stalls >= MAX_STALLS) {
      this.stop();
      return { kind: "paused", message: `Feynman paused: no progress after ${MAX_STALLS} reminders. ${describeCoverage(report)}.` };
    }
    return { kind: "continue", message: continuation(report, problems) };
  }

  // Internals.

  private evaluate(ws: Workspace): { report: CoverageReport; problems: string[] } {
    const report = computeCoverage(ws.repository, ws.modelDir);
    return { report, problems: [...report.problems, ...checkModel(ws.modelDir, ws.repository)] };
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

  private tracked(): Set<string> {
    this.headFiles ??= new Set(trackedFiles(this.requireWorkspace().repository, "HEAD"));
    return this.headFiles;
  }
}
