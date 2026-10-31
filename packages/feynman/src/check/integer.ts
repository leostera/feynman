// The integer core: the checker's breadth-first search, on worlds as integers (research note
// personal/feynman/checker-performance; RFD0008).
//
// Copying, freezing, writing out and hashing whole worlds of JS objects on every step is slow,
// and nearly every handler call repeats a local step made before. So:
//
// - every instance state, message and timer is interned once and named by an integer, so a
//   world is a short Int32Array (see Layout);
// - a local step (an instance, in one state, taking one step, with one argument, with its own
//   timers as they are) runs through the engine once, and its effect is kept as integers: the
//   new state, the pending ids it removes and those it adds;
// - a world's fingerprint is a sum of hashes of its parts (Zobrist), which a step updates for
//   the parts it changes; a child's vector is built only when the fingerprint is new. Only
//   fingerprints are kept of the worlds seen, with a parent and a choice per node, so paths
//   are replayed on real worlds when a report needs them.
//
// Steps that read other instances, or hand out fresh ids or random numbers, depend on more
// than the key says: they run through the engine every time (the engine's Observation says
// which). It judges every kind of property (liveness on the graph it keeps), errors, stuck
// worlds, coverage and symmetry. The tests and the fuzzer hold it to the reference explorer
// (test/check/reference.ts), and the TLA+ and P oracles to TLC and P.
import { act, actorNamed, FAULT, fire, guard, holdsIn, isLiveness, observation, stepsTaking, traceView, whenHolds, worldView, type Delivery, type Event, type Fairness, type Observation, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { deliveryIn } from "../spec/engine.ts";
import { sortedJson } from "../spec/json.ts";
import type { Bounds, Root, StopReason, Watch } from "./explore.ts";
import { MEMORY_EVERY, overMemory } from "./memory.ts";
import { startBreaks, stuck } from "./judge.ts";
import { instanceLine, renamedLine, type Symmetry } from "./keys.ts";
import { predicatesOf, type Edge, type FairId, type Graph, type LassoStep, type Predicate } from "./liveness.ts";
import { fairness } from "./fairness.ts";
import { memoryOf, rootMemory } from "./nevers.ts";
import { PrintMap } from "./prints.ts";
import { apply, branches, inputCombinations, QUIET, type Choice } from "./steps.ts";

type Instance = World["instances"][number];
type Pending = World["pending"][number];
type PendingTemplate = Omit<Pending, "id">;

/** One thing the explored states differ in, and in how many ways (see `IntegerSearch.variety`). */
export interface Variety {
  /** `Actor.field`, or `message name` for the messages of that name in flight. */
  what: string;
  values: number;
}

/** Values named by integers: each distinct one (by its key) once. */
class Interner<T> {
  private ids = new Map<string, number>();
  readonly values: T[] = [];
  readonly keys: string[] = [];

  id(key: string, value: () => T): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      this.ids.set(key, (id = this.values.push(value()) - 1));
      this.keys.push(key);
    }
    return id;
  }
}

/** For one renaming of a symmetry: the renamed key line of each state and pending entry, by id (see `IntegerSearch.symmetricPrint`). */
interface Renamed {
  renaming: Map<string, string>;
  identity: boolean;
  /** By state and pending id: the renamed line's id. */
  states: number[];
  pendings: number[];
}

/**
 * Where things are in a world's vector:
 * [state id per instance | fresh id | rng | variables | memory | message count | message ids |
 *  timer ids], messages and timers each
 * oldest first. An instance's state id covers its own variables; `variables` is the world's.
 * The memory is what `never` properties remember of the path (nevers.ts memoryOf), interned.
 *
 * Messages are a bag to the fingerprint, but kept in the order they were sent, as the engine's
 * worlds are: so the choices from a vector come in the order `branches` gives them
 * (pendingInOrder), and the first counterexample found is the one the reference explorer finds.
 */
interface Layout {
  /** Which layout, in the fingerprint: worlds with other instances are other states. */
  index: number;
  instances: Instance[];
  /** Each instance's slot, by id. */
  slots: Map<string, number>;
  /** What each instance state can do, by state id; with the world's variables, when its actor's `when`s read them. */
  plans: LocalPlan[];
  plansWithVariables: Map<number, LocalPlan>;
  /** `timersOf` for a vector without timers: shared, never written. */
  noTimers: Int32Array;
  /**
   * The step cache, by (state id, own timers list) and then by step and argument. One per
   * layout: a step sees which instances there are (`ctx.all`, `ctx.the`, sending to one)
   * without reading their states, so its effect holds only among the same instances. A step
   * that uses the world's variables is cached by their value as well (cachedIn).
   */
  cache: Map<number, Cached>[][];
  /** The effects of steps that leave their own instance alone (a lost message), by slot and then as `cache`: whatever the instance's state. */
  apart: Map<number, Cached>[];
  /** By interned message or timer: the slot of the instance it is for. */
  slotOf: number[];
  fresh: number;
  rng: number;
  /** The world's model variables (RFD0012), interned. */
  variables: number;
  memory: number;
  messages: number;
}

/** A step of a lasso, replayed: its choice, and the world it was taken in, when asked for. */
export interface Resolved {
  choice: Choice;
  world?: World;
}

/** A cached effect: one, or one for each value of the world's variables when the step uses them. */
type Cached = Effect | Map<number, Effect>;

/** What a local step does, as integers. */
interface Effect {
  error?: string;
  /** The step's `actor.key`, for coverage, interned (`IntegerSearch.stepKeys`). */
  reached: number;
  state: number;
  /** Message ids it removes (the one delivered or lost first, if so); timer ids it removes. */
  removesMessages: Int32Array;
  removesTimers: Int32Array;
  /** Message and timer ids it adds, in the order sent and set. */
  addsMessages: Int32Array;
  addsTimers: Int32Array;
  /** What a trace sees of the step's event, interned (see `TraceStep`). */
  event: number;
  /** Whether the step is tagged `fault`. */
  fault: boolean;
  /** It leaves its instance's state as it was, and did not read it: `state` is unused. */
  apart?: boolean;
  /** For steps that are not cached: the counters after them. */
  fresh?: number;
  rng?: number;
  /** The world's variables after it, for a step that uses them. */
  variables?: number;
  /** A reset's choice of the messages on their way to the instance to drop, with its answer for each interned message, worked out once. */
  drops?: { pick: (delivery: Delivery) => boolean; answers: number[] };
}

/** What `never` and step properties see of an event (traceView): its place goes in when a path is laid out. */
type TraceStep = Pick<Event, "actor" | "key" | "error" | "sent">;

/** A choice, as it can be found again in any world: messages and timers by what they are, not by their ids there. */
interface ChoiceName {
  kind: Choice["kind"];
  instance?: string;
  key?: string;
  inputs?: Record<string, unknown>;
  /** For `fire`: the pending entry's intern id. */
  pending?: number;
}

/** A frontier entry: a node, its world's vector, and its fingerprint. */
interface Entry {
  gid: number;
  layout: Layout;
  /** Its world as properties see it (`IntegerSearch.tupleOf`). */
  tuple: number;
  vector: Int32Array;
  h1: number;
  h2: number;
}

/**
 * A vector ready to step from. Its world is built only when something needs it: a step that
 * runs through the engine, or liveness fairness. Pending ids in that world are places in the
 * vector's pending part, from 1, so the intern id of pending entry `k` is
 * `vector[layout.messages + k]`.
 */
interface Here {
  vector: Int32Array;
  layout: Layout;
  /** Each instance's own timers, as a list id (from 1; 0 for none), for the step cache's key. */
  timersOf: Int32Array;
  world(): World;
}

/** What an instance in one state can do, whatever else is in the world (see `IntegerSearch.planOf`). */
interface LocalPlan {
  /** Actions whose `when` holds: their choices, or their inputs when those come from `examples`, which read the world. */
  acts: { key: string; choices?: Choice[]; inputs?: ActionInputs }[];
  guards: Choice[];
  /** By interned message or timer: the steps that can take it (`stepIndex`), worked out when first met (takers). */
  /** By interned message or timer. */
  takers: number[][];
}

type ActionInputs = Parameters<typeof inputCombinations>[2];

/** A frontier entry being expanded, and what its steps share. */
interface Expanding {
  parent: Entry;
  depth: number;
  here: Here;
  symmetry: Symmetry;
  /** For `never` properties: the trace steps on the way to the parent, worked out when first asked for. */
  trail: (() => TraceStep[]) | undefined;
}

/** A step, as what it changes in the vector. */
interface Step {
  layout: Layout;
  slot: number;
  /** Where in the vector the message delivered is; -1 for other steps. */
  at: number;
  effect: Effect;
  /** Its step is tagged `fault` (RFD0012): counterexamples prefer fewer. */
  fault: boolean;
  /** What `never` properties remember after it. */
  memory: number;
}

