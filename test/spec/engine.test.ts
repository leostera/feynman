import { expect, test } from "bun:test";
import { act, defineSpec, fire, message, pendingInOrder, Runner, runScenario, startWorld } from "../../src/spec/index.ts";
import remoteAccess from "./fixtures/remote-access.ts";

test("a scenario runs to its end, recording what each step changed and sent", () => {
  const run = runScenario(remoteAccess, remoteAccess.scenarios[0]);
  expect(run.error).toBeUndefined();
  expect(run.events.map((e) => `${e.actor}.${e.key}`)).toEqual([
    "Person.spawn",
    "Mac.spawn",
    "Person.pairHost",
    "Axo relay.message:NewCode",
    "Person.message:Code",
    "Mac.link",
    "Axo relay.message:Redeem",
    "Mac.message:Redeemed",
  ]);
  const link = run.events.find((e) => e.key === "link")!;
  expect(link.inputs).toEqual({ code: "code-1" });
  expect(link.changes.map((c) => `${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)).toEqual([
    'link.pending: null → "cred-1"',
    'code: null → "code-1"',
    'keychain: [] → ["cred-1"]',
  ]);
  expect(link.sent.map((s) => s.message)).toEqual(["message:Redeem"]);
  expect(link.started.map((s) => s.timer)).toEqual(["redeemTimeout"]);
  const studio = run.worlds.at(-1)!.instances.find((i) => i.id === "mac-studio")!;
  expect(studio.state).toMatchObject({ link: { account: "acct-Alice", pending: null } });
  expect(run.events.every((e) => !e.error && e.violations.length === 0)).toBe(true);
  // Redeemed cancelled the timeout: nothing is left pending.
  expect(run.worlds.at(-1)!.pending).toEqual([]);
});

test("runs are deterministic: the same spec and seed give the same trace", () => {
  const a = runScenario(remoteAccess, remoteAccess.scenarios[0], 7);
  const b = runScenario(remoteAccess, remoteAccess.scenarios[0], 7);
  expect(JSON.stringify(b)).toBe(JSON.stringify(a));
});

test("a lost reply leaves the Mac retrying, and the relay refuses the used code", () => {
  const runner = new Runner(remoteAccess);
  const alice = runner.spawn("Person", "Alice").instance;
  const studio = runner.spawn("Mac", "Studio").instance;
  runner.act(alice, "pairHost");
  runner.settle();
  const code = (runner.world.instances.find((i) => i.id === alice)!.state as { codes: string[] }).codes[0];
  runner.act(studio, "link", { code });
  runner.loseNext("message:Redeemed");
  runner.settle();
  const keys = runner.events.map((e) => `${e.kind} ${e.actor}.${e.key}`);
  expect(keys).toContain("lose Mac.message:Redeemed");
  expect(keys).toContain("timer Mac.redeemTimeout");
  expect(keys.at(-1)).toBe("deliver Mac.message:Refused");
  const mac = runner.world.instances.find((i) => i.id === studio)!.state as { link: { account: string | null } };
  expect(mac.link.account).toBeNull();
});

test("a send the step does not declare is a spec error, and the step has no effects", () => {
  const spec = defineSpec("Undeclared", { messages: { Ping: message<{}>({ name: "ping" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const A = s.defineActor({
      name: "A",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: {
        go: {
          label: "Go",
          description: "Sends without declaring it.",
          sources: ["a.ts#go"],
          run(state, _inputs, ctx) {
            state.n = 1;
            ctx.send(ctx.the(A), s.messages.Ping, {});
          },
        },
      },
    });
  });
  const [start] = startWorld(spec);
  const step = act(spec, start.world, "a", "go");
  expect(step.event.error).toBe("A.go: sends message:Ping, which it does not declare in sends");
  expect(step.event.changes).toEqual([]);
  expect(step.world.pending).toEqual([]);
  expect(step.world.instances[0].state).toEqual({ n: 0 });
});

test("invariants that do not hold are reported on the event that broke them", () => {
  const spec = defineSpec("Broken", { messages: { Ping: message<{}>({ name: "ping" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const Counter = s.defineActor({
      name: "Counter",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: {
        bump: { label: "Bump", description: "Adds one.", sources: ["c.ts#bump"], sends: [s.messages.Ping], run: (state, _i, ctx) => { state.n += 1; ctx.send(ctx.the(Counter), s.messages.Ping, {}); } },
      },
      transitions: {
        [s.messages.Ping]: { description: "Adds one more.", sources: ["c.ts#ping"], run: (state) => void (state.n += 1) },
      },
    });
    s.defineInvariants({ atMostTwo: { description: "n stays at two or below.", always: (w) => w.the(Counter).state.n <= 2 } });
  });
  let world = startWorld(spec).at(-1)!.world;
  world = act(spec, world, "counter", "bump").world;
  const delivered = fire(spec, world, pendingInOrder(world)[0].id);
  expect(delivered.event.violations).toEqual([]);
  const again = act(spec, delivered.world, "counter", "bump");
  expect(again.event.violations).toEqual(["atMostTwo"]);
});

test("a restart keeps durable state and forgets the rest, and its timers", () => {
  const runner = new Runner(remoteAccess);
  const studio = runner.spawn("Mac", "Studio").instance;
  runner.act(studio, "link", { code: "never-issued" });
  const restarted = runner.restart(studio);
  expect(restarted.changes.map((c) => c.path)).toEqual(["link.pending", "code", "keychain"]);
  expect(runner.world.pending.filter((p) => p.kind === "timer")).toEqual([]);
});
