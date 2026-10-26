// The checker: a bounded breadth-first search over everything that can happen next.
//
// From a world with the configured instances, each state branches on: every action on
// every instance (with inputs from its schema), every guarded transition that holds,
// every pending delivery (networks reorder), the earliest timer, and, within the fault
// budget, losing a delivery or restarting an instance. States are deduplicated by a
// canonical hash, so breadth-first order finds the shortest counterexample.
import {
  act,
  actorNamed,
  choices,
  fire,
  guard,
  holdsIn,
  lose,
  restart,
  spawn,
  startWorld,
  traceView,
  worldView,
  type Event,
  type Spec,
  type Step,
  type World,
} from "@feynman/spec";

export interface Bounds {
  /** Instances of each actor that is not a singleton (1 by default). */
  instances: Record<string, number>;
  /** Longest path explored, in events. */
  depth: number;
  /** Faults (lost deliveries, restarts) allowed on one path. */
  faults: number;
  /** Stop after this many distinct states. */
  maxStates: number;
  /** Stop after this long, in milliseconds. */
  timeLimit: number;
  /** Times one instance may take the same action on one path. */
  repeats: number;
}

export const DEFAULT_BOUNDS: Bounds = { instances: {}, depth: 14, faults: 1, maxStates: 300_000, timeLimit: 20_000, repeats: 2 };

export type Choice =
  | { kind: "act"; instance: string; key: string; inputs: Record<string, unknown> }
  | { kind: "fire"; pending: number }
  | { kind: "guard"; instance: string; key: string }
  | { kind: "lose"; pending: number }
  | { kind: "restart"; instance: string };

/** A path from the initial world, replayed with every world along it. */
export interface Counterexample {
  /** The scenario whose end the path starts from; none for the empty world. */
  from?: string;
  initial: World;
  choices: Choice[];
  events: Event[];
  worlds: World[];
}

export interface PropertyResult {
  id: string;
  kind: "always" | "eventually" | "never";
  description: string;
  holds: boolean;
  counterexample?: Counterexample;
  /** For `eventually`: the system running by itself from the end of the counterexample, never reaching the property. */
  then?: Event[];
}

export interface Report {
  spec: string;
  bounds: Bounds;
  states: number;
  /** How many scenario ends were explored from, besides the initial world. */
  seeds: number;
  /** Whether every state within the bounds was explored. */
  exhaustive: boolean;
  /** Why the search stopped early, when it did. */
  stoppedBy?: "maxStates" | "timeLimit";
  depthReached: number;
  durationMs: number;
  properties: PropertyResult[];
  /** Spec bugs met while exploring: an undeclared send, a message nobody handles. */
  errors: { message: string; counterexample: Counterexample }[];
  coverage: { reached: string[]; missed: string[] };
}

interface Node {
  parent: number;
  /** Which start this path begins at: 0 is the initial world, then each seed. */
  root: number;
  choice: Choice | null;
  event: Event | null;
  depth: number;
  faults: number;
  /** Actions taken on this path, by `instance.key`. */
  acts: Record<string, number>;
}

/** A search state: the world, plus how many times each action was taken on the way. */
function stateKey(world: World, acts: Record<string, number>): string {
  const counts = Object.entries(acts).sort(([a], [b]) => (a < b ? -1 : 1));
  return canonical(world) + JSON.stringify(counts);
}

/** A world to explore from besides the initial one, such as where a scenario ends. */
export interface Seed {
  name: string;
  world: World;
}

/**
 * Explore every interleaving within the bounds, from the initial world and from each seed
 * at once, breadth first. Seeding with where scenarios end puts the search where the
 * interesting states are, rather than spending its budget getting there.
 */
