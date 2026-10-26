// The corpus: well-known systems whose bugs, and the shortest way to them, were worked out by
// hand. The checker must find exactly those, accept the fixes, and reach the same verdicts
// whichever way it explores: with or without its reductions, with or without symmetry, and
// by random runs alone.
import { describe, expect, test } from "bun:test";
import { check, replay, type Bounds, type Report } from "@feynman/check";
import type { Spec } from "@feynman/spec";
import { cache } from "../specs/cache.ts";
import { leaseLock } from "../specs/lease-lock.ts";
import { payments } from "../specs/payments.ts";
import { twoPhaseCommit } from "../specs/two-phase-commit.ts";
import { leaderElection } from "../specs/leader-election.ts";
import { jobQueue } from "../specs/job-queue.ts";

/** A property's expected verdict: holds, or broken by a shortest path of this many events, with this many faults. */
type Expected = "holds" | { events: number; faults: number };

interface Case {
  name: string;
  spec: Spec;
  bounds: Partial<Bounds>;
  expect: Record<string, Expected>;
  /** Whether no step reads the clock, so the reduced search must visit exactly the plain one's states. */
  clockFree: boolean;
  /** Actors declared symmetric that are not, which the checker must catch. */
  refuted?: string[];
}

const EXHAUSTIVE = { maxStates: 2_000_000, timeLimit: 120_000, walks: 0 };

const cases: Case[] = [
  { name: "payments, buggy", spec: payments("buggy"), bounds: { depth: 8, faults: 1, instances: { Client: 1 } }, expect: { debitedOnce: { events: 4, faults: 0 }, paymentsSettle: "holds" }, clockFree: true },
  { name: "payments, fixed", spec: payments("fixed"), bounds: { depth: 8, faults: 1, instances: { Client: 1 } }, expect: { debitedOnce: "holds", paymentsSettle: "holds" }, clockFree: true },
  { name: "two-phase commit, buggy", spec: twoPhaseCommit("buggy"), bounds: { depth: 9, faults: 0, instances: { Participant: 2 } }, expect: { atomic: { events: 7, faults: 0 } }, clockFree: true },
  { name: "two-phase commit, fixed", spec: twoPhaseCommit("fixed"), bounds: { depth: 9, faults: 0, instances: { Participant: 2 } }, expect: { atomic: "holds", decides: "holds" }, clockFree: true },
  { name: "two-phase commit, fixed, one fault", spec: twoPhaseCommit("fixed"), bounds: { depth: 8, faults: 1, instances: { Participant: 2 } }, expect: { atomic: "holds", decides: { events: 6, faults: 1 } }, clockFree: true },
  { name: "lease lock, buggy", spec: leaseLock("buggy"), bounds: { depth: 11, faults: 0, instances: { Client: 2 } }, expect: { fenced: { events: 10, faults: 0 } }, clockFree: false },
  { name: "lease lock, fixed", spec: leaseLock("fixed"), bounds: { depth: 11, faults: 0, instances: { Client: 2 } }, expect: { fenced: "holds" }, clockFree: false },
  { name: "cache, buggy", spec: cache("buggy"), bounds: { depth: 8, faults: 0 }, expect: { converges: { events: 7, faults: 0 } }, clockFree: true },
  { name: "cache, fixed", spec: cache("fixed"), bounds: { depth: 8, faults: 0 }, expect: { converges: "holds" } , clockFree: true },
  { name: "leader election, buggy", spec: leaderElection("buggy"), bounds: { depth: 12, faults: 0, instances: { Node: 3 } }, expect: { agree: { events: 4, faults: 0 } }, clockFree: true },
  { name: "leader election, fixed", spec: leaderElection("fixed"), bounds: { depth: 12, faults: 0, instances: { Node: 3 } }, expect: { agree: "holds" }, clockFree: true, refuted: ["Node"] },
  { name: "job queue, buggy", spec: jobQueue("buggy"), bounds: { depth: 8, faults: 1 }, expect: { doneOnce: { events: 6, faults: 0 }, jobsFinish: "holds" }, clockFree: true },
  { name: "job queue, fixed", spec: jobQueue("fixed"), bounds: { depth: 8, faults: 1 }, expect: { doneOnce: "holds", jobsFinish: "holds" }, clockFree: true },
  { name: "cache, fixed, one fault", spec: cache("fixed"), bounds: { depth: 7, faults: 1 }, expect: { converges: { events: 7, faults: 1 } }, clockFree: true },
];

/** What a report says about each expected property, in the terms of `Expected`. */
function verdicts(report: Report, expected: Record<string, Expected>): Record<string, Expected> {
  return Object.fromEntries(
    Object.keys(expected).map((id) => {
      const p = report.properties.find((x) => x.id === id)!;
      if (p.holds) return [id, "holds"];
      const events = p.counterexample!.events;
      return [id, { events: events.length, faults: events.filter((e) => e.kind === "lose" || e.kind === "restart").length }];
    }),
  );
}

for (const c of cases) {
  describe(c.name, () => {
    const run = (extra: Partial<Bounds> = {}) => check(c.spec, { ...c.bounds, ...EXHAUSTIVE, ...extra });
    const plain = run({ reduce: false, symmetry: false });

    test("the search finds what was worked out by hand, and nothing else", () => {
      expect(plain.exhaustive).toBe(true);
      expect(plain.errors.map((e) => e.message)).toEqual([]);
      expect(verdicts(plain, c.expect)).toEqual(c.expect);
    });

    test("counterexamples replay to the same events", () => {
      for (const p of plain.properties.filter((x) => !x.holds)) {
        const again = replay(c.spec, p.counterexample!.initial, p.counterexample!.choices);
        expect(again.events.map((e) => `${e.actor}.${e.key}`)).toEqual(p.counterexample!.events.map((e) => `${e.actor}.${e.key}`));
      }
    });

    test("the reductions reach the same verdicts, with counterexamples just as short", () => {
      const reduced = run({ reduce: true, symmetry: false });
      expect(verdicts(reduced, c.expect)).toEqual(c.expect);
      expect(reduced.coverage).toEqual(plain.coverage);
      if (c.clockFree) expect(reduced.states).toBe(plain.states);
    });

    test("symmetry reaches the same verdicts, in no more states, or is caught being wrong", () => {
      const folded = run({ reduce: true, symmetry: true });
      expect(verdicts(folded, c.expect)).toEqual(c.expect);
      expect(folded.coverage).toEqual(plain.coverage);
      expect(folded.states).toBeLessThanOrEqual(plain.states);
      expect(folded.reductions.refuted).toEqual(c.refuted);
    });

    test("random runs alone find every bug", () => {
      const broken = Object.entries(c.expect).filter(([, v]) => v !== "holds").map(([id]) => id);
      const walked = check(c.spec, { ...c.bounds, depth: 0, walks: 3_000, walkDepth: 40, timeLimit: 60_000 });
      for (const id of broken) {
        const p = walked.properties.find((x) => x.id === id)!;
        expect(p.holds).toBe(false);
        expect(p.foundBy).toBe("walk");
      }
      for (const [id] of Object.entries(c.expect).filter(([, v]) => v === "holds")) expect(walked.properties.find((x) => x.id === id)!.holds).toBe(true);
    });
  });
}
