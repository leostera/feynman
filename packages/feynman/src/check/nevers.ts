// What `never` properties remember of a path, which is part of a state when they read it.
import { traceView, type Event, type PropertyInfo, type Spec } from "../spec/index.ts";

/** What `never` properties remember of no path at all: a root's memory. */
export function rootMemory(spec: Spec): string {
  const nevers = spec.properties.filter((p) => p.kind === "never");
  return nevers.length ? memoryOf(nevers, []).memory : "";
}

/**
 * A `never` property judges the whole path, so two paths to one world are one state only if
 * the property remembers the same of both. It sees the path through `count` and `some`, each
 * over single events, so the answers those calls give are all it can remember: they go in the
 * fingerprint. A property that reads `trace.events` itself could remember anything, so then
 * the whole path goes in: no two paths are merged. Judging the path this way also says which
 * of them it breaks.
 */
export function memoryOf(nevers: PropertyInfo[], events: Event[]): { memory: string; nevers: string[] } {
  const base = traceView(events);
  const memory: unknown[] = [];
  const broken: string[] = [];
  let opaque = false;
  const trace = {
    get events() {
      opaque = true;
      return base.events;
    },
    count: (p: Parameters<typeof base.count>[0]) => {
      const n = base.count(p);
      memory.push(n);
      return n;
    },
    some: (p: Parameters<typeof base.some>[0]) => {
      const b = base.some(p);
      memory.push(b);
      return b;
    },
  };
  for (const invariant of nevers) {
    if (invariant.kind !== "never") continue;
    try {
      if (invariant.never(trace)) broken.push(invariant.id);
    } catch {
      memory.push("!");
    }
  }
  return { memory: opaque ? `path:${events.map((e) => `${e.actor}.${e.key}`).join(",")}` : JSON.stringify(memory), nevers: broken };
}
