// The core's primitives for building faults and bounds as library code (RFD0012): model
// variables, ctx.reset, ctx.forward and ctx.delivery. Each spec here is checked by both engines
// and the reference explorer, which must count the same worlds.
import { expect, test } from "bun:test";
import { check, type Engine } from "../../src/check/index.ts";
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineVariable, defineZone, runScenario, type Spec } from "../../src/spec/index.ts";
import { explore } from "../check/reference.ts";

const zone = defineZone({ name: "z" });
const PLAIN = { depth: 10, faults: 0, repeats: 2, walks: 0, reduce: false, symmetry: false, workers: 0 } as const;

/** Both engines and the reference explorer: the same number of worlds, and the same verdicts. */
async function agree(spec: Spec, depth: number = PLAIN.depth) {
  const theirs = explore(spec, { depth, faults: 0, repeats: 2, instances: {} });
  const reports = await Promise.all((["integer", "classic"] as Engine[]).map((engine) => check(spec, { ...PLAIN, depth }, [], { engine })));
  for (const r of reports) {
    expect(r.exhaustive).toBe(true);
    expect(r.states).toBe(theirs.worlds.size);
    expect(r.errors).toEqual([]);
  }
  expect(reports[0].properties.map((p) => [p.id, p.holds])).toEqual(reports[1].properties.map((p) => [p.id, p.holds]));
  return reports[0];
}

const Ping = defineMessage("Ping");

/** A server that may drop pings, spending a shared budget, and counts what it answers. */
function dropping(budget: number) {
  const drops = defineVariable("drops", budget);
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ answered: 0 }),
    transitions: {
      answer: { on: Ping, description: "Answers.", run: (s) => void s.answered++ },
      drop: {
        on: Ping,
        fair: false,
        tags: ["fault"],
        uses: [drops],
        when: (_s, model) => model.get(drops) > 0,
        description: "Loses it.",
        run: (_s, _m, ctx) => ctx.set(drops, ctx.get(drops) - 1),
      },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ sent: 0 }),
    actions: { ping: { label: "Ping", description: "Pings.", sends: [Ping], run: (s, _i, ctx) => void (s.sent++, ctx.send(ctx.the(Server), Ping, {})) } },
  });
  const allAnswered = defineProperty("allAnswered", { description: "Every ping sent and delivered is answered.", always: (w) => w.quiet === false || w.the(Server).state.answered + (budget - w.get(drops)) === w.the(Client).state.sent });
  return defineSpec({ name: "Dropping", actors: [Server, Client], properties: [allAnswered] });
}

test("a variable is a budget: a step spends it, its when reads it, a property reads it, and --set changes it", async () => {
  const none = await agree(dropping(0));
  const one = await agree(dropping(1));
  const two = await agree(dropping(2));
  expect(none.states).toBeLessThan(one.states);
  expect(one.states).toBeLessThan(two.states);
  expect(one.properties.every((p) => p.holds)).toBe(true);
  // Setting the variable is the same spec as defining it so.
  expect((await agree(dropping(1).setting({ drops: 2 }))).states).toBe(two.states);
  expect(dropping(1).setting({ drops: 2 }).variables).toEqual([{ name: "drops", initial: 2 }]);
  expect(() => dropping(1).setting({ dropz: 2 })).toThrow('Dropping has no variable named "dropz"; its variables: drops');
  // A variable back at its initial value is the same world as one never set.
  expect(one.coverage.missed).toEqual([]);
});

test("a variable for each instance bounds what each one does", async () => {
  const counted = (symmetric: boolean) => {
    const pings = defineVariable("pings", 0, { each: true });
    const Pinger = defineActor({
      name: "Pinger",
      zone,
      symmetric,
      initialState: () => ({}),
      actions: {
        ping: { label: "Ping", description: "Pings, twice at most.", uses: [pings], when: (_s, model) => model.get(pings) < 2, run: (_s, _i, ctx) => ctx.set(pings, ctx.get(pings) + 1) },
      },
    });
    return defineSpec({ name: "Counted", actors: [Pinger], properties: [defineProperty("atMostTwo", { description: "Each pings twice at most.", always: (w) => w.all(Pinger).every((p) => w.get(pings, p) <= 2) })] });
  };
  const spec = counted(false);
  const theirs = explore(spec, { depth: 10, faults: 0, repeats: 10, instances: { Pinger: 2 } });
  const ours = await check(spec, { ...PLAIN, repeats: 10, instances: { Pinger: 2 } }, [], { engine: "integer" });
  // Two pingers, each at 0, 1 or 2.
  expect(ours.states).toBe(9);
  expect(theirs.worlds.size).toBe(9);
  expect(ours.properties[0].holds).toBe(true);
});

