// The checker against TLC on the same systems: the same reachable states, the same verdicts,
// and counterexamples just as short. Skipped when tla2tools.jar is not around (TLA_TOOLS_JAR).
import { describe, expect, test } from "bun:test";
import { feynman, TLA_JAR, tlc } from "./oracle.ts";
import { configured, corpus } from "./corpus.ts";

describe.skipIf(!TLA_JAR)("TLC oracles", () => {
  for (const example of corpus) {
    const o = example.tla;
    if (!o) continue;
    for (const c of o.configs) {
      test(`${example.name}, ${c.variant}, ${c.faults} fault(s)`, async () => {
        const constants = { Buggy: c.variant === "buggy", Faults: c.faults, Repeats: c.repeats, ...(o.depth ? { Depth: o.depth } : {}) };
        const view = o.depth ? { view: "view" } : {};
        const { spec, bounds } = configured(example.spec(c.variant), { faults: c.faults, instances: example.instances ?? {}, ...(o.depth ? { depth: o.depth } : {}) });
        const ours = await feynman(spec, bounds);
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        // Without a depth, as by default, the search finds every world, as TLC does. With one
        // (systems that never run out of things to do), the bound cuts paths off, and an
        // invariant that held there is not proved: unfinished, held up to the depth.
        expect({ exhaustive: ours.report.exhaustive, cut: ours.report.cutAtDepth === true }).toEqual({ exhaustive: true, cut: !!o.depth });
        for (const p of ours.report.properties) if (o.depth && p.holds && o.invariants.includes(p.id)) expect({ id: p.id, upTo: p.upTo }).toEqual({ id: p.id, upTo: o.depth });
        // The same reachable states.
        expect(ours.distinct).toBe(tlc(o.module, constants, [], view).distinct);
        // The same verdict on each invariant, and counterexamples just as short.
        for (const invariant of o.invariants) {
          const theirs = tlc(o.module, constants, [invariant], view).violated;
          const p = ours.report.properties.find((x) => x.id === invariant);
          if (!p) throw new Error(`${example.name} has no property ${invariant}`);
          expect({ invariant, broken: !p.holds, events: p.holds || p.unreached ? undefined : p.counterexample.events.length }).toEqual({ invariant, broken: !!theirs, events: theirs?.events });
        }
        // The same verdict on each reachable property, and a way there just as short: TLC's
        // shortest counterexample to the invariant that it is never reached.
        for (const id of o.reachable ?? []) {
          const theirs = tlc(o.module, constants, [`${id}Never`], view).violated;
          const p = ours.report.properties.find((x) => x.id === id);
          if (!p || p.kind !== "reachable") throw new Error(`${example.name} has no reachable property ${id}`);
          expect({ id, reached: p.holds && p.witness ? p.witness.events.length : undefined }).toEqual({ id, reached: theirs?.events });
        }
        // The same verdict on each liveness property, under the same fairness.
        for (const property of o.liveness ?? []) {
          const theirs = tlc(o.module, constants, [], { temporal: { specification: "FairSpec", properties: [property] } }).temporal;
          const p = ours.report.properties.find((x) => x.id === property);
          if (!p) throw new Error(`${example.name} has no property ${property}`);
          expect({ property, broken: !p.holds, unfinished: p.holds && !!p.unfinished }).toEqual({ property, broken: !!theirs, unfinished: false });
        }
      }, 300_000);
    }
  }
});
