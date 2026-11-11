// Traces as logs (RFD0016). The oracle: a run, written as a trace (OTLP, Jaeger or Zipkin),
// with its spans shuffled, clocks skewed, and spans the spec knows nothing of in between, is
// read as the same events as the run written as JSON Lines. And the OpenTelemetry SDK's own
// export of a traced system is read as what that system did.
import { expect, test } from "bun:test";
import { context, trace, type Context as OtelContext } from "@opentelemetry/api";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { conform, LogError, parseLog, type LogEvent } from "../../src/check/conform.ts";
import { apply, branches, initialWorld, QUIET } from "../../src/check/index.ts";
import { readSpans, traceFormat, traceLog, type TraceFormat } from "../../src/check/trace.ts";
import { seeded } from "../../src/check/walk.ts";
import type { Event, Spec, World } from "../../src/spec/index.ts";
import { alternatingBit } from "../../examples/alternating-bit.ts";
import { orderedWrites } from "../../examples/ordered-writes.ts";
import { payments } from "../../examples/payments.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";

interface Rendered {
  /** The run as JSON Lines, as conform.test.ts writes it. */
  jsonl: string;
  /** The run as a trace, in each format. */
  traces: Record<TraceFormat, string>;
}

/**
 * A random run's steps, as spans named by their place in it (`step 3`): a delivery is a child,
 * through a gateway span, of the step that sent it, and each machine's clock is off by as much
 * as `skew` microseconds, either way. Steps are a millisecond apart.
 */
