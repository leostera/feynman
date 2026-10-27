// The corpus: every example, with what each way of checking it must find. One entry per
// system, so adding one is one place: the checker's verdicts worked out by hand
// (examples.test.ts), and, where there is one, its TLA+ model (tla.oracle.ts) and P model
// (p.oracle.ts).
import type { Bounds } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { alternatingBit } from "../../examples/alternating-bit.ts";
import { cache } from "../../examples/cache.ts";
import { jobQueue } from "../../examples/job-queue.ts";
import { leaderElection } from "../../examples/leader-election.ts";
import { leaseLock } from "../../examples/lease-lock.ts";
import { payments } from "../../examples/payments.ts";
import { lightSwitch } from "../../examples/switch.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";

export type Variant = "buggy" | "fixed";

/** A property's expected verdict: holds, or broken by a shortest path of this many events, with this many faults. */
export type Expected = "holds" | { events: number; faults: number };

/** One run of the checker, and the verdicts worked out by hand. */
export interface Case {
  variant: Variant;
  bounds: Partial<Bounds>;
  expect: Record<string, Expected>;
  /** Actors declared symmetric that are not, which the checker must catch. */
  refuted?: string[];
}

/** An independent TLA+ model, examples/oracles/<module>.tla: the same states, verdicts and shortest counterexamples. */
export interface TlaOracle {
  module: string;
  /** Safety invariants both sides check, by the same name. */
  invariants: string[];
  /** For systems that never run out of things to do: both sides stop at this depth, and the model has a `view`. */
  depth?: number;
  configs: { variant: Variant; faults: number; repeats: number }[];
}

/** An independent P model, examples/oracles/p/<project>: the same verdict on one property. */
export interface POracle {
  project: string;
  property: string;
  /** The message of the property's assertion in the P model. */
  assertion: string;
  depth: number;
  /** Test cases in the project's PTst/Test.p (tcBuggy, tcFixed, tcFixedOneFault by default). */
  cases?: { testCase: string; variant: Variant; faults: number }[];
}

export interface Example {
  name: string;
  spec: (variant: Variant) => Spec;
  /** Instances of each non-singleton actor, wherever this example runs. */
  instances?: Record<string, number>;
  cases: Case[];
  tla?: TlaOracle;
  p?: POracle;
}

/** Both variants, with and without one fault: the usual TLA+ configurations. */
const BOTH_WAYS = (["fixed", "buggy"] as const).flatMap((variant) => [0, 1].map((faults) => ({ variant, faults, repeats: 2 })));

export const P_CASES = [
  { testCase: "tcBuggy", variant: "buggy" as const, faults: 0 },
  { testCase: "tcFixed", variant: "fixed" as const, faults: 0 },
  { testCase: "tcFixedOneFault", variant: "fixed" as const, faults: 1 },
];

export const corpus: Example[] = [
  {
    name: "payments",
    spec: payments,
    instances: { Client: 1 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { debitedOnce: { events: 4, faults: 0 }, paymentsSettle: "holds" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { debitedOnce: "holds", paymentsSettle: "holds" } },
    ],
    tla: { module: "Payments", invariants: ["debitedOnce"], depth: 9, configs: BOTH_WAYS },
    p: { project: "Payments", property: "debitedOnce", assertion: "the bank debited more often than the client paid", depth: 8 },
  },
  {
    name: "two-phase commit",
    spec: twoPhaseCommit,
    instances: { Participant: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 9, faults: 0 }, expect: { atomic: { events: 7, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 0 }, expect: { atomic: "holds", decides: "holds" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { atomic: "holds", decides: { events: 6, faults: 1 } } },
    ],
    tla: { module: "TwoPhaseCommit", invariants: ["atomic", "decidedOnceQuiet"], configs: BOTH_WAYS },
    p: { project: "TwoPhaseCommit", property: "atomic", assertion: "one participant committed while another aborted", depth: 9 },
  },
  {
    name: "lease lock",
    spec: leaseLock,
    instances: { Client: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 11, faults: 0 }, expect: { fenced: { events: 10, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 11, faults: 0 }, expect: { fenced: "holds" } },
    ],
    tla: { module: "LeaseLock", invariants: ["fenced"], configs: BOTH_WAYS },
    p: { project: "LeaseLock", property: "fenced", assertion: "storage took an older holder's write after a newer one's", depth: 11 },
  },
  {
    name: "cache",
    spec: cache,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { converges: { events: 7, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 0 }, expect: { converges: "holds" } },
      { variant: "fixed", bounds: { depth: 7, faults: 1 }, expect: { converges: { events: 7, faults: 1 } } },
    ],
    tla: { module: "Cache", invariants: ["consistentOnceQuiet"], configs: BOTH_WAYS },
  },
  {
    name: "leader election",
    spec: leaderElection,
    instances: { Node: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 12, faults: 0 }, expect: { agree: { events: 3, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 12, faults: 0 }, expect: { agree: "holds" }, refuted: ["Node"] },
    ],
    tla: { module: "LeaderElection", invariants: ["agreeOnceQuiet"], configs: BOTH_WAYS },
  },
  {
    name: "job queue",
    spec: jobQueue,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { doneOnce: { events: 6, faults: 0 }, jobsFinish: "holds" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { doneOnce: "holds", jobsFinish: "holds" } },
    ],
    tla: { module: "JobQueue", invariants: ["doneOnce"], depth: 9, configs: BOTH_WAYS },
    p: { project: "JobQueue", property: "doneOnce", assertion: "a job had its side effect twice", depth: 8 },
  },
  {
    name: "switch",
    spec: () => lightSwitch(),
    cases: [{ variant: "buggy", bounds: { depth: 6, faults: 0 }, expect: { onOnce: { events: 3, faults: 0 } } }],
    tla: { module: "Switch", invariants: ["onOnce"], depth: 6, configs: [{ variant: "buggy", faults: 0, repeats: 2 }] },
  },
  {
    name: "alternating bit",
    spec: alternatingBit,
    cases: [
      { variant: "buggy", bounds: { depth: 9, faults: 1 }, expect: { inStep: "holds", inOrder: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { inStep: "holds", inOrder: "holds" } },
    ],
    tla: { module: "AlternatingBit", invariants: ["inStep", "inOrder"], depth: 9, configs: BOTH_WAYS },
    p: { project: "AlternatingBit", property: "inOrder", assertion: "the receiver kept an item out of order", depth: 9 },
  },
];

/** A case's name in test output: "two-phase commit, fixed, one fault". */
export function caseName(example: Example, c: Case): string {
  const faults = c.bounds.faults ? `, ${c.bounds.faults === 1 ? "one fault" : `${c.bounds.faults} faults`}` : "";
  return example.cases.length === 1 ? example.name : `${example.name}, ${c.variant}${faults}`;
}
