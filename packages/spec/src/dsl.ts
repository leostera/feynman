// The spec DSL: what a spec file writes. Types follow RFD0002 and the typing prototype in
// prototypes/spec-typing; defineSpec turns the declarations into a Spec the engine runs.
import type {
  ActionInfo,
  ActorInfo,
  GroupInfo,
  InputInfo,
  InvariantInfo,
  LimitInfo,
  MessageInfo,
  ScenarioInfo,
  Spec,
  TransitionInfo,
  ZoneInfo,
} from "./spec.ts";

export const SEC = 1000;
export const MIN = 60 * SEC;

/** Code a step stands for: `path#symbol` or `path:start-end`. */
export type Source = `${string}#${string}` | `${string}:${number}-${number}`;

export type Tone = "request" | "reply" | "refused" | "stream";

// How things look -----------------------------------------------------------------------------
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
  /** How its instances line up: one under another (default), side by side, or in a grid. */
  arrange?: "stack" | "row" | "grid";
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
  /** When it stops being usable, in simulated milliseconds: the chip counts down to it. */
  expires?: number;
}

export interface Look<S> {
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
  /** How long it takes to arrive, in milliseconds; the spec's default otherwise. */
  latency?: number;
  /** Phantom: carries the payload type. */
  readonly payload?: P;
}

export function message<P>(def: { name: string; over?: string; tone?: Tone; latency?: number }): MessageDef<P> {
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

/** The world as invariants and examples see it. */
export interface World {
  readonly now: number;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
}

// What a step can do ------------------------------------------------------------------------------

export interface Ctx<M extends Registry, Sends extends MessageKey<M>, Starts extends string> {
  /** This instance's id and label, and the instance itself, to send to yourself. */
  readonly id: string;
  readonly label: string;
  readonly self: Instance<unknown, unknown>;
  /** Simulated time, in milliseconds. */
  readonly now: number;
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  /** Send a message; `text` says, for this event only, what it means. */
  send<K extends Sends>(to: Instance<any, any>, key: K, payload: PayloadOf<M, K>, text?: string): void;
  /** Start one of this actor's internal transitions as a timer. Restarting replaces it. */
  start(label: Starts, after: number): void;
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
}

export interface InternalTransition<M extends Registry, S, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  /** When set, the transition can run whenever this holds, not only as a timer. */
  when?: (state: Readonly<S>) => boolean;
  run(state: S, ctx: Ctx<M, Sends, Starts>): void;
  /** What happened this time, as the timeline says it, from the state after the step. */
  say?: (state: Readonly<S>) => string;
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
  look?: Look<NoInfer<S>>;
  /** The live connections an instance holds now, from its own state. */
  links?: (state: Readonly<NoInfer<S>>, self: { id: string; label: string }) => Link[];
  actions?: ActionsFor<M, NoInfer<S>, A>;
  transitions?: TransitionsFor<M, NoInfer<S>, T>;
}

// Invariants and scenarios ----------------------------------------------------------------------------

export interface TraceEvent {
  readonly index: number;
  readonly at: number;
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

export type InvariantDef =
  | { description: string; always: (world: World) => boolean }
  | {
      description: string;
      /** Once `after` holds (always, by default), the system running by itself gets here within `within` milliseconds. */
      eventually: (world: World) => boolean;
      after?: (world: World) => boolean;
      within: number;
    }
  | { description: string; never: (trace: Trace) => boolean };

type ActionInputs<A, K extends keyof A> = InputsOf<A[K]>;
type NoInputs<A> = { [K in keyof A & string]: keyof A[K] extends never ? K : never }[keyof A & string];
type ActionsWithInputs<A> = Exclude<keyof A & string, NoInputs<A>>;
/** Actions that take no inputs; when there are none, a message saying what to do. */
type ActionsWithoutInputs<A> = [NoInputs<A>] extends [never]
  ? `every action of this actor takes inputs (${ActionsWithInputs<A>}); pass them as the third argument`
  : NoInputs<A>;

export interface Script {
  spawn<X extends Actor<any, any>>(actor: X, label: string): Instance<StateOf<X>, ActionsOf<X>>;
  /** The one instance of an actor (a singleton, or the only one spawned). */
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  /** Take an action that has no inputs. */
  act<S, A>(who: Instance<S, A>, action: ActionsWithoutInputs<A>, inputs?: Record<string, never>): void;
  /** Take an action with its inputs. */
  act<S, A, K extends ActionsWithInputs<A>>(who: Instance<S, A>, action: K, inputs: ActionInputs<A, K>): void;
  /** Run what is due within `horizon` milliseconds (a minute by default), in time order. */
  settle(horizon?: number): void;
  /** Let `ms` pass, running what falls due. */
  wait(ms: number): void;
  /** Lose the next delivery of `key`, as a network would. */
  lose(key: string): void;
  /** Restart an instance: its state returns to its initial value, except durable fields. */
  restart(who: Instance<any, any>): void;
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
  defineInvariants(defs: Record<string, InvariantDef>): void;
  defineGroup(def: GroupDef): Group;
  defineScenario(def: { name: string; description?: string; run(script: Script): void }): void;
}

export interface SpecOptions<M extends Registry> {
  messages: M;
  /** What the spec explains, in a sentence. */
  description?: string;
  /** Default message latency in milliseconds (50). */
  latency?: number;
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
    messages[key] = { key, id, name: def.name, over: def.over, tone: def.tone ?? "request", latency: def.latency };
  }
  const spec: Spec = {
    name,
    description: options.description,
    latency: options.latency ?? 50,
    messages,
    zones: [],
    limits: [],
    actors: [],
    invariants: [],
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
    defineInvariants(defs) {
      for (const [id, def] of Object.entries(defs)) spec.invariants.push(invariantInfo(id, def));
    },
    defineGroup(def) {
      const group = groupInfo(spec, def);
      spec.groups.push(group);
      return group;
    },
    defineScenario(def) {
      const scenario: ScenarioInfo = { name: def.name, description: def.description, run: def.run as ScenarioInfo["run"] };
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
  look?: ActorInfo["look"];
  links?: ActorInfo["links"];
  actions?: Record<string, RawStep & { label: string; inputs?: Record<string, { type: InputType; examples?: unknown; accepts?: string }> }>;
  transitions?: Record<string, RawStep>;
}

function actorInfo(spec: Spec, raw: RawActor): ActorInfo {
  if (spec.actors.some((actor) => actor.name === raw.name)) throw new Error(`Two actors are named "${raw.name}"`);
  if (raw.durable !== undefined && !Array.isArray(raw.durable)) throw new Error(`${raw.name}: durable lists state fields, like durable: ["codes"]`);
  const actions: Record<string, ActionInfo> = {};
  for (const [key, step] of Object.entries(raw.actions ?? {})) {
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
    transitions[key] = {
      key,
      message,
      description: step.description,
      sources: step.sources ?? [],
      sends: step.sends ?? [],
      starts: step.starts ?? [],
      when: step.when,
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
    look: raw.look ?? {},
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

function invariantInfo(id: string, def: InvariantDef): InvariantInfo {
  if ("always" in def) return { id, description: def.description, kind: "always", always: def.always };
  if ("eventually" in def) return { id, description: def.description, kind: "eventually", eventually: def.eventually, after: def.after, within: def.within };
  return { id, description: def.description, kind: "never", never: def.never };
}
