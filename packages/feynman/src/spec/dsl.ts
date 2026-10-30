// The spec DSL: what a spec file writes (RFD0011). Each part is a value: messages, zones, actors,
// rules, properties and scenarios; defineSpec assembles them into the Spec the engine runs.
import { isSchema, type Fields, type Shaped, type TypeOf } from "./schema.ts";
import type {
  ActionInfo,
  ActorInfo,
  Fairness,
  GroupInfo,
  InputInfo,
  PropertyInfo,
  LimitInfo,
  ScenarioInfo,
  Spec,
  StepInfo,
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
//
// A message is a value (RFD0011): its id, its payload schema, and how it reads. Steps hold the
// message they react to (`on: Charge`), and `send` takes it, so nothing is keyed by a string.

/** Definition order, so a spec lists its zones, messages and rules as its file defines them. */
let defined = 0;

export interface Message<Id extends string = string, P = unknown> {
  readonly kind: "message";
  /** `Charge`, unique within a spec. */
  readonly id: Id;
  /** The engine's key: `message:Charge`. */
  readonly key: `message:${Id}`;
  /** In everyday words: "charge". */
  readonly name: string;
  /** The protocol it travels over: "https", "websocket", "unix socket". */
  readonly over?: string;
  readonly tone: Tone;
  /** A call (RFD0009): its loss, or its reply's, reaches the caller as its failure. */
  readonly call: boolean;
  readonly schema: Fields;
  readonly seq: number;
  /** Phantom: the payload type. */
  readonly __payload?: P;
}

/** A call: a message whose failure reaches its caller. */
export interface Call<Id extends string = string, P = unknown> extends Message<Id, P> {
  readonly call: true;
}

/** A call's failure, as a value: what the caller's step is `on`, and what scenarios deliver. */
export interface Failed<Id extends string = string, P = unknown> {
  readonly kind: "failure";
  /** The engine's key: `failed:message:Charge`. */
  readonly key: `failed:message:${Id}`;
  readonly call: Call<Id, P>;
  /** Phantom: the call's payload type. */
  readonly __failure?: P;
}

export type AnyMessage = Message<string, any>;
type AnyFailed = Failed<string, any>;

/** A message's payload type. */
export type PayloadOf<M> = M extends Message<string, infer P> ? P : never;

interface MessageOptions {
  /** In everyday words, shown in traces: "pairing code". By default, the id in words. */
  name?: string;
  over?: string;
  tone?: Tone;
}

function makeMessage(id: string, schema: unknown, options: MessageOptions | undefined, call: boolean, what: string): Message<string, unknown> {
  if (typeof id !== "string" || !/^[A-Za-z_][\w]*$/.test(id)) throw new Error(`${what}'s first argument is its id, a word like "Charge": not ${JSON.stringify(id)}`);
  const fields = schema ?? {};
  if (typeof fields !== "object" || fields === null || Array.isArray(fields) || !isSchema(fields))
    throw new Error(`${what}("${id}", …): its payload is an object of field schemas, like { payment: String }`);
  return Object.freeze({
    kind: "message",
    id,
    key: `message:${id}`,
    name: options?.name ?? words(id),
    over: options?.over,
    tone: options?.tone ?? "request",
    call,
    schema: fields as Fields,
    seq: ++defined,
  }) as Message<string, unknown>;
}

/** `SyncReply` in words: "sync reply". */
function words(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
}

/** A message, with its payload's schema: `defineMessage("Charged", { payment: String }, { tone: "reply" })`. */
export function defineMessage<const Id extends string, F extends Fields = {}>(id: Id, schema?: F, options?: MessageOptions): Message<Id, TypeOf<F>> {
  return makeMessage(id, schema, options, false, "defineMessage") as Message<Id, TypeOf<F>>;
}

/**
 * A call (RFD0009): a message whose failure reaches its caller, as an RPC or a `fetch` throws.
 * Losing it, or the reply its handler sends with `ctx.reply`, delivers the call's failure to the
 * caller, which handles it with a step `on: failed(Call)`. The caller can't tell which of the two
 * was lost. Every actor that sends a call handles its failure.
 */
export function defineCall<const Id extends string, F extends Fields = {}>(id: Id, schema?: F, options?: MessageOptions): Call<Id, TypeOf<F>> {
  return makeMessage(id, schema, options, true, "defineCall") as Call<Id, TypeOf<F>>;
}

/** A call's failure: `on: failed(Charge)` in the caller, `s.deliver(client, failed(Charge))` in a scenario. */
export function failed<Id extends string, P>(call: Call<Id, P>): Failed<Id, P> {
  if (!call || call.kind !== "message") throw new Error("failed takes a call from defineCall, like failed(Charge)");
  if (!call.call) throw new Error(`failed(${call.id}): ${call.name} is a message, not a call; define it with defineCall for its failure to reach the caller`);
  return { kind: "failure", key: `failed:${call.key}`, call } as Failed<Id, P>;
}

// Actors, instances, and the world ------------------------------------------------------------

declare const PARTS: unique symbol;

export interface Actor<S = any, A = any> {
  readonly name: string;
  /** Phantoms. */
  readonly __state?: S;
  readonly __actions?: A;
}

/** An actor's state type. */
export type StateOf<X> = X extends Actor<infer S, any> ? S : never;
/** An actor's actions: each action's key, to its inputs' types. */
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

/**
 * What a step can do. A step's `ctx` sends only what its `sends` lists; a helper shared by steps
 * takes a plain `Ctx`, and a step passes its own.
 */
export interface Ctx<Sends extends AnyMessage = AnyMessage> {
  /** This instance's id and label, and the instance itself, to send to yourself. */
  readonly id: string;
  readonly label: string;
  readonly self: Instance<unknown, unknown>;
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  /** Send a message; `text` says, for this event only, what it means. */
  send<M extends Sends>(to: Instance<any, any>, message: M, payload: PayloadOf<M>, text?: string): void;
  /**
   * Set one of this actor's timers: from now on it may fire at any moment, before or after
   * anything else pending. Setting it again replaces it.
   */
  start(timer: string): void;
  cancel(timer: string): void;
  /** A fresh id: `cred-1`, `cred-2`. */
  fresh(prefix: string): string;
  /** A deterministic, readable stand-in for a hash: `hash:…`. */
  hash(value: string): string;
  /** A seeded random number in [0, 1). */
  random(): number;
  /** Explain this event when the step's description is not enough. */
  note(text: string): void;
}

/** In a step `on` a message, `reply` answers the sender. */
export interface ReplyCtx<Sends extends AnyMessage = AnyMessage> extends Ctx<Sends> {
  readonly from: Instance<any, any>;
  reply<M extends Sends>(message: M, payload: PayloadOf<M>, text?: string): void;
}

/** What a call's failure carries: the payload of the call that failed, and whom it was to. */
export interface Failure<P> {
  readonly payload: P;
  readonly to: Instance<any, any>;
}

// Steps -------------------------------------------------------------------------------------------

/** What a step receives: a message's payload, a failure, or nothing for a timer or a guard. */
type Received<On> = On extends Message<string, infer P> ? P : On extends Failed<string, infer P> ? Failure<P> : undefined;
type CtxOn<On, Sends extends AnyMessage> = On extends AnyMessage ? ReplyCtx<Sends> : Ctx<Sends>;

/**
 * A step of an actor, named by its key in `transitions`. It is one of three kinds: `on` a
 * message or a call's failure; a timer of the same name, started with `ctx.start` (say when the
 * code fires it with `after`); or a guarded step, possible whenever `when` holds.
 */
export interface StepDef<S, On, Sends extends AnyMessage> {
  /** The message, or the call's failure (`failed(Call)`), this step reacts to. */
  on?: On;
  /**
   * For a guarded step: it can run whenever this holds. For a step on a message: it can take
   * the message only while this holds.
   */
  when?: (state: Readonly<S>) => boolean;
  /**
   * For a timer, when the code fires it, in words: "10 minutes", "after three missed
   * heartbeats". Shown to readers; it has no effect on when it can fire.
   */
  after?: string;
  /** In everyday words, what the step does, in general. */
  description: string;
  /**
   * The code this step stands for, as an ordered trail. Leave it out while the code does not
   * exist yet; add it as the code appears.
   */
  sources?: Source[];
  starts?: string[];
  run(state: S, received: Received<On>, ctx: CtxOn<On, Sends>): void;
  /** What happened this time, as the timeline says it, from the state after the step: "Made code 19YP for alice". */
  say?: (state: Readonly<S>, received: Received<On>) => string;
  /** Housekeeping a reader need not watch, such as a heartbeat: views fold it away. The checker still explores it. */
  routine?: boolean;
  /**
   * Fairness (RFD0006). A delivery, timer or guard that stays possible from some point on
   * eventually happens ("weak", the default); "strong": one possible again and again eventually
   * happens; false: it may never happen.
   */
  fair?: Fairness | false;
}

// Inputs --------------------------------------------------------------------------------------------

/** What an action input holds: String, Number, Boolean, or `oneOf(…)` for a choice. */
export type InputType = StringConstructor | NumberConstructor | BooleanConstructor | Shaped<string | number | boolean>;

declare const INPUT: unique symbol;

/** Made by `input`: an input's type with examples. */
export interface InputDef<T = InputType> {
  readonly [INPUT]: true;
  type: T;
  examples?: ((world: World) => ValueOf<T>[]) | readonly ValueOf<T>[];
  accepts?: string;
}

type ValueOf<T> = T extends InputDef<infer U> ? ValueOf<U> : TypeOf<T>;

/** The values an action's inputs take, from their declared types. */
export type InputsOf<I> = { [K in keyof I]: ValueOf<I[K]> };

/**
 * An action input with examples. `examples` are what the playground offers and the checker
 * tries; `accepts` names a token kind that can be dropped on the node to fill this input.
 */
export function input<const T extends InputType>(type: T, options?: { examples?: ((world: World) => ValueOf<T>[]) | readonly ValueOf<T>[]; accepts?: string }): InputDef<T> {
  return { type, examples: options?.examples, accepts: options?.accepts } as InputDef<T>;
}

export interface ActionDef<S, I> {
  /** The button: "Paste a pairing code". */
  label: string;
  description: string;
  sources?: Source[];
  sends?: readonly AnyMessage[];
  starts?: string[];
  /** `{ code: String, vote: oneOf("yes", "no") }`, or `input(type, { examples })` for examples. */
  inputs?: { [K in keyof I]: I[K] };
  /** When set, the action is offered only while this holds. */
  when?: (state: Readonly<S>) => boolean;
  run(state: S, inputs: InputsOf<I>, ctx: Ctx): void;
  /** What happened this time, as the timeline says it, from the state after the step. */
  say?: (state: Readonly<S>, inputs: InputsOf<I>) => string;
  /** Housekeeping a reader need not watch, such as a heartbeat: views fold it away. The checker still explores it. */
  routine?: boolean;
}

// Zones, limits and groups ----------------------------------------------------------------------

export interface Zone {
  readonly name: string;
}

export function defineZone(def: { name: string; description?: string; place?: ZonePlace }): Zone {
  if (!def?.name) throw new Error("defineZone takes a name, like defineZone({ name: \"Cloud\" })");
  return Object.freeze({ name: def.name, description: def.description, place: def.place ?? {}, seq: ++defined }) as Zone;
}

export interface Limit {
  readonly name: string;
  readonly value: number;
}

export function defineLimit(def: { name: string; value: number; unit?: string; sources?: Source[] }): Limit {
  return Object.freeze({ name: def.name, value: def.value, unit: def.unit, sources: def.sources ?? [] }) as Limit;
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

export function defineGroup(def: GroupDef): Group {
  return Object.freeze({ ...def }) as Group;
}

// Actors ----------------------------------------------------------------------------------------

/** A link to an actor, or to an instance by id or label. */
export interface ActorLink extends Omit<Link, "to"> {
  /** An actor (a singleton), or an instance id or label. */
  to: Actor<any, any> | string;
}

interface ActorDef<S, A, O, Sn> {
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
  links?: (state: Readonly<NoInfer<S>>, self: { id: string; label: string }) => ActorLink[];
  actions?: { [K in keyof A]: ActionDef<NoInfer<S>, A[K]> };
  /** Its steps, by name: `charge: { on: Charge, … }`, `retry: { after: "10 seconds", … }`, `drain: { when: …, … }`. */
  transitions?: { [K in keyof O]: StepDef<NoInfer<S>, O[K], Sn[K & keyof Sn] & AnyMessage> } & { [K in keyof Sn]: { sends?: readonly Sn[K][] } };
}

// Global, so an actor reads the same from every copy of this module: a spec bundled with its
// own copy still runs in the engine's.
const ACTOR = Symbol.for("feynman.actor");
type RawDef = ActorDef<unknown, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;

/** An actor: a kind of process, with its state and its steps. */
export function defineActor<S, A = {}, O = {}, Sn = {}>(def: ActorDef<S, A, O, Sn>): Actor<S, A> {
  if (!def?.name) throw new Error("defineActor takes a name, like defineActor({ name: \"Bank\", … })");
  if (!def.zone?.name) throw new Error(`${def.name}: say where it runs, with zone: a zone from defineZone`);
  if (typeof def.initialState !== "function") throw new Error(`${def.name}: initialState is a function returning its state, like initialState: () => ({ count: 0 })`);
  return Object.freeze({ name: def.name, [ACTOR]: def as unknown as RawDef }) as Actor<S, A>;
}

function definitionOf(actor: Actor<any, any>): RawDef {
  const def = (actor as unknown as { [ACTOR]?: RawDef })?.[ACTOR];
  if (!def) throw new Error(`${(actor as { name?: string })?.name ?? String(actor)} is not an actor from defineActor`);
  return def;
}

// Properties and scenarios ----------------------------------------------------------------------------

export interface TraceEvent {
  readonly index: number;
  readonly actor: string;
  readonly key: string;
  /** Whether this event is `actor` taking the step or action named `step`. */
  is(actor: Actor<any, any>, step: string): boolean;
  /** Whether this event sent `message`. */
  replied(message: AnyMessage): boolean;
  sent(message: AnyMessage): boolean;
}

export interface Trace {
  readonly events: readonly TraceEvent[];
  count(predicate: (event: TraceEvent) => boolean): number;
  some(predicate: (event: TraceEvent) => boolean): boolean;
}

/** The variant being run: the rules off in it, while one of its steps, guards or properties runs. */
let variant: readonly string[] | undefined;

/** A rule of the design (RFD0010): a part that exists to keep properties true. */
export interface Rule {
  readonly name: string;
  readonly description: string;
  /** Whether the rule is in the design being run: true as written, false in a variant without it. */
  readonly on: boolean;
}

/**
 * A rule of the design: a part that exists to keep properties true (RFD0010). Read `rule.on`
 * where it applies, in steps, guards and properties; properties that need it say so with
 * `needs: [rule]`. It is on in the spec as written, and off in the variant without it
 * (`feynman check --without name`).
 */
export function defineRule(name: string, def: { description: string }): Rule {
  if (typeof name !== "string" || !/^[A-Za-z_][\w-]*$/.test(name)) throw new Error(`A rule's name is a word, like "pendingRule", which --without names it by: not ${JSON.stringify(name)}`);
  const rule = {
    name,
    description: def?.description ?? "",
    seq: ++defined,
    get on(): boolean {
      if (variant === undefined) throw new Error(`rule ${name}: read rule.on in a step, a guard, a property or a display function, where the design being checked is known; not when the file loads`);
      return !variant.includes(name);
    },
  };
  return Object.freeze(rule);
}

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
   * The rules of the design this property needs (RFD0010): without any one of them, it should
   * break. `check` checks the design without each rule, and fails when the property still holds.
   */
  needs?: readonly Rule[];
  /**
   * A known bug: the property states what should hold, the system does not do it yet, and
   * `check` expects it broken. Say why, or link the issue. Check reports it, but it does not
   * fail; once the property holds, check fails until `known` is removed.
   */
  known?: string;
};

export interface Property {
  readonly id: string;
}

/**
 * A property: of every state (`always`), every step (`everyStep`), every path so far (`never`),
 * or of every fair infinite behaviour (`eventually`, `leadsTo`, `infinitelyOften`,
 * `eventuallyAlways`). See RFD0006 for what each means, and fairness.
 */
export function defineProperty(id: string, def: PropertyDef): Property {
  if (typeof id !== "string" || !id) throw new Error("defineProperty's first argument is its id, like defineProperty(\"chargedOnce\", { … })");
  propertyInfo(id, def);
  return Object.freeze({ id, def });
}

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

/** What a scenario's `setup` receives: a shared setup is a function of it. */
export type SetupWorld = Setup;

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
  /** Lose the next delivery of `message`, as a network would. */
  lose(message: AnyMessage | AnyFailed): void;
  /** Restart an instance: its state returns to its initial value, except durable fields. */
  restart(who: Instance<any, any>): void;
  /**
   * Deliver a message in flight to `who` now, ahead of the rest: the oldest of `message`, or
   * the oldest carrying `payload` when given. Any message may overtake another. A call's failure
   * is `failed(Call)`: `s.deliver(client, failed(Charge))`.
   */
  deliver<M extends AnyMessage | AnyFailed>(who: Instance<any, any>, message: M, payload?: M extends AnyMessage ? PayloadOf<M> : unknown): void;
  /** Lose a message in flight to `who` now, picked as `deliver` picks it. A fault. */
  drop<M extends AnyMessage | AnyFailed>(who: Instance<any, any>, message: M, payload?: M extends AnyMessage ? PayloadOf<M> : unknown): void;
  /**
   * Take one of `who`'s steps by name: a guarded step whose `when` holds now, or a step on a
   * message, which takes the oldest such message in flight to `who` (the oldest carrying
   * `payload`, if given), as `deliver` picks it.
   */
  step(who: Instance<any, any>, step: string, payload?: unknown): void;
  /** The world now, to read state between steps. */
  readonly world: World;
}