/** The search, with what `reportOf` (explore.ts) reads of it. */
export class IntegerSearch {
  readonly failures = new Map<string, number>();
  readonly errors = new Map<string, number>();
  stuckAt: number | undefined;
  states = 0;
  stoppedBy: StopReason | undefined;
  /** Whether the search ran out of worlds before the depth bound: it has explored every world reachable. */
  complete = false;
  /** Whether a new world was found at the depth bound, and not expanded. */
  private cut = false;
  /** Where `run` goes on from, if it stopped at a deadline. */
  private resume: { frontier: Entry[]; next: Entry[]; depth: number; at: number } | undefined;
  /** For liveness: the nodes at the depth bound, whose edges are added at the end if they can be. */
  private open: Entry[] = [];
  /** A symmetry claim turned out false: the search stopped, to be run again without it. */
  refuted = false;
  depthReached = 0;
  /** Every path of up to this many events, from each root, was explored; the rest only if not stopped. */
  completeDepth = 0;
  /** The most messages in flight at once in any explored world. */
  mostInFlight = 0;
  /** Stop once every property has broken: nothing is left to learn (a rule's claim, RFD0010). */
  untilBroken = false;
  /** Whether it stopped because every property had broken. */
  allBroken = false;
  readonly root: number[] = [];
  private parent: number[] = [];
  /** How each node was reached from its parent: a `ChoiceName` id, found again in any world. */
  private named: number[] = [];
  private faults: number[] = [];
  private depth: number[] = [];
  /** Each node's last event, as a `TraceStep` id: a path's events go up its parents, oldest last. */
  private eventOf: number[] = [];
  private readonly broken = new Set<string>();

  private instanceStates = new Interner<Instance>();
  private pendings = new Interner<PendingTemplate>();
  /** By `actor.step`: whether the step is tagged `fault`. */
  private freshes = new Interner<Record<string, number>>();
  private stepArgs = new Interner<string>();
  private stepNames = new Interner<string>();
  private readsWorld = new Map<string, boolean>();
  /** The world's variables, by their key; 0 is none set, so a spec without variables keeps 0. */
  private worldVariables = (() => {
    const interner = new Interner<Record<string, unknown>>();
    interner.id("", () => ({}));
    return interner;
  })();
  /** `takers`, by pending entry and then by its receiver's state. */
  /** By instance state id: whether a `when` of its actor reads the world's variables (whenReadsWorld). */
  private readsWorldIn: boolean[] = [];
  private fires: Fire[][] = [];
  /** By step index: a step that has run apart from its instance's state (Effect.apart). */
  private runsApart: boolean[] = [];
  private timerLists = new Interner<string>();
  private names = new Interner<ChoiceName>();
  /** What a step adds to `never` properties' memory (remember), by memory and then by trace step. */
  private memorySteps: { memory: number; nevers: string[] }[][] = [];
  /** Fires' fairness (fairOf), by step index and then by interned message or timer; null for none. */
  private fairFires: ({ id: FairId; kind: Fairness } | null)[][] = [];
  /** Fires' names (nameIn), by step index and then by interned message or timer. */
  private fireNames: number[][] = [];
  private stepKeys = new Interner<string>();
  private traceSteps = new Interner<TraceStep>();
  private memories = new Interner<string>();
  private nevers: PropertyInfo[];
  private everySteps: { id: string; everyStep: Extract<PropertyInfo, { kind: "everyStep" }>["everyStep"] }[];
  private reachedSteps: boolean[] = [];
  /** Key lines (keys.ts), named by integers: what symmetric fingerprints are made of. */
  private lines = new Map<string, number>();
  private renamedBy = new WeakMap<Map<string, string>, Renamed>();
  /** For nodes from roots with symmetry: the fingerprint of the world without renaming, which renamed twins do not share. */
  private plains = new Map<number, [number, number]>();
  private twinChecks = 0;
  /**
   * For choices that do not name a pending entry (actions, guards), which are shared objects
   * (`planOf`): the step cache's argument, and the choice's name, worked out once.
   */
  /** Choices of actions whose inputs come from `examples`, by (tuple, instance, action). */
  private examples = new Map<string, Choice[]>();
  /** While twin checks remain: each state's vector, so a twin's world need not be replayed. */
  private twinWorlds = new Map<number, { vector: Int32Array; layout: Layout }>();
  private seen = new PrintMap();
  /** For liveness: edges out of each expanded node, the fair steps possible there, and which predicates hold. */
  private readonly keepsEdges: boolean;
  private readonly predicates: Predicate[];
  /**
   * Properties see a world's instances and whether anything is pending, nothing else: its
   * tuple, interned. Their answers are kept by tuple, and by pairs of tuples for step
   * properties: most states differ from others only in what is in flight.
   */
  private tuples = new Map<string, number>();
  /** By parent tuple: its children's tuples (childTuple). */
  private tupleSteps: Map<number, number>[] = [];
  /** By tuple: the `always` properties that fail there, and which liveness predicates hold. */
  private alwaysFailing: string[][] = [];
  private truthsByTuple: Uint8Array[] = [];
  /** Each node's tuple, for liveness; -1 for shadow nodes. */
  private tupleOfNode: number[] = [];
  /** By (tuple before, tuple after, trace step): each step property's answer, HOLDS or BREAKS, if known. */
  private stepAnswers = new Map<string, Uint8Array>();
  private expanded: boolean[] = [];
  private shadow: boolean[] = [];
  private option: number[] = [];
  private edges: Edge[][] = [];
  private enabled: Map<FairId, Fairness>[] = [];
  /** One per set of instances the roots have, by their sorted ids. */
  private layouts = new Map<string, Layout>();
  private always: { id: string; holds: (w: World) => boolean }[];

  constructor(
    private readonly spec: Spec,
    private readonly b: Bounds,
    readonly roots: Root[],
    private readonly watch: Watch,
    private readonly started: number,
  ) {
    this.nevers = spec.properties.filter((p) => p.kind === "never");
    this.keepsEdges = spec.properties.some(isLiveness);
    this.predicates = predicatesOf(spec.properties.filter(isLiveness));
    this.everySteps = spec.properties.flatMap((p) => (p.kind === "everyStep" ? [{ id: p.id, everyStep: p.everyStep }] : []));
    this.always = spec.properties.flatMap((p) => (p.kind === "always" ? [{ id: p.id, holds: (w: World) => holdsSafely(() => p.always(worldView(spec, w))) }] : []));
  }

  /** Steps that ran, as `actor.key`. */
  get stats(): { reached: Set<string> } {
    return { reached: new Set(this.stepKeys.values.filter((_, i) => this.reachedSteps[i])) };
  }

  /**
   * The layout for a root's instances. World keys sort instances (keys.ts), so a set of them is one
   * layout, in the order of the first root that has it (which the choices follow).
   */
  private layoutOf(world: World): Layout {
    const key = world.instances.map((i) => i.id).sort().join("\u0000");
    let layout = this.layouts.get(key);
    if (layout) return layout;
    const slots = new Map(world.instances.map((instance, slot) => [instance.id, slot]));
    const n = world.instances.length;
    layout = { index: this.layouts.size, instances: world.instances, slots, plans: [], plansWithVariables: new Map(), noTimers: new Int32Array(n), cache: [], apart: [], slotOf: [], fresh: n, rng: n + 1, variables: n + 2, memory: n + 3, messages: n + 4 };
    this.layouts.set(key, layout);
    return layout;
  }

  /**
   * Breadth first, until the depth bound, a limit, or `deadline` (the time limit's, by default).
   * Stopped by a deadline, it can be run again, and goes on from where it was.
   */
  run(deadline = this.started + this.b.timeLimit): void {
    this.stoppedBy = undefined;
    const r = (this.resume ??= { frontier: this.start(this.open), next: [], depth: 0, at: 0 });
    while (r.frontier.length && r.depth < this.b.depth) {
      for (; r.at < r.frontier.length; r.at++) {
        // Every world within `depth` events has been found and judged: those past it, not all.
        this.completeDepth = r.depth;
        if ((r.at & 255) === 0 && Date.now() > deadline) {
          this.stoppedBy = "timeLimit";
          return;
        }
        if (!this.expand(r.frontier[r.at], r.depth, r.next, this.open)) return;
        if (this.untilBroken && this.broken.size === this.spec.properties.length) {
          this.allBroken = true;
          return;
        }
      }
      r.frontier = r.next;
      r.next = [];
      r.depth++;
      r.at = 0;
    }
    // Nothing new at the depth bound: every world reachable has been explored.
    this.complete = !this.cut;
    // Liveness needs the edges out of the worlds at the depth bound too. Where every step from
    // one lands on a known state, nothing lies past it, and its edges are added: in a space the
    // bound does not cut, liveness is then judged in full, as TLC would.
    if (this.keepsEdges) for (const entry of this.open) this.close(entry);
  }

