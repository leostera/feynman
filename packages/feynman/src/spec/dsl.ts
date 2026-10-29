// The spec DSL: what a spec file writes. Types follow RFD0002; defineSpec turns the
// declarations into a Spec the engine runs.
import type {
  ActionInfo,
  ActorInfo,
  Fairness,
  GroupInfo,
  InputInfo,
  PropertyInfo,
  LimitInfo,
  MessageInfo,
  ScenarioInfo,
  Spec,
  TransitionInfo,
  ZoneInfo,
} from "./spec.ts";


/** Code a step stands for: `path#symbol` or `path:start-end`. */
export type Source = `${string}#${string}` | `${string}:${number}-${number}`;

export type Tone = "request" | "reply" | "refused" | "stream";

// How things are displayed ---------------------------------------------------------------------------
//
// Presentation is data on the actor, read by the explorer: an icon, a status line, a mood that
// colours it, rows that show its state as structure, and the live links it holds. These
// functions read only the actor's own state, so actors never need each other's types here.

/** What an actor is drawn as. */
export type Icon =
  | "person" | "people" | "phone" | "laptop" | "desktop" | "browser" | "server" | "cloud" | "database"
  | "shield" | "key" | "lock" | "terminal" | "robot" | "queue" | "folder" | "file" | "sheet" | "globe"
  | "gear" | "camera" | "video" | "mail" | "bell" | "clock" | "cpu" | "box" | "plug" | "wifi" | "chat"
  | "router" | "storage" | "code" | "pipeline" | "eye" | "card";

/**
 * Where a zone sits on the playground's map. Positions are still computed; these say what
 * matters to the picture: left to right, which zone is the region everything hangs off, and
 * how its instances line up.
 */
export interface ZonePlace {
  /** Left to right, from 0. Zones without one follow the direction messages flow. */
  column?: number;
  /** Draw it as a tinted region, as for a service. By default, a zone holding a singleton is one. */
  region?: boolean;
  /** Where its instances sit in the column: at the top, the middle (default), or the bottom. A region's start at the top. */
  align?: "start" | "center" | "end";
  /** How its instances line up: one under another (default), side by side, in a grid, or around a ring (peers in a cluster). */
  arrange?: "stack" | "row" | "grid" | "ring";
}

/** Where an actor's instances sit within their zone. */
export interface ActorPlace {
  /** Instances of actors with a lower order come first; within an order, by label, so "Studio app" and "Studio daemon" sit together. */
  order?: number;
  /** Sit on the zone's border rather than inside it, like a gate everything passes through. */
  edge?: "left" | "right";
}

/**
 * What a node is drawn as. By default it follows the icon: a service (cloud, server,
 * database…) is a circle with its name inside, a device (phone, laptop…) a rounded square,
 * and an actor on a zone's edge a gate.
 */
export type Shape = "circle" | "device" | "gate" | "card";

/** How things are going: colours a node, a row, or a link. */
export type Mood = "ok" | "warn" | "bad" | "busy" | "off" | "info";

/** One line of an actor's state, shown as structure: a host, an account, a file. */
export interface Row {
  label: string;
  detail?: string;
  mood?: Mood;
  /** Rows with the same group are boxed together under it: "Alice's account". */
  group?: string;
  /** An instance (id or label) this row belongs to; its group, and the row if it has no mood, take its colour. */
  owner?: string;
}

/**
 * Something an instance holds that a person can pick up and drop on another node, such as a
 * pairing code or a signed-in person. Dropping it runs the target's action whose input
 * `accepts` this kind, with `value` as that input.
 */
export interface Token {
  kind: string;
  value: string | number | boolean;
  /** What the chip shows; the value by default. */
  label?: string;
  mood?: Mood;
}

