import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";

const SPEC = (refuseEmpty: boolean) => `import { defineSpec, message } from "@leostera/feynman";

export default defineSpec("Echo", { messages: { Say: message<{ text: string }>({ name: "say" }), Heard: message<{ text: string }>({ name: "heard", tone: "reply" }) } }, (spec) => {
  const { Say, Heard } = spec.messages;
  const zone = spec.defineZone({ name: "Everywhere" });
  const Server = spec.defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ heard: [] as string[] }),
    transitions: {
      [Say]: {
        description: "Repeats what it hears.",
        sources: ["src/server.ts#say"],
        sends: [Heard],
        run(state, msg, ctx) {
          ${refuseEmpty ? "if (!msg.text) return;" : ""}
          state.heard.push(msg.text);
          ctx.reply(Heard, { text: msg.text });
        },
      },
    },
  });
  const Client = spec.defineActor({
    name: "Client",
    zone,
    initialState: () => ({ got: [] as string[] }),
    actions: {
      say: {
        label: "Say",
        description: "Says something.",
        inputs: { text: spec.defineInput(String, { examples: () => ["hi", ""] }) },
        sources: ["src/client.ts#say"],
        sends: [Say],
        run: (_s, { text }, ctx) => ctx.send(ctx.the(Server), Say, { text }),
      },
    },
    transitions: { [Heard]: { description: "Hears it back.", sources: ["src/client.ts:1-3"], run: (s, msg) => void s.got.push(msg.text) } },
  });
  spec.defineProperties({
    serverHearsEverything: { description: "Everything said is heard by the server.", always: (w) => w.the(Server).state.heard.every((t) => typeof t === "string") },
  });
  spec.defineScenario({
    name: "Say nothing",
    run(s) {
      const c = s.spawn(Client, "Ann");
      s.act(c, "say", { text: "" });
      s.settle();
    },
  });
});
`;

function repo(): { root: string; commit: (message: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "feynman-cli-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, "specs"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "src/server.ts"), "export function say(text: string) {\n  return text;\n}\n");
  writeFileSync(join(root, "src/client.ts"), "// client\nexport function say() {\n}\n");
  return {
    root,
    commit(message) {
      git("add", "-A");
      git("-c", "user.email=t@e.st", "-c", "user.name=t", "commit", "-qm", message);
    },
  };
}

/** ANSI colour codes: the CLI colours its output when stdout is a terminal, as it is under `bun test` in one. */
const ANSI = /\u001b\[[0-9;]*m/g;

/** Run the CLI in-process and keep what it printed, as plain text. */
async function capture(argv: string[], cwd: string): Promise<{ status: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(" ").replace(ANSI, ""));
  try {
    const status = await main(argv, cwd);
    return { status, out: lines.join("\n") };
  } finally {
    console.log = log;
  }
}

test("list, run, check, lock: a spec in specs/ next to package.json", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false));
  commit("echo");
  expect((await capture(["list"], root)).out).toContain("specs/echo.ts  Echo  2 actors, 2 messages, 1 properties, 1 scenarios");
  const run = await capture(["run", "echo"], root);
  expect(run.status).toBe(0);
  expect(run.out).toContain("Ann (Client)  say");
  const check = await capture(["check", "--depth", "6"], root);
  expect(check.out).toContain("✓ serverHearsEverything");
  expect(check.out).toContain("3 source(s) not in feynman.lock yet");
  expect(check.status).toBe(0);
  // A source that does not resolve fails the check.
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false).replace('"src/client.ts:1-3"', '"src/client.ts#hear"'));
  const broken = await capture(["check", "--depth", "4"], root);
  expect(broken.status).toBe(1);
  expect(broken.out).toContain("✗ source src/client.ts#hear hear is not defined in src/client.ts");
}, 60_000);

test("lock records sources; check then reports a changed one as stale", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false).replace('"src/client.ts:1-3"', '"src/client.ts:1-2"'));
  commit("echo");
  expect((await capture(["lock"], root)).status).toBe(0);
  expect(JSON.parse(readFileSync(join(root, "feynman.lock"), "utf8")).sources).toHaveProperty(["src/server.ts#say"]);
  writeFileSync(join(root, "src/server.ts"), "export function say(text: string) {\n  return text.trim();\n}\n");
  const check = await capture(["check", "--depth", "4"], root);
  expect(check.out).toContain("stale: src/server.ts#say");
}, 60_000);

