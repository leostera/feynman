// Comparing two runs of the same scenario, for example at two commits: steps are aligned
// by who took which step (actor and key), with a longest common subsequence, then each
// aligned pair is compared by what it did (state changes, sends, errors).
import type { Event, Run } from "./spec.ts";

export type StepStatus = "same" | "changed" | "added" | "removed";

export interface StepDiff {
  status: StepStatus;
  base?: Event;
  head?: Event;
}

export interface RunDiff {
  status: "same" | "changed";
  steps: StepDiff[];
}

export function diffRuns(base: Pick<Run, "events">, head: Pick<Run, "events">): RunDiff {
  const a = base.events;
  const b = head.events;
  const sig = (e: Event) => `${e.actor}\u0000${e.key}`;
  // LCS table over step signatures.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = sig(a[i]) === sig(b[j]) ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const steps: StepDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && sig(a[i]) === sig(b[j])) {
      steps.push({ status: effect(a[i]) === effect(b[j]) ? "same" : "changed", base: a[i], head: b[j] });
      i++;
      j++;
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) steps.push({ status: "added", head: b[j++] });
    else steps.push({ status: "removed", base: a[i++] });
  }
  return { status: steps.every((s) => s.status === "same") ? "same" : "changed", steps };
}

/** What a step did, without ids and times that shift when other steps change. */
function effect(e: Event): string {
  return JSON.stringify([
    e.inputs ?? null,
    e.payload ?? null,
    e.changes.map((c) => [c.instance, c.path, c.after]),
    e.sent.map((s) => [s.to, s.message, s.payload]),
    e.started.map((s) => s.timer),
    e.cancelled,
    e.error ?? null,
    e.violations,
  ]);
}