  /** One node per distinct root: judged, and the frontier to start from. */
  private start(open: Entry[]): Entry[] {
    const frontier: Entry[] = [];
    const memory = this.memories.id(rootMemory(this.spec), () => rootMemory(this.spec));
    for (const [r, { world, symmetry }] of this.roots.entries()) {
      const L = this.layoutOf(world);
      const vector = this.vectorOf(world, memory, L);
      const folded = symmetry.classes.length ? this.symmetricPrint(vector, L, symmetry) : undefined;
      const [h1, h2] = folded ? folded.print : printOf(vector, L);
      if (this.seen.get(h1, h2) !== undefined) continue;
      const gid = this.node(-1, r, -1, -1, 0, -1);
      if (folded) this.keepForTwins(gid, vector, L, folded.plain);
      this.seen.set(h1, h2, gid);
      this.states++;
      this.watch.state?.(world, this.memoryText(vector, L));
      for (const id of startBreaks(this.spec, world)) if (!this.broken.has(id)) this.breaks(id, gid);
      this.judgeStuck(vector, gid, L);
      const tuple = this.tupleOf(vector, L);
      if (this.keepsEdges) this.judgeTruths(tuple, () => world, gid);
      this.queue({ gid, layout: L, tuple, vector, h1, h2 }, 0, frontier, open);
    }
    return frontier;
  }

  /** A new state at a depth: expanded in the next round, or (for liveness) closed at the end. */
  private queue(entry: Entry, depth: number, next: Entry[], open: Entry[]): void {
    if (depth < this.b.depth) next.push(entry);
    else {
      // A new world at the bound: there may be more past it.
      this.cut = true;
      if (this.keepsEdges) open.push(entry);
    }
  }

  /** Every step from a frontier entry, in the order `branches` gives them. False when the search must stop. */
  private expand(parent: Entry, depth: number, next: Entry[], open: Entry[]): boolean {
    const here = this.here(parent.vector, parent.layout);
    const from: Expanding = { parent, depth, here, symmetry: this.roots[this.root[parent.gid]].symmetry, trail: this.nevers.length ? this.lazyTrail(parent.gid) : undefined };
    const options = this.choicesOf(here, parent.tuple);
    if (this.keepsEdges) {
      // Expanded once it is begun, even if the search stops partway.
      this.expanded[parent.gid] = true;
      this.edges[parent.gid] = [];
      this.enabled[parent.gid] = this.fairStepsIn(here, options);
    }
    for (let option = 0; option < options.length; option++) {
      const step = this.step(here, options[option]);
      this.reachedSteps[step.effect.reached] = true;
      const goesOn = step.effect.error ? this.failed(from, option, options[option], step) : this.land(from, option, options[option], step, next, open);
      if (!goesOn) return false;
    }
    return true;
  }

  /**
   * A step that fails: a spec error, which goes nowhere. The first time an error is met, a node
   * of its own (a shadow, not a state) ends its counterexample. False if it refutes symmetry.
   */
  private failed(from: Expanding, option: number, choice: Choice, step: Step): boolean {
    const { parent, symmetry } = from;
    const error = step.effect.error!;
    if (!this.errors.has(error)) {
      this.errors.set(error, this.shadowNode(parent.gid, option, this.nameIn(choice, parent.vector, parent.layout), this.faultsAfter(parent, step), step.effect.event));
      return true;
    }
    if (!symmetry.classes.length) return true;
    // Its world is the one before, with the budget spent: it may land
    // on a renamed twin, whose claim is tested all the same.
    const unchanged = this.applied(parent.vector, { ...step, at: -1, effect: { ...step.effect, state: parent.vector[step.slot], removesMessages: NONE, removesTimers: NONE, addsMessages: NONE, addsTimers: NONE } });
    const folded = this.symmetricPrint(unchanged, parent.layout, symmetry);
    const existing = this.seen.get(folded.print[0], folded.print[1]);
    return existing === undefined || this.sameAsTwin(existing, unchanged, parent.layout, folded.plain, symmetry) || this.refutes();
  }

  /**
   * Where a step lands (see Search.land). On a known state, it adds an edge, and its world is
   * tested against a renamed twin's; if it breaks a step property, a shadow node ends that
   * counterexample. On a new state, a node, judged and queued. False when the search must stop.
   */
  private land(from: Expanding, option: number, choice: Choice, step: Step, next: Entry[], open: Entry[]): boolean {
    const { parent, here, symmetry, depth } = from;
    const L = parent.layout;
    const { effect } = step;
    const nevers = from.trail ? this.remember(parent.vector[L.memory], from.trail, effect.event, step) : NO_IDS;
    let child: Int32Array | undefined;
    let folded: ReturnType<IntegerSearch["symmetricPrint"]> | undefined;
    if (symmetry.classes.length) {
      child = this.applied(parent.vector, step);
      folded = this.symmetricPrint(child, L, symmetry);
    }
    const print = folded ? folded.print : childPrint(parent, step);
    const h1 = print[0];
    const h2 = print[1];
    const existing = this.seen.get(h1, h2);
    const edgeTo = (to: number) => this.keepsEdges && this.edges[parent.gid].push(edgeOf(to, option, step.fault, this.fairOf(here, choice)?.id));
    if (existing !== undefined) edgeTo(existing);
    // A step property is judged on every step, so one broken on the way to a known state counts too.
    let breaks = NO_IDS;
    let tuple: number | undefined;
    if (this.everySteps.length && this.everySteps.some((p) => !this.broken.has(p.id))) {
      const after = (child ??= this.applied(parent.vector, step));
      tuple = this.childTuple(parent, step, after);
      breaks = this.stepBreaks(parent.tuple, tuple, effect.event, depth, () => this.instancesOf(parent.vector, L), () => this.instancesOf(after, L));
    }
    if (existing !== undefined) {
      if (!breaks.length) return !folded || this.sameAsTwin(existing, child!, L, folded.plain, symmetry) || this.refutes();
      const gid = this.shadowNode(parent.gid, option, this.nameIn(choice, parent.vector, L), this.faultsAfter(parent, step), effect.event);
      for (const id of breaks) if (!this.broken.has(id)) this.breaks(id, gid);
      return true;
    }
    if (this.states >= this.b.maxStates) {
      this.stoppedBy = "maxStates";
      return false;
    }
    if (this.states % MEMORY_EVERY === 0 && overMemory(this.b.memoryLimit)) {
      this.stoppedBy = "memoryLimit";
      return false;
    }
    const gid = this.node(parent.gid, this.root[parent.gid], option, this.nameIn(choice, parent.vector, L), this.faultsAfter(parent, step), effect.event);
    edgeTo(gid);
    child ??= this.applied(parent.vector, step);
    this.seen.set(h1, h2, gid);
    if (folded) this.keepForTwins(gid, child, L, folded.plain);
    this.states++;
    if (child[L.messages] > this.mostInFlight) this.mostInFlight = child[L.messages];
    if (this.watch.state) this.watch.state(this.materialize(child, L), this.memoryText(child, L));
    const state = child;
    tuple ??= this.childTuple(parent, step, state);
    if (this.always.length) this.judge(tuple, state, gid, L);
    for (const id of nevers) if (!this.broken.has(id)) this.breaks(id, gid);
    this.judgeStuck(state, gid, L);
    if (this.keepsEdges) this.judgeTruths(tuple, () => this.instancesOf(state, L), gid);
    this.queue({ gid, layout: L, tuple, vector: state, h1, h2 }, depth + 1, next, open);
    for (const id of breaks) if (!this.broken.has(id)) this.breaks(id, gid);
    return true;
  }

  /** A symmetry claim turned out false: the search stops, to be run again without it. */
  private refutes(): false {
    this.refuted = true;
    return false;
  }

  private faultsAfter(parent: Entry, step: Step): number {
    return this.faults[parent.gid] + (step.fault ? 1 : 0);
  }

  /** A node at the depth bound: its edges, if every step from it lands on a known state; else it stays open. */
  private close(entry: Entry): void {
    const { vector, layout: L } = entry;
    const here = this.here(vector, L);
    const symmetry = this.roots[this.root[entry.gid]].symmetry;
    const trail = this.nevers.length ? this.lazyTrail(entry.gid) : undefined;
    const options = this.choicesOf(here, entry.tuple);
    const out: Edge[] = [];
    for (let option = 0; option < options.length; option++) {
      const step = this.step(here, options[option]);
      if (step.effect.error) continue;
      if (trail) this.remember(vector[L.memory], trail, step.effect.event, step);
      const print = symmetry.classes.length ? this.symmetricPrint(this.applied(vector, step), L, symmetry).print : childPrint(entry, step);
      const to = this.seen.get(print[0], print[1]);
      if (to === undefined) return;
      out.push(edgeOf(to, option, step.fault, this.fairOf(here, options[option])?.id));
    }
    this.edges[entry.gid] = out;
    this.enabled[entry.gid] = this.fairStepsIn(here, options);
    this.expanded[entry.gid] = true;
  }