export interface Display<S> {
  icon?: Icon;
  shape?: Shape;
  /** Labels for instances added in the playground, in order: "Alice", "Bob". */
  names?: string[];
  /** A few words under the name: "connected", "not linked", "watching Studio". */
  status?: (state: Readonly<S>) => string;
  mood?: (state: Readonly<S>) => Mood;
  rows?: (state: Readonly<S>) => Row[];
  /**
   * Whose this is, as an instance id or label: a Mac belongs to the person whose account
   * it is linked to. It then wears that instance's colour; with null it stays neutral.
   */
  owner?: (state: Readonly<S>) => string | null;
  /** Things to drag onto other nodes, floating beside this one. */
  tokens?: (state: Readonly<S>, self: { id: string; label: string }) => Token[];
}

/** A live connection an instance holds: a socket, a session, a subscription. */
export interface Link {
  /** An instance id, an instance label, or the name of a singleton actor. */
  to: string;
  /** What it is: "websocket", "session"; links of one kind share a style. */
  kind?: string;
  label?: string;
  mood?: Mood;
  style?: "solid" | "dashed" | "dotted";
  /** The label of a row on the target to end at, so the line meets what it connects to. */
  row?: string;
}

// Messages ----------------------------------------------------------------------------------

/** A message kind and its payload type, declared in `defineSpec`'s `messages`. */
export interface MessageDef<P> {
  /** In everyday words: "pairing code". */
  name: string;
  /** The protocol it travels over: "https", "websocket", "unix socket". */
  over?: string;
  tone?: Tone;
  /** Phantom: carries the payload type. */
  readonly payload?: P;
}

export function message<P>(def: { name: string; over?: string; tone?: Tone }): MessageDef<P> {
  return def;
}

type Registry = Record<string, MessageDef<any>>;

/** A message's key: what transitions are keyed by, and what `send` takes. */
export type MessageKey<M extends Registry> = { [K in keyof M & string]: `message:${K}` }[keyof M & string];

type PayloadOf<M extends Registry, K> = K extends `message:${infer N}`
  ? N extends keyof M
    ? M[N] extends MessageDef<infer P>
      ? P
      : never
    : never
  : never;

// Actors, instances, and the world ------------------------------------------------------------

export interface Actor<S, A> {
  readonly name: string;
  /** Phantoms. */
  readonly __state?: S;
  readonly __actions?: A;
}

/** An actor handle's state type. */
export type StateOf<X> = X extends Actor<infer S, any> ? S : never;
/** An actor handle's actions: each action's key, to its inputs' types. */
export type ActionsOf<X> = X extends Actor<any, infer A> ? A : never;

export interface Instance<S, A> {
  readonly id: string;
  readonly label: string;
  readonly state: Readonly<S>;
  /** Phantom. */
  readonly __actions?: A;
}

/** The world as properties and examples see it. */
export interface World {
  /** Nothing is in flight: no message on its way and no timer set. "Once quiet, …" is how to say "in the end". */
  readonly quiet: boolean;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
}

// What a step can do ------------------------------------------------------------------------------

export interface Ctx<M extends Registry, Sends extends MessageKey<M>, Starts extends string> {
  /** This instance's id and label, and the instance itself, to send to yourself. */
  readonly id: string;
  readonly label: string;
  readonly self: Instance<unknown, unknown>;
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  /** Send a message; `text` says, for this event only, what it means. */
  send<K extends Sends>(to: Instance<any, any>, key: K, payload: PayloadOf<M, K>, text?: string): void;
  /**
   * Set one of this actor's internal transitions as a timer: from now on it may fire at any
   * moment, before or after anything else pending. Setting it again replaces it.
   */
  start(label: Starts): void;
  cancel(label: string): void;
  /** A fresh id: `cred-1`, `cred-2`. */
  fresh(prefix: string): string;
  /** A deterministic, readable stand-in for a hash: `hash:…`. */
  hash(value: string): string;
  /** A seeded random number in [0, 1). */
  random(): number;
  /** Explain this event when the step's description is not enough. */
  note(text: string): void;
}

/** In a message transition, `reply` answers the sender. */
export interface ReplyCtx<M extends Registry, Sends extends MessageKey<M>, Starts extends string> extends Ctx<M, Sends, Starts> {
  readonly from: Instance<any, any>;
  reply<K extends Sends>(key: K, payload: PayloadOf<M, K>, text?: string): void;
}

