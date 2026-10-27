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
import type { PropertyInfo, Spec, World } from "../spec/index.ts";
import { holdsIn } from "../spec/index.ts";
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
  /** Fair steps possible in each node, by identity: "weak" or "strong". */
  enabled: Map<string, "weak" | "strong">[];
  /** A path from a root to each node, as the search found it. */
  parent: number[];
  /** The choice from the parent, per node. */
  choiceFrom: (Choice | null)[];
}

export interface Lasso {
  /** From a root: the root, then each choice, and the node it reaches. */
  root: number;
  prefix: { choice: Choice; from: number }[];
  /** Repeated forever; empty when the behaviour stays in the last world. */
  loop: { choice: Choice; from: number }[];
}

export type LivenessVerdict = { holds: true; unfinished: boolean; tested?: number } | { holds: false; lasso: Lasso; tested?: number };

type Liveness = Extract<PropertyInfo, { kind: "eventually" | "leadsTo" | "infinitelyOften" | "eventuallyAlways" }>;

export function judgeLiveness(spec: Spec, graph: Graph, property: Liveness): LivenessVerdict {
  const n = graph.worlds.length;
  const live = (i: number) => !graph.shadow[i];
  const memo = (predicate: (w: never) => boolean) => {
    const cache = new Map<number, boolean>();
    return (i: number) => {
      let v = cache.get(i);
      if (v === undefined) cache.set(i, (v = holdsIn(spec, graph.worlds[i], predicate as never)));
      return v;
    };
  };

  // Where a behaviour may be before it settles, where it may settle, and which settled parts are bad.
  let starts: number[];
  let allowed: (i: number) => boolean;
  let accepts: (component: number[]) => boolean = () => true;
  // For `eventuallyAlways`: a world the loop must pass, where the property does not hold.
  let bad: ((component: number[]) => number | undefined) | undefined;
  let tested: number | undefined;
  switch (property.kind) {
    case "eventually": {
      const q = memo(property.eventually);
      allowed = (i) => !q(i);
      starts = allowed(graph.initial) ? [graph.initial] : [];
      break;
    }
    case "leadsTo": {
      const p = memo(property.whenever);
      const q = memo(property.then);
      allowed = (i) => !q(i);
      starts = range(n).filter((i) => live(i) && p(i) && !q(i));
      tested = starts.length;
      break;
    }
    case "infinitelyOften": {
      const q = memo(property.infinitelyOften);
      allowed = (i) => !q(i);
      starts = range(n).filter((i) => live(i) && !q(i));
      break;
    }
    case "eventuallyAlways": {
      const q = memo(property.eventuallyAlways);
      allowed = () => true;
      starts = graph.roots;
      accepts = (component) => component.some((i) => !q(i));
      bad = (component) => component.find((i) => !q(i));
      break;
    }
  }

  // The region: reachable from a start through allowed nodes. Unexpanded nodes in it make an
  // absent counterexample inconclusive.
  const { members, from, cost, open } = region(graph, starts, allowed);
  const inRegion = (i: number) => members.has(i) && graph.expanded[i];
  // Of the bad fair parts, the one cheapest to reach, and its cheapest world as the way in.
  let best: { part: number[]; entry: number; cost: number } | undefined;
  for (const component of components(graph, [...members].filter(inRegion), inRegion)) {
    for (const part of fairParts(graph, component)) {
      if (!accepts(part)) continue;
      const entry = part.reduce((a, b) => (cost.get(b)! < cost.get(a)! ? b : a));
      if (!best || cost.get(entry)! < best.cost) best = { part, entry, cost: cost.get(entry)! };
    }
  }
  const counted = tested === undefined ? {} : { tested };
  if (best) return { holds: false, lasso: lasso(graph, best.part, best.entry, from, bad?.(best.part)), ...counted };
  return { holds: true, unfinished: open, ...counted };
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/** Fault steps cost more than any number of others: counterexamples need the fewest faults first, then the fewest steps. */
const FAULT = 1_000_000;
const isFault = (choice: Choice | null) => choice?.kind === "lose" || choice?.kind === "restart";

/**
 * Nodes reachable from `starts` through allowed nodes, with the cheapest way to each (from the
 * root, by the search's path to a start, then through the region), and whether an unexpanded
 * one is among them.
 */
function region(graph: Graph, starts: number[], allowed: (i: number) => boolean) {
  const n = graph.worlds.length;
  // The search's path to each node: its cost.
  const base = new Float64Array(n);
  for (let i = 0; i < n; i++) base[i] = graph.parent[i] < 0 ? 0 : base[graph.parent[i]] + (isFault(graph.choiceFrom[i]) ? FAULT : 1);
  const cost = new Map<number, number>();
  const from = new Map<number, number>();
  const heap = new Heap();
  for (const s of starts) {
    if (graph.shadow[s] || !allowed(s) || (cost.get(s) ?? Infinity) <= base[s]) continue;
    cost.set(s, base[s]);
    heap.push(base[s], s);
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
    for (const e of graph.edges[i]) {
      if (graph.shadow[e.to] || !allowed(e.to) || members.has(e.to)) continue;
      const next = c + (isFault(e.choice) ? FAULT : 1);
      if (next >= (cost.get(e.to) ?? Infinity)) continue;
      cost.set(e.to, next);
      from.set(e.to, i);
      heap.push(next, e.to);
    }
  }
  return { members, from, cost, open };
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
        const l = 2 * i + 1, r = l + 1;
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

/** Strongly connected components of the subgraph of `nodes` (Tarjan, iterative). */
function components(graph: Graph, nodes: number[], inside: (i: number) => boolean): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work: { node: number; edge: number }[] = [{ node: root, edge: 0 }];
    index.set(root, counter), low.set(root, counter++), stack.push(root), onStack.add(root);
    while (work.length) {
      const frame = work[work.length - 1];
      const edges = graph.edges[frame.node];
      if (frame.edge < edges.length) {
        const to = edges[frame.edge++].to;
        if (!inside(to)) continue;
        if (!index.has(to)) {
          index.set(to, counter), low.set(to, counter++), stack.push(to), onStack.add(to);
          work.push({ node: to, edge: 0 });
        } else if (onStack.has(to)) low.set(frame.node, Math.min(low.get(frame.node)!, index.get(to)!));
        continue;
      }
      work.pop();
      if (work.length) {
        const up = work[work.length - 1].node;
        low.set(up, Math.min(low.get(up)!, low.get(frame.node)!));
      }
      if (low.get(frame.node) === index.get(frame.node)) {
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
  }
  return out;
}

/** The fair parts of a component (Emerson-Lei): itself if fair; none if a weak step is owed; else the fair parts of what is left without the worlds owing a strong step. */
function fairParts(graph: Graph, component: number[]): number[][] {
  const members = new Set(component);
  const taken = new Set<string>();
  for (const i of component) for (const e of graph.edges[i]) if (e.fair && members.has(e.to)) taken.add(e.fair);
  const owedStrong = new Set<string>();
  // A weak step possible in every world of the component, never taken in it: no part of it is fair.
  const [first, ...rest] = component;
  for (const [id, kind] of graph.enabled[first]) {
    if (taken.has(id)) continue;
    if (kind === "strong") owedStrong.add(id);
    else if (rest.every((i) => graph.enabled[i].has(id))) return [];
  }
  for (const i of rest) for (const [id, kind] of graph.enabled[i]) if (kind === "strong" && !taken.has(id)) owedStrong.add(id);
  if (!owedStrong.size) return [component];
  const keep = component.filter((i) => ![...owedStrong].some((id) => graph.enabled[i].has(id)));
  if (!keep.length) return [];
  const kept = new Set(keep);
  return components(graph, keep, (i) => kept.has(i)).flatMap((part) => fairParts(graph, part));
}

/** A counterexample: a way into the fair part, then a loop through it that takes every step fairness asks for. */
function lasso(graph: Graph, fair: number[], entry: number, from: Map<number, number>, mustVisit?: number): Lasso {
  const members = new Set(fair);
  // Into the part: through the region, back to the start that reached it, then the search's path to that start.
  const regionPath: number[] = [];
  for (let i: number | undefined = entry; i !== undefined; i = from.get(i)) regionPath.unshift(i);
  const start = regionPath[0];
  const searchPath: number[] = [];
  for (let i = start; i >= 0; i = graph.parent[i]) searchPath.unshift(i);
  const root = searchPath[0];
  const prefix: Lasso["prefix"] = [];
  for (let k = 1; k < searchPath.length; k++) prefix.push({ choice: graph.choiceFrom[searchPath[k]]!, from: searchPath[k - 1] });
  for (let k = 1; k < regionPath.length; k++) prefix.push({ choice: edgeBetween(graph, regionPath[k - 1], regionPath[k]).choice, from: regionPath[k - 1] });

  // Round the part: start by staying put, and add detours while the loop owes a fair step.
  return { root, prefix, loop: fairLoop(graph, members, entry, mustVisit) };
}

/**
 * A short fair loop from `entry` inside a fair part: waypoints (an edge to take, or a world to
 * pass) are added one at a time for what the loop so far owes: a weak step possible in all its
 * worlds but not taken (take it, or pass a world where it is not possible), or a strong step
 * possible in one of its worlds but not taken (take it). The part is fair, so each can be met.
 */
function fairLoop(graph: Graph, members: Set<number>, entry: number, mustVisit?: number): Lasso["loop"] {
  type Waypoint = { node: number } | { from: number; edge: Edge };
  const waypoints: Waypoint[] = mustVisit === undefined || mustVisit === entry ? [] : [{ node: mustVisit }];
  const build = (): Lasso["loop"] => {
    const out: Lasso["loop"] = [];
    let at = entry;
    for (const w of waypoints) {
      if ("node" in w) {
        out.push(...pathWithin(graph, members, at, w.node));
        at = w.node;
      } else {
        out.push(...pathWithin(graph, members, at, w.from), { choice: w.edge.choice, from: w.from });
        at = w.edge.to;
      }
    }
    out.push(...pathWithin(graph, members, at, entry));
    return out;
  };
  for (let round = 0; round <= members.size * 4; round++) {
    const loop = build();
    const visited = new Set([entry, ...loop.map((s) => s.from)]);
    const taken = new Set<string>();
    for (const step of loop) {
      const e = graph.edges[step.from].find((x) => x.choice === step.choice);
      if (e?.fair) taken.add(e.fair);
    }
    const nodes = [...visited];
    let owed: { id: string; kind: "weak" | "strong" } | undefined;
    for (const i of nodes) {
      for (const [id, kind] of graph.enabled[i]) {
        if (taken.has(id)) continue;
        if (kind === "strong" || nodes.every((j) => graph.enabled[j].has(id))) owed = { id, kind };
        if (owed) break;
      }
      if (owed) break;
    }
    if (!owed) return loop;
    const edgeFor = [...members].flatMap((i) => graph.edges[i].filter((e) => e.fair === owed!.id && members.has(e.to)).map((edge) => ({ from: i, edge })))[0];
    if (edgeFor) waypoints.push(edgeFor);
    else {
      const elsewhere = [...members].find((i) => !graph.enabled[i].has(owed!.id));
      if (elsewhere === undefined) break;
      waypoints.push({ node: elsewhere });
    }
  }
  // Should not happen in a fair part; fall back to a loop through every world.
  for (const i of members) waypoints.push({ node: i });
  return build();
}

function edgeBetween(graph: Graph, a: number, b: number): Edge {
  return graph.edges[a].find((e) => e.to === b)!;
}

/** The shortest path from a to b inside `members`, as steps. */
function pathWithin(graph: Graph, members: Set<number>, a: number, b: number): Lasso["loop"] {
  if (a === b) return [];
  const back = new Map<number, { from: number; edge: Edge }>([[a, { from: -1, edge: null as never }]]);
  const queue = [a];
  for (let head = 0; head < queue.length && !back.has(b); head++) {
    const i = queue[head];
    for (const e of graph.edges[i]) {
      if (!members.has(e.to) || back.has(e.to)) continue;
      back.set(e.to, { from: i, edge: e });
      queue.push(e.to);
    }
  }
  const out: Lasso["loop"] = [];
  for (let i = b; i !== a; i = back.get(i)!.from) out.unshift({ choice: back.get(i)!.edge.choice, from: back.get(i)!.from });
  return out;
}
