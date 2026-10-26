// The flows of a run: what each thing someone did set off.
//
// A flow starts where someone acts (an action), where instances appear (a run of spawns), or
// where a fault restarts one. Every other event joins the flow that caused it: a delivery or
// a timer the flow of the event that created it (sent the message, set the timer); a lost
// message the flow of the message; a guarded step the flow that last touched its instance.
// So "Pair a Mac and reach it" reads as: they appear, Alice signs in, Alice pairs, the Mac
// links, Alice runs a command, each with everything it caused, even where they interleave.
import type { Event, Run, World } from "./spec.ts";

export interface Flow {
  /** The event that started it: an action, the first of a run of spawns, or a restart. */
  start: number;
  kind: "action" | "spawn" | "restart";
  /** Every event of the flow, by index into the run's events, in order. */
  events: number[];
}

/** The flows of a run, in the order they started. */
export function flowsOf(run: Run): Flow[] {
  const flows: Flow[] = [];
  /** Which flow created each pending event, by pending id. */
  const createdBy = new Map<number, number>();
  /** The flow that last touched each instance. */
  const lastOn = new Map<string, number>();
  const before = (i: number): World => (i === 0 ? run.initial : run.worlds[i - 1]);

  const start = (i: number, kind: Flow["kind"]) => {
    flows.push({ start: i, kind, events: [] });
    return flows.length - 1;
  };
  const flowOf = (i: number, event: Event): number => {
    if (event.kind === "action") return start(i, "action");
    if (event.kind === "restart") return start(i, "restart");
    if (event.kind === "spawn") {
      const last = flows.at(-1);
      // Instances that appear one after another appear together.
      return last?.kind === "spawn" && last.events.at(-1) === i - 1 ? flows.length - 1 : start(i, "spawn");
    }
    if (event.kind === "guard") return lastOn.get(event.instance) ?? start(i, "action");
    // A delivery, timer or loss consumes one pending event: the one gone after it.
    const after = new Set(run.worlds[i].pending.map((p) => p.id));
    const consumed = before(i).pending.find((p) => !after.has(p.id) && p.to === event.instance);
    const cause = consumed ? createdBy.get(consumed.id) : undefined;
    return cause ?? lastOn.get(event.instance) ?? start(i, "action");
  };

  run.events.forEach((event, i) => {
    const flow = flowOf(i, event);
    flows[flow].events.push(i);
    lastOn.set(event.instance, flow);
    // What this event created belongs to its flow.
    const had = new Set(before(i).pending.map((p) => p.id));
    for (const p of run.worlds[i].pending) if (!had.has(p.id)) createdBy.set(p.id, flow);
  });
  return flows;
}
