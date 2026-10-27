// The checker: a bounded breadth-first search over everything that can happen next, plus
// random runs that go deeper than the search can.
//
// From a world with the configured instances, each state branches on: every action on
// every instance (with inputs from its schema), every guarded transition that holds,
// every pending delivery (networks reorder), every timer set, and, within the fault
// budget, losing a delivery or restarting an instance. States are deduplicated by a
// canonical key (keys.ts), so breadth-first order finds the shortest counterexample.
//
// Three reductions keep every state the plain search would visit, and skip only work
// whose result is known:
// - Sleep sets: when two steps on different instances commute (neither reads anyone else,
//   or shares a counter with the other), both orders reach the same world,
//   so the second order is not tried again. A state reached later with fewer such steps
//   skipped is expanded again for the difference.
// - Inputs an action did not read: other values for them would do exactly the same.
// - Symmetry (keys.ts): interchangeable instances are renamed to one order.
import { actorNamed, isLiveness, observation, spawn, startWorld, traceView, type Event, type Fairness, type LivenessProperty, type Observation, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { canonical, NO_SYMMETRY, pendingText, symmetricKey, symmetryOf, type Symmetry } from "./keys.ts";
import { judge, stepBreaks, stuck, verdicts, type Verdicts } from "./judge.ts";
import { judgeLiveness, type Edge, type Graph, type Lasso } from "./liveness.ts";
import { apply, branches, QUIET, replay, type Choice, type Counterexample } from "./steps.ts";
import { rebind, shrink, walk, type WalkResult } from "./walk.ts";

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

/** A property's verdict: it held, or here is how it breaks. */
export type PropertyResult = PropertyHeld | PropertyBroken;

interface PropertyVerdict {
  id: string;
  kind: PropertyInfo["kind"];
  description: string;
  /** A known bug: why the property is expected to break. */
  known?: string;
  /**
   * For `leadsTo`: in how many explored worlds it was put to the test, `whenever` holding
   * and `then` not. Zero means exploration never got there, so holding says nothing.
   */
  tested?: number;
}

export interface PropertyHeld extends PropertyVerdict {
  holds: true;
  /**
   * Holding among the worlds explored, but not all of them: the search stopped early, or (for
   * liveness) the region it was judged on reaches worlds past the depth bound, where a loop
   * may lie.
   */
  unfinished?: boolean;
}

export interface PropertyBroken extends PropertyVerdict {
  holds: false;
  counterexample: Counterexample;
  /** Who found the counterexample: the search (shortest), or a random run (shrunk, maybe not shortest). */
  foundBy: "search" | "walk";
  /**
   * For liveness: what repeats forever after the counterexample, from where it ends. Empty
   * when the system stays where it ends (nothing fair can happen there).
   */
  loop?: Counterexample;
  /**
   * When the counterexample is not the shortest because a shorter one needs more faults:
   * that one's length and faults (see withFewestFaults).
   */
  shorter?: { events: number; faults: number };
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
  /** A world where nothing can happen and the spec does not call it final (the first found). */
  stuck?: { counterexample: Counterexample; foundBy: "search" | "walk" };
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
  observed: Observation;
  failed: boolean;
  /** Whether it sets a timer: timers are kept in age order (keys.ts), so two that set one do not commute. */
  setsTimer: boolean;
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
  /** Stands only for a counterexample's last step (an error, a broken step), not for a state. */
  shadow?: boolean;
}

/** A world to explore from besides the initial one, such as where a scenario ends. */
export interface Seed {
  name: string;
  world: World;
}

/** Callbacks for tools that compare the checker with another: every distinct state, as the search first meets it. */
export interface Watch {
  state?(world: World, budget: { acts: Record<string, number>; faults: number; memory: string }): void;
}

/**
 * Explore every interleaving within the bounds, from the initial world and from each seed
 * at once, breadth first, after a share of random runs. Seeding with where scenarios end puts
 * the search where the interesting states are, rather than spending its budget getting there.
 */
export function check(spec: Spec, bounds: Partial<Bounds> = {}, seeds: Seed[] = [], watch: Watch = {}): Report {
  const b = boundsFor(spec, bounds);
  const started = Date.now();
  const roots = rootsOf(spec, b, seeds);
  const walkVerdicts = verdicts();
  const walked = b.walks > 0 ? walk(spec, roots, b, walkVerdicts, started + b.timeLimit * WALK_SHARE) : NO_WALKS;
  const search = new Search(spec, b, roots, watch, started);
  search.run();
  if (search.refuted) return withoutSymmetry(spec, bounds, seeds, watch, roots, started);
  return reportOf(spec, b, seeds.length, search, walked, walkVerdicts, started);
}

const NO_WALKS: WalkResult = { runs: 0, steps: 0, deepest: 0, findings: [], errors: [] };

/** The bounds asked for, with the reductions the spec's properties rule out turned off. */
function boundsFor(spec: Spec, bounds: Partial<Bounds>): Bounds {
  const b: Bounds = { ...DEFAULT_BOUNDS, ...bounds, instances: { ...DEFAULT_BOUNDS.instances, ...bounds.instances } };
  // A `never` property that reads the path's events in order tells orders apart, so no two orders commute for it.
  if (spec.properties.some((p) => p.kind === "never" && /\.events\b/.test(String(p.never)))) b.reduce = false;
  // Step properties and liveness need every edge, which skipping orders drops; liveness is
  // judged without symmetry for now (RFD0006: a property naming one instance is not symmetric).
  const liveness = spec.properties.some(isLiveness);
  if (liveness || spec.properties.some((p) => p.kind === "everyStep")) b.reduce = false;
  if (liveness) b.symmetry = false;
  return b;
}

/** Where the search starts: the initial world, then each seed; with the symmetry of each, when the bounds use it. */
interface Root {
  name?: string;
  world: World;
  symmetry: Symmetry;
}

function rootsOf(spec: Spec, b: Bounds, seeds: Seed[]): Root[] {
  return [{ world: initialWorld(spec, b) }, ...seeds].map((r) => ({ ...r, symmetry: b.symmetry ? symmetryOf(spec, r.world) : NO_SYMMETRY }));
}

/** A symmetry claim turned out false: search again without it, and say which actors claimed it. */
function withoutSymmetry(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[], watch: Watch, roots: Root[], started: number): Report {
  const again = check(spec, { ...bounds, symmetry: false }, seeds, watch);
  const classes = roots.flatMap((r) => r.symmetry.classes.map((c) => c.ids));
  const actors = [...new Set(classes.flatMap((ids) => ids.map((id) => roots[0].world.instances.find((i) => i.id === id)?.actor ?? id)))];
  return { ...again, durationMs: Date.now() - started, reductions: { ...again.reductions, refuted: actors } };
}

/** Nodes to expand next; `only`, for a node expanded before, the steps to try now (see revisit). */
type Frontier = { node: number; only?: Set<string> }[];

/** What one expansion has done so far, for the sleep sets and the inputs reduction. */
interface Expansion {
  only: Set<string> | undefined;
  tried: [string, Facts][];
  inputsTried: Map<string, { inputs: Record<string, unknown>; read: Set<string> }[]>;
  next: Frontier;
}

/**
 * The breadth-first search: the nodes it found, and what it judged of them. Each node is a
 * world plus the budget spent getting there; the search judges afresh (not trusting what the
 * random runs found), so its counterexamples are the shortest.
 */
class Search {
  readonly nodes: Node[] = [];
  readonly verdicts = verdicts();
  /** The node where each property first broke. */
  readonly failures = new Map<string, number>();
  /** The node where each spec error was first met. */
  readonly errors = new Map<string, number>();
  readonly saved = { orders: 0, inputs: 0 };
  /** For liveness: the edges out of each expanded node, and the fair steps possible in it (liveness.ts). */
  readonly edges: Edge[][] = [];
  readonly enabled: Map<string, Fairness>[] = [];
  stuckAt: number | undefined;
  depthReached = 0;
  stoppedBy: Report["stoppedBy"];
  refuted = false;
  private readonly seen = new Map<string, number>();
  private readonly nevers: PropertyInfo[];
  private readonly keepsEdges: boolean;
  private twinChecks = 0;

  constructor(
    private readonly spec: Spec,
    private readonly b: Bounds,
    readonly roots: Root[],
    private readonly watch: Watch,
    private readonly started: number,
  ) {
    this.nevers = spec.properties.filter((p) => p.kind === "never");
    this.keepsEdges = spec.properties.some(isLiveness);
  }

  run(): void {
    let frontier = this.start();
    search: while (frontier.length) {
      const next: Frontier = [];
      for (const { node, only } of frontier) {
        if (this.nodes[node].depth >= this.b.depth) continue;
        if (!this.expand(node, only, next)) break search;
      }
      frontier = next;
    }
    // Liveness needs the edges out of the worlds at the depth bound too. Where every step from
    // one lands on a known state, nothing lies past it, and its edges are added: in a space the
    // bound does not cut, liveness is then judged in full, as TLC would.
    if (this.keepsEdges && !this.stoppedBy) for (const [index, node] of this.nodes.entries()) if (!node.expanded && !node.shadow) this.close(index);
  }

  /** A node's path as a counterexample, from its root. */
  counterexample(index: number): Counterexample {
    const root = this.roots[this.nodes[index].root];
    return { ...replay(this.spec, root.world, pathChoices(this.nodes, index)), ...(root.name ? { from: root.name } : {}) };
  }

  graph(): Graph {
    return graphOf(this.nodes, this.edges, this.enabled);
  }

  /** One node per distinct root, judged. */
  private start(): Frontier {
    const frontier: Frontier = [];
    for (const [root, { world }] of this.roots.entries()) {
      const key = this.keyOf(world, {}, 0, root, this.memory(() => []));
      if (this.seen.has(key)) continue;
      this.seen.set(key, this.nodes.length);
      this.nodes.push({ parent: -1, root, choice: null, event: null, depth: 0, faults: 0, acts: {}, world, sleep: new Map(), expanded: false });
      this.watch.state?.(world, { acts: {}, faults: 0, memory: this.memory(() => []) });
      frontier.push({ node: this.nodes.length - 1 });
    }
    for (const { node } of frontier) this.examine(node);
    return frontier;
  }

  /** Every step from a node; false if the search must stop (out of budget, or symmetry refuted). */
  private expand(index: number, only: Set<string> | undefined, next: Frontier): boolean {
    const node = this.nodes[index];
    const options = branches(this.spec, node.world, node.faults < this.b.faults);
    if (this.keepsEdges) {
      this.edges[index] = [];
      this.enabled[index] = fairStepsIn(this.spec, node.world, options);
    }
    const expansion: Expansion = { only, tried: [], inputsTried: new Map(), next };
    for (const choice of options) {
      if (this.nodes.length >= this.b.maxStates) return (this.stoppedBy = "maxStates"), false;
      if (Date.now() - this.started > this.b.timeLimit) return (this.stoppedBy = "timeLimit"), false;
      if (!this.take(index, choice, expansion)) return false;
    }
    node.expanded = true;
    return true;
  }

  /** One step from a node: skipped if a reduction says its result is known, else taken and its world recorded. False if symmetry is refuted. */
  private take(index: number, choice: Choice, expansion: Expansion): boolean {
    const node = this.nodes[index];
    const name = stepName(node.world, choice);
    if (expansion.only ? !expansion.only.has(name) : node.sleep.has(name)) {
      if (!expansion.only) this.saved.orders++;
      return true;
    }
    const budget = spend(node, choice, this.b.repeats);
    if (!budget) return true;
    if (this.sameInputsTried(choice, expansion)) {
      this.saved.inputs++;
      return true;
    }
    const observed = observation();
    const step = apply(this.spec, node.world, choice, { explain: false, observe: observed });
    if (choice.kind === "act") {
      const id = `${choice.instance}.${choice.key}`;
      expansion.inputsTried.set(id, [...(expansion.inputsTried.get(id) ?? []), { inputs: choice.inputs, read: observed.inputs }]);
    }
    const facts: Facts = { target: targetOf(node.world, choice), observed, failed: !!step.event.error, setsTimer: step.event.started.length > 0 };
    const sleep = this.childSleep(node, facts, expansion);
    expansion.tried.push([name, facts]);
    return this.land(index, choice, step, budget, sleep, expansion.next);
  }

  /** An earlier try of this action read only inputs this one shares: same result. */
  private sameInputsTried(choice: Choice, expansion: Expansion): boolean {
    if (!this.b.reduce || choice.kind !== "act") return false;
    const tries = expansion.inputsTried.get(`${choice.instance}.${choice.key}`) ?? [];
    return tries.some((t) => [...t.read].every((k) => Object.is(t.inputs[k], choice.inputs[k])));
  }

  /** What the child need not try: what this node skipped or already tried, where it commutes with this step. */
  private childSleep(node: Node, facts: Facts, expansion: Expansion): Map<string, Facts> {
    const sleep = new Map<string, Facts>();
    if (!this.b.reduce || expansion.only) return sleep;
    for (const [k, f] of node.sleep) if (commute(f, facts)) sleep.set(k, f);
    for (const [k, f] of expansion.tried) if (commute(f, facts)) sleep.set(k, f);
    return sleep;
  }

  /**
   * Where a step lands. A step that lands on a known state still ran: it counts as reached.
   * A step that fails, or breaks a step property, is judged all the same: its counterexample
   * ends with the step itself, so it gets a node of its own that stands for nothing else (a
   * shadow). False if the known state's twin refutes the symmetry claim.
   */
  private land(index: number, choice: Choice, step: ReturnType<typeof apply>, budget: { acts: Record<string, number>; faults: number }, sleep: Map<string, Facts>, next: Frontier): boolean {
    const node = this.nodes[index];
    const remembered = this.memory(() => [...pathEvents(this.nodes, index), step.event]);
    const key = this.keyOf(step.world, budget.acts, budget.faults, node.root, remembered);
    this.verdicts.reached.add(`${step.event.actor}.${step.event.key}`);
    const failed = !!step.event.error;
    const breaks = failed ? [] : stepBreaks(this.spec, node.world, step.world, step.event, this.verdicts.broken);
    const existing = this.seen.get(key);
    // A failed step goes nowhere: no edge for liveness.
    const edgeTo = (to: number) => this.keepsEdges && !failed && this.edges[index].push(edgeOf(this.spec, node.world, choice, to));
    const news = breaks.length > 0 || (failed && !this.verdicts.errors.has(step.event.error!));
    if (existing !== undefined) {
      edgeTo(existing);
      if (!news) {
        if (this.roots[node.root].symmetry.classes.length && !this.twinsAgree(this.nodes[existing].world, step.world, node.root)) return (this.refuted = true), false;
        if (this.b.reduce) this.revisit(existing, step.world, sleep, next);
        return true;
      }
    }
    const shadow = failed || existing !== undefined;
    if (!shadow) {
      this.seen.set(key, this.nodes.length);
      edgeTo(this.nodes.length);
    }
    this.nodes.push({ parent: index, root: node.root, choice, event: step.event, depth: node.depth + 1, faults: budget.faults, acts: budget.acts, world: step.world, sleep, expanded: false, ...(shadow ? { shadow } : {}) });
    if (!shadow) this.watch.state?.(step.world, { acts: budget.acts, faults: budget.faults, memory: remembered });
    this.depthReached = Math.max(this.depthReached, node.depth + 1);
    this.examine(this.nodes.length - 1, breaks);
    if (!shadow) next.push({ node: this.nodes.length - 1 });
    return true;
  }

  /** A world at the depth bound: its edges, if each lands on a known state; else it stays open. */
  private close(index: number): void {
    const node = this.nodes[index];
    const options = branches(this.spec, node.world, node.faults < this.b.faults);
    const out: Edge[] = [];
    for (const choice of options) {
      const budget = spend(node, choice, this.b.repeats);
      if (!budget) continue;
      const step = apply(this.spec, node.world, choice, QUIET);
      if (step.event.error) continue;
      const to = this.seen.get(this.keyOf(step.world, budget.acts, budget.faults, node.root, this.memory(() => [...pathEvents(this.nodes, index), step.event])));
      if (to === undefined) return;
      out.push(edgeOf(this.spec, node.world, choice, to));
    }
    this.edges[index] = out;
    this.enabled[index] = fairStepsIn(this.spec, node.world, options);
    node.expanded = true;
  }

  /** Judge a new node: the properties and errors its step meets, and whether it is stuck. */
  private examine(index: number, alsoBroken: string[] = []): void {
    const node = this.nodes[index];
    const { findings, error } = judge(this.spec, node.event, () => pathEvents(this.nodes, index), this.verdicts);
    for (const id of [...findings, ...alsoBroken.filter((id) => !findings.includes(id))]) {
      this.verdicts.broken.add(id);
      this.failures.set(id, index);
    }
    if (error) {
      this.verdicts.errors.add(error);
      this.errors.set(error, index);
    }
    // Fewest faults first, then shortest (the search goes breadth first).
    if (!node.shadow && (this.stuckAt === undefined || node.faults < this.nodes[this.stuckAt].faults) && stuck(this.spec, node.world)) this.stuckAt = index;
  }

  /** A state reached again: anything it skipped that this path did not is tried after all. */
  private revisit(index: number, world: World, sleep: Map<string, Facts>, next: Frontier): void {
    const node = this.nodes[index];
    if (!node.sleep.size) return;
    // A renamed twin's step names do not match; wake everything rather than translate them.
    const same = !this.roots[node.root].symmetry.classes.length || canonical(world) === canonical(node.world);
    const woken = new Set([...node.sleep.keys()].filter((k) => !same || !sleep.has(k)));
    if (!woken.size) return;
    for (const k of woken) node.sleep.delete(k);
    if (node.expanded) next.push({ node: index, only: woken });
  }

  /** Symmetry is a claim; test it on the twins the search merges: both must have the same next steps. */
  private twinsAgree(a: World, b: World, root: number): boolean {
    if (this.twinChecks >= TWIN_CHECKS || canonical(a) === canonical(b)) return true;
    this.twinChecks++;
    return sameSet(successors(this.spec, a, this.roots[root].symmetry), successors(this.spec, b, this.roots[root].symmetry));
  }

  /** A state: the world, plus the budget spent getting there, plus what `never` properties remember of the way there (see memoryOf). */
  private keyOf(world: World, acts: Record<string, number>, faults: number, root: number, remembered: string): string {
    return `${symmetricKey(world, this.roots[root].symmetry)}${actsKey(acts)}|${faults}|${remembered}`;
  }

  private memory(events: () => Event[]): string {
    return this.nevers.length ? memoryOf(this.nevers, events()) : "";
  }
}

/** The report: each property's verdict (from the search, else a random run), errors, stuck, coverage. */
function reportOf(spec: Spec, b: Bounds, seeds: number, search: Search, walked: WalkResult, walkVerdicts: Verdicts, started: number): Report {
  const { roots, nodes } = search;
  const named = (root: number, ce: Counterexample): Counterexample => ({ ...ce, ...(roots[root].name ? { from: roots[root].name } : {}) });
  const fromRoot = (root: number, choices: Choice[]) => named(root, replay(spec, roots[root].world, choices));
  const fromWalk = (id: string): Counterexample | undefined => {
    const found = walked.findings.find((f) => f.id === id);
    return found && named(found.root, shrink(spec, roots[found.root].world, found, fromRoot(found.root, found.choices)));
  };
  const liveness = spec.properties.filter(isLiveness);
  const judgedLive = liveness.length ? livenessVerdicts(spec, liveness, search.graph(), (root) => roots[nodes[root].root].name, !!search.stoppedBy) : new Map<string, PropertyResult>();
  const properties = spec.properties.map((property): PropertyResult => {
    const live = judgedLive.get(property.id);
    if (live) return live;
    const base = verdictBase(property);
    const found = search.failures.get(property.id);
    if (found !== undefined) return { ...base, holds: false, counterexample: search.counterexample(found), foundBy: "search" };
    const walkedTo = fromWalk(property.id);
    if (walkedTo) return { ...base, holds: false, counterexample: walkedTo, foundBy: "walk" };
    return { ...base, holds: true };
  });
  const stuckFound =
    search.stuckAt !== undefined ? { counterexample: search.counterexample(search.stuckAt), foundBy: "search" as const } : walked.stuck ? { counterexample: fromRoot(walked.stuck.root, walked.stuck.choices), foundBy: "walk" as const } : undefined;
  const walkErrors = walked.errors.filter((e) => !search.errors.has(e.message)).map((e) => ({ message: e.message, counterexample: fromRoot(e.root, e.choices) }));
  const reached = new Set([...search.verdicts.reached, ...walkVerdicts.reached]);
  const all = allSteps(spec);
  return {
    spec: spec.name,
    bounds: b,
    seeds,
    states: nodes.length,
    exhaustive: !search.stoppedBy,
    stoppedBy: search.stoppedBy,
    depthReached: search.depthReached,
    durationMs: Date.now() - started,
    properties,
    errors: [...[...search.errors].map(([message, index]) => ({ message, counterexample: search.counterexample(index) })), ...walkErrors],
    ...(stuckFound ? { stuck: stuckFound } : {}),
    coverage: { reached: all.filter((k) => reached.has(k)), missed: all.filter((k) => !reached.has(k)) },
    walks: { runs: walked.runs, steps: walked.steps, deepest: walked.deepest },
    reductions: { ...search.saved, symmetric: roots[0].symmetry.classes.map((c) => c.labels) },
  };
}

/** What every verdict on a property carries. */
function verdictBase(property: PropertyInfo) {
  return { id: property.id, kind: property.kind, description: property.description, ...(property.known === undefined ? {} : { known: property.known }) };
}

/** The budget after a step: actions repeated and faults used; none if the step would take an action past the repeats bound. */
function spend(node: { acts: Record<string, number>; faults: number }, choice: Choice, repeats: number): { acts: Record<string, number>; faults: number } | undefined {
  if (choice.kind === "lose" || choice.kind === "restart") return { acts: node.acts, faults: node.faults + 1 };
  if (choice.kind !== "act") return { acts: node.acts, faults: node.faults };
  const id = `${choice.instance}.${choice.key}`;
  const taken = node.acts[id] ?? 0;
  return taken >= repeats ? undefined : { acts: { ...node.acts, [id]: taken + 1 }, faults: node.faults };
}

/** Singletons, plus the configured number of every other actor, labelled by actor: "Mac", or "Mac A", "Mac B"… */
export function initialWorld(spec: Spec, bounds: Pick<Bounds, "instances">): World {
  let world = startWorld(spec).at(-1)?.world ?? { seq: 0, fresh: {}, rng: 1, instances: [], pending: [] };
  for (const actor of spec.actors.filter((a) => !a.singleton)) {
    const count = bounds.instances[actor.name] ?? 1;
    for (let n = 0; n < count; n++) world = spawn(spec, world, actor.name, count === 1 ? actor.name : `${actor.name} ${String.fromCharCode(65 + n)}`).world;
  }
  return world;
}

// What never properties remember -------------------------------------------------------------------

/**
 * A `never` property judges the whole path, so two paths to one world are one state only if
 * the property remembers the same of both. It sees the path through `count` and `some`, each
 * over single events, so the answers those calls give are all it can remember: they go in the
 * key. A property that reads `trace.events` itself could remember anything, so then the whole
 * path goes in: no two paths are merged.
 */
function memoryOf(nevers: Spec["properties"], events: Event[]): string {
  const base = traceView(events);
  const memory: unknown[] = [];
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
      invariant.never(trace);
    } catch {
      memory.push("!");
    }
  }
  return opaque ? `path:${events.map((e) => `${e.actor}.${e.key}`).join(",")}` : JSON.stringify(memory);
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

