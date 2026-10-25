// Types mirror skills/modelling/schema.json.

export type Confidence = "high" | "medium" | "low";

export interface Source {
  repository: string;
  commit: string;
  url?: string;
  commitUrl?: string;
  /** URL template; `{path}` is replaced by an anchor path. */
  fileUrl?: string;
  committedAt?: string;
  main?: { ref: string; commit: string; ahead: number; behind: number; checkedAt: string };
  footprint?: { files?: number; lines?: number; excludes?: string[] };
}

export interface Meta {
  system: string;
  summary: string;
  source: Source;
  extractedAt?: string;
  extractedBy?: string;
  extraction: "bootstrap" | "update";
  coverage?: string;
}

export type Provenance = "first-party" | "third-party" | "ambient";

export interface Actor {
  id: string;
  provenance: Provenance;
  summary: string;
  footprint?: { paths: string[]; files?: number; lines?: number };
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
  about?: string[];
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

/** Element kinds that have their own page. */
export type Kind = "actor" | "flow" | "state" | "machine" | "boundary" | "invariant" | "contract" | "observability" | "claim";

/** URL segment for each kind's index and detail pages. */
export const SEGMENT: Record<Kind, string> = {
  actor: "actors",
  flow: "flows",
  state: "state",
  machine: "machines",
  boundary: "boundaries",
  invariant: "invariants",
  contract: "contracts",
  observability: "observability",
  claim: "claims",
};

export function href(kind: Kind, id?: string): string {
  return id === undefined ? `#/${SEGMENT[kind]}` : `#/${SEGMENT[kind]}/${encodeURIComponent(id)}`;
}

export function claimId(index: number): string {
  return `${index + 1}`;
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

export type FlowRole = "initiates" | "acts" | "receives";

/** How an actor takes part in a flow: starts it, performs steps in it, or only receives. */
export function roleIn(flow: Flow, actor: string): FlowRole | null {
  if (flow.steps[0]?.actor === actor) return "initiates";
  if (flow.steps.some((step) => step.actor === actor)) return "acts";
  if (flow.steps.some((step) => step.target === actor)) return "receives";
  return null;
}

export function claimsAbout(index: Index, id: string): { id: string; claim: Claim }[] {
  return index.model.claims
    .map((claim, i) => ({ id: claimId(i), claim }))
    .filter(({ claim }) => claim.about?.includes(id));
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

/** Browsable URL for an anchor at the modelled commit, when the source has one. */
export function anchorUrl(source: Source, anchor: string): string | null {
  return source.fileUrl ? source.fileUrl.replace("{path}", anchorPath(anchor)) : null;
}
