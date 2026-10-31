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
import { logReplication } from "../../examples/log-replication.ts";
import { lwwRegister } from "../../examples/lww-register.ts";
import { gCounter } from "../../examples/g-counter.ts";
import { orSet } from "../../examples/or-set.ts";
import { idempotentConsumer } from "../../examples/idempotent-consumer.ts";
import { retriedCall } from "../../examples/retried-call.ts";
import { readRepair } from "../../examples/read-repair.ts";
import { lostUpdate } from "../../examples/lost-update.ts";
import { outbox } from "../../examples/outbox.ts";
import { primaryBackup } from "../../examples/primary-backup.ts";
import { chainReplication } from "../../examples/chain-replication.ts";
import { quorum } from "../../examples/quorum.ts";
import { readYourWrites } from "../../examples/read-your-writes.ts";
import { payments } from "../../examples/payments.ts";
import { ricartAgrawala } from "../../examples/ricart-agrawala.ts";
import { raftVote } from "../../examples/raft-vote.ts";
import { tokenRing } from "../../examples/token-ring.ts";
import { writeSkew } from "../../examples/write-skew.ts";
import { lightSwitch } from "../../examples/switch.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";
import { webhooks } from "../../examples/webhooks.ts";

export type Variant = "buggy" | "fixed";

/**
 * A property's expected verdict: holds; unfinished (liveness whose loop may lie past the depth
 * bound); or broken by a shortest path of this many events (for liveness, to its loop), with
 * this many faults.
 */
export type Expected = "holds" | "unfinished" | { events: number; faults: number };

/**
 * A case's bounds: the checker's, and the fault budget the example declares (RFD0012),
 * `budget("faults", 1)`, which TLA+ and P models keep as a constant. `configured` sets it.
 */
export type CaseBounds = Partial<Bounds> & { faults?: number };

/** The spec with a case's budget set, and the checker's bounds without it. */
export function configured(spec: Spec, bounds: CaseBounds): { spec: Spec; bounds: Partial<Bounds> } {
  const { faults, ...rest } = bounds;
  const has = spec.variables.some((v) => v.name === "faults");
  return { spec: faults !== undefined && has ? spec.setting({ faults }) : spec, bounds: rest };
}

/** One run of the checker, and the verdicts worked out by hand. */
export interface Case {
  variant: Variant;
  bounds: CaseBounds;
  expect: Record<string, Expected>;
  /** Where the system gets stuck, short of its final state: the shortest way there. None if absent. */
  stuck?: { events: number; faults: number };
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
  /**
   * Liveness properties both sides check, by the same name: TLC under the model's `FairSpec`,
   * which makes fair what Feynman does (delivering what is in flight). Only for models without
   * a depth: a liveness verdict needs every world.
   */
  liveness?: string[];
  configs: { variant: Variant; faults: number; repeats: number }[];
}

/**
 * An independent Alloy 6 model, examples/oracles/alloy/<module>.als, searched by SAT over
 * traces: the same verdicts and shortest counterexamples, up to a trace length.
 */
export interface AlloyOracle {
  module: string;
  /** Safety invariants both sides check, by the same name (a pred in the model). */
  invariants: string[];
  /** Events a trace may have: Alloy's verdict that an invariant holds is only up to this many. */
  depth: number;
  configs: { variant: Variant; faults: number; repeats: number }[];
}

/** An independent SPIN model, examples/oracles/spin/<model>.pml: the same states, verdicts and shortest counterexamples. */
export interface SpinOracle {
  model: string;
  /** Safety invariants both sides check: an `ltl` claim p_<name> in the model. */
  invariants: string[];
  configs: { variant: Variant; faults: number; repeats: number }[];
}

