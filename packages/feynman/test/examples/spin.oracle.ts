// The checker against SPIN on the same systems: the same reachable states, the same verdicts,
// and counterexamples just as short. SPIN is an explicit-state checker of its own, written in
// C, with nothing in common with the checker but the semantics the models follow. Skipped
// when SPIN or a C compiler is not around (`brew install spin`).
import { describe, expect, test } from "bun:test";
import { feynman, HAS_SPIN, spin } from "./oracle.ts";
import { configured, corpus } from "./corpus.ts";

describe.skipIf(!HAS_SPIN)("SPIN oracles", () => {
  for (const example of corpus) {
    const o = example.spin;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, async () => {
        const { spec, bounds } = configured(example.spec(c.variant), { faults: c.faults, instances: example.instances ?? {} });
        const ours = await feynman(spec, bounds);
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        expect(ours.report.exhaustive).toBe(true);
        const theirs = spin(o.model, { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats }, o.invariants);
        expect(ours.distinct).toBe(theirs.states);
        for (const invariant of o.invariants) {
          const p = ours.report.properties.find((x) => x.id === invariant);
          if (!p) throw new Error(`${example.name} has no property ${invariant}`);
          expect({ invariant, events: p.holds ? undefined : p.counterexample.events.length }).toEqual({ invariant, events: theirs.violated[invariant] });
        }
      }, 300_000);
    }
  }
});