export interface Scenario {
  readonly name: string;
}

/**
 * A flow a reader should see, scripted: `run` replays it event by event. `setup`, when given,
 * sets the world it starts in (see Setup), for a scenario that begins after some history: a
 * second push, a fetch after pushes.
 */
export function defineScenario(name: string, def: { description?: string; setup?(setup: Setup): void; run(script: Script): void }): Scenario {
  if (typeof name !== "string" || !name) throw new Error("defineScenario's first argument is its name, like defineScenario(\"A payment\", { … })");
  if (def?.setup !== undefined && typeof def.setup !== "function") throw new Error(`Scenario "${name}": setup is a function, like setup(w) { w.set(Store, { saved: true }) }`);
  if (typeof def?.run !== "function") throw new Error(`Scenario "${name}": run is a function, like run(s) { s.act(s.the(Client), "pay"); s.settle(); }`);
  return Object.freeze({ name, def });
}

// The spec ----------------------------------------------------------------------------------------------

export interface SpecParts {
  name: string;
  /** What the spec explains, in a sentence. */
  description?: string;
  actors: Actor<any, any>[];
  groups?: Group[];
  limits?: Limit[];
  /** Rules no property needs yet; rules a property needs are found from it. */
  rules?: Rule[];
  properties?: Property[];
  /**
   * The worlds where the system may stop: finished, not stuck. Any other world where nothing
   * can happen (no action possible, no guard holding, nothing pending) is reported as stuck.
   */
  finalState?: { description: string; when: (world: World) => boolean };
  scenarios?: Scenario[];
}

