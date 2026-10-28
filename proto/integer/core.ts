// A prototype of an integer core for the checker (research: personal/feynman/checker-performance).
//
// The checker today copies, freezes, writes out and hashes whole worlds of JS objects on every
// step, though 99.5% of the handler calls it makes repeat a local step it has made before. Here:
//
// - every instance state, message and timer is interned once and named by an integer, so a world
//   is a short Int32Array (see Layout);
// - a local step (an instance, in one state, taking one step, with one argument, with its own
//   timers as they are) is run through the engine once, and its effect is kept as integers: the
//   new state, the pending ids it removes and those it adds;
// - a world's fingerprint is a hash of its vector, and only fingerprints are kept of the worlds
//   seen; the frontier alone holds vectors.
//
// Steps that read other instances, or hand out fresh ids or random numbers, depend on more than
// the key says: they run through the engine every time. Safety only (states, `always`, errors),
// without the search's reductions or symmetry, to be compared exactly with `check`.
import { branches, type Choice } from "../../src/check/index.ts";
import { PrintMap } from "../../src/check/prints.ts";
import { act, actorNamed, fire, guard, lose, observation, restart, worldView, type Spec, type World } from "../../src/spec/index.ts";
import type { Observation } from "../../src/spec/engine.ts";
import { sortedJson } from "../../src/spec/json.ts";

type Instance = World["instances"][number];
type Pending = World["pending"][number];
type PendingTemplate = Omit<Pending, "id">;

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
 *  message count | message ids, sorted | timer ids, oldest first]
 */
interface Layout {
  instances: Instance[];
  /** Index of each `instance.action` counter, after the faults. */
  acts: Map<string, number>;
  faults: number;
  fresh: number;
  rng: number;
  messages: number;
}

/** What a local step does, as integers. */
interface Effect {
  error?: string;
  state: number;
  /** Message ids it removes, sorted; timer ids it removes. */
  removesMessages: Int32Array;
  removesTimers: Int32Array;
  /** Message ids it adds, sorted; timer ids it sets, in the order set. */
  addsMessages: Int32Array;
  addsTimers: Int32Array;
  /** For steps that are not cached: the counters after them. */
  fresh?: number;
  rng?: number;
}

/** A frontier entry: a world's vector, and its fingerprint. */
interface Entry {
  vector: Int32Array;
  h1: number;
  h2: number;
}

/** A step, as what it changes in the vector. */
interface Step {
  slot: number;
  effect: Effect;
  actsAt: number;
  fault: boolean;
}

export interface Result {
  states: number;
  depth: number;
  /** Each `always` property broken, and the depth of the shortest path that breaks it. */
  broken: Map<string, number>;
  errors: Map<string, number>;
  stats: { expanded: number; steps: number; hits: number; misses: number; uncached: number; distinctStates: number };
}

export interface Bounds {
  depth: number;
  faults: number;
  repeats: number;
}

export class IntegerSearch {
  private states = new Interner<{ slot: number; instance: Instance }>();
  private pendings = new Interner<PendingTemplate>();
  private freshes = new Interner<Record<string, number>>();
  private choices = new Interner<string>();
  private timerLists = new Interner<string>();
  private cache = new Map<number, Effect>();
  private layout: Layout;
  private slots = new Map<string, number>();
  private stats = { expanded: 0, steps: 0, hits: 0, misses: 0, uncached: 0, distinctStates: 0 };
  private always: { id: string; holds: (w: World) => boolean }[];

  constructor(
    private spec: Spec,
    private bounds: Bounds,
    private root: World,
  ) {
    const acts = new Map<string, number>();
    for (const instance of root.instances)
      for (const key of Object.keys(actorNamed(spec, instance.actor).actions)) acts.set(`${instance.id}.${key}`, acts.size);
    const n = root.instances.length;
    root.instances.forEach((instance, slot) => this.slots.set(instance.id, slot));
    this.layout = { instances: root.instances, acts, faults: n, fresh: n + 1 + acts.size, rng: n + 2 + acts.size, messages: n + 3 + acts.size };
    this.always = spec.properties.flatMap((p) => (p.kind === "always" ? [{ id: p.id, holds: (w: World) => safely(() => (p as { always: (v: unknown) => boolean }).always(worldView(spec, w))) }] : []));
  }

