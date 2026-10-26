// Random runs: long, cheap paths through the system, alongside the breadth-first search.
//
// The search proves things up to its depth; random runs go much deeper and find bugs the
// search cannot reach, but prove nothing. Each run is seeded, so runs are reproducible, and
// a broken property's run is shrunk to the fewest steps that still break it.
import { actorNamed, choices as enabled, holdsIn, traceView, type Event, type Spec, type World } from "../spec/index.ts";
import { pendingText } from "./keys.ts";
import { judge, safely, settles, type Verdicts } from "./judge.ts";
import { apply, branches, QUIET, type Choice, type Counterexample } from "./steps.ts";
import type { Bounds } from "./explore.ts";

export interface WalkFinding {
  id: string;
  root: number;
  choices: Choice[];
  then?: Event[];
}

export interface WalkResult {
  runs: number;
  steps: number;
  deepest: number;
  findings: WalkFinding[];
  errors: { message: string; root: number; choices: Choice[] }[];
}

/** How often a run picks each kind of step, when it can: mostly the system, some people, rare faults. */
const WEIGHTS = { system: 0.6, people: 0.32, faults: 0.08 };

export function walk(spec: Spec, roots: World[], b: Bounds, v: Verdicts, until: number): WalkResult {
  const out: WalkResult = { runs: 0, steps: 0, deepest: 0, findings: [], errors: [] };
  for (let run = 0; run < b.walks && Date.now() < until; run++) {
    const root = run % roots.length;
    const random = seeded(run + 1);
    let world = roots[root];
    let faults = 0;
    const acts: Record<string, number> = {};
    const path: Choice[] = [];
    const events: Event[] = [];
    for (let depth = 0; depth < b.walkDepth; depth++) {
      const options = branches(spec, world, faults < b.faults).filter((c) => c.kind !== "act" || (acts[`${c.instance}.${c.key}`] ?? 0) < b.repeats * 2);
      const choice = pick(options, random);
      if (!choice) break;
      if (choice.kind === "act") acts[`${choice.instance}.${choice.key}`] = (acts[`${choice.instance}.${choice.key}`] ?? 0) + 1;
      if (choice.kind === "lose" || choice.kind === "restart") faults++;
      const step = apply(spec, world, choice, QUIET);
      path.push(choice);
      events.push(step.event);
      out.steps++;
      out.deepest = Math.max(out.deepest, path.length);
      const { findings, error } = judge(spec, step.world, step.event, () => events, v);
      for (const f of findings) {
        v.broken.add(f.id);
        out.findings.push({ id: f.id, root, choices: [...path], then: f.then });
      }
      if (error) {
        v.errors.add(error);
        out.errors.push({ message: error, root, choices: [...path] });
      }
      if (step.event.error) break;
      world = step.world;
    }
    out.runs++;
  }
  return out;
}

function pick(options: Choice[], random: () => number): Choice | undefined {
  const groups = {
    system: options.filter((c) => c.kind === "fire" || c.kind === "guard"),
    people: options.filter((c) => c.kind === "act"),
    faults: options.filter((c) => c.kind === "lose" || c.kind === "restart"),
  };
  const kinds = (Object.keys(groups) as (keyof typeof groups)[]).filter((k) => groups[k].length);
  if (!kinds.length) return undefined;
  const total = kinds.reduce((sum, k) => sum + WEIGHTS[k], 0);
  let roll = random() * total;
  const kind = kinds.find((k) => (roll -= WEIGHTS[k]) < 0) ?? kinds.at(-1)!;
  const group = groups[kind];
  return group[Math.floor(random() * group.length)];
}

/** mulberry32: small, fast, and the same everywhere. */
function seeded(seed: number): () => number {
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
function rebind(spec: Spec, was: World, world: World, choice: Choice): Choice | null {
  if (choice.kind === "fire" || choice.kind === "lose") {
    const pending = was.pending.find((p) => p.id === choice.pending);
    const same = pending && world.pending.find((p) => pendingText(p) === pendingText(pending));
    return same ? { ...choice, pending: same.id } : null;
  }
  if (choice.kind === "restart") return world.instances.some((i) => i.id === choice.instance) ? choice : null;
  const now = enabled(spec, world);
  if (choice.kind === "guard") return now.guards.some((g) => g.instance === choice.instance && g.key === choice.key) ? choice : null;
  const instance = world.instances.find((i) => i.id === choice.instance);
  if (!instance || !actorNamed(spec, instance.actor).actions[choice.key]) return null;
  return now.actions.some((a) => a.instance === choice.instance && a.key === choice.key) ? choice : null;
}

/** Whether a replayed path still breaks the property, judged at its end. */
function stillBreaks(spec: Spec, id: string, path: Counterexample): { then?: Event[] } | null {
  const invariant = spec.invariants.find((i) => i.id === id)!;
  const end = path.worlds.at(-1) ?? path.initial;
  if (invariant.kind === "always") return path.events.some((e) => e.violations.includes(id)) ? {} : null;
  if (invariant.kind === "never") return safely(() => invariant.never(traceView(path.events))) ? {} : null;
  if (invariant.after && !holdsIn(spec, end, invariant.after)) return null;
  if (holdsIn(spec, end, invariant.eventually)) return null;
  const then = settles(spec, end, invariant.eventually, invariant.within);
  return then ? { then } : null;
}

/** Drop steps one at a time while the property still breaks; at most `budget` replays. */
export function shrink(spec: Spec, initial: World, found: WalkFinding, replayed: Counterexample, budget = 400): { path: Counterexample; then?: Event[] } {
  let best = replayed;
  let then = found.then;
  let tries = 0;
  let changed = true;
  while (changed && tries < budget) {
    changed = false;
    for (let i = best.choices.length - 1; i >= 0 && tries < budget; i--) {
      tries++;
      const keep = best.choices.map((_, n) => n !== i);
      const candidate = replayLoosely(spec, initial, best, keep);
      if (candidate.choices.length >= best.choices.length) continue;
      const result = stillBreaks(spec, found.id, candidate);
      if (!result) continue;
      best = candidate;
      then = result.then ?? then;
      changed = true;
    }
  }
  return { path: best, then };
}