  /** A world as properties see it: its layout, instance states, the world's variables, and whether anything is pending. */
  private tupleOf(vector: Int32Array, L: Layout): number {
    let key = `${L.index}|${vector.length > L.messages + 1 ? 1 : 0}|${vector[L.variables]}`;
    for (let slot = 0; slot < L.instances.length; slot++) key += `,${vector[slot]}`;
    let id = this.tuples.get(key);
    if (id === undefined) this.tuples.set(key, (id = this.tuples.size));
    return id;
  }

  /**
   * A child's tuple: its parent's, but for the stepping instance's state and whether anything
   * is pending, kept by those for each parent tuple; worked out afresh when the variables change.
   */
  private childTuple(parent: Entry, step: Step, child: Int32Array): number {
    const L = step.layout;
    if (child[L.variables] !== parent.vector[L.variables]) return this.tupleOf(child, L);
    const key = (child[step.slot] * L.instances.length + step.slot) * 2 + (child.length > L.messages + 1 ? 1 : 0);
    const byKey = (this.tupleSteps[parent.tuple] ??= new Map());
    let tuple = byKey.get(key);
    if (tuple === undefined) byKey.set(key, (tuple = this.tupleOf(child, L)));
    return tuple;
  }

  /** Which liveness predicates hold in a new state: worked out once per tuple. */
  private judgeTruths(tuple: number, world: () => World, gid: number): void {
    this.tupleOfNode[gid] = tuple;
    if (this.truthsByTuple[tuple]) return;
    const w = world();
    this.truthsByTuple[tuple] = Uint8Array.from(this.predicates, (p) => (holdsIn(this.spec, w, p) ? 1 : 0));
  }

  /**
   * The step properties a step breaks, of those not yet broken: from what is known of the same
   * step between the same tuples, else judged (judge.ts stepBreaks). A predicate that cannot be
   * evaluated holds. One that reads the event's place in the path is not kept: the place is
   * not in the key.
   */
  private stepBreaks(before: number, after: number, event: number, index: number, beforeWorld: () => World, afterWorld: () => World): string[] {
    const key = `${before},${after},${event}`;
    let known = this.stepAnswers.get(key);
    if (!known) this.stepAnswers.set(key, (known = new Uint8Array(this.everySteps.length)));
    let views: { before: ReturnType<typeof worldView>; after: ReturnType<typeof worldView> } | undefined;
    const out: string[] = [];
    this.everySteps.forEach((p, i) => {
      if (this.broken.has(p.id)) return;
      if (known[i] === UNKNOWN) {
        views ??= { before: worldView(this.spec, beforeWorld()), after: worldView(this.spec, afterWorld()) };
        let readsIndex = false;
        const view = traceView([this.eventAt(event, index)]).events[0];
        const watched = Object.defineProperty({ ...view }, "index", {
          get: () => {
            readsIndex = true;
            return index;
          },
        });
        const answer = holdsSafely(() => p.everyStep(views!.before, views!.after, watched)) ? HOLDS : BREAKS;
        if (answer === BREAKS) out.push(p.id);
        if (!readsIndex) known[i] = answer;
      } else if (known[i] === BREAKS) out.push(p.id);
    });
    return out;
  }

  /** The search as a graph, for liveness (liveness.ts). */
  /**
   * What the states differ in, most first: for each actor's state field, how many values it
   * took across the explored worlds, and for each message, how many different ones were in
   * flight. A search too big to finish is usually one or two of these growing without bound.
   */
  variety(): Variety[] {
    const values = new Map<string, Set<string>>();
    const seen = (what: string, value: string) => {
      let set = values.get(what);
      if (!set) values.set(what, (set = new Set()));
      set.add(value);
    };
    for (const instance of this.instanceStates.values) {
      const state = instance.state as Record<string, unknown>;
      if (state === null || typeof state !== "object") continue;
      for (const [field, value] of Object.entries(state)) seen(`${instance.actor}.${field}`, sortedJson(value));
    }
    for (const pending of this.pendings.values) {
      if (pending.kind !== "deliver") continue;
      const p = pending as Extract<Pending, { kind: "deliver" }>;
      const name = this.spec.messages[p.message]?.name ?? p.message;
      seen(`message ${name}`, sortedJson([p.to, p.from, p.payload]));
    }
    return [...values]
      .map(([what, set]) => ({ what, values: set.size }))
      .filter((v) => v.values > 1)
      .sort((a, b) => b.values - a.values)
      .slice(0, 5);
  }

  graph(): Graph {
    const size = this.parent.length;
    const index = new Map(this.predicates.map((p, i) => [p, i]));
    return {
      size,
      holds: (predicate) => {
        const at = index.get(predicate)!;
        return (i) => {
          const tuple = this.tupleOfNode[i];
          return tuple !== undefined && tuple >= 0 && this.truthsByTuple[tuple][at] === 1;
        };
      },
      roots: this.parent.flatMap((p, i) => (p < 0 ? [i] : [])),
      initial: 0,
      expanded: Array.from({ length: size }, (_, i) => this.expanded[i] === true),
      shadow: this.shadow,
      edges: Array.from({ length: size }, (_, i) => this.edges[i] ?? []),
      enabled: Array.from({ length: size }, (_, i) => this.enabled[i] ?? new Map()),
      parent: this.parent,
      optionFrom: this.option,
      faultFrom: this.parent.map((p, i) => p >= 0 && this.faults[i] > this.faults[p]),
    };
  }

  /** Steps as choices, with the world each is taken in when asked for (see Search.resolve). */
  async resolve(steps: LassoStep[], worlds: boolean): Promise<Map<string, Resolved>> {
    const at = new Map<number, World>();
    const out = new Map<string, Resolved>();
    for (const { from, option } of steps) {
      let world = at.get(from);
      if (!world) at.set(from, (world = this.worldAt(from)));
      const choice = branches(this.spec, world)[option];
      out.set(`${from}:${option}`, worlds ? { choice, world } : { choice });
    }
    return out;
  }

  /**
   * Whether a world that landed on a known state up to symmetry behaves as that state's world
   * does: the same next worlds, up to symmetry. Tested on the first `symmetryChecks` renamed
   * twins met (not on the very same world), in the order met.
   */
  private sameAsTwin(existing: number, vector: Int32Array, L: Layout, plain: [number, number], symmetry: Symmetry): boolean {
    const known = this.plains.get(existing)!;
    if (known[0] === plain[0] && known[1] === plain[1]) return true;
    if (this.twinChecks >= this.b.symmetryChecks) return true;
    // Every state made while checks remain is kept, and checks only go up: the twin is here.
    const twin = this.twinWorlds.get(existing)!;
    if (++this.twinChecks === this.b.symmetryChecks) this.twinWorlds.clear();
    return this.successorsKey(twin.vector, twin.layout, symmetry) === this.successorsKey(vector, L, symmetry);
  }

  /**
   * The worlds one step away, each up to symmetry: renamed twins must agree on them.
   */
  private successorsKey(vector: Int32Array, L: Layout, symmetry: Symmetry): string {
    const here = this.here(vector, L);
    const out = new Set<string>();
    for (const choice of this.choicesOf(here, this.tupleOf(vector, L))) {
      const step = this.step(here, choice);
      out.add(step.effect.error ? `error:${step.effect.error}` : this.symmetricPrint(this.applied(vector, step), L, symmetry).world.join(","));
    }
    return [...out].sort().join("\n");
  }

  /** A new state from a root with symmetry: its plain fingerprint, and its vector while twin checks remain. */
  private keepForTwins(gid: number, vector: Int32Array, L: Layout, plain: [number, number]): void {
    this.plains.set(gid, plain);
    if (this.twinChecks < this.b.symmetryChecks) this.twinWorlds.set(gid, { vector, layout: L });
  }

  /** A node's world, replayed from its root. */
  private worldAt(gid: number): World {
    let world = this.roots[this.root[gid]].world;
    for (const choice of this.pathTo(gid)) world = apply(this.spec, world, choice, QUIET).world;
    return world;
  }

