// The checker against P's systematic tester on the same systems. P runs many seeded schedules
// rather than every state, so it gives verdicts, not state counts: for each configuration,
// whether a schedule breaks the property (and that the assertion broken is the property's),
// which must match whether the checker finds it broken. Skipped without the `p` tool
// (`dotnet tool install --global P`, with .NET 8).
import { describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { check } from "../../src/check/index.ts";
import { corpus, P_CASES } from "./corpus.ts";

const DOTNET = process.env.DOTNET_ROOT ?? join(homedir(), ".dotnet");
const ENV = { ...process.env, DOTNET_ROOT: DOTNET, DOTNET_CLI_TELEMETRY_OPTOUT: "1", PATH: `${DOTNET}:${join(DOTNET, "tools")}:${process.env.HOME}/.dotnet/tools:${process.env.PATH}` };
const HAS_P = spawnSync("p", ["--version"], { env: ENV }).status === 0;
/**
 * Schedules to try. P stops at the first bug, so where the checker finds one it costs only
 * until then, and the bug can be rare (two-phase commit's is in about one schedule in 700):
 * many. Where the checker finds none, P runs them all: fewer. Either way P decides by itself.
 */
const SCHEDULES = { broken: 50_000, holds: 3_000 };
/** Scheduling steps per schedule: retry loops never end by themselves, and these bugs take a few dozen. */
const MAX_STEPS = 300;

/** Run one P test case; the assertion it found broken, if any. */
function pCheck(project: string, testCase: string, schedules: number): string | null {
  const dir = join(import.meta.dir, "..", "..", "examples", "oracles", "p", project);
  const output = join(dir, "PCheckerOutput");
  rmSync(output, { recursive: true, force: true });
  // P exits non-zero when it finds a bug; its output is still the report.
  const run = spawnSync("p", ["check", "-tc", testCase, "-s", String(schedules), "-ms", String(MAX_STEPS)], { cwd: dir, env: ENV, encoding: "utf8" });
  const out = `${run.stdout}${run.stderr}`;
  if (!/Found \d+ bugs?/.test(out)) throw new Error(`P failed on ${project} ${testCase}:\n${out}`);
  if (/Found 0 bugs/.test(out)) return null;
  const logs = existsSync(join(output, "BugFinding")) ? readdirSync(join(output, "BugFinding")).filter((f) => f.endsWith(".txt")) : [];
  const log = logs.map((f) => readFileSync(join(output, "BugFinding", f), "utf8")).join("\n");
  return /<ErrorLog> (.*)/.exec(log)?.[1] ?? "a bug P did not describe";
}

describe.skipIf(!HAS_P)("P oracles", () => {
  for (const example of corpus) {
    const o = example.p;
    if (!o) continue;
    describe(o.project, () => {
      test("compiles", () => {
        execFileSync("p", ["compile"], { cwd: join(import.meta.dir, "..", "..", "examples", "oracles", "p", o.project), env: ENV, encoding: "utf8" });
      }, 300_000);
      for (const c of o.cases ?? P_CASES) {
        test(`${c.variant}, ${c.faults} fault(s): P and the checker agree`, () => {
          const ours = check(example.spec(c.variant), { depth: o.depth, faults: c.faults, instances: example.instances ?? {}, maxStates: 2_000_000, timeLimit: 120_000, walks: 0 });
          const p = ours.properties.find((x) => x.id === o.property);
          if (!p) throw new Error(`${example.name} has no property ${o.property}`);
          const theirs = pCheck(o.project, c.testCase, SCHEDULES[p.holds ? "holds" : "broken"]);
          if (theirs) expect(theirs).toContain(o.assertion);
          expect({ broken: !p.holds }).toEqual({ broken: theirs !== null });
        }, 300_000);
      }
    });
  }
});
