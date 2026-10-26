// Judging one world reached by the search or a random run: which properties it breaks.
// Shared, so both ways of exploring check properties identically.
import { choices, fire, guard, holdsIn, SETTLE_LIMIT, traceView, type Event, type Spec, type StepOptions, type World } from "../spec/index.ts";
import { canonical, leastRenaming, NO_SYMMETRY, pendingText, renamed, type Symmetry } from "./keys.ts";

/** Running by itself to check an `eventually` needs only the worlds. */
const SILENT: StepOptions = { explain: false, invariants: false };

/** Most events the system left alone runs, as a scenario's settle() does. */
export { SETTLE_LIMIT };

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
export function judge(spec: Spec, world: World, event: Event | null, path: () => Event[], v: Verdicts, symmetry: Symmetry = NO_SYMMETRY): { findings: Finding[]; error?: string } {
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
      if (reaches(spec, world, invariant.eventually, v.futures.get(invariant.id)!, symmetry)) continue;
      // Found: run it again, explained, for the counterexample.
      const then = settles(spec, world, invariant.eventually, v.futures.get(invariant.id)!, symmetry);
      if (then) findings.push({ id: invariant.id, then });
    }
  }
  return { findings, error };
}

/**
 * The system left alone: no actions and no faults. A guarded transition that holds runs
 * first; then the message in flight that sorts first by what it carries; when none is in
 * flight, the timer that sorts first. Ordering by content, not by internal ids, makes the
 * run, and so an `eventually` verdict, a function of the state alone: merging worlds cannot
 * change it. With symmetry, content is compared as the world's canonical twin has it
 * (keys.ts), so twins the search merges are judged alike. Other orders are not the system
 * left alone's business: the search itself tries every order, so it reaches them, and
 * judges from there.
 */
export function soloChoices(spec: Spec, world: World, symmetry: Symmetry = NO_SYMMETRY): ({ kind: "guard"; instance: string; key: string } | { kind: "fire"; pending: number })[] {
  const { guards, pending } = choices(spec, world);
  const { renaming } = symmetry.classes.length ? leastRenaming(world, symmetry) : { renaming: new Map<string, string>() };
  const least = <T>(items: T[], text: (item: T) => string) =>
    items.map((item) => [renamed(text(item), renaming), item] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))[0]?.[1];
  const guarded = least(guards, (g) => `${g.instance}|${g.key}`);
  if (guarded) return [{ kind: "guard", instance: guarded.instance, key: guarded.key }];
  const next = least(pending.filter((p) => p.kind === "deliver"), pendingText) ?? least(pending.filter((p) => p.kind === "timer"), pendingText);
  return next ? [{ kind: "fire", pending: next.id }] : [];
}

function soloStep(spec: Spec, world: World, choice: ReturnType<typeof soloChoices>[number], how: StepOptions) {
  return choice.kind === "guard" ? guard(spec, world, choice.instance, choice.key, how) : fire(spec, world, choice.pending, how);
}

/** Per world: whether the system left alone from it reaches the property. */
export type Futures = Map<string, boolean>;

/**
 * Whether the system left alone from `world` reaches `predicate` before it stops, goes
 * round, or runs SETTLE_LIMIT events. Remembered per world, so runs that meet share the rest.
 */
function reaches(spec: Spec, world: World, predicate: (w: never) => boolean, futures: Futures, symmetry: Symmetry): boolean {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = world;
  let answer = false;
  for (let n = 0; n <= SETTLE_LIMIT; n++) {
    if (holdsIn(spec, current, predicate as never)) {
      answer = true;
      break;
    }
    const key = canonical(current);
    const known = futures.get(key);
    if (known !== undefined) {
      answer = known;
      break;
    }
    // Back where this run already was, without the property: it goes round forever.
    if (seen.has(key)) break;
    seen.add(key);
    path.push(key);
    const [choice] = soloChoices(spec, current, symmetry);
    if (!choice) break;
    current = soloStep(spec, current, choice, SILENT).world;
  }
  for (const key of path) futures.set(key, answer);
  return answer;
}

/** The events of the system left alone not reaching `predicate`, explained; null if it does. */
export function settles(spec: Spec, world: World, predicate: (w: never) => boolean, futures: Futures = new Map(), symmetry: Symmetry = NO_SYMMETRY): Event[] | null {
  if (reaches(spec, world, predicate, futures, symmetry)) return null;
  const events: Event[] = [];
  const seen = new Set<string>();
  let current = world;
  for (let n = 0; n < SETTLE_LIMIT; n++) {
    const key = canonical(current);
    if (seen.has(key)) break;
    seen.add(key);
    const [choice] = soloChoices(spec, current, symmetry);
    if (!choice) break;
    const step = soloStep(spec, current, choice, {});
    events.push(step.event);
    current = step.world;
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
