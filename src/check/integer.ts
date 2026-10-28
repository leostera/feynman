// The integer core: the breadth-first search on worlds as integers (research note
// personal/feynman/checker-performance; prototype in proto/integer).
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
// which). It explores exactly what the classic search does without its reductions, for
// safety: states, `always`, `never` and step properties, errors, stuck worlds and coverage. `check` uses it
// whenever it can (see `fitsIntegerCore`), and the oracles hold it to the classic search.
import { act, actorNamed, fire, guard, lose, observation, restart, worldView, type Event, type Observation, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { sortedJson } from "../spec/json.ts";
import type { Bounds, Watch } from "./explore.ts";
import { startBreaks, stepBreaks, stuck } from "./judge.ts";
import { memoryOf, rootMemory } from "./owner.ts";
import { PrintMap } from "./prints.ts";
import type { Root } from "./search.ts";
import { apply, branches, QUIET, type Choice } from "./steps.ts";

type Instance = World["instances"][number];
type Pending = World["pending"][number];
type PendingTemplate = Omit<Pending, "id">;

/**
 * Whether the integer core can do a job: `always` properties only, from roots with the same
 * instances, with no symmetry to fold (that changes the states). It does without the classic
 * search's reductions (and is faster than the classic search with them), so it ignores `reduce`.
 */
export function fitsIntegerCore(spec: Spec, roots: Root[]): boolean {
  if (spec.properties.some((p) => p.kind !== "always" && p.kind !== "never" && p.kind !== "everyStep")) return false;
  if (roots.some((r) => r.symmetry.classes.length)) return false;
  // One layout for every root: the same instances, in the same order.
  const ids = roots[0].world.instances.map((i) => i.id).join("\u0000");
  return roots.every((r) => r.world.instances.map((i) => i.id).join("\u0000") === ids);
}

/** Values named by integers: each distinct one (by its key) once. */
class Interner<T> {
  private ids = new Map<string, number>();
  readonly values: T[] = [];

  id(key: string, value: () => T): number {
    let id = this.ids.get(key);
    if (id === undefined) this.ids.set(key, (id = this.values.push(value()) - 1));
    return id;
  }
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
  instances: Instance[];
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
  /** The step's `actor.key`, for coverage, as an index into `IntegerSearch.steps`. */
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
  vector: Int32Array;
  h1: number;
  h2: number;
}

/** A step, as what it changes in the vector. */
interface Step {
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
  depthReached = 0;
  readonly ownerCount = 1;
  readonly root: number[] = [];
  private parent: number[] = [];
  private choice: number[] = [];
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
  private everySteps: string[];
  private reachedSteps: boolean[] = [];
  private cache = new Map<number, Effect>();
  private layout: Layout;
  private slots = new Map<string, number>();
  private always: { id: string; holds: (w: World) => boolean }[];

  constructor(
    private readonly spec: Spec,
    private readonly b: Bounds,
    readonly roots: Root[],
    private readonly watch: Watch,
    private readonly started: number,
  ) {
    const first = roots[0].world;
    first.instances.forEach((instance, slot) => this.slots.set(instance.id, slot));
    const acts = new Map<string, number>();
    for (const instance of first.instances) for (const key of Object.keys(actorNamed(spec, instance.actor).actions)) acts.set(`${instance.id}.${key}`, acts.size);
    const n = first.instances.length;
    this.layout = { instances: first.instances, acts, faults: n, fresh: n + 1 + acts.size, rng: n + 2 + acts.size, memory: n + 3 + acts.size, messages: n + 4 + acts.size };
    this.nevers = spec.properties.filter((p) => p.kind === "never");
    this.everySteps = spec.properties.flatMap((p) => (p.kind === "everyStep" ? [p.id] : []));
    this.always = spec.properties.flatMap((p) => (p.kind === "always" ? [{ id: p.id, holds: (w: World) => holdsSafely(() => p.always(worldView(spec, w))) }] : []));
  }

  /** Steps that ran, as `actor.key`. */
  get stats(): { reached: Set<string>; orders: number; inputs: number } {
    return { reached: new Set(this.stepKeys.values.filter((_, i) => this.reachedSteps[i])), orders: 0, inputs: 0 };
  }

  run(): void {
    const L = this.layout;
    const seen = new PrintMap();
    let frontier: Entry[] = [];
    const startMemory = this.memories.id(rootMemory(this.spec), () => rootMemory(this.spec));
    for (const [r, { world }] of this.roots.entries()) {
      const vector = this.vectorOf(world, startMemory);
      const [h1, h2] = printOf(vector, L.messages);
      if (seen.get(h1, h2) !== undefined) continue;
      const gid = this.node(-1, r, -1, 0, -1);
      seen.set(h1, h2, gid);
      this.states++;
      this.watch.state?.(world, this.budgetOf(vector));
      for (const id of startBreaks(this.spec, world)) if (!this.broken.has(id)) this.breaks(id, gid);
      this.judgeStuck(vector, gid);
      if (this.b.depth > 0) frontier.push({ gid, vector, h1, h2 });
    }
    const deadline = this.started + this.b.timeLimit;
    for (let depth = 0; frontier.length && depth < this.b.depth; depth++) {
      const next: Entry[] = [];
      for (let f = 0; f < frontier.length; f++) {
        if ((f & 255) === 0 && Date.now() > deadline) {
          this.stoppedBy = "timeLimit";
          return;
        }
        const parent = frontier[f];
        const { vector } = parent;
        const { world, ids, timersOf } = this.materialize(vector);
        const trail = this.nevers.length ? this.trailOf(parent.gid) : undefined;
        for (const choice of branches(this.spec, world, vector[L.faults] < this.b.faults)) {
          const step = this.step(vector, world, ids, timersOf, choice);
          if (!step) continue;
          const { effect } = step;
          this.reachedSteps[effect.reached] = true;
          const faults = this.faults[parent.gid] + (step.fault ? 1 : 0);
          if (effect.error) {
            // A step that fails is a spec error, and goes nowhere; the first time an error is
            // met, a node of its own (a shadow, not a state) ends its counterexample.
            if (!this.errors.has(effect.error)) this.errors.set(effect.error, this.node(parent.gid, this.root[parent.gid], this.nameOf(choice, ids), faults, effect.event));
            continue;
          }
          const nevers = trail ? this.remember(trail, effect.event, step) : NO_IDS;
          const [h1, h2] = childPrint(parent, step, L);
          const existing = seen.get(h1, h2);
          // A step property is judged on every step, so one broken on the way to a known state
          // gets a node of its own too (see Search.land).
          let child: Int32Array | undefined;
          let breaks = NO_IDS;
          if (this.everySteps.some((id) => !this.broken.has(id))) {
            child = this.applied(vector, step);
            breaks = stepBreaks(this.spec, world, this.materialize(child).world, this.eventAt(effect.event, depth), this.broken);
          }
          if (existing !== undefined && !breaks.length) continue;
          if (existing === undefined && this.states >= this.b.maxStates) {
            this.stoppedBy = "maxStates";
            return;
          }
          const gid = this.node(parent.gid, this.root[parent.gid], this.nameOf(choice, ids), faults, effect.event);
          if (existing === undefined) {
            child ??= this.applied(vector, step);
            seen.set(h1, h2, gid);
            this.states++;
            if (this.watch.state) this.watch.state(this.materialize(child).world, this.budgetOf(child));
            if (this.always.length) this.judge(child, gid);
            for (const id of nevers) if (!this.broken.has(id)) this.breaks(id, gid);
            this.judgeStuck(child, gid);
            if (depth + 1 < this.b.depth) next.push({ gid, vector: child, h1, h2 });
          }
          for (const id of breaks) if (!this.broken.has(id)) this.breaks(id, gid);
        }
      }
      frontier = next;
    }
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
    for (let at = gid; this.parent[at] >= 0; at = this.parent[at]) names.push(this.names.values[this.choice[at]]);
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

  private nameOf(choice: Choice, ids: number[]): number {
    const name: ChoiceName =
      choice.kind === "act"
        ? { kind: "act", instance: choice.instance, key: choice.key, inputs: choice.inputs }
        : choice.kind === "guard"
          ? { kind: "guard", instance: choice.instance, key: choice.key }
          : choice.kind === "restart"
            ? { kind: "restart", instance: choice.instance }
            : { kind: choice.kind, pending: ids[choice.pending] };
    return this.names.id(`${name.kind}|${name.instance ?? ""}|${name.key ?? ""}|${name.inputs ? JSON.stringify(name.inputs) : ""}|${name.pending ?? ""}`, () => name);
  }

  private node(parent: number, root: number, choice: number, faults: number, event: number): number {
    const gid = this.parent.push(parent) - 1;
    this.eventOf.push(event);
    this.root.push(root);
    this.choice.push(choice);
    this.faults.push(faults);
    const depth = parent < 0 ? 0 : this.depth[parent] + 1;
    this.depth.push(depth);
    if (depth > this.depthReached) this.depthReached = depth;
    return gid;
  }

  private breaks(id: string, gid: number): void {
    this.broken.add(id);
    this.failures.set(id, gid);
  }

  /** The `always` properties a new world breaks. They see its instances, and whether anything is pending (`quiet`). */
  private judge(vector: Int32Array, gid: number): void {
    const world = this.instancesOf(vector);
    for (const p of this.always) if (!this.broken.has(p.id) && !p.holds(world)) this.breaks(p.id, gid);
  }

  /** Whether nothing can happen in a new world: only possible with nothing pending. Fewest faults, then first found. */
  private judgeStuck(vector: Int32Array, gid: number): void {
    if (vector[this.layout.messages] !== 0 || vector.length > this.layout.messages + 1) return;
    const best = this.stuckAt;
    if (best !== undefined && this.faults[best] <= this.faults[gid]) return;
    if (stuck(this.spec, this.materialize(vector).world)) this.stuckAt = gid;
  }

  /** A world with just the instances, and as many pending entries as there are, for properties. */
  private instancesOf(vector: Int32Array): World {
    const n = this.layout.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.instanceStates.values[vector[slot]];
    return { seq: 0, fresh: {}, rng: 0, instances, pending: new Array(vector.length - this.layout.messages - 1) } as World;
  }

  private budgetOf(vector: Int32Array): { acts: Record<string, number>; faults: number; memory: string } {
    const acts: Record<string, number> = {};
    for (const [id, at] of this.layout.acts) if (vector[this.layout.faults + 1 + at]) acts[id] = vector[this.layout.faults + 1 + at];
    return { acts, faults: vector[this.layout.faults], memory: this.memories.values[vector[this.layout.memory]] };
  }

  /** What a choice does, to apply to the vector; none if it would repeat an action past the bound. */
  private step(vector: Int32Array, world: World, ids: number[], timersOf: Int32Array, choice: Choice): Step | undefined {
    const L = this.layout;
    let actsAt = -1;
    if (choice.kind === "act") {
      actsAt = L.faults + 1 + L.acts.get(`${choice.instance}.${choice.key}`)!;
      if (vector[actsAt] >= this.b.repeats) return undefined;
    }
    let slot: number;
    let at = -1;
    if (choice.kind === "fire" || choice.kind === "lose") {
      // Pending ids in a materialized world are places in the vector's pending part.
      const chosen = world.pending[choice.pending - 1];
      slot = this.slots.get(chosen.to)!;
      if (chosen.kind === "deliver") at = L.messages + choice.pending;
    } else slot = this.slots.get(choice.instance)!;
    return { slot, at, effect: this.effectOf(vector, world, ids, timersOf[slot], slot, choice), actsAt, fault: choice.kind === "lose" || choice.kind === "restart", memory: vector[L.memory] };
  }

  /** A local step's effect: from the cache, or by running it through the engine once. */
  private effectOf(vector: Int32Array, world: World, ids: number[], timers: number, slot: number, choice: Choice): Effect {
    // The key: the instance's state, its own timers (start, cancel and restart read them), and
    // the step with its argument: a message or timer by its intern id, which says who sent
    // what; anything else by an interned name.
    const arg = choice.kind === "fire" ? ids[choice.pending] * 4 : choice.kind === "lose" ? ids[choice.pending] * 4 + 2 : this.argOf(choice) * 4 + 1;
    if (arg >= ARGS || timers >= TIMER_LISTS || vector[slot] >= STATES) throw new Error("the integer core's step cache key is too small for this spec");
    const key = (vector[slot] * TIMER_LISTS + timers) * ARGS + arg;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const observe = observation();
    const step = run(this.spec, world, choice, observe);
    const effect = this.effectFrom(world, ids, slot, step.world, step.event);
    if (observe.readsOthers || observe.shared) return { ...effect, fresh: this.freshId(step.world.fresh), rng: step.world.rng | 0 };
    this.cache.set(key, effect);
    return effect;
  }

  private argOf(choice: Choice): number {
    const name = choice.kind === "act" ? `a|${choice.key}|${JSON.stringify(choice.inputs)}` : choice.kind === "guard" ? `g|${choice.key}` : "r";
    return this.stepArgs.id(name, () => name);
  }

  /** The integers a step changed, from the worlds before and after it. */
  private effectFrom(before: World, ids: number[], slot: number, after: World, e: Event): Effect {
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
      removesMessages: Int32Array.from(removed.filter((p) => p.kind === "deliver").map((p) => ids[p.id])),
      removesTimers: Int32Array.from(removed.filter((p) => p.kind === "timer").map((p) => ids[p.id])),
      addsMessages: Int32Array.from(added.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p))),
      addsTimers: Int32Array.from(added.filter((p) => p.kind === "timer").map((p) => this.pendingId(p))),
    };
  }

  /**
   * A vector with a step applied: the instance's new state, the budget, and what is pending.
   * The message chosen goes from where it is; any other removed message, its first copy
   * (copies are alike, but where they are decides the order of choices). New ones go last.
   */
  private applied(vector: Int32Array, { slot, at: chosen, effect, actsAt, fault, memory }: Step): Int32Array {
    const L = this.layout;
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
  private vectorOf(world: World, memory: number): Int32Array {
    const L = this.layout;
    const inOrder = [...world.pending].sort((a, b) => a.id - b.id);
    const messages = inOrder.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p));
    const timers = world.pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id).map((p) => this.pendingId(p));
    const v = new Int32Array(L.messages + 1 + messages.length + timers.length);
    world.instances.forEach((instance, slot) => (v[slot] = this.stateId(instance)));
    v[L.fresh] = this.freshId(world.fresh);
    v[L.rng] = world.rng | 0;
    v[L.memory] = memory;
    v[L.messages] = messages.length;
    v.set(messages, L.messages + 1);
    v.set(timers, L.messages + 1 + messages.length);
    return v;
  }

  /**
   * The world a vector stands for, for the engine. Each pending entry's id is its place in the
   * vector's pending part, from 1: `ids[id]` is its intern id. `timersOf[slot]` names the list
   * of that instance's timers, for the step cache's key.
   */
  private materialize(vector: Int32Array): { world: World; ids: number[]; timersOf: Int32Array } {
    const L = this.layout;
    const n = L.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.instanceStates.values[vector[slot]];
    const pending: Pending[] = [];
    const ids: number[] = [0];
    const timersOf = new Int32Array(n);
    let own: string[] | undefined;
    for (let i = L.messages + 1; i < vector.length; i++) {
      const id = pending.length + 1;
      const template = this.pendings.values[vector[i]];
      pending.push({ ...template, id } as Pending);
      ids[id] = vector[i];
      if (template.kind === "timer") (own ??= new Array<string>(n).fill(""))[this.slots.get(template.to)!] += `${vector[i]},`;
    }
    if (own) for (let slot = 0; slot < n; slot++) if (own[slot]) timersOf[slot] = 1 + this.timerLists.id(own[slot], () => own![slot]);
    return { world: { seq: pending.length, fresh: this.freshes.values[vector[L.fresh]], rng: vector[L.rng] >>> 0, instances, pending }, ids, timersOf };
  }

  /** An instance in one state, shared by every world it is in that way. */
  private stateId(instance: Instance): number {
    return this.instanceStates.id(`${instance.id}|${sortedJson(instance.state)}`, () => instance);
  }

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
const NO_IDS: string[] = [];
/** The step cache key packs (state, own timers, step and argument) into one number below 2^53. */
const ARGS = 1 << 20;
const TIMER_LISTS = 1 << 10;
const STATES = 1 << 23;

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
export function printOf(v: Int32Array, M: number): [number, number] {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < M; i++) (h1 += lane1(1, i, v[i])), (h2 += lane2(1, i, v[i]));
  const end = M + 1 + v[M];
  for (let i = M + 1; i < end; i++) (h1 += lane1(3, v[i], 0)), (h2 += lane2(3, v[i], 0));
  const t = timersHash(v, end);
  return [(h1 + lane1(4, t, 0)) >>> 0, (h2 + lane2(4, t, 0)) >>> 0];
}

/** A child's fingerprint: the parent's, with the parts the step changes taken out and put back. */
function childPrint(parent: Entry, step: Step, L: Layout): [number, number] {
  const { slot, effect: e, actsAt, fault } = step;
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
