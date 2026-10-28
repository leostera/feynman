// The integer core (integer.ts) explores exactly what the classic search does without its
// reductions: the same report, to the counterexample and the loop, on every example and on
// generated specs, with and without symmetry, and from scenario seeds.
import { expect, test } from "bun:test";
import { check, type Bounds, type Report, type Seed } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/cli/shape.ts";
import type { Spec } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";
import { build, describe as describeSpec } from "../fuzz/spec.ts";

const PLAIN = { walks: 0, maxStates: 2_000_000, timeLimit: 120_000, reduce: false, symmetry: false, workers: 0 } as const;

/** A report without the clock. */
const comparable = (r: Report) => ({ ...r, durationMs: 0 });

async function bothAgree(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[] = []): Promise<Report> {
  const integer = await check(spec, { ...PLAIN, ...bounds }, seeds, { engine: "integer" });
  const classic = await check(spec, { ...PLAIN, ...bounds }, seeds, { engine: "classic" });
  expect(comparable(integer)).toEqual(comparable(classic));
  return integer;
}

for (const example of corpus) for (const c of example.cases) {
  const spec = example.spec(c.variant);
  test(`${caseName(example, c)}: the same report from the integer core as from the classic search`, async () => {
    await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {} });
  }, 120_000);
  test(`${caseName(example, c)}, with symmetry: the same report from both`, async () => {
    await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {}, symmetry: true });
  }, 120_000);
  if (spec.scenarios.length)
    test(`${caseName(example, c)}, from its scenarios too: the same report from both`, async () => {
      await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {}, symmetry: true }, scenarioSeeds(spec));
    }, 120_000);
}

test("generated specs: the same report from both", async () => {
  let compared = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const desc = describeSpec(seed);
    const spec = build(desc);
    const report = await bothAgree(spec, { ...desc.bounds, symmetry: seed % 2 === 0 });
    if (report.exhaustive) compared++;
  }
  expect(compared).toBeGreaterThan(40);
}, 300_000);

test("a step that lists instances is not replayed from a world with other instances", async () => {
  const { defineSpec, message } = await import("../../src/spec/index.ts");
  // The coordinator's broadcast reads only its own state, but whom it reaches depends on the
  // replicas there are: a scenario that spawns a third must not reuse the broadcast to two.
  const spec = defineSpec("Broadcast", { messages: { Ping: message<{}>({ name: "ping" }) } }, (s) => {
    const zone = s.defineZone({ name: "z" });
    const Replica = s.defineActor({
      name: "Replica",
      zone,
      initialState: () => ({ pings: 0 }),
      transitions: { [s.messages.Ping]: { description: "Counts it.", run: (state) => void state.pings++ } },
    });
    s.defineActor({
      name: "Coordinator",
      zone,
      singleton: true,
      initialState: () => ({ sent: 0 }),
      actions: {
        ping: {
          label: "Ping",
          description: "Pings every replica.",
          sends: [s.messages.Ping],
          run: (state, _i, ctx) => {
            state.sent++;
            for (const r of ctx.all(Replica)) ctx.send(r, s.messages.Ping, {});
          },
        },
      },
    });
    s.defineProperties({ fewPings: { description: "No replica is pinged twice.", always: (w) => w.all(Replica).every((r) => r.state.pings < 2) } });
    s.defineScenario({ name: "A third replica", setup: (w) => void w.spawn(Replica, "C"), run: () => {} });
  });
  const report = await bothAgree(spec, { depth: 8, repeats: 2, instances: { Replica: 2 } }, scenarioSeeds(spec));
  expect(report.seeds.length).toBe(1);
});
