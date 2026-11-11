// Writes book/specs/15-triage/two-holds.otlp.json, the trace chapter 15 checks: the race of
// two-holds.jsonl, traced with the OpenTelemetry SDK, as a collector would export it. From
// packages/feynman: `bun test/book/two-holds-trace.ts > ../../book/specs/15-triage/two-holds.otlp.json`.
// Its span ids are random: the chapter quotes the ones in the file.
import { context, SpanKind, trace, type Span, type Tracer } from "@opentelemetry/api";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
const exporter = new InMemorySpanExporter();
const tracer = (attrs: Record<string, string>) => new BasicTracerProvider({ resource: resourceFromAttributes(attrs), spanProcessors: [new SimpleSpanProcessor(exporter)] }).getTracer("box-office");
const phone = (who: string) => tracer({ "service.name": "phone", "service.instance.id": who, "feynman.actor": "Person" });
const alice = phone("Alice"), bob = phone("Bob"), box = tracer({ "service.name": "Box office" });
const t = Date.UTC(2026, 10, 21, 18, 0, 0);
const at = (ms: number) => new Date(t + ms);
// The box office's clock runs 40ms behind the phones'.
const skew = -40;
const step = (tr: Tracer, name: string, attrs: Record<string, string>, start: number, parent?: Span, kind = SpanKind.INTERNAL) => {
  const s = tr.startSpan(name, { kind, attributes: attrs, startTime: at(start) }, parent ? trace.setSpan(context.active(), parent) : undefined);
  s.end(at(start + 3));
  return s;
};
const a1 = step(alice, "tap hold", { "feynman.step": "hold" }, 0);
const b1 = step(bob, "tap hold", { "feynman.step": "hold" }, 2);
const s1 = step(box, "POST /hold", { "feynman.step": "hold" }, 10 + skew, a1, SpanKind.SERVER);
const s2 = step(box, "POST /hold", { "feynman.step": "hold" }, 12 + skew, b1, SpanKind.SERVER);
step(alice, "show held", { "feynman.step": "held" }, 20, s1);
step(bob, "show unavailable", { "feynman.step": "unavailable" }, 21, s2);
process.stdout.write(JSON.stringify(JSON.parse(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(exporter.getFinishedSpans()))), null, 1));
