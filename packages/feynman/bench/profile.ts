// Profile one model: run it under `bun --cpu-prof` and draw the main thread's flame graph.
//
//   bun bench/profile.ts <model>   →  bench/out/profiles/<model>.{svg,folded,cpuprofile}
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { flame } from "./flame.ts";
import { modelNamed } from "./models.ts";

const [name] = process.argv.slice(2);
modelNamed(name);
const dir = join(import.meta.dir, "out", "profiles");
const scratch = join(dir, `.${name}-${process.pid}`);
mkdirSync(scratch, { recursive: true });
const child = spawnSync("bun", ["--cpu-prof", `--cpu-prof-dir=${scratch}`, join(import.meta.dir, "run-one.ts"), name], { encoding: "utf8" });
if (child.status !== 0) throw new Error(child.stderr);
console.log(child.stdout.trim());
const base = join(dir, name);
renameSync(join(scratch, readdirSync(scratch)[0]), `${base}.cpuprofile`);
rmSync(scratch, { recursive: true });
const f = flame(`${base}.cpuprofile`, name);
writeFileSync(`${base}.svg`, f.svg);
writeFileSync(`${base}.folded`, f.folded);
console.log(`\n${f.summary}\n\n${base}.svg`);
