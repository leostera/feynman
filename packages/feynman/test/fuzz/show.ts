// One fuzz seed: its spec description, and what the checks find. `bun test/fuzz/show.ts <seed> [--big]`
import { fuzz } from "./oracle.ts";
import { describe } from "./spec.ts";

const seed = Number(process.argv[2]);
const size = process.argv.includes("--big") ? "big" : "small";
console.log(JSON.stringify(describe(seed, size), null, 1));
const result = await fuzz(seed, { size });
console.log(`\n${result.states} states${result.skipped ? ` (skipped: ${result.skipped})` : ""}`);
for (const f of result.findings) console.log(`\n${f.check}:\n  ${f.detail}`);
