import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import remoteAccess from "../spec/fixtures/remote-access.ts";

test("with one fault, a Mac given a valid code can end up never linked, and the checker shows how", () => {
  const report = check(remoteAccess, { depth: 12, faults: 1, maxStates: 100_000 });
  const byId = Object.fromEntries(report.properties.map((p) => [p.id, p]));
  expect(byId.relayNeverStoresSecrets.holds).toBe(true);
  expect(byId.codeRedeemedOnce.holds).toBe(true);
  const links = byId.macWithValidCodeLinks;
  expect(links.holds).toBe(false);
  const example = links.counterexample!;
  // It takes a lost message…
  expect(example.events.some((e) => e.kind === "lose")).toBe(true);
  // …after which the system, left alone, never links the Mac. (The shortest such path:
  // a stale "refused" for an earlier attempt clears the pending link of the later one.)
  const end = links.then!.at(-1) ?? example.events.at(-1)!;
  expect(end.key).toBe("message:Refused");
  expect(report.errors).toEqual([]);
});

test("without faults, every redemption gets its answer and the property holds", { timeout: 30_000 }, () => {
  const report = check(remoteAccess, { depth: 10, faults: 0, maxStates: 100_000 });
  expect(report.properties.every((p) => p.holds)).toBe(true);
  expect(report.states).toBeGreaterThan(10);
  expect(report.coverage.reached).toContain("Axo relay.message:Redeem");
});

test("counterexamples replay: the same choices give the same events", () => {
  const report = check(remoteAccess, { depth: 12, faults: 1, maxStates: 100_000 });
  const example = report.properties.find((p) => !p.holds)!.counterexample!;
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
    spec.defineInvariants({ belowFive: { description: "Never reaches five.", always: (w) => w.all(Counter).every((c) => c.state.n < 5) } });
    spec.defineScenario({ name: "Count to four", run: (s) => { const c = s.spawn(Counter, "c"); for (let i = 0; i < 4; i++) s.act(c, "up"); } });
  });
  const bounds = { depth: 2, repeats: 9, walks: 0 };
  expect(check(deep, bounds).properties[0].holds).toBe(true);
  const run = runScenario(deep, deep.scenarios[0]);
  const seeded = check(deep, bounds, [{ name: "Count to four", world: run.worlds.at(-1)! }]);
  expect(seeded.properties[0].holds).toBe(false);
  expect(seeded.properties[0].counterexample?.from).toBe("Count to four");
  expect(seeded.properties[0].counterexample?.events.length).toBe(1);
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
    spec.defineInvariants({ belowFive: { description: "Never reaches five.", always: (w) => w.all(Counter).every((c) => c.state.n < 5) } });
  });
  const report = check(deep, { depth: 2, repeats: 20, walks: 50 });
  const p = report.properties[0];
  expect(p.holds).toBe(false);
  expect(p.foundBy).toBe("walk");
  // Shrunk to the five steps it takes, without the fidgeting.
  expect(p.counterexample!.events.map((e) => e.key)).toEqual(["up", "up", "up", "up", "up"]);
  expect(report.walks.runs).toBeGreaterThan(0);
});

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
      spec.defineInvariants({ answered: { description: "Never more answers than pings.", always: (w) => w.all(Client).every((c) => c.state.got <= c.state.sent) } });
    },
  );
  const bounds = { depth: 10, faults: 1, repeats: 2, instances: { Client: 2 }, symmetry: false, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  const plain = check(pings, { ...bounds, reduce: false });
  const reduced = check(pings, { ...bounds, reduce: true });
  expect(plain.errors).toEqual([]);
  expect(plain.exhaustive && reduced.exhaustive).toBe(true);
  expect(reduced.states).toBe(plain.states);
  expect(reduced.coverage).toEqual(plain.coverage);
  expect(reduced.reductions.orders).toBeGreaterThan(0);
});

test("the reductions keep the verdicts and the states on a spec with timers and retries", () => {
  const bounds = { depth: 8, faults: 1, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  const plain = check(remoteAccess, { ...bounds, reduce: false });
  const reduced = check(remoteAccess, { ...bounds, reduce: true });
  expect(reduced.properties.map((p) => p.holds)).toEqual(plain.properties.map((p) => p.holds));
  expect(reduced.coverage).toEqual(plain.coverage);
  expect(reduced.states).toBe(plain.states);
}, 30_000);

test("symmetry: two interchangeable Macs explore fewer states, with the same verdicts", () => {
  const bounds = { depth: 7, faults: 0, instances: { Mac: 2 }, maxStates: 1_000_000, timeLimit: 60_000, walks: 0 };
  const plain = check(remoteAccess, { ...bounds, symmetry: false });
  const folded = check(remoteAccess, { ...bounds, symmetry: true });
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
  const report = check(typed, { depth: 1, walks: 0 });
  // loud is read, note is not: of the four combinations, the two that differ only in the note are one.
  expect(report.reductions.inputs).toBe(2);
});
