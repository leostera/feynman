# RFD0012 - A smaller core

- Feature Name: `smaller-core`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-30`
- Updated: `2026-10-30`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

The engine and the checker know actors, messages, steps, budgets, properties and fairness,
and nothing else. Faults stop being built in. Losing a message, failing a call, duplicating a
message and crashing an instance become ordinary steps that the spec declares, made by small
library functions written with the public DSL:

```ts
import { crash, defineBudget, lose } from "@leostera/feynman";

// One fault per path, shared by every fault below: what `--faults 1` meant.
const faults = defineBudget("faults", { total: 1 });

const Bank = defineActor({
  name: "Bank",
  // …
  transitions: {
    charge: { on: Charge, description: "Charges the customer and answers.", sends: [Charged], run(state, msg, ctx) { … } },
    chargeLost: lose(Charge, { spend: faults }),        // the request never arrives: the client's call fails
    crash: crash({ keeps: ["seen"], spend: faults }),   // was `durable: ["seen"]` and a built-in restart
  },
});

const Client = defineActor({
  name: "Client",
  // …
  actions: { pay: atMost(2, { label: "Pay", … }) },     // was `--repeats 2`, for every action of every spec
  transitions: {
    charged: { on: Charged, … },
    chargedLost: lose(Charged, { spend: faults }),      // the answer is lost: the call fails after the bank charged
    chargeFailed: { on: failed(Charge), … },
  },
});
```

Four things the core does today go: the built-in lose and restart steps, `durable`, the
`--faults` budget and the `--repeats` bound. In their place come three primitives a step can
use (`ctx.reset`, `ctx.redeliver`, `ctx.fail`), one counted resource (`defineBudget`), and one
relaxation: several steps of an actor may be on one message, and the checker tries each.

## Motivation

### The core imposes one fault model on every system

The checker loses any message in flight and restarts any instance that is not a singleton,
within one global budget (`--faults 1`). That is one model of failure, chosen for the user:

- **It is wrong for many systems.** A message on a TCP connection is not lost on its own
  while the connection lives; a write to a Durable Object's storage is not lost after it
  returns; a singleton service does crash. A spec cannot say any of this today. It can only
  turn faults off for the whole check with `--faults 0`.
- **It misses faults that matter.** Duplicated deliveries (at-least-once queues), a call
  that throws after doing its work, a crash between two writes, a clock that jumps: none can
  be written, because faults are not steps the author can write.
- **It is invisible in the spec.** A reader cannot see which faults a verdict covers; they
  are a CLI flag, and the same spec gives different verdicts under different flags.

The user's direction for the core: Feynman should *let* an author build faults, not impose
them.

### Five concepts do the work of one

Faults reach into every layer, each with its own special case:

| Concept | Where it is special-cased |
| --- | --- |
| Lose | `engine.lose`, `losable`, `failureFor`, the `lose` choice and event kind, walks' fault weight, the playground's "Lose it" and "Fail the call", `s.drop` |
| Restart | `engine.restart`, `durable`, the `restart` choice and event kind, "singletons do not restart", the playground's restart, `s.restart` |
| Call failures | `failed:` keys produced by `lose`, the restart dropping failures in flight |
| Fault budget | `Bounds.faults`, a slot in every integer state vector, `--faults`, `check.faults` |
| Repeats | `Bounds.repeats`, a counter per (instance, action) in every state vector, `--repeats`, walks' `repeats * 2` |

The integer core (`src/check/integer.ts`) alone has 81 lines about faults, losses, restarts,
failures or repeats. Every
new kind of fault would add a sixth row. Meanwhile the TLA+ and P oracles, written
independently of Feynman, already model every one of these as a plain action with a plain
counter (`Lose(m) == faults < Faults /\ …`, `Pay == pays < Repeats /\ …`): the 27 TLA+
oracles have `Faults` and `Repeats` as ordinary constants. The checker is the only place
where they are special.

### Bounds that live outside the model surprise people

`--repeats 2` bounds every action of every instance, silently. A bug that needs a third
retry is "held" until someone thinks of raising it, and nothing in the spec says the bound
is there. A bound written in the model (`atMost(2, …)`) is read with the step, reviewed
with it, and changed with it.

## Goals

- The engine and checker have no notion of losing, restarting, failing or repeating; each is
  a library step built only from public DSL and `ctx`.
- A spec says which faults it covers, in its own text, and its verdicts do not depend on CLI
  flags other than search limits (depth, states, time, memory).
- New faults (duplicates, a throw after the work, a crash between two writes) need no change
  to the core.
- Verdicts and distinct-state counts stay exact against the TLA+ and P oracles, after the
  examples declare the faults their oracles model.
- The integer core gets smaller: budgets replace both the fault slot and the repeat counters.

## Non-goals

- Changing how messages are delivered (any order, a bag) or how fairness works (RFD0006).
- Immutable handlers. Steps keep mutating `state` in place.
- A library of every fault in the literature. This RFD ships five factories; others can be
  written in a spec, or added later, with no core change.
- Keeping 0.14 specs checking the same without edits. Specs that relied on built-in faults
  must declare them; the migration is mechanical, and check says when a spec has none.

## Guide-level explanation

### Faults are steps you declare

A fault is a step like any other: it has a name, it is on a message or on nothing, it
changes state and sends messages. Two things mark it as a fault: it is never fair (the
network may stop failing; RFD0006), and it says `fault: true`, so reports can count faults
("needs no faults") and prefer counterexamples with fewer of them. The library makes the
common ones:

| Factory | A step that… | Was |
| --- | --- | --- |
| `lose(M)` | is on `M` and takes it out of flight. If `M` is a call, or a reply that answers one, the caller gets `failed(Call)`. | the built-in lose |
| `duplicate(M)` | is on `M` and puts it back twice: it will be delivered once more. | (impossible) |
| `throws(Call)` | is on `Call`, runs the receiver's step for it, then fails the call instead of replying: the work is done, the caller is told it failed. | lose the reply |
| `crash({ keeps })` | is on nothing, and resets the instance to its initial state, keeping the fields in `keeps`; its timers and the failures on their way to it are gone. | restart + `durable` |
| `atMost(n, step)` | is `step`, taken at most `n` times by each instance on a path. | `--repeats` |

Each takes `{ spend: budget }` to draw from a budget, and passes through `description`,
`when` and `sources` (a crash may point at the code that recovers).

Because faults are steps on the actor they happen to, a reader sees them where they act:
the bank can lose a charge, the client can lose an answer, the cache can crash and keep
nothing. A spec with no faults says so, and `feynman check` says it too:

```
Payments: explored 55 states …
  ! no faults: every path has a perfect network and no crashes. Declare the ones the system can meet, like lose(Debit) or crash().
