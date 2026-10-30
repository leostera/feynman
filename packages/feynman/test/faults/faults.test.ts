// The faults library (RFD0012): faults and bounds as ordinary steps and parts, which both
// engines and the reference explorer explore alike. That they reach exactly what the built-in
// faults did is checked against TLC and P on every example (test/examples).
import { expect, test } from "bun:test";
import { check, type Bounds, type Engine, type Report } from "../../src/check/index.ts";
import { defineActor, defineMessage, defineProperty, defineSpec, defineZone, type Spec } from "../../src/spec/index.ts";
import * as faults from "../../src/faults/index.ts";
import { explore } from "../check/reference.ts";

const zone = defineZone({ name: "z" });

const lengthOf = (p: Report["properties"][number]) => ("counterexample" in p ? p.counterexample?.events.length : undefined);

async function run(spec: Spec, bounds: Partial<Bounds>, engine: Engine): Promise<Report> {
  return check(spec, { walks: 0, reduce: false, symmetry: false, workers: 0, ...bounds }, [], { engine });
}

/** Both engines reach what the reference explorer does, with the same verdicts. */
async function agree(spec: Spec, depth: number, instances: Record<string, number> = {}) {
  const theirs = explore(spec, { depth, instances });
  const reports = await Promise.all((["integer", "classic"] as Engine[]).map((engine) => run(spec, { depth, instances }, engine)));
  for (const r of reports) {
    expect(r.errors).toEqual([]);
    expect(r.states).toBe(theirs.worlds.size);
  }
  expect(reports[0].properties.map((p) => [p.id, p.holds, lengthOf(p)])).toEqual(reports[1].properties.map((p) => [p.id, p.holds, lengthOf(p)]));
  return reports[0];
}

const Hello = defineMessage("Hello", { n: Number });
const Ack = defineMessage("Ack", { n: Number }, { tone: "reply" });

/** Workers that greet a hub and wait for its ack, retrying on a timer, and that restart, keeping what they wrote to disk. */
function greeting(): Spec {
  const budget = faults.budget("faults", 0);
  const Worker = defineActor({
    name: "Worker",
    zone,
    initialState: () => ({ sent: 0, acked: 0 }),
    actions: {
      greet: { label: "Greet", description: "Greets.", with: [faults.atMost(2)], sends: [Hello], starts: ["retry"], run: (s, _i, ctx) => void (s.sent++, ctx.send(ctx.the(Hub), Hello, { n: s.sent }), ctx.start("retry")) },
    },
    transitions: {
      ack: { on: Ack, description: "Acked.", run: (s, m) => void (s.acked = Math.max(s.acked, m.n)) },
      retry: { description: "Greets again.", sends: [Hello], run: (s, _r, ctx) => ctx.send(ctx.the(Hub), Hello, { n: s.sent }) },
      ackLost: faults.lose(Ack, { spend: budget }),
      crash: faults.crash({ keeps: ["sent"], spend: budget }),
    },
  });
  const Hub = defineActor({
    name: "Hub",
    zone,
    singleton: true,
    initialState: () => ({ heard: 0 }),
    transitions: {
      hello: { on: Hello, description: "Acks.", sends: [Ack], run: (s, m, ctx) => void (s.heard++, ctx.reply(Ack, { n: m.n })) },
      helloLost: faults.lose(Hello, { spend: budget }),
    },
  });
  const bounded = defineProperty("acksBounded", { description: "Acks never pass what was sent.", always: (w) => w.all(Worker).every((x) => x.state.acked <= x.state.sent) });
  return defineSpec({ name: "Greeting", actors: [Worker, Hub], properties: [bounded] });
}

test("lose, crash and atMost: more budget, more states, and the engines and the reference agree", async () => {
  let before = 0;
  for (const n of [0, 1, 2]) {
    const report = await agree(greeting().setting({ faults: n }), 10, { Worker: 1 });
    expect(report.states).toBeGreaterThan(before);
    before = report.states;
  }
  // Two workers, symmetric or not: their counters go with them.
  const plain = await run(greeting(), { depth: 8, instances: { Worker: 2 } }, "integer");
  expect((await run(greeting(), { depth: 8, instances: { Worker: 2 } }, "classic")).states).toBe(plain.states);
});

test("duplicate delivers a message twice, which the built-in faults cannot", async () => {
  const Count = defineMessage("Count");
  const Counter = defineActor({
    name: "Counter",
    zone,
    singleton: true,
    initialState: () => ({ n: 0, sent: false }),
    actions: { count: { label: "Count", description: "Counts once.", when: (s) => !s.sent, sends: [Count], run: (s, _i, ctx) => void ((s.sent = true), ctx.send(ctx.self, Count, {})) } },
    transitions: { counted: { on: Count, description: "Adds one.", run: (s) => void s.n++ }, twice: faults.duplicate(Count, { spend: faults.budget("faults", 1) }) },
  });
  const once = defineProperty("countedOnce", { description: "Counted once.", always: (w) => w.the(Counter).state.n <= 1 });
  const spec = defineSpec({ name: "Twice", actors: [Counter], properties: [once] });
  const report = await run(spec, { depth: 6 }, "integer");
  expect(report.properties[0].holds).toBe(false);
  const broken = report.properties[0];
  if (!("counterexample" in broken) || !broken.counterexample) throw new Error("expected a counterexample");
  expect(broken.counterexample.events.map((e) => e.key)).toEqual(["count", "twice", "counted", "counted"]);
  expect((await run(spec.setting({ faults: 0 }), { depth: 6 }, "integer")).properties[0].holds).toBe(true);
});

test("a fault is an ordinary step: tagged fault, unfair, named by its key", () => {
  const spec = greeting();
  const worker = spec.actors.find((a) => a.name === "Worker")!;
  expect(worker.transitions.crash).toMatchObject({ tags: ["fault"], fair: false, uses: ["faults"] });
  expect(worker.transitions.crash.bound).toBeFunction();
  expect(worker.actions.greet.uses).toEqual(["Worker.greet"]);
  expect(spec.variables).toEqual([
    { name: "faults", initial: 0 },
    // Taken so far, up to atMost's limit.
    { name: "Worker.greet", initial: 0, each: "Worker" },
  ]);
  expect(() => faults.failed(defineMessage("Plain") as faults.Call)).toThrow("failed(Plain): plain is a message, not a call; define it with defineCall from the faults library");
});
