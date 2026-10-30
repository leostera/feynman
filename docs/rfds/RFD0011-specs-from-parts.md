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
  actions: {
    pay: {
      label: "Pay",
      when: (s) => !s.paying && !s.paid,
      run(state, _inputs, ctx) {
        state.paying = true;
        ctx.send(ctx.the(Bank), Charge, { payment: "pay-1" });
      },
    },
  },
  handles: ({ on, failed }) => [
    on(Charged, {
      description: "The bank charged the payment: the order is paid.",
      run(state) {
        state.paying = false;
        state.paid = true;
      },
    }),
    failed(Charge, {
      description: "The call threw: the client sends the same charge again.",
      run(_state, failure, ctx) {
        ctx.send(failure.to, Charge, failure.payload);
      },
    }),
  ],
});

const Bank = defineActor({
  name: "Bank",
  zone: bank,
  initialState: () => ({ charges: 0, seen: [] as string[] }),
  handles: ({ on }) => [
    on(Charge, {
      description: "Charges the customer, once per payment, and answers.",
      run(state, msg, ctx) {
        if (!(idempotencyKey.on && state.seen.includes(msg.payment))) state.charges += 1;
        state.seen.push(msg.payment);
        ctx.reply(Charged, { payment: msg.payment });
      },
    }),
  ],
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

Three things change together:

1. **No builder closure.** Parts are values, so a spec reads top to bottom, at one level of
   indentation, and can be split across files or share parts with other specs. `defineSpec`
   assembles and checks them.
2. **Payloads are schemas, not type annotations.** `{ payment: String }` is a value the
   checker can read at run time, and its TypeScript type is inferred from it. Action inputs
   use the same vocabulary.
3. **Nothing is said twice.** A message is defined once. An actor's handlers say which
   messages it handles, and its code says what it sends: there are no `sends`, `starts` or
   `messages` lists to keep in step with the code.

Type safety stays where it is: a handler's `msg` and `state` are typed, a payload of the wrong
shape is a type error wherever it is sent, and messages are values, not strings, everywhere,
scenarios included.

## Motivation

Specs are read by people deciding whether a design is right, and written more and more by
agents. Five things about the current shape make both harder than they need to be.

**Everything is nested in a closure.** A spec is `defineSpec(name, { messages }, (spec) => {
… })`, and every zone, actor, property and scenario is defined inside it, through `spec.`.
Handlers sit four or five levels deep: `defineSpec` → closure → `defineActor` →
`transitions` → handler → `run`. The structure carries no meaning: it is there so the
builder can collect the parts and so the message registry's types reach them.

**A message is declared in two places.** It goes into the options (`messages: { Charge:
call<…>(…) }`), and then out again (`const { Charge } = spec.messages`). Adding one means
editing both, and agents regularly forget the second.

**Steps repeat their code.** `sends: [Charged]` and `starts: ["retry"]` list what `run` does.
They are checked at run time, so they can't drift silently, but every change to a handler
means changing them too, and a forgotten one is the most common error agents hit when
editing a spec.

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
- Nothing is declared twice: not messages, not what a handler handles, not what it sends.
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

An actor's `handles` lists everything it reacts to, each built by a helper it is given:

```ts
handles: ({ on, failed, timer, guard }) => [
  on(Charge, { run(state, msg, ctx) { … } }),          // a message arrives
  failed(Charge, { run(state, failure, ctx) { … } }),  // a call this actor made threw
  timer("retry", { after: "the answer is late", run(state, _, ctx) { … } }),
  guard("drain", { when: (s) => s.queue.length > 0, run(state, _, ctx) { … } }),
],
```

- `on(Charge, …)` types `msg` from `Charge`'s schema and `state` from the actor's
  `initialState`. The actor handles exactly the messages it has an `on` for.
- `failed(Charge, …)` handles a call that threw. An actor that sends a call needs one, as today
  (RFD0009).
- `timer` and `guard` are the internal steps that `transitions` holds today: one fires when
  a timer started with `ctx.start` is due, the other whenever its `when` holds.
- `ctx.the(Bank)` refers to the actor value, defined anywhere in the file: handlers run
  later, so the order of definitions doesn't matter to them.

Handlers don't list what they send or start. The checker reads that from their code (see
"What a step sends").

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
- `defineActor` calls `handles` once, at definition, with helpers that record each handler,
  and normalizes the result into today's `ActorInfo` (transitions keyed `message:<id>`,
  `failed:message:<id>`, or the timer or guard name). The engine doesn't change.
