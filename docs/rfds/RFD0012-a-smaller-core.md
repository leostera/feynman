# RFD0012 - A smaller core

- Feature Name: `smaller-core`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-10-30`
- Updated: `2026-10-30`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

The engine and the checker know actors, messages, steps, model variables, properties and
fairness, and nothing else. Everything the core does today about failure (losing messages,
restarting instances, durable state, call failures, the fault budget, the repeat bound, and
counting the faults a counterexample needs) leaves the core, and is rebuilt as a library on
top of it, with the same public API any spec has:

```ts
import { budget, crash, defineCall, lose } from "@leostera/feynman/faults";

// One fault per path, shared by every fault below: what `--faults 1` meant. A model variable.
const faults = budget("faults", 1);

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
  actions: { pay: atMost(2, { label: "Pay", … }) },     // was `--repeats 2`, on every action of every spec
  transitions: {
    charged: { on: Charged, … },
    chargedLost: lose(Charged, { spend: faults }),      // the answer is lost: the call fails after the bank charged
    chargeFailed: { on: failed(Charge), … },
  },
});
```

The core gains four general primitives, none about failure: several steps on one message,
model variables, two `ctx` operations (`reset` and `forward`), and tags on steps. The
library builds every fault from them.

## Motivation

### The core imposes one fault model on every system

The checker loses any message in flight and restarts any instance that is not a singleton,
within one global budget (`--faults 1`). That is one model of failure, chosen for the user:

- **It is wrong for many systems.** A message on a TCP connection is not lost on its own
  while the connection lives; a write to a Durable Object's storage is not lost after it
  returns; a singleton service does crash. A spec cannot say any of this. It can only turn
  every fault off with `--faults 0`.
- **It misses faults that matter.** Duplicated deliveries (at-least-once queues), a call
  that throws after doing its work, a crash between two writes: none can be written, because
  faults are not something an author writes.
- **It is invisible in the spec.** A reader cannot see which faults a verdict covers; they
  are a CLI flag, and one spec gives different verdicts under different flags.

Feynman should let an author build faults, not impose them.

### Failure is special-cased in every layer

| Concept | Where it is special-cased today |
| --- | --- |
| Lose | `engine.lose`, `losable`, `failureFor`, the `lose` choice and event kind, walks' fault weight, the playground's "Lose it" and "Fail the call", `s.drop` |
| Restart | `engine.restart`, `durable`, the `restart` choice and event kind, "singletons do not restart", the playground's restart, `s.restart` |
| Call failures | `MessageInfo.call`, `failed:` keys made by `lose`, a restart dropping failures in flight, `defineSpec`'s "a call's failure is handled" |
| Fault budget | `Bounds.faults`, a slot in every integer state vector, `--faults`, `check.faults`, `withFewestFaults` |
| Repeats | `Bounds.repeats`, a counter per (instance, action) in every state vector, `--repeats`, walks' `repeats * 2` |

The integer core (`src/check/integer.ts`) alone has 81 lines about faults, losses, restarts,
failures or repeats, and each new kind of fault would add a row to this table. Meanwhile
the TLA+ and P oracles, written independently, model every one of these with nothing
special: a fault is an action, a bound is a variable and a constant (`Lose(m) == faults <
Faults /\ …`, `Pay == pays < Repeats /\ …`; 27 of the TLA+ oracles have `Faults` and
`Repeats` as ordinary constants). The checker is the only place where they are special.

### Bounds outside the model surprise people

`--repeats 2` bounds every action of every instance, silently. A bug that needs a third
retry "holds" until someone thinks of raising it, and nothing in the spec says the bound is
there. A bound written in the model (`atMost(2, …)`) is read, reviewed and changed with the
step it bounds.

## Goals

- The core has no notion of losing, restarting, failing, calls, budgets, repeats or faults.
  Each is library code over the public API: if the library can't build it from the core,
  the core is missing a general primitive, not a fault feature.
- A spec says which faults it covers, in its own text; its verdicts depend on no CLI flag
  other than search limits (depth, states, time, memory).
- New faults (duplicates, a throw after the work, a crash between two writes) need no change
  to the core.
- Verdicts and distinct-state counts stay exact against the TLA+ and P oracles, once the
  examples declare the faults and bounds their oracles model.
- The engine, the integer core and the views get smaller.

## Non-goals

- Changing delivery (any order, a bag) or fairness (RFD0006).
- Immutable handlers: steps keep mutating `state` in place.
- Every fault in the literature: the library ships the ones today's examples need.
- Compatibility. This is a clean cutover: the built-in faults, `durable`, `--faults` and
  `--repeats` are removed, with no shims, aliases or "this is gone" errors. The changelog's
  Migrating section says how to rewrite a spec.

## Guide-level explanation

### The core

What a spec is made of, after this RFD:

- **Actors, messages, steps, properties, scenarios**, as in RFD0011.
- **Several steps on one message.** When the message is in flight, each step on it is a way
  it can be taken, and the checker tries each. At most one is fair; that is the one "left
  alone" delivers to (`s.settle()`, the playground's Play). This is general: a message the
  code handles one of two ways, depending on something the model leaves out, is two steps.
- **Model variables**: state that belongs to the model rather than to an actor, as a TLA+
  variable that no process owns. `defineVariable("faults", 1)` is one value;
  `defineVariable("pays", 0, { each: Client })` is one per instance of Client. A step reads
  and writes them through `ctx.get(v)` and `ctx.set(v, value)` (an `each` variable resolves
  to the step's own instance), a guard reads them (`when: (state, model) => model.get(v) >
  0`), and properties read them (`w.get(v)`). They are for the model's bookkeeping, such as
  bounds and ghost history for properties, not for actors to share state the system does not
  share; the skill says so.
- **`ctx.reset({ keeps })`**: the instance's state becomes its initial state with the fields
  in `keeps` carried over, its timers are cancelled, and replies in flight to it are dropped
  (what it was waiting for went with its memory).
- **`ctx.forward()`**: in a step on a message, puts that message back in flight exactly as
  it was (sender, payload, and the request it answers). Calling it twice makes two copies.
- **`ctx.delivery`**: the message being handled, with its sender and, for a reply, the
  request it answers (`{ message, payload }`).
- **`tags`** on a step: strings the core stores and never reads, for libraries and reports.

That is all. The core has no faults, no calls, no budgets and no repeat bound.

### The faults library

`@leostera/feynman/faults` builds failure from the core. Every factory returns an ordinary
step definition (or a message, for `defineCall`), and could be written in a spec instead:

| Library | Built from | Replaces |
| --- | --- | --- |
| `defineCall(id, schema)` and `failed(Call)` | two messages: the call and its failure, a plain message `failed(Charge)` with the request's payload | `MessageInfo.call` and `failed:` keys |
| `lose(M)` | a step on `M`, `fair: false`, tagged `fault`. For a call, it sends `failed(Call)` to the caller; for a reply answering a call (`ctx.delivery.answers`), it sends `failed(Call)` to the receiver itself; for a plain message it does nothing | the built-in lose |
| `duplicate(M)` | a step on `M` calling `ctx.forward()` twice | (impossible today) |
| `crash({ keeps })` | a step on nothing, `fair: false`, tagged `fault`, calling `ctx.reset({ keeps })` | restart and `durable` |
| `budget(name, n)` and `spend` | a model variable; `spend: b` wraps a step's `when` (`b > 0`) and `run` (`b - 1`) | `--faults` |
| `atMost(n, step)` | an `each` model variable for that step, wrapped the same way | `--repeats` |

Because `failed(Charge)` is a plain message that `lose` declares in its `sends`, the core's
existing check, "every message sent has a step on it", becomes "every call that can fail has
its failure handled", with no special case. A call nothing can fail needs no failure step.

Faults sit on the actor they happen to, so a reader sees them where they act: the bank can
lose a charge, the client can lose an answer, the cache can crash and keep nothing.

### Reports

`feynman check` reads the `fault` tag, as a library would:

- a counterexample "needs no faults" or "needs 1 fault": its events from steps tagged
  `fault`;
- fewest faults first: when the shortest counterexample needs faults, check searches again
  with each budget its fault steps spend lowered, from zero up, through `--set`;
- a spec with no step tagged `fault` gets a line saying so:

  ```
  ! no faults: every path has a perfect network and no crashes. Declare the ones the system meets, like lose(Debit) or crash().
  ```

`feynman check --set faults=2` overrides a model variable's initial value, which is how a
budget is raised (`--faults 2` before). It names one of the spec's variables, so it cannot
bound what the spec does not.

### Scenarios and the playground

- `s.deliver(who, M)` delivers `M` to its fair step.
- `s.step(who, "chargeLost")` takes a named step: on a message, the oldest one in flight it
  is on; on nothing, the step itself. `s.drop` and `s.restart` go.
- The playground shows a message in flight with every step that can take it ("Deliver",
  "Lose", "Deliver twice"), and an instance's steps on nothing that are not fair (Crash)
  beside its actions. The timeline marks events from `fault`-tagged steps.

## Reference-level explanation

### Data model

- `StepInfo` gains `tags: string[]`. `TransitionInfo.message` stays; transitions are keyed by
  step name everywhere, and an index built at assembly (`stepsOn[actor][message]`) finds the
  steps on a message.
- `Spec` gains `variables: { name: string; initial: unknown; each?: string }[]`, found from
  the steps and properties that use them, as messages are.
- `World` gains `variables: Record<string, unknown>`; an `each` variable lives in its
  instance's entry (`InstanceState.variables`), so symmetry renames it with the instance.
- `Pending` keeps `answers` (the request a reply answers): it is reply correlation, which
  `ctx.reply` has always recorded, not failure.
- Removed: `ActorInfo.durable`, `MessageInfo.call`, `Bounds.faults`, `Bounds.repeats`, event
  kinds `lose` and `restart`, choice kinds `lose` and `restart`, `failed:` keys (a failure is
  `message:Charge.failed`, an ordinary message key), `engine.lose`, `engine.restart`,
  `losable`, `failureFor`, `calledBy`, `failureOf`.

### Checking

- **Choices.** A message in flight offers one choice per step on it whose `when` holds.
  Timers, guards and actions are unchanged. There is no other kind of choice.
- **Variables in the integer core.** A world's variables are encoded as instance state is:
  one slot per total variable, and an `each` variable as part of its instance's state. The
  fault slot and the per-(instance, action) counters go. A spec without variables has
  shorter vectors than today.
- **Fewest faults**, as above, re-runs the search with variables overridden: no search-time
  notion of a fault.
- **Walks** weight steps by fairness: fair steps (the system), actions (people), and other
  unfair steps (faults, rarely), which is today's weighting without naming faults.
- **Liveness** needs nothing new: fault steps are `fair: false`.

### What `defineSpec` checks

- At most one fair step per (actor, message).
- Every variable a step or property uses is defined (found by use, so none are listed).
- Every message sent has a step on it (unchanged), which now also covers call failures.

### Invariants

- The engine's step function is the only way the world changes.
- Variables change only inside steps, like instance state, and are recorded as changes.
- The core never reads a tag.

### Migration

A clean cutover, released as 0.15. The changelog's Migrating section says, for each spec:

1. `const faults = budget("faults", 1)` for the old global budget.
2. For each message the system can lose, `lose(M, { spend: faults })` on the receiver; for
   a call, one on the request at the callee and one on the reply at the caller.
3. `durable: [...]` becomes `crash: crash({ keeps: [...], spend: faults })` on actors that
   restart (and now singletons too, when they can crash).
4. Actions that relied on `--repeats` get `atMost(n, …)`.
5. `s.drop(who, M)` and `s.restart(who)` become `s.step(who, "<the step>")`.
6. `--faults N` becomes `--set faults=N`; `--repeats` has no replacement.

### Rollout and validation

1. Core: several steps per message (transitions keyed by name, `stepsOn`, choices per
   step), model variables, `ctx.reset`, `ctx.forward`, `ctx.delivery`, tags, `--set`.
2. The faults library, each factory unit-tested against the built-in behaviour it replaces
   on small specs, with the same states and verdicts.
3. Migrate the examples one at a time, declaring exactly the faults and bounds their TLA+
   and P oracles model; state counts and verdicts must match the oracles exactly. Then the
   tests, fixtures and the fuzzer (which generates fault steps and variables).
4. Delete everything in "Removed" above, the CLI flags and config keys, and their branches
   in the integer core, walks, views and playground, in one cutover.
5. The skill, the README and the site; release 0.15.

Benchmark the integer core before and after: fewer slots per vector should be no slower,
and a regression blocks step 4.

## Drawbacks

- **Specs get longer.** Today faults cost nothing to write; after this, the old coverage is
  a `lose` per message and a `crash` per actor. The coverage becomes visible, but an agent
  that forgets faults gets a spec with a perfect network. The "no faults" line and the skill
  are the mitigation.
- **Model variables can be misused** to share state actors do not share. They are needed for
  bounds the oracles keep as variables; the skill restricts them to bookkeeping and ghost
  state.
- **One check gets weaker.** RFD0011 rejected two steps on one message. It becomes "at most
  one fair step", which still catches two real handlers, but not two unfair ones.

## Rationale and alternatives

### Proposed design

A small core with general primitives, and failure as a library over them. The test for every
primitive: it is not about failure, and some fault cannot be built without it. Several steps
per message is needed for `lose`; variables for budgets and `atMost`; `reset` for `crash`
(state back to initial and replies dropped cannot be done from a step); `forward` for
`duplicate` (a send would lose the sender and the request it answers); tags for reports.

### Budgets and fault counting in the core

The first draft made budgets, a `fault` flag and `ctx.fail()` core concepts. Each is about
failure, and each is buildable from variables, tags and plain messages. Rejected.

### Budgets as actor state

`atMost` could count in a hidden field of the actor's state, but a budget shared across
actors cannot: a step changes only its own actor's state. A budget actor would need a message
per spend, adding events to every counterexample. Variables are one value each, as the
oracles' counters are.

### Faults on a network actor

A library `Network` actor that every message passes through could lose them. Every send would
be two hops, doubling the events of every trace and the states of every search. A step on the
receiver is the same fault with no extra hop.

### Keep built-in faults, add switches

`faults: { lose: [Charge], restart: [Bank] }`, interpreted by the engine, keeps failure in
every layer, and every new fault is a new switch. Rejected.

## Prior art

- **TLA+**: faults are actions in `Next`; bounds are variables and constants, as in this
  repository's oracles. Variables no process owns are ordinary.
- **P**: failure injection is written as machines and nondeterministic choices (`$`), not
  built into the runtime.
- **Jepsen** and **FoundationDB's simulation** inject faults from a configured nemesis or
  simulator: the imposed model this RFD moves away from, for model checking.

## Unresolved questions

### Before acceptance

- `@leostera/feynman/faults` as a subpath, or exported from the main entry?
- `throws(Call)`, a call that fails after the callee did the work, is `lose` on the reply
  today. Is that enough, or should the library have it in the first cut?
- Names: `crash` or `restart`; `atMost` or `upTo`; `defineVariable` or `defineModelState`.

### During implementation

- How guards receive variables: `when(state, model)` or a reader on `ctx`.
- Whether the playground shows unfair steps on nothing on the node or in a menu.

### Out of scope

- Faults in time (clock skew); timers already fire at any moment.
- Partitions between zones.

## Future possibilities

- More library faults, written outside the core: `partition(zoneA, zoneB)`, `stale(read)`.
- Ghost variables for properties: a history of acknowledged writes, without adding it to an
  actor's state.
- A coverage report: which fault steps ever ran, as "never ran" does for steps today.