function render(spec: Spec, seed: number, instances: Record<string, number>, skew: number): Rendered {
  const random = seeded(seed);
  const offsets = new Map<string, number>();
  const clockOf = (machine: string) => {
    if (!offsets.has(machine)) offsets.set(machine, Math.round((random() * 2 - 1) * skew));
    return offsets.get(machine)!;
  };
  let world = initialWorld(spec, { instances });
  const singletons = new Set(initialWorld(spec, { instances: {} }).instances.map((i) => i.id));
  const label = (w: World, id?: string) => w.instances.find((i) => i.id === id)?.label;
  const actorOf = (w: World, id: string) => w.instances.find((i) => i.id === id)!.actor;
  const lines: string[] = [...world.instances.filter((i) => !singletons.has(i.id)).map((i) => JSON.stringify({ kind: "spawn", actor: i.actor, label: i.label }))];
  interface Span { id: string; parent?: string; name: string; service: Record<string, string>; start: number; tags: Record<string, unknown> }
  const spans: Span[] = [];
  // The span that sent each message in flight.
  const sentBy = new Map<number, string>();
  let clock = 1_000_000;
  let ids = 0;
  const id = () => (++ids).toString(16).padStart(16, "0");
  for (let n = 0; n < 10; n++) {
    const options = branches(spec, world).filter((c) => !apply(spec, world, c, QUIET).event.error && !apply(spec, world, c, QUIET).event.tags?.includes("fault"));
    if (!options.length) break;
    const choice = options[Math.floor(random() * options.length)]!;
    const step = apply(spec, world, choice, QUIET);
    const e: Event = step.event;
    const who = label(world, e.instance)!;
    const line: Record<string, unknown> = { kind: e.kind, instance: who, key: e.key, ...(e.kind === "action" ? { inputs: e.inputs ?? {} } : {}), ...(e.kind === "deliver" ? { message: e.message, from: label(world, e.from), payload: e.payload } : {}) };
    lines.push(JSON.stringify(line));
    // Replicas share a service name, told apart by service.instance.id; a singleton is its own service.
    const service: Record<string, string> = singletons.has(e.instance!) ? { "service.name": who } : { "service.name": actorOf(world, e.instance!), "service.instance.id": who, "feynman.actor": actorOf(world, e.instance!) };
    const span: Span = { id: id(), name: `step ${lines.filter((l) => !l.includes('"spawn"')).length - 1}`, service, start: (clock += 1000) + clockOf(who), tags: { "feynman.step": e.key } };
    if (e.kind === "action") for (const [k, v] of Object.entries(e.inputs ?? {})) span.tags[`feynman.inputs.${k}`] = v;
    // An action without inputs says so whole: there are none to name.
    if (e.kind === "action" && !Object.keys(e.inputs ?? {}).length) span.tags["feynman.inputs"] = "{}";
    if (e.kind === "deliver") {
      span.tags["feynman.payload"] = JSON.stringify(e.payload);
      const pending = choice.kind === "fire" ? choice.pending : -1;
      const sender = sentBy.get(pending);
      if (sender) {
        // Through a gateway the spec knows nothing of, on a clock of its own.
        const gateway: Span = { id: id(), parent: sender, name: "proxy", service: { "service.name": "gateway" }, start: clock - 500 + clockOf("gateway"), tags: {} };
        spans.push(gateway);
        span.parent = gateway.id;
      }
    }
    spans.push(span);
    const before = new Set(world.pending.map((p) => p.id));
    for (const p of step.world.pending) if (!before.has(p.id)) sentBy.set(p.id, span.id);
    world = step.world;
  }
  const order = spans.map((s) => ({ s, r: random() })).sort((a, b) => a.r - b.r).map(({ s }) => s);
  const traceId = "0af7651916cd43dd8448eb211c80319c";
  const otlpValue = (v: unknown) => (typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v });
  const services = [...new Set(order.map((s) => JSON.stringify(s.service)))];
  const otlp = {
    resourceSpans: services.map((svc) => ({
      resource: { attributes: Object.entries(JSON.parse(svc)).map(([key, v]) => ({ key, value: otlpValue(v) })) },
      scopeSpans: [{ scope: { name: "test" }, spans: order.filter((s) => JSON.stringify(s.service) === svc).map((s) => ({ traceId, spanId: s.id, ...(s.parent ? { parentSpanId: s.parent } : {}), name: s.name, kind: s.parent ? 2 : 1, startTimeUnixNano: String(BigInt(s.start) * 1000n), endTimeUnixNano: String(BigInt(s.start + 500) * 1000n), attributes: Object.entries(s.tags).map(([key, v]) => ({ key, value: otlpValue(v) })) })) }],
    })),
  };
  const processes = Object.fromEntries(services.map((svc, i) => [`p${i}`, { serviceName: JSON.parse(svc)["service.name"], tags: Object.entries(JSON.parse(svc)).filter(([k]) => k !== "service.name").map(([key, value]) => ({ key, type: "string", value })) }]));
  const jaeger = { data: [{ traceID: traceId, spans: order.map((s) => ({ traceID: traceId, spanID: s.id, operationName: s.name, references: s.parent ? [{ refType: "CHILD_OF", traceID: traceId, spanID: s.parent }] : [], startTime: s.start, duration: 500, tags: Object.entries(s.tags).map(([key, value]) => ({ key, type: typeof value === "string" ? "string" : "int64", value })), processID: `p${services.indexOf(JSON.stringify(s.service))}` })), processes }] };
  // Zipkin has one service name per span: replicas say who they are on the span.
  const zipkin = order.map((s) => ({ traceId, id: s.id, ...(s.parent ? { parentId: s.parent } : {}), name: s.name, kind: s.parent ? "SERVER" : "CLIENT", timestamp: s.start, duration: 500, localEndpoint: { serviceName: s.service["service.instance.id"] ?? s.service["service.name"] }, tags: { ...Object.fromEntries(Object.entries(s.tags).map(([k, v]) => [k, String(v)])), ...(s.service["feynman.actor"] ? { "feynman.actor": s.service["feynman.actor"] } : {}) } }));
  return { jsonl: lines.join("\n"), traces: { otlp: JSON.stringify(otlp), jaeger: JSON.stringify(jaeger), zipkin: JSON.stringify(zipkin) } };
}