// Transitions and actions -------------------------------------------------------------------------

interface StepFields<M extends Registry, Sends extends MessageKey<M>, Starts extends string> {
  /** In everyday words, what the step does, in general. */
  description: string;
  /**
   * The code this step stands for, as an ordered trail. Leave it out while the code does
   * not exist yet, such as when designing a feature before building it; add it as the code
   * appears.
   */
  sources?: Source[];
  sends?: Sends[];
  starts?: Starts[];
}

export interface MessageTransition<M extends Registry, S, P, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  run(state: S, msg: P, ctx: ReplyCtx<M, Sends, Starts>): void;
  /** What happened this time, as the timeline says it, from the state after the step: "Made code 19YP for alice". */
  say?: (state: Readonly<S>, msg: P) => string;
  /** Housekeeping a reader need not watch, such as a heartbeat: views fold it away. The checker still explores it. */
  routine?: boolean;
  /**
   * Fairness for delivering this message (RFD0006): weak by default, so a message in flight
   * arrives unless a fault loses it. "strong", or false for a delivery that may never happen.
   */
  fair?: Fairness | false;
}

export interface InternalTransition<M extends Registry, S, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  /** When set, the transition can run whenever this holds, not only as a timer. */
  when?: (state: Readonly<S>) => boolean;
  /**
   * For a timer, when the code fires it, in words: "10 minutes", "after three missed
   * heartbeats". Shown to readers; it has no effect on when it can fire.
   */
  after?: string;
  run(state: S, ctx: Ctx<M, Sends, Starts>): void;
  /** What happened this time, as the timeline says it, from the state after the step. */
  say?: (state: Readonly<S>) => string;
  /**
   * Fairness (RFD0006): a guard or timer that stays possible from some point on eventually
   * happens ("weak", the default); "strong": one possible again and again eventually happens;
   * false: it may never happen.
   */
  fair?: Fairness | false;
  /** Housekeeping a reader need not watch, such as a heartbeat: views fold it away. The checker still explores it. */
  routine?: boolean;
}

// Inputs --------------------------------------------------------------------------------------------

export type InputType = StringConstructor | NumberConstructor | BooleanConstructor | readonly string[];

declare const INPUT: unique symbol;

/** Made by `spec.defineInput`; the brand keeps plain objects from claiming `examples`. */
export interface InputDef<T = InputType> {
  readonly [INPUT]: true;
  type: T;
  examples?: ((world: World) => ValueOf<T>[]) | readonly ValueOf<T>[];
  accepts?: string;
}

type ValueOf<T> = T extends StringConstructor
  ? string
  : T extends NumberConstructor
    ? number
    : T extends BooleanConstructor
      ? boolean
      : T extends readonly (infer V)[]
        ? V
        : never;

/** The values an action's inputs take, from their declared types. */
export type InputsOf<I> = { [K in keyof I]: ValueOf<I[K]> };

export interface ActionDef<M extends Registry, S, I, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  /** The button: "Paste a pairing code". */
  label: string;
  /** Plain `{ type }`, or `spec.defineInput(type, { examples })` for examples. */
  inputs?: { [K in keyof I]: { type: I[K]; examples?: "use spec.defineInput(type, { examples }) to give examples" } | InputDef<I[K]> };
  /** When set, the action is offered only while this holds. */
  when?: (state: Readonly<S>) => boolean;
  run(state: S, inputs: InputsOf<I>, ctx: Ctx<M, Sends, Starts>): void;
  /** What happened this time, as the timeline says it, from the state after the step. */
  say?: (state: Readonly<S>, inputs: InputsOf<I>) => string;
  /** Housekeeping a reader need not watch, such as a heartbeat: views fold it away. The checker still explores it. */
  routine?: boolean;
}

// Declarations ----------------------------------------------------------------------------------------

export interface Zone {
  readonly name: string;
}

export interface Limit {
  readonly name: string;
  readonly value: number;
}

