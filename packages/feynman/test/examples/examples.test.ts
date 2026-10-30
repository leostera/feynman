// The corpus: well-known systems whose bugs, and the shortest way to them, were worked out by
// hand. The checker must find exactly those, accept the fixes, and reach the same verdicts
// whichever way it explores: with or without its reductions, with or without symmetry, and
// by random runs alone.
import { beforeAll, describe, expect, test } from "bun:test";
import { check, faultsIn, replay, type Counterexample, type Report } from "../../src/check/index.ts";
import { isLiveness } from "../../src/spec/index.ts";
import { caseName, configured, corpus, type Expected } from "./corpus.ts";

const EXHAUSTIVE = { maxStates: 2_000_000, timeLimit: 120_000, walks: 0 };

/** What a report says about each expected property, in the terms of `Expected`. */
function verdicts(report: Report, expected: Record<string, Expected>): Record<string, Expected> {
  return Object.fromEntries(
    Object.keys(expected).map((id) => {
      const p = report.properties.find((x) => x.id === id)!;
      if (p.holds) return [id, p.unfinished ? "unfinished" : "holds"];
      return [id, shape(p.counterexample)];
    }),
  );
}

/** A counterexample's length and faults. For liveness, the way to the loop. */
function shape(ce: Counterexample): Expected {
  return { events: ce.events.length, faults: faultsIn(ce.events) };
}

/** Where the report says the system gets stuck, in the terms of `Expected`. */
const stuckOf = (report: Report) => (report.stuck ? shape(report.stuck.counterexample) : undefined);

for (const example of corpus) for (const c of example.cases) {
  const { spec, bounds: given } = configured(example.spec(c.variant), c.bounds);
  const bounds = { ...given, instances: example.instances ?? {} };
  describe(caseName(example, c), () => {
    const run = (extra: Partial<typeof bounds> = {}) => check(spec, { ...bounds, ...EXHAUSTIVE, ...extra });
    let plain: Report;
    beforeAll(async () => {
      plain = await run({ symmetry: false });
    });

    test("the search finds what was worked out by hand, and nothing else", async () => {
      expect(plain.exhaustive).toBe(true);
      expect(plain.errors.map((e) => e.message)).toEqual([]);
      expect(verdicts(plain, c.expect)).toEqual(c.expect);
      expect(stuckOf(plain)).toEqual(c.stuck);
    });

    test("counterexamples replay to the same events", async () => {
      for (const p of plain.properties.filter((p) => !p.holds)) {
        const again = replay(spec, p.counterexample.initial, p.counterexample.choices);
        expect(again.events.map((e) => `${e.actor}.${e.key}`)).toEqual(p.counterexample.events.map((e) => `${e.actor}.${e.key}`));
      }
    });

    test("symmetry reaches the same verdicts, in no more states, or is caught being wrong", async () => {
      const folded = await run({ symmetry: true });
      expect(verdicts(folded, c.expect)).toEqual(c.expect);
      expect(stuckOf(folded)).toEqual(c.stuck);
      expect(folded.coverage).toEqual(plain.coverage);
      expect(folded.states).toBeLessThanOrEqual(plain.states);
      // Symmetry is off for liveness, so a wrong claim is caught by the safety properties alone.
      const safety = { ...spec, properties: spec.properties.filter((p) => !isLiveness(p)) };
      expect(safety.properties.length === spec.properties.length ? folded.reductions.refuted : (await check(safety, { ...bounds, ...EXHAUSTIVE, symmetry: true })).reductions.refuted).toEqual(c.refuted);
    });

    // Liveness needs the whole graph, which random runs do not build: they judge safety only.
    test("random runs alone find every safety bug, and getting stuck", async () => {
      const safety = Object.entries(c.expect).filter(([id]) => !isLiveness(spec.properties.find((p) => p.id === id)!));
      const walked = await check(spec, { ...bounds, depth: 0, walks: 3_000, walkDepth: 40, timeLimit: 60_000 });
      for (const [id, expected] of safety) {
        const p = walked.properties.find((x) => x.id === id)!;
        expect(p.holds).toBe(expected === "holds");
        if (!p.holds) expect(p.foundBy).toBe("walk");
      }
      expect(walked.stuck?.foundBy).toBe(c.stuck ? "walk" : undefined);
    });
  });
}
