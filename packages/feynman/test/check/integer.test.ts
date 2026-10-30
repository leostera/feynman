// The search's own guarantees, besides agreeing with the reference explorer on the corpus
// (reference.test.ts) and keeping its verdicts under symmetry (examples.test.ts): scenario
// seeds explore what the reference explores from the same worlds, a step cached in one world
// is not replayed in a world with other instances, and a search cut short keeps what it found.
import { expect, test } from "bun:test";
import { check, type PropertyResult } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineZone } from "../../src/spec/index.ts";
import { caseName, configured, corpus } from "../examples/corpus.ts";
import { agreesWithReference } from "./agree.ts";

const PLAIN = { walks: 0, maxStates: 2_000_000, timeLimit: 120_000, symmetry: false } as const;

/** What a verdict says, without the path: held, or broken in so many events. */
const said = (p: PropertyResult) => [p.id, p.holds ? (p.unfinished ? "unfinished" : "holds") : p.counterexample.events.length + (p.loop?.events.length ?? 0)];

for (const example of corpus) for (const c of example.cases) {
  const { spec } = configured(example.spec(c.variant), { faults: c.bounds.faults ?? 0 });
  const bounds = { depth: c.bounds.depth ?? 60, instances: example.instances ?? {} };
  if (spec.scenarios.length)
    test(`${caseName(example, c)}, from its scenarios too: what the reference explores from the same worlds`, async () => {
      await agreesWithReference(spec, bounds, scenarioSeeds(spec));
    }, 300_000);
}

test("a step that lists instances is not replayed from a world with other instances", async () => {
  const { defineSpec } = await import("../../src/spec/index.ts");
  // The coordinator's broadcast reads only its own state, but whom it reaches depends on the
  // replicas there are: a scenario that spawns a third must not reuse the broadcast to two.
  const spec = (() => {
    const Ping = defineMessage("Ping");
    const zone = defineZone({ name: "z" });
    const Replica = defineActor({
      name: "Replica",
      zone,
      initialState: () => ({ pings: 0 }),
      transitions: { ping: { on: Ping, description: "Counts it.", run: (state) => void state.pings++ } },
    });
    const CoordinatorActor = defineActor({
      name: "Coordinator",
      zone,
      singleton: true,
      initialState: () => ({ sent: 0 }),
      actions: {
        ping: {
          label: "Ping",
          description: "Pings every replica.",
          with: [atMost(2)],
          sends: [Ping],
          run: (state, _i, ctx) => {
            state.sent++;
            for (const r of ctx.all(Replica)) ctx.send(r, Ping, {});
          },
        },
      },
    });

    const fewPings = defineProperty("fewPings", { description: "No replica is pinged twice.", always: (w) => w.all(Replica).every((r) => r.state.pings < 2) });

    const aThirdReplica = defineScenario("A third replica", { setup: (w) => void w.spawn(Replica, "C"), run: () => {} });
    return defineSpec({
      name: "Broadcast",
      actors: [Replica, CoordinatorActor],
      properties: [fewPings],
      scenarios: [aThirdReplica],
    });
  })();
  const report = await agreesWithReference(spec, { depth: 8, instances: { Replica: 2 } }, scenarioSeeds(spec));
  expect(report.seeds.length).toBe(1);
});

test("cut off by maxStates: it stops there, and what it found broken is broken as in the full search", async () => {
  for (const name of ["two-phase commit", "read repair", "leader election", "job queue", "quorum"]) {
    const example = corpus.find((e) => e.name === name)!;
    for (const c of example.cases) {
      const { spec } = configured(example.spec(c.variant), { faults: c.bounds.faults ?? 0 });
      const bounds = { ...PLAIN, depth: c.bounds.depth ?? 60, instances: example.instances ?? {} };
      const full = await check(spec, bounds);
      const cut = await check(spec, { ...bounds, maxStates: Math.max(1, Math.floor(full.states / 3)) });
      expect(cut.stoppedBy).toBe("maxStates");
      // Breadth first: a break found before the cut is the full search's shortest one.
      for (const p of cut.properties.filter((q) => !q.holds && !q.loop)) expect(said(full.properties.find((q) => q.id === p.id)!)).toEqual(said(p));
    }
  }
}, 300_000);
