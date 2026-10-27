// A reference explorer: the plainest breadth-first search over the engine's steps, written to
// be obviously right rather than fast. It shares none of the checker's search: no reductions,
// no symmetry, no caching, its own idea of when two worlds are the same, and its own judging.
// What it does share is the engine (the meaning of a step) and the setup the bounds describe:
// the initial instances, and which inputs an action is tried with.
//
// It answers, within the same bounds as the checker: which worlds are reachable, which
// `always` properties break and in how few steps, which errors a step can hit, and which
// steps ever run. `never` and `eventually` properties are left to the checker.
import { initialWorld } from "../../src/check/explore.ts";
import { inputCombinations } from "../../src/check/steps.ts";
import { act, actorNamed, choices, fire, guard, holdsIn, lose, restart, type Spec, type Step, type World } from "../../src/spec/index.ts";
import { sortedJson } from "../../src/spec/json.ts";

export interface ReferenceBounds {
  depth: number;
  faults: number;
  repeats: number;
  instances: Record<string, number>;
}

export interface ReferenceResult {
  /** Every reachable world, as `worldKey` writes it. */
  worlds: Set<string>;
  /** For each `always` property that breaks, the fewest steps to a world where it does. */
  broken: Map<string, number>;
  errors: Set<string>;
  reached: Set<string>;
}

/** What a world is, for this explorer: states, messages in flight as a bag, which timers are set, and the counters the bounds read. */
export function worldKey(world: World, acts: Record<string, number>, faults: number): string {
  return sortedJson({
    instances: world.instances.map((i) => [i.id, i.state]),
    messages: world.pending.filter((p) => p.kind === "deliver").map((p) => sortedJson([p.to, p.from, p.message, p.payload])).sort(),
    timers: world.pending.filter((p) => p.kind === "timer").map((p) => `${p.to}|${p.timer}`).sort(),
    fresh: world.fresh,
    rng: world.rng,
    acts,
    faults,
  });
}

export function explore(spec: Spec, bounds: ReferenceBounds): ReferenceResult {
  const always = spec.invariants.filter((p) => p.kind === "always");
  const result: ReferenceResult = { worlds: new Set(), broken: new Map(), errors: new Set(), reached: new Set() };

  type Node = { world: World; acts: Record<string, number>; faults: number };
  const judge = (node: Node, depth: number) => {
    for (const p of always) if (!result.broken.has(p.id) && !holdsIn(spec, node.world, p.always)) result.broken.set(p.id, depth);
  };

  const start: Node = { world: initialWorld(spec, bounds), acts: {}, faults: 0 };
  result.worlds.add(worldKey(start.world, start.acts, start.faults));
  judge(start, 0);
  let level = [start];

  for (let depth = 1; depth <= bounds.depth && level.length; depth++) {
    const next: Node[] = [];
    for (const node of level) {
      for (const { step, acts, faults } of successors(spec, node, bounds)) {
        // Coverage is of the spec's steps; a lost message or a restart is not one.
        if (step.event.kind !== "lose" && step.event.kind !== "restart") result.reached.add(`${step.event.actor}.${step.event.key}`);
        if (step.event.error) {
          result.errors.add(step.event.error);
          continue;
        }
        const child = { world: step.world, acts, faults };
        const key = worldKey(child.world, acts, faults);
        if (result.worlds.has(key)) continue;
        result.worlds.add(key);
        judge(child, depth);
        next.push(child);
      }
    }
    level = next;
  }
  return result;
}

/** Every step from a world the bounds allow, with the counters after it. */
function successors(spec: Spec, node: { world: World; acts: Record<string, number>; faults: number }, bounds: ReferenceBounds): { step: Step; acts: Record<string, number>; faults: number }[] {
  const { world, acts, faults } = node;
  const out: { step: Step; acts: Record<string, number>; faults: number }[] = [];
  const { actions, guards, pending } = choices(spec, world);
  for (const a of actions) {
    const id = `${a.instance}.${a.key}`;
    if ((acts[id] ?? 0) >= bounds.repeats) continue;
    const instance = world.instances.find((i) => i.id === a.instance)!;
    const info = actorNamed(spec, instance.actor).actions[a.key];
    for (const inputs of inputCombinations(spec, world, info.inputs)) out.push({ step: act(spec, world, a.instance, a.key, inputs), acts: { ...acts, [id]: (acts[id] ?? 0) + 1 }, faults });
  }
  for (const g of guards) out.push({ step: guard(spec, world, g.instance, g.key), acts, faults });
  for (const p of pending) out.push({ step: fire(spec, world, p.id), acts, faults });
  if (faults < bounds.faults) {
    for (const p of pending) if (p.kind === "deliver") out.push({ step: lose(spec, world, p.id), acts, faults: faults + 1 });
    for (const i of world.instances) if (!actorNamed(spec, i.actor).singleton) out.push({ step: restart(spec, world, i.id), acts, faults: faults + 1 });
  }
  return out;
}
