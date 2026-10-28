// The integer core (integer.ts) explores exactly what the classic search does without its
// reductions: the same report, to the counterexample, on every example's safety properties
// and on generated specs.
import { expect, test } from "bun:test";
import { check, type Bounds, type Report } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";
import { build, describe as describeSpec } from "../fuzz/spec.ts";

const PLAIN = { walks: 0, maxStates: 2_000_000, timeLimit: 120_000, reduce: false, symmetry: false, workers: 0 } as const;

/** A report without the clock. */
const comparable = (r: Report) => ({ ...r, durationMs: 0 });

/** A spec with only its `always` properties: what the integer core judges. */
function safety(spec: Spec): Spec {
  return { ...spec, properties: spec.properties.filter((p) => p.kind === "always") };
}

async function bothAgree(spec: Spec, bounds: Partial<Bounds>): Promise<Report> {
  const integer = await check(spec, { ...bounds, ...PLAIN }, [], { engine: "integer" });
  const classic = await check(spec, { ...bounds, ...PLAIN }, [], { engine: "classic" });
  expect(comparable(integer)).toEqual(comparable(classic));
  return integer;
}

for (const example of corpus) for (const c of example.cases) {
  const spec = safety(example.spec(c.variant));
  if (!spec.properties.length) continue;
  test(`${caseName(example, c)}: the same report from the integer core as from the classic search`, async () => {
    await bothAgree(spec, { ...c.bounds, instances: example.instances ?? {} });
  }, 120_000);
}

test("generated specs: the same report from both", async () => {
  let compared = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const desc = describeSpec(seed);
    const spec = safety(build(desc));
    const report = await bothAgree(spec, desc.bounds);
    if (report.exhaustive) compared++;
  }
  expect(compared).toBeGreaterThan(20);
}, 300_000);

test("the integer core refuses a job it does not do", async () => {
  const spec = corpus.find((e) => e.name === "two-phase commit")!.spec("fixed");
  await expect(check(spec, { ...PLAIN, instances: { Participant: 2 } }, [], { engine: "integer" })).rejects.toThrow("the integer core does `always` properties only");
});