export function check(spec: Spec, bounds: Partial<Bounds> = {}, seeds: Seed[] = []): Report {
  const b: Bounds = { ...DEFAULT_BOUNDS, ...bounds, instances: { ...DEFAULT_BOUNDS.instances, ...bounds.instances } };
  const started = Date.now();
  const roots: { name?: string; world: World }[] = [{ world: initialWorld(spec, b) }, ...seeds];
  const nodes: Node[] = [];
  const seen = new Set<string>();
  let frontier: { node: number; world: World }[] = [];
  for (const [root, { world }] of roots.entries()) {
    const key = stateKey(world, {});
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({ parent: -1, root, choice: null, event: null, depth: 0, faults: 0, acts: {} });
    frontier.push({ node: nodes.length - 1, world });
  }
  const failures = new Map<string, number>();
  const errors = new Map<string, number>();
  const eventuallyChecked = new Map<string, { node: number; then: Event[] } | null>();
  const reached = new Set<string>();
  let depthReached = 0;
  let stoppedBy: Report["stoppedBy"];

  const examine = (index: number, world: World) => {
    const node = nodes[index];
    const event = node.event;
    if (event) {
      reached.add(`${event.actor}.${event.key}`);
      if (event.error && !errors.has(event.error)) errors.set(event.error, index);
      for (const id of event.violations) if (!failures.has(id)) failures.set(id, index);
    }
    for (const invariant of spec.invariants) {
      if (failures.has(invariant.id)) continue;
      if (invariant.kind === "never") {
        if (event && safely(() => invariant.never(traceView(pathEvents(nodes, index))))) failures.set(invariant.id, index);
      } else if (invariant.kind === "eventually") {
        if (eventuallyChecked.get(invariant.id)) continue;
        if (invariant.after && !holdsIn(spec, world, invariant.after)) continue;
        if (holdsIn(spec, world, invariant.eventually)) continue;
        const then = settles(spec, world, invariant.eventually, invariant.within);
        if (then) eventuallyChecked.set(invariant.id, { node: index, then });
      }
    }
  };

  for (const { node, world } of frontier) examine(node, world);
  search: while (frontier.length) {
    const next: typeof frontier = [];
    for (const { node: index, world } of frontier) {
      const node = nodes[index];
      if (node.depth >= b.depth) continue;
      for (const choice of branches(spec, world, node.faults < b.faults)) {
        if (nodes.length >= b.maxStates) {
          stoppedBy = "maxStates";
          break search;
        }
        if (Date.now() - started > b.timeLimit) {
          stoppedBy = "timeLimit";
          break search;
        }
        let acts = node.acts;
        if (choice.kind === "act") {
          const id = `${choice.instance}.${choice.key}`;
          if ((acts[id] ?? 0) >= b.repeats) continue;
          acts = { ...acts, [id]: (acts[id] ?? 0) + 1 };
        }
        const step = apply(spec, world, choice);
        const key = stateKey(step.world, acts);
        if (seen.has(key)) continue;
        seen.add(key);
        const faults = node.faults + (choice.kind === "lose" || choice.kind === "restart" ? 1 : 0);
        nodes.push({ parent: index, root: node.root, choice, event: step.event, depth: node.depth + 1, faults, acts });
        depthReached = Math.max(depthReached, node.depth + 1);
        examine(nodes.length - 1, step.world);
        if (!step.event.error) next.push({ node: nodes.length - 1, world: step.world });
      }
    }
    frontier = next;
  }

  const counterexample = (index: number) => {
    const root = roots[nodes[index].root];
    return { ...replay(spec, root.world, pathChoices(nodes, index)), ...(root.name ? { from: root.name } : {}) };
  };
  const properties: PropertyResult[] = spec.invariants.map((invariant) => {
    const base = { id: invariant.id, kind: invariant.kind, description: invariant.description };
    if (invariant.kind === "eventually") {
      const found = eventuallyChecked.get(invariant.id);
      return found ? { ...base, holds: false, counterexample: counterexample(found.node), then: found.then } : { ...base, holds: true };
    }
    const index = failures.get(invariant.id);
    return index === undefined ? { ...base, holds: true } : { ...base, holds: false, counterexample: counterexample(index) };
  });
  const all = allSteps(spec);
  return {
    spec: spec.name,
    bounds: b,
    seeds: seeds.length,
    states: nodes.length,
    exhaustive: !stoppedBy,
    stoppedBy,
    depthReached,
    durationMs: Date.now() - started,
    properties,
    errors: [...errors].map(([message, index]) => ({ message, counterexample: counterexample(index) })),
    coverage: { reached: all.filter((k) => reached.has(k)), missed: all.filter((k) => !reached.has(k)) },
  };
}

/** Singletons, plus the configured number of every other actor, labelled by actor: "Mac", or "Mac A", "Mac B"… */
export function initialWorld(spec: Spec, bounds: Pick<Bounds, "instances">): World {
  let world = startWorld(spec).at(-1)?.world ?? { clock: 0, seq: 0, fresh: {}, rng: 1, instances: [], pending: [] };
  for (const actor of spec.actors.filter((a) => !a.singleton)) {
    const count = bounds.instances[actor.name] ?? 1;
    for (let n = 0; n < count; n++) world = spawn(spec, world, actor.name, count === 1 ? actor.name : `${actor.name} ${String.fromCharCode(65 + n)}`).world;
  }
  return world;
}