  /**
   * A fingerprint up to symmetry: the least, over the renamings, of the renamed world's
   * (instances and pending entries as renamed key lines, keys.ts), with the budget and memory
   * as they are, as world keys have them (keys.ts). Renamed twins have the same set of renamed
   * worlds, so the same least one. Also the world's own fingerprint (no renaming, no budget),
   * and its least without the budget, for twin checks.
   */
  private symmetricPrint(v: Int32Array, L: Layout, symmetry: Symmetry): { print: [number, number]; plain: [number, number]; world: [number, number] } {
    const M = L.messages;
    const end = M + 1 + v[M];
    let base1 = lane1(5, L.index, 0) + lane1(1, L.fresh, v[L.fresh]) + lane1(1, L.rng, v[L.rng]) + lane1(1, L.variables, v[L.variables]);
    let base2 = lane2(5, L.index, 0) + lane2(1, L.fresh, v[L.fresh]) + lane2(1, L.rng, v[L.rng]) + lane2(1, L.variables, v[L.variables]);
    let extra1 = lane1(1, L.memory, v[L.memory]);
    let extra2 = lane2(1, L.memory, v[L.memory]);
    // The least over the renamings, of the world with and without the memory: as numbers, compared hi then lo.
    let best1 = -1;
    let best2 = 0;
    let least1 = -1;
    let least2 = 0;
    let plain: [number, number] = [0, 0];
    const timers: number[] = [];
    for (const renaming of symmetry.renamings) {
      const r = this.renamed(renaming);
      let h1 = base1;
      let h2 = base2;
      for (let s = 0; s < L.instances.length; s++) {
        const line = this.renamedState(r, v[s]);
        (h1 += lane1(6, line, 0)), (h2 += lane2(6, line, 0));
      }
      for (let i = M + 1; i < end; i++) {
        const line = this.renamedPending(r, v[i]);
        (h1 += lane1(3, line, 0)), (h2 += lane2(3, line, 0));
      }
      timers.length = 0;
      for (let i = end; i < v.length; i++) timers.push(this.renamedPending(r, v[i]));
      const t = timersHash(timers, 0);
      (h1 += lane1(4, t, 0)), (h2 += lane2(4, t, 0));
      const w1 = h1 >>> 0;
      const w2 = h2 >>> 0;
      if (r.identity) plain = [w1, w2];
      if (least1 < 0 || w1 < least1 || (w1 === least1 && w2 < least2)) (least1 = w1), (least2 = w2);
      const f1 = (h1 + extra1) >>> 0;
      const f2 = (h2 + extra2) >>> 0;
      if (best1 < 0 || f1 < best1 || (f1 === best1 && f2 < best2)) (best1 = f1), (best2 = f2);
    }
    return { print: [best1, best2], plain, world: [least1, least2] };
  }

  private renamed(renaming: Map<string, string>): Renamed {
    let r = this.renamedBy.get(renaming);
    if (!r) this.renamedBy.set(renaming, (r = { renaming, identity: [...renaming].every(([from, to]) => from === to), states: [], pendings: [] }));
    return r;
  }

  private renamedState(r: Renamed, state: number): number {
    return (r.states[state] ??= this.lineId(renamedLine(this.instanceStates.keys[state], r.renaming)));
  }

  private renamedPending(r: Renamed, pending: number): number {
    return (r.pendings[pending] ??= this.lineId(renamedLine(this.pendings.keys[pending], r.renaming)));
  }

  private lineId(line: string): number {
    let id = this.lines.get(line);
    if (id === undefined) this.lines.set(line, (id = this.lines.size));
    return id;
  }

  /** The trace steps on the way to a node, from its root. */
  private trailOf(gid: number): TraceStep[] {
    const out: TraceStep[] = [];
    for (let at = gid; this.parent[at] >= 0; at = this.parent[at]) out.push(this.traceSteps.values[this.eventOf[at]]);
    return out.reverse();
  }

  private lazyTrail(gid: number): () => TraceStep[] {
    let trail: TraceStep[] | undefined;
    return () => (trail ??= this.trailOf(gid));
  }

  /**
   * What `never` properties remember after a step: into the step, and which of them the path
   * breaks. Paths that remember the same are one state, so what a step adds depends only on the
   * memory before it and the step: worked out on the trail once for each, then kept.
   */
  private remember(before: number, trail: () => TraceStep[], event: number, step: Step): string[] {
    const byEvent = (this.memorySteps[before] ??= []);
    let known = byEvent[event];
    if (!known) {
      const events = [...trail(), this.traceSteps.values[event]].map((e, index) => ({ ...e, index }) as Event);
      const { memory, nevers } = memoryOf(this.nevers, events);
      byEvent[event] = known = { memory: this.memories.id(memory, () => memory), nevers };
    }
    step.memory = known.memory;
    return known.nevers;
  }

  /**
   * A choice's fairness (fairness.ts), kept: a fire's depends only on its step and what it takes
   * (interned), a guard's on the choice, which plans share.
   */
  private fairOf(here: Here, choice: Choice): { id: FairId; kind: Fairness } | undefined {
    if (choice.kind === "act") return undefined;
    if (choice.kind === "guard") {
      const shared = choice as Choice & { fair?: { id: FairId; kind: Fairness } | null };
      if (shared.fair === undefined) shared.fair = fairness(this.spec, here.world(), choice) ?? null;
      return shared.fair ?? undefined;
    }
    const id = here.vector[here.layout.messages + choice.pending];
    const byPending = (this.fairFires[(choice as Fire).index ?? this.stepIndex(choice.step)] ??= []);
    let fair = byPending[id];
    if (fair === undefined) byPending[id] = fair = fairness(this.spec, here.world(), choice) ?? null;
    return fair ?? undefined;
  }

  /** The fair steps possible in a world, among its options, by identity (fairness.ts fairStepsIn). */
  private fairStepsIn(here: Here, options: Choice[]): Map<FairId, Fairness> {
    const out = new Map<FairId, Fairness>();
    for (const choice of options) {
      const fair = this.fairOf(here, choice);
      if (fair) out.set(fair.id, fair.kind);
    }
    return out;
  }

  /** A trace step as an event at a place in its path. Only the order of places is promised (TraceEvent.index). */
  private eventAt(event: number, index: number): Event {
    return { ...this.traceSteps.values[event], index } as Event;
  }

  /** The choices from each node's root to it, found again in real worlds. */
  async paths(gids: number[]): Promise<Map<number, Choice[]>> {
    return new Map(gids.map((gid) => [gid, this.pathTo(gid)]));
  }

  private pathTo(gid: number): Choice[] {
    const names: ChoiceName[] = [];
    for (let at = gid; this.parent[at] >= 0; at = this.parent[at]) names.push(this.names.values[this.named[at]]);
    names.reverse();
    let world = this.roots[this.root[gid]].world;
    const out: Choice[] = [];
    for (const name of names) {
      const choice = this.choiceIn(world, name);
      out.push(choice);
      world = apply(this.spec, world, choice, QUIET).world;
    }
    return out;
  }

  /** A named choice in a world: the same step, on the same message or timer. */
  private choiceIn(world: World, name: ChoiceName): Choice {
    switch (name.kind) {
      case "act":
        return { kind: "act", instance: name.instance!, key: name.key!, inputs: name.inputs! };
      case "guard":
        return { kind: "guard", instance: name.instance!, key: name.key! };
      case "fire": {
        const p = world.pending.find((x) => this.pendingId(x) === name.pending);
        if (!p) throw new Error("a path from the integer core does not replay: what it names is not pending");
        return { kind: "fire", pending: p.id, step: name.key! };
      }
    }
  }

  /** A choice's name: worked out once for shared choices, by its pending entry for the others. */
  private nameIn(choice: Choice, vector: Int32Array, L: Layout): number {
    if (choice.kind !== "fire") return this.factsOf(L, choice).named;
    // A fire's name is its step and the message or timer it takes, by intern ids.
    const byPending = (this.fireNames[(choice as Fire).index ?? this.stepIndex(choice.step)] ??= []);
    return (byPending[vector[L.messages + choice.pending]] ??= this.nameOf(choice, vector, L));
  }

  private nameOf(choice: Choice, vector: Int32Array, L: Layout): number {
    const name: ChoiceName =
      choice.kind === "act"
        ? { kind: "act", instance: choice.instance, key: choice.key, inputs: choice.inputs }
        : choice.kind === "guard"
          ? { kind: "guard", instance: choice.instance, key: choice.key }
          : { kind: "fire", key: choice.step, pending: vector[L.messages + choice.pending] };
    return this.names.id(`${name.kind}|${name.instance ?? ""}|${name.key ?? ""}|${name.inputs ? JSON.stringify(name.inputs) : ""}|${name.pending ?? ""}`, () => name);
  }

  private node(parent: number, root: number, option: number, named: number, faults: number, event: number): number {
    const gid = this.parent.push(parent) - 1;
    this.option.push(option);
    this.shadow.push(false);
    this.eventOf.push(event);
    this.root.push(root);
    this.named.push(named);
    this.faults.push(faults);
    const depth = parent < 0 ? 0 : this.depth[parent] + 1;
    this.depth.push(depth);
    if (depth > this.depthReached) this.depthReached = depth;
    return gid;
  }

  /** A node that stands only for a counterexample's last step (an error, a step property broken on the way to a known state): not a state. */
  private shadowNode(parent: number, option: number, named: number, faults: number, event: number): number {
    const gid = this.node(parent, this.root[parent], option, named, faults, event);
    this.shadow[gid] = true;
    return gid;
  }

