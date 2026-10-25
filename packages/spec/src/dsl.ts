// The spec DSL: what a spec file writes. Types follow RFD0002 and the typing prototype in
// prototypes/spec-typing; defineSpec turns the declarations into a Spec the engine runs.
import type {
  ActionInfo,
  ActorInfo,
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

type StateOf<X> = X extends Actor<infer S, any> ? S : never;
type ActionsOf<X> = X extends Actor<any, infer A> ? A : never;

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
  /** This instance's id and label. */
  readonly id: string;
  readonly label: string;
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
  /** In everyday words, what the step does. */
  description: string;
  sources: Source[];
  sends?: Sends[];
  starts?: Starts[];
}

export interface MessageTransition<M extends Registry, S, P, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  run(state: S, msg: P, ctx: ReplyCtx<M, Sends, Starts>): void;
}

export interface InternalTransition<M extends Registry, S, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  /** When set, the transition can run whenever this holds, not only as a timer. */
  when?: (state: Readonly<S>) => boolean;
  run(state: S, ctx: Ctx<M, Sends, Starts>): void;
}

// Inputs --------------------------------------------------------------------------------------------

export type InputType = StringConstructor | NumberConstructor | BooleanConstructor | readonly string[];

declare const INPUT: unique symbol;

/** Made by `spec.defineInput`; the brand keeps plain objects from claiming `examples`. */
export interface InputDef<T = InputType> {
  readonly [INPUT]: true;
  type: T;
  examples?: (world: World) => ValueOf<T>[];
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

type InputsOf<I> = { [K in keyof I]: ValueOf<I[K]> };

export interface ActionDef<M extends Registry, S, I, Sends extends MessageKey<M> = never, Starts extends string = never>
  extends StepFields<M, Sends, Starts> {
  /** The button: "Paste a pairing code". */
  label: string;
  /** Plain `{ type }`, or `spec.defineInput(type, { examples })` for examples. */
  inputs?: { [K in keyof I]: { type: I[K]; examples?: "use spec.defineInput(type, { examples }) to give examples" } | InputDef<I[K]> };
  /** When set, the action is offered only while this holds. */
  when?: (state: Readonly<S>) => boolean;
  run(state: S, inputs: InputsOf<I>, ctx: Ctx<M, Sends, Starts>): void;
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
  initialState: (ctx: { id: string; label: string }) => S;
  /** State that survives a restart; everything else returns to its initial value. */
  durable?: (keyof S & string)[];
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
      /** Once `after` holds (always, by default), this holds within `within` events of the system running by itself. */
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
  /** Take an action that has no inputs. */
  act<S, A>(who: Instance<S, A>, action: ActionsWithoutInputs<A>): void;
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
  defineZone(def: { name: string; description?: string }): Zone;
  defineLimit(def: { name: string; value: number; unit?: string; sources: Source[] }): Limit;
  defineActor<S, A = {}, T = {}>(def: ActorDef<M, S, A, T>): Actor<S, A>;
  /** An action input: its type, and the example values the playground offers and the checker tries. */
  defineInput<const T extends InputType>(type: T, options?: { examples?: (world: World) => ValueOf<T>[] }): InputDef<T>;
  defineInvariants(defs: Record<string, InvariantDef>): void;
  defineScenario(def: { name: string; description?: string; run(script: Script): void }): void;
}

export interface SpecOptions<M extends Registry> {
  messages: M;
  /** What the spec explains, in a sentence. */
  description?: string;
  /** Default message latency in milliseconds (50). */
  latency?: number;
}

export function defineSpec<M extends Registry>(name: string, options: SpecOptions<M>, body: (spec: SpecBuilder<M>) => void): Spec {
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
  };
  const builder: SpecBuilder<M> = {
    messages: Object.fromEntries(Object.keys(options.messages).map((id) => [id, `message:${id}`])) as SpecBuilder<M>["messages"],
    defineZone(def) {
      const zone: ZoneInfo = { name: def.name, description: def.description };
      spec.zones.push(zone);
      return zone;
    },
    defineLimit(def) {
      const limit: LimitInfo = { name: def.name, value: def.value, unit: def.unit, sources: def.sources };
      spec.limits.push(limit);
      return limit;
    },
    defineActor(def) {
      const actor = actorInfo(spec, def as unknown as RawActor);
      spec.actors.push(actor);
      return actor as unknown as Actor<any, any>;
    },
    defineInput(type, options) {
      return { type, examples: options?.examples } as never;
    },
    defineInvariants(defs) {
      for (const [id, def] of Object.entries(defs)) spec.invariants.push(invariantInfo(id, def));
    },
    defineScenario(def) {
      const scenario: ScenarioInfo = { name: def.name, description: def.description, run: def.run as ScenarioInfo["run"] };
      spec.scenarios.push(scenario);
    },
  };
  body(builder);
  return spec;
}

// From declarations to the spec the engine runs ---------------------------------------------------------

interface RawStep {
  description: string;
  sources: string[];
  sends?: string[];
  starts?: string[];
  when?: (state: unknown) => boolean;
  run: (...args: never[]) => void;
}

interface RawActor {
  name: string;
  description?: string;
  zone: ZoneInfo;
  singleton?: boolean;
  initialState: ActorInfo["initialState"];
  durable?: string[];
  actions?: Record<string, RawStep & { label: string; inputs?: Record<string, { type: InputType; examples?: unknown }> }>;
  transitions?: Record<string, RawStep>;
}

function actorInfo(spec: Spec, raw: RawActor): ActorInfo {
  if (spec.actors.some((actor) => actor.name === raw.name)) throw new Error(`Two actors are named "${raw.name}"`);
  const actions: Record<string, ActionInfo> = {};
  for (const [key, step] of Object.entries(raw.actions ?? {})) {
    actions[key] = {
      key,
      label: step.label,
      description: step.description,
      sources: step.sources,
      sends: step.sends ?? [],
      starts: step.starts ?? [],
      when: step.when,
      inputs: Object.fromEntries(
        Object.entries(step.inputs ?? {}).map(([name, input]) => [
          name,
          { type: inputKind(input.type), values: Array.isArray(input.type) ? [...input.type] : undefined, examples: typeof input.examples === "function" ? (input.examples as never) : undefined },
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
      sources: step.sources,
      sends: step.sends ?? [],
      starts: step.starts ?? [],
      when: step.when,
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
    actions,
    transitions,
  };
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