/**
 * A spec, assembled from its parts. Messages, zones and rules are found from the actors and
 * properties that use them.
 */
export function defineSpec(parts: SpecParts): Spec {
  if (typeof parts === "string")
    throw new Error(`defineSpec(${JSON.stringify(parts)}, { messages }, (spec) => …) is gone: a spec is made of parts since 0.14 (RFD0011). Define each part at the top level, then defineSpec({ name: ${JSON.stringify(parts)}, actors, properties, scenarios }); the changelog's Migrating section has the steps`);
  if (typeof parts !== "object" || parts === null || typeof parts.name !== "string")
    throw new Error("defineSpec takes its parts: defineSpec({ name, actors, properties, scenarios })");
  return assemble(parts, []);
}

type Ordered = { seq: number };
const bySeq = (a: unknown, b: unknown) => (a as Ordered).seq - (b as Ordered).seq;

/** The spec from its parts, with these rules off (RFD0010): the design as written has none off. */
function assemble(parts: SpecParts, without: string[]): Spec {
  const name = without.length ? `${parts.name} without ${without.join(", ")}` : parts.name;
  const actors = parts.actors ?? [];
  if (!Array.isArray(actors) || actors.length === 0) throw new Error(`${parts.name}: list its actors, like actors: [Client, Bank]`);
  const defs = actors.map(definitionOf);

  // Messages and zones, from the actors that use them, in the order the file defines them.
  const messages = new Map<string, Message<string, unknown>>();
  const addMessage = (m: unknown, where: string) => {
    const message = (m as AnyFailed)?.kind === "failure" ? (m as AnyFailed).call : (m as Message<string, unknown>);
    if (message?.kind !== "message") throw new Error(`${where}: ${describe(m)} is not a message from defineMessage or defineCall`);
    const known = messages.get(message.id);
    if (known && known !== message) throw new Error(`${parts.name}: two different messages have the id "${message.id}"`);
    messages.set(message.id, message);
  };
  const zones = new Map<string, Zone & Ordered>();
  for (const def of defs) {
    const known = zones.get(def.zone.name);
    if (known && known !== def.zone) throw new Error(`${parts.name}: two different zones are named "${def.zone.name}"`);
    zones.set(def.zone.name, def.zone as Zone & Ordered);
    for (const [key, action] of Object.entries(def.actions ?? {}) as [string, ActionDef<unknown, unknown>][]) for (const m of action.sends ?? []) addMessage(m, `${def.name}.${key}`);
    for (const [key, step] of Object.entries(def.transitions ?? {}) as [string, RawStep][]) {
      if (step.on !== undefined) {
        if (step.on?.kind !== "message" && step.on?.kind !== "failure") throw new Error(`${def.name}.${key}: on is a message from defineMessage, or failed(Call), not ${describe(step.on)}`);
        addMessage(step.on, `${def.name}.${key}`);
      }
      for (const m of step.sends ?? []) addMessage(m, `${def.name}.${key}`);
    }
  }

  // Rules, from the properties that need them and those listed.
  const rules = new Map<string, Rule & Ordered>();
  const addRule = (r: Rule, where: string) => {
    if (typeof (r as Partial<Ordered>)?.seq !== "number" || typeof r.name !== "string") throw new Error(`${where} needs something that is not a rule: pass rules from defineRule`);
    const known = rules.get(r.name);
    if (known && known !== r) throw new Error(`${parts.name}: two different rules are named "${r.name}"`);
    rules.set(r.name, r as Rule & Ordered);
  };
  for (const r of parts.rules ?? []) addRule(r, parts.name);
  const properties = (parts.properties ?? []) as (Property & { def: PropertyDef })[];
  for (const p of properties) for (const r of p.def.needs ?? []) addRule(r, `Property "${p.id}"`);
  for (const n of without) if (!rules.has(n)) throw new Error(`${parts.name} has no rule named "${n}"; its rules: ${[...rules.keys()].join(", ") || "none"}`);

  // In a spec with rules, its code runs knowing which variant it is in, for `rule.on`.
  const scope = rules.size ? scoped(without) : <F>(fn: F) => fn;

  const spec: Spec = {
    name,
    description: parts.description,
    messages: Object.fromEntries(
      [...messages.values()].sort(bySeq).map((m) => [m.key, { key: m.key, id: m.id, name: m.name, over: m.over, tone: m.tone, call: m.call, schema: m.schema }]),
    ),
    zones: [...zones.values()].sort(bySeq).map((z) => ({ name: z.name, description: (z as unknown as ZoneInfo).description, place: (z as unknown as ZoneInfo).place })),
    limits: (parts.limits ?? []).map((l) => l as unknown as LimitInfo),
    actors: [],
    properties: [],
    scenarios: [],
    groups: [],
    rules: [...rules.values()].sort(bySeq).map((r) => ({ name: r.name, description: r.description, neededBy: [] })),
    without,
    withoutRules(names) {
      for (const n of names) if (!rules.has(n)) throw new Error(`${parts.name} has no rule named "${n}"; its rules: ${[...rules.keys()].join(", ") || "none"}`);
      return assemble(parts, [...new Set([...without, ...names])]);
    },
  };

  for (const def of defs) {
    if (spec.actors.some((a) => a.name === def.name)) throw new Error(`Two actors are named "${def.name}"`);
    spec.actors.push(actorInfo(spec, def, scope));
  }
  checkTalk(spec);

  for (const p of properties) {
    if (spec.properties.some((q) => q.id === p.id)) throw new Error(`Two properties are named "${p.id}"`);
    for (const r of p.def.needs ?? []) spec.rules.find((x) => x.name === r.name)!.neededBy.push(p.id);
    spec.properties.push(scopeProperty(propertyInfo(p.id, p.def), scope));
  }
  if (parts.finalState !== undefined) {
    if (typeof parts.finalState.when !== "function") throw new Error("finalState: `when` is a predicate on the world, like (w) => w.the(Client).state.done");
    spec.finalState = { description: parts.finalState.description, when: scope(parts.finalState.when) as never };
  }
  for (const g of parts.groups ?? []) spec.groups.push(groupInfo(spec, g as unknown as GroupDef));
  for (const s of (parts.scenarios ?? []) as (Scenario & { def: { description?: string; setup?: ScenarioInfo["setup"]; run: ScenarioInfo["run"] } })[]) {
    if (spec.scenarios.some((x) => x.name === s.name)) throw new Error(`Two scenarios are named "${s.name}"`);
    spec.scenarios.push({ name: s.name, description: s.def.description, ...(s.def.setup ? { setup: scope(s.def.setup) } : {}), run: scope(s.def.run) });
  }
  return spec;
}

