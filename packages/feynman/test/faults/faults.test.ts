// The faults library (RFD0012) against the built-in faults it replaces: the same spec, once with
// the checker's own faults (--faults, --repeats, durable) and once with the library's steps and
// budgets declared, must reach the same states and verdicts, in both engines and the reference
// explorer.
import { expect, test } from "bun:test";
import { check, type Bounds, type Engine, type Report } from "../../src/check/index.ts";
import * as core from "../../src/spec/index.ts";
import { defineActor, defineMessage, defineProperty, defineSpec, defineZone, type Spec } from "../../src/spec/index.ts";
import * as faults from "../../src/faults/index.ts";
import { explore } from "../check/reference.ts";

const zone = defineZone({ name: "z" });
const NONE = 1000;

interface Pair {
  builtIn: Spec;
  library: Spec;
  faults: number;
  repeats: number;
  depth: number;
  instances?: Record<string, number>;
  /** Compare with the reference explorer too (it undercounts when the depth cuts the search short). */
  reference?: boolean;
}

const lengthOf = (p: Report["properties"][number]) => ("counterexample" in p ? p.counterexample?.events.length : undefined);

async function run(spec: Spec, bounds: Partial<Bounds>, engine: Engine): Promise<Report> {
  return check(spec, { walks: 0, reduce: false, symmetry: false, workers: 0, ...bounds }, [], { engine });
}

/** The library's spec, with no built-in faults or repeats, reaches what the built-in one does. */
async function same(pair: Pair) {
  const instances = pair.instances ?? {};
  const theirs = explore(pair.builtIn, { depth: pair.depth, faults: pair.faults, repeats: pair.repeats, instances });
  const ours = explore(pair.library, { depth: pair.depth, faults: 0, repeats: NONE, instances });
  if (pair.reference !== false) expect(ours.worlds.size).toBe(theirs.worlds.size);
  expect(Object.fromEntries(ours.liveness)).toEqual(Object.fromEntries(theirs.liveness));
  for (const engine of ["integer", "classic"] as Engine[]) {
    const builtIn = await run(pair.builtIn, { depth: pair.depth, faults: pair.faults, repeats: pair.repeats, instances }, engine);
    const library = await run(pair.library, { depth: pair.depth, faults: 0, repeats: NONE, instances }, engine);
    expect(library.states).toBe(builtIn.states);
    if (pair.reference !== false) expect(library.states).toBe(theirs.worlds.size);
    expect(library.properties.map((p) => [p.id, p.holds, lengthOf(p)])).toEqual(builtIn.properties.map((p) => [p.id, p.holds, lengthOf(p)]));
  }
  return theirs.worlds.size;
}

/** A client paying through a call to a bank, retrying when the call fails (examples/retried-call). */
function payments(library: boolean, idempotent: boolean): Spec {
  const Charge = library ? faults.defineCall("Charge", { payment: String }) : core.defineCall("Charge", { payment: String });
  const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });
  const failure = library ? faults.failed(Charge) : core.failed(Charge as core.Call<"Charge", { payment: string }>);
  const budget = faults.budget("faults", 0);
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ paying: false, paid: false }),
    actions: {
      pay: {
        label: "Pay",
        description: "Pays.",
        when: (s) => !s.paying && !s.paid,
        sends: [Charge],
        run: (s, _i, ctx) => void ((s.paying = true), ctx.send(ctx.the(Bank), Charge, { payment: "p" })),
      },
    },
    transitions: {
      charged: { on: Charged, description: "Paid.", run: (s) => void ((s.paying = false), (s.paid = true)) },
      chargeFailed: { on: failure, description: "Retries.", sends: [Charge], run: (_s, f: { payload: { payment: string }; to: { id: string } }, ctx) => ctx.send(f.to, Charge, f.payload) },
      ...(library ? { chargedLost: faults.lose(Charged, { fails: Charge as faults.Call<"Charge", { payment: string }>, spend: budget }) } : {}),
    },
  });
  const Bank = defineActor({
    name: "Bank",
    zone,
    singleton: true,
    initialState: () => ({ charges: 0, seen: [] as string[] }),
    transitions: {
      charge: {
        on: Charge,
        description: "Charges.",
        sends: [Charged],
        run(s, m, ctx) {
          if (!idempotent || !s.seen.includes(m.payment)) {
            s.charges++;
            if (idempotent) s.seen.push(m.payment);
          }
          ctx.reply(Charged, { payment: m.payment });
        },
      },
      ...(library ? { chargeLost: faults.lose(Charge, { spend: budget }) } : {}),
    },
  });
  const once = defineProperty("chargedOnce", { description: "Charged once.", always: (w) => w.the(Bank).state.charges <= 1 });
  const ends = defineProperty("paymentsEnd", { description: "Ends paid.", leadsTo: { whenever: (w) => w.the(Client).state.paying, then: (w) => w.the(Client).state.paid } });
  return defineSpec({ name: "Payments", actors: [Client, Bank], properties: [once, ends] });
}

