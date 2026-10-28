// One benchmark run, in a process of its own (clean timing and peak memory): a model, with so
// many worker threads. Prints one line of JSON.
import { join } from "node:path";
import { check, Pool } from "../src/check/index.ts";
import { loadSource } from "../src/check/pool.ts";
import { modelNamed } from "./models.ts";

const [name, workersArg] = process.argv.slice(2);
const model = modelNamed(name);
const workers = Number(workersArg ?? 0);
const source = { module: join(import.meta.dir, "..", "examples", `${model.file}.ts`), ...(model.export ? { export: model.export } : {}) };
const spec = await loadSource(source);
const pool = new Pool(workers);
const started = performance.now();
const report = await check(spec, { walks: 0, maxStates: 5_000_000, timeLimit: 600_000, ...model.bounds, workers }, [], workers ? { source, pool } : {});
const ms = performance.now() - started;
pool.close();
console.log(
  JSON.stringify({
    model: name,
    workers,
    threads: report.threads,
    states: report.states,
    exhaustive: report.exhaustive,
    ms: Math.round(ms),
    statesPerSecond: Math.round(report.states / (ms / 1000)),
    peakMB: Math.round(process.resourceUsage().maxRSS / 1024),
    verdicts: Object.fromEntries(report.properties.map((p) => [p.id, p.holds ? ("unfinished" in p && p.unfinished ? "unfinished" : "holds") : p.counterexample.events.length])),
  }),
);
