// How many faults a bug needs. The search finds the shortest counterexample, which may lose
// a message or restart an instance when a longer path breaks the property with none. For
// judging how likely a bug is, the fewest faults matter more than the fewest events.
import type { Event, Spec } from "../spec/index.ts";
import { check, type PropertyResult, type Report, type Seed } from "./explore.ts";

/** Faults on a path: lost deliveries and restarts. */
export function faultsIn(events: readonly Event[]): number {
  return events.filter((e) => e.kind === "lose" || e.kind === "restart").length;
}

/**
 * The report, with each broken property's counterexample swapped for one using the fewest
 * faults, found by checking again with smaller fault budgets, from none up. The property
 * keeps the length of the shortest path in `shorter`, when that one used more faults.
 */
export function withFewestFaults(spec: Spec, report: Report, seeds: Seed[] = []): Report {
  const faultsOf = (p: PropertyResult) => (!p.holds && p.counterexample ? faultsIn(p.counterexample.events) : 0);
  const top = Math.max(0, ...report.properties.map(faultsOf));
  const settled = new Set<string>();
  let properties = report.properties;
  for (let faults = 0; faults < top; faults++) {
    const open = new Set(properties.filter((p) => faultsOf(p) > faults && !settled.has(p.id)).map((p) => p.id));
    if (!open.size) break;
    const again = check(spec, { ...report.bounds, faults }, seeds);
    properties = properties.map((p) => {
      const found = open.has(p.id) ? again.properties.find((q) => q.id === p.id && !q.holds && q.counterexample) : undefined;
      if (!found) return p;
      settled.add(p.id);
      const shortest = p.counterexample!.events;
      const shorter = shortest.length < found.counterexample!.events.length ? { shorter: { events: shortest.length, faults: faultsIn(shortest) } } : {};
      return { ...found, ...(p.known === undefined ? {} : { known: p.known }), ...shorter };
    });
  }
  return { ...report, properties };
}
