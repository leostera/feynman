// The benchmark suite: every model (or those named) with each worker count, each run in a
// process of its own, the best of a few runs. Appends the results to bench/out/results.jsonl,
// with the commit and the machine's load, so runs can be compared over time.
//
//   bun bench/suite.ts [--workers 0,7] [--runs 3] [model…]
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MODELS } from "./models.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { workers: { type: "string", default: "0,7" }, runs: { type: "string", default: "3" } } });
const counts = values.workers!.split(",").map(Number);
const runs = Number(values.runs);
const models = positionals.length ? MODELS.filter((m) => positionals.includes(m.name)) : MODELS;
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).stdout.trim() !== "";
const out = join(import.meta.dir, "out");
mkdirSync(out, { recursive: true });

type Run = { model: string; workers: number; threads: number; states: number; ms: number; statesPerSecond: number; peakMB: number; verdicts: Record<string, unknown> };

console.log(`commit ${commit}${dirty ? " (src changed)" : ""}, ${cpus().length} cores, load ${loadavg().map((l) => l.toFixed(1)).join(" ")}, best of ${runs}`);
console.log(["model".padEnd(18), "states".padStart(8), ...counts.map((w) => `${w}w ms`.padStart(14)), "speed-up".padStart(9), "peak MB".padStart(8)].join(" "));
for (const model of models) {
  const best = counts.map((workers) => {
    const tries: Run[] = [];
    for (let i = 0; i < runs; i++) {
      const child = spawnSync("bun", [join(import.meta.dir, "run-one.ts"), model.name, String(workers)], { encoding: "utf8" });
      if (child.status !== 0) throw new Error(`${model.name} with ${workers} workers failed:\n${child.stderr}`);
      tries.push(JSON.parse(child.stdout.trim().split("\n").at(-1)!));
    }
    return tries.reduce((a, b) => (b.ms < a.ms ? b : a));
  });
  const verdicts = new Set(best.map((r) => JSON.stringify([r.states, r.verdicts])));
  if (verdicts.size > 1) throw new Error(`${model.name}: different results with different worker counts: ${[...verdicts].join(" / ")}`);
  const cells = best.map((r) => `${r.ms}${r.threads > 1 ? `/${r.threads}t` : ""}`.padStart(14));
  console.log([model.name.padEnd(18), String(best[0].states).padStart(8), ...cells, `${(best[0].ms / Math.min(...best.map((r) => r.ms))).toFixed(2)}x`.padStart(9), String(Math.max(...best.map((r) => r.peakMB))).padStart(8)].join(" "));
  for (const r of best) appendFileSync(join(out, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), commit, dirty, load: loadavg()[0], ...r }) + "\n");
}
