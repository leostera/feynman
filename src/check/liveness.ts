// Liveness (RFD0006): judged after exploring, on the graph of explored worlds.
//
// A liveness property fails when some fair infinite behaviour avoids what it asks for. Every
// infinite behaviour in a finite graph ends in a strongly connected component it never
// leaves, so the search is for a component that the behaviour may stay in, the property
// allows it to stay in, and fairness lets it stay in:
//
// - Every world may stutter (stay put), so every world is a loop of its own; fairness is
//   what stops a behaviour stuttering where a fair step is possible.
// - A component is fair when every weakly fair step possible in all its worlds is taken on
//   an edge inside it, and every strongly fair step possible in any of its worlds is too. A
//   component unfair only for a strong step may have a fair part without the worlds where
//   that step is possible: those are removed, and what is left split again (Emerson-Lei).
//
// Only expanded worlds have known successors. A component is judged among them; when no fair
// one is found but the region the property allows reaches an unexpanded world (cut off by
// the depth bound), the verdict is unfinished.
//
// A predicate that throws in a world (it looks at an instance not there yet) is false there:
// a goal not yet reachable is not reached.
import { holdsIn, type Fairness, type PropertyInfo, type Spec, type World, type WorldView } from "../spec/index.ts";
import type { Choice } from "./steps.ts";

/** A step on the graph: where it goes, the choice that takes it, and its fairness identity, if fair. */
export interface Edge {
  to: number;
  choice: Choice;
  fair?: string;
}

/** What the search hands over: for each node, its world, whether its successors are known, its edges, and the fair steps possible there. */
export interface Graph {
  worlds: World[];
  roots: number[];
  /** Root 0's node: where behaviours begin, for `eventually`. */
  initial: number;
  expanded: boolean[];
  /** Nodes that stand only for a counterexample's last step (errors, broken steps): not part of the graph. */
  shadow: boolean[];
  edges: Edge[][];
  /** Fair steps possible in each node, by identity. */
  enabled: Map<string, Fairness>[];
  /** A path from a root to each node, as the search found it. */
  parent: number[];
  /** The choice from the parent, per node. */
  choiceFrom: (Choice | null)[];
}

/** A step of a lasso: the node it is taken in, and the choice. */
export interface LassoStep {
  from: number;
  choice: Choice;
}

export interface Lasso {
  /** The root the way in starts at. */
  root: number;
  prefix: LassoStep[];
  /** Repeated forever; empty when the behaviour stays in the last world. */
  loop: LassoStep[];
}

export type LivenessVerdict = { holds: true; unfinished: boolean; tested?: number } | { holds: false; lasso: Lasso; tested?: number };

type Liveness = Extract<PropertyInfo, { kind: "eventually" | "leadsTo" | "infinitelyOften" | "eventuallyAlways" }>;

/**
 * What to look for, for one property: behaviours that start at a node in `starts`, stay among
 * the `allowed` nodes, and settle in a fair part that `accepts` calls bad (passing `mustVisit`
 * of it, for `eventuallyAlways`).
 */
interface LivenessSearch {
  starts: number[];
  allowed: (node: number) => boolean;
  accepts: (part: number[]) => boolean;
  mustVisit?: (part: number[]) => number | undefined;
  /** For `leadsTo`: how many worlds put it to the test. */
  tested?: number;
}

export function judgeLiveness(spec: Spec, graph: Graph, property: Liveness): LivenessVerdict {
  const search = searchFor(property, graph, (predicate) => memo(spec, graph, predicate));
  const { members, way, cost, open } = region(graph, search.starts, search.allowed);
  const judged = (i: number) => members.has(i) && graph.expanded[i];
  // Of the bad fair parts, the one cheapest to reach, entered at its cheapest world.
  let best: { part: number[]; entry: number; cost: number } | undefined;
  for (const component of components(graph, [...members].filter(judged), judged)) {
    for (const part of fairParts(graph, component)) {
      if (!search.accepts(part)) continue;
      const entry = part.reduce((a, b) => (cost.get(b)! < cost.get(a)! ? b : a));
      if (!best || cost.get(entry)! < best.cost) best = { part, entry, cost: cost.get(entry)! };
    }
  }
  const tested = search.tested === undefined ? {} : { tested: search.tested };
  if (!best) return { holds: true, unfinished: open, ...tested };
  const loop = fairLoop(graph, new Set(best.part), best.entry, search.mustVisit?.(best.part));
  return { holds: false, lasso: { ...wayIn(graph, best.entry, way), loop }, ...tested };
}

