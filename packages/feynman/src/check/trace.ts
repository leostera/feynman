// Traces as logs (RFD0016): what a traced system did, read from OpenTelemetry (OTLP JSON),
// Jaeger or Zipkin, as the steps `conform` follows.
//
// A span is a step of the spec when it says so, with a `feynman.step` attribute, or when a
// mapping says so, for spans the system already has. The rest are the system's own detail and
// are skipped. What a flat log has to spell out, a trace already knows:
//
// - who: the span's `feynman.instance`, or else its service (`service.instance.id`, then
//   `service.name`), and for an instance to spawn, its actor: `feynman.actor`, on the span or
//   on the service's resource;
// - who sent the message a step takes: the nearest span up its parents, or else its links,
//   whose instance is another of the spec's;
// - the order: two machines' clocks disagree, so by default a trace is a partial order. A step
//   comes after the one before it on its own instance, and after the steps it descends from or
//   links to, and the log is a run when some order of the steps that keeps those is.
//   `order: "time"` trusts the clocks instead: by start time, but never before a span it
//   descends from (a span with the same start as its parent is common).
import { initialWorld } from "./explore.ts";
import { LogError, parseEvent, type LogEvent } from "./conform.ts";
import type { Spec } from "../spec/index.ts";

/** A span, as every trace format has it, with its attributes flattened to plain values. */
export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Spans it is linked to, as a consumer's span to its producer's. */
  links: { traceId: string; spanId: string }[];
  name: string;
  kind: "internal" | "server" | "client" | "producer" | "consumer" | "unspecified";
  /** Nanoseconds since the epoch. */
  start: bigint;
  end: bigint;
  attributes: Record<string, unknown>;
  /** The resource's attributes: the service that made the span. */
  resource: Record<string, unknown>;
}

/**
 * What a span means for the spec, for spans that do not say themselves: a log line, as JSON
 * Lines has it (`{instance, key, inputs, payload, …}`, and `actor` for an instance to spawn),
 * or undefined to skip it. What it leaves out comes from the span: the instance from its
 * service, and the sender from its parents.
 */
export type TraceMapping = (span: TraceSpan) => Record<string, unknown> | undefined;

export type TraceFormat = "otlp" | "jaeger" | "zipkin";

// Reading the formats -------------------------------------------------------------------------------

/** Which trace format a text is in, if it is one: undefined for a JSON Lines log. */
export function traceFormat(text: string): TraceFormat | undefined {
  const value = firstJson(text);
  if (Array.isArray(value)) {
    const first = Array.isArray(value[0]) ? value[0][0] : value[0];
    return isRecord(first) && "traceId" in first && "id" in first ? "zipkin" : undefined;
  }
  if (!isRecord(value)) return undefined;
  if ("resourceSpans" in value || "batches" in value || (isRecord(value.trace) && "resourceSpans" in value.trace)) return "otlp";
  if (Array.isArray(value.data) && isRecord(value.data[0]) && "spans" in value.data[0]) return "jaeger";
  return undefined;
}

/** The whole text as JSON, or its first line: an OTLP file exporter writes one request per line. */
function firstJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const line = text.split("\n").find((l) => l.trim());
    try {
      return line ? JSON.parse(line) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Every span in a trace file, whichever format it is in. */
export function readSpans(text: string, format: TraceFormat = traceFormat(text) ?? "otlp"): TraceSpan[] {
  const values: unknown[] = [];
  try {
    values.push(JSON.parse(text));
  } catch {
    // JSON Lines: an OTLP file exporter writes one export request per line.
    text.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      try {
        values.push(JSON.parse(line));
      } catch {
        throw new TraceError(`line ${i + 1} of the trace is not JSON`);
      }
    });
  }
  const read = { otlp: otlpSpans, jaeger: jaegerSpans, zipkin: zipkinSpans }[format];
  return values.flatMap((v) => read(v));
}

const OTLP_KINDS = ["unspecified", "internal", "server", "client", "producer", "consumer"] as const;

