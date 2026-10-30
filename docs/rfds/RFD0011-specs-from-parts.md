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
const Charge = call("Charge", { payment: String }, { over: "rpc" });
const Charged = message("Charged", { payment: String }, { tone: "reply" });

const shop = defineZone({ name: "Shop" });

const Bank = defineActor({
  name: "Bank",
  zone: shop,
  hears: [Charge],
  initialState: () => ({ charges: 0, seen: [] as string[] }),
  on: {
    Charge: {
      description: "Charges the customer, once per payment, and answers.",
      sends: [Charged],
      run(state, msg, ctx) {
        if (!(idempotencyKey.on && state.seen.includes(msg.payment))) state.charges += 1;
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

export default defineSpec({ name: "Retried call", actors: [Client, Bank], properties: [chargedOnce], scenarios: [aPayment] });
```

Two things change together:

1. **No builder closure.** Parts are values, so a spec reads top to bottom, at one level of
   indentation, and can be split across files or share parts with other specs. `defineSpec`
   assembles and checks them.
2. **Payloads are schemas, not type annotations.** `{ payment: String }` is a value the
   checker can read at run time, and its TypeScript type is inferred from it. The same
   vocabulary describes action inputs.

Type safety stays where it is: a handler's `msg` is typed from the message it handles, a
misspelt message is a type error, and so is a payload of the wrong shape.

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

- the checker can't check a payload at run time. A scenario that delivers `{ paymnet: "x" }`
  through `s.deliver`, or a handler that sends a payload built from JSON, passes silently;
- the playground and the Code view can't list a message's fields until one is sent;
- the fuzzer and the input examples can't make payloads;
- action inputs already use runtime types (`inputs: { amount: Number }`, `["yes", "no"]`),
  so a spec uses two vocabularies for the same thing.

**Parts can't be shared.** A Bank actor, a set of zones, or helpers used by several specs
can't be imported, because everything only exists inside one spec's closure. Specs that
have grown to hundreds of lines can't be split. Several projects keep shared helpers
next to their specs and still copy the actors between them.

Playground files also need `return { Client, Bank }` at the end of the closure (`handles`)
to reach actors, which is boilerplate a value at the top level wouldn't need.

## Goals

- Every part of a spec is a value that can be defined at the top level, exported, imported
  and reused.
- A spec reads top to bottom: messages, zones, actors, rules, properties, scenarios, and the
  `defineSpec` that assembles them.
- Each message is defined once.
- Payloads and inputs are described by schemas: values the checker reads at run time, with
  their TypeScript types inferred from them.
- Type safety is unchanged or better: handler payloads, sends, replies, failures, inputs and
  states stay typed, and mistakes stay type errors where they are today.
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
const Charge = call("Charge", { payment: String }, { over: "rpc" });
const Charged = message("Charged", { payment: String }, { tone: "reply" });
const Ping = message("Ping");                              // no payload
```

The first argument is the message's id, unique within a spec. The second is its payload
schema. The third holds the rest (`name`, shown in traces, defaults to the id in words:
"charged"; `over`; `tone`).

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
const Report = message("Report", { host: String, status: Status, keys: listOf(Key) });
```

Action inputs use the same vocabulary: `inputs: { amount: oneOf(30, 80) }`, or with
examples, `input(Number, { examples: [30, 80] })`.

### Actors

```ts
const Client = defineActor({
  name: "Client",
  zone: shop,
  hears: [Charged],
  calls: [Charge],
  initialState: () => ({ paying: false, paid: false }),
  actions: {
    pay: {
      label: "Pay",
      description: "Charges the customer, through the bank.",
      when: (s) => !s.paying && !s.paid,
      sends: [Charge],
      run(state, _inputs, ctx) {
        state.paying = true;
        ctx.send(ctx.the(Bank), Charge, { payment: "pay-1" });
      },
    },
  },
  on: {
    Charged: { description: "The order is paid.", run: (s) => void ((s.paying = false), (s.paid = true)) },
  },
  failed: {
    Charge: { description: "The call threw: charges again.", sends: [Charge], run: (_s, failure, ctx) => ctx.send(failure.to, Charge, failure.payload) },
  },
});
```

- `hears` lists the messages the actor handles; `on` has one handler per message, keyed by
  its id. A handler for a message not in `hears` is a type error ("Did you mean 'Charge'?"),
  and so is a payload field that doesn't exist.
- `calls` lists the calls the actor makes; `failed` has their failure handlers, keyed the same
  way. A call sent without a failure handler is a definition error, as today.
- `timers` and `guards` take the steps `transitions` holds today: those that fire when a
  timer started with `ctx.start` is due, and those taken whenever their `when` holds.
- `ctx.the(Bank)` refers to the actor value, defined anywhere in the file: handlers run
  later, so the order of definitions doesn't matter to them.

### Rules, properties and scenarios

```ts
const idempotencyKey = defineRule("idempotencyKey", { description: "The bank charges each payment once." });
const chargedOnce = defineProperty("chargedOnce", { description: "…", always: (w) => …, needs: [idempotencyKey] });
const aPayment = defineScenario("A payment", { run(s) { s.act(s.the(Client), "pay"); s.settle(); } });
```

`rule.on` reads as today, in handlers, guards and properties.

### Assembling

```ts
export default defineSpec({
  name: "Retried call",
  description: "…",
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

- `message(id, schema?, options?)` and `call(…)` return `Message<Id, Payload>`: `{ id, key,
  name, over, tone, call, schema }`, where `key` is the engine's `message:<id>`.
- `defineActor` keeps `hears`, `calls`, `on`, `failed`, `timers`, `guards` and `actions`, and
  normalizes them into today's `ActorInfo` (transitions keyed `message:<id>` and
  `failed:message:<id>`). The engine doesn't change.
- `defineRule`, `defineProperty`, `defineScenario` return values that `defineSpec` collects.
- `defineSpec(parts)` returns the `Spec` the engine runs today, with `rules`, `without` and
  `withoutRules` from RFD0010.
- Schemas are plain values: constructors, nested objects, and branded results of `oneOf`,
  `listOf`, `setOf`, `recordOf`, `nullable` and `type`. `TypeOf<S>` infers the type.

### Typing

A computed key can't carry a payload type: `[Charge]` reduces to its string, and TypeScript
drops anything attached to it (checked: a branded key loses its brand as a property name).
So the payload comes from the actor's own lists. `hears: [Charge, Charged]` is a tuple of
`Message` values, mapped by id to their payloads, and `on` is typed from that map. Excess
property checks catch a handler for a message the actor doesn't hear, with a "did you mean".
The same holds for `calls` and `failed`. All of this was checked with `tsc` before writing
this RFD.

`sends: [Charged]` and `ctx.send(…, Charged, payload)` take `Message` values, so a payload is
checked against its message's schema type wherever it is sent.

### Semantics

- **Payload checks.** A payload sent, replied, or given to `s.deliver`/`s.drop` is checked
  against its schema. A mismatch is a spec error naming the field ("Client sends charge with
  payment: 1, but its schema says string"), like any other spec error found while exploring.
  Checks are skipped for `type<T>()`.
- **Assembly checks**, in `defineSpec`: ids unique per spec (two different messages with one
  id is an error); every message sent is heard by an actor of the spec; every call sent has a
  failure handler; actors referenced by `sends` are in the spec. `ctx.the(X)` for an actor not
  in the spec fails when it runs, saying so.
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

### Compatibility and migration

This replaces the closure API in 0.14. The migration guide, in the changelog and the skill,
shows each change before and after:

| 0.13 | 0.14 |
| --- | --- |
| `messages: { Charge: call<{ payment: string }>({ name: "charge" }) }` | `const Charge = call("Charge", { payment: String })` |
| `const { Charge } = spec.messages` | (gone) |
| `spec.defineZone(…)`, `spec.defineActor(…)` | `defineZone(…)`, `defineActor(…)` |
| `transitions: { [Charge]: { … } }` | `hears: [Charge]`, `on: { Charge: { … } }` |
| `transitions: { [spec.failed(Charge)]: { … } }` | `calls: [Charge]`, `failed: { Charge: { … } }` |
| `transitions: { retry: { after, … } }` | `timers: { retry: { after, … } }` |
| `transitions: { drain: { when, … } }` | `guards: { drain: { when, … } }` |
| `spec.defineProperties({ p: … })` | `defineProperty("p", …)`, listed in `properties` |
| `spec.defineScenario({ name, … })` | `defineScenario(name, …)`, listed in `scenarios` |
| `spec.defineRule({ name, … })` | `defineRule(name, …)` |
| `return { Client, Bank }` | (gone; import the actors) |
| `inputs: { vote: ["yes", "no"] }` | `inputs: { vote: oneOf("yes", "no") }` |

The migration is mechanical, and agents do it well, so it ships as a guide rather than a
codemod. The skill gets a "Migrating to 0.14" section, as it has for RFD0004.

### Rollout and validation

1. Schemas: the vocabulary, `TypeOf`, runtime checks, with tests for every form.
2. The new DSL beside the old one in the source tree only, building the same `Spec`.
3. Migrate every example, test spec and fixture. Each must keep its state counts and
   verdicts (the corpus tests, the TLA+ and P oracles, and the engine comparisons all
   apply unchanged), and the fuzzer's generated specs move to the new form.
4. Remove the closure API, then update the views, playground files, the skill and the site.
5. Release 0.14 with the migration guide.

## Drawbacks

- Every spec changes. Agents make this cheap, but users with many specs pay it once.
- `hears` and `calls` repeat what the handlers say. They are the price of typing handlers
  without a spec-wide registry: one line per actor, and they read as a summary of what the
  actor does.
- Rules read through a value that depends on what is running: a small piece of dynamic
  scope. It's confined to `rule.on`, and an error outside a step or a property.
- Schemas cover less than TypeScript's types. `type<T>()` is the escape hatch, unchecked.

## Rationale and alternatives

### Proposed design

Parts as values are the simplest structure a spec can have: one definition per thing, read
top to bottom, at one level of nesting, and imported like any other code. Typing comes from
values the parts already hold (`hears`, `calls`, schemas), not from a registry that every
part has to sit inside.

### Messages inside the closure

`spec.defineMessage(…)` inside today's closure removes the double declaration, but keeps the
nesting and keeps parts from being shared. It's a smaller step towards the same goal.

### Keeping types for payloads

`message<{ payment: string }>("Charge")` keeps today's annotation with the new structure. It
reads well and costs nothing, but loses everything a runtime schema gives (checks, fields in
the views, generated payloads) and keeps two vocabularies, one for payloads and one for
inputs. `type<T>()` covers the cases a schema can't.

### `on(Charge, handler)` lists

`transitions: [on(Charge, { … }), on(Charged, { … })]` types each handler from its message
with no `hears`. It's more noise in every handler, and gives up the object keyed by message,
which is how both people and the views look a handler up.

### Using the message as the key

`on: { [Charge]: … }` would need `Charge` to be a string that also carries its payload type.
TypeScript drops that as soon as the string is a property name (checked), so it can't type
`msg`.

### Do nothing

Specs stay nested, messages stay declared twice, payloads stay invisible at run time, and
parts can't be shared. Each is small; together they're most of what makes a spec harder to
read than the design it describes.

## Prior art

- **XState** (v5) moved from configuration objects towards `setup({ types, actions })` plus
  standalone machines, for the same reason: typing without a single registry, and reuse.
- **Zod, Valibot, io-ts** infer types from runtime schemas. Feynman's vocabulary is a small
  subset, enough for payloads.
- **P** declares events with payload types at the top level and machines that handle them,
  standalone parts assembled by a test: `event eCharge: tCharge;`.
- **TLA+** has no assembly at all: a module is a flat list of definitions, and the spec is the
  formula that combines them.

## Unresolved questions

### Before acceptance

- `hears`/`calls` as lists, or derive them from `on`/`failed` with a helper that types each
  handler (`on: handlers(Charge, Charged)({ Charge: … })`)?
- `timers` and `guards` as names, or one `steps` with `after`/`when` as today?
- Should `name` default to the id in words, or stay required?

### During implementation

- Whether payload checks are cached per payload object: payloads are frozen and shared
  between worlds, so a check per distinct payload is enough.
- How schemas show in the playground (a payload's fields in the send form, or examples).

### Out of scope

- Schemas for actor state (`initialState` stays a function whose type is inferred).
- Discriminated unions in schemas; `type<T>()` covers them until there's a need.

## Future possibilities

- **Shared parts libraries.** Zones, actors and messages for common infrastructure (a queue,
  a Durable Object with storage, an R2 bucket) published and imported by specs.
- **Generated payloads.** The fuzzer and the playground could make example payloads from
  schemas.
- **Schemas from code.** A message's schema could be checked against the TypeScript type of
  the function its `sources` names.
