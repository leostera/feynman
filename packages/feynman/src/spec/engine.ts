// The engine: pure steps from a world to the next world and the event that explains it.
// Deterministic by construction: time is simulated, ids and randomness come from the
// world, and every handler sees the world only through its state, input, and ctx.
//
// Worlds share structure: a step copies only the state of the instance taking it, and
// every other state is the same object as in the world before. States are frozen once a
// step is done, so sharing is safe, and a handler that tries to change another
// instance's state fails loudly instead of corrupting the past.
import type { Trace, TraceEvent, WorldView } from "./spec.ts";
import type { ActorInfo, Change, Event, EventKind, InstanceState, ModelView, Pending, Sent, Spec, StepInfo, VariableInfo, World } from "./spec.ts";
import type { Delivery } from "./dsl.ts";
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
  /** Filled in with what the step depended on, for the checker's step cache (integer.ts). */
  observe?: Observation;
}

/** What a step depended on and touched, besides its argument: what decides whether its effect can be reused. */
export interface Observation {
  /** It read another instance's state (`the`, `all`, `from`). */
  others: boolean;
  /** It used a counter every instance shares (`fresh`, `random`). */
  counters: boolean;
  /** It read or set one of the world's model variables. */
  variables: boolean;
  /** It reset its instance, dropping the messages on their way to it that this picks. */
  drops?: (delivery: Delivery) => boolean;
  /** It read or changed its own instance: its state, its own variables or its timers. */
  own: boolean;
}

export function observation(): Observation {
  return { others: false, counters: false, variables: false, own: false };
}

/** The state as a step sees it, noting any use of it. */
function watchedState(state: unknown, observe: Observation): unknown {
  if (typeof state !== "object" || state === null) return state;
  const touch = () => void (observe.own = true);
  return new Proxy(state, {
    get: (target, key) => (touch(), Reflect.get(target, key)),
    set: (target, key, value) => (touch(), Reflect.set(target, key, value)),
    has: (target, key) => (touch(), Reflect.has(target, key)),
    ownKeys: (target) => (touch(), Reflect.ownKeys(target)),
    deleteProperty: (target, key) => (touch(), Reflect.deleteProperty(target, key)),
    defineProperty: (target, key, descriptor) => (touch(), Reflect.defineProperty(target, key, descriptor)),
    getOwnPropertyDescriptor: (target, key) => (touch(), Reflect.getOwnPropertyDescriptor(target, key)),
  });
}

/** A message in flight as a step sees it (`ctx.delivery`, a reset's `drops`); `onRead` hears whose state is read. */
export function deliveryIn(spec: Spec, world: World, p: Extract<Pending, { kind: "deliver" }>, onRead?: (id: string) => void): Delivery {
  const sender = world.instances.find((i) => i.id === p.from);
  return { message: p.message, from: sender ? worldView(spec, world, onRead).instance(sender) : undefined, payload: p.payload, ...(p.answers ? { answers: p.answers } : {}) } as Delivery;
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
      if (whenHolds(spec, world, instance, action.step)) actions.push({ instance: instance.id, key: action.step.key, inputs: action.inputs });
    }
    for (const transition of steps.guards) {
      if (whenHolds(spec, world, instance, transition)) guards.push({ instance: instance.id, key: transition.key });
    }
  }
  return { actions, guards, pending: pendingInOrder(world) };
}

type Steps = { actions: { step: StepInfo; inputs: string[] }[]; guards: StepInfo[] };

/** Each actor's actions and guarded transitions as lists, worked out once per spec. */
const stepLists = new WeakMap<Spec, Map<string, Steps>>();

function stepsOf(spec: Spec, actorName: string): Steps {
  let lists = stepLists.get(spec);
  if (!lists) stepLists.set(spec, (lists = new Map()));
  let steps = lists.get(actorName);
  if (!steps) {
    const actor = actorNamed(spec, actorName);
    steps = {
      actions: Object.values(actor.actions).map((a) => ({ step: a, inputs: Object.keys(a.inputs) })),
      guards: Object.values(actor.transitions).filter((t) => !t.message && t.when),
    };
    lists.set(actorName, steps);
  }
  return steps;
}

