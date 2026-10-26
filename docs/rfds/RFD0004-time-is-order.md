# RFD0004 - Time is the order of events

- Feature Name: `time-is-order`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-26`
- Updated: `2026-10-26`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

By default, specs do not model real time. There is no clock, no message latency, and no
timer duration: what happens next is any event that is pending, a message in flight or a
timer that is set, in any order, so a run is the interleaving of the actors' steps. A timer
means "this may fire at any moment from now on", which is what a timeout is once networks,
pauses and clocks are allowed to be slow. As in TLA+ and P, a spec that needs time models
it itself, with state and events. The engine, the checker, the simulator and the timeline
all count events instead of milliseconds.

## Motivation

Specs model timing in two ways today, and neither pays for itself.

1. **Durations mostly decide nothing the checker should trust.** The checker already lets
   any message overtake any other, and lets a timer fire before a slow reply (that is how
   the payments and job-queue bugs appear). What durations add is an ordering between
   timers: a 10-second heartbeat "always" renews a 30-second lease. Real systems break
   exactly that assumption (a GC pause, a suspended laptop, a clock step), so a spec that
   relies on it hides the bug the reader came to find.
2. **Time is expensive.** A world that read `ctx.now` can no longer be merged with one that
   differs only in when it is, so specs that touch the clock explore up to 1.6 times the
   states TLC finds for the same system. The engine keeps a clock, the checker keeps due
   times, ordering rules for simultaneous events, a timing condition in its partial-order
   reduction, and a stamp in every state key. All of it is code that has been wrong before.
3. **It makes reading harder.** Timelines say "1:51.2" where the reader wants "event 42";
   the simulator waits ten real seconds for a heartbeat; heartbeats exist in specs only to
   keep a lease alive. Axo's spec just removed its heartbeats for this reason.
4. **The oracles already agree with this.** The TLA+ models of payments and the job queue
   say a timer "may fire whenever it is set". Feynman reaches their verdicts and
   counterexample lengths today; without time it should reach their exact state counts too.

## Goals

- One notion of progress: events, in an order. Nothing in a spec, a trace or the views is
  measured in milliseconds.
- Timers that keep their meaning (a retry, a timeout, an expiry) without a duration.
- Exact agreement with TLC on distinct states for every example with a TLA+ model.
- A simpler checker: no clock in state keys, no due times, no timing rule in sleep sets.

## Non-goals

- Checking quantitative claims ("the timeout is longer than three heartbeats"). Those need
  a timed model (timed automata, UPPAAL); a spec can still record the real values as text.
- Keeping old specs running unchanged. The DSL changes; the type checker points at every
  place to fix, and the skill says how.
- Fairness beyond what "left alone" already gives `eventually` (below).

## Guide-level explanation

### Writing timers

A transition starts a timer by name, without a duration, and may cancel it:

```ts
[Granted]: {
  description: "Holds the lock, then stalls before writing.",
  starts: ["write"],
  run(state, msg, ctx) {
    state.token = msg.token;
    ctx.start("write");
  },
},
write: {
  description: "Wakes up and writes, sure it still holds the lock.",
  after: "2 seconds, a GC pause",
  sends: [Write],
  run(state, ctx) { … },
},
```

`after` is optional text for readers, shown in the reference and the timeline's details: the
real value from the code, so nothing true is lost. It has no effect on what can happen.

Things a spec measured with the clock become state and events. A lease no longer compares
`ctx.now` with `until`; the server starts an `expire` timer when it grants the lock and
treats the lease as running until that timer fires. A pairing code that expires after ten
minutes has an `expire` timer; a code typed before it fired works, after it fired fails, and
the checker tries both.

### Modelling time when it matters

When the code's correctness does rest on time (a lease that a single clock enforces, a
deadline counted in ticks), the spec says so in its own state, as a TLA+ or P model would:
a `Clock` actor whose `tick` action advances a counter, steps that compare against it, and
a bound on ticks in the checker's repeats. Time is then part of the model, visible in the
state, and the checker explores it like anything else. Nothing in Feynman is special about it.

### Scenarios and "left alone"

A scenario's `settle()` runs the system **left alone**: every message in flight arrives, in
the order it was sent; when none is in flight, the timer set earliest fires; and so on,
until nothing is pending or 200 events have run (a retry loop never ends by itself).
Messages before timers is the one ordering assumption left, and it is only about what
happens when nobody interferes: timeouts are slower than the network unless something goes
wrong. `eventually` is judged on the same left-alone run.

To make a timer fire early (the network was slower than the timeout), a scenario says so:
`s.fire(who, "retry")`. `s.wait(ms)` and `settle(horizon)` are gone.

### What readers see

- The timeline numbers events (`#42`) and groups what happened between two actions.
- The simulator plays a number of events per second (¼, 1, 5, 25), each message flying for
  the same short time. Timers that are set show on their instance as small chips, like
  messages in flight, and can be fired by clicking them, as messages can be delivered.
- Tokens lose `expires` and their countdown; an expiry is a timer like any other.

## Reference-level explanation

### Architecture and boundaries

The change runs through every layer, and removes code from each:

| Layer | Today | After |
| --- | --- | --- |
| DSL (`src/spec/dsl.ts`) | `ctx.now`, `ctx.start(name, ms)`, `message({ latency })`, `SEC`, `MIN`, token `expires`, `eventually.within`, `s.wait`, `s.settle(horizon)` | `ctx.start(name)`, `ctx.cancel(name)`, `after?: string` on timer transitions, `s.fire(who, timer)`, `s.settle()` |
| Engine (`src/spec/engine.ts`) | `World.clock`, `Pending.at`, latency per message, `stamped` | `Pending.seq` (order of creation); no clock |
| Checker (`src/check`) | due times, simultaneous-event branches, time in keys, timing rule in `commute` | every pending event is a branch; keys are the world without times |
| Views (`src/view`) | clock, speed in ms, flight progress from `at` and latency | event index, events per second, fixed flight duration |

### Data model and interfaces

- `Pending` loses `at` and gains `seq: number`, the order it was created in. Left alone,
  deliveries go in `seq` order, then timers in `seq` order.
- `World` loses `clock`. `WorldView.now` is removed; `WorldView.quiet` stays.
- `TraceEvent` loses its time; its index is its time.
- `defineLimit` stays: limits are named values from the code (sizes, counts, and durations
  as text), shown in the reference. A limit used as a number in a spec is a count.

### Lifecycle and failure semantics

Starting a timer that is set restarts it (one pending entry per instance and name, as
today). A restart of the instance clears its timers. Losing a message and restarting an
instance are the same faults as today, within the same budget.

### Invariants

- Nothing a spec can observe depends on when an event happens, only on which events
  happened before it.
- Two worlds with the same states, pending events (up to `seq`), acts and faults are the
  same state.
- Left alone, a world reaches the same result every time.

### Compatibility and migration

None. Feynman is at 0.x, so this is a clean break: `SEC`, `MIN`, `ctx.now`, durations in
`ctx.start`, `latency`, `expires`, `within`, `wait` and `settle(horizon)` are removed, and
specs that use them stop type-checking.

Everything that uses time is rewritten without it: the examples (the lease lock models its
lease with an `expire` timer), the test fixtures, the skill, the site's snippets, and the
specs of the published simulators (axo, and Seba's pipeline if it is published). The
examples' hand-worked counterexamples are redone and the tests updated, and the oracles must
then agree with TLC on distinct states exactly. Specs in other repositories are rewritten in
copies, for their owners to take.

### Rollout and validation

1. Engine and DSL, with the examples migrated; `bun run test` and `bun run oracles`, now
   comparing distinct states exactly with TLC on every example.
2. Checker simplifications, measured on the examples and a migrated copy of axo's spec in
   `/tmp`: states and states per second before and after.
3. Views: timeline, transport, timer chips.
4. The skill and the site.

## Drawbacks

- Specs lose the ordering durations gave for free. When the code genuinely relies on one
  (it re-sends before the server gives up, on one machine with one clock), the spec has to
  say so with state, or accept the counterexample as a real risk. Usually it is one.
- Every existing spec breaks.
- "Left alone" puts messages before timers. A system that is only correct when a timer
  fires before a reply arrives is judged incorrect by `eventually`; the search still finds
  every ordering.

## Rationale and alternatives

### Proposed design

Untimed, with timers as events that may fire at any moment, is the standard model in TLA+,
P and most protocol checkers, and it matches how Feynman's oracles already model these
systems. It removes the only part of the engine and checker that is about numbers rather
than structure.

### Simpler or narrower approach

Keep durations in the DSL and ignore them everywhere. It breaks nothing, but leaves specs
saying things that are not true of the model, and keeps the view's clock.

### Other alternatives considered

- **Logical clocks per actor** (Lamport): orders without durations, but adds state to every
  key and explains nothing a reader needs.
- **Timer priorities** ("heartbeat before expiry"): reintroduces durations under another
  name.

### Do nothing

Keep paying for time in states, code and reading, for orderings the checker should not trust.

## Prior art

- TLA+ specifications model timeouts as actions enabled while a timer is set.
- P models timers as machines that may send a timeout event at any point.
- Feynman's own oracles (`examples/oracles/Payments.tla`, `JobQueue.tla`).

## Unresolved questions

### Before acceptance

- Is "messages before timers" the right order for left alone, or should `settle` deliver
  messages only, and timers fire only when a scenario fires them?
- Should transitions return the next state instead of changing the one they are given
  (comment on the guide's example)? See "Transitions that return the next state" below.

### During implementation

- The step cap for `settle()` and left-alone runs (200 is a guess).
- How timer chips look in the simulator, and whether `after` text shows on them.

### Out of scope

- Timed checking.

## Transitions that return the next state

Raised in review: `run(state, msg, ctx)` changes `state` in place; TLA+ and P instead
describe the next state, which makes each transition's effect explicit. Two things to weigh:

- **Seeing what changed does not need it.** The engine already copies the stepping
  instance's state before a step and freezes the result, so a step cannot reach any other
  state, and every step's changes are recorded field by field (the timeline's
  `asking: false → true`). What a reader sees would not change.
- **Writing would.** Returning `{ ...state, token: msg.token }` is as clear for flat state,
  and noisier for nested state (`{ ...state, hosts: { ...state.hosts, [id]: { ...state.hosts[id], online: true } } }`),
  which most real specs have. Two styles at once (mutate, or return) would be the worst of
  both.

Proposal: keep this RFD to time, and decide the transition style in its own RFD with a
migrated example of each kind (the lease lock, and axo's relay) to compare side by side.

## Future possibilities

- With time gone, a trace is a sequence of events, which makes comparing traces between
  commits (RFD0005) a sequence alignment with no timing noise.
