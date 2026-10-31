// The checker against Quint specs checked by Apalache: the same verdicts, and counterexamples
// just as short. Apalache works by SMT (Z3), unrolling a step at a time, so it shares no method
// with the checker or the other oracles. A verdict that an invariant holds is only up to the
// oracle's depth, so the checker runs to the same depth. Skipped without Quint and a Java
// (`brew install quint openjdk`); Quint fetches Apalache the first time.
import { describe, expect, test } from "bun:test";
import { feynman, HAS_QUINT, quint } from "./oracle.ts";
import { configured, corpus } from "./corpus.ts";

describe.skipIf(!HAS_QUINT)("Quint oracles", () => {
  for (const example of corpus) {
    const o = example.quint;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, async () => {
        const { spec, bounds } = configured(example.spec(c.variant), { faults: c.faults, instances: example.instances ?? {}, depth: o.depth });
        const ours = await feynman(spec, bounds);
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        const theirs = quint(o.module, { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats }, o.invariants, o.depth);
        for (const invariant of o.invariants) {
          const p = ours.report.properties.find((x) => x.id === invariant);
          if (!p) throw new Error(`${example.name} has no property ${invariant}`);
          expect({ invariant, events: p.holds ? undefined : p.counterexample.events.length }).toEqual({ invariant, events: theirs[invariant] });
        }
      }, 300_000);
    }
  }
});
