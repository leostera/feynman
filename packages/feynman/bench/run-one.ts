// One benchmark run, in a process of its own (clean timing and peak memory). Prints one line of JSON.
import { check } from "../src/check/index.ts";
import type { Spec } from "../src/spec/index.ts";
import { modelNamed } from "./models.ts";

const model = modelNamed(process.argv[2]);
const loaded: Spec = (await import(`../examples/${model.file}.ts`))[model.export ?? "default"];
const spec = loaded.setting(model.set);
const started = performance.now();
const report = await check(spec, { walks: 0, maxStates: 5_000_000, timeLimit: 600_000, ...model.bounds });
const ms = performance.now() - started;
console.log(
  JSON.stringify({
    model: model.name,
    states: report.states,
    exhaustive: report.exhaustive,
    ms: Math.round(ms),
    statesPerSecond: Math.round(report.states / (ms / 1000)),
    peakMB: Math.round(process.resourceUsage().maxRSS / 1024),
    verdicts: Object.fromEntries(report.properties.map((p) => [p.id, p.holds ? (p.unfinished ? "unfinished" : "holds") : p.counterexample.events.length])),
  }),
);