/**
 * Whether a step's `when` holds for an instance in a world: it reads the instance's state and
 * the model variables the step uses. One that throws does not hold, except for reading a
 * variable the step does not list in `uses`, which is a spec error.
 */
export function whenHolds(spec: Spec, world: World, instance: InstanceState, step: StepInfo, own = false): boolean {
  if (!step.when && (own || !step.bound)) return true;
  try {
    const model = modelView(spec, world, instance, step);
    if (!own && step.bound && !step.bound(model)) return false;
    return step.when ? step.when(instance.state, model) : true;
  } catch (error) {
    if (error instanceof UndeclaredVariable) throw new SpecError(`${instance.actor}.${step.key}: ${error.message}`);
    return false;
  }
}

class UndeclaredVariable extends Error {}

/** A variable's value as the spec starts it: its initial value, or one `--set` gave it. */
function initialOf(spec: Spec, name: string): VariableInfo {
  const info = spec.variables.find((v) => v.name === name);
  if (!info) throw new UndeclaredVariable(`${name} is not one of this spec's variables`);
  return info;
}

/** A variable's value for an instance: its own for an `each` variable, else the world's; absent, its initial value. */
export function variableIn(spec: Spec, world: World, instance: InstanceState | undefined, name: string): unknown {
  const info = initialOf(spec, name);
  if (info.each !== undefined) {
    if (!instance || instance.actor !== info.each) throw new UndeclaredVariable(`${name} is one per ${info.each}, and ${instance?.actor ?? "the world"} has none`);
    return instance.variables && name in instance.variables ? instance.variables[name] : info.initial;
  }
  return world.variables && name in world.variables ? world.variables[name] : info.initial;
}

