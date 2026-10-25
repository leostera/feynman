// The model as the renderer sees it: types and anchors from @feynman/model, plus
// routes to element pages and an index for looking elements up.
import type {
  Actor,
  Claim,
  Component,
  Flow,
  Invariant,
  Limit,
  Model,
  Protocol,
  State,
  StateMachine,
} from "@feynman/model/types";

export type * from "@feynman/model/types";
export { anchorUrl, resolveAnchor, spanLabel } from "@feynman/model/anchors";

/** Element kinds that have their own page. */
export type Kind = "actor" | "component" | "flow" | "protocol" | "state" | "machine" | "invariant" | "claim" | "limit";

/** URL segment for each kind's pages; also the model directory each kind is stored in. */
export const SEGMENT: Record<Kind, string> = {
  actor: "actors",
  component: "components",
  flow: "flows",
  protocol: "protocols",
  state: "state",
  machine: "state-machines",
  invariant: "invariants",
  claim: "claims",
  limit: "limits",
};

const KIND_BY_SEGMENT = new Map(Object.entries(SEGMENT).map(([kind, segment]) => [segment, kind as Kind]));

export function kindOfSegment(segment: string): Kind | undefined {
  return KIND_BY_SEGMENT.get(segment);
}

export function href(kind: Kind, id?: string): string {
  return id === undefined ? `#/${SEGMENT[kind]}` : `#/${SEGMENT[kind]}/${encodeURIComponent(id)}`;
}

/** A typed reference to one element. */
export interface Ref {
  kind: Kind;
  id: string;
}

/** Parse an element path such as `flows/pi-recovery`. */
export function parsePath(path: string): Ref | null {
  const [segment, id] = path.split("/");
  const kind = kindOfSegment(segment);
  return kind && id ? { kind, id } : null;
}

export interface Index {
  model: Model;
  actors: Map<string, Actor>;
  components: Map<string, Component>;
  flows: Map<string, Flow>;
  protocols: Map<string, Protocol>;
  state: Map<string, State>;
  machines: Map<string, StateMachine>;
  invariants: Map<string, Invariant>;
  claims: Map<string, Claim>;
  limits: Map<string, Limit>;
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
    components: byId(model.components),
    flows: byId(model.flows),
    protocols: byId(model.protocols),
    state: byId(model.state),
    machines: byId(model.stateMachines),
    invariants: byId(model.invariants),
    claims: byId(model.claims),
    limits: byId(model.limits),
    usedBy: new Map(),
  };
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

/** The index map holding each kind's elements. */
const MAP: Record<Kind, Exclude<keyof Index, "model" | "usedBy">> = {
  actor: "actors",
  component: "components",
  flow: "flows",
  protocol: "protocols",
  state: "state",
  machine: "machines",
  invariant: "invariants",
  claim: "claims",
  limit: "limits",
};

/** How many elements of `kind` the model has. */
export function countOf(index: Index, kind: Kind): number {
  return index[MAP[kind]].size;
}

export function exists(index: Index, { kind, id }: Ref): boolean {
  return index[MAP[kind]].has(id);
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

/** Claims whose `about` names this element. */
export function claimsAbout(index: Index, { kind, id }: Ref): Claim[] {
  const path = `${SEGMENT[kind]}/${id}`;
  return index.model.claims.filter((claim) => claim.about?.includes(path));
}

/** Limits whose `about` names this element. */
export function limitsAbout(index: Index, { kind, id }: Ref): Limit[] {
  const path = `${SEGMENT[kind]}/${id}`;
  return index.model.limits.filter((limit) => limit.about?.includes(path));
}

/** Protocols an actor serves or uses. */
export function protocolsOf(index: Index, actor: string): { protocol: Protocol; role: "serves" | "uses" }[] {
  const result: { protocol: Protocol; role: "serves" | "uses" }[] = [];
  for (const protocol of index.model.protocols) {
    if (protocol.server === actor) result.push({ protocol, role: "serves" });
    else if (protocol.clients?.includes(actor) || protocol.messages.some((m) => m.from === actor)) result.push({ protocol, role: "uses" });
  }
  return result;
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

/** Components running in an actor. */
export function componentsOf(index: Index, actor: string): Component[] {
  return index.model.components.filter((component) => component.actors.includes(actor));
}

/** Lines of code in an actor: its components' footprints, each counted once. */
export function actorLines(index: Index, actor: string): number | undefined {
  const components = componentsOf(index, actor).filter((component) => component.footprint.lines !== undefined);
  return components.length ? components.reduce((n, component) => n + (component.footprint.lines ?? 0), 0) : undefined;
}

/** Flows with a step done by this component. */
export function flowsOfComponent(index: Index, component: string): Flow[] {
  return index.model.flows.filter((flow) => flow.steps.some((step) => step.component === component));
}
