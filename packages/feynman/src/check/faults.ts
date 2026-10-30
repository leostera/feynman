// How many faults a bug needs. A fault is a step tagged `fault` (RFD0012): the core has none,
// and the faults library tags the ones it builds. The search finds the shortest
// counterexample, which may need more faults than a longer one; for judging how likely a bug
// is, the fewest faults matter more than the fewest events.
import type { Event, Spec } from "../spec/index.ts";
import { FAULT } from "../spec/index.ts";
import { check, type CheckOptions, type PropertyBroken, type PropertyResult, type Report, type Seed } from "./explore.ts";

/** Faults on a path: its events from steps tagged `fault`. */
export function faultsIn(events: readonly Event[]): number {
  return events.filter((e) => e.tags?.includes(FAULT)).length;
}

/** Whether the spec has a fault at all: a step tagged `fault`. */
export function hasFaults(spec: Spec): boolean {
  return spec.actors.some((a) => [...Object.values(a.actions), ...Object.values(a.transitions)].some((s) => s.tags.includes(FAULT)));
}

/**
 * The budgets faults spend: the shared numeric variables the steps tagged `fault` use. Checking
 * again with them lowered is checking with fewer faults.
 */
export function budgetsOf(spec: Spec): { name: string; initial: number }[] {
  const used = new Set(spec.actors.flatMap((a) => [...Object.values(a.actions), ...Object.values(a.transitions)].filter((s) => s.tags.includes(FAULT)).flatMap((s) => s.uses)));
  return spec.variables.filter((v): v is { name: string; initial: number } => used.has(v.name) && !v.each && typeof v.initial === "number");
}

/**
 * The report, with each broken property's counterexample swapped for one using the fewest
 * faults, found by checking again with the fault budgets lowered, from none up. The property
 * keeps the length of the shortest path in `shorter`, when that one used more faults.
 */
export async function withFewestFaults(spec: Spec, report: Report, seeds: Seed[] = [], options: CheckOptions = {}): Promise<Report> {
  const budgets = budgetsOf(spec);
  if (!budgets.length) return report;
  const faultsOf = (p: PropertyResult) => (p.holds ? 0 : faultsIn(p.counterexample.events));
  const top = Math.max(0, ...report.properties.map(faultsOf));
  const settled = new Set<string>();
  let properties = report.properties;
  for (let faults = 0; faults < top; faults++) {
    const open = new Set(properties.filter((p) => faultsOf(p) > faults && !settled.has(p.id)).map((p) => p.id));
    if (!open.size) break;
    const lowered = Object.fromEntries(budgets.map((b) => [b.name, Math.min(b.initial, faults)]));
    const source = options.source ? { ...options.source, set: { ...options.source.set, ...lowered } } : undefined;
    const again = await check(spec.setting(lowered), report.bounds, seeds, { ...options, ...(source ? { source } : {}) });
    properties = properties.map((p) => {
      const found = open.has(p.id) ? again.properties.find((q): q is PropertyBroken => q.id === p.id && !q.holds) : undefined;
      if (!found || p.holds) return p;
      settled.add(p.id);
      const shortest = p.counterexample.events;
      const shorter = shortest.length < found.counterexample.events.length ? { shorter: { events: shortest.length, faults: faultsIn(shortest) } } : {};
      return { ...found, ...(p.known === undefined ? {} : { known: p.known }), ...shorter };
    });
  }
  return { ...report, properties };
}
