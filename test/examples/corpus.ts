// The corpus: every example, with what each way of checking it must find. One entry per
// system, so adding one is one place: the checker's verdicts worked out by hand
// (examples.test.ts), and, where there is one, its TLA+ model (tla.oracle.ts) and P model
// (p.oracle.ts).
import type { Bounds } from "../../src/check/index.ts";
import type { Spec } from "../../src/spec/index.ts";
import { alternatingBit } from "../../examples/alternating-bit.ts";
import { barrier } from "../../examples/barrier.ts";
import { cache } from "../../examples/cache.ts";
import { changRoberts } from "../../examples/chang-roberts.ts";
import { diningPhilosophers } from "../../examples/dining-philosophers.ts";
import { jobQueue } from "../../examples/job-queue.ts";
import { leaderElection } from "../../examples/leader-election.ts";
import { leaseLock } from "../../examples/lease-lock.ts";
import { outbox } from "../../examples/outbox.ts";
import { primaryBackup } from "../../examples/primary-backup.ts";
import { payments } from "../../examples/payments.ts";
import { ricartAgrawala } from "../../examples/ricart-agrawala.ts";
import { raftVote } from "../../examples/raft-vote.ts";
import { tokenRing } from "../../examples/token-ring.ts";
import { writeSkew } from "../../examples/write-skew.ts";
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
  {
    name: "raft vote",
    spec: raftVote,
    instances: { Node: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { oneLeader: { events: 7, faults: 1 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { oneLeader: "holds" } },
    ],
    tla: { module: "RaftVote", invariants: ["oneLeader"], configs: BOTH_WAYS },
    p: {
      project: "RaftVote",
      property: "oneLeader",
      assertion: "two nodes lead the same term",
      depth: 8,
      // The bug needs a restart: the P model's one fault is a restart, never a lost message.
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "outbox",
    spec: outbox,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { announcedOnceQuiet: { events: 3, faults: 1 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 0 }, expect: { announcedOnceQuiet: "holds" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { announcedOnceQuiet: { events: 4, faults: 1 } } },
    ],
    tla: { module: "Outbox", invariants: ["announcedOnceQuiet"], configs: BOTH_WAYS },
    p: {
      project: "Outbox",
      property: "announcedOnceQuiet",
      // The system always comes to rest: an announcement still owed at the end is the bug.
      assertion: "Announced detected liveness bug in hot state 'Owed'",
      depth: 8,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixed", variant: "fixed", faults: 0 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "write skew",
    spec: writeSkew,
    instances: { Doctor: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 9, faults: 0 }, expect: { covered: { events: 8, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { covered: "holds" } },
    ],
    tla: { module: "WriteSkew", invariants: ["covered"], configs: BOTH_WAYS },
    p: { project: "WriteSkew", property: "covered", assertion: "nobody is on call", depth: 9 },
  },
  {
    name: "dining philosophers",
    spec: diningPhilosophers,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { noDeadlock: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { noDeadlock: "holds" } },
    ],
    tla: { module: "DiningPhilosophers", invariants: ["noDeadlock"], configs: BOTH_WAYS },
    p: { project: "DiningPhilosophers", property: "noDeadlock", assertion: "each philosopher holds one fork and waits for the other", depth: 8 },
  },
  {
    name: "ricart-agrawala",
    spec: ricartAgrawala,
    instances: { Node: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { mutex: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { mutex: "holds" } },
    ],
    tla: { module: "RicartAgrawala", invariants: ["mutex"], configs: BOTH_WAYS },
    p: { project: "RicartAgrawala", property: "mutex", assertion: "both nodes are in the critical section", depth: 9 },
  },
  {
    name: "token ring",
    spec: tokenRing,
    instances: { Node: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { oneToken: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { oneToken: "holds" } },
    ],
    tla: { module: "TokenRing", invariants: ["oneToken"], depth: 8, configs: BOTH_WAYS },
    p: { project: "TokenRing", property: "oneToken", assertion: "two nodes hold the token", depth: 8 },
  },
  {
    name: "chang-roberts",
    spec: changRoberts,
    instances: { Node: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { oneLeader: { events: 3, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { oneLeader: "holds" } },
    ],
    tla: { module: "ChangRoberts", invariants: ["oneLeader"], configs: BOTH_WAYS },
    p: { project: "ChangRoberts", property: "oneLeader", assertion: "two nodes lead", depth: 9 },
  },
  {
    name: "barrier",
    spec: barrier,
    instances: { Worker: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { waitsForAll: { events: 5, faults: 1 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { waitsForAll: "holds" } },
    ],
    tla: { module: "Barrier", invariants: ["waitsForAll"], configs: BOTH_WAYS },
    p: {
      project: "Barrier",
      property: "waitsForAll",
      assertion: "the barrier opened before every worker reached it",
      depth: 8,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "primary-backup",
    spec: primaryBackup,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { ackedIsReplicated: { events: 3, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { ackedIsReplicated: "holds" } },
    ],
    tla: { module: "PrimaryBackup", invariants: ["ackedIsReplicated"], configs: BOTH_WAYS },
    p: { project: "PrimaryBackup", property: "ackedIsReplicated", assertion: "acknowledged a write the backup does not have", depth: 8 },
  },
];

/** A case's name in test output: "two-phase commit, fixed, one fault". */
export function caseName(example: Example, c: Case): string {
  const faults = c.bounds.faults ? `, ${c.bounds.faults === 1 ? "one fault" : `${c.bounds.faults} faults`}` : "";
  return example.cases.length === 1 ? example.name : `${example.name}, ${c.variant}${faults}`;
}