/** An independent NuSMV model, examples/oracles/nusmv/<model>.smv: the same states, verdicts, shortest counterexamples, and liveness verdicts under the same fairness. */
export interface NusmvOracle {
  model: string;
  /** Safety invariants both sides check, by the same name (an INVARSPEC NAME in the model). */
  invariants: string[];
  /** Liveness properties both sides check, by the same name (an LTLSPEC NAME, under the model's JUSTICE). */
  liveness?: string[];
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
  alloy?: AlloyOracle;
  spin?: SpinOracle;
  nusmv?: NusmvOracle;
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
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { debitedOnce: { events: 4, faults: 0 }, paymentsSettle: "unfinished" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { debitedOnce: "holds", paymentsSettle: "unfinished" } },
    ],
    tla: { module: "Payments", invariants: ["debitedOnce"], depth: 9, configs: BOTH_WAYS },
    alloy: { module: "Payments", invariants: ["debitedOnce"], depth: 8, configs: BOTH_WAYS },
    p: { project: "Payments", property: "debitedOnce", assertion: "the bank debited more often than the client paid", depth: 8 },
  },
  {
    name: "two-phase commit",
    spec: twoPhaseCommit,
    instances: { Participant: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 9, faults: 0 }, expect: { atomic: { events: 7, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 9, faults: 0 }, expect: { atomic: "holds", decidedOnceQuiet: "holds", decides: "holds" } },
      // Blocking: once everyone has voted and a vote is lost, it never decides (6); quiet needs the other vote delivered too (7).
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { atomic: "holds", decidedOnceQuiet: { events: 7, faults: 1 }, decides: { events: 7, faults: 1 } }, stuck: { events: 5, faults: 1 } },
    ],
    tla: { module: "TwoPhaseCommit", invariants: ["atomic", "decidedOnceQuiet"], liveness: ["decides"], configs: BOTH_WAYS },
    alloy: { module: "TwoPhaseCommit", invariants: ["atomic", "decidedOnceQuiet"], depth: 9, configs: BOTH_WAYS },
    spin: { model: "TwoPhaseCommit", invariants: ["atomic", "decidedOnceQuiet"], configs: BOTH_WAYS },
    nusmv: { model: "TwoPhaseCommit", invariants: ["atomic", "decidedOnceQuiet"], liveness: ["decides"], configs: BOTH_WAYS },
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
      { variant: "fixed", bounds: { depth: 12, faults: 0 }, expect: { converges: "holds" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { converges: { events: 7, faults: 1 } } },
    ],
    tla: { module: "Cache", invariants: ["consistentOnceQuiet"], liveness: ["converges"], configs: BOTH_WAYS },
    spin: { model: "Cache", invariants: ["consistentOnceQuiet"], configs: BOTH_WAYS },
    nusmv: { model: "Cache", invariants: ["consistentOnceQuiet"], liveness: ["converges"], configs: BOTH_WAYS },
  },
  {
    name: "leader election",
    spec: leaderElection,
    instances: { Node: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 12, faults: 0 }, expect: { agree: { events: 9, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 12, faults: 0 }, expect: { agree: "holds" }, refuted: ["Node"] },
    ],
    tla: { module: "LeaderElection", invariants: ["agreeOnceQuiet"], liveness: ["agree"], configs: BOTH_WAYS },
    alloy: { module: "LeaderElection", invariants: ["agreeOnceQuiet"], depth: 9, configs: BOTH_WAYS },
    spin: { model: "LeaderElection", invariants: ["agreeOnceQuiet"], configs: BOTH_WAYS },
    nusmv: { model: "LeaderElection", invariants: ["agreeOnceQuiet"], liveness: ["agree"], configs: BOTH_WAYS },
  },
  {
    name: "job queue",
    spec: jobQueue,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { doneOnce: { events: 6, faults: 0 }, jobsFinish: "unfinished" } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { doneOnce: "holds", jobsFinish: "unfinished" } },
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
    alloy: { module: "AlternatingBit", invariants: ["inStep", "inOrder"], depth: 9, configs: BOTH_WAYS },
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
    alloy: { module: "Outbox", invariants: ["announcedOnceQuiet"], depth: 8, configs: BOTH_WAYS },
    spin: { model: "Outbox", invariants: ["announcedOnceQuiet"], configs: BOTH_WAYS },
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
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { covered: "holds" }, stuck: { events: 5, faults: 1 } },
    ],
    tla: { module: "WriteSkew", invariants: ["covered"], configs: BOTH_WAYS },
    alloy: { module: "WriteSkew", invariants: ["covered"], depth: 9, configs: BOTH_WAYS },
    spin: { model: "WriteSkew", invariants: ["covered"], configs: BOTH_WAYS },
    p: { project: "WriteSkew", property: "covered", assertion: "nobody is on call", depth: 9 },
  },
  {
    name: "dining philosophers",
    spec: diningPhilosophers,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { noDeadlock: { events: 6, faults: 0 } }, stuck: { events: 8, faults: 0 } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { noDeadlock: "holds" }, stuck: { events: 5, faults: 1 } },
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
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { mutex: "holds" }, stuck: { events: 4, faults: 1 } },
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
      { variant: "fixed", bounds: { depth: 9, faults: 1 }, expect: { oneLeader: "holds" }, stuck: { events: 4, faults: 1 } },
    ],
    tla: { module: "ChangRoberts", invariants: ["oneLeader"], configs: BOTH_WAYS },
    p: { project: "ChangRoberts", property: "oneLeader", assertion: "two nodes lead", depth: 9 },
  },
  {
    name: "barrier",
    spec: barrier,
    instances: { Worker: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 1 }, expect: { waitsForAll: { events: 5, faults: 1 } }, stuck: { events: 4, faults: 1 } },
      { variant: "fixed", bounds: { depth: 8, faults: 1 }, expect: { waitsForAll: "holds" }, stuck: { events: 4, faults: 1 } },
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
    alloy: { module: "PrimaryBackup", invariants: ["ackedIsReplicated"], depth: 8, configs: BOTH_WAYS },
    spin: { model: "PrimaryBackup", invariants: ["ackedIsReplicated"], configs: BOTH_WAYS },
    p: { project: "PrimaryBackup", property: "ackedIsReplicated", assertion: "acknowledged a write the backup does not have", depth: 8 },
  },
  {
    name: "read-your-writes",
    spec: readYourWrites,
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { readsOwnWrites: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 12, faults: 1 }, expect: { readsOwnWrites: "holds" } },
    ],
    tla: { module: "ReadYourWrites", invariants: ["readsOwnWrites"], configs: BOTH_WAYS },
    p: { project: "ReadYourWrites", property: "readsOwnWrites", assertion: "a read came back older than the client's own write", depth: 12 },
  },
  {
    name: "quorum",
    spec: quorum,
    instances: { Replica: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { readSeesWrite: { events: 8, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 14, faults: 1 }, expect: { readSeesWrite: "holds" } },
    ],
    tla: { module: "Quorum", invariants: ["readSeesWrite"], configs: BOTH_WAYS },
    p: { project: "Quorum", property: "readSeesWrite", assertion: "a read after a successful write missed it", depth: 14 },
  },
  {
    name: "chain replication",
    spec: chainReplication,
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { monotonicReads: { events: 8, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 14, faults: 1 }, expect: { monotonicReads: "holds" } },
    ],
    tla: { module: "ChainReplication", invariants: ["monotonicReads"], configs: BOTH_WAYS },
    p: { project: "ChainReplication", property: "monotonicReads", assertion: "a read came back older than one already read", depth: 14 },
  },
  {
    name: "log replication",
    spec: logReplication,
    cases: [
      { variant: "buggy", bounds: { depth: 6, faults: 0 }, expect: { followerIsPrefix: { events: 3, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 14, faults: 1 }, expect: { followerIsPrefix: "holds" }, stuck: { events: 4, faults: 1 } },
    ],
    tla: { module: "LogReplication", invariants: ["followerIsPrefix"], configs: BOTH_WAYS },
    p: { project: "LogReplication", property: "followerIsPrefix", assertion: "the follower's log is not the start of the leader's", depth: 14 },
  },
  {
    name: "lww register",
    spec: lwwRegister,
    instances: { Writer: 2, Replica: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 8, faults: 0 }, expect: { convergesOnceQuiet: { events: 6, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 10, faults: 0 }, expect: { convergesOnceQuiet: "holds" } },
      // Last-writer-wins needs every write everywhere: a lost one needs anti-entropy.
      { variant: "fixed", bounds: { depth: 6, faults: 1 }, expect: { convergesOnceQuiet: { events: 3, faults: 1 } } },
    ],
    tla: { module: "LwwRegister", invariants: ["convergesOnceQuiet"], configs: BOTH_WAYS },
    p: {
      project: "LwwRegister",
      property: "convergesOnceQuiet",
      assertion: "LWW detected liveness bug in hot state 'Apart'",
      depth: 10,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcFixed", variant: "fixed", faults: 0 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "g-counter",
    spec: gCounter,
    instances: { Replica: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 6, faults: 0 }, expect: { countsEveryIncrementOnceQuiet: { events: 4, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 10, faults: 0 }, expect: { countsEveryIncrementOnceQuiet: "holds" } },
      // A state-based CRDT needs every state to arrive eventually: a lost one needs anti-entropy.
      { variant: "fixed", bounds: { depth: 4, faults: 1 }, expect: { countsEveryIncrementOnceQuiet: { events: 2, faults: 1 } } },
    ],
    tla: { module: "GCounter", invariants: ["countsEveryIncrementOnceQuiet"], configs: BOTH_WAYS },
    p: {
      project: "GCounter",
      property: "countsEveryIncrementOnceQuiet",
      assertion: "GCounter detected liveness bug in hot state 'Missing'",
      depth: 10,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcFixed", variant: "fixed", faults: 0 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "or-set",
    spec: orSet,
    instances: { Replica: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 6, faults: 0 }, expect: { convergesOnceQuiet: { events: 4, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 10, faults: 0 }, expect: { convergesOnceQuiet: "holds" } },
      // An operation-based CRDT needs every operation everywhere: a lost one needs anti-entropy.
      { variant: "fixed", bounds: { depth: 4, faults: 1 }, expect: { convergesOnceQuiet: { events: 2, faults: 1 } } },
    ],
    tla: { module: "OrSet", invariants: ["convergesOnceQuiet"], configs: BOTH_WAYS },
    p: {
      project: "OrSet",
      property: "convergesOnceQuiet",
      assertion: "OrSet detected liveness bug in hot state 'Apart'",
      depth: 10,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcFixed", variant: "fixed", faults: 0 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "idempotent consumer",
    spec: idempotentConsumer,
    instances: { Consumer: 1 },
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { chargedOnce: "holds" } },
      { variant: "buggy", bounds: { depth: 7, faults: 1 }, expect: { chargedOnce: { events: 5, faults: 1 } } },
      { variant: "fixed", bounds: { depth: 10, faults: 1 }, expect: { chargedOnce: "holds" } },
    ],
    tla: { module: "IdempotentConsumer", invariants: ["chargedOnce"], depth: 10, configs: BOTH_WAYS },
    alloy: { module: "IdempotentConsumer", invariants: ["chargedOnce"], depth: 8, configs: BOTH_WAYS },
    p: {
      project: "IdempotentConsumer",
      property: "chargedOnce",
      assertion: "a job was charged twice",
      depth: 10,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
      ],
    },
  },
  {
    name: "retried call",
    spec: retriedCall,
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { chargedOnce: "holds", paymentsEnd: "holds" } },
      // The bank charges, its answer is lost, the call fails, the client retries, the bank charges again.
      { variant: "buggy", bounds: { depth: 10, faults: 1 }, expect: { chargedOnce: { events: 5, faults: 1 }, paymentsEnd: "holds" } },
      { variant: "fixed", bounds: { depth: 12, faults: 2 }, expect: { chargedOnce: "holds", paymentsEnd: "holds" } },
    ],
    tla: { module: "RetriedCall", invariants: ["chargedOnce"], liveness: ["paymentsEnd"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    alloy: { module: "RetriedCall", invariants: ["chargedOnce"], depth: 11, configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    spin: { model: "RetriedCall", invariants: ["chargedOnce"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    nusmv: { model: "RetriedCall", invariants: ["chargedOnce"], liveness: ["paymentsEnd"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    p: {
      project: "RetriedCall",
      property: "chargedOnce",
      assertion: "the customer was charged twice",
      depth: 12,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
        { testCase: "tcFixedTwoFaults", variant: "fixed", faults: 2 },
      ],
    },
  },
  {
    name: "read repair",
    spec: readRepair,
    instances: { Replica: 3 },
    cases: [
      { variant: "buggy", bounds: { depth: 12, faults: 0 }, expect: { neverGoesBack: { events: 10, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 30, faults: 0 }, expect: { neverGoesBack: "holds" } },
      { variant: "fixed", bounds: { depth: 30, faults: 1 }, expect: { neverGoesBack: "holds" } },
    ],
    tla: { module: "ReadRepair", invariants: ["neverGoesBack"], configs: BOTH_WAYS },
    p: { project: "ReadRepair", property: "neverGoesBack", assertion: "a replica went back to an older version", depth: 30 },
  },
  {
    name: "lost update",
    spec: lostUpdate,
    instances: { Teller: 2 },
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { moneyAddsUp: { events: 8, faults: 0 } } },
      { variant: "fixed", bounds: { depth: 40, faults: 0 }, expect: { moneyAddsUp: "holds" } },
      { variant: "fixed", bounds: { depth: 40, faults: 1 }, expect: { moneyAddsUp: "holds" } },
    ],
    tla: { module: "LostUpdate", invariants: ["moneyAddsUp"], configs: BOTH_WAYS },
    p: { project: "LostUpdate", property: "moneyAddsUp", assertion: "the balance and what was paid out do not add up", depth: 40 },
  },
  {
    name: "webhooks",
    spec: webhooks,
    cases: [
      { variant: "buggy", bounds: { depth: 10, faults: 0 }, expect: { creditedOnce: "holds" } },
      // The first event is sent and duplicated, one copy arrives, the second is sent and arrives, the other copy arrives.
      { variant: "buggy", bounds: { depth: 10, faults: 1 }, expect: { creditedOnce: { events: 6, faults: 1 } } },
      { variant: "fixed", bounds: { depth: 10, faults: 2 }, expect: { creditedOnce: "holds" } },
    ],
    tla: { module: "Webhooks", invariants: ["creditedOnce"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    alloy: { module: "Webhooks", invariants: ["creditedOnce"], depth: 10, configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    spin: { model: "Webhooks", invariants: ["creditedOnce"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    nusmv: { model: "Webhooks", invariants: ["creditedOnce"], configs: [...BOTH_WAYS, { variant: "fixed", faults: 2, repeats: 2 }, { variant: "buggy", faults: 2, repeats: 2 }] },
    p: {
      project: "Webhooks",
      property: "creditedOnce",
      assertion: "the shop credited more than it was notified of",
      depth: 10,
      cases: [
        { testCase: "tcBuggy", variant: "buggy", faults: 0 },
        { testCase: "tcBuggyOneFault", variant: "buggy", faults: 1 },
        { testCase: "tcFixedOneFault", variant: "fixed", faults: 1 },
        { testCase: "tcFixedTwoFaults", variant: "fixed", faults: 2 },
      ],
    },
  },
];

/** A case's name in test output: "two-phase commit, fixed, one fault". */
export function caseName(example: Example, c: Case): string {
  const faults = c.bounds.faults ? `, ${c.bounds.faults === 1 ? "one fault" : `${c.bounds.faults} faults`}` : "";
  return example.cases.length === 1 ? example.name : `${example.name}, ${c.variant}${faults}`;
}
