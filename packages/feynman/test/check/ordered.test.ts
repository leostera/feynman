// Ordered channels: of the ordered messages one instance sends another, a step takes only the
// oldest in flight, unless it may take one out of order, as a loss does. The reference
// explorer (reference.ts), which keeps each channel's order its own way, must reach the same
// worlds, and as many as the checker has states.
import { expect, test } from "bun:test";
import { canonical, check, initialWorld, type Bounds, type Report } from "../../src/check/index.ts";
import { atMost, budget, crash, defineActor, defineCall, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, duplicate, failed, lose, runScenario, stepsTaking, act, type Spec, type World } from "../../src/spec/index.ts";
import { explore } from "./reference.ts";

const zone = defineZone({ name: "z" });
const SEARCH = { walks: 0, timeLimit: 600_000 } satisfies Partial<Bounds>;

/**
 * A writer that sends First, then Second, to a reader that writes down what arrives. With
 * `faults`, either may be lost on the way. Its scenario tries to deliver second first.
 */
function pipe(ordered: boolean, options: { faults?: number; forwards?: boolean; duplicates?: boolean } = {}): Spec {
  const First = defineMessage("First", {}, { ordered });
  const Second = defineMessage("Second", {}, { ordered });
  const faults = budget("faults", options.faults ?? 0);
  const Reader = defineActor({
    name: "Reader",
    zone,
    singleton: true,
    initialState: () => ({ got: [] as string[], put: false }),
    transitions: {
      first: {
        on: First,
        description: "Writes it down; puts it back once, when told to.",
        run(state, _msg, ctx) {
          if (options.forwards && !state.put) return void ((state.put = true), ctx.forward());
          state.got.push("first");
        },
      },
      second: { on: Second, description: "Writes it down.", run: (state) => void state.got.push("second") },
      firstLost: lose(First, { spend: faults }),
      secondLost: lose(Second, { spend: faults }),
      ...(options.duplicates ? { firstTwice: duplicate(First, { spend: faults }) } : {}),
    },
  });
  const Writer = defineActor({
    name: "Writer",
    zone,
    singleton: true,
    initialState: () => ({}),
    actions: {
      go: {
        with: [atMost(1)],
        label: "Go",
        description: "Sends first, then second.",
        sends: [First, Second],
        run(_state, _inputs, ctx) {
          ctx.send(ctx.the(Reader), First, {});
          ctx.send(ctx.the(Reader), Second, {});
        },
      },
    },
  });
  const inOrder = defineProperty("inOrder", { description: "Second never arrives before first.", always: (w) => w.the(Reader).state.got[0] !== "second" });
  const bothArrive = defineProperty("bothArrive", { description: "Both arrive.", reachable: (w) => w.the(Reader).state.got.length === 2 });
  const secondFirst = defineScenario("Second first", {
    description: "Tries to deliver second before first.",
    run(s) {
      s.act(s.the(Writer), "go");
      s.deliver(s.the(Reader), Second);
    },
  });
  return defineSpec({ name: "Pipe", actors: [Writer, Reader], properties: [inOrder, bothArrive], scenarios: [secondFirst] });
}

/** The checker's states are the reference explorer's worlds, one for one. */
async function agrees(spec: Spec, bounds: Partial<Bounds> = {}): Promise<Report> {
  const worlds = new Set<string>();
  const report = await check(spec, { ...SEARCH, symmetry: false, ...bounds }, [], { watch: { state: (w) => void worlds.add(canonical(w)) } });
  const ref = explore(spec, { depth: Infinity, instances: bounds.instances ?? {} });
  expect(report.exhaustive).toBe(true);
  expect({ states: report.states, worlds: worlds.size }).toEqual({ states: ref.worlds.size, worlds: ref.worlds.size });
  return report;
}

const verdicts = (report: Report) => Object.fromEntries(report.properties.map((p) => [p.id, p.holds ? (p.witness ? `reached in ${p.witness.events.length}` : "holds") : p.unreached ? "never" : `broken in ${p.counterexample.events.length}`]));

