// A search stopped by its state or time limit says how far it got in full: every path of up to
// `upTo` events. Checking with that depth bound must then finish, within the states the stopped
// search had already found: that is what makes "held on every path of up to N events" true.
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
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