/**
 * Actors shown as one thing: the relay, rather than its Worker and Durable Objects. A list
 * of singletons is one node. A record groups instances of other actors by label: with
 * `{ app: App, daemon: Axod }`, "Studio app" and "Studio daemon" are one "Studio".
 */
export interface GroupDef {
  name: string;
  actors: Actor<any, any>[] | Record<string, Actor<any, any>>;
  description?: string;
  icon?: Icon;
  shape?: Shape;
  /** Shown as one node to begin with (true); it opens on demand. */
  collapsed?: boolean;
  /** Names for instances added in the playground, for a record group: "Studio", "iMac". */
  names?: string[];
}

export interface Group {
  readonly name: string;
}

/**
 * `transitions`, keyed by a known message key or by a label for an internal transition.
 * `T` maps each key to the messages its transition sends, inferred from its `sends`.
 */
type TransitionsFor<M extends Registry, S, T> = {
  [P in keyof T]: P extends `message:${string}`
    ? P extends MessageKey<M>
      ? MessageTransition<M, S, PayloadOf<M, P>, T[P] & MessageKey<M>, string>
      : `${P & string} is not one of this spec's messages`
    : InternalTransition<M, S, T[P] & MessageKey<M>, string>;
};

/** `actions`: `A` maps each action to its inputs, `{ code: StringConstructor }`. */
type ActionsFor<M extends Registry, S, A> = {
  [P in keyof A]: ActionDef<M, S, A[P], MessageKey<M>, string>;
};

interface ActorDef<M extends Registry, S, A, T> {
  name: string;
  /** In everyday words, what this is. */
  description?: string;
  zone: Zone;
  /** One instance, spawned with the world. */
  singleton?: boolean;
  /** Where its instances sit within the zone, on the playground's map. */
  place?: ActorPlace;
  initialState: (ctx: { id: string; label: string }) => S;
  /** State that survives a restart; everything else returns to its initial value. */
  durable?: (keyof S & string)[];
  /**
   * Instances are interchangeable: the spec only compares their ids and labels for equality,
   * never orders them or computes with them. The checker then treats "Alice, then Bob" and
   * "Bob, then Alice" as one state. It tests the claim as it goes and says if it is false.
   */
  symmetric?: boolean;
  display?: Display<NoInfer<S>>;
  /** The live connections an instance holds now, from its own state. */
  links?: (state: Readonly<NoInfer<S>>, self: { id: string; label: string }) => Link[];
  actions?: ActionsFor<M, NoInfer<S>, A>;
  transitions?: TransitionsFor<M, NoInfer<S>, T>;
}

// Properties and scenarios ----------------------------------------------------------------------------

export interface TraceEvent {
  readonly index: number;
  readonly actor: string;
  readonly key: string;
  /** Whether this event is `actor` taking the step keyed `key`. */
  is(actor: Actor<any, any>, key: string): boolean;
  /** Whether this event sent a message keyed `key`. */
  replied(key: string): boolean;
  sent(key: string): boolean;
}

export interface Trace {
  readonly events: readonly TraceEvent[];
  count(predicate: (event: TraceEvent) => boolean): number;
  some(predicate: (event: TraceEvent) => boolean): boolean;
}

/**
 * A property: of every state (`always`), every step (`everyStep`), every path so far (`never`),
 * or of every fair infinite behaviour (`eventually`, `leadsTo`, `infinitelyOften`,
 * `eventuallyAlways`). See RFD0006 for what each means, and fairness.
 */
export type PropertyDef = (
  | { description: string; always: (world: World) => boolean }
  /** Of every step: the world before it, the world after, and the event. */
  | { description: string; everyStep: (before: World, after: World, event: TraceEvent) => boolean }
  | { description: string; never: (trace: Trace) => boolean }
  /** From the start, this happens at least once. */
  | { description: string; eventually: (world: World) => boolean }
  /** Every time `whenever` holds, `then` holds then or later. */
  | { description: string; leadsTo: { whenever: (world: World) => boolean; then: (world: World) => boolean } }
  /** This keeps happening, forever. */
  | { description: string; infinitelyOften: (world: World) => boolean }
  /** From some point on, this always holds. */
  | { description: string; eventuallyAlways: (world: World) => boolean }
) & {
  /**
   * A known bug: the property states what should hold, the system does not do it yet, and
   * `check` expects it broken. Say why, or link the issue. Check reports it, but it does not
   * fail; once the property holds, check fails until `known` is removed.
   */
  known?: string;
};

