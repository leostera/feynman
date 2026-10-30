// What a spec is at runtime, and what the engine produces: plain data that views, the
// checker, and diffs read. Functions (initial state, run, predicates) are the only code.
import type { Fields } from "./schema.ts";
import type { ActorPlace, Icon, Link, Display, Script, Setup, Shape, Trace, TraceEvent, World as WorldView, ZonePlace } from "./dsl.ts";

export interface Spec {
  name: string;
  description?: string;
  /** By key: `message:Redeem`. */
  messages: Record<string, MessageInfo>;
  zones: ZoneInfo[];
  limits: LimitInfo[];
  actors: ActorInfo[];
  properties: PropertyInfo[];
  /** The worlds where the system may stop; any other world where nothing can happen is stuck. */
  finalState?: { description: string; when: (world: WorldView) => boolean };
  scenarios: ScenarioInfo[];
  /** Actors shown as one thing, at a higher level of abstraction. */
  groups: GroupInfo[];
  /** The rules of the design (RFD0010). */
  rules: RuleInfo[];
  /** The rules turned off in this spec, by name: it is a variant of the design without them. */
  without: string[];
  /** The same design without these rules too, assembled again from the spec's parts. */
  withoutRules(names: string[]): Spec;
}

export interface GroupInfo {
  name: string;
  description?: string;
  icon?: Icon;
  shape?: Shape;
  collapsed: boolean;
  names?: string[];
  /**
   * Its actors. With a suffix, instances group by label: "Studio app" (suffix "app") joins
   * "Studio". Without, the actor is a singleton and the group is one node.
   */
  members: { actor: string; suffix: string | null }[];
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
  /**
   * A call (RFD0009): losing it, or the reply to it, gives the caller its failure, delivered
   * as `failed:<key>`, instead of silence.
   */
  call: boolean;
  /** Its payload's schema (RFD0011): every payload sent is checked against it. */
  schema: Fields;
}

export interface ZoneInfo {
  name: string;
  description?: string;
  place: ZonePlace;
}

export interface LimitInfo {
  name: string;
  value: number;
  unit?: string;
  sources: string[];
}

export interface StepInfo {
  /** What the engine keys it by: the message for a step on one (`message:Charge`), else its name. */
  key: string;
  /** Its name in the spec: `charge`, `retry`, `pay`. */
  name: string;
  description: string;
  /** The sentence for one event, from the state after it and the step's payload. */
  say?: (state: unknown, payload: unknown) => string;
  /** Housekeeping, such as a heartbeat, that views fold away. */
  routine: boolean;
  sources: string[];
  sends: string[];
  starts: string[];
  when?: (state: unknown) => boolean;
  /**
   * Fairness (RFD0006): whether this transition, once it stays (weak) or keeps coming back
   * (strong) possible, must eventually happen. Deliveries, timers and guards are weak unless
   * they say otherwise; actions are never fair.
   */
  fair?: Fairness | false;
  /** For a timer, when the code fires it, in words; it does not change when it can fire. */
  after?: string;
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
  /** The message key, for a step on a message or a call's failure; otherwise a timer or a guard. */
  message?: string;
  /** For a timer or a guard, `received` is undefined. */
  run: (state: any, received: any, ctx: any) => void;
}

export interface ActorInfo {
  name: string;
  description?: string;
  zone: string;
  singleton: boolean;
  initialState: (ctx: { id: string; label: string }) => unknown;
  durable: string[];
  /** Its instances are interchangeable (see `defineActor({ symmetric })`). */
  symmetric: boolean;
  display: Display<unknown>;
  place: ActorPlace;
  links?: (state: unknown, self: { id: string; label: string }) => Link[];
  actions: Record<string, ActionInfo>;
  transitions: Record<string, TransitionInfo>;
}

/**
 * How fair a step is (RFD0006): weakly, it must happen once it stays possible; strongly, once
 * it keeps becoming possible, even if not for good.
 */
export type Fairness = "weak" | "strong";

/** A property, as the engine and checker read it (see `PropertyDef` in dsl.ts). */
export type PropertyInfo = (
  | { kind: "always"; always: (world: WorldView) => boolean }
  | { kind: "everyStep"; everyStep: (before: WorldView, after: WorldView, event: TraceEvent) => boolean }
  | { kind: "never"; never: (trace: Trace) => boolean }
  | { kind: "eventually"; eventually: (world: WorldView) => boolean }
  | { kind: "leadsTo"; whenever: (world: WorldView) => boolean; then: (world: WorldView) => boolean }
  | { kind: "infinitelyOften"; infinitelyOften: (world: WorldView) => boolean }
  | { kind: "eventuallyAlways"; eventuallyAlways: (world: WorldView) => boolean }
) & {
  id: string;
  description: string;
  /** A known bug: why the property is expected to break (see `PropertyDef.known`). */
  known?: string;
  /** The rules it needs, by name: without any of them, it should break (RFD0010). */
  needs?: string[];
};

/** A rule of the design: a part that exists to keep properties true (RFD0010). */
export interface RuleInfo {
  name: string;
  description: string;
  /** The properties that need it, by id. */
  neededBy: string[];
}

/** The liveness kinds: judged on fair infinite behaviours, after exploring (RFD0006). */
export const LIVENESS_KINDS = ["eventually", "leadsTo", "infinitelyOften", "eventuallyAlways"] as const;

/** A liveness property: judged on fair infinite behaviours. */
export type LivenessProperty = Extract<PropertyInfo, { kind: (typeof LIVENESS_KINDS)[number] }>;

export function isLiveness(p: PropertyInfo): p is LivenessProperty {
  return (LIVENESS_KINDS as readonly string[]).includes(p.kind);
}

export interface ScenarioInfo {
  name: string;
  description?: string;
  /** The world the scenario starts in, when not the spec's start. */
  setup?: (setup: Setup) => void;
  run: (script: Script) => void;
}

// The world ----------------------------------------------------------------------------------------

/**
 * Everything the engine knows at one moment. Plain data: it serializes, hashes, and copies.
 * There is no clock: what can happen next is anything pending, in any order (RFD0004).
 */
export interface World {
  /** Counter for pending ids and events: the order things were created in. */
  seq: number;
  /** Counters for `ctx.fresh`, by prefix. */
  fresh: Record<string, number>;
  /** State of the seeded random generator. */
  rng: number;
  instances: InstanceState[];
  /** Messages in flight and timers set, in the order they were created (by `id`). */
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
      to: string;
      from: string;
      message: string;
      payload: unknown;
      text?: string;
      /** For a reply to a call (RFD0009): the call it answers, whose failure losing it gives. */
      answers?: { message: string; payload: unknown };
    }
  | {
      id: number;
      kind: "timer";
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
  text?: string;
}

/** One step of the world, with everything views and the checker need to explain it. */
export interface Event {
  /** Its place in the world's history: what came before it has a smaller index. */
  index: number;
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
  started: { timer: string }[];
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

export type { Script, Setup, Trace, TraceEvent, WorldView };
