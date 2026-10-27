// The checker against TLC on the same systems: the same reachable states, the same verdicts,
// and counterexamples just as short. Skipped when tla2tools.jar is not around (TLA_TOOLS_JAR).
import { describe, expect, test } from "bun:test";
import { feynman, TLA_JAR, tlc } from "./oracle.ts";
import { corpus } from "./corpus.ts";

describe.skipIf(!TLA_JAR)("TLC oracles", () => {
  for (const example of corpus) {
    const o = example.tla;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, () => {
        const constants = { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats, ...(o.depth ? { Depth: o.depth } : {}) };
        const view = o.depth ? { view: "view" } : {};
        const ours = feynman(example.spec(c.variant), { faults: c.faults, repeats: c.repeats, instances: example.instances ?? {}, ...(o.depth ? { depth: o.depth } : {}) });
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        if (!o.depth) expect(ours.report.exhaustive).toBe(true);
        // The same reachable states.
        expect(ours.distinct).toBe(tlc(o.module, constants, [], view).distinct);
        // The same verdict on each invariant, and counterexamples just as short.
        for (const invariant of o.invariants) {
          const theirs = tlc(o.module, constants, [invariant], view).violated;
          const p = ours.report.properties.find((x) => x.id === invariant);
          if (!p) throw new Error(`${example.name} has no property ${invariant}`);
          expect({ invariant, broken: !p.holds, events: p.counterexample?.events.length }).toEqual({ invariant, broken: !!theirs, events: theirs?.events });
        }
      }, 300_000);
    }
  }
});