type ActionInputs<A, K extends keyof A> = InputsOf<A[K]>;
type NoInputs<A> = { [K in keyof A & string]: keyof A[K] extends never ? K : never }[keyof A & string];
type ActionsWithInputs<A> = Exclude<keyof A & string, NoInputs<A>>;
/** Actions that take no inputs; when there are none, a message saying what to do. */
type ActionsWithoutInputs<A> = [NoInputs<A>] extends [never]
  ? `every action of this actor takes inputs (${ActionsWithInputs<A>}); pass them as the third argument`
  : NoInputs<A>;

/**
 * The world a scenario starts in, set up rather than reached by events: a repository already
 * pushed to, a cluster with a leader. Each instance starts in its `initialState` with the
 * fields given here laid over it. The flow starts after it. It is a claim that the system
 * gets there; the checker explores from here too, and reports a property this world breaks.
 */
export interface Setup {
  /** A singleton's state at the start: these fields, over its `initialState`. */
  set<X extends Actor<any, any>>(actor: X, state: Partial<StateOf<X>>): void;
  /**
   * An instance there from the start, rather than spawned in the flow: its `initialState`,
   * with these fields over it. In `run`, find it with `s.the(Actor)` or `s.all(Actor)`.
   */
  spawn<X extends Actor<any, any>>(actor: X, label: string, state?: Partial<StateOf<X>>): void;
}

export interface Script {
  spawn<X extends Actor<any, any>>(actor: X, label: string): Instance<StateOf<X>, ActionsOf<X>>;
  /** The one instance of an actor (a singleton, or the only one spawned). */
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  /** Take an action that has no inputs. */
  act<S, A>(who: Instance<S, A>, action: ActionsWithoutInputs<A>, inputs?: Record<string, never>): void;
  /** Take an action with its inputs. */
  act<S, A, K extends ActionsWithInputs<A>>(who: Instance<S, A>, action: K, inputs: ActionInputs<A, K>): void;
  /**
   * Leave the system alone until nothing is pending: every message in flight arrives, in the
   * order it was sent, and when none is, the timer set first fires. With `until`, stop as soon
   * as it holds (before anything happens, if it holds already), to step in at that moment:
   * `s.settle({ until: (w) => w.the(Store).state.saved })`, then `s.restart(worker)`. It is an
   * error if the system settles, or runs SETTLE_LIMIT events, without getting there.
   */
  settle(options?: { until: (world: World) => boolean }): void;
  /** Fire one of an instance's timers now, ahead of what is in flight. */
  fire(who: Instance<any, any>, timer: string): void;
  /** Lose the next delivery of `key`, as a network would. */
  lose(key: string): void;
  /** Restart an instance: its state returns to its initial value, except durable fields. */
  restart(who: Instance<any, any>): void;
  /**
   * Deliver a message in flight to `who` now, ahead of the rest: the oldest one named
   * `message`, or the oldest carrying `payload` when given. Any message may overtake another.
   */
  deliver(who: Instance<any, any>, message: string, payload?: unknown): void;
  /** Lose a message in flight to `who` now, picked as `deliver` picks it. A fault. */
  drop(who: Instance<any, any>, message: string, payload?: unknown): void;
  /** Run one of `who`'s internal transitions whose `when` guard holds now. */
  step(who: Instance<any, any>, transition: string): void;
  /** The world now, to read state between steps. */
  readonly world: World;
}

// The spec ----------------------------------------------------------------------------------------------

