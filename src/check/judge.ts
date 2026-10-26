// Judging one world reached by the search or a random run: which properties it breaks.
// Shared, so both ways of exploring check properties identically.
import { choices, fire, guard, holdsIn, traceView, type Event, type Spec, type StepOptions, type World } from "../spec/index.ts";
import { canonical, pendingText } from "./keys.ts";

/** Running by itself to check an `eventually` needs only the worlds. */
const SILENT: StepOptions = { explain: false, invariants: false };

/** Most events one run by itself may take, so a looping spec cannot hang the checker. */
export const SETTLE_LIMIT = 1000;

/** What the exploring so far knows about properties: which broke, and what it remembers. */
export interface Verdicts {
  /** Properties broken somewhere, and spec errors met; whoever explores records where. */
  broken: Set<string>;
  errors: Set<string>;
  /** Steps (`Actor.key`) that ran somewhere. */
  reached: Set<string>;
  /** For `eventually`: how often it was put to the test. */
  tested: Map<string, number>;
  futures: Map<string, Futures>;
}

export function verdicts(): Verdicts {
  return { broken: new Set(), errors: new Set(), reached: new Set(), tested: new Map(), futures: new Map() };
}

/** What a world (and the event that led to it) newly breaks. */
export interface Finding {
  id: string;
  /** For `eventually`: the system left alone from this world, never reaching the property. */
  then?: Event[];
}

/**
 * Judge a world: the event's errors and `always` violations, `never` over the path, and
 * whether an `eventually` property that applies here is reached by the system left alone.
 * Only properties not yet broken are judged.
 */
export function judge(spec: Spec, world: World, event: Event | null, path: () => Event[], v: Verdicts): { findings: Finding[]; error?: string } {
  const findings: Finding[] = [];
  let error: string | undefined;
  if (event) {
    v.reached.add(`${event.actor}.${event.key}`);
    if (event.error && !v.errors.has(event.error)) error = event.error;
    for (const id of event.violations) if (!v.broken.has(id)) findings.push({ id });
  }
  for (const invariant of spec.invariants) {
    if (v.broken.has(invariant.id) || findings.some((f) => f.id === invariant.id)) continue;
    if (invariant.kind === "never") {
      if (event && safely(() => invariant.never(traceView(path())))) findings.push({ id: invariant.id });
    } else if (invariant.kind === "eventually") {
      if (invariant.after && !holdsIn(spec, world, invariant.after)) continue;
      if (holdsIn(spec, world, invariant.eventually)) continue;
      v.tested.set(invariant.id, (v.tested.get(invariant.id) ?? 0) + 1);
      if (!v.futures.has(invariant.id)) v.futures.set(invariant.id, new Map());
      if (!neverWithin(spec, world, invariant.eventually, invariant.within, v.futures.get(invariant.id)!)) continue;
      // Found: run it again, explained, for the counterexample.
      const then = settles(spec, world, invariant.eventually, invariant.within, v.futures.get(invariant.id)!);
      if (then) findings.push({ id: invariant.id, then });
    }
  }
  return { findings, error };
}

/**
 * The system left alone: no actions and no faults, every event on time. Events due at the
 * same moment go in the order of what they carry (then a guarded transition before any), not
 * of internal ids, so the run, and so an `eventually` verdict, is a function of the state
 * alone: merging worlds cannot change it. Other orders of simultaneous events are not the
 * system left alone's business: the search itself tries every order of deliveries, so it
 * reaches them, and judges from there.
 */
export function soloChoices(spec: Spec, world: World): ({ kind: "guard"; instance: string; key: string } | { kind: "fire"; pending: number })[] {
  const { guards, pending } = choices(spec, world);
  if (guards.length) return [{ kind: "guard", instance: guards[0].instance, key: guards[0].key }];
  if (!pending.length) return [];
  const due = Math.max(world.clock, pending[0].at);
  const now = pending.filter((p) => p.at <= due);
  // Most overdue first, then by what it carries.
  now.sort((a, b) => a.at - b.at || (pendingText(a) < pendingText(b) ? -1 : pendingText(a) > pendingText(b) ? 1 : 0));
  return [{ kind: "fire", pending: now[0].id }];
}

function soloStep(spec: Spec, world: World, choice: ReturnType<typeof soloChoices>[number], how: StepOptions) {
  return choice.kind === "guard" ? guard(spec, world, choice.instance, choice.key, how) : fire(spec, world, choice.pending, how);
}

/** Per world: how long until the property holds, left alone; or that it is longer than some time. */
type Worst = { exact: number } | { over: number };
export type Futures = Map<string, Worst>;

/**
 * How long the system left alone takes to reach `predicate` from `world`; Infinity when it
 * takes longer than `budget` ms, or never gets there (it stops, or loops). Remembered per
 * world, so runs that meet share the rest.
 */
function worst(spec: Spec, world: World, predicate: (w: never) => boolean, budget: number, futures: Futures, stack: Set<string>, depth = 0): number {
  if (holdsIn(spec, world, predicate as never)) return 0;
  const key = canonical(world);
  const known = futures.get(key);
  if (known && "exact" in known) return known.exact <= budget ? known.exact : Infinity;
  if (known && known.over >= budget) return Infinity;
  // Back where this order already was, without the property: an order can go round forever.
  if (stack.has(key) || depth >= SETTLE_LIMIT) return Infinity;
  const next = soloChoices(spec, world);
  let longest = next.length ? 0 : Infinity;
  stack.add(key);
  for (const choice of next) {
    const step = soloStep(spec, world, choice, SILENT);
    const took = step.world.clock - world.clock;
    const rest = took > budget ? Infinity : worst(spec, step.world, predicate, budget - took, futures, stack, depth + 1);
    longest = Math.max(longest, took + rest);
    if (longest > budget) break;
  }
  stack.delete(key);
  futures.set(key, longest <= budget ? { exact: longest } : { over: budget });
  return longest <= budget ? longest : Infinity;
}

/** Whether the system left alone keeps `predicate` false for longer than `within`. */
function neverWithin(spec: Spec, world: World, predicate: (w: never) => boolean, within: number, futures: Futures): boolean {
  return worst(spec, world, predicate, within, futures, new Set()) === Infinity;
}

/** The events of the system left alone not reaching `predicate` within `within` ms, explained; null if it does. */
export function settles(spec: Spec, world: World, predicate: (w: never) => boolean, within: number, futures: Futures = new Map()): Event[] | null {
  if (!neverWithin(spec, world, predicate, within, futures)) return null;
  const events: Event[] = [];
  const seen = new Set<string>();
  const deadline = world.clock + within;
  let current = world;
  for (let n = 0; n < SETTLE_LIMIT; n++) {
    const key = canonical(current);
    if (seen.has(key)) break;
    seen.add(key);
    const budget = deadline - current.clock;
    let failing: ReturnType<typeof soloStep> | undefined;
    for (const choice of soloChoices(spec, current)) {
      const step = soloStep(spec, current, choice, {});
      const took = step.world.clock - current.clock;
      if (took > budget || worst(spec, step.world, predicate, budget - took, futures, new Set()) === Infinity) {
        failing = step;
        break;
      }
    }
    if (!failing || failing.world.clock > deadline) break;
    events.push(failing.event);
    current = failing.world;
  }
  return events;
}

export function safely<T>(f: () => T): T | false {
  try {
    return f();
  } catch {
    return false;
  }
}
