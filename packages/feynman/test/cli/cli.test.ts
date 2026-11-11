import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";
import { budget, crash, defineActor, defineSpec, defineZone } from "../../src/spec/index.ts";

const SPEC = (refuseEmpty: boolean) => `import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, input } from "@leostera/feynman";

const Say = defineMessage("Say", { text: String });
const Heard = defineMessage("Heard", { text: String }, { tone: "reply" });

const zone = defineZone({ name: "Everywhere" });

const Server = defineActor({
  name: "Server",
  zone,
  singleton: true,
  initialState: () => ({ heard: [] as string[] }),
  transitions: {
    say: {
      on: Say,
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

const Client = defineActor({
  name: "Client",
  zone,
  initialState: () => ({ got: [] as string[] }),
  actions: {
    say: {
      label: "Say",
      description: "Says something.",
      inputs: { text: input(String, { examples: () => ["hi", ""] }) },
      sources: ["src/client.ts#say"],
      sends: [Say],
      run: (_s, { text }, ctx) => ctx.send(ctx.the(Server), Say, { text }),
    },
  },
  transitions: { heard: { on: Heard, description: "Hears it back.", sources: ["src/client.ts:1-3"], run: (s, msg) => void s.got.push(msg.text) } },
});

const serverHearsEverything = defineProperty("serverHearsEverything", { description: "Everything said is heard by the server.", always: (w) => w.the(Server).state.heard.every((t) => typeof t === "string") });

const sayNothing = defineScenario("Say nothing", {
  run(s) {
    const c = s.spawn(Client, "Ann");
    s.act(c, "say", { text: "" });
    s.settle();
  },
});

export default defineSpec({
  name: "Echo",
  actors: [Server, Client],
  properties: [serverHearsEverything],
  scenarios: [sayNothing],
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
  // Paths cut off at depth 6 may break it further on: held is not proved.
  expect(check.out).toContain("~ serverHearsEverything");
  expect(check.out).toContain("held to depth 6, but paths that had not got there yet were cut off");
  expect(check.out).toContain("3 source(s) not in feynman.lock yet");
  expect(check.status).toBe(0);
  // A source that does not resolve fails the check.
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false).replace('"src/client.ts:1-3"', '"src/client.ts#hear"'));
  const broken = await capture(["check", "--depth", "4"], root);
  expect(broken.status).toBe(1);
  expect(broken.out).toContain("✗ source src/client.ts#hear hear is not defined in src/client.ts");
}, 60_000);

test("run: one scenario prints its trace; several, a line each unless --all", async () => {
  const { root, commit } = repo();
  const two = SPEC(false)
    .replace('const sayNothing = defineScenario("Say nothing"', 'const doNothing = defineScenario("Do nothing", { run: () => {} });\nconst sayNothing = defineScenario("Say nothing"')
    .replace("scenarios: [sayNothing]", "scenarios: [doNothing, sayNothing]");
  writeFileSync(join(root, "specs/echo.ts"), two);
  commit("echo");
  const summary = await capture(["run", "echo"], root);
  expect(summary.status).toBe(0);
  expect(summary.out).toContain("✓ Do nothing  0 event(s)");
  expect(summary.out).toMatch(/✓ Say nothing {2}\d+ event\(s\)/);
  expect(summary.out).not.toContain("Ann (Client)  say");
  expect((await capture(["run", "echo", "--all"], root)).out).toContain("Ann (Client)  say");
  expect((await capture(["run", "echo", "--scenario", "Say nothing"], root)).out).toContain("Ann (Client)  say");
}, 60_000);

test("check: rules a property needs are checked without them; --without shows the design without one", async () => {
  const { root, commit } = repo();
  writeFileSync(
    join(root, "specs/capped.ts"),
    `import { defineActor, defineProperty, defineRule, defineSpec, defineZone } from "@leostera/feynman";
