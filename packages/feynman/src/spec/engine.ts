// The engine: pure steps from a world to the next world and the event that explains it.
// Deterministic by construction: time is simulated, ids and randomness come from the
// world, and every handler sees the world only through its state, input, and ctx.
//
// Worlds share structure: a step copies only the state of the instance taking it, and
// every other state is the same object as in the world before. States are frozen once a
// step is done, so sharing is safe, and a handler that tries to change another
// instance's state fails loudly instead of corrupting the past.
import type { Trace, TraceEvent, WorldView } from "./spec.ts";
import type { ActorInfo, Change, Event, EventKind, InstanceState, Pending, Sent, Spec, StepInfo, World } from "./spec.ts";
import { sortedJson, unstorable } from "./json.ts";
import { mismatch } from "./schema.ts";

export interface Step {
  world: World;
  event: Event;
}

/** A spec bug found while running a step: an undeclared send, a missing actor. */
export class SpecError extends Error {}

/**
 * How much a step works out besides the next world. A reader needs everything; the checker,
 * exploring, skips what it never reads and replays a counterexample in full afterwards.
 */
export interface StepOptions {
  /** The event's changes and sentence (true). */
  explain?: boolean;
  /** Which `always` invariants the world after it breaks (true). */
  invariants?: boolean;
  /** Filled in with what the step touched besides its own state, for the checker's reductions. */
  observe?: Observation;
}

/**
 * What a step touched besides its own instance. A step that reads nobody else and uses no
 * world-wide counter commutes with a step on another instance.
 */
export interface Observation {
  /** It looked at another instance (`the`, `all`, `from`). */
  readsOthers: boolean;
  /** It used a counter every instance shares (`fresh`, `random`). */
  shared: boolean;
  /** The action inputs it read; all of them when it enumerated them. */
  inputs: Set<string>;
}

export function observation(): Observation {
  return { readsOthers: false, shared: false, inputs: new Set() };
}