  run(): Result {
    const L = this.layout;
    const seen = new PrintMap();
    const broken = new Map<string, number>();
    const errors = new Map<string, number>();
    const rootVector = this.vectorOf(this.root, 0, new Map());
    const rootPrint = printOf(rootVector, L.messages);
    seen.set(rootPrint[0], rootPrint[1], 0);
    let states = 1;
    this.judge(rootVector, 0, broken);
    let frontier: Entry[] = [{ vector: rootVector, h1: rootPrint[0], h2: rootPrint[1] }];
    let depth = 0;
    while (frontier.length && depth < this.bounds.depth) {
      const next: Entry[] = [];
      for (const parent of frontier) {
        this.stats.expanded++;
        const { vector } = parent;
        const { world, ids, timersOf } = this.materialize(vector);
        const faultsLeft = vector[L.faults] < this.bounds.faults;
        for (const choice of branches(this.spec, world, faultsLeft)) {
          const step = this.successor(vector, world, ids, timersOf, choice, depth + 1, errors);
          if (!step) continue;
          // The child's fingerprint from the parent's, for what the step changed; its vector
          // only if it is new.
          const [h1, h2] = childPrint(parent, step.slot, step.effect, step.actsAt, step.fault, L);
          if (seen.get(h1, h2) !== undefined) continue;
          seen.set(h1, h2, states++);
          const child = this.applied(vector, step.slot, step.effect, step.actsAt, step.fault);
          if (CHECK_PRINTS) {
            const [a, b] = printOf(child, L.messages);
            if (a !== h1 || b !== h2) throw new Error(`an incremental fingerprint differs from the whole one at depth ${depth + 1}`);
          }
          if (this.always.length) this.judge(child, depth + 1, broken);
          next.push({ vector: child, h1, h2 });
        }
      }
      frontier = next;
      depth++;
    }
    this.stats.distinctStates = this.states.values.length;
    return { states, depth, broken, errors, stats: this.stats };
  }

  /** The `always` properties a world breaks. They see its instances, and whether anything is pending (`quiet`). */
  private judge(vector: Int32Array, depth: number, broken: Map<string, number>): void {
    const L = this.layout;
    const n = L.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.states.values[vector[slot]].instance;
    const world = { seq: 0, fresh: {}, rng: 0, instances, pending: new Array(vector.length - L.messages - 1) } as World;
    for (const p of this.always) if (!broken.has(p.id) && !p.holds(world)) broken.set(p.id, depth);
  }

  /** What a choice does, to apply to the vector; none if the bounds forbid it or the step fails. */
  private successor(vector: Int32Array, world: World, ids: number[], timersOf: Int32Array, choice: Choice, depth: number, errors: Map<string, number>): Step | undefined {
    const L = this.layout;
    this.stats.steps++;
    let actsAt = -1;
    if (choice.kind === "act") {
      actsAt = L.faults + 1 + L.acts.get(`${choice.instance}.${choice.key}`)!;
      if (vector[actsAt] >= this.bounds.repeats) return undefined;
    }
    let effect: Effect;
    let slot: number;
    if (choice.kind === "lose") {
      const p = world.pending[choice.pending - 1];
      slot = this.slots.get(p.to)!;
      effect = { state: vector[slot], removesMessages: Int32Array.of(ids[choice.pending]), removesTimers: NONE, addsMessages: NONE, addsTimers: NONE };
    } else {
      slot = this.slots.get(instanceOf(world, choice))!;
      effect = this.effectOf(vector, world, ids, timersOf[slot], slot, choice);
    }
    if (effect.error) {
      if (!errors.has(effect.error)) errors.set(effect.error, depth);
      return undefined;
    }
    return { slot, effect, actsAt, fault: choice.kind === "lose" || choice.kind === "restart" };
  }