function describe(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === undefined) return "undefined";
  return (value as { name?: string })?.name ?? typeof value;
}

/** Runs a function knowing which variant it belongs to, so `rule.on` reads it. */
function scoped(without: readonly string[]) {
  return <F>(fn: F): F => {
    if (typeof fn !== "function") return fn;
    return function (this: unknown, ...args: unknown[]) {
      const outer = variant;
      variant = without;
      try {
        return (fn as (...a: unknown[]) => unknown).apply(this, args);
      } finally {
        variant = outer;
      }
    } as F;
  };
}
type Scope = ReturnType<typeof scoped>;

function scopeProperty(p: PropertyInfo, scope: Scope): PropertyInfo {
  const out = { ...p } as Record<string, unknown>;
  for (const key of ["always", "everyStep", "never", "eventually", "whenever", "then", "infinitelyOften", "eventuallyAlways"]) if (typeof out[key] === "function") out[key] = scope(out[key]);
  return out as PropertyInfo;
}

/**
 * Who talks to whom, checked before anything runs: every message sent is received by an actor
 * of the spec, and an actor that sends a call handles its failure (RFD0009).
 */
function checkTalk(spec: Spec): void {
  const received = new Set(spec.actors.flatMap((a) => Object.values(a.transitions).flatMap((t) => (t.message ? [t.message] : []))));
  for (const actor of spec.actors) {
    for (const step of [...Object.values(actor.actions), ...Object.values(actor.transitions)]) {
      for (const key of step.sends) {
        const info = spec.messages[key]!;
        if (!received.has(key)) throw new Error(`${actor.name}.${step.key}: sends ${info.name}, but no actor of ${spec.name} has a step on ${info.id}`);
        if (info.call && !actor.stepsOn[`failed:${key}`])
          throw new Error(`${actor.name}: sends ${info.name}, a call: handle its failure with a step on failed(${info.id})`);
      }
    }
  }
}

