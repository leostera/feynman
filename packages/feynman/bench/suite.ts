// The benchmark suite: every model (or those named), each run in a process of its own, the
// best of a few runs. Appends the results to bench/out/results.jsonl, with the commit and the
// machine's load, so runs can be compared over time.
//
//   bun bench/suite.ts [--runs 3] [model…]
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { MODELS } from "./models.ts";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { runs: { type: "string", default: "3" } } });
const runs = Number(values.runs);
const models = positionals.length ? MODELS.filter((m) => positionals.includes(m.name)) : MODELS;
const commit = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
const dirty = spawnSync("git", ["status", "--porcelain", "src"], { encoding: "utf8" }).stdout.trim() !== "";
const out = join(import.meta.dir, "out");
mkdirSync(out, { recursive: true });

type Run = { model: string; states: number; ms: number; statesPerSecond: number; peakMB: number; verdicts: Record<string, unknown> };

console.log(`commit ${commit}${dirty ? " (src changed)" : ""}, ${cpus().length} cores, load ${loadavg().map((l) => l.toFixed(1)).join(" ")}, best of ${runs}`);
console.log(["model".padEnd(18), "states".padStart(8), "ms".padStart(8), "states/s".padStart(10), "peak MB".padStart(8)].join(" "));
for (const model of models) {
  const tries: Run[] = [];
  for (let i = 0; i < runs; i++) {
    const child = spawnSync("bun", [join(import.meta.dir, "run-one.ts"), model.name], { encoding: "utf8" });
    if (child.status !== 0) throw new Error(`${model.name} failed:\n${child.stderr}`);
    tries.push(JSON.parse(child.stdout.trim().split("\n").at(-1)!));
  }
  const best = tries.reduce((a, b) => (b.ms < a.ms ? b : a));
  console.log([model.name.padEnd(18), String(best.states).padStart(8), String(best.ms).padStart(8), String(best.statesPerSecond).padStart(10), String(best.peakMB).padStart(8)].join(" "));
  appendFileSync(join(out, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), commit, dirty, load: loadavg()[0], ...best }) + "\n");
}
