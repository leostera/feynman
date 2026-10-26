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
import type { Spec } from "../../src/spec/index.ts";
import { jobQueue } from "../../examples/job-queue.ts";
import { payments } from "../../examples/payments.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";

const DOTNET = process.env.DOTNET_ROOT ?? join(homedir(), ".dotnet");
const ENV = { ...process.env, DOTNET_ROOT: DOTNET, DOTNET_CLI_TELEMETRY_OPTOUT: "1", PATH: `${DOTNET}:${join(DOTNET, "tools")}:${process.env.HOME}/.dotnet/tools:${process.env.PATH}` };
const HAS_P = spawnSync("p", ["--version"], { env: ENV }).status === 0;
/**
 * Schedules to try. P stops at the first bug, so a buggy system costs only until then; its bug
 * can be rare (two-phase commit's is in about one schedule in 700). A fixed system runs them all.
 */
const SCHEDULES = { buggy: 50_000, fixed: 3_000 };
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

interface POracle {
  project: string;
  spec: (variant: "buggy" | "fixed") => Spec;
  property: string;
  /** The message of the property's assertion in the P model. */
  assertion: string;
  instances?: Record<string, number>;
  depth: number;
}

const oracles: POracle[] = [
  { project: "TwoPhaseCommit", spec: twoPhaseCommit, property: "atomic", assertion: "one participant committed while another aborted", instances: { Participant: 2 }, depth: 9 },
  { project: "Payments", spec: payments, property: "debitedOnce", assertion: "the bank debited more often than the client paid", instances: { Client: 1 }, depth: 8 },
  { project: "JobQueue", spec: jobQueue, property: "doneOnce", assertion: "a job had its side effect twice", depth: 8 },
];

const cases = [
  { testCase: "tcBuggy", variant: "buggy" as const, faults: 0 },
  { testCase: "tcFixed", variant: "fixed" as const, faults: 0 },
  { testCase: "tcFixedOneFault", variant: "fixed" as const, faults: 1 },
];

describe.skipIf(!HAS_P)("P oracles", () => {
  for (const o of oracles) {
    describe(o.project, () => {
      test("compiles", () => {
        execFileSync("p", ["compile"], { cwd: join(import.meta.dir, "..", "..", "examples", "oracles", "p", o.project), env: ENV, encoding: "utf8" });
      }, 300_000);
      for (const c of cases) {
        test(`${c.variant}, ${c.faults} fault(s): P and the checker agree`, () => {
          const theirs = pCheck(o.project, c.testCase, SCHEDULES[c.variant]);
          if (theirs) expect(theirs).toContain(o.assertion);
          const ours = check(o.spec(c.variant), { depth: o.depth, faults: c.faults, instances: o.instances ?? {}, maxStates: 2_000_000, timeLimit: 120_000, walks: 0 });
          const p = ours.properties.find((x) => x.id === o.property)!;
          expect({ broken: !p.holds }).toEqual({ broken: theirs !== null });
        }, 300_000);
      }
    });
  }
});
