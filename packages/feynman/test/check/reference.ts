// A reference explorer: the plainest breadth-first search over the engine's steps, written to
// be obviously right rather than fast. It shares none of the checker's search: no reductions,
// no symmetry, no caching, its own idea of when two worlds are the same, and its own judging.
// What it does share is the engine (the meaning of a step) and the setup the bounds describe:
// the initial instances, and which inputs an action is tried with.
//
// It answers, within the same bounds as the checker: which worlds are reachable, which
// `always` properties break and in how few steps, which errors a step can hit, which steps
// ever run, where the system gets stuck, and the verdict on each liveness property (by a
// fixpoint over sets of its own, not the checker's components). `never` and `everyStep`
// properties are left to the checker.
import { initialWorld } from "../../src/check/explore.ts";
import { inputCombinations } from "../../src/check/steps.ts";
import { act, actorNamed, choices, fire, guard, holdsIn, isLiveness, losable, lose, restart, type LivenessProperty, type Spec, type Step, type World } from "../../src/spec/index.ts";
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
  /** The world where nothing can happen, short of the final state, with the fewest faults, then steps. */
  stuck?: { events: number; faults: number };
  /** Each liveness property's verdict. */
  liveness: Map<string, "holds" | "broken" | "unfinished">;
}

/** A world in the graph: its successors (by index; -1 for a world past the depth bound) and the fair steps possible in it. */
type GraphNode = { world: World; acts: Record<string, number>; faults: number; depth: number; edges: { to: number; fair?: string }[]; enabled: Map<string, "weak" | "strong">; closed: boolean };

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
  const always = spec.properties.filter((p) => p.kind === "always");
  const result: ReferenceResult = { worlds: new Set(), broken: new Map(), errors: new Set(), reached: new Set(), liveness: new Map() };
  const graph: GraphNode[] = [];
  const index = new Map<string, number>();
  const add = (node: Node, depth: number) => {
    const key = worldKey(node.world, node.acts, node.faults);
    index.set(key, graph.length);
    graph.push({ ...node, depth, edges: [], enabled: enabledIn(spec, node.world), closed: false });
    return graph.length - 1;
  };

  type Node = { world: World; acts: Record<string, number>; faults: number };
  const judge = (node: Node, depth: number) => {
    for (const p of always) if (!result.broken.has(p.id) && !holdsIn(spec, node.world, p.always)) result.broken.set(p.id, depth);
  };

  const start: Node = { world: initialWorld(spec, bounds), acts: {}, faults: 0 };
  result.worlds.add(worldKey(start.world, start.acts, start.faults));
  judge(start, 0);
  let level = [add(start, 0)];

  for (let depth = 1; depth <= bounds.depth && level.length; depth++) {
    const next: number[] = [];
    for (const at of level) {
      for (const { step, acts, faults, fair } of successors(spec, graph[at], bounds)) {
        // Coverage is of the spec's steps; a lost message or a restart is not one.
        if (step.event.kind !== "lose" && step.event.kind !== "restart") result.reached.add(`${step.event.actor}.${step.event.key}`);
        if (step.event.error) {
          result.errors.add(step.event.error);
          continue;
        }
        const child = { world: step.world, acts, faults };
        const key = worldKey(child.world, acts, faults);
        if (!result.worlds.has(key)) {
          result.worlds.add(key);
          judge(child, depth);
          next.push(add(child, depth));
        }
        graph[at].edges.push({ to: index.get(key)!, ...(fair ? { fair } : {}) });
      }
      graph[at].closed = true;
    }
    level = next;
  }
  // The worlds at the depth bound: closed if every step from one lands on a known world.
  for (const at of level) {
    const edges: GraphNode["edges"] = [];
    let closed = true;
    for (const { step, acts, faults, fair } of successors(spec, graph[at], bounds)) {
      if (step.event.error) continue;
      const to = index.get(worldKey(step.world, acts, faults));
      if (to === undefined) closed = false;
      else edges.push({ to, ...(fair ? { fair } : {}) });
    }
    if (closed) Object.assign(graph[at], { edges, closed });
  }

  for (const node of graph) {
    const { actions, guards, pending } = choices(spec, node.world);
    const final = spec.finalState && holdsIn(spec, node.world, spec.finalState.when);
    if (actions.length || guards.length || pending.length || final) continue;
    const best = result.stuck;
    if (!best || node.faults < best.faults || (node.faults === best.faults && node.depth < best.events)) result.stuck = { events: node.depth, faults: node.faults };
  }
  for (const p of spec.properties) if (isLiveness(p)) result.liveness.set(p.id, livenessOf(spec, graph, p));
  return result;
}

/** The fair steps possible in a world: deliveries, timers and guards, weak unless the step says otherwise. */
function enabledIn(spec: Spec, world: World): Map<string, "weak" | "strong"> {
  const out = new Map<string, "weak" | "strong">();
  const { guards, pending } = choices(spec, world);
  for (const g of guards) {
    const f = fairOf(spec, world, g.instance, g.key, `g|${g.instance}|${g.key}`);
    if (f) out.set(f.id, f.kind);
  }
  for (const p of pending) {
    const f = fairOf(spec, world, p.to, p.kind === "deliver" ? p.message : p.timer, idOf(p));
    if (f) out.set(f.id, f.kind);
  }
  return out;
}

function idOf(p: World["pending"][number]): string {
  return p.kind === "deliver" ? `d|${sortedJson([p.to, p.from, p.message, p.payload])}` : `t|${p.to}|${p.timer}`;
}