export interface SpecBuilder<M extends Registry> {
  readonly messages: { [N in keyof M & string]: `message:${N}` };
  defineZone(def: { name: string; description?: string; place?: ZonePlace }): Zone;
  defineLimit(def: { name: string; value: number; unit?: string; sources?: Source[] }): Limit;
  defineActor<S, A = {}, T = {}>(def: ActorDef<M, S, A, T>): Actor<S, A>;
  /** An action input: its type, and the example values the playground offers and the checker tries. */
  /**
   * An action input. `examples` are what the playground offers and the checker tries;
   * `accepts` names a token kind that can be dropped on the node to fill this input.
   */
  defineInput<const T extends InputType>(type: T, options?: { examples?: ((world: World) => ValueOf<T>[]) | readonly ValueOf<T>[]; accepts?: string }): InputDef<T>;
  defineProperties(defs: Record<string, PropertyDef>): void;
  /**
   * The worlds where the system may stop: finished, not stuck. Any other world where nothing
   * can happen (no action possible, no guard holding, nothing pending) is reported as stuck.
   */
  defineFinalState(def: { description: string; when: (world: World) => boolean }): void;
  defineGroup(def: GroupDef): Group;
  /**
   * A flow a reader should see, scripted: `run` replays it event by event. `setup`, when
   * given, sets the world it starts in (see Setup), for a scenario that begins after some
   * history: a second push, a fetch after pushes.
   */
  defineScenario(def: { name: string; description?: string; setup?(setup: Setup): void; run(script: Script): void }): void;
}

export interface SpecOptions<M extends Registry> {
  messages: M;
  /** What the spec explains, in a sentence. */
  description?: string;
}

/**
 * A spec. The body may return its actors, `return { Person, Relay }`, so other files (a
 * playground) can name them with their types: `spec.handles.Person`.
 */
export function defineSpec<M extends Registry, H extends Record<string, Actor<any, any>> = {}>(
  name: string,
  options: SpecOptions<M>,
  body: (spec: SpecBuilder<M>) => H | void,
): Spec & { handles: H } {
  const messages: Record<string, MessageInfo> = {};
  for (const [id, def] of Object.entries(options.messages)) {
    const key = `message:${id}`;
    messages[key] = { key, id, name: def.name, over: def.over, tone: def.tone ?? "request" };
  }
  const spec: Spec = {
    name,
    description: options.description,
    messages,
    zones: [],
    limits: [],
    actors: [],
    properties: [],
    scenarios: [],
    groups: [],
  };
  const builder: SpecBuilder<M> = {
    messages: Object.fromEntries(Object.keys(options.messages).map((id) => [id, `message:${id}`])) as SpecBuilder<M>["messages"],
    defineZone(def) {
      const zone: ZoneInfo = { name: def.name, description: def.description, place: def.place ?? {} };
      spec.zones.push(zone);
      return zone;
    },
    defineLimit(def) {
      const limit: LimitInfo = { name: def.name, value: def.value, unit: def.unit, sources: def.sources ?? [] };
      spec.limits.push(limit);
      return limit;
    },
    defineActor(def) {
      const actor = actorInfo(spec, def as unknown as RawActor);
      spec.actors.push(actor);
      return actor as unknown as Actor<any, any>;
    },
    defineInput(type, options) {
      return { type, examples: options?.examples, accepts: options?.accepts } as never;
    },
    defineProperties(defs) {
      for (const [id, def] of Object.entries(defs)) {
        if (spec.properties.some((p) => p.id === id)) throw new Error(`Two properties are named "${id}"`);
        spec.properties.push(propertyInfo(id, def));
      }
    },
    defineFinalState(def) {
      if (spec.finalState) throw new Error("defineFinalState is called once; say every final world in one predicate");
      if (typeof def.when !== "function") throw new Error("defineFinalState: `when` is a predicate on the world, like (w) => w.the(Client).state.done");
      spec.finalState = { description: def.description, when: def.when as never };
    },
    defineGroup(def) {
      const group = groupInfo(spec, def);
      spec.groups.push(group);
      return group;
    },
    defineScenario(def) {
      if (spec.scenarios.some((s) => s.name === def.name)) throw new Error(`Two scenarios are named "${def.name}"`);
      if (def.setup !== undefined && typeof def.setup !== "function") throw new Error(`Scenario "${def.name}": setup is a function, like setup(w) { w.set(Store, { saved: true }) }`);
      const scenario: ScenarioInfo = { name: def.name, description: def.description, ...(def.setup ? { setup: def.setup as ScenarioInfo["setup"] } : {}), run: def.run as ScenarioInfo["run"] };
      spec.scenarios.push(scenario);
    },
  };
  const handles = body(builder) ?? ({} as H);
  return Object.assign(spec, { handles });
}

