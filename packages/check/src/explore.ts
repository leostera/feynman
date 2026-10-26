// The checker: a bounded breadth-first search over everything that can happen next, plus
// random runs that go deeper than the search can.
//
// From a world with the configured instances, each state branches on: every action on
// every instance (with inputs from its schema), every guarded transition that holds,
// every pending delivery (networks reorder), the earliest timer, and, within the fault
// budget, losing a delivery or restarting an instance. States are deduplicated by a
// canonical key (keys.ts), so breadth-first order finds the shortest counterexample.
//
// Three reductions keep every state the plain search would visit, and skip only work
// whose result is known:
// - Sleep sets: when two steps on different instances commute (neither reads anyone else,
//   moves the clock, or shares a counter with the other), both orders reach the same world,
//   so the second order is not tried again. A state reached later with fewer such steps
//   skipped is expanded again for the difference.
// - Inputs an action did not read: other values for them would do exactly the same.
// - Symmetry (keys.ts): interchangeable instances are renamed to one order.
import { observation, spawn, startWorld, type Event, type Observation, type Spec, type World } from "@feynman/spec";
import { canonical, NO_SYMMETRY, pendingText, symmetricKey, symmetryOf, type Symmetry } from "./keys.ts";
import { judge, verdicts } from "./judge.ts";
import { apply, branches, QUIET, replay, type Choice, type Counterexample } from "./steps.ts";
import { shrink, walk, type WalkResult } from "./walk.ts";

export { apply, branches, QUIET, replay, type Choice, type Counterexample } from "./steps.ts";
export { canonical } from "./keys.ts";

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
  /** Random runs to try before the search; they take at most a quarter of the time limit. */
  walks: number;
  /** Longest random run, in events. */
  walkDepth: number;
  /** Treat interchangeable instances of one actor as one (see keys.ts). */
  symmetry: boolean;
  /** Skip orders and inputs that cannot make a difference. Off only to compare. */
  reduce: boolean;
}

export const DEFAULT_BOUNDS: Bounds = {
  instances: {},
  depth: 14,
  faults: 1,
  maxStates: 300_000,
  timeLimit: 20_000,
  repeats: 2,
  walks: 2_000,
  walkDepth: 120,
  symmetry: true,
  reduce: true,
};

/** Merged twins whose next steps are compared, to test a symmetry claim. */
const TWIN_CHECKS = 2_000;

/** The keys of the worlds one step away, faults aside. */
function successors(spec: Spec, world: World, symmetry: Symmetry): Set<string> {
  const out = new Set<string>();
  for (const choice of branches(spec, world, false)) {
    const step = apply(spec, world, choice, QUIET);
    out.add(step.event.error ? `error:${step.event.error}` : symmetricKey(step.world, symmetry));
  }
  return out;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every((k) => b.has(k));
}

/** Share of the time limit random runs may use. */
const WALK_SHARE = 0.25;

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
  /** Who found the counterexample: the search (shortest), or a random run (shrunk, maybe not shortest). */
  foundBy?: "search" | "walk";
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
  /** Steps that ran somewhere, in the search or a random run. */
  coverage: { reached: string[]; missed: string[] };
  /** The random runs: how many, how many steps in all, and the longest. */
  walks: { runs: number; steps: number; deepest: number };
  /** What the reductions saved: steps not tried because their result was known. */
  reductions: {
    orders: number;
    inputs: number;
    symmetric: string[][];
    /** Actors declared symmetric whose instances turned out not to be; the search was redone without. */
    refuted?: string[];
  };
}

/** What one step did, as far as commuting with another step goes. */
interface Facts {
  /** The instance whose state it changes. */
  target: string;
  /** When it happens: a delivery or timer moves the clock to when it is due, if later. */
  time: number;
  /** Whether when it happens shows: it sends, starts a timer, or reads the clock. */
  timed: boolean;
  /** It fires a timer, which only the earliest timer may. */
  timer: boolean;
  /** It starts a timer, which may become the earliest. */
  starts: boolean;
  observed: Observation;
  failed: boolean;
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
  world: World;
  /** Steps not to try from here: another order already reaches what they would. */
  sleep: Map<string, Facts>;
  expanded: boolean;
}

