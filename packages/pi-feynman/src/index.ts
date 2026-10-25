// Feynman for Pi: maps Pi's tools, commands, and lifecycle events onto
// @feynman/modeler, which holds the extraction logic.
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Extraction, renderModel, TOOLS, type DriveState } from "@feynman/modeler";
import { join, resolve } from "node:path";
import { Type } from "typebox";

/** Session entry recording the drive state. */
const DRIVE_ENTRY = "feynman-drive";
/** Custom message type for coverage reports shown to the agent. */
const COVERAGE_MESSAGE = "feynman-coverage";

export default function feynman(pi: ExtensionAPI) {
  let extraction: Extraction | null = null;

  const open = (ctx: ExtensionContext): Extraction =>
    new Extraction({
      cwd: ctx.cwd,
      ledger: `session-${ctx.sessionManager.getSessionId().slice(0, 8)}`,
      onStateChange: (state) => pi.appendEntry<DriveState>(DRIVE_ENTRY, state),
    });
  const current = (ctx: ExtensionContext): Extraction => (extraction ??= open(ctx));

  // Rebuild from the active branch: the last drive state, and every read the agent
  // made (with any truncation its result reported), so a resumed session keeps its evidence.
  pi.on("session_start", (_event, ctx) => {
    extraction = open(ctx);
    let state: DriveState | null = null;
    const reads = new Map<string, Record<string, unknown>>();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === DRIVE_ENTRY) state = entry.data as DriveState;
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role === "assistant") {
        for (const part of message.content) if (part.type === "toolCall" && part.name === "read") reads.set(part.id, part.arguments);
      } else if (message.role === "toolResult" && reads.has(message.toolCallId) && !message.isError) {
        noteRead(ctx, reads.get(message.toolCallId)!, message.details);
      }
    }
    extraction.restore(state);
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName === "read" && !event.isError) noteRead(ctx, event.input, event.details);
  });

  const noteRead = (ctx: ExtensionContext, input: Record<string, unknown>, details: unknown) => {
    if (typeof input.path !== "string") return;
    const truncation = (details as { truncation?: { truncated: boolean; outputLines: number } } | undefined)?.truncation;
    current(ctx).noteRead(ctx.cwd, input.path, {
      offset: typeof input.offset === "number" ? input.offset : undefined,
      limit: typeof input.limit === "number" ? input.limit : undefined,
      returnedLines: truncation?.truncated ? truncation.outputLines : undefined,
    });
  };

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (current(ctx).isLedgerPath(ctx.cwd, String(event.input.path ?? ""))) {
      return { block: true, reason: `Coverage ledgers are written by Feynman: files are recorded once read in full, and ${TOOLS.skip.name} records vendored or generated ones.` };
    }
  });

  // Not `event.context.canContinue`: that describes the context before our entry,
  // and the coverage message appended here is what the next request continues from.
  pi.on("agent_before_settle", (event, ctx) => {
    if (event.outcome !== "completed") return;
    const decision = current(ctx).onStop();
    if (!decision) return;
    if (decision.kind === "paused") {
      ctx.ui.notify(`${decision.message} Run /feynman-extract to resume.`, "warning");
      return;
    }
    const content = decision.kind === "done" ? `${decision.message} Render it with /feynman-render.` : decision.message;
    return {
      continue: decision.kind === "continue",
      entries: [{ type: "custom_message", customType: COVERAGE_MESSAGE, display: true, content }],
    };
  });

  const text = (value: string) => [{ type: "text" as const, text: value }];

  pi.registerTool({
    name: TOOLS.extract.name,
    label: TOOLS.extract.label,
    description: TOOLS.extract.description,
    promptSnippet: TOOLS.extract.snippet,
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      return { content: text(current(ctx).begin()), details: undefined };
    },
  });

  pi.registerTool({
    name: TOOLS.skip.name,
    label: TOOLS.skip.label,
    description: TOOLS.skip.description,
    promptSnippet: TOOLS.skip.snippet,
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, description: TOOLS.skip.params.paths }),
      outcome: StringEnum(TOOLS.skip.outcomes, { description: TOOLS.skip.params.outcome }),
      note: Type.String({ description: TOOLS.skip.params.note }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = current(ctx).skip(params.paths, params.outcome, params.note);
      return { content: text(result.text), details: { recorded: result.recorded, rejected: result.rejected } };
    },
  });

  pi.registerTool({
    name: TOOLS.status.name,
    label: TOOLS.status.label,
    description: TOOLS.status.description,
    promptSnippet: TOOLS.status.snippet,
    parameters: Type.Object({ missing: Type.Optional(Type.Boolean({ description: TOOLS.status.params.missing })) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const result = current(ctx).status(params.missing);
      return { content: text(result.text), details: { missing: result.missing, problems: result.problems } };
    },
  });

  /** Register `/feynman-<name>`; failures are reported, not thrown. */
  const command = (name: string, description: string, run: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void) =>
    pi.registerCommand(`feynman-${name}`, {
      description,
      handler: async (args, ctx) => {
        try {
          await run(args.trim(), ctx);
        } catch (error) {
          ctx.ui.notify((error as Error).message, "error");
        }
      },
    });

  command("extract", "Start or resume extracting the Feynman model at HEAD, and guide the agent through its phases until the model is complete", async (_args, ctx) => {
    await pi.sendUserMessage(current(ctx).begin());
  });

  command("status", "Show Feynman model coverage and validity", (_args, ctx) => {
    ctx.ui.notify(current(ctx).summary(), "info");
  });

  command("stop", "Stop asking the agent to continue the Feynman extraction", (_args, ctx) => {
    current(ctx).stop();
    ctx.ui.notify("Feynman stopped driving the extraction.", "info");
  });

  command("render", "Render the Feynman model to HTML (default .feynman/index.html)", async (args, ctx) => {
    const workspace = current(ctx).workspace;
    if (!workspace) throw new Error("Not inside a git repository.");
    const out = args ? resolve(ctx.cwd, args) : join(workspace.repository, ".feynman", "index.html");
    await renderModel(workspace.modelDir, out);
    ctx.ui.notify(`Rendered ${out}`, "info");
  });
}
