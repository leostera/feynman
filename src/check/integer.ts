// The integer core: the checker's breadth-first search, on worlds as integers (research note
// personal/feynman/checker-performance; RFD0008).
//
// The classic search (search.ts, owner.ts) copies, freezes, writes out and hashes whole worlds
// of JS objects on every step, though nearly every handler call repeats a local step it has
// made before. Here:
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
// which). It explores exactly what the classic search does without its reductions: states,
// every kind of property (liveness on the graph it keeps), errors, stuck worlds, coverage and
// symmetry. test/check/integer.test.ts and the fuzzer hold it to the classic search, the
// reference explorer, and the TLA+ and P oracles to TLC and P.
import { act, actorNamed, fire, guard, holdsIn, isLiveness, lose, observation, restart, traceView, worldView, type Event, type Fairness, type Observation, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { sortedJson } from "../spec/json.ts";
import type { Bounds, Watch } from "./explore.ts";
import { startBreaks, stuck } from "./judge.ts";
import { renamedLine, type Symmetry } from "./keys.ts";
import { predicatesOf, type Edge, type FairId, type Graph, type LassoStep, type Predicate } from "./liveness.ts";
import { fairness, fairStepsIn, memoryOf, rootMemory, type Resolved } from "./owner.ts";
import { PrintMap } from "./prints.ts";
import type { Root } from "./search.ts";
import { apply, branches, inputCombinations, QUIET, type Choice } from "./steps.ts";

type Instance = World["instances"][number];
type Pending = World["pending"][number];
type PendingTemplate = Omit<Pending, "id">;

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
  states: Map<number, number>;
  pendings: Map<number, number>;
}

/**
 * Where things are in a world's vector:
 * [state id per instance | faults | actions taken per (instance, action) | fresh id | rng |
 *  memory | message count | message ids | timer ids], messages and timers each oldest first.
 * The memory is what `never` properties remember of the path (owner.ts memoryOf), interned.
 *
 * Messages are a bag to the fingerprint, but kept in the order they were sent, as the classic
 * search's worlds are: so the choices from a vector come in the same order (pendingInOrder),
 * and the first counterexample found is the same one.
 */
interface Layout {
  /** Which layout, in the fingerprint: worlds with other instances are other states. */
  index: number;
  instances: Instance[];
  /** Each instance's slot, by id. */
  slots: Map<string, number>;
  /** What each instance state can do, by state id. */
  plans: Map<number, LocalPlan>;
  /** A restart choice per instance that can restart (not a singleton), in slot order. */
  restarts: Choice[];
  /** `timersOf` for a vector without timers: shared, never written. */
  noTimers: Int32Array;
  /**
   * The step cache, by (state id, own timers list) and then by step and argument. One per
   * layout: a step sees which instances there are (`ctx.all`, `ctx.the`, sending to one)
   * without reading their states, so its effect holds only among the same instances.
   */
  cache: Map<number, Map<number, Effect>>;
  /** Index of each `instance.action` counter, after the faults. */
  acts: Map<string, number>;
  faults: number;
  fresh: number;
  rng: number;
  memory: number;
  messages: number;
}

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
  /** For steps that are not cached: the counters after them. */
  fresh?: number;
  rng?: number;
}

/** What `never` and step properties see of an event (traceView): its place goes in when a path is laid out. */
type TraceStep = Pick<Event, "actor" | "key" | "error" | "sent">;

/** A choice, as it can be found again in any world: messages and timers by what they are, not by their ids there. */
interface ChoiceName {
  kind: Choice["kind"];
  instance?: string;
  key?: string;
  inputs?: Record<string, unknown>;
  /** For `fire` and `lose`: the pending entry's intern id. */
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
}

type ActionInputs = Parameters<typeof inputCombinations>[2];

/** A frontier entry being expanded, and what its steps share. */
interface Expanding {
  parent: Entry;
  depth: number;
  here: Here;
  symmetry: Symmetry;
  /** For `never` properties: the trace steps on the way to the parent. */
  trail: TraceStep[] | undefined;
}

/** A step, as what it changes in the vector. */
interface Step {
  layout: Layout;
  slot: number;
  /** Where in the vector the message delivered or lost is; -1 for other steps. */
  at: number;
  effect: Effect;
  actsAt: number;
  fault: boolean;
  /** What `never` properties remember after it. */
  memory: number;
}