/** An event without where it came from: what conform follows. */
const bare = (events: LogEvent[]) => events.map(({ line: _line, at: _at, ...e }) => { if ("after" in e) delete (e as { after?: number[] }).after; return e; });

/** A trace's steps, by their place in the run (from `step N`), with the places they come after. */
function placed(events: LogEvent[]) {
  const steps = events.filter((e) => e.kind !== "spawn");
  const placeOf = new Map(steps.map((e) => [e.line, Number(/^span "step (\d+)"/.exec(e.at!)![1])]));
  return steps.map(({ line, at: _at, after, ...e }) => ({ place: placeOf.get(line)!, after: (after ?? []).map((l) => placeOf.get(l)!), event: { ...e, kind: undefined, message: undefined } }));
}

test("a run, as a trace in OTLP, Jaeger or Zipkin, shuffled, its clocks skewed, is read as its steps, in an order its run keeps", () => {
  const specs: [Spec, Record<string, number>][] = [
    [orderedWrites("fixed"), {}],
    [alternatingBit("fixed", "ordered"), {}],
    [payments("fixed"), { Client: 2 }],
    [twoPhaseCommit("fixed"), { Participant: 2 }],
  ];
  let compared = 0;
  let misordered = 0;
  for (const [spec, instances] of specs)
    for (let seed = 1; seed <= 25; seed++) {
      // Clocks off by up to 50ms, where steps are 1ms apart: only each machine's order, and what caused what, can be trusted.
      const { jsonl, traces } = render(spec, seed, instances, 50_000);
      const expected = bare(parseLog(jsonl, spec)).filter((e) => e.kind !== "spawn").map((e) => ({ ...e, kind: undefined, message: undefined }));
      // Zipkin and Jaeger tags are strings: their payloads and inputs are compared as JSON reads them.
      const normal = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "number" ? String(x) : x)));
      for (const format of ["otlp", "jaeger", "zipkin"] as const) {
        expect(traceFormat(traces[format])).toBe(format);
        const log = traceLog(readSpans(traces[format]), spec);
        const read = placed(log);
        // Every step, as the run took it, and nothing comes after a step the run took later.
        expect(normal(read.map((r) => r.event))).toEqual(normal(read.map((r) => expected[r.place])));
        expect(read.map((r) => r.place).sort((a, b) => a - b)).toEqual(expected.map((_, i) => i));
        for (const r of read) expect({ seed, step: r.place, before: r.after.filter((p) => p >= r.place) }).toEqual({ seed, step: r.place, before: [] });
        expect({ spec: spec.name, seed, format, conforms: conform(spec, log).conforms }).toEqual({ spec: spec.name, seed, format, conforms: true });
        compared++;
      }
      // Trusting the skewed clocks gets the order wrong, often: what the causal order is for.
      const byClock = placed(traceLog(readSpans(traces.otlp), spec, { order: "time" })).map((r) => r.place);
      if (byClock.some((p, i) => p !== i)) misordered++;
      // With clocks that agree, --order time reads the run back as it was.
      const timed = render(spec, seed, instances, 0).traces.otlp;
      const inTime = traceLog(readSpans(timed), spec, { order: "time" });
      expect(normal(bare(inTime).filter((e) => e.kind !== "spawn").map((e) => ({ ...e, kind: undefined, message: undefined })))).toEqual(normal(expected));
    }
  expect(compared).toBe(300);
  expect(misordered).toBeGreaterThan(50);
});

