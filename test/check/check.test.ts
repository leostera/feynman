import { expect, test } from "bun:test";
import { broken } from "../helpers.ts";
import { check } from "../../src/check/index.ts";
import { isLiveness } from "../../src/spec/index.ts";
import remoteAccess from "../spec/fixtures/remote-access.ts";

/**
 * These tests read the search's shortest counterexample, so nothing may depend on how fast the
 * machine is: no random runs (they have a time share, and may report the bug first), and a
 * time limit the search never meets, even on a machine busy building (as before publishing).
 */
const UNTIMED = { walks: 0, timeLimit: 600_000 };

/** One fault, explored once and shared: the slowest check here. */
let oneFault: ReturnType<typeof check> | undefined;
const withOneFault = () => (oneFault ??= check(remoteAccess, { depth: 12, faults: 1, maxStates: 100_000, ...UNTIMED }));

test("with one fault, a Mac given a valid code can end up never linked, and the checker shows how", async () => {
  const report = await withOneFault();
  const byId = Object.fromEntries(report.properties.map((p) => [p.id, p]));
  expect(byId.relayNeverStoresSecrets.holds).toBe(true);
  expect(byId.codeRedeemedOnce.holds).toBe(true);
  const links = broken(byId.macWithValidCodeLinks);
  const example = links.counterexample;
  // It takes a lost message…
  expect(example.events.some((e) => e.kind === "lose")).toBe(true);
  // …after which no fair behaviour links the Mac.
  expect(links.loop).toBeDefined();
  expect(report.errors).toEqual([]);
});

test("without faults, every redemption gets its answer and the property holds", { timeout: 30_000 }, async () => {
  const report = await check(remoteAccess, { depth: 10, faults: 0, maxStates: 100_000, ...UNTIMED });
  expect(report.properties.every((p) => p.holds)).toBe(true);
  expect(report.states).toBeGreaterThan(10);
  expect(report.coverage.reached).toContain("Axo relay.message:Redeem");
});

test("counterexamples replay: the same choices give the same events", async () => {
  const report = await withOneFault();
  const example = report.properties.find((p) => !p.holds)!.counterexample;
  expect(example.events.length).toBe(example.choices.length);
  expect(example.worlds.length).toBe(example.choices.length);
  expect(example.events.every((e) => !e.error)).toBe(true);
});