- `defineRule`, `defineProperty` and `defineScenario` return values that `defineSpec` collects.
- `defineSpec(parts)` returns the `Spec` the engine runs today, with `rules`, `without` and
  `withoutRules` from RFD0010.
- Schemas are plain values: constructors, nested objects, and branded results of `oneOf`,
  `listOf`, `setOf`, `recordOf`, `nullable` and `type`. `TypeOf<S>` infers the type.

### Typing

A handler needs two types: its payload, from its message, and its state, from its actor.

- **Why not an object keyed by message.** `{ [Charge]: … }` can't type `msg`: a computed key
  reduces to its string, and TypeScript drops anything attached to it. `{ Charge: … }` keyed
  by id works only with a list of the messages the actor handles (`hears: [Charge]`) to look
  the payload up in, which says each message twice.
- **Why not standalone `on(Charge, …)`.** A handler built outside the actor gets its payload
  but not its state, which comes out as `unknown`.
- **Why `handles: ({ on }) => […]`.** `initialState` has no context-sensitive parameters, so
  TypeScript infers the state type from it first. Then it types `handles`'s parameter as
  `{ on: <P>(m: Message<string, P>, h: Handler<S, P>) => Handled, … }`, so each `on` gets both.
  A wrong payload field and a wrong state field are both type errors.

All three were checked with `tsc` before writing this RFD.

`ctx.send(to, Charged, payload)`, `ctx.reply(Charged, payload)` and `ctx.start("retry")`
take any message or timer of the spec, with the payload checked against the message's schema
type. They are no longer narrowed to a `sends` list.

### What a step sends

Today `sends` and `starts` serve four purposes. Each is kept without them:

| Purpose | Today | With this RFD |
| --- | --- | --- |
| A step sends only what it declares | checked at run time | gone: there is nothing to declare |
| An actor that sends a call handles its failure | checked at definition, from `sends` | checked at definition, from the code; and at run time, when a call is sent by an actor without a `failed` handler |
| The views draw who talks to whom before exploring | `actorLinks`, from `sends` | from the code, and from what exploring sends |
| A step's sends are listed in the Code view and the flows | from `sends` | from the code |

"From the code" means a static pass over the spec's source, which Feynman already does for
the Code view (TypeScript and calldiff are dependencies). It finds, in each handler and
action, the messages passed to `ctx.send`, `ctx.reply` and `ctx.broadcast`, and the timers
passed to `ctx.start`. It sees through local helpers that receive `ctx`. Where it can't tell
(a message chosen at run time, from a variable), it lists what the step's code may send as
unknown, and exploring fills in what is actually sent.

What a step sends is a property of its code. The runtime checks are the guarantee; the static
pass gives the views and the definition-time check their answers before anything runs.

Types can't do this: a function's type says nothing about the calls in its body.

### Semantics

