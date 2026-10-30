// Faults as a library (RFD0012). The core has no faults: a message is lost because a step on it
// at its receiver drops it, an instance restarts because a step resets it, and a budget is a
// model variable that a step spends. Each factory here returns an ordinary step definition (or
// a message, for defineCall), which a spec could write itself; faults are tagged `fault`, which
// reports read and the core never does.
// Imported from the parts, not the entry, which exports this library too.
import { defineMessage, defineVariable, stepVariable, type AnyMessage, type Ctx, type Delivery, type Message, type ModelView, type Part, type PayloadOf, type ReplyCtx, type Variable } from "../spec/dsl.ts";
import type { Fields, TypeOf } from "../spec/schema.ts";

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

/** Each call's failure, by the call itself: two specs may each have a message named Charge. */
const failures = new WeakMap<object, Message<string, unknown>>();
/** The keys failures have (`message:Charge.failed`): only this library makes keys with `.failed`. */
const failureKeys = new Set<string>();

/**
 * A call (RFD0009), as a message and its failure: `lose` on the call, or on its reply, sends
 * the caller `failed(Charge)`, as an RPC or a `fetch` throws. Its replies carry the request
 * they answer, so a lost reply knows which call it fails.
 */
export function defineCall<const Id extends string, F extends Fields = {}>(id: Id, schema?: F, options?: { name?: string; over?: string }): Call<Id, TypeOf<F>> {
  const call = defineMessage(id, schema, { ...options, correlate: true });
  const failure = defineMessage(`${id}.failed`, { payload: (schema ?? {}) as F, to: { id: String } }, { name: `${call.name} failed`, tone: "refused" });
  failures.set(call, failure as Message<string, unknown>);
  failureKeys.add(failure.key);
  return call as Call<Id, TypeOf<F>>;
}

/** The failure of a call from `defineCall`: what the caller's step is `on`. */
export function failed<Id extends string, P>(call: Call<Id, P>): Failed<Id, P> {
  const failure = call && typeof call === "object" ? failures.get(call) : undefined;
  if (!failure) {
    const what = call && typeof call === "object" && "name" in call ? `${call.name} is a message` : `${String(call)} is not a message`;
    throw new Error(`failed(${call?.id ?? String(call)}): ${what}, not a call; define it with defineCall from the faults library`);
  }
  return failure as unknown as Failed<Id, P>;
}

/** Whether a message key is a call's failure, which happens in the caller's own process. */
function isFailure(key: string): boolean {
  return failureKeys.has(key);
}

// Budgets ---------------------------------------------------------------------------------------------

/** A budget: a model variable a fault spends. `--set faults=2` raises it. */
export type Budget = Variable<number>;

/** `budget("faults", 1)`: at most one fault on any path, across every step that spends it. */
export function budget(name: string, n: number): Budget {
  if (!Number.isInteger(n) || n < 0) throw new Error(`budget("${name}", …) takes a whole number, not ${n}`);
  return defineVariable(name, n);
}

/** A part that spends a budget: the step is possible only while it is above zero, and takes one. */
export function spend(budget: Budget): Part {
  return {
    uses: [budget],
    when: (model) => model.get(budget) > 0,
    run: (ctx) => ctx.set(budget, ctx.get(budget) - 1),
  };
}

/**
 * A part bounding a step to at most `limit` times per instance on any path: an action a person
 * might take forever, bounded for the checker as TLA+ bounds it with a counter. Each instance
 * counts its own, in a model variable named after the step (`Client.pay`). The limit is a
 * number, or a variable several steps share, so `--set repeats=3` raises them all.
 */
export function atMost(limit: number | Variable<number>): Part {
  if (typeof limit === "number" && (!Number.isInteger(limit) || limit < 0)) throw new Error(`atMost(limit) takes a whole number, not ${limit}`);
  const taken = stepVariable(0, { each: true });
  const most = (model: ModelView) => (typeof limit === "number" ? limit : model.get(limit));
  return {
    uses: typeof limit === "number" ? [taken] : [taken, limit],
    when: (model) => model.get(taken) < most(model),
    run: (ctx) => ctx.set(taken, ctx.get(taken) + 1),
  };
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
  with: readonly Part[];
  sends?: readonly AnyMessage[];
  when?: (state: any, model: ModelView) => boolean;
  description: string;
  run(state: any, received: any, ctx: any): void;
}

function fault<On>(step: Omit<FaultStep<On>, "fair" | "tags" | "with">, budget: Budget | undefined): FaultStep<On> {
  return { ...step, fair: false, tags: [FAULT], with: budget ? [spend(budget)] : [] };
}

/**
 * The receiver loses `message` on the way: a step on it that does nothing with it. For a call,
 * the caller's call fails; for a reply, pass `fails` with the call it answers (or the calls it
 * may answer), and the caller's call fails when the reply is lost: the callee did the work, and
 * the caller cannot tell.
 */
export function lose<M extends AnyMessage>(message: M, options?: FaultOptions & { fails?: Call<string, any> | readonly Call<string, any>[] }): FaultStep<M> {
  const failure = message && typeof message === "object" ? failures.get(message) : undefined;
  const calls = options?.fails === undefined ? [] : Array.isArray(options.fails) ? options.fails : [options.fails as Call<string, any>];
  const failing = new Map(calls.map((call) => [call.key as string, failed(call) as unknown as Message<string, unknown>]));
  const sends = [...(failure ? [failure] : []), ...failing.values()];
  return fault<M>(
    {
      on: message,
      sends,
      description: options?.description ?? `${capital(message.name)} is lost on the way.`,
      run(_state: unknown, payload: PayloadOf<M>, ctx: ReplyCtx) {
        if (failure) ctx.send(ctx.from, failure, { payload, to: { id: ctx.id } });
        const answers = ctx.delivery.answers;
        const fails = answers && failing.get(answers.message);
        // The failure reaches the caller from the callee, as one from a lost call does.
        if (fails) ctx.forward({ message: fails, payload: { payload: answers.payload, to: { id: ctx.from.id } } });
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
