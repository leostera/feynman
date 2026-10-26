// Judging one world reached by the search or a random run: which properties it breaks.
// Shared, so both ways of exploring check properties identically.
import { choices, fire, guard, holdsIn, traceView, type Event, type Spec, type StepOptions, type World } from "@feynman/spec";
import { canonical } from "./keys.ts";

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
      const then = settles(spec, world, invariant.eventually, invariant.within);
      if (then) findings.push({ id: invariant.id, then });
    }
  }
  return { findings, error };
}

/**
 * What the system does by itself from a world, per `eventually` property: how long until the
 * property holds, or that it does not for a while (or ever, once nothing is left to run).
 * The run by itself is deterministic, so every world on one such run shares its future, and
 * many explored worlds run into futures already seen. Keyed like deduplication.
 */
type Future = { holdsAfter: number } | { notFor: number };
export type Futures = Map<string, Future>;

/** Whether the system, left alone from `world`, does not reach `predicate` within `within` ms. */
function neverWithin(spec: Spec, world: World, predicate: (w: never) => boolean, within: number, futures: Futures): boolean {
  const chain: { key: string; clock: number }[] = [];
  const deadline = world.clock + within;
  const remember = (future: (clock: number) => Future) => {
    for (const { key, clock } of chain) futures.set(key, future(clock));
  };
  let current = world;
  for (let n = 0; n < SETTLE_LIMIT; n++) {
    const key = canonical(current);
    const known = futures.get(key);
    if (known && "holdsAfter" in known) {
      const at = current.clock + known.holdsAfter;
      remember((clock) => ({ holdsAfter: at - clock }));
      return at > deadline;
    }
    if (known && current.clock + known.notFor >= deadline) {
      const until = current.clock + known.notFor;
      remember((clock) => ({ notFor: until - clock }));
      return true;
    }
    chain.push({ key, clock: current.clock });
    const { guards, pending } = choices(spec, current);
    if (!guards.length && !pending.length) {
      remember(() => ({ notFor: Infinity }));
      return true;
    }
    if (!guards.length && pending[0].at > deadline) {
      remember((clock) => ({ notFor: deadline - clock }));
      return true;
    }
    current = (guards.length ? guard(spec, current, guards[0].instance, guards[0].key, SILENT) : fire(spec, current, pending[0].id, SILENT)).world;
    if (holdsIn(spec, current, predicate as never)) {
      const at = current.clock;
      remember((clock) => ({ holdsAfter: at - clock }));
      return at > deadline;
    }
  }
  return true;
}

/**
 * Run the system by itself (no actions, no faults) for `within` milliseconds of simulated
 * time; the events, if `predicate` never holds in that time.
 */
export function settles(spec: Spec, world: World, predicate: (w: never) => boolean, within: number): Event[] | null {
  const events: Event[] = [];
  const deadline = world.clock + within;
  let current = world;
  for (let n = 0; n < SETTLE_LIMIT; n++) {
    const { guards, pending } = choices(spec, current);
    if (!guards.length && (!pending.length || pending[0].at > deadline)) break;
    const step = guards.length ? guard(spec, current, guards[0].instance, guards[0].key) : fire(spec, current, pending[0].id);
    events.push(step.event);
    current = step.world;
    if (holdsIn(spec, current, predicate as never)) return null;
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
