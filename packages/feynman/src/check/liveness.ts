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
import type { Fairness, LivenessProperty, WorldView } from "../spec/index.ts";

/** A fair step's identity, the same wherever it is possible (a hash of its name). */
export type FairId = number;

/** A predicate a liveness property is made of. */
export type Predicate = (w: WorldView) => boolean;

/** The predicates of liveness properties, in a fixed order: owners evaluate them in every world they keep. */
export function predicatesOf(properties: LivenessProperty[]): Predicate[] {
  return properties.flatMap((p) => {
    switch (p.kind) {
      case "eventually":
        return [p.eventually];
      case "leadsTo":
        return [p.whenever, p.then];
      case "infinitelyOften":
        return [p.infinitelyOften];
      case "eventuallyAlways":
        return [p.eventuallyAlways];
    }
  });
}

/** A step on the graph: where it goes, which of its world's options takes it, whether it is a fault, and its fairness identity, if fair. */
export interface Edge {
  to: number;
  option: number;
  fault: boolean;
  fair?: FairId;
}

/** What the search hands over: for each node, whether its successors are known, its edges, the fair steps possible there, and which predicates hold in it. */
export interface Graph {
  size: number;
  /** Whether a predicate holds in each node. A predicate that throws in a world is false there. */
  holds: (predicate: Predicate) => (node: number) => boolean;
  roots: number[];
  /** Root 0's node: where behaviours begin, for `eventually`. */
  initial: number;
  expanded: boolean[];
  /** Nodes that stand only for a counterexample's last step (errors, broken steps): not part of the graph. */
  shadow: boolean[];
  edges: Edge[][];
  /** Fair steps possible in each node, by identity. */
  enabled: Map<FairId, Fairness>[];
  /** A path from a root to each node, as the search found it. */
  parent: number[];
  /** Which of the parent's options leads to each node, and whether it is a fault. */
  optionFrom: number[];
  faultFrom: boolean[];
}

/** A step of a lasso: the node it is taken in, and which of its options. */
export interface LassoStep {
  from: number;
  option: number;
}

export interface Lasso {
  /** The root the way in starts at. */
  root: number;
  prefix: LassoStep[];
  /** Repeated forever; empty when the behaviour stays in the last world. */
  loop: LassoStep[];
}

export type LivenessVerdict = { holds: true; unfinished: boolean; tested?: number } | { holds: false; lasso: Lasso; tested?: number };

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

export function judgeLiveness(graph: Graph, property: LivenessProperty): LivenessVerdict {
  const search = searchFor(property, graph);
  const { members, inRegion, way, cost, open } = region(graph, search.starts, search.allowed);
  const judged = (i: number) => inRegion[i] === 1 && graph.expanded[i];
  // Of the bad fair parts, the one cheapest to reach, entered at its cheapest world.
  let best: { part: number[]; entry: number; cost: number } | undefined;
  for (const component of components(graph, members.filter(judged), judged)) {
    for (const part of fairParts(graph, component)) {
      if (!search.accepts(part)) continue;
      const entry = part.reduce((a, b) => (cost[b] < cost[a] ? b : a));
      if (!best || cost[entry] < best.cost) best = { part, entry, cost: cost[entry] };
    }
  }
  const tested = search.tested === undefined ? {} : { tested: search.tested };
  if (!best) return { holds: true, unfinished: open, ...tested };
  const loop = fairLoop(graph, new Set(best.part), best.entry, search.mustVisit?.(best.part));
  return { holds: false, lasso: { ...wayIn(graph, best.entry, way), loop }, ...tested };
}