const cap = defineRule("cap", { description: "Counting stops at two." });
const decoy = defineRule("decoy", { description: "Changes nothing." });
const zone = defineZone({ name: "z" });
const Counter = defineActor({
  name: "Counter", zone, singleton: true, initialState: () => ({ n: 0 }),
  actions: { count: { label: "Count", description: "Counts one more.", when: (s) => !cap.on || s.n < 2, run: (s) => void s.n++ } },
});
const belowThree = defineProperty("belowThree", { description: "The count stays below three.", always: (w) => w.the(Counter).state.n < 3, needs: [cap, decoy] });
export default defineSpec({ name: "Capped", actors: [Counter], properties: [belowThree], finalState: { description: "It may stop at any count.", when: () => true } });
`,
  );
  commit("capped");
  const checked = await capture(["check", "capped", "--walks", "0"], root);
  expect(checked.out).toContain("✓ cap    needed: without it, belowThree breaks (3 events)");
  expect(checked.out).toContain("✗ decoy  not needed by belowThree: held without the rule, in every state.");
  expect(checked.status).toBe(1);
  expect((await capture(["check", "capped", "--walks", "0", "--no-rules"], root)).status).toBe(0);
  const without = await capture(["check", "capped", "--walks", "0", "--without", "cap"], root);
  expect(without.out).toContain("Capped without cap: explored");
  expect(without.out).toContain("✗ belowThree");
  expect(without.out).not.toContain("✓ cap");
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
  SPEC(false)
    .replace(
      "const sayNothing =",
      `const nothingEmpty = defineProperty("nothingEmpty", { description: "The server never hears nothing.", always: (w) => !w.the(Server).state.heard.includes("")${known ? `, known: ${JSON.stringify(known)}` : ""} });\n\nconst sayNothing =`,
    )
    .replace("properties: [serverHearsEverything]", "properties: [nothingEmpty, serverHearsEverything]");

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
  expect(property.counterexample.events.map((e: { instance: string; step: string }) => `${e.instance} ${e.step}`)).toEqual(["Client say", "Server say"]);

  const code = await capture(["check", "--depth", "4", "--only", "nothingEmpty", "--as-scenario"], root);
  expect(code.out).toContain('const client = s.spawn(Client, "Client");');
  expect(code.out).toContain('s.act(client, "say", {"text":""});');
  expect(code.out).toContain("s.deliver(server, Say); // from client");

  await expect(main(["check", "--as-scenario"], root)).rejects.toThrow("name its property with --only");
  await expect(main(["check", "--only", "nope"], root)).rejects.toThrow("No property named nope");
}, 60_000);

test("a mistyped option is the user's error, with where to look, not a crash", async () => {
  const error = await main(["check", "--export", "fixed"]).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TypeError);
  expect((error as Error).message).toBe("Unknown option --export. `feynman help` lists the options.");
  await expect(main(["check", "--depth"])).rejects.toThrow("argument missing. `feynman help` lists the options.");
});

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

test("version, --version and -v print the version", async () => {
  const { version } = await import("../../package.json");
  for (const flag of ["version", "--version", "-v"]) expect(await capture([flag], tmpdir())).toEqual({ status: 0, out: version });
});

test("check: a liveness property cut off at the depth bound says to raise --depth", async () => {
  const { root } = repo();
  writeFileSync(
    join(root, "specs/count.ts"),
    `import { defineActor, defineProperty, defineSpec, defineZone } from "@leostera/feynman";
const zone = defineZone({ name: "Here" });
const Counter = defineActor({ name: "Counter", zone, singleton: true, initialState: () => ({ n: 0 }),
  transitions: { tick: { description: "Counts one.", sources: ["src/server.ts#say"], when: (s) => s.n < 30, run: (s) => void s.n++ } } });