  private breaks(id: string, gid: number): void {
    this.broken.add(id);
    this.failures.set(id, gid);
  }

  /** The `always` properties a new state breaks: which fail is worked out once per tuple. */
  private judge(tuple: number, vector: Int32Array, gid: number, L: Layout): void {
    let failing = this.alwaysFailing[tuple];
    if (!failing) {
      const world = this.instancesOf(vector, L);
      this.alwaysFailing[tuple] = failing = this.always.flatMap((p) => (p.holds(world) ? [] : [p.id]));
    }
    for (const id of failing) if (!this.broken.has(id)) this.breaks(id, gid);
  }

  /**
   * Whether nothing can happen in a new world: only possible with nothing pending, so its
   * instances are all there is to it. Fewest faults, then first found.
   */
  private judgeStuck(vector: Int32Array, gid: number, L: Layout): void {
    if (vector.length > L.messages + 1) return;
    const best = this.stuckAt;
    if (best !== undefined && this.faults[best] <= this.faults[gid]) return;
    if (stuck(this.spec, this.instancesOf(vector, L))) this.stuckAt = gid;
  }

  /**
   * A world with just the instances, and as many (empty) pending entries as there are: all a
   * property sees of a world (worldView: the instances, and whether anything is pending).
   */
  private instancesOf(vector: Int32Array, L: Layout): World {
    const n = L.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.instanceStates.values[vector[slot]];
    return { seq: 0, fresh: {}, rng: 0, instances, pending: new Array(vector.length - L.messages - 1), ...this.variablesOf(vector, L) } as World;
  }

  /** What the search's watcher sees of a state besides its world: what `never` properties remember. */
  private memoryText(vector: Int32Array, L: Layout): string {
    return this.memories.values[vector[L.memory]];
  }

  private factsOf(L: Layout, choice: Choice): { arg: number; named: number } {
    // Kept on the choice, which plans share: an action's or a guard's.
    const shared = choice as Choice & { facts?: { arg: number; named: number } };
    let facts = shared.facts;
    if (!facts) {
      if (choice.kind === "fire") throw new Error("a choice on a pending entry has no facts of its own");
      shared.facts = facts = { arg: this.argOf(choice), named: this.nameOf(choice, NONE, L) };
    }
    return facts;
  }

  /** What a choice does, to apply to the vector. */
  private step(here: Here, choice: Choice): Step {
    const { vector, layout: L } = here;
    let slot: number;
    let at = -1;
    if (choice.kind === "fire") {
      const id = vector[L.messages + choice.pending];
      slot = this.slotIn(L, id);
      if (this.pendings.values[id].kind === "deliver") at = L.messages + choice.pending;
    } else slot = L.slots.get(choice.instance)!;
    const effect = this.effectOf(here, slot, choice);
    return { layout: L, slot, at, effect: effect.drops ? this.withDrops(here, slot, at, effect) : effect, fault: effect.fault, memory: vector[L.memory] };
  }

  /** A reset's effect in this vector: the messages in flight to the instance that its `drops` picks, removed as well. */
  private withDrops(here: Here, slot: number, chosen: number, effect: Effect): Effect {
    const { vector, layout: L } = here;
    const { pick, answers } = effect.drops!;
    let dropped: number[] | undefined;
    for (let i = L.messages + 1, end = L.messages + 1 + vector[L.messages]; i < end; i++) {
      const id = vector[i];
      if (i === chosen || this.slotIn(L, id) !== slot) continue;
      // By message: 0 not asked yet, 1 kept, 2 dropped.
      let answer = answers[id];
      if (!answer) {
        // An answer that read the sender's state holds for this world only.
        let readsSender = false;
        const pending = { ...this.pendings.values[id], id: 0 } as Extract<Pending, { kind: "deliver" }>;
        answer = pick(deliveryIn(this.spec, here.world(), pending, () => (readsSender = true))) === true ? 2 : 1;
        if (!readsSender) answers[id] = answer;
      }
      if (answer === 2) (dropped ??= []).push(id);
    }
    return dropped ? { ...effect, removesMessages: Int32Array.from([...effect.removesMessages, ...dropped]) } : effect;
  }

  /** A local step's effect: from the cache, or by running it through the engine once. */
  private effectOf(here: Here, slot: number, choice: Choice): Effect {
    const { vector, layout: L } = here;
    const timers = here.timersOf[slot];
    // The key: the instance's state, its own timers (start, cancel and reset read them), and
    // the step with its argument: a message or timer by its intern id, which says who sent
    // what; anything else by an interned name.
    const index = choice.kind === "fire" ? ((choice as Fire).index ?? this.stepIndex(choice.step)) : -1;
    const arg = choice.kind === "fire" ? (vector[L.messages + choice.pending] * STEPS + index) * 2 : this.factsOf(L, choice).arg * 2 + 1;
    const variables = vector[L.variables];
    const apart = (L.apart[slot] ??= new Map());
    // Steps that have run apart from their instance are looked for there first.
    if (index >= 0 && this.runsApart[index]) {
      const known = cachedIn(apart, arg, variables);
      if (known) return known;
    }
    const byTimers = (L.cache[vector[slot]] ??= []);
    const byArg = (byTimers[timers] ??= new Map());
    const cached = cachedIn(byArg, arg, variables) ?? cachedIn(apart, arg, variables);
    if (cached) return cached;
    const observe = observation();
    const world = here.world();
    const step = run(this.spec, world, choice, observe);
    // A reset's drops are worked out for each vector (withDrops), so they are not in the effect.
    const chosen = observe.drops && choice.kind === "fire" ? choice.pending : -1;
    const effect = this.effectFrom(world, (k) => vector[L.messages + k], slot, step.world, step.event, observe.drops ? chosen : undefined);
    if (observe.others || observe.counters) return { ...effect, fresh: this.freshId(step.world.fresh), rng: step.world.rng | 0, variables: this.variablesId(step.world) };
    if (observe.drops) effect.drops = { pick: observe.drops, answers: [] };
    if (observe.variables) effect.variables = this.variablesId(step.world);
    // A step that did not touch its own instance runs the same way in any state of it: up to its
    // first use of its own instance, it ran without it, and it never got there.
    if (!observe.own) effect.apart = true;
    if (!observe.own && index >= 0) this.runsApart[index] = true;
    cacheIn(observe.own ? byArg : apart, arg, observe.variables ? variables : undefined, effect);
    return effect;
  }

  /** A step's name as a small number, for the step cache's key. */
  private stepIndex(step: string): number {
    const index = this.stepNames.id(step, () => step);
    if (index >= STEPS) throw new Error(`the integer core met more than ${STEPS} distinct step names`);
    return index;
  }

  /**
   * The steps that can take pending entry `id` (interned) when its receiver is in state `state`
   * (and the world's variables, when its `when`s read them; the plan is for both): a timer's own;
   * for a message, the steps on it whose `when` holds there (stepsTaking).
   */
  private takers(plan: LocalPlan, id: number, state: number, variables: number): number[] {
    let steps = plan.takers[id];
    if (!steps) {
      const instance = this.instanceStates.values[state];
      const pending = { ...this.pendings.values[id], id: 0 } as Pending;
      const world = { ...NO_WORLD, instances: [instance], ...(variables ? { variables: this.worldVariables.values[variables] } : {}) } as World;
      plan.takers[id] = steps = stepsTaking(this.spec, world, pending).map((step) => this.stepIndex(step));
    }
    return steps;
  }

  private argOf(choice: Exclude<Choice, { kind: "fire" }>): number {
    const name = choice.kind === "act" ? `a|${choice.key}|${JSON.stringify(choice.inputs)}` : `g|${choice.key}`;
    return this.stepArgs.id(name, () => name);
  }