function groupInfo(spec: Spec, def: GroupDef): GroupInfo {
  if (spec.groups.some((g) => g.name === def.name)) throw new Error(`Two groups are named "${def.name}"`);
  const members = Array.isArray(def.actors)
    ? def.actors.map((a) => ({ actor: a.name, suffix: null }))
    : Object.entries(def.actors).map(([suffix, a]) => ({ actor: a.name, suffix }));
  for (const m of members) if (!spec.actors.some((a) => a.name === m.actor)) throw new Error(`Group "${def.name}": define ${m.actor} before the group`);
  return { name: def.name, description: def.description, icon: def.icon, shape: def.shape, collapsed: def.collapsed ?? true, names: def.names, members };
}

// From declarations to the spec the engine runs ---------------------------------------------------------

interface RawStep {
  description: string;
  sources?: string[];
  sends?: string[];
  starts?: string[];
  when?: (state: unknown) => boolean;
  after?: string;
  fair?: Fairness | false;
  run: (...args: never[]) => void;
  say?: (state: unknown, payload: unknown) => string;
  routine?: boolean;
}

interface RawActor {
  name: string;
  description?: string;
  zone: ZoneInfo;
  singleton?: boolean;
  place?: ActorPlace;
  initialState: ActorInfo["initialState"];
  durable?: string[];
  symmetric?: boolean;
  display?: ActorInfo["display"];
  links?: ActorInfo["links"];
  actions?: Record<string, RawStep & { label: string; inputs?: Record<string, { type: InputType; examples?: unknown; accepts?: string }> }>;
  transitions?: Record<string, RawStep>;
}

function actorInfo(spec: Spec, raw: RawActor): ActorInfo {
  if (spec.actors.some((actor) => actor.name === raw.name)) throw new Error(`Two actors are named "${raw.name}"`);
  if (!raw.zone?.name) throw new Error(`${raw.name}: say where it runs, with zone: a zone from spec.defineZone`);
  if (raw.durable !== undefined && !Array.isArray(raw.durable)) throw new Error(`${raw.name}: durable lists state fields, like durable: ["codes"]`);
  const actions: Record<string, ActionInfo> = {};
  for (const [key, step] of Object.entries(raw.actions ?? {})) {
    if (step.fair !== undefined) throw new Error(`${raw.name}.${key}: actions are never fair (a person may stop); fair is for transitions`);
    actions[key] = {
      key,
      label: step.label,
      description: step.description,
      sources: step.sources ?? [],
      sends: step.sends ?? [],
      starts: step.starts ?? [],
      when: step.when,
      say: step.say,
      routine: step.routine ?? false,
      inputs: Object.fromEntries(
        Object.entries(step.inputs ?? {}).map(([name, input]) => [
          name,
          { type: inputKind(input.type), values: Array.isArray(input.type) ? [...input.type] : undefined, examples: examplesOf(input.examples), accepts: input.accepts },
        ]),
      ),
      run: step.run as ActionInfo["run"],
    };
  }
  const transitions: Record<string, TransitionInfo> = {};
  for (const [key, step] of Object.entries(raw.transitions ?? {})) {
    const message = key.startsWith("message:") ? key : undefined;
    if (message && !spec.messages[message]) throw new Error(`${raw.name}: ${message} is not one of this spec's messages`);
    // Keyed by a label, it is a timer or a guarded step: no message arrives, so its run is
    // (state, ctx). A third parameter would take ctx's place and fail when it first runs.
    if (!message && step.run.length >= 3) {
      throw new Error(`${raw.name}.${key}: a timer or guarded transition receives no message: its run is (state, ctx), not (state, msg, ctx)`);
    }
    transitions[key] = {
      key,
      message,
      description: step.description,
      sources: step.sources ?? [],
      sends: step.sends ?? [],
      starts: step.starts ?? [],
      when: step.when,
      after: step.after,
      ...fairnessOf(`${raw.name}.${key}`, step.fair),
      say: step.say,
      routine: step.routine ?? false,
      run: step.run as TransitionInfo["run"],
    };
  }
  return {
    name: raw.name,
    description: raw.description,
    zone: raw.zone.name,
    singleton: raw.singleton ?? false,
    initialState: raw.initialState,
    durable: raw.durable ?? [],
    symmetric: raw.symmetric === true,
    display: raw.display ?? {},
    place: raw.place ?? {},
    links: raw.links,
    actions,
    transitions,
  };
}

