// One fuzz seed: its spec description, and what the checks find. `bun test/fuzz/show.ts <seed> [--workers 3] [--big]`
import { Pool } from "../../src/check/index.ts";
import { fuzz } from "./oracle.ts";
import { describe } from "./spec.ts";

const seed = Number(process.argv[2]);
const workers = process.argv.includes("--workers") ? Number(process.argv[process.argv.indexOf("--workers") + 1]) : 0;
const size = process.argv.includes("--big") ? "big" : "small";
console.log(JSON.stringify(describe(seed, size), null, 1));
const pool = workers ? new Pool(workers) : undefined;
const result = await fuzz(seed, { pool, size });
pool?.close();
console.log(`\n${result.states} states${result.skipped ? ` (skipped: ${result.skipped})` : ""}`);
for (const f of result.findings) console.log(`\n${f.check}:\n  ${f.detail}`);