/** The search, with what `reportOf` reads of one (see search.ts). */
export class IntegerSearch {
  readonly failures = new Map<string, number>();
  readonly errors = new Map<string, number>();
  stuckAt: number | undefined;
  states = 0;
  stoppedBy: "maxStates" | "timeLimit" | undefined;
  /** A symmetry claim turned out false: the search stopped, to be run again without it. */
  refuted = false;
  depthReached = 0;
  readonly ownerCount = 1;
  readonly root: number[] = [];
  private parent: number[] = [];
  /** How each node was reached from its parent: a `ChoiceName` id, found again in any world. */
  private named: number[] = [];
  private faults: number[] = [];
  private depth: number[] = [];
  /** Each node's last event, as a `TraceStep` id: a path's events go up its parents, as classic trails do. */
  private eventOf: number[] = [];
  private readonly broken = new Set<string>();

  private instanceStates = new Interner<Instance>();
  private pendings = new Interner<PendingTemplate>();
  private freshes = new Interner<Record<string, number>>();
  private stepArgs = new Interner<string>();
  private timerLists = new Interner<string>();
  private names = new Interner<ChoiceName>();
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
   * For choices that do not name a pending entry (actions, guards, restarts), which are shared
   * objects (`planOf`, `Layout.restarts`): the action's counter in the vector, the step cache's
   * argument, and the choice's name, worked out once.
   */
  private facts = new WeakMap<Choice, { actsAt: number; arg: number; named: number }>();
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
  get stats(): { reached: Set<string>; orders: number; inputs: number } {
    return { reached: new Set(this.stepKeys.values.filter((_, i) => this.reachedSteps[i])), orders: 0, inputs: 0 };
  }

  /**
   * The layout for a root's instances. The classic key sorts instances, so a set of them is one
   * layout, in the order of the first root that has it (which the choices follow).
   */
  private layoutOf(world: World): Layout {
    const key = world.instances.map((i) => i.id).sort().join("\u0000");
    let layout = this.layouts.get(key);
    if (layout) return layout;
    const slots = new Map(world.instances.map((instance, slot) => [instance.id, slot]));
    const acts = new Map<string, number>();
    for (const instance of world.instances) for (const k of Object.keys(actorNamed(this.spec, instance.actor).actions)) acts.set(`${instance.id}.${k}`, acts.size);
    const n = world.instances.length;
    const restarts = world.instances.flatMap((i): Choice[] => (actorNamed(this.spec, i.actor).singleton ? [] : [{ kind: "restart", instance: i.id }]));
    layout = { index: this.layouts.size, instances: world.instances, slots, plans: new Map(), restarts, noTimers: new Int32Array(world.instances.length), cache: new Map(), acts, faults: n, fresh: n + 1 + acts.size, rng: n + 2 + acts.size, memory: n + 3 + acts.size, messages: n + 4 + acts.size };
    this.layouts.set(key, layout);
    return layout;
  }

  run(): void {
    // For liveness: the nodes at the depth bound, whose edges are added at the end if they can be.
    const open: Entry[] = [];
    let frontier = this.start(open);
    const deadline = this.started + this.b.timeLimit;
    for (let depth = 0; frontier.length && depth < this.b.depth; depth++) {
      const next: Entry[] = [];
      for (let f = 0; f < frontier.length; f++) {
        if ((f & 255) === 0 && Date.now() > deadline) {
          this.stoppedBy = "timeLimit";
          return;
        }
        if (!this.expand(frontier[f], depth, next, open)) return;
      }
      frontier = next;
    }
    // Liveness needs the edges out of the worlds at the depth bound too. Where every step from
    // one lands on a known state, nothing lies past it, and its edges are added: in a space the
    // bound does not cut, liveness is then judged in full, as TLC would.
    if (this.keepsEdges) for (const entry of open) this.close(entry);
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
      this.watch.state?.(world, this.budgetOf(vector, L));
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
    else if (this.keepsEdges) open.push(entry);
  }

