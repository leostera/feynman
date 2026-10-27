// The search split among worker threads (RFD0007) gives the same report as on one thread:
// the same states, verdicts, counterexamples, stuck worlds and coverage.
import { afterAll, expect, test } from "bun:test";
import { check, Pool, type Bounds, type Report } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { lostUpdate } from "../../examples/lost-update.ts";
import { leaderElection } from "../../examples/leader-election.ts";
import { orSet } from "../../examples/or-set.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";

const pool = new Pool(3);
afterAll(() => pool.close());

/** A report without what depends on the threads or the clock. */
const comparable = (r: Report) => ({ ...r, durationMs: 0, threads: 0, bounds: { ...r.bounds, workers: 0 } });

const cases: { name: string; spec: Spec; module: string; export?: string; bounds: Partial<Bounds> }[] = [
  { name: "lost update, buggy, 1 fault: a broken property and a stuck world", spec: lostUpdate("buggy"), module: "lost-update", bounds: { faults: 1, depth: 60, instances: { Teller: 2 }, reduce: false, symmetry: false } },
  { name: "or-set, fixed, with every reduction on", spec: orSet("fixed"), module: "or-set", export: "fixed", bounds: { faults: 0, depth: 9, instances: { Replica: 2 } } },
  { name: "two-phase commit, fixed, 1 fault: liveness broken, with a loop", spec: twoPhaseCommit("fixed"), module: "two-phase-commit", export: "fixed", bounds: { faults: 1, depth: 16, instances: { Participant: 3 } } },
  { name: "leader election, buggy: liveness broken", spec: leaderElection("buggy"), module: "leader-election", bounds: { faults: 0, depth: 16, instances: { Node: 4 } } },
  { name: "or-set, fixed, 1 fault, plain", spec: orSet("fixed"), module: "or-set", export: "fixed", bounds: { faults: 1, depth: 8, instances: { Replica: 2 }, reduce: false, symmetry: false } },
];

for (const c of cases) {
  test(`${c.name}: the same report on one thread and on four`, async () => {
    const bounds = { walks: 0, timeLimit: 120_000, ...c.bounds };
    const alone = await check(c.spec, { ...bounds, workers: 0 });
    const source = { module: `${import.meta.dir}/../../examples/${c.module}.ts`, ...(c.export ? { export: c.export } : {}) };
    const shared = await check(c.spec, { ...bounds, workers: 3 }, [], { source, pool });
    expect(alone.threads).toBe(1);
    expect(shared.threads).toBe(4);
    expect(comparable(shared)).toEqual(comparable(alone));
  });
}

test("a spec too small to share stays on the main thread", async () => {
  const report = await check(orSet("buggy"), { walks: 0, faults: 0, depth: 4, workers: 3, instances: { Replica: 2 } }, [], { source: { module: `${import.meta.dir}/../../examples/or-set.ts` }, pool });
  expect(report.threads).toBe(1);
});