/** The inputs, recording which ones the action reads. */
function watchedInputs(inputs: Record<string, unknown>, observe: Observation): Record<string, unknown> {
  const all = () => Object.keys(inputs).forEach((key) => observe.inputs.add(key));
  return new Proxy(inputs, {
    get(target, key) {
      if (typeof key === "string") observe.inputs.add(key);
      return target[key as string];
    },
    has(target, key) {
      if (typeof key === "string") observe.inputs.add(key);
      return key in target;
    },
    ownKeys(target) {
      all();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      all();
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

const FULL: StepOptions = {};

// Worlds ------------------------------------------------------------------------------------------

/** A world with every singleton spawned. */
export function startWorld(spec: Spec, seed = 1): Step[] {
  let world: World = { seq: 0, fresh: {}, rng: seed >>> 0 || 1, instances: [], pending: [] };
  const steps: Step[] = [];
  for (const actor of spec.actors.filter((a) => a.singleton)) {
    const step = spawn(spec, world, actor.name, actor.name);
    steps.push(step);
    world = step.world;
  }
  return steps;
}

export function emptyWorld(seed = 1): World {
  return { seq: 0, fresh: {}, rng: seed >>> 0 || 1, instances: [], pending: [] };
}

export function actorNamed(spec: Spec, name: string): ActorInfo {
  const actor = spec.actors.find((a) => a.name === name);
  if (!actor) throw new SpecError(`There is no actor named "${name}"`);
  return actor;
}

export function instanceById(world: World, id: string): InstanceState {
  const instance = world.instances.find((i) => i.id === id);
  if (!instance) throw new SpecError(`There is no instance "${id}"`);
  return instance;
}

/**
 * What is pending, in the order the system takes it when nobody interferes: messages in the
 * order they were sent, then timers in the order they were set. Left alone, timeouts are
 * slower than the network (RFD0004). Any of them may still go next.
 */
export function pendingInOrder(world: World): Pending[] {
  const rank = (p: Pending) => (p.kind === "deliver" ? 0 : 1);
  return [...world.pending].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/** What the system does next when nobody interferes: the first of pendingInOrder. */
export function nextLeftAlone(world: World): Pending | undefined {
  return pendingInOrder(world)[0];
}

/** What can happen next: actions people can take, guarded transitions that hold, and what is pending. */
export function choices(spec: Spec, world: World) {
  const actions: { instance: string; key: string; inputs: string[] }[] = [];
  const guards: { instance: string; key: string }[] = [];
  for (const instance of world.instances) {
    const steps = stepsOf(spec, instance.actor);
    for (const action of steps.actions) {
      if (!action.when || holds(action.when, instance.state)) actions.push({ instance: instance.id, key: action.key, inputs: action.inputs });
    }
    for (const transition of steps.guards) {
      if (holds(transition.when, instance.state)) guards.push({ instance: instance.id, key: transition.key });
    }
  }
  return { actions, guards, pending: pendingInOrder(world) };
}

type Guarded = { key: string; when: (state: never) => boolean };
type Steps = { actions: { key: string; when?: (state: never) => boolean; inputs: string[] }[]; guards: Guarded[] };

/** Each actor's actions and guarded transitions as lists, worked out once per spec. */
const stepLists = new WeakMap<Spec, Map<string, Steps>>();

function stepsOf(spec: Spec, actorName: string): Steps {
  let lists = stepLists.get(spec);
  if (!lists) stepLists.set(spec, (lists = new Map()));
  let steps = lists.get(actorName);
  if (!steps) {
    const actor = actorNamed(spec, actorName);
    steps = {
      actions: Object.values(actor.actions).map((a) => ({ key: a.key, when: a.when as Steps["actions"][number]["when"], inputs: Object.keys(a.inputs) })),
      guards: Object.values(actor.transitions).filter((t) => !t.message && t.when).map((t) => ({ key: t.key, when: t.when as Guarded["when"] })),
    };
    lists.set(actorName, steps);
  }
  return steps;
}

function holds(when: (state: never) => boolean, state: unknown): boolean {
  try {
    return when(state as never);
  } catch {
    return false;
  }
}

// Steps ----------------------------------------------------------------------------------------------

export function spawn(spec: Spec, world: World, actorName: string, label: string): Step {
  const actor = actorNamed(spec, actorName);
  const id = uniqueId(world, actor.singleton ? slug(actor.name) : slug(`${actor.name}-${label}`));
  const state = actor.initialState({ id, label });
  const odd = unstorable(state, "initial state");
  if (odd) throw new SpecError(`${actor.name}: ${notPlain(odd)}`);
  const next = { ...world, instances: [...world.instances, { id, actor: actor.name, label, state: freeze(clone(state)) }] };
  return finish(spec, world, next, {
    kind: "spawn",
    instance: id,
    actor: actor.name,
    key: "spawn",
    description: `${label} appears.`,
    sources: [],
    changes: [{ instance: id, path: "", before: undefined, after: clone(state) }],
  });
}

/** A person takes an action on an instance. */
export function act(spec: Spec, world: World, instanceId: string, key: string, inputs: Record<string, unknown> = {}, how: StepOptions = FULL): Step {
  const instance = instanceById(world, instanceId);
  const actor = actorNamed(spec, instance.actor);
  const action = actor.actions[key];
  if (!action) throw new SpecError(`${actor.name} has no action "${key}"`);
  const seen = how.observe ? watchedInputs(inputs, how.observe) : inputs;
  return runStep(spec, world, { kind: "action", instance, actor, step: action, inputs, call: (state, ctx) => action.run(state, seen, ctx) }, how);
}

/**
 * The steps that can take a pending entry now: a timer's own step; for a message, each step on
 * it whose `when` holds, in the order declared (RFD0012).
 */
export function stepsTaking(spec: Spec, world: World, pending: Pending): string[] {
  if (pending.kind === "timer") return [pending.timer];
  const instance = world.instances.find((i) => i.id === pending.to);
  if (!instance) return [];
  const actor = actorNamed(spec, instance.actor);
  const steps = actor.stepsOn[pending.message] ?? [];
  return steps.length === 1 && !actor.transitions[steps[0]].when ? steps : steps.filter((s) => !actor.transitions[s].when || holds(actor.transitions[s].when!, instance.state));
}

/** The step a message goes to when the system is left alone: the fair one of the steps on it. */
export function leftAloneStep(actor: ActorInfo, message: string): string | undefined {
  const steps = actor.stepsOn[message] ?? [];
  return steps.find((s) => actor.transitions[s].fair !== false) ?? steps[0];
}

/** Deliver a pending message to one of the steps on it (the one left alone takes, unless named), or fire a pending timer. */
export function fire(spec: Spec, world: World, pendingId: number, step?: string, how: StepOptions = FULL): Step {
  const pending = world.pending.find((p) => p.id === pendingId);
  if (!pending) throw new SpecError(`Nothing pending has id ${pendingId}`);
  const consumed = { ...world, pending: world.pending.filter((p) => p.id !== pendingId) };
  const instance = instanceById(consumed, pending.to);
  const actor = actorNamed(spec, instance.actor);
  if (pending.kind === "timer") {
    const transition = actor.transitions[pending.timer];
    return runStep(spec, consumed, { kind: "timer", instance, actor, step: transition, call: (state, ctx) => transition.run(state, undefined, ctx) }, how);
  }
  const name = step ?? leftAloneStep(actor, pending.message);
  const transition = name === undefined ? undefined : actor.transitions[name];
  const delivery = { message: pending.message, payload: pending.payload, from: pending.from };
  if (transition && transition.message !== pending.message) throw new SpecError(`${actor.name}.${name} is not a step on ${messageName(spec, pending.message)}`);
  if (transition?.when && !holds(transition.when, instance.state)) throw new SpecError(`${actor.name}.${name} cannot take ${messageName(spec, pending.message)} now: its when does not hold`);
  if (!transition) {
    return finish(spec, world, consumed, {
      kind: "deliver",
      instance: instance.id,
      actor: actor.name,
      key: pending.message,
      description: `${instance.label} received ${messageName(spec, pending.message)}.`,
      sources: [],
      ...delivery,
      changes: [],
      error: `${actor.name} has no transition for ${pending.message}`,
    }, how);
  }
  const from = consumed.instances.find((i) => i.id === pending.from);
  // A call's failure carries the call's payload and whom it was to (the callee, its `from`).
  const failed = calledBy(pending.message) !== undefined;
  return runStep(spec, consumed, {
    kind: "deliver",
    instance,
    actor,
    step: transition,
    delivery,
    notes: pending.text ? [pending.text] : [],
    from,
    call: failed
      ? (state, ctx) => transition.run(state, { payload: pending.payload, to: (ctx as { from: unknown }).from }, ctx)
      : (state, ctx) => transition.run(state, pending.payload, ctx),
  }, how);
}

/** Run an internal transition whose `when` guard holds. */
export function guard(spec: Spec, world: World, instanceId: string, key: string, how: StepOptions = FULL): Step {
  const instance = instanceById(world, instanceId);
  const actor = actorNamed(spec, instance.actor);
  const transition = actor.transitions[key];
  if (!transition || transition.message || !transition.when) throw new SpecError(`${actor.name}.${key} is not a guarded transition`);
  return runStep(spec, world, { kind: "guard", instance, actor, step: transition, call: (state, ctx) => transition.run(state, undefined, ctx) }, how);
}

/** A fault: a pending delivery is lost. */
export function lose(spec: Spec, world: World, pendingId: number, how: StepOptions = FULL): Step {
  const pending = world.pending.find((p) => p.id === pendingId);
  if (!pending || pending.kind !== "deliver") throw new SpecError(`No pending delivery has id ${pendingId}`);
  if (!losable(pending)) throw new SpecError(`${messageName(spec, pending.message)} happens in ${pending.to}'s own process: it cannot be lost`);
  const next = { ...world, pending: world.pending.filter((p) => p.id !== pendingId) };
  const to = instanceById(world, pending.to);
  let description = `${messageName(spec, pending.message)} to ${to.label} is lost on the way.`;
  // Losing a call, or the reply to one, fails the call: its caller hears of it (RFD0009).
  const failure = failureFor(spec, pending);
  const sent: Sent[] = [];
  if (failure) {
    const id = ++next.seq;
    next.pending.push({ id, kind: "deliver", ...failure });
    sent.push({ id, to: failure.to, message: failure.message, payload: failure.payload });
    const caller = instanceById(world, failure.to).label;
    description = pending.answers
      ? `${messageName(spec, pending.message)} to ${to.label} is lost on the way: ${caller}'s ${messageName(spec, pending.answers.message)} fails.`
      : `${messageName(spec, pending.message)} to ${to.label} is lost on the way: ${caller}'s call fails.`;
  }
  return finish(spec, world, next, {
    kind: "lose",
    instance: pending.to,
    actor: to.actor,
    key: pending.message,
    description,
    sources: [],
    message: pending.message,
    payload: pending.payload,
    from: pending.from,
    changes: [],
    sent,
  }, how);
}

/** The failure losing this message delivers: for a call, to its sender; for a call's reply, to the one it answers. */
function failureFor(spec: Spec, pending: Extract<Pending, { kind: "deliver" }>): { to: string; from: string; message: string; payload: unknown } | undefined {
  if (pending.answers) return { to: pending.to, from: pending.from, message: failureOf(pending.answers.message), payload: pending.answers.payload };
  if (spec.messages[pending.message]?.call) return { to: pending.from, from: pending.to, message: failureOf(pending.message), payload: pending.payload };
  return undefined;
}

/** A fault: an instance restarts. State returns to its initial value, except durable fields; its timers are gone. */
export function restart(spec: Spec, world: World, instanceId: string, how: StepOptions = FULL): Step {
  const instance = instanceById(world, instanceId);
  const actor = actorNamed(spec, instance.actor);
  const fresh = clone(actor.initialState({ id: instance.id, label: instance.label })) as Record<string, unknown>;
  const old = instance.state as Record<string, unknown>;
  for (const field of actor.durable) fresh[field] = clone(old[field]);
  const next = {
    ...world,
    instances: world.instances.map((i) => (i.id === instanceId ? { ...i, state: freeze(fresh) } : i)),
    // Its timers are gone, and so are the failures on their way to it: the calls that would have thrown went with its memory.
    pending: world.pending.filter((p) => !(p.to === instanceId && (p.kind === "timer" || calledBy(p.message) !== undefined))),
  };
  return finish(spec, world, next, {
    kind: "restart",
    instance: instance.id,
    actor: actor.name,
    key: "restart",
    description: `${instance.label} restarts${actor.durable.length ? `, keeping ${actor.durable.join(", ")}` : ""}.`,
    sources: [],
    changes: how.explain === false ? [] : diff(instance.id, old, fresh),
  }, how);
}

// Running a step -----------------------------------------------------------------------------------

interface Running {
  kind: EventKind;
  instance: InstanceState;
  actor: ActorInfo;
  step: StepInfo;
  inputs?: Record<string, unknown>;
  delivery?: { message: string; payload: unknown; from: string };
  from?: InstanceState;
  notes?: string[];
  call: (state: unknown, ctx: unknown) => unknown;
}

/** Whether `value` is `within`, or held somewhere inside it. */
function contains(within: unknown, value: object): boolean {
  if (within === value) return true;
  if (typeof within !== "object" || within === null) return false;
  const parts = within instanceof Map ? [...within.keys(), ...within.values()] : within instanceof Set ? [...within] : Object.values(within);
  return parts.some((part) => contains(part, value));
}

function runStep(spec: Spec, before: World, run: Running, how: StepOptions): Step {
  // Only what a step can change is copied: the lists, the counters, and its own state.
  const next: World = { ...before, fresh: { ...before.fresh }, instances: [...before.instances], pending: [...before.pending] };
  const position = next.instances.findIndex((i) => i.id === run.instance.id);
  const self = { ...next.instances[position] };
  next.instances[position] = self;
  const state = clone(self.state);
  const effects = { sent: [] as Sent[], started: [] as { timer: string }[], cancelled: [] as string[], notes: [...(run.notes ?? [])] };
  const base = {
    kind: run.kind,
    instance: self.id,
    actor: run.actor.name,
    key: run.step.key,
    description: run.step.description,
    sources: run.step.sources,
    inputs: run.kind === "action" ? run.inputs : undefined,
    ...run.delivery,
  };
  try {
    const returned = run.call(state, makeCtx(spec, next, self, run.actor, run.step, effects, run.from, how.observe, run.delivery));
    if (returned instanceof Promise) throw new SpecError("its run is async: a step happens at once, so it cannot await; tell others with a message and handle their reply in another step");
    // `(s) => s.n++` and `(s) => (s.list = [...])` return what they assign, harmlessly; an object
    // the state does not hold looks like a new state, which would be lost.
    if (typeof returned === "object" && returned !== null && !contains(state, returned))
      throw new SpecError("its run returned an object, which is ignored: a step changes its state in place (state.n += 1), it does not return a new one");
  } catch (error) {
    const message = readOnly(error)
      ? `changes the state of another instance (${error instanceof Error ? error.message : String(error)}); a step may change only its own state, and tell others with a message`
      : error instanceof Error
        ? error.message
        : String(error);
    // A step that fails has no effects: its sends, timers, and changes are discarded.
    return finish(spec, before, before, { ...base, changes: [], error: `${run.actor.name}.${run.step.key}: ${message}` }, how);
  }
  const odd = unstorable(state, "state");
  if (odd) return finish(spec, before, before, { ...base, changes: [], error: `${run.actor.name}.${run.step.key}: ${notPlain(odd)}` }, how);
  const explain = how.explain !== false;
  const changes = explain ? diff(self.id, self.state, state) : [];
  self.state = freeze(state);
  const text = explain ? sentence(run.step, state, run.kind === "action" ? run.inputs : run.delivery?.payload) : undefined;
  return finish(spec, before, next, { ...base, changes, sent: effects.sent, started: effects.started, cancelled: effects.cancelled, notes: effects.notes, ...(text ? { text } : {}), ...(run.step.routine ? { routine: true } : {}) }, how);
}

/** The step's `say` for this event; a `say` that throws is left out rather than failing the step. */
function sentence(step: StepInfo, state: unknown, payload: unknown): string | undefined {
  if (!step.say) return undefined;
  try {
    const text = step.say(state, payload);
    return typeof text === "string" && text ? text : undefined;
  } catch {
    return undefined;
  }
}

/** The key of a message given to `send` or `reply`: a message from defineMessage, not a string. */
function keyOf(value: unknown): string {
  if (typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "message") return (value as { key: string }).key;
  throw new SpecError(`sends ${typeof value === "string" ? JSON.stringify(value) : String(value)}: send and reply take a message from defineMessage, like ctx.send(bank, Charge, { payment })`);
}

function makeCtx(
  spec: Spec,
  world: World,
  self: InstanceState,
  actor: ActorInfo,
  step: StepInfo,
  effects: { sent: Sent[]; started: { timer: string }[]; cancelled: string[]; notes: string[] },
  from?: InstanceState,
  observe?: Observation,
  delivery?: { message: string; payload: unknown },
) {
  // Handling a call: its reply is tagged with the call, so losing it fails the call (RFD0009).
  const answering = delivery && spec.messages[delivery.message]?.call ? { message: delivery.message, payload: delivery.payload } : undefined;
  let replied = false;
  const view = worldView(spec, world, observe ? (id) => id !== self.id && (observe.readsOthers = true) : undefined);
  const send = (to: { id: string }, value: unknown, payload: unknown, text?: string, answers?: { message: string; payload: unknown }) => {
    const message = keyOf(value);
    if (!step.sends.includes(message)) throw new SpecError(`sends ${message.slice("message:".length)}, which it does not declare in sends`);
    const info = spec.messages[message];
    if (!info) throw new SpecError(`${message} is not one of this spec's messages`);
    const wrong = mismatch(info.schema, payload);
    if (wrong) throw new SpecError(`sends ${info.name} with ${wrong}`);
    const target = world.instances.find((i) => i.id === to?.id);
    if (!target) throw new SpecError(`sends ${message} to an instance that does not exist`);
    const id = ++world.seq;
    // Copied once, so the sender's state and the message never share anything, then shared.
    const odd = unstorable(payload, "payload");
    if (odd) throw new SpecError(notPlain(odd));
    const body = freeze(clone(payload));
    world.pending.push({ id, kind: "deliver", to: target.id, from: self.id, message, payload: body, text, ...(answers ? { answers } : {}) });
    effects.sent.push({ id, to: target.id, message, payload: body, text });
  };
  return {
    id: self.id,
    label: self.label,
    self: view.instance(self),
    from: from ? view.instance(from) : undefined,
    the: view.the,
    all: view.all,
    send,
    reply(value: unknown, payload: unknown, text?: string) {
      const message = keyOf(value);
      if (!from) throw new SpecError("reply is only possible in a message transition");
      if (delivery && calledBy(delivery.message)) throw new SpecError("a failure happens in this instance: there is no one to reply to");
      if (answering) {
        if (replied) throw new SpecError(`replies twice to ${messageName(spec, answering.message)}, a call: a call has one reply`);
        if (spec.messages[message]?.call) throw new SpecError(`replies to ${messageName(spec, answering.message)} with ${messageName(spec, message)}, a call: a call's reply is part of it, not a call of its own`);
        replied = true;
      }
      send(from, value, payload, text, answering);
    },
    start(label: string) {
      if (!step.starts.includes(label)) throw new SpecError(`starts ${label}, which it does not declare in starts`);
      const transition = actor.transitions[label];
      if (!transition || transition.message) throw new SpecError(`${label} is not an internal transition of ${actor.name}`);
      world.pending = world.pending.filter((p) => !(p.kind === "timer" && p.to === self.id && p.timer === label));
      world.pending.push({ id: ++world.seq, kind: "timer", to: self.id, timer: label });
      effects.started.push({ timer: label });
    },
    cancel(label: string) {
      const had = world.pending.length;
      world.pending = world.pending.filter((p) => !(p.kind === "timer" && p.to === self.id && p.timer === label));
      if (world.pending.length < had) effects.cancelled.push(label);
    },
    fresh(prefix: string) {
      if (observe) observe.shared = true;
      world.fresh[prefix] = (world.fresh[prefix] ?? 0) + 1;
      return `${prefix}-${world.fresh[prefix]}`;
    },
    hash: hashOf,
    random() {
      if (observe) observe.shared = true;
      world.rng = (world.rng + 0x6d2b79f5) >>> 0;
      let t = world.rng;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    note(text: string) {
      effects.notes.push(text);
    },
  };
}

/** Number the event, and check every `always` invariant on the world after it. */
function finish(
  spec: Spec,
  before: World,
  after: World,
  partial: Omit<Event, "index" | "violations" | "sent" | "started" | "cancelled" | "notes"> & Partial<Pick<Event, "sent" | "started" | "cancelled" | "notes" | "text">>,
  how: StepOptions = FULL,
): Step {
  const world = { ...after, seq: Math.max(after.seq, before.seq) + 1 };
  const event: Event = {
    index: world.seq,
    sent: [],
    started: [],
    cancelled: [],
    notes: [],
    ...partial,
    violations: [],
  };
  event.violations = how.invariants === false ? [] : violatedAlways(spec, world);
  return { world, event };
}

// Views for predicates --------------------------------------------------------------------------------

/** The world as predicates and examples see it; `onRead` hears whose state they read. */
export function worldView(spec: Spec, world: World, onRead?: (id: string) => void) {
  const views = new Map<string, { id: string; label: string; state: unknown }>();
  const instance = (i: InstanceState) => {
    let view = views.get(i.id);
    if (!view)
      views.set(
        i.id,
        (view = onRead
          ? {
              id: i.id,
              label: i.label,
              get state() {
                onRead(i.id);
                return i.state;
              },
            }
          : { id: i.id, label: i.label, state: i.state }),
      );
    return view;
  };
  const all = (actor: { name: string }) => world.instances.filter((i) => i.actor === actor?.name).map(instance);
  const the = (actor: { name: string }) => {
    const found = all(actor);
    if (found.length === 1) return found[0];
    const info = spec.actors.find((a) => a.name === actor?.name);
    throw new SpecError(found.length === 0 ? `there is no ${info?.name ?? "such actor"} yet` : `there are ${found.length} of ${info?.name}; use all() instead of the()`);
  };
  return { quiet: world.pending.length === 0, all, the, instance } as WorldView & { instance: typeof instance };
}

export function violatedAlways(spec: Spec, world: World): string[] {
  const view = worldView(spec, world);
  const violated: string[] = [];
  for (const invariant of spec.properties) {
    if (invariant.kind !== "always") continue;
    try {
      if (!invariant.always(view)) violated.push(invariant.id);
    } catch {
      // A predicate that cannot be evaluated yet (no instance to look at) holds vacuously.
    }
  }
  return violated;
}

export function holdsIn(spec: Spec, world: World, predicate: (world: WorldView) => boolean): boolean {
  try {
    return predicate(worldView(spec, world));
  } catch {
    return false;
  }
}

export function traceView(events: readonly Event[]): Trace {
  const views: TraceEvent[] = events.map((e) => ({
    index: e.index,
    actor: e.actor,
    key: e.key,
    is: (actor, step) => e.actor === actor.name && e.key === step && !e.error,
    replied: (message) => e.sent.some((s) => s.message === message.key),
    sent: (message) => e.sent.some((s) => s.message === message.key),
  }));
  return {
    events: views,
    count: (predicate) => views.filter(predicate).length,
    some: (predicate) => views.some(predicate),
  };
}

// Helpers ----------------------------------------------------------------------------------------------

/** Whether a delivery went to the step the message goes to left alone, rather than to another step on it. */
export function tookLeftAlone(spec: Spec, event: Pick<Event, "actor" | "key" | "message">): boolean {
  const actor = spec.actors.find((a) => a.name === event.actor);
  return !actor || event.message === undefined || leftAloneStep(actor, event.message) === event.key;
}

/** A delivery in words: its message's name, and the step that took it when that is not the one left alone ("charge → chargeLost"). */
export function deliveryName(spec: Spec, event: Pick<Event, "actor" | "key" | "message">): string {
  const message = messageName(spec, event.message ?? event.key);
  return tookLeftAlone(spec, event) ? message : `${message} → ${event.key}`;
}

export function messageName(spec: Spec, key: string): string {
  const call = calledBy(key);
  if (call) return `${spec.messages[call]?.name ?? call} failed`;
  return spec.messages[key]?.name ?? key;
}

/** The key a call's failure is delivered as (RFD0009): `failed:message:Write`. */
export function failureOf(call: string): string {
  return `failed:${call}`;
}

/** For a failure's key, the call that failed; otherwise undefined. */
export function calledBy(key: string): string | undefined {
  return key.startsWith("failed:") ? key.slice("failed:".length) : undefined;
}

/** Whether a fault can lose this pending entry: a message, but not a call's failure, which happens in the caller. */
export function losable(p: Pending): boolean {
  return p.kind === "deliver" && !calledBy(p.message);
}

/** A deterministic, readable stand-in for a hash. */
export function hashOf(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193) >>> 0;
  return `hash:${h.toString(36).slice(0, 6)}`;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "instance";
}

function uniqueId(world: World, base: string): string {
  if (!world.instances.some((i) => i.id === base)) return base;
  for (let n = 2; ; n++) if (!world.instances.some((i) => i.id === `${base}-${n}`)) return `${base}-${n}`;
}

/**
 * A deep copy. States and payloads are plain data, so plain objects, arrays, sets, maps and
 * dates are copied by hand, which is much faster than structuredClone; anything else falls
 * back to it.
 */
export function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = clone(value[i]);
    return out as T;
  }
  if (value instanceof Set) {
    const out = new Set();
    for (const member of value) out.add(clone(member));
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value) out.set(clone(k), clone(v));
    return out as T;
  }
  if (value instanceof Date) return new Date(value.getTime()) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return structuredClone(value);
  const out: Record<string, unknown> = {};
  for (const key in value) out[key] = clone((value as Record<string, unknown>)[key]);
  return out as T;
}

/** Deep-freeze a value the engine is done changing; it may then be shared between worlds. */
export function freeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  if (value instanceof Set || value instanceof Map) {
    // Object.freeze leaves a set's members and a map's entries changeable; these do not.
    for (const method of ["add", "set", "delete", "clear"] as const) {
      if (method in value) Object.defineProperty(value, method, { value: frozenCollection });
    }
    Object.freeze(value);
    for (const child of value instanceof Set ? value : [...value.keys(), ...value.values()]) freeze(child);
    return value;
  }
  Object.freeze(value);
  if (Array.isArray(value)) for (const child of value) freeze(child);
  else for (const key in value) freeze((value as Record<string, unknown>)[key]);
  return value;
}

function frozenCollection(): never {
  throw new TypeError("Cannot change a frozen set or map: it is read-only");
}

export function notPlain(where: string): string {
  return `holds ${where}, which is not plain data: states and payloads hold strings, numbers, booleans, null, arrays, plain objects, sets, maps and dates, so that the checker can tell them apart`;
}

/** Whether an error is a write to a frozen object: a step reaching into someone else's state. */
function readOnly(error: unknown): boolean {
  return error instanceof TypeError && /read[- ]only|not extensible|frozen|Attempted to assign/i.test(error.message);
}

/** Changes from `before` to `after`, by path. Arrays and leaves are compared whole. */
export function diff(instance: string, before: unknown, after: unknown, path = ""): Change[] {
  if (Object.is(before, after)) return [];
  if (isRecord(before) && isRecord(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((key) => diff(instance, before[key], after[key], join(path, key)));
  }
  if (sortedJson(before) === sortedJson(after)) return [];
  return [{ instance, path, before: clone(before), after: clone(after) }];
}

/** A plain object, walked key by key; sets, maps and other objects are compared whole. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function join(path: string, key: string): string {
  const part = /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
  if (!path) return /^[A-Za-z_$]/.test(part) ? part : `[${part}]`;
  return /^[A-Za-z_$]/.test(part) ? `${path}.${part}` : `${path}[${part}]`;
}