/** Each kind of liveness property as a search for a bad fair part. */
function searchFor(property: Liveness, graph: Graph, holds: (predicate: (w: WorldView) => boolean) => (node: number) => boolean): LivenessSearch {
  const live = range(graph.worlds.length).filter((i) => !graph.shadow[i]);
  const always = () => true;
  switch (property.kind) {
    case "eventually": {
      // From the start, never reaching it.
      const q = holds(property.eventually);
      return { starts: q(graph.initial) ? [] : [graph.initial], allowed: (i) => !q(i), accepts: always };
    }
    case "leadsTo": {
      // From a world where `whenever` holds and `then` does not, never reaching `then`.
      const [p, q] = [holds(property.whenever), holds(property.then)];
      const starts = live.filter((i) => p(i) && !q(i));
      return { starts, allowed: (i) => !q(i), accepts: always, tested: starts.length };
    }
    case "infinitelyOften": {
      // From some point on, never holding again.
      const q = holds(property.infinitelyOften);
      return { starts: live.filter((i) => !q(i)), allowed: (i) => !q(i), accepts: always };
    }
    case "eventuallyAlways": {
      // Failing again and again: a fair part with a world where it fails.
      const q = holds(property.eventuallyAlways);
      const failing = (part: number[]) => part.find((i) => !q(i));
      return { starts: graph.roots, allowed: always, accepts: (part) => failing(part) !== undefined, mustVisit: failing };
    }
  }
}

