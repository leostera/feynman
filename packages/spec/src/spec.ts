// What a spec is at runtime, and what the engine produces: plain data that views, the
// checker, and diffs read. Functions (initial state, run, predicates) are the only code.
import type { Link, Look, Script, Trace, TraceEvent, World as WorldView } from "./dsl.ts";

export interface Spec {
  name: string;
  description?: string;
  /** Default message latency, in milliseconds. */
  latency: number;
  /** By key: `message:Redeem`. */
  messages: Record<string, MessageInfo>;
  zones: ZoneInfo[];
  limits: LimitInfo[];
  actors: ActorInfo[];
  invariants: InvariantInfo[];
  scenarios: ScenarioInfo[];
}

export interface MessageInfo {
  /** `message:Redeem`. */
  key: string;
  /** `Redeem`. */
  id: string;
  /** In everyday words: "redeem". */
  name: string;
  over?: string;
  tone: "request" | "reply" | "refused" | "stream";
  latency?: number;
}

export interface ZoneInfo {
  name: string;
  description?: string;
}

export interface LimitInfo {
  name: string;
  value: number;
  unit?: string;
  sources: string[];
}

export interface StepInfo {
  key: string;
  description: string;
  /** The sentence for one event, from the state after it and the step's payload. */
  say?: (state: unknown, payload: unknown) => string;
  /** Housekeeping, such as a heartbeat, that views fold away. */
  routine: boolean;
  sources: string[];
  sends: string[];
  starts: string[];
  when?: (state: unknown) => boolean;
}

export interface InputInfo {
  type: "string" | "number" | "boolean" | "choice";
  /** For `choice`. */
  values?: string[];
  examples?: (world: WorldView) => unknown[];
  /** A token kind that can be dropped on the node to fill this input. */
  accepts?: string;
}

export interface ActionInfo extends StepInfo {
  label: string;
  inputs: Record<string, InputInfo>;
  run: (state: any, inputs: any, ctx: any) => void;
}

export interface TransitionInfo extends StepInfo {
  /** The message key, for a transition keyed by a message; otherwise internal. */
  message?: string;
  run: (state: any, msgOrCtx: any, ctx?: any) => void;
}

export interface ActorInfo {
  name: string;
  description?: string;
  zone: string;
  singleton: boolean;
  initialState: (ctx: { id: string; label: string }) => unknown;
  durable: string[];
  look: Look<unknown>;
  links?: (state: unknown, self: { id: string; label: string }) => Link[];
  actions: Record<string, ActionInfo>;
  transitions: Record<string, TransitionInfo>;
}

export type InvariantInfo =
  | { id: string; description: string; kind: "always"; always: (world: WorldView) => boolean }
  | {
      id: string;
      description: string;
      kind: "eventually";
      eventually: (world: WorldView) => boolean;
      after?: (world: WorldView) => boolean;
      within: number;
    }
  | { id: string; description: string; kind: "never"; never: (trace: Trace) => boolean };

export interface ScenarioInfo {
  name: string;
  description?: string;
  run: (script: Script) => void;
}

// The world ----------------------------------------------------------------------------------------

/** Everything the engine knows at one moment. Plain data: it serializes, hashes, and copies. */
export interface World {
  /** Simulated time, in milliseconds. */
  clock: number;
  /** Counter for pending ids and events. */
  seq: number;
  /** Counters for `ctx.fresh`, by prefix. */
  fresh: Record<string, number>;
  /** State of the seeded random generator. */
  rng: number;
  instances: InstanceState[];
  pending: Pending[];
}

export interface InstanceState {
  id: string;
  actor: string;
  label: string;
  state: unknown;
}

export type Pending =
  | {
      id: number;
      kind: "deliver";
      at: number;
      to: string;
      from: string;
      message: string;
      payload: unknown;
      text?: string;
    }
  | {
      id: number;
      kind: "timer";
      at: number;
      to: string;
      timer: string;
    };

// Events -------------------------------------------------------------------------------------------

export type EventKind = "spawn" | "action" | "deliver" | "timer" | "guard" | "lose" | "restart";

export interface Change {
  instance: string;
  /** `link.pending`, `codes["hash:1k2"].used`. */
  path: string;
  before: unknown;
  after: unknown;
}

export interface Sent {
  id: number;
  to: string;
  message: string;
  payload: unknown;
  at: number;
  text?: string;
}

/** One step of the world, with everything views and the checker need to explain it. */
export interface Event {
  index: number;
  at: number;
  kind: EventKind;
  /** The instance that took the step. */
  instance: string;
  actor: string;
  /** The action or transition key: `link`, `message:Redeem`, `redeemTimeout`. */
  key: string;
  description: string;
  sources: string[];
  inputs?: Record<string, unknown>;
  /** For deliveries: the message, its payload, and who sent it. */
  message?: string;
  payload?: unknown;
  from?: string;
  changes: Change[];
  sent: Sent[];
  started: { timer: string; at: number }[];
  cancelled: string[];
  /** Notes and send texts, in everyday words. */
  notes: string[];
  /** What happened this time, in a sentence, from the step's `say`. */
  text?: string;
  /** Whether the step is housekeeping (`routine`), which views fold away. */
  routine?: boolean;
  /** A spec bug at this step, such as an undeclared send; the step's effects are discarded. */
  error?: string;
  /** Invariants (`always`) that do not hold after this event. */
  violations: string[];
}

/** A run: the world before, every event, and the world after each. */
export interface Run {
  spec: string;
  seed: number;
  initial: World;
  events: Event[];
  worlds: World[];
}

export type { Script, Trace, TraceEvent, WorldView };