const reaches = defineProperty("reaches", { description: "It gets to 30.", eventually: (w) => w.the(Counter).state.n >= 30 });
export default defineSpec({ name: "Count", actors: [Counter], properties: [reaches], finalState: { description: "Done.", when: (w) => w.the(Counter).state.n >= 30 } });
`,
  );
  const { out } = await capture(["check", "count", "--depth", "10", "--walks", "0"], root);
  expect(out).toContain("~ reaches  It gets to 30.  held to depth 10, but paths that had not got there yet were cut off at that depth");
  expect(out).toContain(`"~" is not a proof: raise --depth (check.depth in feynman.config.ts; it is 10 now)`);
  expect((await capture(["check", "count", "--depth", "40", "--walks", "0"], root)).out).toContain("✓ reaches");
});

test("check: a scenario's setup is explored from, and one that breaks a property says so", async () => {
  const { root } = repo();
  writeFileSync(
    join(root, "specs/ledger.ts"),
    `import { defineActor, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";
const zone = defineZone({ name: "Here" });
const Ledger = defineActor({ name: "Ledger", zone, singleton: true, initialState: () => ({ seq: 0 }),
  actions: { bump: { label: "Bump", description: "Moves on.", sources: ["src/server.ts#say"], run: (s) => void s.seq++ } } });
const belowTen = defineProperty("belowTen", { description: "It stays below ten.", always: (w) => w.the(Ledger).state.seq < 10 });
const tenAlready = defineScenario("Ten already", { setup: (w) => w.set(Ledger, { seq: 10 }), run: () => {} });
export default defineSpec({ name: "Ledger", actors: [Ledger], properties: [belowTen], scenarios: [tenAlready] });
`,
  );
  const { out } = await capture(["check", "ledger", "--walks", "0"], root);
  expect(out).toContain(`✗ scenario "Ten already": its setup breaks belowTen`);
  expect(out).toContain("and from the setup of 1");
  expect(out).toContain(`shortest counterexample, 0 event(s), needs no faults, from the setup of scenario "Ten already"`);
});

test("type errors are said again at the end, so the end of the output shows them", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(false).replace("state.heard.push(msg.text);", "state.heard.push(msg.text.length);"));
  commit("echo");
  const check = await capture(["check", "--depth", "4", "--brief"], root);
  expect(check.status).toBe(1);
  expect(check.out).toContain("specs/echo.ts:");
  expect(check.out.trimEnd().split("\n").at(-1)).toBe("✗ 1 type error(s) in specs/echo.ts, listed at the top: the results above may come from code that does not compile");
}, 60_000);

test("a loaded spec's steps are found by name: the spec and the engine share one Feynman", async () => {
  const { root } = repo();
  writeFileSync(
    join(root, "specs/echo.ts"),
    SPEC(false)
      .replace(
        "const sayNothing =",
        `const onlySayHears = defineProperty("onlySayHears", { description: "Only the server's say step hears.", everyStep: (before, after, e) => e.is(Server, "say") || after.the(Server).state.heard.length === before.the(Server).state.heard.length });\n\nconst sayNothing =`,
      )
      .replace("properties: [serverHearsEverything]", "properties: [onlySayHears]"),
  );
  const { out } = await capture(["check", "--brief", "--depth", "4", "--walks", "0"], root);
  expect(out).toContain("~ onlySayHears");
}, 60_000);

test("--help after a command prints the usage", async () => {
  const { root } = repo();
  const help = await capture(["build", "--help"], root);
  expect(help.status).toBe(0);
  expect(help.out).toContain("Usage: feynman <command>");
});

test("check: --instances and --set that name nothing, or give the wrong kind of value, are refused", async () => {
  const { root, commit } = repo();
  writeFileSync(join(root, "specs/echo.ts"), SPEC(true));
  commit("spec");
  const refused = (argv: string[]) => main(["check", ...argv], root).then(
    () => "accepted",
    (e: Error) => e.message,
  );
  // A mistyped actor was ignored, under a header that named it as if it had been used.
  expect(await refused(["--instances", "Clinet=3"])).toBe("--instances: no actor named Clinet; actors there can be several of: Client");
  expect(await refused(["--instances", "Server=2"])).toBe("--instances: Server is a singleton, so there is exactly one; actors there can be several of: Client");
  expect(await refused(["--instances", "Client=-1"])).toContain("--instances takes Actor=N pairs, N a whole number");
  expect(await refused(["--instances", "Client=two"])).toContain("--instances takes Actor=N pairs, N a whole number");
  const two = await capture(["check", "--instances", "Client=2", "--brief"], root);
  expect(two.out).toContain("2 Client");
}, 60_000);

test("a model variable is set to the kind of value it starts with", () => {
  const faults = budget("faults", 1);
  const zone = defineZone({ name: "z" });
  const A = defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), transitions: { crash: crash({ spend: faults }) } });
  const spec = defineSpec({ name: "Budgeted", actors: [A], finalState: { description: "Anything.", when: () => true } });
  expect(spec.setting({ faults: 3 }).variables.find((v) => v.name === "faults")?.initial).toBe(3);
  expect(() => spec.setting({ faults: "lots" })).toThrow('Budgeted: faults is a number (it starts at 1), not "lots"');
  expect(() => spec.setting({ faults: -1 })).toThrow("Budgeted: faults is a whole number (it starts at 1), not -1");
  expect(() => spec.setting({ fualts: 2 })).toThrow('Budgeted has no variable named "fualts"');
});

/** A shop with two of something, buyers who each ask once, and two reachable properties. */
const SHOP = `import { atMost, defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

const Buy = defineMessage("Buy", {});
const Sold = defineMessage("Sold", {}, { tone: "reply" });
const SoldOut = defineMessage("SoldOut", {}, { tone: "reply" });
const zone = defineZone({ name: "Everywhere" });

const Shop = defineActor({
  name: "Shop",
  zone,
  singleton: true,
  initialState: () => ({ stock: 2 }),
  transitions: {
    buy: {
      on: Buy,
      description: "Sells one, if there is one left.",
      sends: [Sold, SoldOut],
      run(state, _msg, ctx) {
        if (state.stock === 0) return ctx.reply(SoldOut, {});
        state.stock -= 1;
        ctx.reply(Sold, {});
      },
    },
  },
});

const Buyer = defineActor({
  name: "Buyer",
  zone,
  initialState: () => ({ got: false, missed: false }),
  actions: { buy: { label: "Buy", description: "Asks for one.", with: [atMost(1)], sends: [Buy], run: (_s, _i, ctx) => ctx.send(ctx.the(Shop), Buy, {}) } },
  transitions: {
    sold: { on: Sold, description: "Gets one.", run: (s) => void (s.got = true) },
    soldOut: { on: SoldOut, description: "Is told there are none left.", run: (s) => void (s.missed = true) },
  },
});

const someoneGetsOne = defineProperty("someoneGetsOne", { description: "A buyer gets one.", reachable: (w) => w.all(Buyer).some((b) => b.state.got) });
const someoneMisses = defineProperty("someoneMisses", { description: "A buyer is told there are none left.", reachable: (w) => w.all(Buyer).some((b) => b.state.missed) });

export default defineSpec({ name: "Shop", actors: [Shop, Buyer], properties: [someoneGetsOne, someoneMisses], finalState: { description: "Anything.", when: () => true } });
`;

test("check reads out reachable properties: how far, never reached, not reached yet, the way there, and as a scenario", async () => {
  const { root } = repo();
  writeFileSync(join(root, "specs/shop.ts"), SHOP);
  // Two buyers, two in stock: nobody misses out, and every world was explored, so that is a ✗.
  const two = await capture(["check", "shop", "--instances", "Buyer=2", "--walks", "0"], root);
  expect(two.status).toBe(1);
  expect(two.out).toContain("✓ someoneGetsOne  A buyer gets one.  reached in 3 event(s); see the way there with feynman check specs/shop.ts --only <property>");
  expect(two.out).toMatch(/✗ someoneMisses {2}A buyer is told there are none left\. {2}never reached: no world within the bounds gets there, of the \d+ explored/);
  expect(two.out).toContain("A guard too strict, a step that can never run, or bounds too small for it");
  // A depth bound that cuts the search off before the third buyer misses out: not reached yet.
  const cut = await capture(["check", "shop", "--instances", "Buyer=3", "--depth", "4", "--walks", "0"], root);
  expect(cut.status).toBe(0);
  expect(cut.out).toContain("~ someoneMisses  A buyer is told there are none left.  not reached by depth 4, but paths that had not got there yet were cut off at that depth: it may be reached further on");
  // --only shows the way there.
  const only = await capture(["check", "shop", "--instances", "Buyer=3", "--only", "someoneMisses", "--walks", "0"], root);
  expect(only.out).toContain("✓ someoneMisses  A buyer is told there are none left.  reached in 7 event(s)");
  expect(only.out).toContain("7  Buyer C (Buyer)  sold out  {}  from Shop");
  // --as-scenario writes it out.
  const scenario = await capture(["check", "shop", "--instances", "Buyer=3", "--only", "someoneMisses", "--as-scenario", "--walks", "0"], root);
  expect(scenario.out).toContain('const someoneMissesIsReached = defineScenario("someoneMisses is reached", {');
  const unreached = await capture(["check", "shop", "--instances", "Buyer=2", "--only", "someoneMisses", "--as-scenario", "--walks", "0"], root);
  expect(unreached.out).toContain("someoneMisses is never reached within these bounds: there is no path to replay.");
  // --json: the verdicts, the way there, and how far a search that stopped got.
  const json = JSON.parse((await capture(["check", "shop", "--instances", "Buyer=2", "--walks", "0", "--json"], root)).out);
  const [spec] = json.specs;
  const byId = Object.fromEntries(spec.properties.map((p: { id: string }) => [p.id, p]));
  expect(byId.someoneGetsOne).toMatchObject({ kind: "reachable", verdict: "holds", witness: { foundBy: "search", events: [{}, {}, {}] } });
  expect(byId.someoneMisses).toMatchObject({ kind: "reachable", verdict: "broken" });
  expect(byId.someoneMisses.counterexample).toBeUndefined();
}, 60_000);

test("conform reads a log against a spec: the run it is, where it leaves the spec, as JSON, and as a scenario", async () => {
  const { root } = repo();
  writeFileSync(join(root, "specs/shop.ts"), SHOP);
  const line = (o: unknown) => JSON.stringify(o);
  const spawns = [line({ kind: "spawn", actor: "Buyer", label: "Ann" }), line({ kind: "spawn", actor: "Buyer", label: "Bo" })];
  writeFileSync(
    join(root, "sold.jsonl"),
    [...spawns, line({ instance: "Ann", key: "buy" }), line({ instance: "Shop", key: "buy", from: "Ann" }), line({ instance: "Ann", key: "sold", state: { got: true } })].join("\n"),
  );
  const ok = await capture(["conform", "shop", "sold.jsonl"], root);
  expect(ok.status).toBe(0);
  expect(ok.out).toContain("specs/shop.ts, against sold.jsonl");
  // The spawns make the world it starts in; the events are the steps.
  expect(ok.out).toContain("✓ the log is a run of the spec: 3 logged event(s)");
  expect(ok.out).toContain("   2  Shop (Shop)  buy  {}  from Ann  line 4");
  expect(ok.out).toContain("no property breaks on it");
  // Bo is told there are none left, with two in stock.
  writeFileSync(join(root, "wrong.jsonl"), [...spawns, line({ instance: "Bo", key: "buy" }), line({ instance: "Bo", key: "soldOut" })].join("\n"));
  const wrong = await capture(["conform", "shop", "wrong.jsonl"], root);
  expect(wrong.status).toBe(1);
  expect(wrong.out).toContain("✗ the log leaves the spec at line 4: Bo soldOut");
  expect(wrong.out).toContain("what else could happen there, after up to 4 step(s) the log does not show:");
  expect(wrong.out).toContain("    Shop buy  Buy {} from Bo");
  const json = JSON.parse((await capture(["conform", "shop", "wrong.jsonl", "--json"], root)).out);
  expect(json).toMatchObject({ spec: "specs/shop.ts", log: "wrong.jsonl", conforms: false, stop: { line: 4 } });
  expect(json.events.map((e: { key: string; line: number }) => [e.key, e.line])).toEqual([["buy", 3]]);
  const scenario = await capture(["conform", "shop", "sold.jsonl", "--as-scenario"], root);
  expect(scenario.out).toContain('const theLog = defineScenario("The log sold.jsonl", {');
  expect(scenario.out).toContain('s.act(ann, "buy"); // line 3');
  // A line the log cannot mean is refused with its number.
  writeFileSync(join(root, "bad.jsonl"), line({ instance: "Ann", key: "fly" }));
  const bad = await capture(["conform", "shop", "bad.jsonl"], root);
  expect(bad.status).toBe(1);
  expect(bad.out).toContain("bad.jsonl: line 1 is about Ann, who is not there");
}, 60_000);