/** Ordered writes, as a system traced with the OpenTelemetry SDK: a client and a store, as two services. */
function tracedWrites(applied: ("a" | "b")[]): string {
  const exporter = new InMemorySpanExporter();
  const tracer = (service: string) => new BasicTracerProvider({ resource: resourceFromAttributes({ "service.name": service }), spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer("writes");
  const client = tracer("Client");
  const store = tracer("Store");
  // The client's writes go out with their trace context, as an HTTP client's would.
  const sent = new Map<string, OtelContext>();
  for (const value of ["a", "b"]) {
    const span = client.startSpan("POST /write", { attributes: { "feynman.step": "set", "feynman.inputs.value": value } });
    sent.set(value, trace.setSpan(context.active(), span));
    span.end();
  }
  // The store applies them in the order they arrive, which the network decides.
  for (const value of applied) {
    const http = store.startSpan("PUT /value", { kind: 1 }, sent.get(value));
    const apply = store.startSpan("apply", { attributes: { "feynman.step": "put", "feynman.payload.value": value } }, trace.setSpan(context.active(), http));
    apply.end();
    http.end();
  }
  return new TextDecoder().decode(JsonTraceSerializer.serializeRequest(exporter.getFinishedSpans()));
}

test("the OpenTelemetry SDK's export of a traced system is read as what the system did, and judged", () => {
  const inOrder = tracedWrites(["a", "b"]);
  const reordered = tracedWrites(["b", "a"]);
  expect(traceFormat(inOrder)).toBe("otlp");
  const steps = (text: string, spec: Spec) => traceLog(readSpans(text), spec).map((e) => (e.kind === "spawn" ? e.label : `${e.instance} ${e.key} ${JSON.stringify(e.inputs ?? e.payload)}${e.from ? ` from ${e.from}` : ""}`));
  // The SDK gives a child the start of its parent, to the millisecond: the order still puts it after.
  expect(steps(reordered, orderedWrites("buggy"))).toEqual(['Client set {"value":"a"}', 'Client set {"value":"b"}', 'Store put {"value":"b"} from Client', 'Store put {"value":"a"} from Client']);
  // Each step after the one before it on its instance, and after the step that caused it.
  expect(traceLog(readSpans(reordered), orderedWrites("buggy")).map((e) => (e.kind === "spawn" ? undefined : e.after))).toEqual([[], [1], [2], [3, 1]]);
  // On a network that reorders, the reordered run is one of the spec's, and breaks lastWriteWins.
  const buggy = orderedWrites("buggy");
  const r = conform(buggy, traceLog(readSpans(reordered), buggy));
  if (!r.conforms) throw new Error("does not conform");
  expect(r.broken.map((b) => b.id)).toEqual(["lastWriteWins"]);
  // On one connection, it is not: the store took b with a ahead of it.
  const fixed = orderedWrites("fixed");
  const ordered = conform(fixed, traceLog(readSpans(reordered), fixed));
  if (ordered.conforms || ordered.stop.kind !== "mismatch") throw new Error("conforms");
  expect(ordered.stop.line.at).toMatch(/^span "apply" \(Store, [0-9a-f]{16}\)$/);
  expect(conform(fixed, traceLog(readSpans(inOrder), fixed))).toMatchObject({ conforms: true, broken: [] });
});

test("a mapping reads the spans a system already has; a span may also name its parts as JSON", () => {
  const spec = orderedWrites("buggy");
  const text = tracedWrites(["b", "a"]);
  // Without feynman.step: the spans as the system had them, with the attributes taken off.
  const plain = JSON.parse(text);
  for (const r of plain.resourceSpans) for (const s of r.scopeSpans) for (const span of s.spans) span.attributes = span.attributes.filter((a: { key: string }) => a.key.endsWith(".value")).map((a: { key: string; value: unknown }) => ({ key: "value", value: a.value }));
  const spans = readSpans(JSON.stringify(plain));
  expect(traceLog(spans, spec).length).toBe(0);
  const mapped = traceLog(spans, spec, {
    map: (span) => (span.name === "POST /write" ? { key: "set", inputs: { value: span.attributes.value } } : span.name === "apply" ? { key: "put", payload: { value: span.attributes.value } } : undefined),
  });
  expect(mapped.map((e) => (e.kind === "spawn" ? "" : `${e.instance}.${e.key}`))).toEqual(["Client.set", "Client.set", "Store.put", "Store.put"]);
  expect(conform(spec, mapped).conforms).toBe(true);
  // feynman.payload as one JSON string, and feynman.instance over the service.
  const json = JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "store-7" } }] }, scopeSpans: [{ spans: [{ traceId: "aa", spanId: "01", name: "apply", kind: "SPAN_KIND_INTERNAL", startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [{ key: "feynman.step", value: { stringValue: "put" } }, { key: "feynman.instance", value: { stringValue: "Store" } }, { key: "feynman.payload", value: { stringValue: '{"value":"a"}' } }] }] }] }] });
  expect(bare(traceLog(readSpans(json), spec))).toEqual([{ instance: "Store", key: "put", payload: { value: "a" } }]);
});