// Liveness counterexamples --------------------------------------------------------------------------

/**
 * A step's fairness (RFD0006): its identity, the same wherever it is possible, and how fair it
 * is. Deliveries, timers and guards are weakly fair unless their transition says otherwise;
 * actions and faults are never fair.
 */
function fairness(spec: Spec, world: World, choice: Choice): { id: string; kind: Fairness } | undefined {
  if (choice.kind === "act" || choice.kind === "lose" || choice.kind === "restart") return undefined;
  let id: string;
  let key: string;
  let instance: string;
  if (choice.kind === "guard") {
    id = `g|${choice.instance}|${choice.key}`;
    key = choice.key;
    instance = choice.instance;
  } else {
    const pending = world.pending.find((p) => p.id === choice.pending)!;
    id = pending.kind === "deliver" ? `d|${pendingText(pending)}` : `t|${pending.to}|${pending.timer}`;
    key = pending.kind === "deliver" ? pending.message : pending.timer;
    instance = pending.to;
  }
  const actor = world.instances.find((i) => i.id === instance)?.actor;
  const fair = actor ? actorNamed(spec, actor).transitions[key]?.fair : undefined;
  if (fair === false) return undefined;
  return { id, kind: fair ?? "weak" };
}

/** The fair steps possible in a world, among its options, by identity. */
function fairStepsIn(spec: Spec, world: World, options: Choice[]): Map<string, Fairness> {
  return new Map(options.flatMap((c) => fairness(spec, world, c) ?? []).map((f) => [f.id, f.kind]));
}