/** Each kind of liveness property as a search for a bad fair part. */
function searchFor(property: LivenessProperty, graph: Graph): LivenessSearch {
  const holds = graph.holds;
  const live = range(graph.size).filter((i) => !graph.shadow[i]);
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

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

// The region a behaviour may be in ----------------------------------------------------------

/** Fault steps cost more than any number of others: counterexamples need the fewest faults first, then the fewest steps. */
const FAULT = 1_000_000;
const costOf = (fault: boolean) => (fault ? FAULT : 1);

/** An edge taken from a node. */
interface Hop {
  from: number;
  edge: Edge;
}

/**
 * Nodes reachable from `starts` through allowed nodes, with the cheapest way to each: the
 * search's path to a start, then hops through the region (`way`: the hop into each node that
 * is not a start). And whether an unexpanded node is among them. Nodes are dense integers, so
 * costs and membership are arrays.
 */
function region(graph: Graph, starts: number[], allowed: (i: number) => boolean) {
  const cost = new Float64Array(graph.size).fill(Infinity);
  const way = new Map<number, Hop>();
  const heap = new Heap();
  const pathCost = searchPathCosts(graph);
  for (const s of starts) {
    if (graph.shadow[s] || !allowed(s) || cost[s] !== Infinity) continue;
    cost[s] = pathCost[s];
    heap.push(pathCost[s], s);
  }
  // 1 in the region; 2 allowed but not yet reached; 3 not allowed (both asked once).
  const inRegion = new Uint8Array(graph.size);
  const members: number[] = [];
  let open = false;
  while (heap.size) {
    const c = heap.topCost();
    const i = heap.pop();
    if (inRegion[i] === 1 || c > cost[i]) continue;
    inRegion[i] = 1;
    members.push(i);
    if (!graph.expanded[i]) {
      open = true;
      continue;
    }
    for (const edge of graph.edges[i]) {
      const to = edge.to;
      if (inRegion[to] === 1 || inRegion[to] === 3) continue;
      if (inRegion[to] === 0) {
        if (graph.shadow[to] || !allowed(to)) {
          inRegion[to] = 3;
          continue;
        }
        inRegion[to] = 2;
      }
      const next = c + costOf(edge.fault);
      if (next >= cost[to]) continue;
      cost[to] = next;
      way.set(to, { from: i, edge });
      heap.push(next, to);
    }
  }
  return { members, inRegion, way, cost, open };
}

/** What the search's path to each node costs. Parents come before their children. */
function searchPathCosts(graph: Graph): Float64Array {
  const out = new Float64Array(graph.size);
  for (let i = 0; i < out.length; i++) out[i] = graph.parent[i] < 0 ? 0 : out[graph.parent[i]] + costOf(graph.faultFrom[i]);
  return out;
}

/** A binary min-heap of (cost, node), in two parallel arrays. */
class Heap {
  private costs: number[] = [];
  private nodes: number[] = [];
  get size() {
    return this.nodes.length;
  }
  topCost(): number {
    return this.costs[0];
  }
  push(cost: number, node: number) {
    const { costs, nodes } = this;
    let i = nodes.length;
    costs.push(cost);
    nodes.push(node);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (costs[up] <= cost) break;
      costs[i] = costs[up];
      nodes[i] = nodes[up];
      i = up;
    }
    costs[i] = cost;
    nodes[i] = node;
  }
  /** The node with the least cost, taken out. */
  pop(): number {
    const { costs, nodes } = this;
    const top = nodes[0];
    const lastCost = costs.pop()!;
    const lastNode = nodes.pop()!;
    const n = nodes.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && costs[r] < costs[l] ? r : l;
        if (costs[m] >= lastCost) break;
        costs[i] = costs[m];
        nodes[i] = nodes[m];
        i = m;
      }
      costs[i] = lastCost;
      nodes[i] = lastNode;
    }
    return top;
  }
}

// Fair parts --------------------------------------------------------------------------------