function groupInfo(spec: Spec, def: GroupDef): GroupInfo {
  if (spec.groups.some((g) => g.name === def.name)) throw new Error(`Two groups are named "${def.name}"`);
  const members = Array.isArray(def.actors)
    ? def.actors.map((a) => ({ actor: a.name, suffix: null }))
    : Object.entries(def.actors).map(([suffix, a]) => ({ actor: a.name, suffix }));
  for (const m of members) if (!spec.actors.some((a) => a.name === m.actor)) throw new Error(`Group "${def.name}": ${m.actor} is not one of ${spec.name}'s actors`);
  return { name: def.name, description: def.description, icon: def.icon, shape: def.shape, collapsed: def.collapsed ?? true, names: def.names, members };
}

// From declarations to the spec the engine runs ---------------------------------------------------------

interface RawStep {
  on?: AnyMessage | AnyFailed;
  description: string;
  sources?: string[];
  sends?: AnyMessage[];
  starts?: string[];
  when?: (state: unknown) => boolean;
  after?: string;
  fair?: Fairness | false;
  run: (...args: never[]) => void;
  say?: (state: unknown, payload: unknown) => string;
  routine?: boolean;
}

function keysOf(sends: readonly unknown[] | undefined, where: string): string[] {
  return (sends ?? []).map((m) => {
    if ((m as AnyMessage)?.kind !== "message") throw new Error(`${where}: sends lists messages from defineMessage or defineCall, not ${describe(m)}`);
    return (m as AnyMessage).key;
  });
}