  /** The integers a step changed, from the worlds before and after it. */
  private effectFrom(before: World, pendingAt: (k: number) => number, slot: number, after: World, e: Event, resetKeeping?: number): Effect {
    const stepKey = `${e.actor}.${e.key}`;
    const reached = this.stepKeys.id(stepKey, () => stepKey);
    const sent = e.sent.map((s) => ({ message: s.message }));
    const traced: TraceStep = { actor: e.actor, key: e.key, sent: sent as Event["sent"], ...(e.error ? { error: e.error } : {}) };
    const event = this.traceSteps.id(`${stepKey}|${e.error ?? ""}|${sent.map((s) => s.message).join(",")}`, () => traced);
    const fault = e.tags?.includes(FAULT) === true;
    const error = e.error;
    if (error) return { error, reached, event, fault, state: 0, removesMessages: NONE, removesTimers: NONE, addsMessages: NONE, addsTimers: NONE };
    const kept = new Set(after.pending.map((p) => p.id));
    // After a reset that drops (resetKeeping, the message taken or -1), only that message and timers count as removed.
    const self = after.instances[slot].id;
    const removed = before.pending.filter((p) => !kept.has(p.id) && (resetKeeping === undefined || p.kind === "timer" || p.to !== self || p.id === resetKeeping));
    const added = after.pending.filter((p) => p.id > before.seq).sort((a, b) => a.id - b.id);
    return {
      reached,
      event,
      fault,
      state: this.stateId(after.instances[slot]),
      removesMessages: Int32Array.from(removed.filter((p) => p.kind === "deliver").map((p) => pendingAt(p.id))),
      removesTimers: Int32Array.from(removed.filter((p) => p.kind === "timer").map((p) => pendingAt(p.id))),
      addsMessages: Int32Array.from(added.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p))),
      addsTimers: Int32Array.from(added.filter((p) => p.kind === "timer").map((p) => this.pendingId(p))),
    };
  }

  /**
   * A vector with a step applied: the instance's new state, the budget, and what is pending.
   * The message chosen goes from where it is; any other removed message, its first copy
   * (copies are alike, but where they are decides the order of choices). New ones go last.
   */
  private applied(vector: Int32Array, { layout: L, slot, at: chosen, effect, memory }: Step): Int32Array {
    const M = L.messages;
    const count = vector[M];
    const { removesMessages: rm, removesTimers: rt, addsMessages: am, addsTimers: at } = effect;
    const messages = count - rm.length + am.length;
    const out = new Int32Array(M + 1 + messages + (vector.length - M - 1 - count) - rt.length + at.length);
    for (let i = 0; i < M; i++) out[i] = vector[i];
    if (!effect.apart) out[slot] = effect.state;
    out[L.memory] = memory;
    if (effect.fresh !== undefined) out[L.fresh] = effect.fresh;
    if (effect.rng !== undefined) out[L.rng] = effect.rng;
    if (effect.variables !== undefined) out[L.variables] = effect.variables;
    out[M] = messages;
    let left: number[] | undefined;
    if (rm.length > (chosen >= 0 ? 1 : 0)) {
      left = Array.from(rm);
      if (chosen >= 0) left.splice(left.indexOf(vector[chosen]), 1);
    }
    let w = M + 1;
    for (let i = M + 1, end = M + 1 + count; i < end; i++) {
      if (i === chosen) continue;
      const id = vector[i];
      const r = left ? left.indexOf(id) : -1;
      if (r >= 0) {
        left!.splice(r, 1);
        continue;
      }
      out[w++] = id;
    }
    out.set(am, w);
    w += am.length;
    for (let i = M + 1 + count; i < vector.length; i++) if (!rt.includes(vector[i])) out[w++] = vector[i];
    out.set(at, w);
    return out;
  }

  /** A root world's vector, with nothing spent. */
  private vectorOf(world: World, memory: number, L: Layout): Int32Array {
    const inOrder = [...world.pending].sort((a, b) => a.id - b.id);
    const messages = inOrder.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p));
    const timers = world.pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id).map((p) => this.pendingId(p));
    const v = new Int32Array(L.messages + 1 + messages.length + timers.length);
    for (const instance of world.instances) v[L.slots.get(instance.id)!] = this.stateId(instance);
    v[L.fresh] = this.freshId(world.fresh);
    v[L.rng] = world.rng | 0;
    v[L.variables] = this.variablesId(world);
    v[L.memory] = memory;
    v[L.messages] = messages.length;
    v.set(messages, L.messages + 1);
    v.set(timers, L.messages + 1 + messages.length);
    return v;
  }

  /** The world a vector stands for, for the engine: each pending entry's id is its place in the vector's pending part, from 1. */
  private materialize(vector: Int32Array, L: Layout): World {
    const n = L.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.instanceStates.values[vector[slot]];
    const pending: Pending[] = [];
    for (let i = L.messages + 1; i < vector.length; i++) pending.push({ ...this.pendings.values[vector[i]], id: pending.length + 1 } as Pending);
    return { seq: pending.length, fresh: this.freshes.values[vector[L.fresh]], rng: vector[L.rng] >>> 0, instances, pending, ...this.variablesOf(vector, L) };
  }

  private here(vector: Int32Array, L: Layout): Here {
    let world: World | undefined;
    return { vector, layout: L, timersOf: this.timersOf(vector, L), world: () => (world ??= this.materialize(vector, L)) };
  }

  /** The slot of the instance an interned message or timer is for. */
  private slotIn(L: Layout, id: number): number {
    return (L.slotOf[id] ??= L.slots.get(this.pendings.values[id].to)!);
  }

  /** Each instance's own timers, oldest first, as a list id (from 1; 0 for none). */
  private timersOf(vector: Int32Array, L: Layout): Int32Array {
    const n = L.instances.length;
    const end = L.messages + 1 + vector[L.messages];
    if (end === vector.length) return L.noTimers;
    const out = new Int32Array(n);
    const own = new Array<string>(n).fill("");
    for (let i = end; i < vector.length; i++) own[this.slotIn(L, vector[i])] += `${vector[i]},`;
    for (let slot = 0; slot < n; slot++) if (own[slot]) out[slot] = 1 + this.timerLists.id(own[slot], () => own[slot]);
    return out;
  }

  /**
   * Every choice from a vector, as `branches` gives them from its world, in the same order:
   * actions (with their inputs), then guards, instance by instance; then everything pending,
   * messages before timers, oldest first (pendingInOrder, which the vector keeps), each to
   * every step that can take it.
   */
  private choicesOf(here: Here, tuple: number): Choice[] {
    const { vector, layout: L } = here;
    const out: Choice[] = [];
    const n = L.instances.length;
    const variables = vector[L.variables];
    const plans = new Array<LocalPlan>(n);
    for (let slot = 0; slot < n; slot++) {
      plans[slot] = this.planOf(L, vector[slot], variables);
      for (const act of plans[slot].acts) for (const c of act.choices ?? this.exampleChoices(here, tuple, slot, act.key, act.inputs!)) out.push(c);
    }
    for (let slot = 0; slot < n; slot++) for (const c of plans[slot].guards) out.push(c);
    const pending = vector.length - L.messages - 1;
    for (let k = 1; k <= pending; k++) {
      const id = vector[L.messages + k];
      const slot = this.slotIn(L, id);
      for (const step of this.takers(plans[slot], id, vector[slot], variables)) out.push(this.fireAt(k, step));
    }
    return out;
  }

  /**
   * What an instance in one state can do: its actions whose `when` holds (with their inputs, if
   * those do not come from `examples`) and its guards that hold. Both read only its state and
   * its own variables, unless a `when` of its actor reads the world's (`variables`, interned).
   */
  private planOf(L: Layout, state: number, variables: number): LocalPlan {
    const withVariables = this.readsWorldAt(state);
    const key = state + variables * 2 ** 26;
    let plan = withVariables ? L.plansWithVariables.get(key) : L.plans[state];
    if (plan) return plan;
    const instance = this.instanceStates.values[state];
    const world = { ...NO_WORLD, ...(variables ? { variables: this.worldVariables.values[variables] } : {}) } as World;
    const actor = actorNamed(this.spec, instance.actor);
    const acts: LocalPlan["acts"] = [];
    for (const info of Object.values(actor.actions)) {
      if (!whenHolds(this.spec, world, instance, info)) continue;
      const inputs = info.inputs as ActionInputs;
      if (Object.values(inputs).some((input) => input.examples)) acts.push({ key: info.key, inputs });
      else acts.push({ key: info.key, choices: inputCombinations(this.spec, NO_WORLD, inputs).map((combo): Choice => ({ kind: "act", instance: instance.id, key: info.key, inputs: combo })) });
    }
    const guards = Object.values(actor.transitions)
      .filter((t) => !t.message && t.when && whenHolds(this.spec, world, instance, t))
      .map((t): Choice => ({ kind: "guard", instance: instance.id, key: t.key }));
    plan = { acts, guards, takers: [] };
    if (withVariables) L.plansWithVariables.set(key, plan);
    else L.plans[state] = plan;
    return plan;
  }

  private readsWorldAt(state: number): boolean {
    return (this.readsWorldIn[state] ??= this.whenReadsWorld(this.instanceStates.values[state].actor));
  }

  /** Choices on pending entry `k`, shared: they name it by its place, and the step that takes it (`stepIndex`). */
  private fireAt(k: number, index: number): Fire {
    const byStep = (this.fires[k] ??= []);
    return (byStep[index] ??= { kind: "fire", pending: k, step: this.stepNames.values[index], index });
  }

  /** Whether a `when` of this actor's steps reads a variable of the world's, not only its instance's. */
  private whenReadsWorld(actor: string): boolean {
    let reads = this.readsWorld.get(actor);
    if (reads === undefined) {
      const info = actorNamed(this.spec, actor);
      const one = new Set(this.spec.variables.filter((v) => !v.each).map((v) => v.name));
      reads = [...Object.values(info.actions), ...Object.values(info.transitions)].some((s) => (s.when || s.bound) && s.uses.some((u) => one.has(u)));
      this.readsWorld.set(actor, reads);
    }
    return reads;
  }

  /** An action's choices when its inputs come from `examples`, which read the world: kept by its tuple. */
  private exampleChoices(here: Here, tuple: number, slot: number, key: string, inputs: ActionInputs): Choice[] {
    const id = here.layout.instances[slot].id;
    const cacheKey = `${tuple}|${id}|${key}`;
    let choices = this.examples.get(cacheKey);
    if (!choices) this.examples.set(cacheKey, (choices = inputCombinations(this.spec, this.instancesOf(here.vector, here.layout), inputs).map((combo): Choice => ({ kind: "act", instance: id, key, inputs: combo }))));
    return choices;
  }

  /** An instance in one state, shared by every world it is in that way. */
  private stateId(instance: Instance): number {
    // The key is the instance's key line (keys.ts), which symmetric fingerprints rename.
    return this.instanceStates.id(instanceLine(instance), () => instance);
  }

  /** As keys.ts pendingText writes it: symmetric fingerprints rename it. */
  private pendingId(p: Pending): number {
    const key = p.kind === "deliver" ? (p.answers ? `r|${p.to}|${p.from}|${p.message}|${sortedJson([p.payload, p.answers.message, p.answers.payload])}` : `d|${p.to}|${p.from}|${p.message}|${sortedJson(p.payload)}`) : `t|${p.to}|${p.timer}`;
    const id = this.pendings.id(key, () => {
      const { id: _, ...template } = p;
      return template;
    });
    return id;
  }

  /** The world's variables, interned: 0 for none set. */
  private variablesId(world: World): number {
    return world.variables ? this.worldVariables.id(sortedJson(world.variables), () => world.variables!) : 0;
  }

  private variablesOf(vector: Int32Array, L: Layout): { variables?: Record<string, unknown> } {
    return vector[L.variables] ? { variables: this.worldVariables.values[vector[L.variables]] } : {};
  }

  private freshId(fresh: Record<string, number>): number {
    // As world keys write it (keys.ts): in the order the counters were made.
    return this.freshes.id(JSON.stringify(fresh), () => fresh);
  }
}

