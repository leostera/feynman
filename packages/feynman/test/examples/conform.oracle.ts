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

/**
 * The trace module for one log: OrderedWrites, instantiated, with the log to read through. A
 * line may be matched once the lines `before` it lists have been: in order, each the one before.
 */
function traceModule(log: Line[], before: number[][] = log.map((_, i) => (i ? [i] : []))): string {
  const trace = `<<${log.map((l) => `[key |-> "${l.key}", value |-> "${l.value}"]`).join(", ")}>>`;
  const preds = `<<${before.map((b) => `{${b.join(", ")}}`).join(", ")}>>`;
  return `---- MODULE TraceOrderedWrites ----
EXTENDS Naturals, Sequences
CONSTANTS Buggy, Faults, Repeats
VARIABLES last, value, net, acts, faults, done
W == INSTANCE OrderedWrites
Trace == ${trace}
Before == ${preds}
(* A step the log records is a line not yet matched, all of whose befores are. *)
Logged(e) == \\E k \\in 1..Len(Trace) : k \\notin done /\\ Before[k] \\subseteq done /\\ Trace[k] = e /\\ done' = done \\cup {k}
Init == W!Init /\\ done = {}
Next ==
  \\/ \\E v \\in {"a", "b"} : W!Set(v) /\\ Logged([key |-> "set", value |-> v])
  \\/ \\E j \\in W!Arrives : W!Put(j) /\\ Logged([key |-> "put", value |-> net[j]])
  \\/ \\E j \\in DOMAIN net : W!Lose(j) /\\ done' = done
(* Broken when a behaviour has read the whole log: then the log is one of its runs. *)
Unread == done # 1..Len(Trace)
====
`;
}

/** The same log, as feynman conform reads it. */
function jsonl(log: Line[], before?: number[][]): string {
  return log.map((l, i) => JSON.stringify({ ...(l.key === "set" ? { instance: "Client", key: "set", inputs: { value: l.value } } : { instance: "Store", key: "put", payload: { value: l.value } }), ...(before ? { after: before[i] } : {}) })).join("\n");
}

/**
 * The log as a trace from two machines would give it: the client's lines in their order, the
 * store's in theirs, and nothing between the two, written the store's first: an order no run
 * has, so the log is a run only as a partial order.
 */
function partial(log: Line[]): { log: Line[]; before: number[][] } {
  const written = [...log.filter((l) => l.key === "put"), ...log.filter((l) => l.key === "set")];
  const before = written.map((l, i) => (i > 0 && written[i - 1]!.key === l.key ? [i] : []));
  return { log: written, before };
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
      const tried = { accepted: 0, rejected: 0, "accepted partial": 0, "rejected partial": 0 };
      const dir = mkdtempSync(join(tmpdir(), "feynman-trace-"));
      try {
        for (const [n, total] of logs().map((l, n) => [n, l] as const)) {
          // Every other log, as a partial order.
          const { log, before } = n % 2 ? partial(total) : { log: total, before: undefined };
          const text = jsonl(log, before);
          const ours = conform(spec, parseLog(text, spec), { gap: 3 }).conforms;
          // Ten of each, so neither answer goes untested.
          const kind = `${ours ? "accepted" : "rejected"}${before ? " partial" : ""}` as const;
          if (tried[kind] >= 10) continue;
          tried[kind]++;
          writeFileSync(join(dir, "TraceOrderedWrites.tla"), traceModule(log, before));
          const theirs = tlc("TraceOrderedWrites", { Buggy: variant === "buggy", Faults: faults, Repeats: 3 }, ["Unread"], { dir, modules: ["OrderedWrites"] }).violated !== undefined;
          expect({ log: text, conforms: ours }).toEqual({ log: text, conforms: theirs });
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      expect(tried).toEqual({ accepted: 10, rejected: 10, "accepted partial": 10, "rejected partial": 10 });
    }, 600_000);
  }
});