function actorInfo(spec: Spec, raw: RawDef, scope: Scope): ActorInfo {
  if (raw.durable !== undefined && !Array.isArray(raw.durable)) throw new Error(`${raw.name}: durable lists state fields, like durable: ["codes"]`);
  const display = Object.fromEntries(Object.entries(raw.display ?? {}).map(([k, v]) => [k, scope(v)])) as ActorInfo["display"];
  const actions: Record<string, ActionInfo> = {};
  for (const [key, step] of Object.entries(raw.actions ?? {}) as [string, ActionDef<unknown, Record<string, unknown>> & { fair?: unknown }][]) {
    if (step.fair !== undefined) throw new Error(`${raw.name}.${key}: actions are never fair (a person may stop); fair is for transitions`);
    actions[key] = {
      key,
      label: step.label,
      description: step.description,
      sources: step.sources ?? [],
      sends: keysOf(step.sends, `${raw.name}.${key}`),
      starts: step.starts ?? [],
      when: scope(step.when) as StepInfo["when"],
      say: scope(step.say) as StepInfo["say"],
      routine: step.routine ?? false,
      inputs: Object.fromEntries(Object.entries(step.inputs ?? {}).map(([name, value]) => [name, inputInfo(`${raw.name}.${key}`, name, value)])),
      run: scope(step.run) as ActionInfo["run"],
    };
  }
  const transitions: Record<string, TransitionInfo> = {};
  const stepsOn: Record<string, string[]> = {};
  for (const [name, step] of Object.entries(raw.transitions ?? {}) as [string, RawStep][]) {
    const where = `${raw.name}.${name}`;
    if (typeof step?.run !== "function") throw new Error(`${where}: a step has a run, like run(state, msg, ctx) { … }`);
    const on = step.on;
    if (on !== undefined && on?.kind !== "message" && on?.kind !== "failure") throw new Error(`${where}: on is a message from defineMessage, or failed(Call), not ${describe(on)}`);
    if (on && step.after !== undefined) throw new Error(`${where}: a step on a message is not a timer: leave out after`);
    // A timer or a guard receives nothing: its run is (state, _, ctx), like every step's. The
    // 0.13 form, (state, ctx), would take ctx's place and fail when it first runs.
    if (!on && step.run.length === 2) throw new Error(`${where}: a timer or a guard receives nothing, and its run is (state, _, ctx), not (state, ctx)`);
    // Events, coverage, e.is and s.step name a step by its name alone, so an action does not share it.
    if (actions[name]) throw new Error(`${raw.name}: an action and a step are both named ${name}; give them different names`);
    if (on) {
      const fair = (stepsOn[on.key] ??= []).find((other) => transitions[other]!.fair !== false);
      // Several steps may take one message (RFD0012); left alone, it goes to the fair one, so there is one.
      if (fair && step.fair !== false) {
        const what = on.kind === "failure" ? `failed(${on.call.id})` : on.id;
        throw new Error(`${raw.name}: ${fair} and ${name} are both fair steps on ${what}; one message has at most one fair step, and the others say fair: false`);
      }
      stepsOn[on.key]!.push(name);
    }
    transitions[name] = {
      key: name,
      message: on?.key,
      description: step.description,
      sources: step.sources ?? [],
      sends: keysOf(step.sends, where),
      starts: step.starts ?? [],
      when: scope(step.when),
      after: step.after,
      ...fairnessOf(where, step.fair),
      say: scope(step.say),
      routine: step.routine ?? false,
      run: scope(step.run) as TransitionInfo["run"],
    };
  }
  const links = raw.links
    ? scope((state: unknown, self: { id: string; label: string }) =>
        (raw.links!(state as never, self) ?? []).map((l) => (typeof l.to === "string" ? l : { ...l, to: (l.to as Actor).name })) as Link[],
      )
    : undefined;
  return {
    name: raw.name,
    description: raw.description,
    zone: raw.zone.name,
    singleton: raw.singleton ?? false,
    initialState: scope(raw.initialState) as ActorInfo["initialState"],
    durable: (raw.durable as string[] | undefined) ?? [],
    symmetric: raw.symmetric === true,
    display,
    place: raw.place ?? {},
    links,
    actions,
    transitions,
    stepsOn,
  };
}

