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
  type StepOptions,
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
  /**
   * For `eventually`: in how many explored worlds it was put to the test, its `after` holding
   * and the property not yet. Zero means exploration never got there, so holding says nothing.
   */
  tested?: number;
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
  const futures = new Map<string, Futures>();
  const tested = new Map<string, number>();
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
        tested.set(invariant.id, (tested.get(invariant.id) ?? 0) + 1);
        if (!futures.has(invariant.id)) futures.set(invariant.id, new Map());
        if (!neverWithin(spec, world, invariant.eventually, invariant.within, futures.get(invariant.id)!)) continue;
        // Found: run it again, explained, for the counterexample.
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
        const step = apply(spec, world, choice, QUIET);
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
      const times = tested.get(invariant.id) ?? 0;
      return found ? { ...base, holds: false, counterexample: counterexample(found.node), then: found.then, tested: times } : { ...base, holds: true, tested: times };
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

/** Exploring reads only the next world, errors, violations and what was sent; counterexamples are replayed in full. */
const QUIET: StepOptions = { explain: false };
/** Running by itself to check an `eventually` needs only the worlds. */
const SILENT: StepOptions = { explain: false, invariants: false };

export function apply(spec: Spec, world: World, choice: Choice, how?: StepOptions): Step {
  switch (choice.kind) {
    case "act":
      return act(spec, world, choice.instance, choice.key, choice.inputs, how);
    case "fire":
      return fire(spec, world, choice.pending, how);
    case "guard":
      return guard(spec, world, choice.instance, choice.key, how);
    case "lose":
      return lose(spec, world, choice.pending, how);
    case "restart":
      return restart(spec, world, choice.instance, how);
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

/** Each state's JSON, once: states are frozen and shared between worlds, so most are seen many times. */
const stateText = new WeakMap<object, string>();

function textOf(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  let text = stateText.get(value);
  if (text === undefined) stateText.set(value, (text = JSON.stringify(value)));
  return text;
}

/**
 * What the system does by itself from a world, per `eventually` property: how long until the
 * property holds, or that it does not for a while (or ever, once nothing is left to run).
 * The run by itself is deterministic, so every world on one such run shares its future, and
 * most explored worlds run into futures already seen. Keyed like deduplication, without
 * absolute time.
 */
type Future = { holdsAfter: number } | { notFor: number };
type Futures = Map<string, Future>;

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

/** What is pending, apart from when: entries are shared between worlds, so this is worked out once each. */
const pendingTexts = new WeakMap<object, string>();

function pendingText(p: World["pending"][number]): string {
  let text = pendingTexts.get(p);
  if (text === undefined) pendingTexts.set(p, (text = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${textOf(p.payload)}` : `t|${p.to}|${p.timer}`));
  return text;
}

/** A world's identity for deduplication: instances and what is pending, without ids or absolute times. */
export function canonical(world: World): string {
  const pending = world.pending
    .map((p) => `${p.at - world.clock}|${pendingText(p)}`)
    .sort();
  const instances = world.instances.map((i) => `${i.id}=${textOf(i.state)}`).join("\n");
  return `${instances}\n--\n${pending.join("\n")}\n--\n${JSON.stringify(world.fresh)}|${world.rng}`;
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