test("diff: every scenario's trace compared with another commit", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false));
  commit("before");
  writeFileSync(join(root, "specs/echo.ts"), SPEC(true));
  const diff = await capture(["diff", "--base", "main"], root);
  expect(diff.out).toContain("Say nothing: changed");
  expect(diff.out).toContain("~ Server.say");
  expect(diff.out).toContain("- Client.heard");
}, 60_000);

test("check type-checks specs: a send that is not declared is an error before anything runs", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false).replace("sends: [Heard],", "sends: [],"));
  commit("echo");
  const check = await capture(["check", "--depth", "2"], root);
  expect(check.status).toBe(1);
  expect(check.out).toMatch(/specs\/echo\.ts:\d+:\d+ /);
}, 60_000);

/** The Echo spec with a property the empty example breaks, marked known or not. */
const NEVER_EMPTY = (known?: string) =>
  SPEC(false).replace(
    "spec.defineProperties({",
    `spec.defineProperties({
    nothingEmpty: { description: "The server never hears nothing.", always: (w) => !w.the(Server).state.heard.includes("")${known ? `, known: ${JSON.stringify(known)}` : ""} },`,
  );

test("check --brief, --only, --json and --as-scenario: what agents read", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), NEVER_EMPTY());
  commit("echo");
  const brief = await capture(["check", "--depth", "4", "--brief"], root);
  expect(brief.status).toBe(1);
  expect(brief.out).toContain("✗ nothingEmpty");
  expect(brief.out).toContain("shortest counterexample, 2 event(s), needs no faults; see it with feynman check specs/echo.ts --only nothingEmpty");
  expect(brief.out).not.toContain("Repeats what it hears.");

  const only = await capture(["check", "--depth", "4", "--only", "nothingEmpty"], root);
  expect(only.out).toContain("Repeats what it hears.");
  expect(only.out).not.toContain("serverHearsEverything");

  const json = JSON.parse((await capture(["check", "--depth", "4", "--json"], root)).out);
  expect(json.ok).toBe(false);
  const [spec] = json.specs;
  expect(spec.scenarios).toEqual([{ name: "Say nothing", broken: "nothingEmpty", known: false }]);
  const property = spec.properties.find((p: { id: string }) => p.id === "nothingEmpty");
  expect(property.verdict).toBe("broken");
  expect(property.counterexample.faults).toBe(0);
  expect(property.counterexample.events.map((e: { instance: string; step: string }) => `${e.instance} ${e.step}`)).toEqual(["Client say", "Server message:Say"]);

  const code = await capture(["check", "--depth", "4", "--only", "nothingEmpty", "--as-scenario"], root);
  expect(code.out).toContain('const client = s.spawn(Client, "Client");');
  expect(code.out).toContain('s.act(client, "say", {"text":""});');
  expect(code.out).toContain('s.deliver(server, "Say"); // from client');

  await expect(main(["check", "--as-scenario"], root)).rejects.toThrow("name its property with --only");
  await expect(main(["check", "--only", "nope"], root)).rejects.toThrow("No property named nope");
}, 60_000);

test("check: a property marked known is reported but does not fail, until it holds", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), NEVER_EMPTY("ECHO-1: empty messages are not refused yet"));
  commit("echo");
  const known = await capture(["check", "--depth", "4"], root);
  expect(known.out).toContain('✗ scenario "Say nothing": nothingEmpty (known bug)');
  expect(known.out).toContain("known bug: ECHO-1: empty messages are not refused yet");
  expect(known.status).toBe(0);
  // Fixed: the mark is stale, and check says so.
  writeFileSync(join(root, "specs/echo.ts"), NEVER_EMPTY("ECHO-1").replace("state.heard.push(msg.text);", "if (msg.text) state.heard.push(msg.text);"));
  const fixed = await capture(["check", "--depth", "4"], root);
  expect(fixed.out).toContain('marked known ("ECHO-1"), but holds now: remove known');
  expect(fixed.status).toBe(1);
}, 60_000);