```

### Several steps on one message

An actor may now have several steps on one message. When the message is in flight, each is
a way it can be taken, and the checker tries each. This is what lets `lose(Charge)` sit
beside `charge`. It is also useful beyond faults: a message the code handles one of two
ways, depending on something the model leaves out (a cache hit or miss), is two steps
rather than a `random()` inside one.

The fair step, if there is one, is what "left alone" means: `s.settle()` and the
playground's Play deliver to it. At most one step on a message may be fair; the others must
be `fair: false`.

### Budgets

A budget is a counted resource a step spends: `defineBudget("faults", { total: 1 })` is one
fault on any path, shared by every step that spends it; `{ each: 2 }` is two per instance.
A step whose budget is spent is not possible. Budgets live in the world beside the
instances, so the checker counts them as state, as the oracles' counters are.

`feynman check --budget faults=2` checks with a budget raised, the way `--faults 2` did;
`--budget` names one of the spec's budgets, so it cannot bound something the spec does not
bound.

### Calls

A call (`defineCall`) is still a message whose failure can reach the caller, handled by a
step on `failed(Call)`. What changes is where failures come from: only steps that call
`ctx.fail()`, which `lose` and `throws` do. So `defineSpec`'s rule becomes: a call that some
step can fail must have its failure handled by every sender. A call nothing can fail needs
no failure step.

### Scenarios and the playground

- `s.deliver(who, M)` delivers `M` to its fair step, as today.
- `s.step(who, "chargeLost")` takes a named step: on a message, the oldest one in flight it
  is on; on nothing, the step itself. It replaces `s.drop(who, M)` and `s.restart(who)`,
  which go.
- The playground shows a message in flight with every step that can take it ("Deliver",
  "Lose", "Deliver twice"), and an instance's fault steps (Crash) beside its other steps.
  The fault tag in the timeline comes from the step's `fault: true`.

## Reference-level explanation

### Data model

- `StepInfo` gains `fault: boolean` (defaults to false) and `spend: { budget: string }[]`.
- `Spec` gains `budgets: { name: string; scope: "total" | "each"; amount: number }[]`.
- `ActorInfo.transitions` is keyed by step name, no longer by message key; each transition
  carries `message?: string`. The engine finds the steps on a message by an index built once
  at assembly (`stepsOn[actor][messageKey]`).
- `World` gains `budgets: Record<string, number>` for total budgets and, per instance,
  `spent: Record<string, number>` for each-instance budgets.
- Removed: `ActorInfo.durable`, `Bounds.faults`, `Bounds.repeats`, event kinds `lose` and
  `restart`, `Choice` kinds `lose` and `restart`.

### The three primitives

All three are available in any step's `ctx`, and are what the factories are built from:

- **`ctx.reset({ keeps })`**: the instance's state becomes its `initialState`, with the
  fields in `keeps` carried over; its timers are cancelled; failures in flight to it are
  dropped (the calls that would have thrown went with its memory). This is today's restart,
  moved from the engine to a step.
- **`ctx.redeliver()`**: in a step on a message, puts that message back in flight, with the
  same sender, payload and the call it answers. Calling it twice makes two copies.
- **`ctx.fail()`**: in a step on a call, sends `failed(Call)` with the request's payload to
  the caller instead of a reply; in a step on a reply that answers a call, sends
  `failed(Call)` to the caller itself. Anywhere else, it is a spec error. A step that calls
  `ctx.fail()` declares it with `fails: [Call]`, as `sends` declares messages, so the
  checker and `defineSpec` know which calls can fail without running anything.
  `ctx.answering` says whether the message being handled is a call or answers one, so a step
  can tell whether `ctx.fail()` applies to this delivery.

### The factories

Each is a few lines over the public API, in `src/spec/faults.ts`, exported from the package.
For example:

```ts
export function lose<M extends AnyMessage>(message: M, options: FaultOptions = {}): StepDef<unknown, M> {
  return {
    on: message,
    description: options.description ?? `${message.name} is lost on the way.`,
    fault: true,
    fair: false,
    spend: options.spend ? [options.spend] : [],
    fails: callOf(message),             // the call it is, or the call it may answer; none for a plain message
    run: (_state, _msg, ctx) => void (ctx.answering ? ctx.fail() : undefined),  // a plain message just goes
  };
}
```

`throws(Call)` reuses the receiver's fair step on `Call`: it runs that step's `run` with a
`ctx` whose `reply` is recorded but not sent, then calls `ctx.fail()`. It is a factory over
the actor's own step, so it is written `throws(Charge, { spend: faults })` inside the
receiver and resolved at assembly.

### Checking

- **Choices.** A message in flight offers one choice per step on it, where the step's
  `when` and budget allow. Timers, guards and actions are unchanged. There is no other kind
  of choice.
- **Budgets in the integer core.** The state vector's fault slot and per-(instance, action)
  counters are replaced by one slot per total budget and one per (instance, each-budget).
  Specs without budgets have none, so their vectors are shorter than today's.
- **Fewest faults.** A counterexample's faults are its events from `fault: true` steps.
  `withFewestFaults` searches again with fault steps capped at 0, 1, … as today, now as an
  internal option rather than the `faults` bound.
- **Walks** weight `fault: true` steps as they weight faults today.
- **Liveness** needs nothing: fault steps are `fair: false`, so a fair behaviour never
  requires one.
- **Symmetry** and the reductions see budgets as state, permuted with their instances.

### What `defineSpec` checks

- At most one fair step per (actor, message); the others are `fair: false`.
- Every budget a step spends is one of the spec's budgets (found from the steps, as messages
  are, so it need not be listed).
- A call that some step declares in `fails` has a step on `failed(Call)` in every actor
  that sends it.
- `fault: true` steps are `fair: false`.

### Invariants

- The engine's step function is the only way the world changes; there is no other entry
  point for faults.
- A budget never goes below zero; a step whose spend would make it negative is not offered.
- A failure is only ever sent by a step that declares the call in `fails`.

### Compatibility and migration

This breaks every spec that relied on built-in faults or on `--repeats`, which is most.
Release it as 0.15 with a Migrating section:

1. `durable: ["codes"]` on an actor that could restart becomes
   `crash: crash({ keeps: ["codes"], spend: faults })` in its transitions.
2. For each message the system can lose, add `lose(M, { spend: faults })` to the receiver.
   For calls, losing the request and losing the answer are both `lose` steps: one on the
   call at the callee, one on the reply at the caller.
3. `const faults = defineBudget("faults", { total: 1 })`, and `--faults N` becomes
   `--budget faults=N`.
4. Actions that relied on `--repeats` to stop get `atMost(n, …)`.
5. `s.drop(who, M)` becomes `s.step(who, "<lose step>")`; `s.restart(who)` becomes
   `s.step(who, "crash")`.

Loading a spec that uses `durable`, or running `check --faults`/`--repeats`, says what
replaced it.

### Rollout and validation

1. Budgets, `fault`, `spend` and the three primitives, beside the built-in faults.
2. The factories, with unit tests per factory against the built-in behaviour they replace.
3. Several steps per message: transitions keyed by name, the `stepsOn` index, choices per
   step.
4. Migrate the examples one at a time, declaring exactly the faults and bounds their TLA+
   and P oracles model; state counts and verdicts must match the oracles exactly. Then the
   tests, fixtures and the fuzzer's specs (the fuzzer generates fault steps and budgets).
5. Remove the built-in lose and restart, `durable`, `Bounds.faults`, `Bounds.repeats`, the
   CLI flags and config keys, and their branches in the integer core, walks and views.
6. Update the playground, the skill, the README and the site; release 0.15.

Measure the integer core before and after on the benchmark suite: fewer slots per vector
should make it no slower; a regression blocks step 5.

## Drawbacks

- **Specs get longer.** Today faults cost nothing to write. After this, a spec that wants
  the old coverage names each lose step and crash. That is the point (the coverage is
  visible), but it is more to write, and an agent that forgets faults gets a spec with a
  perfect network. The "no faults" warning and the skill are the mitigation.
- **Exact old coverage is verbose.** The built-in model loses every message type and
  restarts every non-singleton. Reproducing it means a `lose` per message type. A helper
  (`losesEvery(actor)`) could do it, but would bring back the imposed model this RFD
  removes; it is left out.
- **Several steps per message weakens a check.** RFD0011 rejected two steps on one message
  as a likely mistake. It becomes "at most one fair step", which still catches the common
  mistake (two real handlers) but not two unfair ones.

## Rationale and alternatives

### Proposed design

Faults as steps uses the one mechanism the checker already explores well, the one the
oracles already use, and the one an author can extend. Budgets replace two special counters
with one general one.

### Keep built-in faults, add switches

`faults: { lose: [Charge], restart: [Bank] }` on the spec, interpreted by the engine. This
keeps faults special in every layer, and every new kind of fault is a new switch and a new
engine branch. Rejected.

### Budgets as actor state

`atMost` could count in a hidden field of the actor's state. A total budget shared across
actors cannot: a step changes only its own actor's state. A fault actor holding the budget
would need a message per spend, adding events to every counterexample. Budgets in the world
are one integer each, which the integer core already stores for faults today.

### Faults on a network actor

Losing a message could be a step of a library `Network` actor that every message passes
through. Every send would then be two hops, doubling the events of every trace and the
states of every search. Rejected: a step on the receiver is the same fault with no extra
hop.

### Keep `--repeats` as a default

A default bound on actions keeps specs short, but bounds behaviour silently; the oracles
show it as one more counter. `atMost` keeps it explicit; the depth bound still keeps
searches finite.

## Prior art

- **TLA+**: faults are actions in `Next`, with counters as variables and constants for the
  bounds, as in this repository's oracles.
- **P**: failure injection is written as machines and nondeterministic choices (`$`), not
  built into the runtime.
- **Jepsen** and **FoundationDB's simulation**: faults are injected by a "nemesis" or
  simulator configured per test, which is the imposed model this RFD moves away from, for
  model checking.

## Unresolved questions

### Before acceptance

- Should `throws(Call)` exist in the first cut, or is `lose` on the reply (the bank does the
  work, the answer is lost) enough for today's examples?
- Names: `crash` or `restart`; `atMost` or `upTo`; `defineBudget` with `total`/`each`?

### During implementation

- Whether the playground shows fault steps on the node or only on hover.
- How `withFewestFaults` caps fault steps cheaply in the integer core without bringing back
  a fault slot.

### Out of scope

- Faults in time: clock skew, timers firing late. Timers already fire at any moment.
- Partitions as one step that loses everything between two zones.

## Future possibilities

- More factories: `partition(zoneA, zoneB)`, `stale(read)`, `slowDisk`.
- Budgets for things other than faults: retries per payment, people per scenario.
- A coverage report: which fault steps ever ran in the search, as `never ran` does for
  steps today.
