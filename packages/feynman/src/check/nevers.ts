// What `never` properties remember of a path, which is part of a state when they read it.
import { traceView, type Event, type PropertyInfo } from "../spec/index.ts";

/** What a trace sees of a step: who took it, which step, what it sent, and whether it failed. */
export type TraceStep = Pick<Event, "actor" | "key" | "error" | "sent">;

export interface Remembered {
  /** What the properties remember of the path: paths that remember the same are one state. */
  memory: string;
  /** The properties the path breaks. */
  nevers: string[];
  /** How each property read the path: the calls it made, in order (see `memoryOf`). */
  shapes: Map<string, string>;
}

/** The shape of a property that remembers the whole path. */
const WHOLE_PATH = "the whole path";

const NONE: ReadonlySet<string> = new Set();

/**
 * A `never` property judges the whole path, so two paths to one world are one state only if
 * the property remembers the same of both. It sees the path through `count` and `some`, each
 * over single events, so the answers those calls give are all it can remember: they go in the
 * fingerprint. Judging the path this way also says which of them it breaks.
 *
 * That holds while the property asks the same questions of every path. One that asks a
 * question only sometimes (`t.some(a) && t.count(b) > 1` never counts b before an a) has not
 * said what it would remember of the paths where it did not ask: two of them that differ in
 * how many b they hold would be merged, and one of the two never judged. So each property's
 * calls are its shape, reported here; the search reads them, and a property whose shape varies
 * is run again as `whole` (the search starts over). A property in `whole`, or one that reads
 * `trace.events` itself, could remember anything: the whole path goes in, and no two paths
 * are merged. A predicate built from an earlier answer is beyond what the shape can see.
 */
export function memoryOf(nevers: PropertyInfo[], events: readonly TraceStep[], whole: ReadonlySet<string> = NONE): Remembered {
  const base = traceView(events.map((e, index) => ({ ...e, index }) as Event));
  const parts: string[] = [];
  const broken: string[] = [];
  const shapes = new Map<string, string>();
  let path: string | undefined;
  for (const invariant of nevers) {
    if (invariant.kind !== "never") continue;
    const answers: unknown[] = [];
    const calls: string[] = [];
    let opaque = whole.has(invariant.id);
    const trace = {
      get events() {
        opaque = true;
        return base.events;
      },
      count: (p: Parameters<typeof base.count>[0]) => {
        const n = base.count(p);
        answers.push(n);
        calls.push(`count ${String(p)}`);
        return n;
      },
      some: (p: Parameters<typeof base.some>[0]) => {
        const b = base.some(p);
        answers.push(b);
        calls.push(`some ${String(p)}`);
        return b;
      },
    };
    try {
      if (invariant.never(trace)) broken.push(invariant.id);
    } catch {
      answers.push("!");
      calls.push("!");
    }
    shapes.set(invariant.id, opaque ? WHOLE_PATH : calls.join("\n"));
    parts.push(opaque ? (path ??= pathText(events)) : JSON.stringify(answers));
  }
  return { memory: parts.join("|"), nevers: broken, shapes };
}

/** A path as text: everything a trace can see of each step. */
function pathText(events: readonly TraceStep[]): string {
  return `path:${events.map((e) => `${e.actor}.${e.key}${e.error ? "!" : ""}>${e.sent.map((s) => s.message).join("+")}`).join(",")}`;
}

/** An event as a trace sees it. */
export function traceStep(e: Event): TraceStep {
  return { actor: e.actor, key: e.key, sent: e.sent.map((s) => ({ message: s.message })) as Event["sent"], ...(e.error ? { error: e.error } : {}) };
}
