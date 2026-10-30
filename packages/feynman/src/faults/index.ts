// Faults as a library (RFD0012). The core has no faults: a message is lost because a step on it
// at its receiver drops it, an instance restarts because a step resets it, and a budget is a
// model variable that a step spends. Each factory here returns an ordinary step definition (or
// a message, for defineCall), which a spec could write itself; faults are tagged `fault`, which
// reports read and the core never does.
import { defineMessage, defineVariable, type AnyMessage, type Ctx, type Delivery, type Fields, type Message, type ModelView, type PayloadOf, type ReplyCtx, type TypeOf, type Variable } from "../spec/index.ts";
import { stepVariable } from "../spec/dsl.ts";

/** What reports count: a step tagged `fault` is one. */
export const FAULT = "fault";

// Calls ---------------------------------------------------------------------------------------------

/** What a call's failure carries: the payload of the call that failed, and whom it was to. */
export interface Failure<P> {
  readonly payload: P;
  readonly to: { readonly id: string };
}

/** A call: a message whose loss, or its reply's, reaches the caller as `failed(call)`. */
export interface Call<Id extends string = string, P = unknown> extends Message<Id, P> {
  /** Phantom: marks a call, so `failed` takes only calls. */
  readonly __call?: true;
}

/** A call's failure: a plain message, `Charge.failed`, the caller has a step on. */
export type Failed<Id extends string, P> = Message<`${Id}.failed`, Failure<P>>;

const failures = new Map<string, Message<string, unknown>>();

/**
 * A call (RFD0009), as a message and its failure: `lose` on the call, or on its reply, sends
 * the caller `failed(Charge)`, as an RPC or a `fetch` throws. Its replies carry the request
 * they answer, so a lost reply knows which call it fails.
 */
export function defineCall<const Id extends string, F extends Fields = {}>(id: Id, schema?: F, options?: { name?: string; over?: string }): Call<Id, TypeOf<F>> {
  const call = defineMessage(id, schema, { ...options, correlate: true });
  const failure = defineMessage(`${id}.failed`, { payload: (schema ?? {}) as F, to: { id: String } }, { name: `${call.name} failed`, tone: "refused" });
  failures.set(call.key, failure as Message<string, unknown>);
  return call as Call<Id, TypeOf<F>>;
}

/** The failure of a call from `defineCall`: what the caller's step is `on`. */
export function failed<Id extends string, P>(call: Call<Id, P>): Failed<Id, P> {
  const failure = failures.get(call?.key);
  if (!failure) throw new Error(`failed(${call?.id ?? String(call)}): not a call; define it with defineCall from the faults library`);
  return failure as unknown as Failed<Id, P>;
}

/** Whether a message key is a call's failure, which happens in the caller's own process. */
function isFailure(key: string): boolean {
  return [...failures.values()].some((f) => f.key === key);
}

// Budgets ---------------------------------------------------------------------------------------------

/** A budget: a model variable a fault spends. `--set faults=2` raises it. */
export type Budget = Variable<number>;

/** `budget("faults", 1)`: at most one fault on any path, across every step that spends it. */
export function budget(name: string, n: number): Budget {
  if (!Number.isInteger(n) || n < 0) throw new Error(`budget("${name}", …) takes a whole number, not ${n}`);
  return defineVariable(name, n);
}

/** The parts of a step a bound wraps. */
interface Bounded<S> {
  when?: (state: Readonly<S>, model: ModelView) => boolean;
  uses?: readonly Variable<any>[];
  run(state: S, received: any, ctx: any): void;
}

/** A step that runs only while `variable` is above zero, taking one from it each time. */
export function spending<D extends Bounded<any>>(variable: Variable<number>, def: D): D {
  const { when, run } = def;
  return {
    ...def,
    uses: [...(def.uses ?? []), variable],
    when: (state: never, model: ModelView) => model.get(variable) > 0 && (when ? when(state, model) : true),
    run(state: never, received: never, ctx: Ctx) {
      ctx.set(variable, ctx.get(variable) - 1);
      run(state, received, ctx);
    },
  };
}

