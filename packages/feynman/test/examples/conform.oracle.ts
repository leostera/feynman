// feynman conform against TLC's trace validation (RFD0016): whether a log is a run of a spec,
// decided by TLC on an independent model. The model steps through the log as it runs: a step
// the log records must be the log's next line, and a loss, which logs do not record, may
// happen anywhere. The log is a run when TLC reaches its end, which the invariant `Unread`
// says it never does. Skipped when tla2tools.jar is not around (TLA_TOOLS_JAR).
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conform, parseLog } from "../../src/check/conform.ts";
import { seeded } from "../../src/check/walk.ts";
import { orderedWrites } from "../../examples/ordered-writes.ts";
import { TLA_JAR, tlc } from "./oracle.ts";

type Line = { key: "set" | "put"; value: "a" | "b" };

/** The trace module for one log: OrderedWrites, instantiated, with the log to read through. */
function traceModule(log: Line[]): string {
  const trace = `<<${log.map((l) => `[key |-> "${l.key}", value |-> "${l.value}"]`).join(", ")}>>`;
  return `---- MODULE TraceOrderedWrites ----
EXTENDS Naturals, Sequences
CONSTANTS Buggy, Faults, Repeats
VARIABLES last, value, net, acts, faults, i
W == INSTANCE OrderedWrites
Trace == ${trace}
(* A step the log records is its next line. *)
Logged(e) == i <= Len(Trace) /\\ Trace[i] = e /\\ i' = i + 1
Init == W!Init /\\ i = 1
Next ==
  \\/ \\E v \\in {"a", "b"} : W!Set(v) /\\ Logged([key |-> "set", value |-> v])
  \\/ \\E j \\in W!Arrives : W!Put(j) /\\ Logged([key |-> "put", value |-> net[j]])
  \\/ \\E j \\in DOMAIN net : W!Lose(j) /\\ i' = i
(* Broken when a behaviour has read the whole log: then the log is one of its runs. *)
Unread == i <= Len(Trace)
====
`;
}

/** The same log, as feynman conform reads it. */
function jsonl(log: Line[]): string {
  return log.map((l) => JSON.stringify(l.key === "set" ? { instance: "Client", key: "set", inputs: { value: l.value } } : { instance: "Store", key: "put", payload: { value: l.value } })).join("\n");
}

/**
 * Logs to try: every one of one to five lines, in a seeded order. (The empty log is a run of
 * anything; TLC finds that in the initial state, where it counts no states.)
 */
function logs(): Line[][] {
  const symbols: Line[] = [{ key: "set", value: "a" }, { key: "set", value: "b" }, { key: "put", value: "a" }, { key: "put", value: "b" }];
  let all: Line[][] = [[]];
  for (let n = 0; n < 5; n++) all = [...all, ...all.filter((l) => l.length === n).flatMap((l) => symbols.map((s) => [...l, s]))];
  const random = seeded(7);
  return all.filter((l) => l.length).map((l) => ({ l, r: random() })).sort((a, b) => a.r - b.r).map(({ l }) => l);
}

describe.skipIf(!TLA_JAR)("feynman conform against TLC trace validation", () => {
  for (const [variant, faults] of [["buggy", 0], ["fixed", 0], ["fixed", 1], ["buggy", 1]] as const) {
    test(`ordered writes, ${variant}, ${faults} fault(s)`, () => {
      const spec = orderedWrites(variant).setting({ faults });
      const tried = { accepted: 0, rejected: 0 };
      const dir = mkdtempSync(join(tmpdir(), "feynman-trace-"));
      try {
        for (const log of logs()) {
          const ours = conform(spec, parseLog(jsonl(log), spec), { gap: 3 }).conforms;
          // Ten of each, so neither answer goes untested.
          if (tried[ours ? "accepted" : "rejected"] >= 10) continue;
          tried[ours ? "accepted" : "rejected"]++;
          writeFileSync(join(dir, "TraceOrderedWrites.tla"), traceModule(log));
          const theirs = tlc("TraceOrderedWrites", { Buggy: variant === "buggy", Faults: faults, Repeats: 3 }, ["Unread"], { dir, modules: ["OrderedWrites"] }).violated !== undefined;
          expect({ log: jsonl(log), conforms: ours }).toEqual({ log: jsonl(log), conforms: theirs });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(tried).toEqual({ accepted: 10, rejected: 10 });
    }, 600_000);
  }
});