function otlpSpans(value: unknown): TraceSpan[] {
  if (!isRecord(value)) throw new TraceError("an OTLP trace is an object with resourceSpans");
  // Tempo answers {trace: {resourceSpans}} or {batches}; the collector writes {resourceSpans}.
  const resources = (isRecord(value.trace) ? value.trace.resourceSpans : (value.resourceSpans ?? value.batches)) as unknown[];
  if (!Array.isArray(resources)) throw new TraceError("an OTLP trace has resourceSpans");
  return resources.flatMap((r) => {
    if (!isRecord(r)) return [];
    const resource = otlpAttributes(isRecord(r.resource) ? r.resource.attributes : undefined);
    const scopes = (r.scopeSpans ?? r.instrumentationLibrarySpans ?? []) as unknown[];
    return scopes.flatMap((s) =>
      (isRecord(s) && Array.isArray(s.spans) ? s.spans : []).map((span: Record<string, unknown>): TraceSpan => ({
        traceId: otlpId(span.traceId),
        spanId: otlpId(span.spanId),
        ...(span.parentSpanId ? { parentSpanId: otlpId(span.parentSpanId) } : {}),
        links: (Array.isArray(span.links) ? span.links : []).map((l: Record<string, unknown>) => ({ traceId: otlpId(l.traceId), spanId: otlpId(l.spanId) })),
        name: String(span.name ?? ""),
        kind: typeof span.kind === "number" ? (OTLP_KINDS[span.kind] ?? "unspecified") : otlpKindName(span.kind),
        start: BigInt(String(span.startTimeUnixNano ?? 0)),
        end: BigInt(String(span.endTimeUnixNano ?? 0)),
        attributes: otlpAttributes(span.attributes),
        resource,
      })),
    );
  });
}

/** OTLP/JSON ids are hex; some exporters write base64, as protobuf's JSON mapping does. */
function otlpId(v: unknown): string {
  const s = String(v ?? "");
  if (/^[0-9a-f]*$/i.test(s)) return s.toLowerCase();
  return Buffer.from(s, "base64").toString("hex");
}

function otlpKindName(v: unknown): TraceSpan["kind"] {
  const name = String(v ?? "").replace(/^SPAN_KIND_/, "").toLowerCase();
  return (OTLP_KINDS as readonly string[]).includes(name) ? (name as TraceSpan["kind"]) : "unspecified";
}

function otlpAttributes(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of Array.isArray(v) ? v : []) if (isRecord(a)) out[String(a.key)] = otlpValue(a.value);
  return out;
}

function otlpValue(v: unknown): unknown {
  if (!isRecord(v)) return v;
  if ("stringValue" in v) return v.stringValue;
  if ("boolValue" in v) return v.boolValue;
  // int64 is a string in OTLP/JSON.
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("arrayValue" in v) return ((isRecord(v.arrayValue) ? v.arrayValue.values : []) as unknown[]).map(otlpValue);
  if ("kvlistValue" in v) return otlpAttributes(isRecord(v.kvlistValue) ? v.kvlistValue.values : []);
  if ("bytesValue" in v) return v.bytesValue;
  return undefined;
}

/** Jaeger's JSON, as its UI downloads a trace and its API answers: {data: [{spans, processes}]}. */
function jaegerSpans(value: unknown): TraceSpan[] {
  const traces = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  return traces.flatMap((t: Record<string, unknown>) => {
    const processes = isRecord(t.processes) ? t.processes : {};
    return (Array.isArray(t.spans) ? t.spans : []).map((s: Record<string, unknown>): TraceSpan => {
      const tags = jaegerTags(s.tags);
      const process = processes[String(s.processID)] as Record<string, unknown> | undefined;
      const refs = (Array.isArray(s.references) ? s.references : []) as Record<string, unknown>[];
      const parent = refs.find((r) => r.refType === "CHILD_OF");
      const start = BigInt(Math.round(Number(s.startTime ?? 0))) * 1000n;
      return {
        traceId: String(s.traceID),
        spanId: String(s.spanID),
        ...(parent ? { parentSpanId: String(parent.spanID) } : {}),
        links: refs.filter((r) => r !== parent).map((r) => ({ traceId: String(r.traceID), spanId: String(r.spanID) })),
        name: String(s.operationName ?? ""),
        kind: otlpKindName(tags["span.kind"]),
        start,
        end: start + BigInt(Math.round(Number(s.duration ?? 0))) * 1000n,
        attributes: tags,
        resource: { ...(process ? jaegerTags(process.tags) : {}), ...(process ? { "service.name": process.serviceName } : {}) },
      };
    });
  });
}

function jaegerTags(v: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of Array.isArray(v) ? v : []) if (isRecord(t)) out[String(t.key)] = t.value;
  return out;
}