  /** Every step from a frontier entry, in the classic order. False when the search must stop. */
  private expand(parent: Entry, depth: number, next: Entry[], open: Entry[]): boolean {
    const here = this.here(parent.vector, parent.layout);
    const from: Expanding = { parent, depth, here, symmetry: this.roots[this.root[parent.gid]].symmetry, trail: this.nevers.length ? this.trailOf(parent.gid) : undefined };
    const options = this.choicesOf(here, parent.tuple);
    if (this.keepsEdges) {
      // Expanded once it is begun, as in the classic search, even if the search stops partway.
      this.expanded[parent.gid] = true;
      this.edges[parent.gid] = [];
      this.enabled[parent.gid] = fairStepsIn(this.spec, here.world(), options);
    }
    for (let option = 0; option < options.length; option++) {
      const step = this.step(here, options[option]);
      if (!step) continue;
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
    // Its world is the one before, with the budget spent: as in the classic search, it may land
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
    const nevers = from.trail ? this.remember(from.trail, effect.event, step) : NO_IDS;
    let child: Int32Array | undefined;
    let folded: ReturnType<IntegerSearch["symmetricPrint"]> | undefined;
    if (symmetry.classes.length) {
      child = this.applied(parent.vector, step);
      folded = this.symmetricPrint(child, L, symmetry);
    }
    const [h1, h2] = folded ? folded.print : childPrint(parent, step);
    const existing = this.seen.get(h1, h2);
    const edgeTo = (to: number) => this.keepsEdges && this.edges[parent.gid].push(edgeOf(to, option, step.fault, fairness(this.spec, here.world(), choice)?.id));
    if (existing !== undefined) edgeTo(existing);
    // A step property is judged on every step, so one broken on the way to a known state counts too.
    let breaks = NO_IDS;
    let tuple: number | undefined;
    if (this.everySteps.some((p) => !this.broken.has(p.id))) {
      const after = (child ??= this.applied(parent.vector, step));
      tuple = this.tupleOf(after, L);
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
    const gid = this.node(parent.gid, this.root[parent.gid], option, this.nameIn(choice, parent.vector, L), this.faultsAfter(parent, step), effect.event);
    edgeTo(gid);
    child ??= this.applied(parent.vector, step);
    this.seen.set(h1, h2, gid);
    if (folded) this.keepForTwins(gid, child, L, folded.plain);
    this.states++;
    if (this.watch.state) this.watch.state(this.materialize(child, L), this.budgetOf(child, L));
    const state = child;
    tuple ??= this.tupleOf(state, L);
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
    const trail = this.nevers.length ? this.trailOf(entry.gid) : undefined;
    const options = this.choicesOf(here, entry.tuple);
    const out: Edge[] = [];
    for (let option = 0; option < options.length; option++) {
      const step = this.step(here, options[option]);
      if (!step || step.effect.error) continue;
      if (trail) this.remember(trail, step.effect.event, step);
      const [h1, h2] = symmetry.classes.length ? this.symmetricPrint(this.applied(vector, step), L, symmetry).print : childPrint(entry, step);
      const to = this.seen.get(h1, h2);
      if (to === undefined) return;
      out.push(edgeOf(to, option, step.fault, fairness(this.spec, here.world(), options[option])?.id));
    }
    this.edges[entry.gid] = out;
    this.enabled[entry.gid] = fairStepsIn(this.spec, here.world(), options);
    this.expanded[entry.gid] = true;
  }

  /** A world as properties see it: its layout, instance states, and whether anything is pending. */
  private tupleOf(vector: Int32Array, L: Layout): number {
    let key = `${L.index}|${vector.length > L.messages + 1 ? 1 : 0}`;
    for (let slot = 0; slot < L.instances.length; slot++) key += `,${vector[slot]}`;
    let id = this.tuples.get(key);
    if (id === undefined) this.tuples.set(key, (id = this.tuples.size));
    return id;
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
      const choice = branches(this.spec, world, this.faults[from] < this.b.faults)[option];
      out.set(`${from}:${option}`, worlds ? { choice, world } : { choice });
    }
    return out;
  }

  /**
   * Whether a world that landed on a known state up to symmetry behaves as that state's world
   * does: the same next worlds, up to symmetry. Tested on the first `symmetryChecks` renamed
   * twins met (not on the very same world), in the order met, as the classic search does.
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
   * The worlds one step away, faults aside and whatever the repeats bound says, each up to
   * symmetry and without its budget: renamed twins must agree on them (owner.ts successorsPrint).
   */
  private successorsKey(vector: Int32Array, L: Layout, symmetry: Symmetry): string {
    const here = this.here(vector, L);
    const out = new Set<string>();
    for (const choice of branches(this.spec, here.world(), false)) {
      const step = this.stepOf(here, choice);
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
   * as they are, as the classic key has them. Renamed twins have the same set of renamed
   * worlds, so the same least one. Also the world's own fingerprint (no renaming, no budget),
   * and its least without the budget, for twin checks.
   */
  private symmetricPrint(v: Int32Array, L: Layout, symmetry: Symmetry): { print: [number, number]; plain: [number, number]; world: [number, number] } {
    const M = L.messages;
    const end = M + 1 + v[M];
    let base1 = lane1(5, L.index, 0) + lane1(1, L.fresh, v[L.fresh]) + lane1(1, L.rng, v[L.rng]);
    let base2 = lane2(5, L.index, 0) + lane2(1, L.fresh, v[L.fresh]) + lane2(1, L.rng, v[L.rng]);
    let extra1 = lane1(1, L.memory, v[L.memory]);
    let extra2 = lane2(1, L.memory, v[L.memory]);
    for (let i = L.faults; i < L.fresh; i++) (extra1 += lane1(1, i, v[i])), (extra2 += lane2(1, i, v[i]));
    let best: [number, number] | undefined;
    let least: [number, number] | undefined;
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
      const world: [number, number] = [h1 >>> 0, h2 >>> 0];
      if (r.identity) plain = world;
      if (!least || lessThan(world, least)) least = world;
      const full: [number, number] = [(h1 + extra1) >>> 0, (h2 + extra2) >>> 0];
      if (!best || lessThan(full, best)) best = full;
    }
    return { print: best!, plain, world: least! };
  }

  private renamed(renaming: Map<string, string>): Renamed {
    let r = this.renamedBy.get(renaming);
    if (!r) this.renamedBy.set(renaming, (r = { renaming, identity: [...renaming].every(([from, to]) => from === to), states: new Map(), pendings: new Map() }));
    return r;
  }

  private renamedState(r: Renamed, state: number): number {
    let line = r.states.get(state);
    if (line === undefined) r.states.set(state, (line = this.lineId(renamedLine(this.instanceStates.keys[state], r.renaming))));
    return line;
  }

  private renamedPending(r: Renamed, pending: number): number {
    let line = r.pendings.get(pending);
    if (line === undefined) r.pendings.set(pending, (line = this.lineId(renamedLine(this.pendings.keys[pending], r.renaming))));
    return line;
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

  /** What `never` properties remember after a step on a trail: into the step, and which of them the path breaks. */
  private remember(trail: TraceStep[], event: number, step: Step): string[] {
    const events = [...trail, this.traceSteps.values[event]].map((e, index) => ({ ...e, index }) as Event);
    const { memory, nevers } = memoryOf(this.nevers, events);
    step.memory = this.memories.id(memory, () => memory);
    return nevers;
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
      case "restart":
        return { kind: "restart", instance: name.instance! };
      case "fire":
      case "lose": {
        const p = world.pending.find((x) => this.pendingId(x) === name.pending);
        if (!p) throw new Error("a path from the integer core does not replay: what it names is not pending");
        return { kind: name.kind, pending: p.id };
      }
    }
  }

  /** A choice's name: worked out once for shared choices, by its pending entry for the others. */
  private nameIn(choice: Choice, vector: Int32Array, L: Layout): number {
    return choice.kind === "fire" || choice.kind === "lose" ? this.nameOf(choice, vector, L) : this.factsOf(L, choice).named;
  }

  private nameOf(choice: Choice, vector: Int32Array, L: Layout): number {
    const name: ChoiceName =
      choice.kind === "act"
        ? { kind: "act", instance: choice.instance, key: choice.key, inputs: choice.inputs }
        : choice.kind === "guard"
          ? { kind: "guard", instance: choice.instance, key: choice.key }
          : choice.kind === "restart"
            ? { kind: "restart", instance: choice.instance }
            : { kind: choice.kind, pending: vector[L.messages + choice.pending] };
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
    return { seq: 0, fresh: {}, rng: 0, instances, pending: new Array(vector.length - L.messages - 1) } as World;
  }

  private budgetOf(vector: Int32Array, L: Layout): { acts: Record<string, number>; faults: number; memory: string } {
    const acts: Record<string, number> = {};
    for (const [id, at] of L.acts) if (vector[L.faults + 1 + at]) acts[id] = vector[L.faults + 1 + at];
    return { acts, faults: vector[L.faults], memory: this.memories.values[vector[L.memory]] };
  }

  /** What a choice does, to apply to the vector; none if it would repeat an action past the bound. */
  private step(here: Here, choice: Choice): Step | undefined {
    if (choice.kind === "act" && here.vector[this.factsOf(here.layout, choice).actsAt] >= this.b.repeats) return undefined;
    return this.stepOf(here, choice);
  }

  private factsOf(L: Layout, choice: Choice): { actsAt: number; arg: number; named: number } {
    let facts = this.facts.get(choice);
    if (!facts) {
      if (choice.kind === "fire" || choice.kind === "lose") throw new Error("a choice on a pending entry has no facts of its own");
      this.facts.set(choice, (facts = { actsAt: choice.kind === "act" ? actsIndex(L, choice) : -1, arg: this.argOf(choice), named: this.nameOf(choice, NONE, L) }));
    }
    return facts;
  }

  /** What a choice does, whatever the repeats bound says. */
  private stepOf(here: Here, choice: Choice): Step {
    const { vector, layout: L } = here;
    const actsAt = choice.kind === "act" ? this.factsOf(L, choice).actsAt : -1;
    let slot: number;
    let at = -1;
    if (choice.kind === "fire" || choice.kind === "lose") {
      const chosen = this.pendings.values[vector[L.messages + choice.pending]];
      slot = L.slots.get(chosen.to)!;
      if (chosen.kind === "deliver") at = L.messages + choice.pending;
    } else slot = L.slots.get(choice.instance)!;
    return { layout: L, slot, at, effect: this.effectOf(here, slot, choice), actsAt, fault: choice.kind === "lose" || choice.kind === "restart", memory: vector[L.memory] };
  }

  /** A local step's effect: from the cache, or by running it through the engine once. */
  private effectOf(here: Here, slot: number, choice: Choice): Effect {
    const { vector, layout: L } = here;
    const timers = here.timersOf[slot];
    // The key: the instance's state, its own timers (start, cancel and restart read them), and
    // the step with its argument: a message or timer by its intern id, which says who sent
    // what; anything else by an interned name.
    const arg = choice.kind === "fire" ? vector[L.messages + choice.pending] * 4 : choice.kind === "lose" ? vector[L.messages + choice.pending] * 4 + 2 : this.factsOf(L, choice).arg * 4 + 1;
    // Timer lists are named from 1 (0 for none), so the pair is one number while lists stay below 2^20.
    if (timers >= 1_048_576) throw new Error("the integer core met more than 2^20 distinct lists of one instance's timers");
    const local = vector[slot] * 1_048_576 + timers;
    let byArg = L.cache.get(local);
    if (!byArg) L.cache.set(local, (byArg = new Map()));
    const cached = byArg.get(arg);
    if (cached) return cached;
    const observe = observation();
    const world = here.world();
    const step = run(this.spec, world, choice, observe);
    const effect = this.effectFrom(world, (k) => vector[L.messages + k], slot, step.world, step.event);
    if (observe.readsOthers || observe.shared) return { ...effect, fresh: this.freshId(step.world.fresh), rng: step.world.rng | 0 };
    byArg.set(arg, effect);
    return effect;
  }

  private argOf(choice: Choice): number {
    const name = choice.kind === "act" ? `a|${choice.key}|${JSON.stringify(choice.inputs)}` : choice.kind === "guard" ? `g|${choice.key}` : "r";
    return this.stepArgs.id(name, () => name);
  }

  /** The integers a step changed, from the worlds before and after it. */
  private effectFrom(before: World, pendingAt: (k: number) => number, slot: number, after: World, e: Event): Effect {
    const stepKey = `${e.actor}.${e.key}`;
    const reached = this.stepKeys.id(stepKey, () => stepKey);
    const sent = e.sent.map((s) => ({ message: s.message }));
    const traced: TraceStep = { actor: e.actor, key: e.key, sent: sent as Event["sent"], ...(e.error ? { error: e.error } : {}) };
    const event = this.traceSteps.id(`${stepKey}|${e.error ?? ""}|${sent.map((s) => s.message).join(",")}`, () => traced);
    const error = e.error;
    if (error) return { error, reached, event, state: 0, removesMessages: NONE, removesTimers: NONE, addsMessages: NONE, addsTimers: NONE };
    const kept = new Set(after.pending.map((p) => p.id));
    const removed = before.pending.filter((p) => !kept.has(p.id));
    const added = after.pending.filter((p) => p.id > before.seq).sort((a, b) => a.id - b.id);
    return {
      reached,
      event,
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
  private applied(vector: Int32Array, { layout: L, slot, at: chosen, effect, actsAt, fault, memory }: Step): Int32Array {
    const M = L.messages;
    const count = vector[M];
    const { removesMessages: rm, removesTimers: rt, addsMessages: am, addsTimers: at } = effect;
    const messages = count - rm.length + am.length;
    const out = new Int32Array(M + 1 + messages + (vector.length - M - 1 - count) - rt.length + at.length);
    out.set(vector.subarray(0, M));
    out[slot] = effect.state;
    out[L.memory] = memory;
    if (actsAt >= 0) out[actsAt]++;
    if (fault) out[L.faults]++;
    if (effect.fresh !== undefined) out[L.fresh] = effect.fresh;
    if (effect.rng !== undefined) out[L.rng] = effect.rng;
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
    return { seq: pending.length, fresh: this.freshes.values[vector[L.fresh]], rng: vector[L.rng] >>> 0, instances, pending };
  }

  private here(vector: Int32Array, L: Layout): Here {
    let world: World | undefined;
    return { vector, layout: L, timersOf: this.timersOf(vector, L), world: () => (world ??= this.materialize(vector, L)) };
  }

  /** Each instance's own timers, oldest first, as a list id (from 1; 0 for none). */
  private timersOf(vector: Int32Array, L: Layout): Int32Array {
    const n = L.instances.length;
    const end = L.messages + 1 + vector[L.messages];
    if (end === vector.length) return L.noTimers;
    const out = new Int32Array(n);
    const own = new Array<string>(n).fill("");
    for (let i = end; i < vector.length; i++) own[L.slots.get(this.pendings.values[vector[i]].to)!] += `${vector[i]},`;
    for (let slot = 0; slot < n; slot++) if (own[slot]) out[slot] = 1 + this.timerLists.id(own[slot], () => own[slot]);
    return out;
  }

  /**
   * Every choice from a vector, as `branches` gives them from its world, in the same order:
   * actions (with their inputs), then guards, instance by instance; then everything pending,
   * messages before timers, oldest first (pendingInOrder, which the vector keeps); then, while
   * faults are left, losing each message and restarting each instance that can restart.
   */
  private choicesOf(here: Here, tuple: number): Choice[] {
    const { vector, layout: L } = here;
    const out: Choice[] = [];
    const n = L.instances.length;
    for (let slot = 0; slot < n; slot++) {
      for (const act of this.planOf(L, vector[slot]).acts) for (const c of act.choices ?? this.exampleChoices(here, tuple, slot, act.key, act.inputs!)) out.push(c);
    }
    for (let slot = 0; slot < n; slot++) for (const c of this.planOf(L, vector[slot]).guards) out.push(c);
    const pending = vector.length - L.messages - 1;
    for (let k = 1; k <= pending; k++) out.push(fireAt(k));
    if (vector[L.faults] < this.b.faults) {
      for (let k = 1; k <= vector[L.messages]; k++) out.push(loseAt(k));
      for (const c of L.restarts) out.push(c);
    }
    return out;
  }

  /**
   * What an instance in one state can do: its actions whose `when` holds (with their inputs, if
   * those do not come from `examples`) and its guards that hold. Both read only its state.
   */
  private planOf(L: Layout, state: number): LocalPlan {
    let plan = L.plans.get(state);
    if (plan) return plan;
    const instance = this.instanceStates.values[state];
    const actor = actorNamed(this.spec, instance.actor);
    const acts: LocalPlan["acts"] = [];
    for (const info of Object.values(actor.actions)) {
      if (info.when && !enabledIn(info.when, instance.state)) continue;
      const inputs = info.inputs as ActionInputs;
      if (Object.values(inputs).some((input) => input.examples)) acts.push({ key: info.key, inputs });
      else acts.push({ key: info.key, choices: inputCombinations(this.spec, NO_WORLD, inputs).map((combo): Choice => ({ kind: "act", instance: instance.id, key: info.key, inputs: combo })) });
    }
    const guards = Object.values(actor.transitions)
      .filter((t) => !t.message && t.when && enabledIn(t.when, instance.state))
      .map((t): Choice => ({ kind: "guard", instance: instance.id, key: t.key }));
    L.plans.set(state, (plan = { acts, guards }));
    return plan;
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
    return this.instanceStates.id(`${instance.id}=${sortedJson(instance.state)}`, () => instance);
  }

  /** As keys.ts pendingText writes it: symmetric fingerprints rename it. */
  private pendingId(p: Pending): number {
    const key = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${sortedJson(p.payload)}` : `t|${p.to}|${p.timer}`;
    return this.pendings.id(key, () => {
      const { id: _, ...template } = p;
      return template;
    });
  }

  private freshId(fresh: Record<string, number>): number {
    // As the classic key writes it (keys.ts): in the order the counters were made.
    return this.freshes.id(JSON.stringify(fresh), () => fresh);
  }
}

const NONE = new Int32Array(0);
/** A world with nothing in it, for input combinations that do not read the world. */
const NO_WORLD = { seq: 0, fresh: {}, rng: 0, instances: [], pending: [] } as World;

/** Choices on pending entry `k`, shared: they name it by its place. */
const fires: Choice[] = [];
const loses: Choice[] = [];
function fireAt(k: number): Choice {
  return (fires[k] ??= { kind: "fire", pending: k });
}
function loseAt(k: number): Choice {
  return (loses[k] ??= { kind: "lose", pending: k });
}
/** A step property's answer, as kept: not known yet, holds, breaks. */
const UNKNOWN = 0;
const HOLDS = 1;
const BREAKS = 2;

function lessThan(a: [number, number], b: [number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

/** Where an action's count is in the vector. */
function actsIndex(L: Layout, choice: Extract<Choice, { kind: "act" }>): number {
  return L.faults + 1 + L.acts.get(`${choice.instance}.${choice.key}`)!;
}

function edgeOf(to: number, option: number, fault: boolean, fair: FairId | undefined): Edge {
  return { to, option, fault, ...(fair === undefined ? {} : { fair }) };
}
const NO_IDS: string[] = [];

function run(spec: Spec, world: World, choice: Choice, observe: Observation) {
  const how = { explain: false, observe };
  switch (choice.kind) {
    case "act":
      return act(spec, world, choice.instance, choice.key, choice.inputs, how);
    case "fire":
      return fire(spec, world, choice.pending, how);
    case "guard":
      return guard(spec, world, choice.instance, choice.key, how);
    case "restart":
      return restart(spec, world, choice.instance, how);
    case "lose":
      return lose(spec, world, choice.pending, how);
  }
}

/** Whether a step's `when` holds in a state: one that throws does not, as the engine has it. */
function enabledIn(when: (state: never) => boolean, state: unknown): boolean {
  try {
    return when(state as never);
  } catch {
    return false;
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

/** A child's fingerprint: the parent's, with the parts the step changes taken out and put back. */
function childPrint(parent: Entry, step: Step): [number, number] {
  const { layout: L, slot, effect: e, actsAt, fault } = step;
  const v = parent.vector;
  let h1 = parent.h1;
  let h2 = parent.h2;
  const swap = (i: number, to: number) => {
    if (v[i] === to) return;
    h1 += lane1(1, i, to) - lane1(1, i, v[i]);
    h2 += lane2(1, i, to) - lane2(1, i, v[i]);
  };
  swap(slot, e.state);
  if (actsAt >= 0) swap(actsAt, v[actsAt] + 1);
  if (fault) swap(L.faults, v[L.faults] + 1);
  if (e.fresh !== undefined) swap(L.fresh, e.fresh);
  if (e.rng !== undefined) swap(L.rng, e.rng);
  swap(L.memory, step.memory);
  for (const id of e.removesMessages) (h1 -= lane1(3, id, 0)), (h2 -= lane2(3, id, 0));
  for (const id of e.addsMessages) (h1 += lane1(3, id, 0)), (h2 += lane2(3, id, 0));
  if (e.removesTimers.length || e.addsTimers.length) {
    const end = L.messages + 1 + v[L.messages];
    const after: number[] = [];
    for (let i = end; i < v.length; i++) if (!e.removesTimers.includes(v[i])) after.push(v[i]);
    after.push(...e.addsTimers);
    const t = timersHash(after, 0);
    const before = timersHash(v, end);
    h1 += lane1(4, t, 0) - lane1(4, before, 0);
    h2 += lane2(4, t, 0) - lane2(4, before, 0);
  }
  return [h1 >>> 0, h2 >>> 0];
}
