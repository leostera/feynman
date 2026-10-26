// A playground session: the world at the start, the steps taken since, and the operations
// that produced them, so a session survives reloads by replaying its operations against
// the (possibly edited) spec.
import { act, fire, guard, lose, pendingInOrder, restart, spawn, startWorld, emptyWorld, choices, type Event, type Run, type Spec, type World } from "../spec/index.ts";

/** What a person did in the playground; `at` is when, so time spent watching counts. */
export type Op = (
  | { op: "spawn"; actor: string; label: string }
  | { op: "act"; instance: string; key: string; inputs: Record<string, unknown> }
  | { op: "fire"; pending: number }
  | { op: "lose"; pending: number }
  | { op: "guard"; instance: string; key: string }
  | { op: "restart"; instance: string }
) & { at?: number };

export interface Step {
  event: Event | null;
  world: World;
}

export interface Session {
  initial: World;
  steps: Step[];
  /** Null for sessions loaded from a trace, which cannot be replayed as operations. */
  ops: Op[] | null;
  /** Where the session came from, for the timeline header. */
  origin: string;
}

export function freshSession(spec: Spec): Session {
  const steps = startWorld(spec);
  return { initial: steps.at(-1)?.world ?? emptyWorld(), steps: [], ops: [], origin: "Fresh start" };
}

export function sessionFromRun(run: Pick<Run, "initial" | "events" | "worlds">, origin: string): Session {
  return { initial: run.initial, steps: run.events.map((event, i) => ({ event, world: run.worlds[i] })), ops: null, origin };
}

export function current(session: Session): World {
  return session.steps.at(-1)?.world ?? session.initial;
}

/** Apply one operation; the engine records spec bugs on the event rather than throwing. */
export function apply(spec: Spec, session: Session, op: Op): Session {
  const now = current(session);
  // Whole milliseconds: time spent watching moves the clock, but never by fractions.
  const at = op.at === undefined ? undefined : Math.round(op.at);
  const world = at !== undefined && at > now.clock ? { ...now, clock: at } : now;
  const step = run(spec, world, op);
  return { ...session, steps: [...session.steps, step], ops: session.ops ? [...session.ops, op] : null };
}

function run(spec: Spec, world: World, op: Op): Step {
  switch (op.op) {
    case "spawn":
      return spawn(spec, world, op.actor, op.label);
    case "act":
      return act(spec, world, op.instance, op.key, op.inputs);
    case "fire":
      return fire(spec, world, op.pending);
    case "lose":
      return lose(spec, world, op.pending);
    case "guard":
      return guard(spec, world, op.instance, op.key);
    case "restart":
      return restart(spec, world, op.instance);
  }
}

/** Keep the first `count` steps: rolling back to a moment in the timeline. */
export function rollback(session: Session, count: number): Session {
  return { ...session, steps: session.steps.slice(0, count), ops: session.ops ? session.ops.slice(0, count) : null };
}

/** Replay a session's operations against a spec, stopping at the first that no longer applies. */
export function replay(spec: Spec, ops: Op[], origin: string): Session {
  let session: Session = { ...freshSession(spec), origin };
  for (const op of ops) {
    try {
      const next = apply(spec, session, op);
      if (next.steps.at(-1)?.event?.error) break;
      session = next;
    } catch {
      break;
    }
  }
  return session;
}

/** What to do next, in the order a person would: what is due, then what they can do. */
export type Hint =
  | { kind: "guard"; instance: string; key: string }
  | { kind: "pending"; pending: World["pending"][number] }
  | { kind: "spawn"; actor: string }
  | { kind: "act"; instance: string; key: string }
  | { kind: "done" };

export function nextHint(spec: Spec, world: World): Hint {
  const { guards, actions } = choices(spec, world);
  if (guards.length) return { kind: "guard", ...guards[0] };
  const [first] = pendingInOrder(world);
  if (first) return { kind: "pending", pending: first };
  const spawnable = spec.actors.filter((a) => !a.singleton);
  const missing = spawnable.find((a) => !world.instances.some((i) => i.actor === a.name) && Object.keys(a.actions).length);
  if (missing) return { kind: "spawn", actor: missing.name };
  if (actions.length) return { kind: "act", instance: actions[0].instance, key: actions[0].key };
  return { kind: "done" };
}

/** The next free label for a new instance of an actor: "Mac 2". */
export function nextLabel(world: World, actor: string): string {
  const taken = new Set(world.instances.map((i) => i.label));
  for (let n = 1; ; n++) {
    const label = n === 1 ? actor : `${actor} ${n}`;
    if (!taken.has(label)) return label;
  }
}

/** Run what is due until nothing is, or `limit` events. */
export function settle(spec: Spec, session: Session, limit = 200): Session {
  let s = session;
  for (let n = 0; n < limit; n++) {
    const hint = nextHint(spec, current(s));
    if (hint.kind === "guard") s = apply(spec, s, { op: "guard", instance: hint.instance, key: hint.key });
    else if (hint.kind === "pending") s = apply(spec, s, { op: "fire", pending: hint.pending.id });
    else break;
    if (s.steps.at(-1)?.event?.error) break;
  }
  return s;
}
