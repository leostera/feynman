// An owner of worlds (RFD0007). The search's worlds are split among owners: one on the main
// thread, and one per worker thread once the search is big enough to share. An owner holds
// the nodes it was given, expands them, and tells the coordinator (search.ts) only what it
// needs to decide which successors are new: a 64-bit fingerprint for each, and the few that
// break something. Worlds stay where they were made, since copying one between threads costs
// about as much as making it.
//
// Every message here is plain data, so it can cross threads. Successors are numbered per
// owner, in the order they were made (candidates); the coordinator answers with the global
// node ids of the ones to keep (`prepare`), before the next round of expanding (`expand`).
import { actorNamed, freeze, holdsIn, isLiveness, observation, traceView, type Event, type Fairness, type Observation, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { stepBreaks, stuck } from "./judge.ts";
import { fingerprint, nameHash, NO_SYMMETRY, pendingText, statePrint, symmetricKey, symmetryOf, type Symmetry } from "./keys.ts";
import { predicatesOf, type FairId, type Predicate } from "./liveness.ts";
import { apply, branches, QUIET, type Choice } from "./steps.ts";
import type { Bounds } from "./explore.ts";

/** What every owner of one search is given: the bounds, and where paths start (the initial world, then each seed). */
export interface OwnerJob {
  bounds: Bounds;
  roots: World[];
}

/** Actions taken on a path, by `instance.key`: the repeats bound counts them. */
export type Acts = Record<string, number>;

/** What one step did, as far as commuting with another step goes. */
export interface Facts {
  /** The instance whose state it changes. */
  target: string;
  observed: Observation;
  failed: boolean;
  /** Whether it sets a timer: timers are kept in age order (keys.ts), so two that set one do not commute. */
  setsTimer: boolean;
}

/** A node an owner holds: a world, the budget spent getting there, and what the reductions know of it. */
interface Held {
  world: World;
  acts: Acts;
  faults: number;
  depth: number;
  root: number;
  /** Steps not to try from here: another order already reaches what they would. */
  sleep: Map<string, Facts>;
  /** The events on the way here, newest first; kept only when a `never` property reads the path. */
  trail: Trail | undefined;
}

type Trail = { event: Event; up: Trail | undefined };

/** A node handed from one owner to another. */
export interface Moved {
  gid: number;
  world: World;
  acts: Acts;
  faults: number;
  depth: number;
  root: number;
  sleep: [string, Facts][];
  /** Oldest first. */
  trail?: Event[];
}

/** A successor, kept until the coordinator says whether it is new. */
interface Candidate extends Held {
  /** The text its fingerprint was taken of, for `watch` (inline only). */
  memory: string;
}

// Messages ------------------------------------------------------------------------------------------

/** Before a round of expanding: which candidates (or roots) to keep and as which node, steps to wake, nodes to hand over. */
export interface Prepare {
  /** Pairs of (candidate index, node id); a root is candidate -(root + 1). */
  keep: Int32Array;
  /** Steps the coordinator found must be tried after all, by node: hashes of their names. */
  wake: { gid: number; names: number[] }[];
  /** Properties broken since the last round: owners need not report them again. */
  broken: string[];
  /** Nodes to hand to another owner. */
  exports: number[];
}

/** For each node kept, in order: whether it is stuck, and (for liveness) which predicates hold in it. */
export interface Prepared {
  stuck: Uint8Array;
  /** One byte per kept node and predicate, node by node. */
  truths: Uint8Array;
  exported: Moved[];
}

/** A node to expand, at its place in the frontier; `only` for a node expanded before, the steps to try now (hashes of their names). */
export interface Entry {
  slot: number;
  gid: number;
  only?: number[];
}

export interface ExpandOrder {
  imports: Moved[];
  entries: Entry[];
  /** When the time limit runs out, in ms since the epoch: entries after that are not expanded. */
  deadline: number;
}

/** Candidate flags. */
export const FAILED = 1;
export const FAULT = 2;
/** Its sleep set is not empty: arriving at it again may wake steps. */
export const SLEEPY = 4;

/** What a successor met: kept apart, since few meet anything. */
export interface Note {
  k: number;
  /** `always` and `never` properties it breaks, not yet broken here. */
  findings?: string[];
  /** `everyStep` properties its step breaks, not yet broken here. */
  breaks?: string[];
  error?: string;
}

/** A round of expanding: per entry, its slot and how many candidates it made; per candidate, its fingerprint and the rest. */
export interface Expansion {
  slots: Int32Array;
  counts: Int32Array;
  /** Two words per candidate. */
  prints: Uint32Array;
  /** The fingerprint of the world without renaming, when the root has symmetry: twins are told apart by it. */
  plains: Uint32Array;
  /** Which of its world's options each candidate's step is. */
  options: Uint16Array;
  flags: Uint8Array;
  /** For liveness: each candidate's fair identity (NaN when not fair), and per entry the fair steps possible. */
  fair: Float64Array;
  enabled: [FairId, Fairness][][];
  notes: Note[];
  /** Entries were left out: the time limit ran out. */
  cut: boolean;
}

/** A node or a candidate. */
export type Ref = { gid: number } | { k: number };

export interface Query {
  /** Sleep sets, as hashes of step names. */
  sleeps: Ref[];
  /** A fingerprint of the set of worlds one step away (faults aside), to test a symmetry claim. */
  twins: Ref[];
}

export interface Answer {
  sleeps: number[][];
  /** Two words per twin. */
  twins: Uint32Array;
}

/** A node at the depth bound, for liveness: where each step goes, if all are known. */
export interface Closed {
  gid: number;
  prints: Uint32Array;
  options: Uint16Array;
  faults: Uint8Array;
  fair: Float64Array;
  enabled: [FairId, Fairness][];
}

/** A step to replay: a node, and which of its options. */
export interface StepRef {
  gid: number;
  option: number;
}

export interface Resolved {
  choice: Choice;
  /** The node's world, when asked for. */
  world?: World;
}

export interface Stats {
  reached: string[];
  orders: number;
  inputs: number;
}

// The owner -------------------------------------------------------------------------------------------

export class Owner {
  private readonly b: Bounds;
  private readonly roots: { world: World; symmetry: Symmetry }[];
  private readonly nevers: PropertyInfo[];
  private readonly keepsEdges: boolean;
  private readonly predicates: Predicate[];
  private readonly nodes = new Map<number, Held>();
  private candidates: Candidate[] = [];
  /** Properties this owner knows are broken: by itself, or as the coordinator says. */
  private readonly broken = new Set<string>();
  private readonly errors = new Set<string>();
  private readonly reached = new Set<string>();
  private readonly saved = { orders: 0, inputs: 0 };

  constructor(
    private readonly spec: Spec,
    job: OwnerJob,
  ) {
    this.b = job.bounds;
    this.roots = job.roots.map((world) => ({ world: freeze(world), symmetry: this.b.symmetry ? symmetryOf(spec, world) : NO_SYMMETRY }));
    this.nevers = spec.properties.filter((p) => p.kind === "never");
    this.keepsEdges = spec.properties.some(isLiveness);
    this.predicates = predicatesOf(spec.properties.filter(isLiveness));
  }

  prepare(order: Prepare): Prepared {
    for (const id of order.broken) this.broken.add(id);
    const stuckOut = new Uint8Array(order.keep.length / 2);
    const truths = new Uint8Array((order.keep.length / 2) * this.predicates.length);
    for (let i = 0; i < order.keep.length; i += 2) {
      const [ref, gid] = [order.keep[i], order.keep[i + 1]];
      const held = ref < 0 ? this.rootNode(-ref - 1) : this.candidates[ref];
      this.nodes.set(gid, held);
      stuckOut[i / 2] = stuck(this.spec, held.world) ? 1 : 0;
      this.predicates.forEach((p, n) => (truths[(i / 2) * this.predicates.length + n] = holdsIn(this.spec, held.world, p) ? 1 : 0));
    }
    this.candidates = [];
    for (const { gid, names } of order.wake) {
      const sleep = this.nodes.get(gid)!.sleep;
      const woken = new Set(names);
      for (const name of [...sleep.keys()]) if (woken.has(nameHash(name))) sleep.delete(name);
    }
    const exported = order.exports.map((gid) => this.export(gid));
    return { stuck: stuckOut, truths, exported };
  }

  expand(order: ExpandOrder): Expansion {
    for (const moved of order.imports) this.import(moved);
    const out = new ExpansionBuilder(this.keepsEdges);
    for (const entry of order.entries) {
      if (Date.now() > order.deadline) {
        out.cut = true;
        break;
      }
      const before = this.candidates.length;
      out.enabled.push(this.expandOne(entry, out));
      out.slots.push(entry.slot);
      out.counts.push(this.candidates.length - before);
    }
    return out.build();
  }

  query(q: Query): Answer {
    const held = (ref: Ref) => ("k" in ref ? this.candidates[ref.k] : this.nodes.get(ref.gid)!);
    const twins = new Uint32Array(q.twins.length * 2);
    q.twins.forEach((ref, i) => twins.set(this.successorsPrint(held(ref)), i * 2));
    return { sleeps: q.sleeps.map((ref) => [...held(ref).sleep.keys()].map(nameHash)), twins };
  }

  close(gids: number[]): Closed[] {
    return gids.map((gid) => {
      const node = this.nodes.get(gid)!;
      const options = branches(this.spec, node.world, node.faults < this.b.faults);
      const prints: number[] = [];
      const indexes: number[] = [];
      const faults: number[] = [];
      const fair: number[] = [];
      options.forEach((choice, option) => {
        const budget = spend(node, choice, this.b.repeats);
        if (!budget) return;
        const step = apply(this.spec, node.world, choice, QUIET);
        if (step.event.error) return;
        prints.push(...statePrint(step.world, this.roots[node.root].symmetry, budgetText(budget, this.memory(() => [...eventsOf(node.trail), step.event]))).print);
        indexes.push(option);
        faults.push(isFault(choice) ? 1 : 0);
        fair.push(fairness(this.spec, node.world, choice)?.id ?? NaN);
      });
      return { gid, prints: Uint32Array.from(prints), options: Uint16Array.from(indexes), faults: Uint8Array.from(faults), fair: Float64Array.from(fair), enabled: [...fairStepsIn(this.spec, node.world, options)] };
    });
  }

  resolve(steps: StepRef[], worlds: boolean): Resolved[] {
    return steps.map(({ gid, option }) => {
      const node = this.nodes.get(gid)!;
      const choice = branches(this.spec, node.world, node.faults < this.b.faults)[option];
      return worlds ? { choice, world: node.world } : { choice };
    });
  }

  stats(): Stats {
    return { reached: [...this.reached], ...this.saved };
  }

  /** A candidate's world and budget, for tools that watch every state (inline only). */
  candidate(k: number): { world: World; acts: Acts; faults: number; memory: string } {
    const { world, acts, faults, memory } = this.candidates[k];
    return { world, acts, faults, memory };
  }

  /** Every step from a node, as candidates; the fair steps possible there, for liveness. */
  private expandOne(entry: Entry, out: ExpansionBuilder): [FairId, Fairness][] {
    const node = this.nodes.get(entry.gid)!;
    const options = branches(this.spec, node.world, node.faults < this.b.faults);
    const only = entry.only && new Set(entry.only);
    const tried: [string, Facts][] = [];
    const inputsTried = new Map<string, { inputs: Record<string, unknown>; read: Set<string> }[]>();
    options.forEach((choice, option) => {
      const name = stepName(node.world, choice);
      if (only ? !only.has(nameHash(name)) : node.sleep.has(name)) {
        if (!only) this.saved.orders++;
        return;
      }
      const budget = spend(node, choice, this.b.repeats);
      if (!budget) return;
      if (this.sameInputsTried(choice, inputsTried)) {
        this.saved.inputs++;
        return;
      }
      const observed = observation();
      const step = apply(this.spec, node.world, choice, { explain: false, observe: observed });
      if (choice.kind === "act") {
        const id = `${choice.instance}.${choice.key}`;
        inputsTried.set(id, [...(inputsTried.get(id) ?? []), { inputs: choice.inputs, read: observed.inputs }]);
      }
      const facts: Facts = { target: targetOf(node.world, choice), observed, failed: !!step.event.error, setsTimer: step.event.started.length > 0 };
      const sleep = this.childSleep(node, facts, tried, !!only);
      tried.push([name, facts]);
      this.candidateOf(node, choice, option, step, budget, sleep, out);
    });
    return this.keepsEdges ? [...fairStepsIn(this.spec, node.world, options)] : [];
  }

  /** A successor: fingerprinted, judged, and kept until the coordinator says whether it is new. */
  private candidateOf(node: Held, choice: Choice, option: number, step: ReturnType<typeof apply>, budget: { acts: Acts; faults: number }, sleep: Map<string, Facts>, out: ExpansionBuilder): void {
    const event = step.event;
    this.reached.add(`${event.actor}.${event.key}`);
    const trail = this.nevers.length ? { event, up: node.trail } : undefined;
    const { memory, nevers } = this.remember(trail);
    const k = this.candidates.length;
    this.candidates.push({ world: step.world, acts: budget.acts, faults: budget.faults, depth: node.depth + 1, root: node.root, sleep, trail, memory });
    const symmetry = this.roots[node.root].symmetry;
    const { print, plain } = statePrint(step.world, symmetry, budgetText(budget, memory));
    out.prints.push(...print);
    out.plains.push(...(symmetry.classes.length ? plain : [0, 0]));
    out.options.push(option);
    out.flags.push((event.error ? FAILED : 0) | (isFault(choice) ? FAULT : 0) | (sleep.size ? SLEEPY : 0));
    if (this.keepsEdges) out.fair.push(fairness(this.spec, node.world, choice)?.id ?? NaN);
    // What it breaks, of what this owner does not know is broken: the coordinator keeps the
    // first of each. A step that breaks a step property, or fails, is always judged (it gets a
    // node of its own), so after the first this owner need not report it. A state that breaks
    // an `always` or `never` property is judged only if it is new, which only the coordinator
    // knows: those are reported until it says they broke.
    const findings = [...event.violations, ...nevers].filter((id) => !this.broken.has(id));
    const breaks = event.error ? [] : stepBreaks(this.spec, node.world, step.world, event, this.broken);
    const error = event.error && !this.errors.has(event.error) ? event.error : undefined;
    if (!findings.length && !breaks.length && !error) return;
    for (const id of breaks) this.broken.add(id);
    if (error) this.errors.add(error);
    out.notes.push({ k, ...(findings.length ? { findings } : {}), ...(breaks.length ? { breaks } : {}), ...(error ? { error } : {}) });
  }

  /** An earlier try of this action read only inputs this one shares: same result. */
  private sameInputsTried(choice: Choice, inputsTried: Map<string, { inputs: Record<string, unknown>; read: Set<string> }[]>): boolean {
    if (!this.b.reduce || choice.kind !== "act") return false;
    const tries = inputsTried.get(`${choice.instance}.${choice.key}`) ?? [];
    return tries.some((t) => [...t.read].every((k) => Object.is(t.inputs[k], choice.inputs[k])));
  }

  /** What the child need not try: what this node skipped or already tried, where it commutes with this step. */
  private childSleep(node: Held, facts: Facts, tried: [string, Facts][], only: boolean): Map<string, Facts> {
    const sleep = new Map<string, Facts>();
    if (!this.b.reduce || only) return sleep;
    for (const [k, f] of node.sleep) if (commute(f, facts)) sleep.set(k, f);
    for (const [k, f] of tried) if (commute(f, facts)) sleep.set(k, f);
    return sleep;
  }

  /** What `never` properties remember of a path (see memoryOf), and which of them it breaks. */
  private remember(trail: Trail | undefined): { memory: string; nevers: string[] } {
    if (!this.nevers.length) return { memory: "", nevers: [] };
    return memoryOf(this.nevers, eventsOf(trail));
  }

  private memory(events: () => Event[]): string {
    return this.nevers.length ? memoryOf(this.nevers, events()).memory : "";
  }

  /** A fingerprint of the worlds one step away, faults aside: twins must agree on it. */
  private successorsPrint(node: Held): [number, number] {
    const symmetry = this.roots[node.root].symmetry;
    const keys = new Set<string>();
    for (const choice of branches(this.spec, node.world, false)) {
      const step = apply(this.spec, node.world, choice, QUIET);
      keys.add(step.event.error ? `error:${step.event.error}` : symmetricKey(step.world, symmetry));
    }
    return fingerprint([...keys].sort().join("\n\n"));
  }

  private rootNode(root: number): Held {
    return { world: this.roots[root].world, acts: {}, faults: 0, depth: 0, root, sleep: new Map(), trail: undefined };
  }

  private export(gid: number): Moved {
    const node = this.nodes.get(gid)!;
    this.nodes.delete(gid);
    return { gid, world: node.world, acts: node.acts, faults: node.faults, depth: node.depth, root: node.root, sleep: [...node.sleep], ...(node.trail ? { trail: eventsOf(node.trail) } : {}) };
  }

  private import(moved: Moved): void {
    let trail: Trail | undefined;
    for (const event of moved.trail ?? []) trail = { event, up: trail };
    this.nodes.set(moved.gid, { world: freeze(moved.world), acts: moved.acts, faults: moved.faults, depth: moved.depth, root: moved.root, sleep: new Map(moved.sleep), trail });
  }
}

/**
 * What a state is besides its world: the budget spent getting there, and what `never`
 * properties remember of the way. The coordinator fingerprints the roots with it too.
 */
export function budgetText(budget: { acts: Acts; faults: number }, memory: string): string {
  return `${actsKey(budget.acts)}|${budget.faults}|${memory}`;
}

/** What `never` properties remember of no path at all: a root's memory. */
export function rootMemory(spec: Spec): string {
  const nevers = spec.properties.filter((p) => p.kind === "never");
  return nevers.length ? memoryOf(nevers, []).memory : "";
}

/** An expansion as it is built, as growable arrays; then packed into typed ones. */
class ExpansionBuilder {
  slots: number[] = [];
  counts: number[] = [];
  prints: number[] = [];
  plains: number[] = [];
  options: number[] = [];
  flags: number[] = [];
  fair: number[] = [];
  enabled: [FairId, Fairness][][] = [];
  notes: Note[] = [];
  cut = false;
  constructor(private readonly keepsEdges: boolean) {}
  build(): Expansion {
    return {
      slots: Int32Array.from(this.slots),
      counts: Int32Array.from(this.counts),
      prints: Uint32Array.from(this.prints),
      plains: Uint32Array.from(this.plains),
      options: Uint16Array.from(this.options),
      flags: Uint8Array.from(this.flags),
      fair: Float64Array.from(this.fair),
      enabled: this.keepsEdges ? this.enabled : [],
      notes: this.notes,
      cut: this.cut,
    };
  }
}

/** The budget after a step: actions repeated and faults used; none if the step would take an action past the repeats bound. */
export function spend(node: { acts: Acts; faults: number }, choice: Choice, repeats: number): { acts: Acts; faults: number } | undefined {
  if (isFault(choice)) return { acts: node.acts, faults: node.faults + 1 };
  if (choice.kind !== "act") return { acts: node.acts, faults: node.faults };
  const id = `${choice.instance}.${choice.key}`;
  const taken = node.acts[id] ?? 0;
  return taken >= repeats ? undefined : { acts: { ...node.acts, [id]: taken + 1 }, faults: node.faults };
}

function isFault(choice: Choice): boolean {
  return choice.kind === "lose" || choice.kind === "restart";
}

/** Actions taken, written once per budget object: steps other than actions pass theirs on. */
const actsKeys = new WeakMap<Acts, string>();

function actsKey(acts: Acts): string {
  let key = actsKeys.get(acts);
  if (key === undefined) actsKeys.set(acts, (key = JSON.stringify(Object.entries(acts).sort(([a], [b]) => (a < b ? -1 : 1)))));
  return key;
}

function eventsOf(trail: Trail | undefined): Event[] {
  const out: Event[] = [];
  for (let t = trail; t; t = t.up) out.push(t.event);
  return out.reverse();
}

// What never properties remember -------------------------------------------------------------------

/**
 * A `never` property judges the whole path, so two paths to one world are one state only if
 * the property remembers the same of both. It sees the path through `count` and `some`, each
 * over single events, so the answers those calls give are all it can remember: they go in the
 * fingerprint. A property that reads `trace.events` itself could remember anything, so then
 * the whole path goes in: no two paths are merged. Judging the path this way also says which
 * of them it breaks.
 */
function memoryOf(nevers: PropertyInfo[], events: Event[]): { memory: string; nevers: string[] } {
  const base = traceView(events);
  const memory: unknown[] = [];
  const broken: string[] = [];
  let opaque = false;
  const trace = {
    get events() {
      opaque = true;
      return base.events;
    },
    count: (p: Parameters<typeof base.count>[0]) => {
      const n = base.count(p);
      memory.push(n);
      return n;
    },
    some: (p: Parameters<typeof base.some>[0]) => {
      const b = base.some(p);
      memory.push(b);
      return b;
    },
  };
  for (const invariant of nevers) {
    if (invariant.kind !== "never") continue;
    try {
      if (invariant.never(trace)) broken.push(invariant.id);
    } catch {
      memory.push("!");
    }
  }
  return { memory: opaque ? `path:${events.map((e) => `${e.actor}.${e.key}`).join(",")}` : JSON.stringify(memory), nevers: broken };
}

// Commuting -------------------------------------------------------------------------------------------

/**
 * Whether two steps taken from one world reach the same world in either order. They must
 * change different instances, neither may read another instance, and they may not both use
 * a shared counter, or both set a timer (timers are kept in age order). Sends commute: a
 * step never sees what is pending, and nothing pending waits for anything else.
 */
function commute(a: Facts, b: Facts): boolean {
  return (
    a.target !== b.target &&
    !a.failed &&
    !b.failed &&
    !a.observed.readsOthers &&
    !b.observed.readsOthers &&
    !(a.observed.shared && b.observed.shared) &&
    !(a.setsTimer && b.setsTimer)
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
      // What it carries: two identical entries reach the same world either way.
      return `${choice.kind[0]}|${pendingText(world.pending.find((x) => x.id === choice.pending)!)}`;
    }
  }
}