test("a consumer's sender is found through its links, as a queue's traces have them", () => {
  const spec = orderedWrites("buggy");
  const span = (service: string, id: string, extra: object) => ({ resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] }, scopeSpans: [{ spans: [{ traceId: id.repeat(2), spanId: id, name: id, startTimeUnixNano: "1", endTimeUnixNano: "2", links: [], ...extra }] }] });
  const text = [
    JSON.stringify({ resourceSpans: [span("Client", "c1", { attributes: [{ key: "feynman.step", value: { stringValue: "set" } }, { key: "feynman.inputs.value", value: { stringValue: "a" } }] })] }),
    // A new trace for the consumer, linked to the producer's span: the file exporter's JSON Lines.
    JSON.stringify({ resourceSpans: [span("Store", "d1", { startTimeUnixNano: "5", links: [{ traceId: "c1c1", spanId: "c1" }], attributes: [{ key: "feynman.step", value: { stringValue: "put" } }] })] }),
  ].join("\n");
  expect(bare(traceLog(readSpans(text), spec))).toEqual([
    { instance: "Client", key: "set", inputs: { value: "a" } },
    { instance: "Store", key: "put", from: "Client" },
  ]);
  // The consumer's step comes after the producer's: the link is what caused it.
  expect(traceLog(readSpans(text), spec).map((e) => (e.kind === "spawn" ? undefined : e.after))).toEqual([[], [1]]);
  expect(() => traceLog(readSpans(text), spec, { traceId: "ffff" })).toThrow("there is no trace ffff: the traces are c1c1, d1d1");
  expect(bare(traceLog(readSpans(text), spec, { traceId: "c1c1" }))).toEqual([{ instance: "Client", key: "set", inputs: { value: "a" } }]);
});

test("a span the spec cannot read is refused, by its name, service and id", () => {
  const spec = orderedWrites("buggy");
  const one = (attributes: object[]) => JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "Store" } }] }, scopeSpans: [{ spans: [{ traceId: "aa", spanId: "0123456789abcdef", name: "apply", startTimeUnixNano: "1", endTimeUnixNano: "2", attributes }] }] }] });
  const refused = (text: string) => {
    try {
      conform(spec, traceLog(readSpans(text), spec));
    } catch (error) {
      if (error instanceof LogError) return error.message;
      throw error;
    }
    return "read";
  };
  expect(refused(one([{ key: "feynman.step", value: { stringValue: "put" } }, { key: "feynman.payload", value: { stringValue: "{" } }]))).toBe('span "apply" (Store, 0123456789abcdef) has feynman.payload that is not JSON: {');
  expect(refused(one([{ key: "feynman.step", value: { stringValue: "fly" } }]))).toBe('span "apply" (Store, 0123456789abcdef) has Store take fly, which Store has no action or step named: it has put, putLost');
  expect(refused(one([{ key: "feynman.step", value: { stringValue: "put" } }, { key: "feynman.message", value: { stringValue: "Ballot" } }]))).toContain('span "apply" (Store, 0123456789abcdef) names message Ballot');
});
