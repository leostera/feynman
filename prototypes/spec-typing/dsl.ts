// A typing prototype for RFD0002: can TypeScript infer `state`, `msg`, and `inputs` in
// the DSL the RFD proposes, and reject the mistakes an agent is likely to make?
// Runtime behaviour is stubbed; only the types matter here.

export const SEC = 1000;
export const MIN = 60 * SEC;

// Sources: `path#symbol` or `path:start-end`.
export type Source = `${string}#${string}` | `${string}:${number}-${number}`;

export type Tone = "request" | "reply" | "refused" | "stream";

// Messages ----------------------------------------------------------------------------

/** A message kind and its payload type. Declared in the spec's `messages`. */
export interface MessageDef<P> {
  name: string;
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

// Instances and the world ---------------------------------------------------------------

export interface Actor<S, A> {
  readonly name: string;
  /** Phantoms. */
  readonly state?: S;
  readonly actions?: A;
}

type StateOf<X> = X extends Actor<infer S, any> ? S : never;
type ActionsOf<X> = X extends Actor<any, infer A> ? A : never;

export interface Instance<S, A> {
  readonly id: string;
  readonly label: string;
  readonly state: Readonly<S>;
  /** Phantom. */
  readonly actions?: A;
}

export interface World {
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
}

// What a step can do --------------------------------------------------------------------

interface Ctx<M extends Registry, Sends extends MessageKey<M>, Starts extends string> {
  readonly id: string;
  readonly label: string;
  readonly now: number;
  the<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>;
  all<X extends Actor<any, any>>(actor: X): Instance<StateOf<X>, ActionsOf<X>>[];
  send<K extends Sends>(to: Instance<any, any>, key: K, payload: PayloadOf<M, K>, text?: string): void;
  start(label: Starts, after: number): void;
  cancel(label: string): void;
  fresh(prefix: string): string;
  hash(value: string): string;
  random(): number;
}

/** In a message transition, `reply` answers the sender. */
interface ReplyCtx<M extends Registry, Sends extends MessageKey<M>, Starts extends string> extends Ctx<M, Sends, Starts> {
  reply<K extends Sends>(key: K, payload: PayloadOf<M, K>, text?: string): void;
}

// Transitions and actions -----------------------------------------------------------------

interface StepFields<M extends Registry, Sends extends MessageKey<M>, Starts extends string> {
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
  when?: (state: Readonly<S>) => boolean;
  run(state: S, ctx: Ctx<M, Sends, Starts>): void;
}

// Inputs ------------------------------------------------------------------------------------

type InputType = StringConstructor | NumberConstructor | BooleanConstructor | readonly string[];

declare const INPUT: unique symbol;

/** Made by `spec.defineInput`; the brand keeps plain objects from claiming `examples`. */
export interface InputDef<T = InputType> {
  readonly [INPUT]: true;
  type: T;
  /** Only `type` decides the input's type; examples are checked against it. */
  examples?: (world: World) => NoInfer<ValueOf<T>>[];
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
  label: string;
  /** `I` maps each input to its type: `{ code: StringConstructor }`. */
  /** Plain `{ type }`, or `spec.defineInput(type, { examples })` for examples. */
  inputs?: { [K in keyof I]: { type: I[K]; examples?: "use spec.defineInput(type, { examples }) to give examples" } | InputDef<I[K]> };
  run(state: S, inputs: InputsOf<I>, ctx: Ctx<M, Sends, Starts>): void;
}

// Actors ------------------------------------------------------------------------------------

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
  zone: Zone;
  singleton?: boolean;
  initialState: (ctx: { id: string; label: string }) => S;
  actions?: ActionsFor<M, NoInfer<S>, A>;
  transitions?: TransitionsFor<M, NoInfer<S>, T>;
}

// Invariants and scenarios -------------------------------------------------------------------

export interface Trace {
  count(predicate: (event: Event) => boolean): number;
}

export interface Event {
  is(actor: Actor<any, any>, key: string): boolean;
  replied(key: string): boolean;
}

type InvariantDef =
  | { description: string; always: (world: World) => boolean }
  | { description: string; eventually: (world: World) => boolean; within: number }
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
  settle(): void;
}

// The spec ------------------------------------------------------------------------------------

export interface Spec<M extends Registry> {
  readonly messages: { [N in keyof M & string]: `message:${N}` };
  defineZone(def: { name: string }): Zone;
  defineLimit(def: { name: string; value: number; sources: Source[] }): Limit;
  defineActor<S, A = {}, T = {}>(def: ActorDef<M, S, A, T>): Actor<S, A>;
  /** An action input: its type, and the example values the playground offers and the checker tries. */
  defineInput<const T extends InputType>(type: T, options?: { examples?: (world: World) => ValueOf<T>[] }): InputDef<T>;
  defineInvariants(defs: Record<string, InvariantDef>): void;
  defineScenario(def: { name: string; run(script: Script): void }): void;
}

export interface SpecModule {
  readonly name: string;
}

export function defineSpec<M extends Registry>(
  name: string,
  def: { messages: M },
  body: (spec: Spec<M>) => void,
): SpecModule {
  const keys = Object.fromEntries(Object.keys(def.messages).map((n) => [n, `message:${n}`]));
  const identity = <T>(value: T) => value;
  const spec = {
    messages: keys,
    defineZone: identity,
    defineLimit: identity,
    defineActor: identity,
    defineInput: (type: unknown, options?: object) => ({ type, ...options }),
    defineInvariants: () => {},
    defineScenario: () => {},
  } as unknown as Spec<M>;
  body(spec);
  return { name };
}
