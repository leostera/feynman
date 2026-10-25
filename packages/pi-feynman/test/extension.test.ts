import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, repository, startSession, type Harness } from "./harness.ts";

const FILES = {
  "README.md": "# app\n",
  "src/app.ts": ["export function handle(body: string): number {", "  if (body.length > 1024) return 413;", "  return 201;", "}", ""].join("\n"),
};

const META = {
  system: "app",
  summary: "A tiny handler that accepts bodies up to 1 KiB.",
  source: { repository: ".", commit: "" },
  extraction: "bootstrap",
};

const ACTOR = {
  provenance: "first-party",
  runsOn: { location: "local" },
  summary: "The request handler.",
  footprint: { paths: ["src/"] },
  anchors: ["src/app.ts#handle"],
};

let harness: Harness | undefined;
afterEach(() => harness?.dispose());

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const stop = (text = "Done.") => fauxAssistantMessage(fauxText(text));
const toolResults = (h: Harness) =>
  h.session.messages.filter((m) => m.role === "toolResult").map((m) => ({ tool: m.toolName, error: m.isError, text: JSON.stringify(m.content) }));

test("keeps the agent going until every file is read, recorded, and the model is valid", async () => {
  const cwd = repository(FILES);
  harness = await startSession(cwd);
  harness.respond([
    call("feynman_extract", {}),
    // Skimming one line is not reading the file.
    call("read", { path: "src/app.ts", limit: 1 }),
    call("feynman_reviewed", { files: [{ path: "src/app.ts", outcome: "modelled" }] }),
    stop(),
    // The extension appends what is missing and continues.
    call("read", { path: "src/app.ts" }),
    call("read", { path: "README.md" }),
    // Read in full, but nothing in the model points at it yet.
    call("feynman_reviewed", { files: [{ path: "src/app.ts", outcome: "modelled" }] }),
    () => {
      // The commit is whatever feynman_extract recorded in meta.json.
      const meta = JSON.parse(readFileSync(join(cwd, ".feynman/model/meta.json"), "utf8"));
      return call("write", { path: ".feynman/model/meta.json", content: JSON.stringify({ ...META, source: { ...META.source, commit: meta.source.commit } }) });
    },
    call("write", { path: ".feynman/model/actors/app.json", content: JSON.stringify(ACTOR) }),
    call("feynman_reviewed", {
      files: [
        { path: "src/app.ts", outcome: "modelled" },
        { path: "README.md", outcome: "no-behaviour" },
      ],
    }),
    stop(),
  ]);

  await harness.session.prompt("Extract the Feynman model.");

  const reviews = toolResults(harness).filter((r) => r.tool === "feynman_reviewed");
  expect(reviews[0].text).toContain("not read in full (1 of 4 lines)");
  expect(reviews[1].text).toContain("no element anchors it");
  expect(reviews[2].text).toContain("Recorded 2 file(s)");

  const reports = harness.customMessages("feynman-coverage");
  expect(reports).toHaveLength(2);
  expect(reports[0]).toContain("0 of 2 files reviewed");
  expect(reports[0]).toContain("Continue");
  expect(reports[1]).toContain("2 of 2 files reviewed");
  expect(reports[1]).toContain("the model is valid");
  expect(harness.pending()).toBe(0);

  const ledgers = readdirSync(join(cwd, ".feynman/model/coverage"));
  expect(ledgers).toHaveLength(1);
  const ledger = JSON.parse(readFileSync(join(cwd, ".feynman/model/coverage", ledgers[0]), "utf8"));
  expect(ledger.files.map((f: { path: string }) => f.path)).toEqual(["README.md", "src/app.ts"]);
});

test("blocks writing coverage ledgers directly", async () => {
  const cwd = repository(FILES);
  harness = await startSession(cwd);
  harness.respond([
    call("write", { path: ".feynman/model/coverage/forged.json", content: "{}" }),
    stop(),
  ]);
  await harness.session.prompt("Forge a ledger.");

  const write = toolResults(harness).find((r) => r.tool === "write");
  expect(write?.error).toBe(true);
  expect(write?.text).toContain("feynman_reviewed");
  expect(existsSync(join(cwd, ".feynman/model/coverage/forged.json"))).toBe(false);
});