/** Strongly connected components of the subgraph of `nodes` (Tarjan, iterative). */
function components(graph: Graph, nodes: number[], inside: (i: number) => boolean): number[][] {
  // Nodes are dense integers: -1 not visited yet.
  const index = new Int32Array(graph.size).fill(-1);
  const low = new Int32Array(graph.size);
  const onStack = new Uint8Array(graph.size);
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  const visit = (node: number) => {
    index[node] = low[node] = counter++;
    stack.push(node);
    onStack[node] = 1;
  };
  const workNodes: number[] = [];
  const workEdges: number[] = [];
  for (const root of nodes) {
    if (index[root] >= 0) continue;
    visit(root);
    workNodes.push(root);
    workEdges.push(0);
    while (workNodes.length) {
      const top = workNodes.length - 1;
      const node = workNodes[top];
      const edges = graph.edges[node];
      if (workEdges[top] < edges.length) {
        const to = edges[workEdges[top]++].to;
        if (!inside(to)) continue;
        if (index[to] < 0) {
          visit(to);
          workNodes.push(to);
          workEdges.push(0);
        } else if (onStack[to] && index[to] < low[node]) low[node] = index[to];
        continue;
      }
      workNodes.pop();
      workEdges.pop();
      if (workNodes.length) {
        const up = workNodes[workNodes.length - 1];
        if (low[node] < low[up]) low[up] = low[node];
      }
      if (low[node] !== index[node]) continue;
      const component: number[] = [];
      let popped: number;
      do {
        popped = stack.pop()!;
        onStack[popped] = 0;
        component.push(popped);
      } while (popped !== node);
      out.push(component);
    }
  }
  return out;
}

/** The fair steps taken on edges inside a set of nodes. */
function takenWithin(graph: Graph, members: Set<number>): Set<FairId> {
  const taken = new Set<FairId>();
  for (const i of members) for (const e of graph.edges[i]) if (e.fair && members.has(e.to)) taken.add(e.fair);
  return taken;
}

/** The fair parts of a component (Emerson-Lei): itself if fair; none if a weak step is owed; else the fair parts of what is left without the worlds owing a strong step. */
function fairParts(graph: Graph, component: number[]): number[][] {
  if (component.length === 1) return singleFair(graph, component[0]) ? [component] : [];
  const members = new Set(component);
  const taken = takenWithin(graph, members);
  // A weak step possible in every world of the component, never taken in it: no part of it is fair.
  const [first, ...rest] = component;
  for (const [id, kind] of graph.enabled[first]) {
    if (kind === "weak" && !taken.has(id) && rest.every((i) => graph.enabled[i].has(id))) return [];
  }
  const owedStrong = new Set<FairId>();
  for (const i of component) for (const [id, kind] of graph.enabled[i]) if (kind === "strong" && !taken.has(id)) owedStrong.add(id);
  if (!owedStrong.size) return [component];
  const keep = component.filter((i) => ![...owedStrong].some((id) => graph.enabled[i].has(id)));
  const kept = new Set(keep);
  return components(graph, keep, (i) => kept.has(i)).flatMap((part) => fairParts(graph, part));
}

/**
 * Whether a component of one world is fair: every fair step possible there is taken by a loop
 * back to it. Most components are one world, so this is fairParts without its sets. (A strong
 * step owed here leaves nothing when its world is removed.)
 */
function singleFair(graph: Graph, node: number): boolean {
  const enabled = graph.enabled[node];
  if (!enabled.size) return true;
  const edges = graph.edges[node];
  for (const id of enabled.keys()) {
    let taken = false;
    for (let k = 0; k < edges.length && !taken; k++) taken = edges[k].to === node && edges[k].fair === id;
    if (!taken) return false;
  }
  return true;
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
  const prefix: LassoStep[] = searchPath.slice(1).map((node, k) => ({ from: searchPath[k], option: graph.optionFrom[node] }));
  return { root: searchPath[0], prefix: [...prefix, ...hops.map(stepOf)] };
}

const stepOf = (hop: Hop): LassoStep => ({ from: hop.from, option: hop.edge.option });

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
function owedBy(graph: Graph, entry: number, loop: Hop[]): { id: FairId; kind: Fairness } | undefined {
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
function payment(graph: Graph, members: Set<number>, owed: { id: FairId; kind: Fairness }): Waypoint {
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
