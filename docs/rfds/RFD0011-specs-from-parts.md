# RFD0011 - Specs from parts

- Feature Name: `parts`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-30`
- Updated: `2026-10-30`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A spec is written as standalone parts (messages, zones, actors, rules, properties and
scenarios), each a value defined at the top level of a file, and assembled at the end:

```ts
const Charge = defineCall("Charge", { payment: String }, { over: "rpc" });
const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });

const shop = defineZone({ name: "Shop" });
const bank = defineZone({ name: "Bank" });

const idempotencyKey = defineRule("idempotencyKey", {
  description: "The bank remembers the payments it has charged, and charges each one once.",
});

const Client = defineActor({
  name: "Client",
  zone: shop,
  initialState: () => ({ paying: false, paid: false }),
  receives: [Charged, failed(Charge)],
  actions: {
    pay: {
      label: "Pay",
      when: (s) => !s.paying && !s.paid,
      sends: [Charge],
      run(state, _inputs, ctx) {
        state.paying = true;
        ctx.send(ctx.the(Bank), Charge, { payment: "pay-1" });
      },
    },
  },
  on: {
    Charged: {
      description: "The bank charged the payment: the order is paid.",
      run(state) {
        state.paying = false;
        state.paid = true;
      },
    },
  },
  failed: {
    Charge: {
      description: "The call threw: the client sends the same charge again.",
      sends: [Charge],
      run(_state, failure, ctx) {
        ctx.send(failure.to, Charge, failure.payload);
      },
    },
  },
});

const Bank = defineActor({
  name: "Bank",
  zone: bank,
  initialState: () => ({ charges: 0, seen: [] as string[] }),
  receives: [Charge],
  on: {
    Charge: {
      description: "Charges the customer, once per payment, and answers.",
      sends: [Charged],
      run(state, msg, ctx) {
        if (!(idempotencyKey.on && state.seen.includes(msg.payment))) state.charges += 1;
        state.seen.push(msg.payment);
        ctx.reply(Charged, { payment: msg.payment });
      },
    },
  },
});

const chargedOnce = defineProperty("chargedOnce", {
  description: "The customer is never charged twice.",
  always: (w) => w.the(Bank).state.charges <= 1,
  needs: [idempotencyKey],
});

const theAnswerIsLost = defineScenario("The answer is lost", {
  description: "The bank charges, its answer is lost, and the client retries.",
  run(s) {
    s.act(s.the(Client), "pay");
    s.deliver(s.the(Bank), Charge);
    s.drop(s.the(Client), Charged);
    s.settle();
  },
});