/** A predicate on worlds, evaluated once per node. */
function memo(spec: Spec, graph: Graph, predicate: (w: WorldView) => boolean): (node: number) => boolean {
  const cache = new Map<number, boolean>();
  return (i) => {
    let value = cache.get(i);
    if (value === undefined) cache.set(i, (value = holdsIn(spec, graph.worlds[i], predicate)));
    return value;
  };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

// The region a behaviour may be in ----------------------------------------------------------

/** Fault steps cost more than any number of others: counterexamples need the fewest faults first, then the fewest steps. */
const FAULT = 1_000_000;
const costOf = (choice: Choice | null) => (choice?.kind === "lose" || choice?.kind === "restart" ? FAULT : 1);

/** An edge taken from a node. */
interface Hop {
  from: number;
  edge: Edge;
}

/**
 * Nodes reachable from `starts` through allowed nodes, with the cheapest way to each: the
 * search's path to a start, then hops through the region (`way`: the hop into each node that
 * is not a start). And whether an unexpanded node is among them.
 */
function region(graph: Graph, starts: number[], allowed: (i: number) => boolean) {
  const cost = new Map<number, number>();
  const way = new Map<number, Hop>();
  const heap = new Heap();
  const pathCost = searchPathCosts(graph);
  for (const s of starts) {
    if (graph.shadow[s] || !allowed(s) || cost.has(s)) continue;
    cost.set(s, pathCost[s]);
    heap.push(pathCost[s], s);
  }
  const members = new Set<number>();
  let open = false;
  while (heap.size) {
    const [c, i] = heap.pop();
    if (members.has(i) || c > cost.get(i)!) continue;
    members.add(i);
    if (!graph.expanded[i]) {
      open = true;
      continue;
    }
    for (const edge of graph.edges[i]) {
      if (graph.shadow[edge.to] || !allowed(edge.to) || members.has(edge.to)) continue;
      const next = c + costOf(edge.choice);
      if (next >= (cost.get(edge.to) ?? Infinity)) continue;
      cost.set(edge.to, next);
      way.set(edge.to, { from: i, edge });
      heap.push(next, edge.to);
    }
  }
  return { members, way, cost, open };
}

/** What the search's path to each node costs. Parents come before their children. */
function searchPathCosts(graph: Graph): Float64Array {
  const out = new Float64Array(graph.worlds.length);
  for (let i = 0; i < out.length; i++) out[i] = graph.parent[i] < 0 ? 0 : out[graph.parent[i]] + costOf(graph.choiceFrom[i]);
  return out;
}

/** A binary min-heap of (cost, node). */
class Heap {
  private items: [number, number][] = [];
  get size() {
    return this.items.length;
  }
  push(cost: number, node: number) {
    const a = this.items;
    a.push([cost, node]);
    for (let i = a.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (a[up][0] <= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.items;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

// Fair parts --------------------------------------------------------------------------------

/** Strongly connected components of the subgraph of `nodes` (Tarjan, iterative). */
function components(graph: Graph, nodes: number[], inside: (i: number) => boolean): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  const visit = (node: number) => {
    index.set(node, counter);
    low.set(node, counter++);
    stack.push(node);
    onStack.add(node);
  };
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: number; edge: number }[] = [{ node: root, edge: 0 }];
    visit(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = graph.edges[frame.node];
      if (frame.edge < edges.length) {
        const to = edges[frame.edge++].to;
        if (!inside(to)) continue;
        if (!index.has(to)) {
          visit(to);
          work.push({ node: to, edge: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const up = work[work.length - 1].node;
        low.set(up, Math.min(low.get(up)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: number[] = [];
      let top: number;
      do {
        top = stack.pop()!;
        onStack.delete(top);
        component.push(top);
      } while (top !== frame.node);
      out.push(component);
    }
  }
  return out;
}

/** The fair steps taken on edges inside a set of nodes. */
function takenWithin(graph: Graph, members: Set<number>): Set<string> {
  const taken = new Set<string>();
  for (const i of members) for (const e of graph.edges[i]) if (e.fair && members.has(e.to)) taken.add(e.fair);
  return taken;
}

/** The fair parts of a component (Emerson-Lei): itself if fair; none if a weak step is owed; else the fair parts of what is left without the worlds owing a strong step. */
function fairParts(graph: Graph, component: number[]): number[][] {
  const members = new Set(component);
  const taken = takenWithin(graph, members);
  // A weak step possible in every world of the component, never taken in it: no part of it is fair.
  const [first, ...rest] = component;
  for (const [id, kind] of graph.enabled[first]) {
    if (kind === "weak" && !taken.has(id) && rest.every((i) => graph.enabled[i].has(id))) return [];
  }
  const owedStrong = new Set<string>();
  for (const i of component) for (const [id, kind] of graph.enabled[i]) if (kind === "strong" && !taken.has(id)) owedStrong.add(id);
  if (!owedStrong.size) return [component];
  const keep = component.filter((i) => ![...owedStrong].some((id) => graph.enabled[i].has(id)));
  const kept = new Set(keep);
  return components(graph, keep, (i) => kept.has(i)).flatMap((part) => fairParts(graph, part));
}

// The counterexample ------------------------------------------------------------------------

/** The way into a fair part: the search's path to the start that reached its entry, then the hops through the region. */
function wayIn(graph: Graph, entry: number, way: Map<number, Hop>): Omit<Lasso, "loop"> {
  const hops: Hop[] = [];
  let start = entry;
  for (let hop = way.get(start); hop; hop = way.get(start)) {
    hops.unshift(hop);
    start = hop.from;
  }
  const searchPath: number[] = [];
  for (let i = start; i >= 0; i = graph.parent[i]) searchPath.unshift(i);
  const prefix: LassoStep[] = searchPath.slice(1).map((node, k) => ({ from: searchPath[k], choice: graph.choiceFrom[node]! }));
  return { root: searchPath[0], prefix: [...prefix, ...hops.map(stepOf)] };
}

const stepOf = (hop: Hop): LassoStep => ({ from: hop.from, choice: hop.edge.choice });

/** A point the loop must go through: a world to pass, or an edge to take. */
type Waypoint = { node: number } | Hop;

/**
 * A short fair loop from `entry` inside a fair part. It starts as staying put, and gains a
 * waypoint for each fair step it still owes: a weak step possible in all its worlds and never
 * taken (take it, or pass a world where it is not possible), or a strong step possible in one
 * of its worlds and never taken (take it). Waypoints are kept, so a step once paid stays paid,
 * and each step gains at most one: the loop is done in at most one round per fair step. The
 * part is fair, so every step owed can be paid within it.
 */
function fairLoop(graph: Graph, members: Set<number>, entry: number, mustVisit: number | undefined): LassoStep[] {
  const waypoints: Waypoint[] = mustVisit === undefined || mustVisit === entry ? [] : [{ node: mustVisit }];
  const fairSteps = new Set([...members].flatMap((i) => [...graph.enabled[i].keys()]));
  for (let round = 0; round <= fairSteps.size; round++) {
    const loop = through(graph, members, entry, waypoints);
    const owed = owedBy(graph, entry, loop);
    if (owed === undefined) return loop.map(stepOf);
    waypoints.push(payment(graph, members, owed));
  }
  throw new Error(`a fair loop owes more fair steps than its part has (${fairSteps.size}): the part is not fair`);
}

/** A loop from `entry` through each waypoint in turn and back, by shortest paths within `members`. */
function through(graph: Graph, members: Set<number>, entry: number, waypoints: Waypoint[]): Hop[] {
  const out: Hop[] = [];
  let at = entry;
  for (const w of waypoints) {
    if ("node" in w) {
      out.push(...pathWithin(graph, members, at, w.node));
      at = w.node;
    } else {
      out.push(...pathWithin(graph, members, at, w.from), w);
      at = w.edge.to;
    }
  }
  out.push(...pathWithin(graph, members, at, entry));
  return out;
}

/** A fair step the loop owes, if any. */
function owedBy(graph: Graph, entry: number, loop: Hop[]): { id: string; kind: Fairness } | undefined {
  const visited = [...new Set([entry, ...loop.map((h) => h.from)])];
  const taken = new Set(loop.flatMap((h) => (h.edge.fair ? [h.edge.fair] : [])));
  for (const i of visited) {
    for (const [id, kind] of graph.enabled[i]) {
      if (taken.has(id)) continue;
      if (kind === "strong" || visited.every((j) => graph.enabled[j].has(id))) return { id, kind };
    }
  }
  return undefined;
}

/** How to pay an owed step inside the part: take it, or (for a weak one) pass a world where it is not possible. */
function payment(graph: Graph, members: Set<number>, owed: { id: string; kind: Fairness }): Waypoint {
  for (const from of members) {
    const edge = graph.edges[from].find((e) => e.fair === owed.id && members.has(e.to));
    if (edge) return { from, edge };
  }
  const elsewhere = owed.kind === "weak" ? [...members].find((i) => !graph.enabled[i].has(owed.id)) : undefined;
  if (elsewhere === undefined) throw new Error(`a fair part owes ${owed.id} and cannot pay it: the part is not fair`);
  return { node: elsewhere };
}

/** The shortest path from a to b inside `members`. Both are in one strongly connected part, so it exists. */
function pathWithin(graph: Graph, members: Set<number>, a: number, b: number): Hop[] {
  if (a === b) return [];
  const into = new Map<number, Hop>();
  const queue = [a];
  for (let head = 0; head < queue.length && !into.has(b); head++) {
    const from = queue[head];
    for (const edge of graph.edges[from]) {
      if (!members.has(edge.to) || edge.to === a || into.has(edge.to)) continue;
      into.set(edge.to, { from, edge });
      queue.push(edge.to);
    }
  }
  const out: Hop[] = [];
  for (let i = b; i !== a; ) {
    const hop = into.get(i);
    if (!hop) throw new Error(`no path from node ${a} to node ${b} in their component`);
    out.unshift(hop);
    i = hop.from;
  }
  return out;
}