test("on a channel that reorders, second can overtake first; on an ordered one, it cannot", async () => {
  expect(verdicts(await agrees(pipe(false)))).toEqual({ inOrder: "broken in 2", bothArrive: "reached in 3" });
  expect(verdicts(await agrees(pipe(true)))).toEqual({ inOrder: "holds", bothArrive: "reached in 3" });
});

test("a loss takes any message, the one behind too, and leaves the rest in order", async () => {
  const spec = pipe(true, { faults: 1 });
  const after = act(spec, initialWorld(spec, { instances: {} }), "writer", "go").world;
  const [first, second] = after.pending;
  expect(stepsTaking(spec, after, first!)).toEqual(["first", "firstLost"]);
  expect(stepsTaking(spec, after, second!)).toEqual(["secondLost"]);
  // Lose first, and second arrives first: the only way it can, here.
  const report = await agrees(spec);
  const inOrder = report.properties.find((p) => p.id === "inOrder")!;
  if (inOrder.holds || inOrder.unreached) throw new Error("inOrder holds");
  expect(inOrder.counterexample.events.map((e) => `${e.actor}.${e.key}`)).toEqual(["Writer.go", "Reader.firstLost", "Reader.second"]);
  expect(report.coverage.reached).toContain("Reader.secondLost");
});

test("a channel is a sender and a receiver: what two senders send may arrive in either order", async () => {
  const Note = defineMessage("Note", { from: String }, { ordered: true });
  const Reader = defineActor({ name: "Reader", zone, singleton: true, initialState: () => ({ got: [] as string[] }), transitions: { note: { on: Note, description: "Writes it down.", run: (s, m) => void s.got.push(m.from) } } });
  const Writer = defineActor({
    name: "Writer",
    zone,
    initialState: () => ({}),
    actions: { go: { with: [atMost(1)], label: "Go", description: "Sends a note.", sends: [Note], run: (_s, _i, ctx) => ctx.send(ctx.the(Reader), Note, { from: ctx.id }) } },
  });
  const spec = defineSpec({
    name: "Notes",
    actors: [Reader, Writer],
    properties: [
      defineProperty("aFirst", { description: "A's note can arrive first.", reachable: (w) => w.the(Reader).state.got.join() === "writer-writer-a,writer-writer-b" }),
      defineProperty("bFirst", { description: "B's note can arrive first.", reachable: (w) => w.the(Reader).state.got.join() === "writer-writer-b,writer-writer-a" }),
    ],
  });
  expect(verdicts(await agrees(spec, { instances: { Writer: 2 } }))).toEqual({ aFirst: "reached in 4", bFirst: "reached in 4" });
});

test("an ordered message is never put back in flight: forward and duplicate are errors", async () => {
  for (const spec of [pipe(true, { forwards: true }), pipe(true, { faults: 1, duplicates: true })]) {
    const report = await check(spec, SEARCH);
    expect(report.errors.map((e) => e.message)).toEqual([expect.stringContaining("forwards first, which is ordered: back in flight, it would arrive behind the ones sent after it")]);
  }
  // On a channel that reorders, both are fine.
  expect((await check(pipe(false, { forwards: true }), SEARCH)).errors).toEqual([]);
});

test("a scenario cannot deliver an ordered message past the one ahead of it", () => {
  const ordered = pipe(true);
  expect(runScenario(ordered, ordered.scenarios[0]!).error).toContain("Reader.second cannot take second now: it is ordered, and first, sent before it, is still in flight ahead of it");
  const reorders = pipe(false);
  expect(runScenario(reorders, reorders.scenarios[0]!).error).toBeUndefined();
});