/** Everything that can happen next from `world`. */
export function branches(spec: Spec, world: World, faultsLeft: boolean): Choice[] {
  const { actions, guards, pending } = choices(spec, world);
  const out: Choice[] = [];
  for (const action of actions) {
    const instance = world.instances.find((i) => i.id === action.instance)!;
    const info = actorNamed(spec, instance.actor).actions[action.key];
    for (const inputs of inputCombinations(spec, world, info.inputs)) out.push({ kind: "act", instance: action.instance, key: action.key, inputs });
  }
  for (const g of guards) out.push({ kind: "guard", instance: g.instance, key: g.key });
  const firstTimer = pending.find((p) => p.kind === "timer");
  for (const p of pending) if (p.kind === "deliver" || p === firstTimer) out.push({ kind: "fire", pending: p.id });
  if (faultsLeft) {
    for (const p of pending) if (p.kind === "deliver") out.push({ kind: "lose", pending: p.id });
    for (const instance of world.instances) if (!actorNamed(spec, instance.actor).singleton) out.push({ kind: "restart", instance: instance.id });
  }
  return out;
}

export function apply(spec: Spec, world: World, choice: Choice): Step {
  switch (choice.kind) {
    case "act":
      return act(spec, world, choice.instance, choice.key, choice.inputs);
    case "fire":
      return fire(spec, world, choice.pending);
    case "guard":
      return guard(spec, world, choice.instance, choice.key);
    case "lose":
      return lose(spec, world, choice.pending);
    case "restart":
      return restart(spec, world, choice.instance);
  }
}

export function replay(spec: Spec, initial: World, choices: Choice[]): Counterexample {
  const events: Event[] = [];
  const worlds: World[] = [];
  let world = initial;
  for (const choice of choices) {
    const step = apply(spec, world, choice);
    events.push(step.event);
    worlds.push(step.world);
    world = step.world;
  }
  return { initial, choices, events, worlds };
}

/** Values to try for each input: its examples, or a small set per type. At most 12 combinations. */
function inputCombinations(spec: Spec, world: World, inputs: Record<string, { type: string; values?: string[]; examples?: (w: never) => unknown[] }>): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const [name, input] of Object.entries(inputs)) {
    const values = input.examples
      ? dedupe(safely(() => input.examples!(worldView(spec, world) as never)) || [])
      : input.type === "choice"
        ? (input.values ?? [])
        : input.type === "number"
          ? [0, 1]
          : input.type === "boolean"
            ? [true, false]
            : ["", "x"];
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))).slice(0, 12);
  }
  return combos;
}

/** Most events one run by itself may take, so a looping spec cannot hang the checker. */
const SETTLE_LIMIT = 1000;

/**
 * Run the system by itself (no actions, no faults) for `within` milliseconds of simulated
 * time; the events, if `predicate` never holds in that time.
 */
function settles(spec: Spec, world: World, predicate: (w: never) => boolean, within: number): Event[] | null {
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

/** A world's identity for deduplication: instances and what is pending, without ids or absolute times. */
export function canonical(world: World): string {
  const pending = world.pending
    .map((p) => (p.kind === "deliver" ? ["d", p.at - world.clock, p.to, p.from, p.message, p.payload] : ["t", p.at - world.clock, p.to, p.timer]))
    .map((p) => JSON.stringify(p))
    .sort();
  return JSON.stringify([world.instances.map((i) => [i.id, i.state]), pending, world.fresh, world.rng]);
}

function pathChoices(nodes: Node[], index: number): Choice[] {
  const out: Choice[] = [];
  // Up to the path's start: a node with no parent (the initial world, or a seed).
  for (let i = index; nodes[i].parent >= 0; i = nodes[i].parent) out.push(nodes[i].choice!);
  return out.reverse();
}

function pathEvents(nodes: Node[], index: number): Event[] {
  const out: Event[] = [];
  for (let i = index; nodes[i].parent >= 0; i = nodes[i].parent) out.push(nodes[i].event!);
  return out.reverse();
}

function allSteps(spec: Spec): string[] {
  return spec.actors.flatMap((actor) => [...Object.keys(actor.actions), ...Object.keys(actor.transitions)].map((key) => `${actor.name}.${key}`));
}

function safely<T>(f: () => T): T | false {
  try {
    return f();
  } catch {
    return false;
  }
}

function dedupe(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = JSON.stringify(v);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