const NONE = new Int32Array(0);
/** A world with nothing in it, for input combinations that do not read the world. */
const NO_WORLD = { seq: 0, fresh: {}, rng: 0, instances: [], pending: [] } as World;

/** A choice on a message or timer, with its step as a small number (stepIndex), for the step cache. */
type Fire = Extract<Choice, { kind: "fire" }> & { index: number };
/** Distinct step names the step cache tells apart in a key. */
const STEPS = 4096;
/** A step property's answer, as kept: not known yet, holds, breaks. */
const UNKNOWN = 0;
const HOLDS = 1;
const BREAKS = 2;

/** An edge, always of one shape (`fair` undefined when the step is not fair). */
function edgeOf(to: number, option: number, fault: boolean, fair: FairId | undefined): Edge {
  return { to, option, fault, fair };
}
const NO_IDS: string[] = [];

/**
 * A step's cached effect for an argument: up to its first use of the world's variables, a step
 * runs the same way, so one that uses them always does, and is cached by their value as well.
 */
function cachedIn(byArg: Map<number, Cached>, arg: number, variables: number): Effect | undefined {
  const entry = byArg.get(arg);
  return entry instanceof Map ? entry.get(variables) : entry;
}

function cacheIn(byArg: Map<number, Cached>, arg: number, variables: number | undefined, effect: Effect): void {
  if (variables === undefined) return void byArg.set(arg, effect);
  let byVariables = byArg.get(arg);
  if (!(byVariables instanceof Map)) byArg.set(arg, (byVariables = new Map()));
  byVariables.set(variables, effect);
}

function run(spec: Spec, world: World, choice: Choice, observe: Observation) {
  const how = { explain: false, observe };
  switch (choice.kind) {
    case "act":
      return act(spec, world, choice.instance, choice.key, choice.inputs, how);
    case "fire":
      return fire(spec, world, choice.pending, choice.step, how);
    case "guard":
      return guard(spec, world, choice.instance, choice.key, how);
  }
}


function holdsSafely(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    // As the engine judges `always` (violatedAlways): a predicate that cannot be evaluated holds.
    return true;
  }
}

// Fingerprints, Zobrist-style: a world's is the sum (two 32-bit lanes, wrapping) of a hash
// per part, so a step updates its parent's for the parts it changes. Parts: each header
// position with its value (states, budget, fresh, rng); each message in the bag; the timers,
// as one hash of their order.

function fmix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

function lane1(tag: number, a: number, b: number): number {
  return fmix(Math.imul(a + 0x9e3779b9, 0x27d4eb2f) ^ Math.imul(b + tag * 0x165667b1, 0x61c88647) ^ tag);
}

function lane2(tag: number, a: number, b: number): number {
  return fmix(Math.imul(b ^ 0x7f4a7c15, 0x85ebca77) + Math.imul(a + tag, 0xc2b2ae3d) + 0x2545f491 * tag);
}

/** The timers' order, as one number. */
function timersHash(v: ArrayLike<number>, from: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < v.length; i++) h = fmix(h ^ v[i]) + 0x9e3779b9;
  return h >>> 0;
}

/** A vector's fingerprint from scratch. */
function printOf(v: Int32Array, L: Layout): [number, number] {
  const M = L.messages;
  let h1 = lane1(5, L.index, 0);
  let h2 = lane2(5, L.index, 0);
  for (let i = 0; i < M; i++) (h1 += lane1(1, i, v[i])), (h2 += lane2(1, i, v[i]));
  const end = M + 1 + v[M];
  for (let i = M + 1; i < end; i++) (h1 += lane1(3, v[i], 0)), (h2 += lane2(3, v[i], 0));
  const t = timersHash(v, end);
  return [(h1 + lane1(4, t, 0)) >>> 0, (h2 + lane2(4, t, 0)) >>> 0];
}

/**
 * A child's fingerprint: the parent's, with the parts the step changes taken out and put back.
 * Written to CHILD (hi, lo) rather than returned, as it runs for every step.
 */
function childPrint(parent: Entry, step: Step): Uint32Array {
  const { layout: L, slot, effect: e } = step;
  const v = parent.vector;
  let h1 = parent.h1;
  let h2 = parent.h2;
  // Each header position the step may change, with its new value.
  if (!e.apart && v[slot] !== e.state) (h1 += lane1(1, slot, e.state) - lane1(1, slot, v[slot])), (h2 += lane2(1, slot, e.state) - lane2(1, slot, v[slot]));
  if (e.fresh !== undefined && v[L.fresh] !== e.fresh) (h1 += lane1(1, L.fresh, e.fresh) - lane1(1, L.fresh, v[L.fresh])), (h2 += lane2(1, L.fresh, e.fresh) - lane2(1, L.fresh, v[L.fresh]));
  if (e.rng !== undefined && v[L.rng] !== e.rng) (h1 += lane1(1, L.rng, e.rng) - lane1(1, L.rng, v[L.rng])), (h2 += lane2(1, L.rng, e.rng) - lane2(1, L.rng, v[L.rng]));
  if (e.variables !== undefined && v[L.variables] !== e.variables) (h1 += lane1(1, L.variables, e.variables) - lane1(1, L.variables, v[L.variables])), (h2 += lane2(1, L.variables, e.variables) - lane2(1, L.variables, v[L.variables]));
  if (v[L.memory] !== step.memory) (h1 += lane1(1, L.memory, step.memory) - lane1(1, L.memory, v[L.memory])), (h2 += lane2(1, L.memory, step.memory) - lane2(1, L.memory, v[L.memory]));
  const rm = e.removesMessages;
  for (let k = 0; k < rm.length; k++) (h1 -= lane1(3, rm[k], 0)), (h2 -= lane2(3, rm[k], 0));
  const am = e.addsMessages;
  for (let k = 0; k < am.length; k++) (h1 += lane1(3, am[k], 0)), (h2 += lane2(3, am[k], 0));
  if (e.removesTimers.length || e.addsTimers.length) {
    const end = L.messages + 1 + v[L.messages];
    const after: number[] = [];
    for (let i = end; i < v.length; i++) if (!e.removesTimers.includes(v[i])) after.push(v[i]);
    for (let k = 0; k < e.addsTimers.length; k++) after.push(e.addsTimers[k]);
    const t = timersHash(after, 0);
    const before = timersHash(v, end);
    h1 += lane1(4, t, 0) - lane1(4, before, 0);
    h2 += lane2(4, t, 0) - lane2(4, before, 0);
  }
  CHILD[0] = h1 >>> 0;
  CHILD[1] = h2 >>> 0;
  return CHILD;
}
const CHILD = new Uint32Array(2);

