// The checker against Alloy 6 on the same systems: the same verdicts, and counterexamples
// just as short. Alloy finds them by SAT over traces of growing length, not by enumerating
// states, so it shares neither TLC's method nor the checker's. A verdict that an invariant
// holds is only up to the oracle's depth on Alloy's side, so the checker runs to the same
// depth. Skipped when Alloy is not around (ALLOY_JAR, or `brew install alloy-analyzer`).
import { describe, expect, test } from "bun:test";
import { ALLOY_JAR, alloy, feynman } from "./oracle.ts";
import { configured, corpus } from "./corpus.ts";

describe.skipIf(!ALLOY_JAR)("Alloy oracles", () => {
  for (const example of corpus) {
    const o = example.alloy;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, async () => {
        const { spec, bounds } = configured(example.spec(c.variant), { faults: c.faults, instances: example.instances ?? {}, depth: o.depth });
        const ours = await feynman(spec, bounds);
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        const theirs = alloy(o.module, { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats }, o.invariants, o.depth + 1);
        for (const invariant of o.invariants) {
          const p = ours.report.properties.find((x) => x.id === invariant);
          if (!p) throw new Error(`${example.name} has no property ${invariant}`);
          expect({ invariant, events: p.holds ? undefined : p.counterexample.events.length }).toEqual({ invariant, events: theirs[invariant] });
        }
      }, 300_000);
    }
  }
});
