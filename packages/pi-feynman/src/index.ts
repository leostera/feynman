// Feynman for Pi: drive one agent through extracting a behavioural model of the
// repository until every file it is responsible for has been reviewed.
//
// The agent works freely, following the code wherever it leads. This extension
// only keeps score: it records which files the agent has seen, lets it record
// files as reviewed (seen ones only), and whenever the agent is about to stop,
// checks coverage and model validity and asks it to continue if anything is left.
import { execFile } from "node:child_process";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  checkModel,
  computeCoverage,
  CoverageError,
  describeCoverage,
  groupMissing,
  measureModel,
  recordReviewed,
  SCHEMA_DIR,
  trackedFiles,
} from "@feynman/model";
import { Type } from "typebox";
import { Evidence } from "./evidence.ts";
import { findWorkspace, MODEL_DIR, startExtraction, type Start, type Workspace } from "./workspace.ts";

/** Session entry recording whether an extraction is being driven. */
const DRIVE_ENTRY = "feynman-drive";
/** Stop nudging after this many continuations without progress. */
const MAX_STALLS = 3;
/** How many unreviewed paths a continuation lists by name. */
const LISTED_PATHS = 40;

interface Drive {
  active: boolean;
  repository: string;
  modelDir: string;
}

interface Progress {
  missing: number;
  problems: number;
}

const OUTCOMES = ["modelled", "no-behaviour", "vendored", "generated"] as const;