function edgeOf(spec: Spec, world: World, choice: Choice, to: number): Edge {
  const fair = fairness(spec, world, choice);
  return { to, choice, ...(fair ? { fair: fair.id } : {}) };
}

/** The explored graph, for liveness: unexpanded nodes have no edges and no fair steps. */
function graphOf(nodes: Node[], edges: Edge[][], enabled: Map<string, Fairness>[]): Graph {
  return {
    worlds: nodes.map((n) => n.world),
    roots: nodes.flatMap((n, i) => (n.parent < 0 ? [i] : [])),
    initial: 0,
    expanded: nodes.map((n) => n.expanded),
    shadow: nodes.map((n) => !!n.shadow),
    edges: nodes.map((_, i) => edges[i] ?? []),
    enabled: nodes.map((_, i) => enabled[i] ?? new Map()),
    parent: nodes.map((n) => n.parent),
    choiceFrom: nodes.map((n) => n.choice),
  };
}

/**
 * Each liveness property's verdict, by id. A property that held after the search stopped
 * early is unfinished; `seedOf` names the scenario a counterexample starts from, if any.
 */
function livenessVerdicts(spec: Spec, liveness: LivenessProperty[], graph: Graph, seedOf: (root: number) => string | undefined, stoppedEarly: boolean): Map<string, PropertyResult> {
  return new Map(
    liveness.map((property): [string, PropertyResult] => {
      const verdict = judgeLiveness(spec, graph, property);
      const base = { ...verdictBase(property), ...(verdict.tested === undefined ? {} : { tested: verdict.tested }) };
      if (verdict.holds) return [property.id, { ...base, holds: true, ...(verdict.unfinished || stoppedEarly ? { unfinished: true } : {}) }];
      return [property.id, { ...base, holds: false, ...lassoOf(spec, graph, verdict.lasso, seedOf(verdict.lasso.root)), foundBy: "search" }];
    }),
  );
}

/** A lasso as a counterexample and the loop after it, replayed with explanations. Steps are matched to the world they run in by what they carry, since paths through the graph differ from the ones the search took. */
function lassoOf(spec: Spec, graph: Graph, lasso: Lasso, from: string | undefined): { counterexample: Counterexample; loop: Counterexample } {
  const run = (start: World, steps: Lasso["prefix"]): Counterexample => {
    const out: Counterexample = { initial: start, choices: [], events: [], worlds: [] };
    let world = start;
    for (const { choice, from: node } of steps) {
      const now = rebind(spec, graph.worlds[node], world, choice);
      if (!now) throw new Error(`a liveness counterexample does not replay at ${choice.kind}`);
      const step = apply(spec, world, now);
      out.choices.push(now);
      out.events.push(step.event);
      out.worlds.push(step.world);
      world = step.world;
    }
    return out;
  };
  const counterexample = { ...run(graph.worlds[lasso.root], lasso.prefix), ...(from ? { from } : {}) };
  return { counterexample, loop: run(counterexample.worlds.at(-1) ?? counterexample.initial, lasso.loop) };
}