/** The model as a step's `when` reads it: the variables it uses, and no others. */
function modelView(spec: Spec, world: World, instance: InstanceState, step: StepInfo): ModelView {
  return {
    get(variable) {
      const name = (variable as { name?: string })?.name;
      if (typeof name !== "string" || !step.uses.includes(name)) throw new UndeclaredVariable(`reads ${name ?? String(variable)}, which it does not declare in uses`);
      return variableIn(spec, world, instance, name) as never;
    },
  };
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
  return runStep(spec, world, { kind: "action", instance, actor, step: action, inputs, call: (state, ctx) => action.run(state, inputs, ctx) }, how);
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
  return steps.length === 1 && !actor.transitions[steps[0]].when ? steps : steps.filter((s) => whenHolds(spec, world, instance, actor.transitions[s]));
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
  if (transition && !whenHolds(spec, consumed, instance, transition)) throw new SpecError(`${actor.name}.${name} cannot take ${messageName(spec, pending.message)} now: its when does not hold`);
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
  return runStep(spec, consumed, {
    kind: "deliver",
    instance,
    actor,
    step: transition,
    delivery,
    received: pending,
    notes: pending.text ? [pending.text] : [],
    from,
    call: (state, ctx) => transition.run(state, pending.payload, ctx),
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

// Running a step -----------------------------------------------------------------------------------

interface Running {
  kind: EventKind;
  instance: InstanceState;
  actor: ActorInfo;
  step: StepInfo;
  inputs?: Record<string, unknown>;
  delivery?: { message: string; payload: unknown; from: string };
  /** For a delivery: the message as it was in flight, which `ctx.forward` puts back. */
  received?: Extract<Pending, { kind: "deliver" }>;
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
  const effects: Effects = { sent: [], started: [], cancelled: [], notes: [...(run.notes ?? [])], variables: [] };
  const base = {
    kind: run.kind,
    instance: self.id,
    actor: run.actor.name,
    key: run.step.key,
    ...(run.step.tags.length ? { tags: run.step.tags } : {}),
    description: run.step.description,
    sources: run.step.sources,
    inputs: run.kind === "action" ? run.inputs : undefined,
    ...run.delivery,
  };
  try {
    const watching = how.observe ? watchedState(state, how.observe) : state;
    const returned = run.call(watching, makeCtx(spec, next, self, state, run, effects, how.observe));
    if (returned instanceof Promise) throw new SpecError("its run is async: a step happens at once, so it cannot await; tell others with a message and handle their reply in another step");
    // `(s) => s.n++` and `(s) => (s.list = [...])` return what they assign, harmlessly; an object
    // the state does not hold looks like a new state, which would be lost.
    if (typeof returned === "object" && returned !== null && returned !== watching && !contains(state, returned))
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
  const changes = explain ? [...diff(self.id, self.state, state), ...effects.variables] : [];
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

/** What a step did besides changing its state, gathered while it runs. */
interface Effects {
  sent: Sent[];
  started: { timer: string }[];
  cancelled: string[];
  notes: string[];
  /** Changes to model variables, as changes: `@faults` on the world (instance ""), or on its own instance. */
  variables: Change[];
}

/** What `send` takes after the payload: the text, or the text and the request the message answers. */
type SendOptions = string | { text?: string; answers?: { message: string; payload: unknown } };

function makeCtx(spec: Spec, world: World, self: InstanceState, state: unknown, run: Running, effects: Effects, observe?: Observation) {
  const { actor, step, from, delivery, received } = run;
  const declared = (variable: { name: string }) => {
    const name = (variable as { name?: string })?.name;
    if (typeof name !== "string" || !step.uses.includes(name)) throw new SpecError(`uses ${name ?? String(variable)}, which it does not declare in uses`);
    return name;
  };
  const variableValue = (variable: { name: string }, quiet: boolean) => {
    const name = declared(variable);
    if (!quiet && observe) {
      if (spec.variables.find((v) => v.name === name)!.each) observe.own = true;
      else observe.variables = true;
    }
    try {
      return variableIn(spec, world, self, name);
    } catch (error) {
      throw new SpecError(error instanceof Error ? error.message : String(error));
    }
  };
  // A reply to a message that correlates records the request it answers.
  const answering = delivery && spec.messages[delivery.message]?.correlate ? { message: delivery.message, payload: delivery.payload } : undefined;
  let replied = false;
  const onRead = observe ? (id: string) => void (id === self.id ? (observe.own = true) : (observe.others = true)) : undefined;
  const ownTouched = () => void (observe && (observe.own = true));
  const view = worldView(spec, world, onRead);
  const send = (to: { id: string }, value: unknown, payload: unknown, options?: SendOptions, tagged?: { message: string; payload: unknown }) => {
    const text = typeof options === "string" ? options : options?.text;
    const answers = tagged ?? (typeof options === "object" ? options.answers : undefined);
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
  const deliveryOf = (p: Extract<Pending, { kind: "deliver" }>) => deliveryIn(spec, world, p, onRead);
  return {
    id: self.id,
    label: self.label,
    self: view.instance(self),
    from: from ? view.instance(from) : undefined,
    the: view.the,
    all: view.all,
    send,
    reply(value: unknown, payload: unknown, text?: string) {
      if (!from) throw new SpecError("reply is only possible in a message transition");
      if (answering) {
        if (replied) throw new SpecError(`replies twice to ${messageName(spec, answering.message)}: a reply answers one request once`);
        replied = true;
      }
      send(from, value, payload, text, answering);
    },
    /** The message being handled: its key, sender, payload, and the request it answers, if any. */
    delivery: received ? deliveryOf(received) : undefined,
    /**
     * Puts the message being handled back in flight as it was: same sender, payload, and request
     * it answers. As another message, it keeps the sender and answers nothing.
     */
    forward(as?: { message: unknown; payload: unknown }) {
      if (!received) throw new SpecError("forward is only possible in a step on a message");
      const id = ++world.seq;
      if (!as) {
        world.pending.push({ ...received, id });
        effects.sent.push({ id, to: received.to, message: received.message, payload: received.payload, text: received.text });
        return;
      }
      const message = keyOf(as.message);
      if (!step.sends.includes(message)) throw new SpecError(`forwards as ${message.slice("message:".length)}, which it does not declare in sends`);
      const info = spec.messages[message];
      const wrong = info && mismatch(info.schema, as.payload);
      if (wrong) throw new SpecError(`forwards as ${info.name} with ${wrong}`);
      const odd = unstorable(as.payload, "payload");
      if (odd) throw new SpecError(notPlain(odd));
      const body = freeze(clone(as.payload));
      world.pending.push({ id, kind: "deliver", to: received.to, from: received.from, message, payload: body });
      effects.sent.push({ id, to: received.to, message, payload: body });
    },
    /**
     * Starts this instance again: its state becomes its initial state, with the fields in
     * `keeps` carried over; its timers are cancelled; the messages on their way to it that
     * `drops` picks are dropped.
     */
    reset(options?: { keeps?: readonly string[]; drops?: (delivery: Delivery) => boolean }) {
      ownTouched();
      const keeps = options?.keeps ?? [];
      const old = state as Record<string, unknown>;
      for (const field of keeps) if (!(field in old)) throw new SpecError(`reset keeps ${field}, which its state does not have`);
      const fresh = clone(actor.initialState({ id: self.id, label: self.label })) as Record<string, unknown>;
      for (const field of keeps) fresh[field] = old[field];
      for (const key of Object.keys(old)) delete old[key];
      Object.assign(old, fresh);
      for (const p of world.pending) if (p.kind === "timer" && p.to === self.id) effects.cancelled.push(p.timer);
      const drops = options?.drops;
      // What it drops depends on what others sent it: the integer core applies `drops` itself,
      // to each message in flight to the instance (Observation).
      if (drops && observe) observe.drops = drops;
      world.pending = world.pending.filter((p) => p.to !== self.id || (p.kind === "deliver" && !drops?.(deliveryOf(p))));
    },
    get(variable: { name: string }) {
      return variableValue(variable, false);
    },
    set(variable: { name: string }, value: unknown) {
      const name = declared(variable);
      const odd = unstorable(value, "variable");
      if (odd) throw new SpecError(notPlain(odd));
      const info = spec.variables.find((v) => v.name === name)!;
      if (observe) {
        if (info.each) observe.own = true;
        else observe.variables = true;
      }
      const before = variableValue(variable, true);
      const stored = freeze(clone(value));
      // Its initial value is the same state as never set: kept out, so one state has one key.
      const initial = sortedJson(stored) === sortedJson(info.initial);
      const owner = info.each ? self : world;
      const values = { ...(owner.variables ?? {}) };
      if (initial) delete values[name];
      else values[name] = stored;
      if (Object.keys(values).length) owner.variables = values;
      else delete owner.variables;
      effects.variables.push({ instance: info.each ? self.id : "", path: `@${name}`, before: clone(before), after: clone(stored) });
    },
    start(label: string) {
      if (!step.starts.includes(label)) throw new SpecError(`starts ${label}, which it does not declare in starts`);
      const transition = actor.transitions[label];
      if (!transition || transition.message) throw new SpecError(`${label} is not an internal transition of ${actor.name}`);
      ownTouched();
      world.pending = world.pending.filter((p) => !(p.kind === "timer" && p.to === self.id && p.timer === label));
      world.pending.push({ id: ++world.seq, kind: "timer", to: self.id, timer: label });
      effects.started.push({ timer: label });
    },
    cancel(label: string) {
      ownTouched();
      const had = world.pending.length;
      world.pending = world.pending.filter((p) => !(p.kind === "timer" && p.to === self.id && p.timer === label));
      if (world.pending.length < had) effects.cancelled.push(label);
    },
    fresh(prefix: string) {
      if (observe) observe.counters = true;
      world.fresh[prefix] = (world.fresh[prefix] ?? 0) + 1;
      return `${prefix}-${world.fresh[prefix]}`;
    },
    hash: hashOf,
    random() {
      if (observe) observe.counters = true;
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
  const get = (variable: { name: string }, of?: { id: string }) => variableIn(spec, world, of ? world.instances.find((i) => i.id === of.id) : undefined, variable?.name);
  return { quiet: world.pending.length === 0, all, the, get, instance } as WorldView & { instance: typeof instance };
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
  return spec.messages[key]?.name ?? key;
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
