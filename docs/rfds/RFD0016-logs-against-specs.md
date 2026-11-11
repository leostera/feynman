# RFD0016 - Logs against specs

- Feature Name: `conform`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-11-21`
- Updated: `2026-11-21`
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
- An oracle: TLC must agree on which logs are runs.

## Non-goals

- Reading a system's native log format. Mapping its events to step keys and instance labels
  is the system's job: a few lines of `jq` or a logging adapter.
- Timestamps, and the order of events on different machines. The log is one sequence. Merging
  per-machine logs into one, consistently with causality, comes before `conform`.
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
  `OrderedWrites.tla` for each log. A logged step must match the log's next line, a loss may
  happen anywhere, and TLC reaches the end of the log exactly when the log is a run. On 80
  logs, 10 accepted and 10 rejected per configuration, TLC and `conform` agree. A mutation
  that ignores values in the trace module makes them disagree.

## Drawbacks

- The gap bounds what the log may leave out. Too small, and a real run is rejected. Too large,
  and the search grows with every fault the spec has. A log with long silences needs
  `--unlogged` and a larger gap.
- Only the reading with the fewest unlogged steps is reported. If another reading breaks a
  property and this one doesn't, `conform` doesn't say so.
- Names must be the spec's: step keys and instance labels. A system whose logs are named
  otherwise needs a mapping, and the mapping can be wrong.

## Rationale and alternatives

- **A trace spec written by hand, as in TLA+.** That is a second model to keep in step with the
  first. Here the spec is already executable, so following it is the cheaper way.
- **Exact replay, with every step logged.** Simpler, but no real log records lost packets.
  Treating faults as unlogged by default matches what systems actually log.
- **Depth-first search, stopping at the first reading.** Faster on a log that conforms, but its
  reading may be full of unlogged steps. Breadth first gives the simplest explanation, and on
  a log that doesn't conform it finds the furthest line anyway.
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

- Merging per-machine logs into one, using vector clocks or the spec's causality: any
  interleaving consistent with each machine's order.
- Reporting every reading's broken properties, not just the simplest reading's.
- A mapping file from a service's log events to the spec's names, so `conform` can read
  OpenTelemetry spans directly.
- Showing a log in the explorer, as a flow, with the line it leaves the spec at marked.
