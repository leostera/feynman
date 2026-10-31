// Random runs: long, cheap paths through the system, alongside the breadth-first search.
//
// The search proves things up to its depth; random runs go much deeper and find bugs the
// search cannot reach, but prove nothing. Each run is seeded, so runs are reproducible, and
// a broken property's run is shrunk to the fewest steps that still break it. The runs
// themselves go on the search's vectors (IntegerSearch.walk); this is what they report, how
// they pick, and the shrinking.
import { actorNamed, choices as enabled, stepsTaking, traceView, type Event, type Spec, type World } from "../spec/index.ts";
import { pendingText } from "./keys.ts";
import { safely, stepBreaks } from "./judge.ts";
import { apply, type Choice, type Counterexample } from "./steps.ts";

export interface WalkFinding {
  id: string;
  root: number;
  choices: Choice[];
}

export interface WalkResult {
  runs: number;
  steps: number;
  deepest: number;
  findings: WalkFinding[];
  errors: { message: string; root: number; choices: Choice[] }[];
  /** The first run that got stuck, if any. */
  stuck?: { root: number; choices: Choice[] };
}

/** How often a run picks each kind of step, when it can: mostly the system's fair steps, some people, rarely an unfair step (a fault). */
export const WEIGHTS = { system: 0.6, people: 0.32, unfair: 0.08 };

/** mulberry32: small, fast, and the same everywhere. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shrinking ----------------------------------------------------------------------------------------------

/**
 * Replay choices loosely: a delivery is found by what it carries rather than by its id, since
 * ids shift once earlier steps are dropped, and a step no longer possible is skipped.
 */
function replayLoosely(spec: Spec, initial: World, original: Counterexample, keep: boolean[]): Counterexample {
  const choices: Choice[] = [];
  const events: Event[] = [];
  const worlds: World[] = [];
  let world = initial;
  original.choices.forEach((choice, i) => {
    if (!keep[i]) return;
    const now = rebind(spec, original.worlds[i - 1] ?? initial, world, choice);
    if (!now) return;
    const step = apply(spec, world, now);
    choices.push(now);
    events.push(step.event);
    worlds.push(step.world);
    world = step.world;
  });
  return { initial, choices, events, worlds };
}

/** The same choice in another world: the pending event that carries the same thing, if any. */
export function rebind(spec: Spec, was: World, world: World, choice: Choice): Choice | null {
  if (choice.kind === "fire") {
    const pending = was.pending.find((p) => p.id === choice.pending);
    const same = pending && world.pending.find((p) => pendingText(p) === pendingText(pending));
    if (!same || !stepsTaking(spec, world, same).includes(choice.step)) return null;
    return { ...choice, pending: same.id };
  }
  const now = enabled(spec, world);
  if (choice.kind === "guard") return now.guards.some((g) => g.instance === choice.instance && g.key === choice.key) ? choice : null;
  const instance = world.instances.find((i) => i.id === choice.instance);
  if (!instance || !actorNamed(spec, instance.actor).actions[choice.key]) return null;
  return now.actions.some((a) => a.instance === choice.instance && a.key === choice.key) ? choice : null;
}

/** Whether a replayed path still breaks the property. */
function stillBreaks(spec: Spec, id: string, path: Counterexample): boolean {
  const property = spec.properties.find((p) => p.id === id)!;
  // A failed step breaks no property (see judge).
  if (property.kind === "always") return path.events.some((e) => !e.error && e.violations.includes(id));
  if (property.kind === "never") return !!safely(() => property.never(traceView(path.events)));
  if (property.kind === "everyStep") return path.events.some((e, i) => !e.error && stepBreaks(spec, path.worlds[i - 1] ?? path.initial, path.worlds[i], e, new Set()).includes(id));
  return false;
}

/** Drop steps one at a time while the property still breaks; at most `budget` replays. */
export function shrink(spec: Spec, initial: World, found: WalkFinding, replayed: Counterexample, budget = 400): Counterexample {
  let best = replayed;
  let tries = 0;
  let changed = true;
  while (changed && tries < budget) {
    changed = false;
    for (let i = best.choices.length - 1; i >= 0 && tries < budget; i--) {
      tries++;
      const keep = best.choices.map((_, n) => n !== i);
      const candidate = replayLoosely(spec, initial, best, keep);
      if (candidate.choices.length >= best.choices.length) continue;
      if (!stillBreaks(spec, found.id, candidate)) continue;
      best = candidate;
      changed = true;
    }
  }
  return best;
}