export default defineSpec({
  name: "Retried call",
  actors: [Client, Bank],
  properties: [chargedOnce],
  scenarios: [theAnswerIsLost],
});
```

Two things change:

1. **No builder closure.** Parts are values, so a spec reads top to bottom, at one level of
   indentation, and can be split across files or share parts with other specs. `defineSpec`
   assembles and checks them.
2. **Payloads are schemas, not type annotations.** `{ payment: String }` is a value the
   checker can read at run time, and its TypeScript type is inferred from it. Action inputs
   use the same vocabulary.

An actor reads as a summary before its code: `receives` lists what it reacts to, and each
step's `sends` lists what it may send, as today.

Type safety stays where it is: a handler's `msg` and `state` are typed, a payload of the wrong
shape is a type error wherever it is sent, a handler for a message the actor doesn't receive
is a type error, and messages are values, not strings, everywhere, scenarios included.

## Motivation

Specs are read by people deciding whether a design is right, and written more and more by
agents. Four things about the current shape make both harder than they need to be.

**Everything is nested in a closure.** A spec is `defineSpec(name, { messages }, (spec) => {
… })`, and every zone, actor, property and scenario is defined inside it, through `spec.`.
Handlers sit four or five levels deep: `defineSpec` → closure → `defineActor` →
`transitions` → handler → `run`. The structure carries no meaning: it is there so the
builder can collect the parts and so the message registry's types reach them.

**A message is declared in two places.** It goes into the options (`messages: { Charge:
call<…>(…) }`), and then out again (`const { Charge } = spec.messages`). Adding one means
editing both, and agents regularly forget the second.

**Payloads are types only.** `message<{ payment: string }>(…)` gives TypeScript the shape,
and nothing else:

- the checker can't check a payload at run time. A scenario that delivers `{ paymnet: "x" }`,
  or a handler that sends a payload built from JSON, passes silently;
- the playground and the Code view can't list a message's fields until one is sent;
- the fuzzer and the input examples can't make payloads;
- action inputs already use runtime types (`inputs: { amount: Number }`, `["yes", "no"]`),
  so a spec uses two vocabularies for the same thing.

**Parts can't be shared.** A Bank actor, a set of zones, or helpers used by several specs
can't be imported, because everything only exists inside one spec's closure. Specs that
have grown to hundreds of lines can't be split. Several projects keep shared helpers next to
their specs and still copy actors between them. Playground files also need `return {
Client, Bank }` at the end of the closure to reach actors.

## Goals

- Every part of a spec is a value that can be defined at the top level, exported, imported
  and reused.
- A spec reads top to bottom: messages, zones, rules, actors, properties, scenarios, and the
  `defineSpec` that assembles them.
- Each message is defined once.
- Payloads and inputs are described by schemas: values the checker reads at run time, with
  their TypeScript types inferred from them.
- Type safety is unchanged or better: handler payloads and states, sends, replies, failures
  and inputs stay typed, and messages are referred to by value, not by string.
- Every existing spec can be migrated mechanically, and the migration guide shows how.

## Non-goals

- **Changing the semantics.** Engine, checker, faults, calls, rules and properties behave as
  they do. This is about how a spec is written.
- **A general schema library.** The schema vocabulary covers what specs carry (strings,
  numbers, booleans, choices, lists, sets, records, nullable fields, nested objects), not
  Zod's. An escape hatch takes any TypeScript type, unchecked.
- **Keeping the closure API.** It goes in one release, with a migration guide, as with
  RFD0004.

## Guide-level explanation

### Messages and calls

```ts
const Charge = defineCall("Charge", { payment: String }, { over: "rpc" });
const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });
const Ping = defineMessage("Ping");                        // no payload
```

The first argument is the message's id, unique within a spec. The second is its payload
schema. The third holds the rest: `name`, shown in traces, which defaults to the id in words
("charged"); `over`; `tone`.

### Schemas

| Schema | Type |
| --- | --- |
| `String`, `Number`, `Boolean` | `string`, `number`, `boolean` |
| `oneOf("yes", "no")` | `"yes" \| "no"` |
| `listOf(S)`, `setOf(S)`, `recordOf(S)` | `T[]`, `Set<T>`, `Record<string, T>` |
| `nullable(S)` | `T \| null` |
| `{ field: S, … }` | `{ field: T, … }` |
| `type<T>()` | `T`, not checked at run time |

A schema used in several places is a value too:

```ts
const Status = oneOf("online", "offline");
const Key = { shard: String, version: Number };
const Report = defineMessage("Report", { host: String, status: Status, keys: listOf(Key) });
```

Action inputs use the same vocabulary: `inputs: { vote: oneOf("yes", "no") }`, or with
examples, `input(Number, { examples: [30, 80] })`.

### Actors

```ts
const Client = defineActor({
  name: "Client",
  zone: shop,
  initialState: () => ({ paying: false, paid: false }),
  receives: [Charged, failed(Charge)],
  actions: { pay: { label: "Pay", sends: [Charge], run(state, _inputs, ctx) { … } } },
  on: { Charged: { run(state, msg) { … } } },
  failed: { Charge: { sends: [Charge], run(state, failure, ctx) { … } } },
  timers: { retry: { after: "the answer is late", run(state, _timer, ctx) { … } } },
  guards: { drain: { when: (s) => s.queue.length > 0, run(state, _, ctx) { … } } },
});
```

- `receives` lists what the actor reacts to: messages, and `failed(Call)` for the calls it
  makes that may throw.
- `on` has a handler for each message received, keyed by its id. `msg` is typed from the
  message's schema and `state` from `initialState`. A handler for a message not in
  `receives` is a type error ("Did you mean 'Charged'?").
- `failed` has a handler for each `failed(Call)` received. An actor that sends a call must
  receive its failure, as today (RFD0009).
- `sends` (and `starts`, for timers) list what a step may send, as today. A step that sends
  anything else is an error when it runs.
- `timers` and `guards` hold the internal steps that `transitions` holds today: one fires
  when a timer started with `ctx.start` is due, the other whenever its `when` holds.
- `ctx.the(Bank)` refers to the actor value, defined anywhere in the file: handlers run
  later, so the order of definitions doesn't matter to them.

Actions stay inside their actor (see "Actions defined apart").

### Rules, properties and scenarios

```ts
const idempotencyKey = defineRule("idempotencyKey", { description: "…" });
const chargedOnce = defineProperty("chargedOnce", { description: "…", always: (w) => …, needs: [idempotencyKey] });
const aPayment = defineScenario("A payment", {
  run(s) {
    s.act(s.the(Client), "pay");
    s.deliver(s.the(Bank), Charge);
    s.settle();
  },
});
```

`rule.on` reads as today, in handlers, guards and properties. Scenarios refer to messages by
value: `s.deliver(s.the(Bank), Charge)`, `s.drop(…, Charged)`, `s.deliver(…, failed(Charge))`.

### Assembling

```ts
export default defineSpec({
  name: "Retried call",
  description: "A payment retried after its answer is lost.",
  actors: [Client, Bank],
  properties: [chargedOnce, paymentsEnd],
  scenarios: [aPayment, theAnswerIsLost],
  finalState: { description: "The order is paid.", when: (w) => w.the(Client).state.paid },
});
```

Messages, zones and rules are collected from the actors and properties that use them, so
they aren't listed. Groups and limits are fields too.

## Reference-level explanation

### Data model

- `defineMessage(id, schema?, options?)` and `defineCall(…)` return `Message<Id, Payload>`:
  `{ id, key, name, over, tone, call, schema }`, where `key` is the engine's `message:<id>`.
- `failed(Call)` returns `Failure<Id, Payload>`, which `receives` and scenarios accept.
- `defineActor` normalizes `on`, `failed`, `timers` and `guards` into today's `ActorInfo`
  (transitions keyed `message:<id>`, `failed:message:<id>`, or the timer or guard name).
  The engine doesn't change.
- `defineRule`, `defineProperty` and `defineScenario` return values that `defineSpec` collects.
- `defineSpec(parts)` returns the `Spec` the engine runs today, with `rules`, `without` and
  `withoutRules` from RFD0010.
- Schemas are plain values: constructors, nested objects, and branded results of `oneOf`,
  `listOf`, `setOf`, `recordOf`, `nullable` and `type`. `TypeOf<S>` infers the type.

### Typing

A handler needs two types: its payload, from its message, and its state, from its actor.

- **Payloads.** `receives` is inferred as a tuple of `Message` and `Failure` values. Mapped by
  id, it gives `on` and `failed` their keys and each handler's `msg` type. Excess property
  checks reject a handler for anything not received.
- **State.** `initialState` has no context-sensitive parameters, so TypeScript infers the
  state type from it first, then types every handler's `state` from it.
- **Why not `{ [Charge]: … }`.** A computed key reduces to its string, and TypeScript drops
  anything attached to it, so the payload type is lost. Keys are ids, typed through `receives`.
- **Sends.** `sends: [Charged]` narrows `ctx.send` and `ctx.reply` in that step to the listed
  messages, with each payload checked against its message's schema type, as today.

All of this was checked with `tsc` before writing this RFD: wrong payload fields, wrong state
fields and handlers for messages not received are all type errors.

### Semantics

- **Payload checks.** A payload sent, replied, or given to `s.deliver`/`s.drop` is checked
  against its schema. A mismatch is a spec error naming the field ("Client sends charge with
  payment: 1, but its schema says string"), like any other spec error found while exploring.
  Checks are skipped for `type<T>()`.
- **Assembly checks**, in `defineSpec`: ids unique per spec (two different messages with one
  id is an error); every message an actor sends is handled by some actor of the spec; every
  call sent is received as `failed(Call)` and handled; every message received is
in `on`, and every handler's message is received; actors referenced in handlers are in the
spec. `ctx.the(X)`
  for an actor not in the spec fails when it runs, saying so.
- **Rules.** A rule is a module-level value, but its `on` belongs to the spec being run: the
  engine and the checker set the spec in effect while they run a step or judge a property,
  and `rule.on` reads it. `checkRules` runs the variant by switching that, not by rebuilding.
  Reading `rule.on` outside a step or property is an error.
- **Reuse.** One actor may be in several specs. Each spec checks its own parts.

### What the checker gets from the parts

Types are erased before the checker runs: a verdict doesn't depend on whether a spec
type-checks, and the checker already catches, on every path it explores, what the types
catch in the editor. So this RFD keeps everything the checker can use as runtime data, and
derives the types from it, not the other way round:

| Runtime data | Types derived from it | What the checker does with it |
| --- | --- | --- |
| payload schemas | each message's payload type | checks every payload on every explored step |
| `receives` | each handler's `msg`, and which handlers may exist | knows who handles what before exploring |
| `sends`, `starts` | what `ctx.send`, `ctx.reply`, `ctx.start` accept in a step | knows who may send what before exploring |

From `receives` and `sends`, `defineSpec` builds the spec's communication graph and checks,
before anything runs:

- every message sent is received by some actor of the spec ("Bank sends Audit, but no actor
  receives it");
- every message received is sent by some actor or scenario ("Bank receives Refund, but
  nothing sends it"), a warning, since a scenario may deliver it;
- every call sent is received as `failed(Call)` by the actor that sends it.

And the check output gains a coverage line: the handlers, actions, timers and guards that
never ran within the bounds ("never ran: Client failed Charge"). A property that held is
weaker than it looks if the steps that could break it never ran, and this says so next to
the verdict.

The same graph is what partial-order reduction needs (two steps whose actors, sends and
receivers don't overlap are independent), which is left to its own RFD.

### Invariants

- A spec written either way builds the same `Spec`: the engine and the checker can't tell.
  The migration is checked by this: every migrated example keeps its state counts, verdicts,
  counterexamples, and TLA+/P oracle results.
- Every payload in a world matches its message's schema.
- Every call sent comes from an actor that handles its failure.

### Compatibility and migration

This replaces the closure API in 0.14. The migration guide, in the changelog and the skill,
shows each change before and after:

| 0.13 | 0.14 |
| --- | --- |
| `messages: { Charge: call<{ payment: string }>({ name: "charge" }) }` | `const Charge = defineCall("Charge", { payment: String })` |
| `const { Charge } = spec.messages` | (gone) |
| `spec.defineZone(…)`, `spec.defineActor(…)` | `defineZone(…)`, `defineActor(…)` |
| `transitions: { [Charge]: { … } }` | `receives: [Charge]`, `on: { Charge: { … } }` |
| `transitions: { [spec.failed(Charge)]: { … } }` | `receives: [failed(Charge)]`, `failed: { Charge: { … } }` |
| `transitions: { retry: { after, … } }` | `timers: { retry: { after, … } }` |
| `transitions: { drain: { when, … } }` | `guards: { drain: { when, … } }` |
| `sends: [Charged]`, `starts: ["retry"]` | (unchanged) |
| `spec.defineProperties({ p: … })` | `defineProperty("p", …)`, listed in `properties` |
| `spec.defineScenario({ name, … })` | `defineScenario(name, …)`, listed in `scenarios` |
| `s.deliver(x, "Charge")`, `"failed:Charge"` | `s.deliver(x, Charge)`, `failed(Charge)` |
| `spec.defineRule({ name, … })` | `defineRule(name, …)` |
| `return { Client, Bank }` | (gone; import the actors) |
| `inputs: { vote: ["yes", "no"] }` | `inputs: { vote: oneOf("yes", "no") }` |

The migration is mechanical, and agents do it well, so it ships as a guide rather than a
codemod. The skill gets a "Migrating to 0.14" section, as it has for RFD0004.

### Rollout and validation

1. Schemas: the vocabulary, `TypeOf`, runtime checks, with tests for every form.
2. The new DSL beside the old one in the source tree only, building the same `Spec`.
3. Migrate every example, test spec and fixture. Each must keep its state counts and
   verdicts (the corpus tests, the TLA+ and P oracles, and the engine comparisons all apply
   unchanged), and the fuzzer's generated specs move to the new form.
4. Remove the closure API, then update the views, playground files, the skill and the site.
5. Release 0.14 with the migration guide.

## Drawbacks

- Every spec changes. Agents make this cheap, but users with many specs pay it once.
- `receives` repeats the keys of `on` and `failed`. It is what types the handlers without a
  spec-wide registry, and it reads as the actor's summary: what it reacts to, before how.
- Rules read through a value that depends on what is running: a small piece of dynamic
  scope, confined to `rule.on`, and an error outside a step or a property.
- Schemas cover less than TypeScript's types. `type<T>()` is the escape hatch, unchecked.

## Rationale and alternatives

### Proposed design

Parts as values are the simplest structure a spec can have: one definition per thing, read
top to bottom, at one level of nesting, and imported like any other code. Typing comes from
values the parts already hold (messages with schemas, the actor's `receives` and initial
state), not from a registry that every part has to sit inside.

### An actor body, and handlers that return their effects

```ts
const Bank = defineActor({
  name: "Bank",
  initialState: () => ({ charges: 0 }),
  run(self) {
    self.on(Charge, (state, msg) => {
      state.charges += 1;
      return self.reply(Charged, { ok: true });
    });
  },
});
```

Each handler is fully typed from its message, and if a handler returns what it sends (as an
Erlang `gen_server` returns its reply, or an Elm update its commands), TypeScript infers
each handler's outputs: `{ Charge: "Charged" }`, with no `sends` to write. Both were checked
with `tsc`; statements alone (`self.on(…); self.on(…)`) can't build the actor's type,
since TypeScript infers from arguments and return values, never from how a parameter is used
in a body.

It reads well and is sound, but it moves what a step sends from runtime data into a type the
checker never sees, which is the wrong way round (see "What the checker gets from the
parts"). Every send must also be returned, through helpers and loops, and a forgotten
`return` drops a message.

### Handlers built by helpers

```ts
handles: ({ on, failed }) => [
  on(Charged, { run(state, msg) { … } }),
  failed(Charge, { run(state, failure, ctx) { … } }),
],
```

It types payload and state with no `receives`, since each handler is built from its message.
It reads worse: a callback returning a list of calls, where an object keyed by message shows
the same thing plainly, and is the form reviewers found hardest to read.

### Deriving `sends` from the code

TypeScript can't see the calls inside a function body, so `sends` could only be derived by a
static pass over the source (Feynman already parses sources for the Code view). It would
remove the lists, but they are worth keeping: they show what a step may do before reading
its code, and they're checked when it runs.

### Actions defined apart

```ts
const clientState = () => ({ paying: false, paid: false });
const pay = defineAction(clientState, { label: "Pay", when: (s) => !s.paid, run(state) { … } });
const Client = defineActor({ name: "Client", initialState: clientState, actions: { pay } });
```

This types correctly, and an action given to an actor with a different state is a type
error. But an action reads and writes its actor's state, so it can't be typed without it:
each actor's state has to be named apart, and its steps end up away from the state they
change. Actions, like handlers, stay in their actor. A step shared by several actors can
still be a function that returns the step.

### Handlers added to the actor

```ts
const Bank = defineActor({ name: "Bank", zone: bank, initialState: () => ({ charges: 0 }) });
Bank.on(Charge, { run(state, msg, ctx) { … } });
```

The flattest form, and fully typed. But the actor is built up by statements spread over the
file, a value that changes after it's made, and an actor can't be read in one place.

### Keeping types for payloads

`defineMessage<{ payment: string }>("Charge")` keeps today's annotation. It reads well and
costs nothing, but loses everything a runtime schema gives (checks, fields in the views,
generated payloads) and keeps two vocabularies. `type<T>()` covers what a schema can't.

### Messages inside the closure

`spec.defineMessage(…)` inside today's closure removes the double declaration, but keeps the
nesting and keeps parts from being shared.

### Do nothing

Specs stay nested, messages stay declared twice, payloads stay invisible at run
time, and parts can't be shared. Each is small; together they're most of what makes a spec
harder to read than the design it describes.

## Prior art

- **XState** (v5) moved from one configuration object towards `setup({ types, actions })` and
  standalone machines, for the same reasons: typing without a single registry, and reuse.
- **Zod, Valibot, io-ts** infer types from runtime schemas. Feynman's vocabulary is a small
  subset, enough for payloads.
- **P** declares events with payload types at the top level, and machines that handle them
  with `on eCharge do …`; a test assembles them. Machines don't declare what they send.
- **TLA+** has no assembly at all: a module is a flat list of definitions, and the spec is the
  formula that combines them.

## Unresolved questions

### Before acceptance

- `receives` as the name, or `hears`, or `handles`?
- Should `name` default to the id in words, or stay required?

### During implementation

- How the coverage line counts steps that ran (per handler, or per handler and outcome).
- Whether payload checks are cached per payload object: payloads are frozen and shared
  between worlds, so one check per distinct payload is enough.
- How schemas show in the playground (a payload's fields, or examples).

### Out of scope

- Schemas for actor state (`initialState` stays a function whose type is inferred).
- Discriminated unions in schemas; `type<T>()` covers them until there's a need.

## Future possibilities

- **Partial-order reduction.** The communication graph tells which steps are independent, so
  the search can skip their reorderings.

- **Shared parts libraries.** Zones, actors and messages for common infrastructure (a queue,
  a Durable Object with storage, an object store) published and imported by specs.
- **Generated payloads.** The fuzzer and the playground could make example payloads from
  schemas.
- **Schemas from code.** A message's schema could be checked against the TypeScript type of
  the function its `sources` names.