test("lose on a call and on its reply is the built-in loss of a call: the caller's call fails", async () => {
  for (const idempotent of [false, true])
    for (const n of [0, 1, 2]) {
      const library = payments(true, idempotent).setting({ faults: n });
      await same({ builtIn: payments(false, idempotent), library, faults: n, repeats: 1, depth: 14 });
    }
});

const Hello = defineMessage("Hello", { n: Number });
const Ack = defineMessage("Ack", { n: Number }, { tone: "reply" });

/** Workers that greet a hub and wait for its ack, retrying on a timer, and that restart, keeping what they wrote to disk. */
function greeting(library: boolean): Spec {
  const budget = faults.budget("faults", 0);
  const greets = { label: "Greet", description: "Greets.", sends: [Hello], starts: ["retry"], run: (s: { sent: number }, _i: unknown, ctx: core.Ctx) => void (s.sent++, ctx.send(ctx.the(Hub), Hello, { n: s.sent }), ctx.start("retry")) };
  const Worker = defineActor({
    name: "Worker",
    zone,
    initialState: () => ({ sent: 0, acked: 0 }),
    durable: library ? undefined : ["sent"],
    actions: { greet: library ? faults.atMost(2, greets) : greets },
    transitions: {
      ack: { on: Ack, description: "Acked.", run: (s, m) => void (s.acked = Math.max(s.acked, m.n)) },
      retry: { description: "Greets again.", sends: [Hello], run: (s, _r, ctx) => ctx.send(ctx.the(Hub), Hello, { n: s.sent }) },
      ...(library ? { ackLost: faults.lose(Ack, { spend: budget }), crash: faults.crash({ keeps: ["sent"], spend: budget }) } : {}),
    },
  });
  const Hub = defineActor({
    name: "Hub",
    zone,
    singleton: true,
    initialState: () => ({ heard: 0 }),
    transitions: {
      hello: { on: Hello, description: "Acks.", sends: [Ack], run: (s, m, ctx) => void (s.heard++, ctx.reply(Ack, { n: m.n })) },
      ...(library ? { helloLost: faults.lose(Hello, { spend: budget }) } : {}),
    },
  });
  const bounded = defineProperty("acksBounded", { description: "Acks never pass what was sent.", always: (w) => w.all(Worker).every((x) => x.state.acked <= x.state.sent) });
  return defineSpec({ name: "Greeting", actors: [Worker, Hub], properties: [bounded] });
}

test("lose, crash and atMost are the built-in loss, restart and repeats bound", async () => {
  for (const n of [0, 1, 2]) {
    const states = await same({ builtIn: greeting(false), library: greeting(true).setting({ faults: n }), faults: n, repeats: 2, depth: 10, instances: { Worker: 1 } });
    expect(states).toBeGreaterThan(1);
  }
  await same({ builtIn: greeting(false), library: greeting(true).setting({ faults: 1 }), faults: 1, repeats: 2, depth: 8, instances: { Worker: 2 }, reference: false });
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
  const report = await run(spec, { depth: 6, faults: 0, repeats: NONE }, "integer");
  expect(report.properties[0].holds).toBe(false);
  const broken = report.properties[0];
  if (!("counterexample" in broken) || !broken.counterexample) throw new Error("expected a counterexample");
  expect(broken.counterexample.events.map((e) => e.key)).toEqual(["count", "twice", "counted", "counted"]);
  expect((await run(spec.setting({ faults: 0 }), { depth: 6, faults: 0, repeats: NONE }, "integer")).properties[0].holds).toBe(true);
});

test("a fault is an ordinary step: tagged fault, unfair, named by its key", () => {
  const spec = greeting(true);
  const worker = spec.actors.find((a) => a.name === "Worker")!;
  expect(worker.transitions.crash).toMatchObject({ tags: ["fault"], fair: false, uses: ["faults"] });
  expect(worker.actions.greet.uses).toEqual(["Worker.greet"]);
  expect(spec.variables).toEqual([
    { name: "faults", initial: 0 },
    { name: "Worker.greet", initial: 2, each: "Worker" },
  ]);
  expect(() => faults.failed(defineMessage("Plain") as faults.Call)).toThrow("failed(Plain): not a call; define it with defineCall from the faults library");
});