test("a crash orphans calls where they are: an ordered channel keeps its order through it", async () => {
  // A call, then a plain message, on one channel: the crash changes the call, not the message.
  const Ask = defineCall("Ask", { n: Number }, { ordered: true });
  const Note = defineMessage("Note", {}, { ordered: true });
  const Told = defineMessage("Told", {}, { tone: "reply" });
  const faults = budget("faults", 1);
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({ got: [] as string[] }),
    transitions: {
      ask: { on: Ask, description: "Writes it down, and answers.", sends: [Told], run: (s, _m, ctx) => void (s.got.push("ask"), ctx.reply(Told, {})) },
      note: { on: Note, description: "Writes it down.", run: (s) => void s.got.push("note") },
    },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    initialState: () => ({ told: 0 }),
    actions: {
      go: {
        with: [atMost(1)],
        label: "Go",
        description: "Asks, then sends a note.",
        sends: [Ask, Note],
        run(_s, _i, ctx) {
          ctx.send(ctx.the(Server), Ask, { n: 1 });
          ctx.send(ctx.the(Server), Note, {});
        },
      },
    },
    transitions: {
      told: { on: Told, description: "Counts.", run: (s) => void (s.told += 1) },
      failed: { on: failed(Ask), description: "Gives up.", run: () => {} },
      crash: crash({ spend: faults }),
    },
  });
  const inOrder = defineProperty("inOrder", { description: "The server hears the call before the note.", always: (w) => w.the(Server).state.got[0] !== "note" });
  const spec = defineSpec({ name: "Calls", actors: [Server, Client], properties: [inOrder] });
  const report = await agrees(spec);
  expect(verdicts(report)).toEqual({ inOrder: "holds" });
  expect(report.coverage.reached).toContain("Client.crash");
});

test("symmetry folds senders of ordered messages, and reaches the same verdicts", async () => {
  const Note = defineMessage("Note", { n: Number }, { ordered: true });
  const Reader = defineActor({ name: "Reader", zone, singleton: true, initialState: () => ({ got: 0, last: {} as Record<string, number> }), transitions: { note: { on: Note, description: "Keeps the last from each.", run: (s, m, ctx) => void ((s.got += 1), (s.last[ctx.from!.id] = m.n)) } } });
  const Writer = defineActor({
    name: "Writer",
    zone,
    symmetric: true,
    initialState: () => ({ sent: 0 }),
    actions: { go: { with: [atMost(2)], label: "Go", description: "Sends the next note.", sends: [Note], run: (s, _i, ctx) => void ((s.sent += 1), ctx.send(ctx.the(Reader), Note, { n: s.sent })) } },
  });
  const inOrder = defineProperty("inOrder", { description: "Each writer's notes arrive in order.", everyStep: (before, after) => Object.entries(after.the(Reader).state.last).every(([id, n]) => n >= (before.the(Reader).state.last[id] ?? 0)) });
  const spec = defineSpec({ name: "Notes", actors: [Reader, Writer], properties: [inOrder] });
  const bounds = { ...SEARCH, instances: { Writer: 3 } };
  const plain = await check(spec, { ...bounds, symmetry: false });
  const folded = await check(spec, { ...bounds, symmetry: true });
  expect(plain.states).toBe(explore(spec, { depth: Infinity, instances: { Writer: 3 } }).worlds.size);
  expect(folded.states).toBeLessThan(plain.states);
  expect(folded.reductions.refuted ?? []).toEqual([]);
  expect([verdicts(plain), verdicts(folded)]).toEqual([{ inOrder: "holds" }, { inOrder: "holds" }]);
});

test("a world's key keeps the order on each channel, and only there", () => {
  const spec = pipe(true);
  const world = (order: string[], ordered: boolean): World => ({
    seq: order.length,
    fresh: {},
    rng: 1,
    instances: initialWorld(spec, { instances: {} }).instances,
    pending: order.map((m, i) => ({ id: i + 1, kind: "deliver" as const, to: "reader", from: "writer", message: `message:${m}`, payload: {}, ...(ordered ? { ordered: true as const } : {}) })),
  });
  expect(canonical(world(["First", "Second"], true))).not.toBe(canonical(world(["Second", "First"], true)));
  expect(canonical(world(["First", "Second"], false))).toBe(canonical(world(["Second", "First"], false)));
});

test("ordered is declared on a message, and outOfOrder only on a step on one", () => {
  expect(pipe(true).messages["message:First"]?.ordered).toBe(true);
  expect(pipe(false).messages["message:First"]?.ordered).toBeUndefined();
  expect(() =>
    defineSpec({
      name: "Bad",
      actors: [defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), transitions: { tick: { description: "Ticks.", when: () => true, outOfOrder: true, run: () => {} } } })],
    }),
  ).toThrow("A.tick: outOfOrder is for a step on a message, which may take it with others ahead of it");
});
