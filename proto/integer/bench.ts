// The integer core against the checker, on the bench models: the same states and verdicts
// (safety only, reductions off), and how long each takes on one thread.
//
//   bun proto/integer/bench.ts [model…]
import { check, initialWorld } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { MODELS, modelNamed } from "../../bench/models.ts";
import { IntegerSearch } from "./core.ts";

const names = process.argv.slice(2);
for (const model of names.length ? names.map(modelNamed) : MODELS) {
  const full: Spec = (await import(`../../examples/${model.file}.ts`))[model.export ?? "default"];
  // Safety only: `always` properties (never ones change what a state is; liveness needs the graph).
  const spec: Spec = { ...full, properties: full.properties.filter((p) => p.kind === "always") };
  const bounds = { depth: 60, faults: 1, repeats: 2, instances: {}, ...model.bounds, reduce: false, symmetry: false, walks: 0, workers: 0, maxStates: 5_000_000, timeLimit: 600_000 };
  const t0 = performance.now();
  const theirs = await check(spec, bounds);
  const tCheck = performance.now() - t0;
  const t1 = performance.now();
  const ours = new IntegerSearch(spec, bounds, initialWorld(spec, bounds)).run();
  const tInt = performance.now() - t1;
  const verdicts = (m: Map<string, number>) => Object.fromEntries([...m].sort());
  const checkBroken = Object.fromEntries(theirs.properties.filter((p) => !p.holds).map((p) => [p.id, (p as { counterexample: { events: unknown[] } }).counterexample.events.length]).sort());
  const same = theirs.states === ours.states && JSON.stringify(checkBroken) === JSON.stringify(verdicts(ours.broken));
  console.log(
    JSON.stringify({
      model: model.name,
      same,
      states: { check: theirs.states, integer: ours.states },
      broken: { check: checkBroken, integer: verdicts(ours.broken) },
      ms: { check: Math.round(tCheck), integer: Math.round(tInt) },
      speedup: +(tCheck / tInt).toFixed(1),
      stats: ours.stats,
    }),
  );
}
