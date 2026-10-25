// Types mirror skills/modelling/schema.json.

export type Confidence = "high" | "medium" | "low";

export interface Meta {
  system: string;
  summary: string;
  source: { repository: string; commit: string };
  extractedBy?: string;
  extraction: "bootstrap" | "update";
  coverage?: string;
}

export interface Actor {
  id: string;
  summary: string;
  transports?: string[];
  anchors: string[];
  confidence?: Confidence;
}

export interface MessageSet {
  actor: string;
  transport: string;
  summary?: string;
  accepts?: string[];
  emits?: string[];
  anchors: string[];
}

export interface Step {
  actor: string;
  action: string;
  target?: string;
  ref?: string;
  boundary?: string;
  properties?: string[];
}

export interface Flow {
  id: string;
  summary: string;
  trigger: string;
  steps: Step[];
  anchors: string[];
  confidence?: Confidence;
}

export interface State {
  id: string;
  owner: string;
  summary: string;
  lifetime: string;
  anchors: string[];
}

export interface StateMachine {
  id: string;
  summary?: string;
  states?: string[];
  transitions?: string[];
  anchors: string[];
}

export interface Boundary {
  id: string;
  summary: string;
  parsesInto?: string;
  effectsAfterParse?: boolean;
  anchors: string[];
}

export interface Invariant {
  id: string;
  statement: string;
  enforcedBy: string[];
  consequence?: string;
  anchors: string[];
}

export interface Contract {
  id: string;
  summary?: string;
  anchors: string[];
}

export interface Observability {
  id: string;
  summary?: string;
  flows?: string[];
  confidence?: Confidence;
  anchors: string[];
}

export interface Measurement {
  subject: string;
  value: string | number;
  kind: string;
  anchors: string[];
}

export type ClaimStatus = "supported" | "partially-supported" | "contradicted" | "unverified";

export interface Claim {
  statement: string;
  status: ClaimStatus;
  epistemic: "stated" | "inferred" | "measured";
  note?: string;
  evidence: string[];
}

export interface Model {
  meta: Meta;
  actors: Actor[];
  messages: MessageSet[];
  flows: Flow[];
  state: State[];
  stateMachines?: StateMachine[];
  boundaries?: Boundary[];
  invariants: Invariant[];
  contracts?: Contract[];
  observability?: Observability[];
  measurements?: Measurement[];
  claims: Claim[];
}

/** Element kinds that get their own card. */
export type Kind =
  | "overview"
  | "actor"
  | "flow"
  | "state"
  | "machine"
  | "boundary"
  | "invariant"
  | "contract"
  | "observability"
  | "claim"
  | "index";

/** A card address: `kind:id`, used in the URL fragment. */
export interface Address {
  kind: Kind;
  id: string;
}

export function formatAddress(address: Address): string {
  return `${address.kind}:${address.id}`;
}

export function parseAddress(raw: string): Address | null {
  const colon = raw.indexOf(":");
  if (colon <= 0) return null;
  return { kind: raw.slice(0, colon) as Kind, id: decodeURIComponent(raw.slice(colon + 1)) };
}

export function claimId(index: number): string {
  return `claim-${index + 1}`;
}

export interface Index {
  model: Model;
  actors: Map<string, Actor>;
  flows: Map<string, Flow>;
  state: Map<string, State>;
  machines: Map<string, StateMachine>;
  boundaries: Map<string, Boundary>;
  invariants: Map<string, Invariant>;
  contracts: Map<string, Contract>;
  observability: Map<string, Observability>;
  claims: Map<string, Claim>;
  /** The kind of element an id refers to, for resolving step refs. */
  kindOf: Map<string, Kind>;
  /** Flows that delegate to a flow through a step ref. */
  usedBy: Map<string, string[]>;
}

function byId<T extends { id: string }>(items: T[] | undefined): Map<string, T> {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

export function buildIndex(model: Model): Index {
  const index: Index = {
    model,
    actors: byId(model.actors),
    flows: byId(model.flows),
    state: byId(model.state),
    machines: byId(model.stateMachines),
    boundaries: byId(model.boundaries),
    invariants: byId(model.invariants),
    contracts: byId(model.contracts),
    observability: byId(model.observability),
    claims: new Map(model.claims.map((claim, i) => [claimId(i), claim])),
    kindOf: new Map(),
    usedBy: new Map(),
  };
  const kinds: [Kind, Map<string, unknown>][] = [
    ["actor", index.actors],
    ["flow", index.flows],
    ["state", index.state],
    ["machine", index.machines],
    ["boundary", index.boundaries],
    ["invariant", index.invariants],
    ["contract", index.contracts],
    ["observability", index.observability],
  ];
  for (const [kind, items] of kinds) for (const id of items.keys()) index.kindOf.set(id, kind);
  for (const flow of model.flows) {
    for (const step of flow.steps) {
      if (!step.ref) continue;
      const users = index.usedBy.get(step.ref) ?? [];
      if (!users.includes(flow.id)) users.push(flow.id);
      index.usedBy.set(step.ref, users);
    }
  }
  return index;
}

export function loadModel(): Model {
  const element = document.getElementById("feynman-model");
  if (!element?.textContent) throw new Error("No embedded model found");
  return JSON.parse(element.textContent) as Model;
}

/** Actors in the order they first take part in a flow. */
export function flowParticipants(flow: Flow): string[] {
  const seen: string[] = [];
  for (const step of flow.steps) {
    for (const actor of [step.actor, step.target]) {
      if (actor && !seen.includes(actor)) seen.push(actor);
    }
  }
  return seen;
}

/** Path part of an anchor (`path#symbol`). */
export function anchorPath(anchor: string): string {
  return anchor.split("#")[0];
}
