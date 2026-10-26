// The checker against TLC on the same systems: the same reachable states, the same verdicts,
// and counterexamples just as short. Skipped when tla2tools.jar is not around (TLA_TOOLS_JAR).
import { describe, expect, test } from "bun:test";
import type { Spec } from "@feynman/spec";
import { feynman, TLA_JAR, tlc } from "./oracle.ts";
import { cache } from "../specs/cache.ts";
import { jobQueue } from "../specs/job-queue.ts";
import { leaderElection } from "../specs/leader-election.ts";
import { payments } from "../specs/payments.ts";
import { twoPhaseCommit } from "../specs/two-phase-commit.ts";
import { lightSwitch } from "../specs/switch.ts";

interface Oracle {
  name: string;
  module: string;
  spec: (variant: "buggy" | "fixed") => Spec;
  instances?: Record<string, number>;
  /** Safety invariants both sides check, by the same name. */
  invariants: string[];
  /** For systems that never run out of things to do: both sides stop at this depth. */
  depth?: number;
  configs: { buggy: boolean; faults: number; repeats: number }[];
}

const oracles: Oracle[] = [
  {
    name: "two-phase commit",
    module: "TwoPhaseCommit",
    spec: twoPhaseCommit,
    instances: { Participant: 2 },
    invariants: ["atomic", "decidedOnceQuiet"],
    configs: [false, true].flatMap((buggy) => [0, 1].map((faults) => ({ buggy, faults, repeats: 2 }))),
  },
  {
    name: "leader election",
    module: "LeaderElection",
    spec: leaderElection,
    instances: { Node: 3 },
    invariants: ["agreeOnceQuiet"],
    configs: [false, true].flatMap((buggy) => [0, 1].map((faults) => ({ buggy, faults, repeats: 2 }))),
  },
  {
    name: "cache",
    module: "Cache",
    spec: cache,
    invariants: ["consistentOnceQuiet"],
    configs: [false, true].flatMap((buggy) => [0, 1].map((faults) => ({ buggy, faults, repeats: 2 }))),
  },
  {
    name: "payments",
    module: "Payments",
    spec: payments,
    instances: { Client: 1 },
    invariants: ["debitedOnce"],
    depth: 9,
    configs: [false, true].flatMap((buggy) => [0, 1].map((faults) => ({ buggy, faults, repeats: 2 }))),
  },
  {
    name: "job queue",
    module: "JobQueue",
    spec: jobQueue,
    invariants: ["doneOnce"],
    depth: 9,
    configs: [false, true].flatMap((buggy) => [0, 1].map((faults) => ({ buggy, faults, repeats: 2 }))),
  },
  {
    name: "switch",
    module: "Switch",
    spec: () => lightSwitch(),
    invariants: ["onOnce"],
    depth: 6,
    configs: [{ buggy: true, faults: 0, repeats: 2 }],
  },
];

describe.skipIf(!TLA_JAR)("TLC oracles", () => {
  for (const o of oracles) {
    for (const c of o.configs) {
      const label = `${o.name}, ${c.buggy ? "buggy" : "fixed"}, ${c.faults} fault(s)`;
      test(label, () => {
        const constants = { Buggy: c.buggy, Faults: c.faults, Repeats: c.repeats, ...(o.depth ? { Depth: o.depth } : {}) };
        const view = o.depth ? { view: "view" } : {};
        const ours = feynman(o.spec(c.buggy ? "buggy" : "fixed"), { faults: c.faults, repeats: c.repeats, instances: o.instances ?? {}, ...(o.depth ? { depth: o.depth } : {}) });
        expect(ours.report.errors.map((e) => e.message)).toEqual([]);
        if (!o.depth) expect(ours.report.exhaustive).toBe(true);
        // The same reachable states.
        expect(ours.distinct).toBe(tlc(o.module, constants, [], view).distinct);
        // The same verdict on each invariant, and counterexamples just as short.
        for (const invariant of o.invariants) {
          const theirs = tlc(o.module, constants, [invariant], view).violated;
          const p = ours.report.properties.find((x) => x.id === invariant)!;
          expect({ invariant, broken: !p.holds, events: p.counterexample?.events.length }).toEqual({ invariant, broken: !!theirs, events: theirs?.events });
        }
      }, 300_000);
    }
  }
});