test("a step uses only the variables it lists", () => {
  const drops = defineVariable("drops", 1);
  const other = defineVariable("other", 0);
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({}),
    actions: {
      peek: { label: "Peek", description: "Reads one it does not list.", uses: [other], run: (_s, _i, ctx) => void ctx.get(drops) },
      list: { label: "List", description: "Lists one.", uses: [drops], run: () => {} },
    },
  });
  const peeked = defineScenario("Peek", { run: (s) => s.act(s.the(Server), "peek") });
  const spec = defineSpec({ name: "Uses", actors: [Server], scenarios: [peeked] });
  expect(runScenario(spec, spec.scenarios[0]).error).toBe("Server.peek: uses drops, which it does not declare in uses");
  expect(() => defineVariable("not a word", 0)).toThrow('A variable\'s name is a word, like "faults", which --set names it by: not "not a word"');
});

const Ask = defineMessage("Ask");
const Told = defineMessage("Told", {}, { tone: "reply" });

test("ctx.reset starts the instance again: initial state but for what it keeps, no timers, no replies on their way", () => {
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({}),
    transitions: {
      ask: {
        on: Ask,
        description: "Answers, as an answer to the question.",
        sends: [Told],
        run: (_s, _m, ctx) => ctx.send(ctx.from, Told, {}, { text: "told", answers: { message: ctx.delivery.message, payload: ctx.delivery.payload } }),
      },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ asked: 0, told: 0, disk: 0 }),
    actions: {
      ask: { label: "Ask", description: "Asks, and waits.", sends: [Ask], starts: ["giveUp"], run: (s, _i, ctx) => void (s.asked++, s.disk++, ctx.send(ctx.the(Server), Ask, {}), ctx.start("giveUp")) },
      crash: { label: "Crash", description: "Crashes, keeping its disk.", run: (_s, _i, ctx) => ctx.reset({ keeps: ["disk"] }) },
    },
    transitions: {
      told: { on: Told, description: "Is told.", run: (s) => void s.told++ },
      giveUp: { description: "Gives up.", run: () => {} },
    },
  });
  const crashed = defineScenario("Crash while asking", {
    run(s) {
      const client = s.the(Client);
      s.act(client, "ask");
      s.deliver(s.the(Server), Ask);
      s.act(client, "crash");
    },
  });
  const spec = defineSpec({ name: "Reset", actors: [Server, Client], scenarios: [crashed] });
  const run = runScenario(spec, spec.scenarios[0]);
  expect(run.error).toBeUndefined();
  const last = run.events.at(-1)!;
  expect(last.cancelled).toEqual(["giveUp"]);
  expect(last.changes.map((c) => `${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`)).toEqual(["asked: 1 → 0"]);
  // The reply to its question went with its memory.
  expect(run.worlds.at(-1)!.pending).toEqual([]);
});

test("ctx.forward puts the message back as it was, and ctx.delivery says what it is", async () => {
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ answered: 0, from: "" }),
    transitions: {
      answer: { on: Ping, description: "Answers.", run: (s, _m, ctx) => void (s.answered++, (s.from = ctx.delivery.from.id)) },
      twice: { on: Ping, fair: false, when: (s) => s.answered === 0, description: "Delivers it twice.", run: (_s, _m, ctx) => (ctx.forward(), ctx.forward()) },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({}),
    actions: { ping: { label: "Ping", description: "Pings.", when: () => true, sends: [Ping], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ping, {}) } },
  });
  const doubled = defineScenario("Doubled", {
    run(s) {
      s.act(s.the(Client), "ping");
      s.step(s.the(Server), "twice");
      s.settle();
    },
  });
  const spec = defineSpec({ name: "Forward", actors: [Server, Client], scenarios: [doubled] });
  const run = runScenario(spec, spec.scenarios[0]);
  expect(run.error).toBeUndefined();
  expect(run.worlds.at(-1)!.instances.find((i) => i.actor === "Server")!.state).toEqual({ answered: 2, from: "client" });
  await agree(spec, 6);
});