/** A world to explore from besides the initial one, such as where a scenario ends. */
export interface Seed {
  name: string;
  world: World;
}

/**
 * Explore every interleaving within the bounds, from the initial world and from each seed
 * at once, breadth first, after a share of random runs. Seeding with where scenarios end puts
 * the search where the interesting states are, rather than spending its budget getting there.
 */
export function check(spec: Spec, bounds: Partial<Bounds> = {}, seeds: Seed[] = []): Report {
  const b: Bounds = { ...DEFAULT_BOUNDS, ...bounds, instances: { ...DEFAULT_BOUNDS.instances, ...bounds.instances } };
  const started = Date.now();
  const roots: { name?: string; world: World; symmetry: Symmetry }[] = [{ world: initialWorld(spec, b) }, ...seeds].map((r) => ({
    ...r,
    symmetry: b.symmetry ? symmetryOf(spec, r.world) : NO_SYMMETRY,
  }));
  const v = verdicts();
  const walked: WalkResult = b.walks > 0 ? walk(spec, roots.map((r) => r.world), b, v, started + b.timeLimit * WALK_SHARE) : { runs: 0, steps: 0, deepest: 0, findings: [], errors: [] };
  // The search judges afresh, so it finds the shortest counterexample even for what a run found.
  const search = verdicts();
  search.futures = v.futures;

  const nodes: Node[] = [];
  const seen = new Map<string, number>();
  const saved = { orders: 0, inputs: 0 };
  // A state is the world plus the budget spent getting there: actions repeated, faults used.
  const keyOf = (world: World, acts: Record<string, number>, faults: number, root: number) => `${symmetricKey(world, roots[root].symmetry)}${actsKey(acts)}|${faults}`;
  let frontier: { node: number; only?: Set<string> }[] = [];
  for (const [root, { world }] of roots.entries()) {
    const key = keyOf(world, {}, 0, root);
    if (seen.has(key)) continue;
    seen.set(key, nodes.length);
    nodes.push({ parent: -1, root, choice: null, event: null, depth: 0, faults: 0, acts: {}, world, sleep: new Map(), expanded: false });
    frontier.push({ node: nodes.length - 1 });
  }
  const failures = new Map<string, { node: number; then?: Event[] }>();
  const errors = new Map<string, number>();
  let depthReached = 0;
  let stoppedBy: Report["stoppedBy"];

  // Symmetry is a claim; test it on the twins the search merges: both must have the same next steps.
  let twinChecks = 0;
  let refuted = false;
  const twinsAgree = (a: World, b: World, root: number) => {
    // Twins at different times are also shifted in time; their next steps differ in when, not what.
    if (twinChecks >= TWIN_CHECKS || a.clock !== b.clock || canonical(a) === canonical(b)) return true;
    twinChecks++;
    return sameSet(successors(spec, a, roots[root].symmetry), successors(spec, b, roots[root].symmetry));
  };

  const examine = (index: number) => {
    const node = nodes[index];
    const { findings, error } = judge(spec, node.world, node.event, () => pathEvents(nodes, index), search);
    for (const f of findings) {
      search.broken.add(f.id);
      failures.set(f.id, { node: index, then: f.then });
    }
    if (error) {
      search.errors.add(error);
      errors.set(error, index);
    }
  };

  /** A state reached again: anything it skipped that this path did not is tried after all. */
  const revisit = (index: number, world: World, sleep: Map<string, Facts>, next: typeof frontier) => {
    const node = nodes[index];
    if (!node.sleep.size) return;
    // A renamed twin's step names do not match; wake everything rather than translate them.
    const same = !roots[node.root].symmetry.classes.length || canonical(world) === canonical(node.world);
    const woken = new Set([...node.sleep.keys()].filter((k) => !same || !sleep.has(k)));
    if (!woken.size) return;
    for (const k of woken) node.sleep.delete(k);
    if (node.expanded) next.push({ node: index, only: woken });
  };

  const expand = (index: number, only: Set<string> | undefined, next: typeof frontier): boolean => {
    const node = nodes[index];
    const world = node.world;
    const tried: [string, Facts][] = [];
    const inputsTried = new Map<string, { inputs: Record<string, unknown>; read: Set<string> }[]>();
    for (const choice of branches(spec, world, node.faults < b.faults)) {
      if (nodes.length >= b.maxStates) return (stoppedBy = "maxStates"), false;
      if (Date.now() - started > b.timeLimit) return (stoppedBy = "timeLimit"), false;
      const name = stepName(world, choice);
      if (only ? !only.has(name) : node.sleep.has(name)) {
        if (!only) saved.orders++;
        continue;
      }
      let acts = node.acts;
      if (choice.kind === "act") {
        const id = `${choice.instance}.${choice.key}`;
        if ((acts[id] ?? 0) >= b.repeats) continue;
        acts = { ...acts, [id]: (acts[id] ?? 0) + 1 };
        // An earlier try of this action read only inputs this one shares: same result.
        const twin = b.reduce && inputsTried.get(id)?.find((t) => [...t.read].every((k) => Object.is(t.inputs[k], choice.inputs[k])));
        if (twin) {
          saved.inputs++;
          continue;
        }
      }
      const observed = observation();
      const step = apply(spec, world, choice, { explain: false, observe: observed });
      if (choice.kind === "act") {
        const id = `${choice.instance}.${choice.key}`;
        inputsTried.set(id, [...(inputsTried.get(id) ?? []), { inputs: choice.inputs, read: observed.inputs }]);
      }
      const facts: Facts = {
        target: targetOf(world, choice),
        time: step.world.clock,
        timed: observed.readsNow || step.event.sent.length > 0 || step.event.started.length > 0,
        timer: step.event.kind === "timer",
        starts: step.event.started.length > 0,
        observed,
        failed: !!step.event.error,
      };
      // What the child need not try: what this node skipped or already tried, where it commutes with this step.
      const sleep = new Map<string, Facts>();
      if (b.reduce && !only) {
        for (const [k, f] of node.sleep) if (commute(f, facts)) sleep.set(k, f);
        for (const [k, f] of tried) if (commute(f, facts)) sleep.set(k, f);
      }
      tried.push([name, facts]);
      const faults = node.faults + (choice.kind === "lose" || choice.kind === "restart" ? 1 : 0);
      const key = keyOf(step.world, acts, faults, node.root);
      const existing = seen.get(key);
      if (existing !== undefined) {
        if (roots[node.root].symmetry.classes.length && !twinsAgree(nodes[existing].world, step.world, node.root)) return (refuted = true), false;
        if (b.reduce) revisit(existing, step.world, sleep, next);
        continue;
      }
      seen.set(key, nodes.length);
      nodes.push({ parent: index, root: node.root, choice, event: step.event, depth: node.depth + 1, faults, acts, world: step.world, sleep, expanded: false });
      depthReached = Math.max(depthReached, node.depth + 1);
      examine(nodes.length - 1);
      if (!step.event.error) next.push({ node: nodes.length - 1 });
    }
    node.expanded = true;
    return true;
  };

  for (const { node } of frontier) examine(node);
  search: while (frontier.length) {
    const next: typeof frontier = [];
    for (const { node: index, only } of frontier) {
      if (nodes[index].depth >= b.depth) continue;
      if (!expand(index, only, next)) break search;
    }
    frontier = next;
  }

  if (refuted) {
    const again = check(spec, { ...bounds, symmetry: false }, seeds);
    const classes = roots.flatMap((r) => r.symmetry.classes.map((c) => c.ids));
    const actors = [...new Set(classes.flatMap((ids) => ids.map((id) => roots[0].world.instances.find((i) => i.id === id)?.actor ?? id)))];
    return { ...again, durationMs: Date.now() - started, reductions: { ...again.reductions, refuted: actors } };
  }

  const counterexample = (index: number) => {
    const root = roots[nodes[index].root];
    return { ...replay(spec, root.world, pathChoices(nodes, index)), ...(root.name ? { from: root.name } : {}) };
  };
  const fromWalk = (id: string) => {
    const found = walked.findings.find((f) => f.id === id);
    if (!found) return undefined;
    const root = roots[found.root];
    const { path, then } = shrink(spec, root.world, found, replay(spec, root.world, found.choices));
    return { counterexample: { ...path, ...(root.name ? { from: root.name } : {}) }, then };
  };
  const properties: PropertyResult[] = spec.invariants.map((invariant) => {
    const base = { id: invariant.id, kind: invariant.kind, description: invariant.description, ...(invariant.kind === "eventually" ? { tested: (search.tested.get(invariant.id) ?? 0) + (v.tested.get(invariant.id) ?? 0) } : {}) };
    const found = failures.get(invariant.id);
    if (found) return { ...base, holds: false, counterexample: counterexample(found.node), ...(found.then ? { then: found.then } : {}), foundBy: "search" as const };
    const walkedTo = fromWalk(invariant.id);
    if (walkedTo) return { ...base, holds: false, counterexample: walkedTo.counterexample, ...(walkedTo.then ? { then: walkedTo.then } : {}), foundBy: "walk" as const };
    return { ...base, holds: true };
  });
  const walkErrors = walked.errors.filter((e) => !errors.has(e.message)).map((e) => ({ message: e.message, counterexample: replay(spec, roots[e.root].world, e.choices) }));
  const reached = new Set([...search.reached, ...v.reached]);
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
    errors: [...[...errors].map(([message, index]) => ({ message, counterexample: counterexample(index) })), ...walkErrors],
    coverage: { reached: all.filter((k) => reached.has(k)), missed: all.filter((k) => !reached.has(k)) },
    walks: { runs: walked.runs, steps: walked.steps, deepest: walked.deepest },
    reductions: { ...saved, symmetric: roots[0].symmetry.classes.map((c) => c.labels) },
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

// Commuting -------------------------------------------------------------------------------------------

/**
 * Whether two steps taken from one world reach the same world in either order. They must
 * change different instances, neither may read another instance, and they may not both use
 * a shared counter. Sends commute: a step never sees what is pending. Time: the clock ends
 * at the later of the two either way, but a step taken second runs at the other's time if
 * that is later, so that step must not show when it ran (send, start a timer, read now).
 * And neither may disable the other: only the earliest timer fires, so a timer does not
 * commute with a step that starts one.
 */
function commute(a: Facts, b: Facts): boolean {
  return (
    a.target !== b.target &&
    !a.failed &&
    !b.failed &&
    !a.observed.readsOthers &&
    !b.observed.readsOthers &&
    !(a.observed.shared && b.observed.shared) &&
    !(a.timer && b.starts) &&
    !(b.timer && a.starts) &&
    !(b.time > a.time && a.timed) &&
    !(a.time > b.time && b.timed)
  );
}

/** The instance a step changes. */
function targetOf(world: World, choice: Choice): string {
  if (choice.kind === "fire" || choice.kind === "lose") return world.pending.find((p) => p.id === choice.pending)!.to;
  return choice.instance;
}

/** A step's name that stays the same along a path while other steps run, independent of ids. */
function stepName(world: World, choice: Choice): string {
  switch (choice.kind) {
    case "act":
      return `a|${choice.instance}|${choice.key}|${JSON.stringify(choice.inputs)}`;
    case "guard":
      return `g|${choice.instance}|${choice.key}`;
    case "restart":
      return `r|${choice.instance}`;
    case "fire":
    case "lose": {
      const p = world.pending.find((x) => x.id === choice.pending)!;
      // When it is due, absolutely: along a path that never changes, while how soon does.
      // (Across paths it may differ for one state; then the names miss and more is tried.)
      return `${choice.kind[0]}|${p.at}|${pendingText(p)}`;
    }
  }
}

// Paths ----------------------------------------------------------------------------------------------

function actsKey(acts: Record<string, number>): string {
  return JSON.stringify(Object.entries(acts).sort(([a], [b]) => (a < b ? -1 : 1)));
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