function examplesOf(examples: unknown): InputInfo["examples"] {
  if (typeof examples === "function") return examples as never;
  if (Array.isArray(examples)) return () => [...examples];
  return undefined;
}

function inputKind(type: InputType): "string" | "number" | "boolean" | "choice" {
  if (type === String) return "string";
  if (type === Number) return "number";
  if (type === Boolean) return "boolean";
  return "choice";
}

/** A step's fairness, as declared: weak or strong, or false for none; anything else is a mistake. */
function fairnessOf(step: string, fair: unknown): { fair?: Fairness | false } {
  if (fair === undefined) return {};
  if (fair === "weak" || fair === "strong" || fair === false) return { fair };
  throw new Error(`${step}: fair is "weak", "strong" or false, not ${JSON.stringify(fair)}`);
}

/** Every kind of property, by the key a definition declares it with: a Record, so the compiler keeps it complete. */
const PROPERTY_KINDS = Object.keys({ always: 0, everyStep: 0, never: 0, eventually: 0, leadsTo: 0, infinitelyOften: 0, eventuallyAlways: 0 } satisfies Record<PropertyInfo["kind"], 0>);

/** A property definition, read into the one kind it declares; a definition with none, several, or a predicate that is not a function is a mistake. */
function propertyInfo(id: string, def: PropertyDef): PropertyInfo {
  const kinds = PROPERTY_KINDS.filter((k) => k in def);
  if (kinds.length !== 1) throw new Error(`Property "${id}": say what it checks with one of ${PROPERTY_KINDS.join(", ")}${kinds.length ? `, not ${kinds.join(" and ")}` : ""}`);
  const predicate = (value: unknown, what: string) => {
    if (typeof value !== "function") throw new Error(`Property "${id}": ${what} is a function, like (w) => …`);
    return value as never;
  };
  const base = { id, description: def.description, ...(def.known === undefined ? {} : { known: def.known }) };
  if ("always" in def) return { ...base, kind: "always", always: predicate(def.always, "always") };
  if ("everyStep" in def) return { ...base, kind: "everyStep", everyStep: predicate(def.everyStep, "everyStep") };
  if ("never" in def) return { ...base, kind: "never", never: predicate(def.never, "never") };
  if ("eventually" in def) return { ...base, kind: "eventually", eventually: predicate(def.eventually, "eventually") };
  if ("leadsTo" in def) return { ...base, kind: "leadsTo", whenever: predicate(def.leadsTo?.whenever, "leadsTo.whenever"), then: predicate(def.leadsTo?.then, "leadsTo.then") };
  if ("infinitelyOften" in def) return { ...base, kind: "infinitelyOften", infinitelyOften: predicate(def.infinitelyOften, "infinitelyOften") };
  return { ...base, kind: "eventuallyAlways", eventuallyAlways: predicate(def.eventuallyAlways, "eventuallyAlways") };
}
