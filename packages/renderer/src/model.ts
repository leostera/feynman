// Types mirror packages/model/schema/*.json, as bundled by loadModel in @feynman/model.

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

export type Location = "local" | "browser" | "remote" | "cloud";

export type ActorKind = "person" | "program" | "service";

export interface Actor {
  id: string;
  kind?: ActorKind;
  provenance: Provenance;
  runsOn: { location: Location; provider?: string; platform?: string };
  summary: string;
  talksTo?: string[];
  anchors: Anchor[];
  confidence?: Confidence;
}

export interface Footprint {
  paths: string[];
  files?: number;
  lines?: number;
}

export interface Component {
  id: string;
  summary: string;
  actors: string[];
  dependsOn?: string[];
  footprint: Footprint;
  anchors: Anchor[];
}

export interface Step {
  actor: string;
  action: string;
  target?: string;
  component?: string;
  ref?: string;
  protocol?: string;
  properties?: string[];
}

export interface Flow {
  id: string;
  summary: string;
  trigger: string;
  outcome?: string;
  steps: Step[];
  anchors: Anchor[];
  confidence?: Confidence;
}

export interface Field {
  name: string;
  type: string;
  required?: boolean;
  note?: string;
}

export type MessageKind = "call" | "record" | "event" | "route" | "table";

export interface Message {
  name: string;
  kind: MessageKind;
  from?: string;
  summary?: string;
  fields?: Field[];
  returns?: Field[];
}

export interface Protocol {
  id: string;
  summary: string;
  style: string;
  transport: string;
  server?: string;
  clients?: string[];
  framing?: string;
  version?: string;
  messages: Message[];
  parsing?: { summary: string; anchors: Anchor[] }[];
  definitions?: Anchor[];
  compatibility?: string;
  anchors: Anchor[];
}

export interface State {
  id: string;
  owner: string;
  summary: string;
  lifetime: string;
  anchors: Anchor[];
}

export interface StateMachine {
  id: string;
  summary?: string;
  states?: string[];
  transitions?: string[];
  anchors: Anchor[];
}

export type Enforcement = "compile-time" | "runtime" | "test-time" | "documented";

export interface Frame {
  symbol: string;
  anchor: Anchor;
  note?: string;
}

export interface Invariant {
  id: string;
  statement: string;
  enforcement: Enforcement[];
  consequence?: string;
  enforcedAt: { trigger: string; frames: Frame[] }[];
  tests?: Anchor[];
  anchors: Anchor[];
}

export interface Limit {
  id: string;
  subject: string;
  value: string | number;
  kind: string;
  epistemic?: "stated" | "measured";
  about?: string[];
  anchors: Anchor[];
}

export type ClaimStatus = "supported" | "partially-supported" | "contradicted" | "unverified";

export interface Claim {
  id: string;
  statement: string;
  status: ClaimStatus;
  epistemic: "stated" | "inferred" | "measured";
  note?: string;
  evidence: Anchor[];
  /** Element paths, e.g. `flows/pi-recovery`. */
  about?: string[];
}

/** The bundled model: every collection sorted by id (see tools/model.mjs). */
export interface Model {
  meta: Meta;
  actors: Actor[];
  components: Component[];
  flows: Flow[];
  protocols: Protocol[];
  state: State[];
  stateMachines: StateMachine[];
  invariants: Invariant[];
  claims: Claim[];
  limits: Limit[];
}

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

export function exists(index: Index, { kind, id }: Ref): boolean {
  const maps: Record<Kind, Map<string, unknown>> = {
    actor: index.actors,
    component: index.components,
    flow: index.flows,
    protocol: index.protocols,
    state: index.state,
    machine: index.machines,
    invariant: index.invariants,
    claim: index.claims,
    limit: index.limits,
  };
  return maps[kind].has(id);
}

export function loadModel(): Model {
  const element = document.getElementById("feynman-model");
  if (!element?.textContent) throw new Error("No embedded model found");
  const model = JSON.parse(element.textContent) as Model;
  // Models written before components existed have none.
  return { ...model, components: model.components ?? [] };
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

export interface Position {
  line: number;
  column?: number;
}

export interface ResolvedAnchor {
  file: string;
  symbol?: string;
  span?: { start: Position; end?: Position };
}

/** A location at the modelled commit: shorthand string or explicit object. */
export type Anchor = string | ResolvedAnchor;

const SHORTHAND = /^([^#:]+)(?::(\d+)(?::(\d+))?(?:-(\d+)(?::(\d+))?)?)?(?:#(.+))?$/;

/** Normalize either anchor form to `{ file, symbol?, span? }`. */
export function resolveAnchor(anchor: Anchor): ResolvedAnchor {
  if (typeof anchor !== "string") return anchor;
  const match = SHORTHAND.exec(anchor);
  if (!match) return { file: anchor };
  const [, file, startLine, startColumn, endLine, endColumn, symbol] = match;
  const position = (line: string, column?: string): Position => ({
    line: Number(line),
    ...(column ? { column: Number(column) } : {}),
  });
  return {
    file,
    ...(symbol ? { symbol } : {}),
    ...(startLine
      ? { span: { start: position(startLine, startColumn), ...(endLine ? { end: position(endLine, endColumn) } : {}) } }
      : {}),
  };
}

/** Path part of an anchor. */
export function anchorPath(anchor: Anchor): string {
  return resolveAnchor(anchor).file;
}

/** `10-42` or `10:5-42:2`, for display. */
export function spanLabel(span: ResolvedAnchor["span"]): string | null {
  if (!span) return null;
  const at = (p: Position) => (p.column ? `${p.line}:${p.column}` : `${p.line}`);
  return span.end ? `${at(span.start)}-${at(span.end)}` : at(span.start);
}

/** Browsable URL for an anchor at the modelled commit, with a line range when known. */
export function anchorUrl(source: Source, anchor: Anchor): string | null {
  if (!source.fileUrl) return null;
  const { file, span } = resolveAnchor(anchor);
  const end = span?.end && span.end.line !== span.start.line ? `-L${span.end.line}` : "";
  return source.fileUrl.replace("{path}", file) + (span ? `#L${span.start.line}${end}` : "");
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