/**
 * At most `n` times per instance on any path: an action a person might take forever, bounded
 * for the checker as TLA+ bounds it with a counter. Its counter is a model variable named after
 * the step, `Client.pay`, which `--set Client.pay=3` changes.
 */
export function atMost<D extends Bounded<any>>(n: number, def: D): D {
  if (!Number.isInteger(n) || n < 0) throw new Error(`atMost(n, …) takes a whole number, not ${n}`);
  return spending(stepVariable(n, { each: true }), def);
}

// Faults ------------------------------------------------------------------------------------------------

interface FaultOptions {
  /** The budget it spends; without one, it may happen on every path, any number of times. */
  spend?: Budget;
  /** In everyday words, instead of the default. */
  description?: string;
}

/** What a fault step is: unfair (it may never happen), on a message or on nothing, tagged `fault`. */
interface FaultStep<On> {
  on?: On;
  fair: false;
  tags: readonly string[];
  uses?: readonly Variable<any>[];
  sends?: readonly AnyMessage[];
  when?: (state: any, model: ModelView) => boolean;
  description: string;
  run(state: any, received: any, ctx: any): void;
}

function fault<On>(step: Omit<FaultStep<On>, "fair" | "tags">, spend: Budget | undefined): FaultStep<On> {
  const out: FaultStep<On> = { ...step, fair: false, tags: [FAULT] };
  return spend ? spending(spend, out) : out;
}

/**
 * The receiver loses `message` on the way: a step on it that does nothing with it. For a call,
 * the caller's call fails; for a reply, pass `fails` with the call it answers, and the caller's
 * call fails when the reply is lost (the callee did the work, and the caller cannot tell).
 */
export function lose<M extends AnyMessage>(message: M, options?: FaultOptions & { fails?: Call<string, any> }): FaultStep<M> {
  const failure = failures.get(message?.key);
  const fails = options?.fails ? failed(options.fails) : undefined;
  const sends = [failure, fails].filter((m): m is Message<string, unknown> => m !== undefined);
  return fault<M>(
    {
      on: message,
      sends,
      description: options?.description ?? `${capital(message.name)} is lost on the way.`,
      run(_state: unknown, payload: PayloadOf<M>, ctx: ReplyCtx) {
        if (failure) ctx.send(ctx.from, failure, { payload, to: { id: ctx.id } });
        const answers = ctx.delivery.answers;
        // The failure reaches the caller from the callee, as one from a lost call does.
        if (fails && answers?.message === options!.fails!.key) ctx.forward({ message: fails, payload: { payload: answers.payload, to: { id: ctx.from.id } } });
      },
    },
    options?.spend,
  );
}

/** The network delivers `message` twice: a step on it that puts it back in flight twice. */
export function duplicate<M extends AnyMessage>(message: M, options?: FaultOptions): FaultStep<M> {
  return fault<M>(
    {
      on: message,
      description: options?.description ?? `${capital(message.name)} arrives twice.`,
      run(_state: unknown, _payload: unknown, ctx: ReplyCtx) {
        ctx.forward();
        ctx.forward();
      },
    },
    options?.spend,
  );
}

/**
 * The instance crashes and starts again: its state is its initial state but for the fields in
 * `keeps` (what it wrote to disk), its timers are gone, and so are the failures on their way
 * to it, which would have thrown in code that is no longer running.
 */
export function crash(options?: FaultOptions & { keeps?: readonly string[] }): FaultStep<undefined> {
  const keeps = options?.keeps ?? [];
  return fault<undefined>(
    {
      when: () => true,
      description: options?.description ?? (keeps.length ? `Crashes and restarts, keeping ${keeps.join(", ")}.` : "Crashes and restarts."),
      run(_state: unknown, _received: unknown, ctx: Ctx) {
        ctx.reset({ keeps, drops: (d: Delivery) => isFailure(d.message) });
      },
    },
    options?.spend,
  );
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