/** Zipkin's v2 JSON: a list of spans, or (from /api/v2/traces) a list of traces. */
function zipkinSpans(value: unknown): TraceSpan[] {
  const spans = (Array.isArray(value) ? value.flat() : []) as Record<string, unknown>[];
  return spans.map((s): TraceSpan => {
    const start = BigInt(Math.round(Number(s.timestamp ?? 0))) * 1000n;
    const endpoint = isRecord(s.localEndpoint) ? s.localEndpoint : {};
    return {
      traceId: String(s.traceId),
      spanId: String(s.id),
      ...(s.parentId ? { parentSpanId: String(s.parentId) } : {}),
      links: [],
      name: String(s.name ?? ""),
      kind: otlpKindName(s.kind),
      start,
      end: start + BigInt(Math.round(Number(s.duration ?? 0))) * 1000n,
      attributes: isRecord(s.tags) ? { ...s.tags } : {},
      resource: { "service.name": endpoint.serviceName },
    };
  });
}

// Spans as steps -----------------------------------------------------------------------------------------

export interface TraceLogOptions {
  /** For spans without `feynman.step`: what each means, or undefined to skip it. */
  map?: TraceMapping;
  /** Only the spans of this trace. */
  traceId?: string;
  /** Causal, by default: each instance's order, and causes before effects. Time: by the clocks. */
  order?: "causal" | "time";
}

/** A trace's steps, as the log events `conform` follows: spawns first, then steps in order. */
export function traceLog(spans: TraceSpan[], spec: Spec, options: TraceLogOptions = {}): LogEvent[] {
  const kept = options.traceId ? spans.filter((s) => s.traceId === options.traceId) : spans;
  if (options.traceId && !kept.length) throw new TraceError(`there is no trace ${options.traceId}: the traces are ${[...new Set(spans.map((s) => s.traceId))].join(", ")}`);
  const byId = new Map(kept.map((s) => [`${s.traceId}/${s.spanId}`, s]));
  const parentOf = (s: TraceSpan) => (s.parentSpanId ? byId.get(`${s.traceId}/${s.parentSpanId}`) : undefined);

  // What each span means: a log line, or nothing.
  const meant = new Map<TraceSpan, Record<string, unknown>>();
  for (const span of kept) {
    const line = span.attributes["feynman.step"] !== undefined ? fromAttributes(span) : options.map?.(span);
    // A service may say once, on its resource, which actor it is (`feynman.actor`).
    const actor = span.resource["feynman.actor"];
    if (line) meant.set(span, { instance: serviceOf(span), ...(actor !== undefined ? { actor } : {}), ...line });
  }

  // Who is who: the singletons, and the instances the trace names with their actor.
  const singletons = new Set(initialWorld(spec, { instances: {} }).instances.map((i) => i.label));
  const actors = new Map<string, string>();
  for (const [span, line] of meant) {
    const instance = String(line.instance);
    if (line.actor === undefined || singletons.has(instance)) continue;
    const actor = String(line.actor);
    const before = actors.get(instance);
    if (before && before !== actor) throw new TraceError(`${where(span)} says ${instance} is a ${actor}, and an earlier span that it is a ${before}`);
    actors.set(instance, actor);
  }
  const known = (instance: string) => singletons.has(instance) || actors.has(instance);
  const instanceOf = (s: TraceSpan) => String(meant.get(s)?.instance ?? serviceOf(s));

  // The order: by start, but after every step span it descends from (clocks disagree).
  const at = new Map<TraceSpan, bigint>();
  const effective = (s: TraceSpan, depth = 0): bigint => {
    const known = at.get(s);
    if (known !== undefined) return known;
    const parent = depth < 10_000 ? parentOf(s) : undefined;
    const after = parent ? effective(parent, depth + 1) : undefined;
    const t = after !== undefined && after >= s.start ? after + (meant.has(parent!) ? 1n : 0n) : s.start;
    at.set(s, t);
    return t;
  };
  const depthOf = (s: TraceSpan) => {
    let n = 0;
    for (let p = parentOf(s); p && n < 10_000; p = parentOf(p)) n++;
    return n;
  };
  const ordered = [...meant.keys()].sort((a, b) => {
    const d = effective(a) - effective(b);
    return d !== 0n ? (d < 0n ? -1 : 1) : depthOf(a) - depthOf(b);
  });

  // The sender: the nearest span up the parents, or else a link, on another of the spec's instances.
  const senderOf = (s: TraceSpan): string | undefined => {
    const self = instanceOf(s);
    for (let p = parentOf(s), n = 0; p && n < 10_000; p = parentOf(p), n++) {
      const other = instanceOf(p);
      if (other !== self && known(other)) return other;
    }
    for (const l of s.links) {
      const linked = byId.get(`${l.traceId}/${l.spanId}`);
      if (linked && instanceOf(linked) !== self && known(instanceOf(linked))) return instanceOf(linked);
    }
    return undefined;
  };

  // What each step must come after: the step before it on its instance, and the steps it descends from or links to.
  const after = new Map<TraceSpan, Set<TraceSpan>>(ordered.map((s) => [s, new Set()]));
  if (options.order !== "time") {
    const nearestStep = (s: TraceSpan | undefined): TraceSpan | undefined => {
      for (let p = s, n = 0; p && n < 10_000; p = parentOf(p), n++) if (meant.has(p)) return p;
      return undefined;
    };
    const local = new Map<string, TraceSpan>();
    const byClock = [...ordered].sort((a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : depthOf(a) - depthOf(b)));
    for (const s of byClock) {
      const instance = instanceOf(s);
      const previous = local.get(instance);
      if (previous) after.get(s)!.add(previous);
      local.set(instance, s);
      const cause = nearestStep(parentOf(s));
      if (cause) after.get(s)!.add(cause);
      for (const l of s.links) {
        const linked = nearestStep(byId.get(`${l.traceId}/${l.spanId}`));
        if (linked && linked !== s) after.get(s)!.add(linked);
      }
    }
  }
  // Written in an order that keeps them, the earliest first.
  const written: TraceSpan[] = [];
  const placed = new Set<TraceSpan>();
  while (written.length < ordered.length) {
    const next = ordered.find((s) => !placed.has(s) && [...after.get(s)!].every((p) => placed.has(p)));
    if (!next) throw new TraceError(`the spans' order goes round in a circle: ${ordered.filter((s) => !placed.has(s)).map(where).join(", ")}; each instance's clock must agree with what caused what`);
    written.push(next);
    placed.add(next);
  }

  const out: LogEvent[] = [];
  let n = 0;
  for (const [instance, actor] of actors) out.push(parseEvent({ kind: "spawn", actor, label: instance }, ++n, spec, `the spawn of ${instance}`));
  const lineOf = new Map<TraceSpan, number>();
  const partial = options.order !== "time";
  for (const span of written) {
    const { actor: _actor, ...line } = meant.get(span)!;
    if (partial) line.after = [...after.get(span)!].map((p) => lineOf.get(p)!);
    lineOf.set(span, n + 1);
    // A step on a message has a sender; an action or timer does not, whatever its parents.
    if (line.from === undefined && takesMessage(spec, actors.get(String(line.instance)) ?? labelActor(spec, String(line.instance)), String(line.key), line.kind)) {
      const from = senderOf(span);
      if (from) line.from = from;
    }
    out.push(parseEvent(line, ++n, spec, where(span)));
  }
  return out;
}

