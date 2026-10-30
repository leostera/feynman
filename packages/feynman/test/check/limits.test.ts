// A search stopped by its state or time limit says how far it got in full: every path of up to
// `upTo` events. Checking with that depth bound must then finish, within the states the stopped
// search had already found: that is what makes "held on every path of up to N events" true.
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { defineActor, defineProperty, defineZone } from "../../src/spec/index.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";

for (const engine of ["integer", "classic"] as const) {
  test(`${engine}: a stopped search held its properties on every path up to its complete depth`, async () => {
    const spec = twoPhaseCommit("fixed");
    const bounds = { depth: 30, faults: 1, repeats: 2, walks: 0, reduce: false, symmetry: false, workers: 0, instances: { Participant: 2 } };
    const stopped = await check(spec, { ...bounds, maxStates: 120 }, [], { engine });
    expect(stopped.stoppedBy).toBe("maxStates");
    const held = stopped.properties.find((p) => p.id === "atomic")!;
    if (!held.holds) throw new Error("atomic should hold");
    expect(held.upTo).toBeGreaterThan(0);
    const within = await check(spec, { ...bounds, depth: held.upTo!, maxStates: 1_000_000 }, [], { engine });
    expect(within.exhaustive).toBe(true);
    expect(within.states).toBeLessThanOrEqual(stopped.states);
  }, 60_000);
}

for (const engine of ["integer", "classic"] as const) {
  test(`${engine}: a search past its memory limit stops and keeps its verdicts`, async () => {
    const { defineSpec } = await import("../../src/spec/index.ts");
    // Two counters that climb on their own: 10,000 states, more than one memory reading apart.
    const spec = (() => {

      const zone = defineZone({ name: "z" });
      const Counter = defineActor({
        name: "Counter",
        zone,
        singleton: true,
        initialState: () => ({ a: 0, b: 0 }),
        actions: {
          a: { label: "A", description: "Counts a.", when: (s) => s.a < 99, run: (s) => void s.a++ },
          b: { label: "B", description: "Counts b.", when: (s) => s.b < 99, run: (s) => void s.b++ },
        },
      });

      const small = defineProperty("small", { description: "Never past 99.", always: (w) => w.the(Counter).state.a < 100 });
      return defineSpec({
        name: "Counters",
        actors: [Counter],
        properties: [small],
      });
    })();
    const report = await check(spec, { depth: 400, repeats: 1000, walks: 0, reduce: false, symmetry: false, workers: 0, memoryLimit: 1 }, [], { engine });
    expect(report.stoppedBy).toBe("memoryLimit");
    expect(report.states).toBeLessThan(10_000);
    expect(report.properties[0]).toMatchObject({ id: "small", holds: true });
    if (engine === "integer") {
      // What the states differ in: the two counters, each in many values; nothing in flight.
      expect(report.variety?.map((v) => v.what).sort()).toEqual(["Counter.a", "Counter.b"]);
      expect(report.variety![0].values).toBeGreaterThan(20);
      expect(report.mostInFlight).toBe(0);
    }
  }, 60_000);
}
