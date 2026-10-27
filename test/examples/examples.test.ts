// The corpus: well-known systems whose bugs, and the shortest way to them, were worked out by
// hand. The checker must find exactly those, accept the fixes, and reach the same verdicts
// whichever way it explores: with or without its reductions, with or without symmetry, and
// by random runs alone.
import { describe, expect, test } from "bun:test";
import { check, replay, type Report } from "../../src/check/index.ts";
import { caseName, corpus, type Expected } from "./corpus.ts";

const EXHAUSTIVE = { maxStates: 2_000_000, timeLimit: 120_000, walks: 0 };

/** What a report says about each expected property, in the terms of `Expected`. */
function verdicts(report: Report, expected: Record<string, Expected>): Record<string, Expected> {
  return Object.fromEntries(
    Object.keys(expected).map((id) => {
      const p = report.properties.find((x) => x.id === id)!;
      if (p.holds) return [id, "holds"];
      const events = p.counterexample!.events;
      return [id, { events: events.length, faults: events.filter((e) => e.kind === "lose" || e.kind === "restart").length }];
    }),
  );
}

for (const example of corpus) for (const c of example.cases) {
  const spec = example.spec(c.variant);
  const bounds = { ...c.bounds, instances: example.instances ?? {} };
  describe(caseName(example, c), () => {
    const run = (extra: Partial<typeof bounds> = {}) => check(spec, { ...bounds, ...EXHAUSTIVE, ...extra });
    const plain = run({ reduce: false, symmetry: false });

    test("the search finds what was worked out by hand, and nothing else", () => {
      expect(plain.exhaustive).toBe(true);
      expect(plain.errors.map((e) => e.message)).toEqual([]);
      expect(verdicts(plain, c.expect)).toEqual(c.expect);
    });

    test("counterexamples replay to the same events", () => {
      for (const p of plain.properties.filter((x) => !x.holds)) {
        const again = replay(spec, p.counterexample!.initial, p.counterexample!.choices);
        expect(again.events.map((e) => `${e.actor}.${e.key}`)).toEqual(p.counterexample!.events.map((e) => `${e.actor}.${e.key}`));
      }
    });

    test("the reductions reach the same verdicts, with counterexamples just as short", () => {
      const reduced = run({ reduce: true, symmetry: false });
      expect(verdicts(reduced, c.expect)).toEqual(c.expect);
      expect(reduced.coverage).toEqual(plain.coverage);
      // Without a clock, sleep sets skip orders, never states.
      expect(reduced.states).toBe(plain.states);
    });

    test("symmetry reaches the same verdicts, in no more states, or is caught being wrong", () => {
      const folded = run({ reduce: true, symmetry: true });
      expect(verdicts(folded, c.expect)).toEqual(c.expect);
      expect(folded.coverage).toEqual(plain.coverage);
      expect(folded.states).toBeLessThanOrEqual(plain.states);
      expect(folded.reductions.refuted).toEqual(c.refuted);
    });

    test("random runs alone find every bug", () => {
      const broken = Object.entries(c.expect).filter(([, v]) => v !== "holds").map(([id]) => id);
      const walked = check(spec, { ...bounds, depth: 0, walks: 3_000, walkDepth: 40, timeLimit: 60_000 });
      for (const id of broken) {
        const p = walked.properties.find((x) => x.id === id)!;
        expect(p.holds).toBe(false);
        expect(p.foundBy).toBe("walk");
      }
      for (const [id] of Object.entries(c.expect).filter(([, v]) => v === "holds")) expect(walked.properties.find((x) => x.id === id)!.holds).toBe(true);
    });
  });
}