  /** A local step's effect: from the cache, or by running it through the engine once. */
  private effectOf(vector: Int32Array, world: World, ids: number[], timers: number, slot: number, choice: Choice): Effect {
    // The key: the instance's state, the step and its argument, and its own timers (start,
    // cancel and restart read them). A message is named by its intern id, which says who sent
    // what; the rest by an interned name.
    const arg = choice.kind === "fire" ? ids[choice.pending] * 2 : this.choiceCode(choice) * 2 + 1;
    if (arg >= ARGS || timers >= TIMER_LISTS) throw new Error("the prototype's cache key is too small for this spec");
    const key = (vector[slot] * TIMER_LISTS + timers) * ARGS + arg;
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.hits++;
      return cached;
    }
    const observe = observation();
    const step = run(this.spec, world, choice, observe);
    const effect = this.effectFrom(world, ids, slot, step.world, step.event.error);
    if (observe.readsOthers || observe.shared) {
      this.stats.uncached++;
      return { ...effect, fresh: this.freshId(step.world.fresh), rng: step.world.rng };
    }
    this.stats.misses++;
    this.cache.set(key, effect);
    return effect;
  }

  /** An action or guard, or a restart, by an interned name. */
  private choiceCode(choice: Choice): number {
    const name = choice.kind === "act" ? `a|${choice.key}|${JSON.stringify(choice.inputs)}` : choice.kind === "guard" ? `g|${choice.key}` : "r";
    return this.choices.id(name, () => name);
  }

  /** The integers a step changed, from the worlds before and after it. */
  private effectFrom(before: World, ids: number[], slot: number, after: World, error: string | undefined): Effect {
    if (error) return { error, state: 0, removesMessages: NONE, removesTimers: NONE, addsMessages: NONE, addsTimers: NONE };
    const kept = new Set(after.pending.map((p) => p.id));
    const removed = before.pending.filter((p) => !kept.has(p.id));
    const added = after.pending.filter((p) => p.id > before.seq);
    return {
      state: this.stateId(slot, after.instances[slot]),
      removesMessages: Int32Array.from(removed.filter((p) => p.kind === "deliver").map((p) => ids[p.id])).sort(),
      removesTimers: Int32Array.from(removed.filter((p) => p.kind === "timer").map((p) => ids[p.id])),
      addsMessages: Int32Array.from(added.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p))).sort(),
      addsTimers: Int32Array.from(added.filter((p) => p.kind === "timer").map((p) => this.pendingId(p))),
    };
  }

  /**
   * A vector with an effect applied: the instance's new state, the budget, and what is
   * pending. Messages are a sorted bag: one pass drops each removed id once and merges the
   * added ones in. Timers keep their order, and new ones go last.
   */
  private applied(vector: Int32Array, slot: number, effect: Effect, actsAt: number, fault: boolean): Int32Array {
    const M = this.layout.messages;
    const count = vector[M];
    const { removesMessages: rm, removesTimers: rt, addsMessages: am, addsTimers: at } = effect;
    const timers = vector.length - M - 1 - count;
    const messages = count - rm.length + am.length;
    const out = new Int32Array(M + 1 + messages + timers - rt.length + at.length);
    out.set(vector.subarray(0, M));
    out[slot] = effect.state;
    if (actsAt >= 0) out[actsAt]++;
    if (fault) out[this.layout.faults]++;
    if (effect.fresh !== undefined) out[this.layout.fresh] = effect.fresh;
    if (effect.rng !== undefined) out[this.layout.rng] = effect.rng;
    out[M] = messages;
    let w = M + 1;
    let r = 0;
    let a = 0;
    for (let i = M + 1, end = M + 1 + count; i < end; i++) {
      const id = vector[i];
      if (r < rm.length && rm[r] === id) {
        r++;
        continue;
      }
      while (a < am.length && am[a] < id) out[w++] = am[a++];
      out[w++] = id;
    }
    while (a < am.length) out[w++] = am[a++];
    for (let i = M + 1 + count; i < vector.length; i++) {
      const id = vector[i];
      if (rt.length && rt.includes(id)) continue;
      out[w++] = id;
    }
    out.set(at, w);
    return out;
  }

  /** A world's vector; `ids` gets the intern id of each pending entry, by its id in the world. */
  private vectorOf(world: World, faults: number, ids: Map<number, number>): Int32Array {
    const L = this.layout;
    const messages = world.pending.filter((p) => p.kind === "deliver").map((p) => this.pendingId(p)).sort((a, b) => a - b);
    const timers = world.pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id).map((p) => this.pendingId(p));
    const v = new Int32Array(L.messages + 1 + messages.length + timers.length);
    world.instances.forEach((instance, slot) => (v[slot] = this.stateId(slot, instance)));
    v[L.faults] = faults;
    v[L.fresh] = this.freshId(world.fresh);
    v[L.rng] = world.rng | 0;
    v[L.messages] = messages.length;
    v.set(messages, L.messages + 1);
    v.set(timers, L.messages + 1 + messages.length);
    for (const p of world.pending) ids.set(p.id, this.pendingId(p));
    return v;
  }

  /**
   * The world a vector stands for, for the engine and the properties. Each pending entry's
   * id is its place in the vector's pending part, from 1: `ids[id]` is its intern id.
   * `timersOf[slot]` names the list of that instance's timers, for the cache key.
   */
  private materialize(vector: Int32Array): { world: World; ids: number[]; timersOf: Int32Array } {
    const L = this.layout;
    const n = L.instances.length;
    const instances = new Array<Instance>(n);
    for (let slot = 0; slot < n; slot++) instances[slot] = this.states.values[vector[slot]].instance;
    const pending: Pending[] = [];
    const ids: number[] = [0];
    const timersOf = new Int32Array(n);
    let own: string[] | undefined;
    for (let i = L.messages + 1; i < vector.length; i++) {
      const id = pending.length + 1;
      const template = this.pendings.values[vector[i]];
      pending.push({ ...template, id } as Pending);
      ids[id] = vector[i];
      if (template.kind === "timer") ((own ??= new Array(n).fill(""))[this.slots.get(template.to)!] += `${vector[i]},`);
    }
    if (own) for (let slot = 0; slot < n; slot++) if (own[slot]) timersOf[slot] = 1 + this.timerLists.id(own[slot], () => own![slot]);
    return { world: { seq: pending.length, fresh: this.freshes.values[vector[L.fresh]], rng: vector[L.rng] >>> 0, instances, pending }, ids, timersOf };
  }

  private stateId(slot: number, instance: Instance): number {
    return this.states.id(`${slot}|${sortedJson(instance.state)}`, () => ({ slot, instance }));
  }

  private pendingId(p: Pending): number {
    const { id: _, ...template } = p;
    const key = p.kind === "deliver" ? `d|${p.to}|${p.from}|${p.message}|${sortedJson(p.payload)}` : `t|${p.to}|${p.timer}`;
    return this.pendings.id(key, () => template);
  }

  private freshId(fresh: Record<string, number>): number {
    return this.freshes.id(JSON.stringify(fresh), () => fresh);
  }
}

