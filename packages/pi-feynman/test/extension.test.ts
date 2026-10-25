import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, repository, startSession, type Harness } from "./harness.ts";

const FILES = {
  "README.md": "# app\n",
  "src/client.ts": ["export async function send(body: string) {", "  return fetch('/notes', { method: 'POST', body });", "}", ""].join("\n"),
  "src/server.ts": ["export function handle(body: string): number {", "  if (body.length > 1024) return 413;", "  return 201;", "}", ""].join("\n"),
};

const actor = (talksTo: string[]) => ({
  kind: "program",
  provenance: "first-party",
  runsOn: { location: "local" },
  summary: "A process.",
  talksTo,
  anchors: ["src/"],
});

const component = (id: string) => ({ summary: `The ${id} code.`, actors: [id], footprint: { paths: [`src/${id}.ts`] }, anchors: [`src/${id}.ts`] });

const FLOW = {
  summary: "A note is posted and stored.",
  trigger: "The user saves a note.",
  steps: [
    { actor: "user", action: "saves a note", target: "client" },
    { actor: "client", action: "POSTs the note", target: "server" },
    { actor: "server", action: "rejects bodies over 1 KiB with 413, else answers 201", target: "client" },
  ],
  anchors: ["src/client.ts#send", "src/server.ts#handle"],
};

let harness: Harness | undefined;
afterEach(() => harness?.dispose());

const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const write = (path: string, value: unknown) => call("write", { path: `.feynman/model/${path}`, content: JSON.stringify(value) });
const stop = (text = "Done.") => fauxAssistantMessage(fauxText(text));
const toolResults = (h: Harness) =>
  h.session.messages.filter((m) => m.role === "toolResult").map((m) => ({ tool: m.toolName, error: m.isError, text: JSON.stringify(m.content) }));

/** A whole extraction of FILES, as the agent would run it, starting with the feynman_extract tool. */
const fullRun = (cwd: string) => {
  const meta = () => JSON.parse(readFileSync(join(cwd, ".feynman/model/meta.json"), "utf8"));
  return [
    call("feynman_extract", {}),
    // Phase 1: an actor map, but the server talks to nobody yet.
    () => write("meta.json", { ...meta(), summary: "Posts notes to a size-limited server." }),
    write("actors/client.json", actor([])),
    write("actors/server.json", actor([])),
    write("actors/user.json", { kind: "person", provenance: "third-party", runsOn: { location: "local" }, summary: "Writes notes.", talksTo: ["client"], anchors: ["README.md"] }),
    write("components/client.json", component("client")),
    write("components/server.json", component("server")),
    stop("Mapped the actors."),
    write("actors/client.json", actor(["server"])),
    stop("Connected them."),
    // Phase 2: the client and server form one group. Skimming does not count.
    call("read", { path: "src/server.ts", limit: 1 }),
    call("read", { path: "src/client.ts" }),
    stop("Read the group."),
    call("read", { path: "src/server.ts" }),
    write("flows/post-note.json", FLOW),
    stop("Wrote the flow."),
    // The last group: files outside every footprint.
    call("read", { path: "README.md" }),
    stop("Read the rest."),
    // Phase 3 starts with its instructions; nothing is thin, so the next stop finishes.
    stop("The model is precise."),
  ];
};

test("guides the agent through actors, groups of connected actors, and depth", async () => {
  const cwd = repository(FILES);
  harness = await startSession(cwd);
  harness.respond(fullRun(cwd));

  await harness.session.prompt("Extract the Feynman model.");

  const kickoff = toolResults(harness).find((r) => r.tool === "feynman_extract")!.text;
  expect(kickoff).toContain("Phase 1: actors");

  const reports = harness.customMessages("feynman-coverage");
  expect(reports).toHaveLength(6);
  expect(reports[0]).toContain("phase 1 of 3");
  expect(reports[0]).toContain("actors/server talks to no other actor");
  expect(reports[1]).toContain("Phase 2: flows");
  expect(reports[1]).toContain("Next group: client, server, which talk to user; components client, server. Read these 2 files");
  expect(reports[2]).toContain("1 of 3 files covered"); // the server was only skimmed
  expect(reports[2]).toContain("src/server.ts");
  expect(reports[3]).toContain("Last group: files outside every component's footprint");
  expect(reports[3]).toContain("README.md");
  expect(reports[4]).toContain("Phase 3: depth");
  expect(reports[5]).toContain("3 of 3 files covered");
  expect(reports[5]).toContain("the model is valid");
  expect(harness.pending()).toBe(0);

  const ledgers = readdirSync(join(cwd, ".feynman/model/coverage"));
  expect(ledgers).toHaveLength(1);
  const ledger = JSON.parse(readFileSync(join(cwd, ".feynman/model/coverage", ledgers[0]), "utf8"));
  expect(ledger.files).toEqual([
    { path: "README.md", outcome: "read" },
    { path: "src/client.ts", outcome: "read" },
    { path: "src/server.ts", outcome: "read" },
  ]);
});

