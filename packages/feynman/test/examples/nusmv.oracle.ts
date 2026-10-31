// The checker against NuSMV on the same systems: the same reachable states, the same verdicts,
// counterexamples just as short, and the same liveness verdicts under the same fairness.
// NuSMV computes with sets of states as BDDs rather than one state at a time, so it shares no
// method with the checker, TLC, SPIN or Alloy. Skipped without NuSMV (NUSMV, or on PATH).
import { describe, expect, test } from "bun:test";
import { feynman, NUSMV, nusmv } from "./oracle.ts";
import { configured, corpus } from "./corpus.ts";

describe.skipIf(!NUSMV)("NuSMV oracles", () => {
  for (const example of corpus) {
    const o = example.nusmv;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, async () => {
        const { spec, bounds } = configured(example.spec(c.variant), { faults: c.faults, instances: example.instances ?? {} });
        const ours = await feynman(spec, bounds);
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        expect(ours.report.exhaustive).toBe(true);
        const theirs = nusmv(o.model, { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats }, o.invariants, o.liveness);
        expect(ours.distinct).toBe(theirs.states);
        const property = (id: string) => {
          const p = ours.report.properties.find((x) => x.id === id);
          if (!p) throw new Error(`${example.name} has no property ${id}`);
          return p;
        };
        for (const invariant of o.invariants) {
          const p = property(invariant);
          expect({ invariant, events: p.holds ? undefined : p.counterexample.events.length }).toEqual({ invariant, events: theirs.violated[invariant] });
        }
        for (const id of o.liveness ?? []) {
          const p = property(id);
          expect({ id, broken: !p.holds, unfinished: p.holds && !!p.unfinished }).toEqual({ id, broken: theirs.broken[id], unfinished: false });
        }
      }, 300_000);
    }
  }
});