const NONE = new Int32Array(0);
/** Test every incremental fingerprint against one computed from scratch (slow). */
const CHECK_PRINTS = process.env.CHECK_PRINTS === "1";
/** The cache key packs (state, own timers, step and argument) into one number below 2^53. */
const ARGS = 1 << 18;
const TIMER_LISTS = 1 << 10;

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

function instanceOf(world: World, choice: Choice): string {
  if (choice.kind === "fire" || choice.kind === "lose") return world.pending[choice.pending - 1].to;
  return choice.instance;
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

/** A part's hash in each lane. */
function lane1(tag: number, a: number, b: number): number {
  return fmix(Math.imul(a + 0x9e3779b9, 0x27d4eb2f) ^ Math.imul(b + tag * 0x165667b1, 0x61c88647) ^ tag);
}
function lane2(tag: number, a: number, b: number): number {
  return fmix(Math.imul(b ^ 0x7f4a7c15, 0x85ebca77) + Math.imul(a + tag, 0xc2b2ae3d) + 0x2545f491 * tag);
}

/** The timers' order, as one number. */
function timersHash(v: Int32Array, from: number): number {
  let h = 0x811c9dc5;
  for (let i = from; i < v.length; i++) h = fmix(h ^ v[i]) + 0x9e3779b9;
  return h >>> 0;
}

/** A vector's fingerprint from scratch. */
function printOf(v: Int32Array, M: number): [number, number] {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < M; i++) (h1 += lane1(1, i, v[i])), (h2 += lane2(1, i, v[i]));
  const end = M + 1 + v[M];
  for (let i = M + 1; i < end; i++) (h1 += lane1(3, v[i], 0)), (h2 += lane2(3, v[i], 0));
  const t = timersHash(v, end);
  return [((h1 + lane1(4, t, 0)) >>> 0), ((h2 + lane2(4, t, 0)) >>> 0)];
}

/** A child's fingerprint: the parent's, with the parts the step changes taken out and put back. */
function childPrint(parent: Entry, slot: number, e: Effect, actsAt: number, fault: boolean, L: Layout): [number, number] {
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
  for (const id of e.removesMessages) (h1 -= lane1(3, id, 0)), (h2 -= lane2(3, id, 0));
  for (const id of e.addsMessages) (h1 += lane1(3, id, 0)), (h2 += lane2(3, id, 0));
  if (e.removesTimers.length || e.addsTimers.length) {
    const end = L.messages + 1 + v[L.messages];
    const before = timersHash(v, end);
    const after: number[] = [];
    for (let i = end; i < v.length; i++) if (!e.removesTimers.includes(v[i])) after.push(v[i]);
    after.push(...e.addsTimers);
    const t = timersHash(Int32Array.from(after), 0);
    h1 += lane1(4, t, 0) - lane1(4, before, 0);
    h2 += lane2(4, t, 0) - lane2(4, before, 0);
  }
  return [h1 >>> 0, h2 >>> 0];
}

function safely(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return true;
  }
}
