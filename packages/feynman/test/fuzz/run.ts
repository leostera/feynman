// Fuzz the checker with random specs: `bun test/fuzz/run.ts [--from 1] [--count 500] [--big]`.
// Prints each kind of finding with the seeds that hit it; `bun test/fuzz/show.ts <seed>`
// prints a seed's spec description and findings.
import { parseArgs } from "node:util";
import { fuzz, type Finding } from "./oracle.ts";

const { values } = parseArgs({ options: { from: { type: "string", default: "1" }, count: { type: "string", default: "300" }, big: { type: "boolean", default: false } } });
const from = Number(values.from);
const count = Number(values.count);
const byCheck = new Map<string, Finding[]>();
let skipped = 0;
let states = 0;
const started = performance.now();
for (let seed = from; seed < from + count; seed++) {
  const result = await fuzz(seed, { size: values.big ? "big" : "small" });
  states += result.states;
  if (result.skipped) skipped++;
  for (const f of result.findings) byCheck.set(f.check, [...(byCheck.get(f.check) ?? []), f]);
  if ((seed - from + 1) % 50 === 0) console.error(`  ${seed - from + 1}/${count} seeds, ${[...byCheck.values()].flat().length} findings`);
}
console.log(`${count} seeds (${from}…${from + count - 1}), ${states.toLocaleString()} states, ${skipped} too big, ${((performance.now() - started) / 1000).toFixed(1)} s`);
if (!byCheck.size) console.log("no findings");
for (const [check, found] of [...byCheck].sort((a, b) => b[1].length - a[1].length)) {
  const seeds = [...new Set(found.map((f) => f.seed))];
  console.log(`\n${check}: ${seeds.length} seed(s): ${seeds.slice(0, 12).join(", ")}${seeds.length > 12 ? ", …" : ""}`);
  console.log(`  e.g. seed ${found[0].seed}: ${found[0].detail.slice(0, 400)}`);
}