/** A span's own say: `feynman.step`, and the rest of `feynman.*`, flat (`feynman.inputs.value`) or as JSON. */
function fromAttributes(span: TraceSpan): Record<string, unknown> {
  const a = span.attributes;
  const line: Record<string, unknown> = { key: a["feynman.step"] };
  for (const field of ["instance", "actor", "kind", "message", "from"]) if (a[`feynman.${field}`] !== undefined) line[field] = a[`feynman.${field}`];
  for (const field of ["inputs", "payload", "state"]) {
    const whole = a[`feynman.${field}`];
    const parts = Object.entries(a).filter(([k]) => k.startsWith(`feynman.${field}.`));
    if (whole !== undefined) line[field] = typeof whole === "string" ? parseJson(whole, span, field) : whole;
    else if (parts.length) line[field] = Object.fromEntries(parts.map(([k, v]) => [k.slice(`feynman.${field}.`.length), v]));
  }
  return line;
}

function parseJson(text: string, span: TraceSpan, field: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new TraceError(`${where(span)} has feynman.${field} that is not JSON: ${text}`);
  }
}

/** The instance a span's service stands for: `service.instance.id`, else `service.name`. */
function serviceOf(span: TraceSpan): string {
  return String(span.resource["service.instance.id"] ?? span.resource["service.name"] ?? "unknown service");
}

/** The actor of a singleton, by its label. */
function labelActor(spec: Spec, label: string): string | undefined {
  return initialWorld(spec, { instances: {} }).instances.find((i) => i.label === label)?.actor;
}

/** Whether the step is one on a message, which has a sender. */
function takesMessage(spec: Spec, actor: string | undefined, key: string, kind: unknown): boolean {
  if (kind !== undefined) return kind === "deliver";
  const info = spec.actors.find((a) => a.name === actor);
  return !!info?.transitions[key]?.message;
}

/** A span as a person finds it in their tracing UI: its name, service and id. */
export function where(span: TraceSpan): string {
  return `span "${span.name}" (${serviceOf(span)}, ${span.spanId})`;
}

export class TraceError extends LogError {
  constructor(what: string) {
    super(0, what, "");
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