- **Payload checks.** A payload sent, replied, or given to `s.deliver`/`s.drop` is checked
  against its schema. A mismatch is a spec error naming the field ("Client sends charge with
  payment: 1, but its schema says string"), like any other spec error found while exploring.
  Checks are skipped for `type<T>()`.
- **Assembly checks**, in `defineSpec`: ids unique per spec (two different messages with one
  id is an error); every message an actor sends is handled by some actor of the spec; every
  call sent has a failure handler; actors referenced in handlers are in the spec. `ctx.the(X)`
  for an actor not in the spec fails when it runs, saying so.
- **Rules.** A rule is a module-level value, but its `on` belongs to the spec being run: the
  engine and the checker set the spec in effect while they run a step or judge a property,
  and `rule.on` reads it. `checkRules` runs the variant by switching that, not by rebuilding.
  Reading `rule.on` outside a step or property is an error.
- **Reuse.** One actor may be in several specs. Each spec checks its own parts.

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
| `transitions: { [Charge]: { … } }` | `handles: ({ on }) => [on(Charge, { … })]` |
| `transitions: { [spec.failed(Charge)]: { … } }` | `failed(Charge, { … })` |
| `transitions: { retry: { after, … } }` | `timer("retry", { after, … })` |
| `transitions: { drain: { when, … } }` | `guard("drain", { when, … })` |
| `sends: [Charged]`, `starts: ["retry"]` | (gone) |
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
2. The static pass for what a step sends, tested against every example's current `sends` and
   `starts`: it must find each of them.
3. The new DSL beside the old one in the source tree only, building the same `Spec`.
4. Migrate every example, test spec and fixture. Each must keep its state counts and
   verdicts (the corpus tests, the TLA+ and P oracles, and the engine comparisons all apply
   unchanged), and the fuzzer's generated specs move to the new form.
5. Remove the closure API, then update the views, playground files, the skill and the site.
6. Release 0.14 with the migration guide.

## Drawbacks

- Every spec changes. Agents make this cheap, but users with many specs pay it once.
- `handles: ({ on }) => […]` is a callback where today there is an object. It is the shape
  that types both payload and state without saying any message twice.
- A static pass over the source is less certain than a list the author writes. It's backed
  by runtime checks, and only the views and an early error depend on it.
- Rules read through a value that depends on what is running: a small piece of dynamic
  scope, confined to `rule.on`, and an error outside a step or a property.
- Schemas cover less than TypeScript's types. `type<T>()` is the escape hatch, unchecked.

## Rationale and alternatives

### Proposed design

Parts as values are the simplest structure a spec can have: one definition per thing, read
top to bottom, at one level of nesting, and imported like any other code. Typing comes from
values the parts already hold (messages with schemas, the actor's initial state), not from a
registry that every part has to sit inside. What can be read from the code isn't written
again beside it.

### A `hears` list and an object keyed by id

```ts
hears: [Charge],
on: { Charge: { run(state, msg, ctx) { … } } },
```

It types correctly, and a handler for a message not heard is an error with a "did you mean".
But `hears` repeats the keys of `on`, and failures need a second pair (`calls`, `failed`).

### Handlers added to the actor

```ts
const Bank = defineActor({ name: "Bank", zone: bank, initialState: () => ({ charges: 0 }) });
Bank.on(Charge, { run(state, msg, ctx) { … } });
```

The flattest form, and fully typed. But the actor is built up by statements spread over the
file, a value that changes after it's made, and an actor can't be read in one place.

### Keeping `sends`, inferred by types

TypeScript can't see the calls inside a function body, so `sends` can only be written or read
from the source. A `run` that returned what it sent would be typed, but turns every handler
inside out.

### Keeping types for payloads

`defineMessage<{ payment: string }>("Charge")` keeps today's annotation. It reads well and
costs nothing, but loses everything a runtime schema gives (checks, fields in the views,
generated payloads) and keeps two vocabularies. `type<T>()` covers what a schema can't.

### Messages inside the closure

`spec.defineMessage(…)` inside today's closure removes the double declaration, but keeps the
nesting and keeps parts from being shared.

### Do nothing

Specs stay nested, messages and sends stay declared twice, payloads stay invisible at run
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

- `handles` as the name, or `on: ({ on }) => […]`, or `reacts`?
- `timer` and `guard` in `handles`, or kept apart as objects keyed by name (they don't need a
  message's type)?
- Should `name` default to the id in words, or stay required?

### During implementation

- How far the static pass follows helpers, and how unknown sends are shown.
- Whether payload checks are cached per payload object: payloads are frozen and shared
  between worlds, so one check per distinct payload is enough.
- How schemas show in the playground (a payload's fields, or examples).

### Out of scope

- Schemas for actor state (`initialState` stays a function whose type is inferred).
- Discriminated unions in schemas; `type<T>()` covers them until there's a need.

## Future possibilities

- **Shared parts libraries.** Zones, actors and messages for common infrastructure (a queue,
  a Durable Object with storage, an object store) published and imported by specs.
- **Generated payloads.** The fuzzer and the playground could make example payloads from
  schemas.
- **Schemas from code.** A message's schema could be checked against the TypeScript type of
  the function its `sources` names.