function inputInfo(where: string, name: string, value: unknown): InputInfo {
  const def = (value as InputDef)?.type !== undefined && typeof value === "object" && !isSchemaShaped(value) ? (value as InputDef) : undefined;
  const type = (def ? def.type : value) as InputType;
  const shaped = type as Shaped<unknown> & { values?: unknown[] };
  if (type !== String && type !== Number && type !== Boolean && shaped?.schema !== "oneOf")
    throw new Error(`${where}: input ${name} is String, Number, Boolean, oneOf(…), or input(type, { examples })`);
  return {
    type: type === String ? "string" : type === Number ? "number" : type === Boolean ? "boolean" : "choice",
    values: shaped?.schema === "oneOf" ? ([...shaped.values!] as string[]) : undefined,
    examples: examplesOf(def?.examples),
    accepts: def?.accepts,
  };
}

function isSchemaShaped(value: unknown): boolean {
  return typeof (value as { schema?: unknown })?.schema === "string";
}

function examplesOf(examples: unknown): InputInfo["examples"] {
  if (typeof examples === "function") return examples as never;
  if (Array.isArray(examples)) return () => [...examples];
  return undefined;
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
  const base = { id, description: def.description, ...(def.known === undefined ? {} : { known: def.known }), ...(def.needs?.length ? { needs: def.needs.map((r) => r.name) } : {}) };
  if ("always" in def) return { ...base, kind: "always", always: predicate(def.always, "always") };
  if ("everyStep" in def) return { ...base, kind: "everyStep", everyStep: predicate(def.everyStep, "everyStep") };
  if ("never" in def) return { ...base, kind: "never", never: predicate(def.never, "never") };
  if ("eventually" in def) return { ...base, kind: "eventually", eventually: predicate(def.eventually, "eventually") };
  if ("leadsTo" in def) return { ...base, kind: "leadsTo", whenever: predicate(def.leadsTo?.whenever, "leadsTo.whenever"), then: predicate(def.leadsTo?.then, "leadsTo.then") };
  if ("infinitelyOften" in def) return { ...base, kind: "infinitelyOften", infinitelyOften: predicate(def.infinitelyOften, "infinitelyOften") };
  return { ...base, kind: "eventuallyAlways", eventuallyAlways: predicate(def.eventuallyAlways, "eventuallyAlways") };
}
