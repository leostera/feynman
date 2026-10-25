// The model's shape, mirroring schema/*.json. Elements carry the `id` their file
// name gives them. Types only: this module is safe to import from browser code.
//
// These types describe a model that passed `checkModel`. `loadModel` reads files
// without validating them, so code handling a model mid-extraction must not rely
// on required fields being present.

export type Confidence = "high" | "medium" | "low";

/** Content hash (git blob id) of each file an element anchors, written by `measure`. */
export type Sources = Record<string, string>;

export interface Position {
  line: number;
  column?: number;
}

export interface ResolvedAnchor {
  file: string;
  symbol?: string;
  span?: { start: Position; end?: Position };
}

/** A location in the repository: shorthand (`path`, `path#symbol`, `path:10-42`) or explicit. */
export type Anchor = string | ResolvedAnchor;

export interface Footprint {
  paths: string[];
  /** Counted by `measure`. */
  files?: number;
  lines?: number;
}

export interface Source {
  repository: string;
  commit: string;
  /** The model includes uncommitted changes on top of `commit`. */
  worktree?: boolean;
  base?: { commit: string };
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

export type ActorKind = "person" | "program" | "service";
export type Provenance = "first-party" | "third-party" | "ambient";
export type Location = "local" | "browser" | "remote" | "cloud";

export interface Actor {
  id: string;
  kind: ActorKind;
  provenance: Provenance;
  runsOn: { location: Location; provider?: string; platform?: string };
  summary: string;
  talksTo?: string[];
  anchors: Anchor[];
  confidence?: Confidence;
  sources?: Sources;
}

export interface Component {
  id: string;
  summary: string;
  actors: string[];
  dependsOn?: string[];
  footprint: Footprint;
  anchors: Anchor[];
  sources?: Sources;
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
  sources?: Sources;
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
  sources?: Sources;
}

export interface State {
  id: string;
  owner: string;
  summary: string;
  lifetime: string;
  anchors: Anchor[];
  sources?: Sources;
}

export interface StateMachine {
  id: string;
  summary?: string;
  states?: string[];
  transitions?: string[];
  anchors: Anchor[];
  sources?: Sources;
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
  sources?: Sources;
}

export interface Limit {
  id: string;
  subject: string;
  value: string | number;
  kind: string;
  epistemic?: "stated" | "measured";
  /** Element paths, e.g. `flows/pi-recovery`. */
  about?: string[];
  anchors: Anchor[];
  sources?: Sources;
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
  sources?: Sources;
}

/** A whole model, every collection sorted by id. */
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

/** The key of each element collection in `Model`. */
export type KindKey = Exclude<keyof Model, "meta">;

/** Any element. */
export type Element = Model[KindKey][number];

/** What each covered file's ledger entry says about it. */
export type Outcome =
  /** Read in full in an extraction session (recorded automatically). */
  | "read"
  /** About developing, building, or publishing the system, not how it behaves. */
  | "development"
  /** A copy of third-party code. */
  | "vendored"
  /** Output of a tool. */
  | "generated";

export interface LedgerEntry {
  /** A file, or a directory ending in `/` for development, vendored, and generated trees. */
  path: string;
  outcome: Outcome;
  note?: string;
  /** For reads of the working tree: the content hash (git blob id) that was read. */
  hash?: string;
}

/** `coverage/<batch>.json`: what one session covered at one commit. */
export interface Ledger {
  commit: string;
  summary: string;
  files: LedgerEntry[];
}