function fairOf(spec: Spec, world: World, instance: string, key: string, id: string): { id: string; kind: "weak" | "strong" } | undefined {
  const actor = world.instances.find((i) => i.id === instance)!.actor;
  const fair = actorNamed(spec, actor).transitions[key]?.fair;
  return fair === false ? undefined : { id, kind: fair ?? "weak" };
}

/**
 * Is there a fair behaviour that breaks the property? The behaviours that might: those that
 * stay, from some point, among the worlds `inside` allows. Of those worlds, keep pruning
 * (to a fixpoint) each strongly connected set that owes a weak step (possible in all of it,
 * taken nowhere in it: drop it all) or a strong one (possible somewhere, never taken: drop
 * the worlds where it is possible). A set that owes nothing is fair; it breaks the property
 * if `bad` says so. A world staying put forever is a set of its own.
 */
function livenessOf(spec: Spec, graph: GraphNode[], p: LivenessProperty): "holds" | "broken" | "unfinished" {
  const holds = (pred: (w: never) => boolean) => graph.map((n) => holdsIn(spec, n.world, pred as never));
  const all = graph.map((_, i) => i);
  let from: number[];
  let inside: (i: number) => boolean;
  let bad: (set: number[]) => boolean = () => true;
  if (p.kind === "eventually") {
    const q = holds(p.eventually);
    inside = (i) => !q[i];
    from = [0];
  } else if (p.kind === "leadsTo") {
    const [w, q] = [holds(p.whenever), holds(p.then)];
    inside = (i) => !q[i];
    from = all.filter((i) => w[i]);
  } else if (p.kind === "infinitelyOften") {
    const q = holds(p.infinitelyOften);
    inside = (i) => !q[i];
    from = all;
  } else {
    const q = holds(p.eventuallyAlways);
    inside = () => true;
    from = all;
    bad = (set) => set.some((i) => !q[i]);
  }
  const region = reach(graph, from.filter(inside), inside);
  const open = [...region].some((i) => !graph[i].closed);
  let alive = new Set([...region].filter((i) => graph[i].closed));
  // Prune one strongly connected set at a time, until a pass prunes nothing.
  for (let changed = true; changed; ) {
    changed = false;
    for (const i of alive) {
      const set = [...reach(graph, [i], (j) => alive.has(j))].filter((j) => reach(graph, [j], (k) => alive.has(k)).has(i));
      const members = new Set(set);
      const taken = new Set(set.flatMap((j) => graph[j].edges.filter((e) => e.fair && members.has(e.to)).map((e) => e.fair!)));
      const owed = new Set(set.flatMap((j) => [...graph[j].enabled].filter(([id]) => !taken.has(id)).map(([id, kind]) => `${kind}|${id}`)));
      const weak = [...owed].filter((o) => o.startsWith("weak|")).map((o) => o.slice(5)).find((id) => set.every((j) => graph[j].enabled.has(id)));
      const strong = [...owed].filter((o) => o.startsWith("strong|")).map((o) => o.slice(7));
      if (weak !== undefined) alive = new Set([...alive].filter((j) => !members.has(j)));
      else if (strong.length) alive = new Set([...alive].filter((j) => !members.has(j) || !strong.some((id) => graph[j].enabled.has(id))));
      else if (bad(set)) return "broken";
      else continue;
      changed = true;
      break;
    }
  }
  return open ? "unfinished" : "holds";
}

/** The worlds reachable from `from` through worlds `inside` allows (past the depth bound, a world leads nowhere known). */
function reach(graph: GraphNode[], from: number[], inside: (i: number) => boolean): Set<number> {
  const seen = new Set(from);
  const queue = [...from];
  while (queue.length) {
    const i = queue.pop()!;
    if (!graph[i].closed) continue;
    for (const e of graph[i].edges) if (inside(e.to) && !seen.has(e.to)) seen.add(e.to), queue.push(e.to);
  }
  return seen;
}

/** Every step from a world the bounds allow, with the counters after it. */
function successors(spec: Spec, node: { world: World; acts: Record<string, number>; faults: number }, bounds: ReferenceBounds): { step: Step; acts: Record<string, number>; faults: number; fair?: string }[] {
  const { world, acts, faults } = node;
  const out: { step: Step; acts: Record<string, number>; faults: number; fair?: string }[] = [];
  const { actions, guards, pending } = choices(spec, world);
  for (const a of actions) {
    const id = `${a.instance}.${a.key}`;
    if ((acts[id] ?? 0) >= bounds.repeats) continue;
    const instance = world.instances.find((i) => i.id === a.instance)!;
    const info = actorNamed(spec, instance.actor).actions[a.key];
    for (const inputs of inputCombinations(spec, world, info.inputs)) out.push({ step: act(spec, world, a.instance, a.key, inputs), acts: { ...acts, [id]: (acts[id] ?? 0) + 1 }, faults });
  }
  for (const g of guards) out.push({ step: guard(spec, world, g.instance, g.key), acts, faults, fair: fairOf(spec, world, g.instance, g.key, `g|${g.instance}|${g.key}`)?.id });
  for (const p of pending) out.push({ step: fire(spec, world, p.id), acts, faults, fair: fairOf(spec, world, p.to, p.kind === "deliver" ? p.message : p.timer, idOf(p))?.id });
  if (faults < bounds.faults) {
    for (const p of pending) if (losable(p)) out.push({ step: lose(spec, world, p.id), acts, faults: faults + 1 });
    for (const i of world.instances) if (!actorNamed(spec, i.actor).singleton) out.push({ step: restart(spec, world, i.id), acts, faults: faults + 1 });
  }
  return out;
}