test("/feynman-explain renders the model and opens it once the extraction is done", async () => {
  const cwd = repository(FILES);
  // A fake `open` (and `xdg-open`) that records what it was asked to open.
  const bin = mkdtempSync(join(tmpdir(), "feynman-bin-"));
  const opened = join(bin, "opened");
  for (const name of ["open", "xdg-open"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "$1" >> "${opened}"\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    harness = await startSession(cwd);
    // The agent also calls feynman_extract after the command's kickoff; that must not drop the request to explain.
    harness.respond(fullRun(cwd));
    await harness.session.prompt("/feynman-explain");
    // The command queues its kickoff as a user message; wait for the agent to finish with it.
    while (harness.pending() > 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await harness.session.waitForIdle();

    const done = harness.customMessages("feynman-coverage").at(-1)!;
    const html = join(realpathSync(cwd), ".feynman/index.html");
    expect(done).toContain(`Rendered and opened ${html}`);
    expect(readFileSync(html, "utf8")).toContain('id="feynman-model"');
    for (let i = 0; i < 100 && !existsSync(opened); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readFileSync(opened, "utf8").trim()).toBe(html);
  } finally {
    process.env.PATH = path;
  }
});

test("sets aside development, vendored, and generated files without reading them", async () => {
  const cwd = repository({ ...FILES, "vendor/lib.js": "/* third party */\n", "bun.lock": "{}\n", "scripts/publish.sh": "npm publish\n" });
  harness = await startSession(cwd);
  harness.respond([
    call("feynman_extract", {}),
    call("feynman_skip", { paths: ["vendor/", "bun.lock"], outcome: "vendored", note: "third-party code and its lockfile" }),
    call("feynman_skip", { paths: ["scripts/"], outcome: "development", note: "publishes the packages" }),
    call("feynman_skip", { paths: ["src/server.ts"], outcome: "generated", note: "" }),
    call("feynman_stop_now", {}),
  ]);
  harness.session.prompt("Extract.").catch(() => {});
  while (harness.pending() > 0) await new Promise((resolve) => setTimeout(resolve, 10));
  await harness.session.abort();

  const [vendored, development, rejected] = toolResults(harness).filter((r) => r.tool === "feynman_skip");
  expect(vendored.text).toContain("Recorded 2 path(s) as vendored");
  expect(development.text).toContain("Recorded 1 path(s) as development");
  expect(development.text).toContain("3 of 6 files covered"); // vendor/lib.js, bun.lock, scripts/publish.sh
  expect(rejected.text).toContain("src/server.ts: say in note where it comes from");
});

test("extracts uncommitted work, recording what was read", async () => {
  const cwd = repository(FILES);
  writeFileSync(join(cwd, "src/server.ts"), "export const handle = () => 201;\n");
  writeFileSync(join(cwd, "src/new.ts"), "export const fresh = true;\n");
  harness = await startSession(cwd);
  harness.respond([call("feynman_extract", {}), call("read", { path: "src/new.ts" }), stop()]);
  await harness.session.prompt("Extract.");

  expect(toolResults(harness)[0].text).toContain("with uncommitted changes, covering 4 files");
  const meta = JSON.parse(readFileSync(join(cwd, ".feynman/model/meta.json"), "utf8"));
  expect(meta.source.worktree).toBe(true);
  const [ledger] = readdirSync(join(cwd, ".feynman/model/coverage"));
  const { files } = JSON.parse(readFileSync(join(cwd, ".feynman/model/coverage", ledger), "utf8"));
  expect(files).toEqual([{ path: "src/new.ts", outcome: "read", hash: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
});

test("blocks writing coverage ledgers directly", async () => {
  const cwd = repository(FILES);
  harness = await startSession(cwd);
  harness.respond([call("write", { path: ".feynman/model/coverage/forged.json", content: "{}" }), stop()]);
  await harness.session.prompt("Forge a ledger.");

  const forged = toolResults(harness).find((r) => r.tool === "write");
  expect(forged?.error).toBe(true);
  expect(forged?.text).toContain("Coverage ledgers are written by Feynman");
  expect(existsSync(join(cwd, ".feynman/model/coverage/forged.json"))).toBe(false);
});
