// The integer core (integer.ts) explores exactly what the classic search does without its
// reductions: the same report, to the counterexample and the loop, on every example and on
// generated specs, with and without symmetry, and from scenario seeds.
import { expect, test } from "bun:test";
import { check, type Bounds, type Report, type Seed } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/cli/shape.ts";
import type { Spec } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";
import { build, describe as describeSpec } from "../fuzz/spec.ts";

const PLAIN = { walks: 0, maxStates: 2_000_000, timeLimit: 120_000, reduce: false, symmetry: false, workers: 0 } as const;

/** A report without the clock. */
const comparable = (r: Report) => ({ ...r, durationMs: 0 });

async function bothAgree(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[] = []): Promise<Report> {
  const integer = await check(spec, { ...PLAIN, ...bounds }, seeds, { engine: "integer" });
  const classic = await check(spec, { ...PLAIN, ...bounds }, seeds, { engine: "classic" });
  expect(comparable(integer)).toEqual(comparable(classic));
  return integer;
}

for (const example of corpus) for (const c of example.cases) {
  const spec = example.spec(c.variant);
  test(`${caseName(example, c)}: the same report from the integer core as from the classic search`, async () => {
    await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {} });
  }, 120_000);
  test(`${caseName(example, c)}, with symmetry: the same report from both`, async () => {
    await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {}, symmetry: true });
  }, 120_000);
  if (spec.scenarios.length)
    test(`${caseName(example, c)}, from its scenarios too: the same report from both`, async () => {
      await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {}, symmetry: true }, scenarioSeeds(spec));
    }, 120_000);
}

test("generated specs: the same report from both", async () => {
  let compared = 0;
  for (let seed = 1; seed <= 80; seed++) {
    const desc = describeSpec(seed);
    const spec = build(desc);
    const report = await bothAgree(spec, { ...desc.bounds, symmetry: seed % 2 === 0 });
    if (report.exhaustive) compared++;
  }
  expect(compared).toBeGreaterThan(40);
}, 300_000);
