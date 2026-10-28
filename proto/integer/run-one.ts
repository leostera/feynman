// The integer core alone on one model, for profiling: `bun --cpu-prof proto/integer/run-one.ts <model>`.
import { initialWorld } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { modelNamed } from "../../bench/models.ts";
import { IntegerSearch } from "./core.ts";

const model = modelNamed(process.argv[2] ?? "or-set-fault");
const full: Spec = (await import(`../../examples/${model.file}.ts`))[model.export ?? "default"];
const spec: Spec = { ...full, properties: full.properties.filter((p) => p.kind === "always") };
const bounds = { depth: 60, faults: 1, repeats: 2, instances: {}, ...model.bounds };
const t = performance.now();
const r = new IntegerSearch(spec, bounds, initialWorld(spec, bounds)).run();
console.log(JSON.stringify({ model: model.name, states: r.states, ms: Math.round(performance.now() - t), stats: r.stats }));
