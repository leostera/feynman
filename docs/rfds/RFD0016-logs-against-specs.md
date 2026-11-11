# RFD0016 - Logs against specs

- Feature Name: `conform`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-11-21`
- Updated: `2026-11-22`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

`feynman conform <spec> <log.jsonl>` answers whether a log of what the system did is a run of
the spec:

```sh
feynman conform book/specs/15-triage/2-one-statement.ts book/specs/15-triage/two-holds.jsonl
```

A log is one JSON object per line. Spawns come first, then one line per step:

```jsonl
{"kind":"spawn","actor":"Person","label":"Alice"}
{"instance":"Alice","key":"hold"}
{"instance":"Box office","key":"hold","from":"Alice"}
```

When some run of the spec shows the log's steps in order, `conform` says so, with that run and
the properties it breaks. When none does, it gives the first line no run can match, with what
the spec could have done there instead. Up to `--gap` (4) steps the log doesn't show may come
between two it does: faults, and the steps of actors that don't log.

A trace works too: OpenTelemetry's OTLP JSON, Jaeger's JSON, or Zipkin's. A span is a step
when it has a `feynman.step` attribute, or when a mapping module (`--map`) says it is one.
The trace gives who took each step, who sent its message, and what caused what. Machines'
clocks disagree, so a trace is a partial order, and it conforms when some order that keeps
it is a run.

## Motivation

A check answers one question: does everything the spec allows keep the properties? It can't
answer the other: does the spec allow what the system does? A spec that leaves something out,
or splits one statement into two steps, keeps its properties for the wrong reason (chapter 15
of the book), and only reading the code catches it today.

The system can answer that itself. It already logs what it does. If a log from a test run or
from production is not a run of the spec, then either the system did something the spec says
is impossible, or the spec is wrong about the system. Both are worth knowing. TLA+ has trace
validation for this: a specification that reads a log, checked with TLC. P has PObserve,
which runs its monitors over production logs. Feynman specs should get it without writing a
second model.

## Goals

- One command, with a log format that maps easily onto what services already log: who took
  which step, with whatever detail the log has.
- Logs are partial. Faults leave no line, some actors leave none at all, and a line may leave
  out inputs, the payload or the state. The answer must not depend on what the log doesn't say.
- When the log is a run: the run, and the properties it breaks, judged as a monitor would
  judge the live system.
- When it isn't: the line, and what the spec could have done there. A bare "no" is no use.
- Production traces, as tracing systems store them, with no rewriting: OpenTelemetry first,
  since everything else can be converted to it, plus Jaeger and Zipkin, which their UIs
  download.
- No trust in clocks across machines.
- An oracle: TLC must agree on which logs are runs, in order and as partial orders.

## Non-goals

- Reading a system's own log format. Mapping its lines to step keys and instance labels is
  the system's job: a few lines of `jq` or a logging adapter. Traces are the exception, since
  their format is standard.
- Vector clocks and other causality metadata beyond what traces carry (parents and links).
- OTLP protobuf. The Collector converts it to JSON.
- Liveness. A log is finite. `eventually` and `leadsTo` have nothing to judge on it.
- Streaming. `conform` reads a whole file.

## Reference-level explanation

### The log

`parseLog(text, spec)` reads JSON Lines and skips blank lines. A line is one of these:

- a spawn, `{"kind":"spawn","actor":A,"label":L}`, for an actor that is not a singleton. All
  spawns come before the first step, because they make the world the log starts in. With
  `--instances`, some instances are there before the spawns.
- a step, `{"instance":I,"key":K}`, where `I` is an instance's label or id and `K` is an action
  or step of its actor. A step line may add:
  - `kind`: `action`, `deliver`, `timer` or `guard`;
  - `inputs`: an action's inputs, which need not be among the values the checker tries;
  - `message`: an id, a key, or a name in words;
  - `from`: the sender;
  - `payload`: compared whole;
  - `state`: the fields given must be in the instance's state after the step. A pattern
    matches when every field it names matches.

A line that is not JSON, names something the spec doesn't have, or has a field the format
doesn't know is a `LogError` that gives its line number. A log and a spec that don't fit each
other in their names is a broken input, not a log that doesn't conform.

### Traces

`readSpans(text)` reads any of three formats into one span shape: trace, span and parent ids,
links, name, kind, start and end in nanoseconds, attributes, and the resource's attributes.
`traceFormat` tells them apart:
- OTLP JSON: an export request with `resourceSpans`, or JSON Lines of them as the file
  exporter writes. Tempo's `{trace: {resourceSpans}}` and `{batches}` are read too.
  Attribute values are unwrapped, with `intValue` (a string) read as a number, and base64
  ids converted to hex.
- Jaeger: `{data: [{spans, processes}]}`, with `CHILD_OF` as the parent and other
  references as links.
- Zipkin v2: a list of spans, or a list of traces.

`traceLog(spans, spec, { map, traceId, order })` turns spans into log events:

- **Which spans.** A span with `feynman.step` stands for the line its `feynman.*` attributes
  make: `instance`, `actor`, `kind`, `message`, `from`, and `inputs`, `payload` and `state`,
  each either as JSON or field by field (`feynman.payload.value`). Otherwise the mapping, a
  module whose default export (`defineTraceMapping`) takes a span and returns a line or
  `undefined`, decides. Every other span is skipped.
- **Who.** `feynman.instance`, else the resource's `service.instance.id`, else its
  `service.name`. An instance that isn't a singleton is spawned from `feynman.actor`, set on
  the span or on the resource.
- **The sender**, for a step on a message that doesn't say who sent it: the nearest span up
  the parents whose instance is another of the spec's. Spans of services the spec doesn't
  know, like gateways, are passed over. Failing that, the same search runs across the
  links, as a queue's consumer span links to its producer's.
- **The order.** By default, a step comes after the step before it on its own instance (by
  that instance's clock, ties broken by depth) and after the nearest step it descends from
  or links to. The steps are written in an order that keeps those constraints, earliest
  first, and each one lists them as `after`. With `order: "time"`, the steps are in one
  order: by start time, but never before a span they descend from. A cycle is an error.

A step's `at` names its span (`span "POST /hold" (Box office, 6d52743cd3587feb)`), and reports
use it in place of a line number.

### Partial orders

Any log, from a trace or a JSON Lines file, may give a step `after: [lines]`. If any step does,
the log is a partial order. A step may then be matched once every step it lists has been, and
the log conforms when some order that keeps all the `after` constraints is a run. The search
node holds the set of steps matched, one bit each, in place of a count. For a log in order,
the only step ready is the next one, as before.

### The search

`conform(spec, log, options)` searches breadth first over (world, lines matched, unlogged
steps since the last match). Two kinds of step leave a node:

- a step that matches the next line: the line's instance takes the line's action or step, and
  the event it makes agrees with every field the line gives. The lines matched go up by one,
  and the gap is reset.
- a step the log doesn't show, while the gap is under `--gap`. Unless `--logs-faults`, these
  are the faults (steps tagged `fault`: losses, duplicates, crashes), plus every step of an
  actor named in `--unlogged`.

A step that fails in the spec matches nothing. Every complete reading matches all the lines,
so the first one breadth-first search reaches has the fewest unlogged steps. That is the one
`conform` reports. Others may differ in those steps.

There are three results:

- **conforms**: the run, which line each event came from (`undefined` for unlogged), and the
  properties broken on it. `always` and `everyStep` properties are judged at each world and
  step. `never` properties are judged on each prefix of the run.
- **mismatch**: the furthest reading, and the line after it. With it come three lists:
  - `near`: what the line's instance can do there under the same step name, with another
    message, sender, payload or state;
  - `could`: everything else that can happen there;
  - `errors`: the errors the logged step meets.
- **limit**: past `--max-states` (200,000) nodes, undecided.

Exit codes: 0 when the log conforms and breaks nothing, 1 otherwise. `--json` gives the same
as structured data, and `--as-scenario` writes the run as a `defineScenario`, with a comment on
each step giving its line, or saying the log doesn't show it.

### Tests

- `test/check/conform.test.ts` lists, for `orderedWrites` with and without faults, every path
  of up to six steps without merging worlds. It writes each path as the log it would leave
  and checks that `conform` accepts exactly those logs, out of every one-line change to
  each.
- Random runs of five examples, with some lines giving the state, must conform, with no more
  unlogged steps than the run had faults.
- `test/examples/conform.oracle.ts` writes a TLA+ trace module over the independent
  `OrderedWrites.tla` for each log. A logged step matches a line once every line before it
  has been matched, a loss may happen anywhere, and TLC reaches the end of the log exactly
  when the log is a run. The logs number 160, and half are partial orders that keep only
  each machine's order, with the store's lines written first, so the written order is
  never a run. Per configuration, TLC and `conform` agree on 10 accepted and 10 rejected
  logs of each kind. Two mutations make them disagree: one ignores values in the trace
  module, the other reads a partial order as written.
- `test/check/trace.test.ts` renders random runs of four examples as OTLP, Jaeger and Zipkin
  traces. Spans are shuffled, each machine's clock is off by up to 50ms (steps are 1ms
  apart), and gateway spans sit between sender and receiver. Each trace must name every
  step of its run, never put a step after one the run took later, and conform. With
  agreeing clocks, `order: "time"` must read the run back exactly. With skewed clocks it
  gets the order wrong for most runs, which is why the default ignores clocks.
- The same file has the OpenTelemetry SDK's own export of a traced ordered-writes system:
  the run it reads, the property it breaks, and on an ordered channel the span where it
  leaves the spec. Mappings, links, `--trace` and refused spans are covered too.
- The fuzzer writes random runs as partial orders, shuffled, with faults left out, and
  checks that they conform. A mutation that reads them as written is caught.

## Drawbacks

- The gap bounds what the log may leave out. Too small, and a real run is rejected. Too large,
  and the search grows with every fault the spec has. A log with long silences needs
  `--unlogged` and a larger gap.
- Only the reading with the fewest unlogged steps is reported. If another reading breaks a
  property and this one doesn't, `conform` doesn't say so.
- Names must be the spec's: step keys and instance labels. A system whose logs are named
  otherwise needs a mapping, and the mapping can be wrong.
- A partial order accepts more than the system did: any order consistent with the clocks of
  each machine and with causality. Two requests on two machines with no causal link may be
  read in either order. That is what the trace can actually show. `--order time` is
  stricter, and it is wrong when clocks are.
- A large trace with much concurrency has many orders. The search merges equal worlds, but
  `--max-states` can still be reached. `--trace ID` keeps the problem small.

## Rationale and alternatives

- **A trace spec written by hand, as in TLA+.** That is a second model to keep in step with the
  first. Here the spec is already executable, so following it is the cheaper way.
- **Exact replay, with every step logged.** Simpler, but no real log records lost packets.
  Treating faults as unlogged by default matches what systems actually log.
- **Depth-first search, stopping at the first reading.** Faster on a log that conforms, but its
  reading may be full of unlogged steps. Breadth first gives the simplest explanation, and on
  a log that doesn't conform it finds the furthest line anyway.
- **Trust timestamps by default.** Simple, and right on one machine. Across machines, a 40ms
  skew reorders a request and its reply in the book's own example. Causality is the only
  cross-machine order a trace really records.
- **A mapping language (YAML rules on span names and attributes).** A TypeScript function is
  as short for the common case, and handles the rest without a new language.
- **A monitor only: judge the properties on the log, without the spec's steps.** That is
  PObserve's model. It can't tell when the system does something the spec doesn't allow,
  and that question is the one this command exists for.

## Prior art

- TLA+ trace validation (Cirstea, Kuppe, Merz and others): a trace spec that reads a log, and
  TLC checks that some behaviour of the spec matches it. `conform.oracle.ts` is a small
  instance of it.
- P's PObserve: P monitors run over production logs.
- Runtime verification more widely, for example LTL monitors over finite traces.

## Future possibilities

- Per-machine JSON Lines logs given as separate files, read as one partial order, as traces
  are.
- Reporting every reading's broken properties, not just the simplest reading's.
- Span events (OTel's in-span logs) as steps, for systems that log several steps in one span.
- Pulling traces straight from a backend (`--from tempo://…`) rather than a file.
- Showing a log in the explorer, as a flow, with the line it leaves the spec at marked.