export default function feynman(pi: ExtensionAPI) {
  let drive: Drive | null = null;
  let workspace: Workspace | null = null;
  let evidence: Evidence | null = null;
  let headFiles: Set<string> | null = null;
  let last: Progress | null = null;
  let stalls = 0;

  const ensureWorkspace = (ctx: ExtensionContext): Workspace => {
    workspace ??= findWorkspace(ctx.cwd);
    if (!workspace) throw new Error("Not inside a git repository.");
    return workspace;
  };
  const ensureEvidence = (ctx: ExtensionContext): Evidence => {
    const ws = ensureWorkspace(ctx);
    evidence ??= new Evidence(ws.repository);
    headFiles ??= new Set(trackedFiles(ws.repository, "HEAD"));
    return evidence;
  };
  const setDrive = (next: Drive | null) => {
    drive = next;
    last = null;
    stalls = 0;
    if (next) pi.appendEntry<Drive>(DRIVE_ENTRY, next);
  };
  const ledgerName = (ctx: ExtensionContext) => `session-${ctx.sessionManager.getSessionId().slice(0, 8)}`;

  // Rebuild state from the active branch: the last drive entry, and every file the
  // agent read or named in a command, so a resumed session keeps its evidence.
  pi.on("session_start", (_event, ctx) => {
    workspace = findWorkspace(ctx.cwd);
    evidence = null;
    headFiles = null;
    drive = null;
    if (!workspace) return;
    const seen = ensureEvidence(ctx);
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === DRIVE_ENTRY) drive = entry.data as Drive;
      if (entry.type !== "message" || entry.message.role !== "assistant") continue;
      for (const part of entry.message.content) {
        if (part.type !== "toolCall") continue;
        const args = part.arguments as Record<string, unknown>;
        if (part.name === "read" && typeof args.path === "string") seen.read(ctx.cwd, args.path);
        if (part.name === "bash" && typeof args.command === "string") seen.bash(ctx.cwd, args.command, headFiles!);
      }
    }
    if (drive && !drive.active) drive = null;
  });

  // Ledgers are written only by feynman_reviewed, which checks the files were seen.
  pi.on("tool_call", (event, ctx) => {
    if ((event.toolName !== "write" && event.toolName !== "edit") || !workspace) return;
    const target = resolve(ctx.cwd, String(event.input.path ?? ""));
    if (target.startsWith(join(workspace.modelDir, "coverage") + sep)) {
      return { block: true, reason: "Coverage ledgers are written by feynman_reviewed; call it with the files you have read." };
    }
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError || !workspace) return;
    const seen = ensureEvidence(ctx);
    if (event.toolName === "read" && typeof event.input.path === "string") seen.read(ctx.cwd, event.input.path);
    if (event.toolName === "bash" && typeof event.input.command === "string") seen.bash(ctx.cwd, event.input.command, headFiles!);
  });

  // The agent is about to stop: continue while files are unreviewed or the model is invalid.
  pi.on("agent_before_settle", (event, ctx) => {
    // Not `event.context.canContinue`: that describes the context before our entries,
    // and the coverage message we append is what the next request continues from.
    if (!drive?.active || event.outcome !== "completed") return;
    const ws = { repository: drive.repository, modelDir: drive.modelDir };
    let report;
    try {
      report = computeCoverage(ws.repository, ws.modelDir);
    } catch (error) {
      setDrive({ ...drive, active: false });
      ctx.ui.notify(`Feynman stopped: ${(error as Error).message}`, "error");
      return;
    }
    const problems = [...report.problems, ...checkModel(ws.modelDir, ws.repository)];

    if (report.missing.length === 0 && problems.length === 0) {
      const measured = measureModel(ws.repository, ws.modelDir);
      setDrive({ ...drive, active: false });
      return {
        entries: [
          {
            type: "custom_message",
            customType: "feynman-coverage",
            display: true,
            content: `Feynman: ${describeCoverage(report)}, and the model is valid. ${measured}. Render it with /feynman render.`,
          },
        ],
      };
    }

    const progress = { missing: report.missing.length, problems: problems.length };
    stalls = last && last.missing === progress.missing && last.problems === progress.problems ? stalls + 1 : 0;
    last = progress;
    if (stalls >= MAX_STALLS) {
      setDrive({ ...drive, active: false });
      ctx.ui.notify(`Feynman paused: no progress after ${MAX_STALLS} reminders. ${describeCoverage(report)}. Run /feynman extract to resume.`, "warning");
      return;
    }
    return {
      continue: true,
      entries: [{ type: "custom_message", customType: "feynman-coverage", display: true, content: continuation(report, problems) }],
    };
  });

  /** Prepare the model directory, start driving, and return the agent's instructions. */
  const begin = (ctx: ExtensionContext): string => {
    const ws = ensureWorkspace(ctx);
    const start = startExtraction(ws);
    setDrive({ active: true, repository: ws.repository, modelDir: ws.modelDir });
    return kickoff(start, computeCoverage(ws.repository, ws.modelDir));
  };

  pi.registerTool({
    name: "feynman_extract",
    label: "Feynman: extract",
    description:
      "Start (or resume) extracting the Feynman model of the current repository at HEAD: a first snapshot when there is no model, or an update from the modelled commit. Returns what to do; afterwards, coverage is checked whenever you stop.",
    promptSnippet: "Start or resume extracting the Feynman model of this repository",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: begin(ctx) }], details: undefined };
    },
  });

  pi.registerTool({
    name: "feynman_reviewed",
    label: "Feynman: reviewed",
    description:
      "Record repository files as reviewed for the Feynman model, with what each contributed. Only files you have read (or named in a command) in this session are accepted. A directory ending in `/` may be recorded whole only as `vendored` or `generated`.",
    promptSnippet: "Record files as reviewed for the Feynman model",
    promptGuidelines: [
      "While extracting a Feynman model, call feynman_reviewed for files once you have read them and reflected them in the model; batch several files per call.",
    ],
    parameters: Type.Object({
      files: Type.Array(
        Type.Object({
          path: Type.String({ description: "Repository-relative path" }),
          outcome: StringEnum(OUTCOMES, {
            description: "modelled: the model reflects it. no-behaviour: nothing to model. vendored or generated: say the origin in note.",
          }),
          note: Type.Optional(Type.String()),
        }),
        { minItems: 1 },
      ),
      summary: Type.Optional(Type.String({ description: "What this session has covered so far, in a phrase" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ws = ensureWorkspace(ctx);
      const seen = ensureEvidence(ctx);
      const before = computeCoverage(ws.repository, ws.modelDir);
      const tracked = new Set(trackedFiles(ws.repository, before.commit));
      const accepted: { path: string; outcome: (typeof OUTCOMES)[number]; note?: string }[] = [];
      const rejected: string[] = [];
      for (const entry of params.files) {
        const path = entry.path.replace(/^\.\//, "");
        if (path.endsWith("/")) {
          if (entry.outcome !== "vendored" && entry.outcome !== "generated") rejected.push(`${path}: only vendored or generated trees may be recorded whole`);
          else if (![...tracked].some((file) => file.startsWith(path))) rejected.push(`${path}: no tracked files under it`);
          else accepted.push({ ...entry, path });
        } else if (!tracked.has(path)) rejected.push(`${path}: not tracked at ${before.commit.slice(0, 7)}`);
        else if (!seen.has(path)) rejected.push(`${path}: not read in this session; read it first`);
        else accepted.push({ ...entry, path });
      }
      if (accepted.length) recordReviewed(ws.modelDir, ledgerName(ctx), before.commit, params.summary ?? "Reviewed in a Pi session.", accepted);
      const after = computeCoverage(ws.repository, ws.modelDir);
      const lines = [
        `Recorded ${accepted.length} file(s). ${describeCoverage(after)}; ${after.missing.length} unreviewed.`,
        ...(rejected.length ? ["Rejected:", ...rejected.map((reason) => `  ${reason}`)] : []),
      ];
      return { content: [{ type: "text", text: lines.join("\n") }], details: { recorded: accepted.length, rejected } };
    },
  });

  pi.registerTool({
    name: "feynman_status",
    label: "Feynman: status",
    description: "Show Feynman model coverage (files reviewed out of those required, unreviewed files by directory) and any model validation problems.",
    promptSnippet: "Check Feynman model coverage and validity",
    parameters: Type.Object({
      missing: Type.Optional(Type.Boolean({ description: "List every unreviewed path instead of a sample" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const ws = ensureWorkspace(ctx);
      const report = computeCoverage(ws.repository, ws.modelDir);
      const problems = [...report.problems, ...checkModel(ws.modelDir, ws.repository)];
      const text = params.missing
        ? [describeCoverage(report), ...report.missing, ...(problems.length ? ["", `${problems.length} problem(s):`, ...problems] : [])].join("\n")
        : continuation(report, problems, false);
      return { content: [{ type: "text", text }], details: { missing: report.missing.length, problems: problems.length } };
    },
  });

  pi.registerCommand("feynman", {
    description: "Feynman model: extract | status | stop | render [out.html]",
    getArgumentCompletions: (prefix) =>
      ["extract", "status", "stop", "render"].filter((name) => name.startsWith(prefix)).map((name) => ({ value: name, label: name })),
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/);
      let ws: Workspace;
      try {
        ws = ensureWorkspace(ctx);
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
        return;
      }
      switch (sub) {
        case "extract": {
          let instructions: string;
          try {
            instructions = begin(ctx);
          } catch (error) {
            ctx.ui.notify((error as Error).message, "error");
            return;
          }
          await pi.sendUserMessage(instructions);
          return;
        }
        case "status": {
          try {
            const report = computeCoverage(ws.repository, ws.modelDir);
            ctx.ui.notify(`${describeCoverage(report)}${drive?.active ? " (driving)" : ""}`, "info");
          } catch (error) {
            ctx.ui.notify((error as Error).message, error instanceof CoverageError ? "warning" : "error");
          }
          return;
        }
        case "stop": {
          if (drive) setDrive({ ...drive, active: false });
          ctx.ui.notify("Feynman stopped driving the extraction.", "info");
          return;
        }
        case "render": {
          const out = rest[0] ? join(ctx.cwd, rest[0]) : join(ws.repository, ".feynman", "index.html");
          try {
            await render(ws.modelDir, out);
            ctx.ui.notify(`Rendered ${out}`, "info");
          } catch (error) {
            ctx.ui.notify(`Render failed: ${(error as Error).message}`, "error");
          }
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand ${sub}. Use extract, status, stop, or render.`, "warning");
      }
    },
  });
}

type Report = ReturnType<typeof computeCoverage>;

function kickoff(start: Start, report: Report): string {
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

function continuation(report: Report, problems: string[], nudge = true): string {
  const out = [`Feynman: ${describeCoverage(report)}.`];
  if (report.missing.length) {
    if (nudge) out.push(`${report.missing.length} files are still unreviewed. Continue: follow the code into them, update the model, and record them with feynman_reviewed.`);
    out.push("", "Unreviewed, by directory:");
    for (const [group, n] of groupMissing(report.missing).slice(0, 20)) out.push(`  ${String(n).padStart(4)}  ${group}`);
    out.push("", `Some of them:`, ...report.missing.slice(0, LISTED_PATHS).map((path) => `  ${path}`));
  }
  if (problems.length) {
    out.push("", `The model has ${problems.length} problem(s)${nudge ? "; fix them" : ""}:`, ...problems.slice(0, 20).map((problem) => `  ${problem}`));
  }
  return out.join("\n");
}

const RENDERER = fileURLToPath(new URL("../../renderer", import.meta.url));

async function render(modelDir: string, out: string) {
  await promisify(execFile)("bun", ["run", "build", modelDir, out], { cwd: RENDERER, maxBuffer: 1 << 24 });
}