test("seeds: exploring from where a scenario ends reaches what the depth alone does not", async () => {
  const { defineSpec, message, runScenario } = await import("../../src/spec/index.ts");
  const { check } = await import("../../src/check/index.ts");
  const deep = defineSpec("Deep", { messages: { Tick: message<{}>({ name: "tick" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "z" });
    const Counter = spec.defineActor({
      name: "Counter",
      zone,
      initialState: () => ({ n: 0 }),
      actions: { up: { label: "Up", description: "Counts up.", run: (s) => void (s.n += 1) } },
    });
    spec.defineProperties({ belowFive: { description: "Never reaches five.", always: (w) => w.all(Counter).every((c) => c.state.n < 5) } });
    spec.defineScenario({ name: "Count to four", run: (s) => { const c = s.spawn(Counter, "c"); for (let i = 0; i < 4; i++) s.act(c, "up"); } });
  });
  const bounds = { depth: 2, repeats: 9, walks: 0 };
  expect((await check(deep, bounds)).properties[0].holds).toBe(true);
  const run = runScenario(deep, deep.scenarios[0]);
  const seeded = await check(deep, bounds, [{ scenario: "Count to four", at: "end", world: run.worlds.at(-1)! }]);
  const fromSeed = broken(seeded.properties[0]);
  expect(fromSeed.counterexample.from).toEqual({ scenario: "Count to four", at: "end" });
  expect(fromSeed.counterexample.events.length).toBe(1);
});

test("random runs go deeper than the search, and their counterexample is shrunk", async () => {
  const { defineSpec, message } = await import("../../src/spec/index.ts");
  const deep = defineSpec("Deep", { messages: { Tick: message<{}>({ name: "tick" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "z" });
    const Counter = spec.defineActor({
      name: "Counter",
      zone,
      initialState: () => ({ n: 0, noise: 0 }),
      actions: {
        up: { label: "Up", description: "Counts up.", run: (s) => void (s.n += 1) },
        fidget: { label: "Fidget", description: "Changes nothing that matters.", run: (s) => void (s.noise = 1 - s.noise) },
      },
    });
    spec.defineProperties({ belowFive: { description: "Never reaches five.", always: (w) => w.all(Counter).every((c) => c.state.n < 5) } });
  });
  const report = await check(deep, { depth: 2, repeats: 20, walks: 50 });
  const p = broken(report.properties[0]);
  expect(p.foundBy).toBe("walk");
  // Shrunk to the five steps it takes, without the fidgeting.
  expect(p.counterexample.events.map((e) => e.key)).toEqual(["up", "up", "up", "up", "up"]);
  expect(report.walks.runs).toBeGreaterThan(0);
});

/** The classic search's reductions, which the integer core does without. */
const CLASSIC = { engine: "classic" } as const;

test("the reductions skip work, never states: exactly the states of the plain search", async () => {
  const { defineSpec, message } = await import("../../src/spec/index.ts");
  // Clients ping a server and count the answers; a log hears about every answer. Many steps
  // commute, so sleep sets skip many orders, and the state counts must still match.
  const pings = defineSpec(
    "Pings",
    { messages: { Ping: message<{ n: number }>({ name: "ping" }), Pong: message<{ n: number }>({ name: "pong" }), Note: message<{ n: number }>({ name: "note" }) } },
    (spec) => {
      const { Ping, Pong, Note } = spec.messages;
      const zone = spec.defineZone({ name: "z" });
      const Log = spec.defineActor({ name: "Log", zone, singleton: true, initialState: () => ({ seen: 0 }), transitions: { [Note]: { description: "Counts.", run: (s) => void (s.seen += 1) } } });
      const Server = spec.defineActor({
        name: "Server",
        zone,
        singleton: true,
        initialState: () => ({ served: 0 }),
        transitions: {
          [Ping]: {
            description: "Answers.",
            sends: [Pong, Note],
            run: (s, msg, ctx) => {
              s.served += 1;
              ctx.reply(Pong, { n: msg.n });
              ctx.send(ctx.the(Log), Note, { n: msg.n });
            },
          },
        },
      });
      const Client = spec.defineActor({
        name: "Client",
        zone,
        initialState: () => ({ sent: 0, got: 0 }),
        actions: { ping: { label: "Ping", description: "Pings.", sends: [Ping], run: (s, _i, ctx) => ((s.sent += 1), ctx.send(ctx.the(Server), Ping, { n: s.sent })) } },
        transitions: { [Pong]: { description: "Counts.", run: (s) => void (s.got += 1) } },
      });
      spec.defineProperties({ answered: { description: "Never more answers than pings.", always: (w) => w.all(Client).every((c) => c.state.got <= c.state.sent) } });
    },
  );
  const bounds = { depth: 10, faults: 1, repeats: 2, instances: { Client: 2 }, symmetry: false, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  const plain = await check(pings, { ...bounds, reduce: false }, [], CLASSIC);
  const reduced = await check(pings, { ...bounds, reduce: true }, [], CLASSIC);
  expect(plain.errors).toEqual([]);
  expect(plain.exhaustive && reduced.exhaustive).toBe(true);
  expect(reduced.states).toBe(plain.states);
  expect(reduced.coverage).toEqual(plain.coverage);
  expect(reduced.reductions.orders).toBeGreaterThan(0);
});

test("the reductions keep the verdicts and the states on a spec with timers and retries", async () => {
  const bounds = { depth: 8, faults: 1, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  const plain = await check(remoteAccess, { ...bounds, reduce: false }, [], CLASSIC);
  const reduced = await check(remoteAccess, { ...bounds, reduce: true }, [], CLASSIC);
  expect(reduced.properties.map((p) => p.holds)).toEqual(plain.properties.map((p) => p.holds));
  expect(reduced.coverage).toEqual(plain.coverage);
  expect(reduced.states).toBe(plain.states);
}, 30_000);

test("symmetry: two interchangeable Macs explore fewer states, with the same verdicts", async () => {
  const bounds = { depth: 7, faults: 0, instances: { Mac: 2 }, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  // Symmetry is off for liveness. This spec has `never` properties too, so its safety and its
  // liveness are judged in searches of their own, and the safety search folds.
  const safety = { ...remoteAccess, properties: remoteAccess.properties.filter((p) => !isLiveness(p)) };
  expect((await check(remoteAccess, { ...bounds, symmetry: true })).reductions.symmetric).toEqual([["Mac A", "Mac B"]]);
  const plain = await check(safety, { ...bounds, symmetry: false });
  const folded = await check(safety, { ...bounds, symmetry: true });
  expect(folded.reductions.symmetric).toEqual([["Mac A", "Mac B"]]);
  expect(folded.states).toBeLessThan(plain.states);
  expect(folded.properties.map((p) => p.holds)).toEqual(plain.properties.map((p) => p.holds));
  expect(folded.coverage).toEqual(plain.coverage);
});

test("inputs an action never reads are not tried twice", async () => {
  const { defineSpec, message } = await import("../../src/spec/index.ts");
  const typed = defineSpec("Typed", { messages: { Tick: message<{}>({ name: "tick" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "z" });
    const Box = spec.defineActor({
      name: "Box",
      zone,
      initialState: () => ({ open: false }),
      actions: {
        open: {
          label: "Open",
          description: "Opens the box; the note is ignored.",
          inputs: { note: { type: String }, loud: { type: Boolean } },
          run: (s, input) => void (s.open = input.loud || true),
        },
      },
    });
    void Box;
  });
  const report = await check(typed, { depth: 1, walks: 0 }, [], CLASSIC);
  // loud is read, note is not: of the four combinations, the two that differ only in the note are one.
  expect(report.reductions.inputs).toBe(2);
});

test("a map that gained its entries in another order is the same state, renamed too", async () => {
  const { gCounter } = await import("../../examples/g-counter.ts");
  const bounds = { depth: 10, faults: 0, walks: 0, instances: { Replica: 2 } };
  const plain = await check(gCounter("fixed"), { ...bounds, symmetry: false });
  const folded = await check(gCounter("fixed"), bounds);
  // Replica A's counts can be {A, B} or {B, A} depending on what came first; they are one state.
  expect(plain.states).toBe(104);
  expect(folded.reductions.refuted).toBeUndefined();
  expect(folded.states).toBeLessThan(plain.states);
});

test("states that hold different sets or maps are different states, and changing one is a change", async () => {
  const { defineSpec } = await import("../../src/spec/index.ts");
  // Picking 7 is the bug. Plain JSON writes every set and map as {}, which made picking 1 and
  // picking 7 one state, so the 7 was never judged.
  const spec = defineSpec("sets", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Z" });
    const Picker = spec.defineActor({
      name: "Picker",
      singleton: true,
      zone,
      initialState: () => ({ picked: new Set<number>(), counts: new Map<number, number>(), done: false, sawSeven: false }),
      actions: {
        pick: {
          label: "Pick",
          description: "Picks a number.",
          when: (state) => !state.done,
          inputs: { n: { type: [1, 7] as const } },
          run(state, inputs) {
            state.done = true;
            state.picked.add(inputs.n);
            state.counts.set(inputs.n, 1);
          },
        },
        look: { label: "Look", description: "Looks at what it picked.", when: (state) => state.done, run: (state) => void (state.sawSeven = state.picked.has(7) && state.counts.has(7)) },
      },
    });
    spec.defineProperties({ neverSeven: { description: "It never sees a 7.", always: (w) => !w.the(Picker).state.sawSeven } });
    return { Picker };
  });
  const report = await check(spec, { depth: 4, walks: 0 });
  const neverSeven = broken(report.properties[0]);
  const pick = neverSeven.counterexample.events.find((e) => e.key === "pick")!;
  expect(pick.changes.map((c) => c.path).sort()).toEqual(["counts", "done", "picked"]);
});

test("a step that fails is reported, and a step is reached, even when its state was seen before", async () => {
  const { defineSpec } = await import("../../src/spec/index.ts");
  // `poke` is a guarded step, which no counter tells apart, and it throws, which changes
  // nothing: its state is its parent's. Judging only new states missed both the error and
  // the step itself.
  const spec = defineSpec("errors", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Z" });
    const Counter = spec.defineActor({
      name: "Counter",
      singleton: true,
      zone,
      initialState: () => ({ n: 0 }),
      actions: { inc: { label: "Inc", description: "Counts one.", when: (state) => state.n < 1, run: (state) => void (state.n += 1) } },
      transitions: {
        poke: {
          description: "Fails at one.",
          when: (state) => state.n === 1,
          run() {
            throw new Error("boom");
          },
        },
      },
    });
    return { Counter };
  });
  for (const reduce of [false, true]) {
    const report = await check(spec, { depth: 4, walks: 0, reduce });
    expect(report.errors.map((e) => e.message)).toEqual(["Counter.poke: boom"]);
    expect(report.coverage.missed).toEqual([]);
  }
});

test("a step that stores what is not plain data, or changes another's set, fails and says why", async () => {
  const { defineSpec } = await import("../../src/spec/index.ts");
  const spec = defineSpec("plain", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Z" });
    const Keeper = spec.defineActor({
      name: "Keeper",
      singleton: true,
      zone,
      initialState: () => ({ seen: new Set<string>(), handler: null as unknown }),
      actions: {
        store: { label: "Store", description: "Stores a function.", run: (state) => void (state.handler = () => 1) },
        reach: {
          label: "Reach",
          description: "Adds to another's set.",
          run: (_state, _inputs, ctx) => void ctx.the(Other).state.seen.add("x"),
        },
      },
    });
    const Other = spec.defineActor({ name: "Other", singleton: true, zone, initialState: () => ({ seen: new Set<string>() }) });
    return { Keeper, Other };
  });
  const report = await check(spec, { depth: 2, walks: 0 });
  const messages = report.errors.map((e) => e.message).sort();
  expect(messages).toHaveLength(2);
  expect(messages[0]).toContain("Keeper.reach: changes the state of another instance");
  expect(messages[1]).toContain("Keeper.store: holds state.handler: a function, which is not plain data");
});

test("symmetry claims are tested on as many merged states as symmetryChecks says; 0 trusts them", async () => {
  const { leaderElection } = await import("../../examples/leader-election.ts");
  // The fixed nodes elect the highest id, so they are not interchangeable: a wrong claim.
  const spec = leaderElection("fixed");
  const safety = { ...spec, properties: spec.properties.filter((p) => !isLiveness(p)) };
  const bounds = { depth: 12, faults: 0, walks: 0, instances: { Node: 3 } };
  expect((await check(safety, bounds)).reductions.refuted).toEqual(["Node"]);
  expect((await check(safety, { ...bounds, symmetryChecks: 10 })).reductions.refuted).toEqual(["Node"]);
  const trusted = await check(safety, { ...bounds, symmetryChecks: 0 });
  expect(trusted.reductions.refuted).toBeUndefined();
  expect(trusted.reductions.symmetric).toEqual([["Node A", "Node B", "Node C"]]);
});

test("setup: the checker explores from the world a scenario sets up, and a property it breaks is reported from there", async () => {
  const { defineSpec, message } = await import("../../src/spec/index.ts");
  const spec = defineSpec("Ledger", { messages: { Publish: message<{ seq: number }>({ name: "publish" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const Ledger = s.defineActor({
      name: "Ledger",
      zone,
      singleton: true,
      initialState: () => ({ seq: 0 }),
      transitions: { [s.messages.Publish]: { description: "Moves on.", run: (state, msg) => void (state.seq = msg.seq) } },
    });
    const Writer = s.defineActor({
      name: "Writer",
      zone,
      singleton: true,
      initialState: () => ({ next: 1 }),
      actions: { publish: { label: "Publish", description: "Publishes the next one.", sends: [s.messages.Publish], run: (state, _i, ctx) => ctx.send(ctx.the(Ledger), s.messages.Publish, { seq: state.next++ }) } },
    });
    s.defineProperties({ belowTen: { description: "The ledger stays below ten.", always: (w) => w.the(Ledger).state.seq < 10 } });
    // From the spec's start, two publishes (repeats) never get near ten; from here, one does.
    s.defineScenario({ name: "Nine published", setup: (w) => (w.set(Ledger, { seq: 9 }), w.set(Writer, { next: 10 })), run: () => {} });
  });
  const { scenarioSeeds } = await import("../../src/cli/shape.ts");
  const bounds = { depth: 6, walks: 0 };
  expect((await check(spec, bounds)).properties[0].holds).toBe(true);
  const seeds = scenarioSeeds(spec);
  // Its run does nothing, so it ends where it starts: one world to explore from.
  expect(seeds.map(({ scenario, at }) => `${scenario} ${at}`)).toEqual(["Nine published start"]);
  const report = await check(spec, bounds, seeds);
  expect(report.seeds).toEqual([{ scenario: "Nine published", at: "start" }]);
  const ce = broken(report.properties[0]).counterexample;
  expect(ce.from).toEqual({ scenario: "Nine published", at: "start" });
  expect(ce.events.map((e) => e.key)).toEqual(["publish", "message:Publish"]);
});