// Fairness --------------------------------------------------------------------------------------------

/**
 * A step's fairness (RFD0006): its identity, the same wherever it is possible, and how fair it
 * is. Deliveries, timers and guards are weakly fair unless their transition says otherwise;
 * actions and faults are never fair.
 */
function fairness(spec: Spec, world: World, choice: Choice): { id: FairId; kind: Fairness } | undefined {
  if (choice.kind === "act" || choice.kind === "lose" || choice.kind === "restart") return undefined;
  let name: string;
  let key: string;
  let instance: string;
  if (choice.kind === "guard") {
    name = `g|${choice.instance}|${choice.key}`;
    key = choice.key;
    instance = choice.instance;
  } else {
    const pending = world.pending.find((p) => p.id === choice.pending)!;
    name = pending.kind === "deliver" ? `d|${pendingText(pending)}` : `t|${pending.to}|${pending.timer}`;
    key = pending.kind === "deliver" ? pending.message : pending.timer;
    instance = pending.to;
  }
  const actor = world.instances.find((i) => i.id === instance)?.actor;
  const fair = actor ? actorNamed(spec, actor).transitions[key]?.fair : undefined;
  if (fair === false) return undefined;
  return { id: nameHash(name), kind: fair ?? "weak" };
}

/** The fair steps possible in a world, among its options, by identity. */
function fairStepsIn(spec: Spec, world: World, options: Choice[]): Map<FairId, Fairness> {
  return new Map(options.flatMap((c) => fairness(spec, world, c) ?? []).map((f) => [f.id, f.kind]));
}
