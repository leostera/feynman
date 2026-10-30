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
scenarios), each a value defined at the top level of a file, and assembled at the end. Each
step of an actor has a name and says what it reacts to as a value (`on: Charge`), and each
payload is a schema (`{ payment: String }`) rather than a type annotation:

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
  singleton: true,
  initialState: () => ({ paying: false, paid: false }),
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
  transitions: {
    paid: {
      on: Charged,
      description: "The bank charged the payment: the order is paid.",
      run(state) {
        state.paying = false;
        state.paid = true;
      },
    },
    retry: {
      on: failed(Charge),
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
  singleton: true,
  initialState: () => ({ charges: 0, seen: [] as string[] }),
  transitions: {
    charge: {
      on: Charge,
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

The closure, the message registry, `spec.`, computed keys and `return { … }` handles all
go. The engine, the checker and their semantics don't change: `defineSpec` builds the same
`Spec` they run today.

## Motivation

Specs are read by people deciding whether a design is right, and written more and more by
agents. The current shape makes both harder than it needs to.

**Everything is nested in a closure.** A spec is `defineSpec(name, { messages }, (spec) => {
… })`, and every zone, actor, property and scenario is defined inside it, through `spec.`.
Handlers sit four or five levels deep. The structure carries no meaning: it is there so the
message registry's types reach the parts.

**A message is declared twice.** It goes into the options (`messages: { Charge: call<…>(…)
}`), and out again (`const { Charge } = spec.messages`). A 20-message spec has a 20-name
destructuring line, and adding a message means editing both places.

**Steps are keyed by stringy messages.** `[Charge]: { … }` works because `Charge` is the
string `"message:Charge"` typed as a literal, and the payload is looked up in the registry by
that literal. It's clever, it's why everything must live inside the closure, and a step's key
says only what it receives, never what it does.

**Payloads are types only.** `message<{ payment: string }>(…)` gives TypeScript the shape,
and nothing else: the checker can't check a payload at run time, the views can't show a
message's fields until one is sent, and inputs already use runtime types (`Number`,
`["yes", "no"]`), so a spec uses two vocabularies for one thing. Payload types also repeat:
in a real 21-message spec every message carries `socket: number`, written 21 times.

**Helpers lose their types.** Functions shared by an actor's steps live inside the closure,
where the state and context types have no names, so they're written `(state: any, ctx: any)`.

**Parts can't be shared.** An actor, a set of zones or a scenario setup can't be imported by
another spec, and a big spec can't be split across files.

**Scenarios use strings.** `s.deliver(x, "Charge")` and `"failed:Charge"` are checked only
when the scenario runs.

A rewrite of a real 640-line spec in this design halved the indentation of its handlers
(the deepest `run(` from 10 spaces to 6), removed its eight `any`s and its 21-name
destructuring line, and gave its 28 steps names that say what they do (`compareWithCloud`,
`findCommonPrefix`, `resumeAfterCut`) instead of what they receive.

## Goals

- Every part of a spec is a value that can be defined at the top level, exported, imported
  and reused.
- A spec reads top to bottom: messages, zones, rules, actors with their helpers, properties,
  scenarios, and the `defineSpec` that assembles them.
- Each message is defined once, and referred to by value everywhere, scenarios included.
- Each step has a name, and says what it reacts to as a value.
- Payloads and inputs are described by schemas: values the checker reads at run time, with
  their TypeScript types inferred from them.
- Type safety is unchanged or better: payloads, states, sends, replies, failures and inputs
  stay typed, and helpers can be typed too.
- Everything the checker uses stays runtime data; types are derived from it.

## Non-goals

- **Changing the semantics.** Engine, checker, faults, calls, rules and properties behave as
  they do. Faults are RFD0012's subject.
- **A general schema library.** The vocabulary covers what specs carry, not Zod's. An escape
  hatch takes any TypeScript type, unchecked.
- **Keeping the closure API.** It goes in 0.14, with a migration guide.

## Guide-level explanation

### Messages and calls

```ts
const Charge = defineCall("Charge", { payment: String }, { over: "rpc" });
const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });
const Ping = defineMessage("Ping");
```

The first argument is the message's id, unique within a spec. The second is its payload
schema, if it has one. The third holds the rest: `name`, shown in traces (by default the id in
words: "charged"), `over` and `tone`. `failed(Charge)` is the failure of a call, as a value.

### Schemas

| Schema | Type |
| --- | --- |
| `String`, `Number`, `Boolean` | `string`, `number`, `boolean` |
| `oneOf("yes", "no")`, `oneOf(1, 2, 3)` | `"yes" \| "no"`, `1 \| 2 \| 3` |
| `listOf(S)`, `setOf(S)`, `recordOf(S)` | `T[]`, `Set<T>`, `Record<string, T>` |
| `nullable(S)` | `T \| null` |
| `{ field: S, … }` | `{ field: T, … }` |
| `type<T>()` | `T`, not checked at run time |

Schemas are values, so shared fields are written once and spread:

```ts
const inRound = { socket: Number, round: Number };
const ChainAt = defineMessage("ChainAt", inRound);
const Chains = defineMessage("Chains", { ...inRound, chains: listOf(String) });
```

Action inputs use the same vocabulary: `inputs: { vote: oneOf("yes", "no") }`, or with
examples, `input(Number, { examples: [30, 80] })`.

### Actors and steps

```ts
const Bank = defineActor({
  name: "Bank",
  zone: bank,
  initialState: () => ({ charges: 0, queue: [] as string[] }),
  actions: {
    audit: { label: "Audit", run(state, _inputs, ctx) { … } },
  },
  transitions: {
    charge:      { on: Charge, sends: [Charged], run(state, msg, ctx) { … } },
    retry:       { on: failed(Charge), sends: [Charge], run(state, failure, ctx) { … } },
    requestLate: { after: "10 seconds", sends: [Sync], run(state, _, ctx) { … } },
    drain:       { when: (s) => s.queue.length > 0, run(state, _, ctx) { … } },
  },
});
```

- A transition is named by its key, and is one of three kinds: `on` a message or a call's
  failure, `after` a timer of the same name started with `ctx.start`, or `when` a guard holds.
- `msg` is typed from `on`, `state` from `initialState`. A wrong field in either is a type
  error.
- `sends` and `starts` list what a step may send and start, as today, checked when it runs.
- An actor receives exactly the messages its steps are `on`. One step per message.
- Actions are as today, inside their actor: they read and write its state.
- `ctx.the(Bank)` refers to the actor value, wherever it's defined in the file: steps run
  later, so the order of definitions doesn't matter to them.
- `durable`, `display`, `links`, `symmetric` and `place` are as today. `links` refers to
  actors by value (`{ to: HostDO }`).

### Helpers

A function shared by steps names the state type and takes the context:

```ts
const axodState = () => ({ connected: false, round: 0, … });
type AxodState = ReturnType<typeof axodState>;

function handshake(state: AxodState, ctx: Ctx): void { … }
```

### Rules, properties and scenarios

```ts
const idempotencyKey = defineRule("idempotencyKey", { description: "…" });

const chargedOnce = defineProperty("chargedOnce", {
  description: "…",
  always: (w) => …,
  needs: [idempotencyKey],
});

const aPayment = defineScenario("A payment", {
  description: "…",
  setup: (w) => w.set(Bank, { charges: 0 }),
  run(s) {
    s.act(s.the(Client), "pay");
    s.deliver(s.the(Bank), Charge);
    s.settle();
  },
});
```

`rule.on` reads as today, in steps, guards and properties. Scenarios name messages by value:
`s.deliver(…, Charge)`, `s.drop(…, Charged)`, `s.deliver(…, failed(Charge))`. A shared setup
is a function of `SetupWorld`.

### Assembling

```ts
export default defineSpec({
  name: "Retried call",
  description: "A payment retried after its answer is lost.",
  actors: [Client, Bank],
  groups: [banks],
  limits: [batchSize],
  properties: [chargedOnce, paymentsEnd],
  finalState: { description: "The order is paid.", when: (w) => w.the(Client).state.paid },
  scenarios: [aPayment, theAnswerIsLost],
});
```

Messages, zones and rules are collected from the actors and properties that use them, so
they aren't listed. `defineZone`, `defineLimit`, `defineGroup` and `input` are standalone
too.

### Playground files

`definePlayground(spec, …)` refers to actors by importing them, not through the handles a
closure returned.

## Reference-level explanation

### Data model

- `defineMessage(id, schema?, options?)` and `defineCall(…)` return `Message<Id, Payload>`:
  `{ id, key, name, over, tone, call, schema }`. `key` is the engine's `message:<id>`.
- `failed(call)` returns `Failure<Id, Payload>`, with `key` `failed:message:<id>`.
- `defineActor` returns an `Actor` holding its definition. Its transitions are normalized
  into today's `ActorInfo`: a step `on: M` becomes the transition keyed `M.key`, keeping its
  name for traces, coverage and the views; `after` and `when` steps are keyed by name.
- `defineZone`, `defineLimit`, `defineGroup`, `defineRule`, `defineProperty` and
  `defineScenario` return values.
- `defineSpec(parts)` collects messages, zones and rules from the parts, checks them (below),
  and returns the `Spec` the engine runs today.
- Schemas are plain values: constructors, nested objects, and branded results of `oneOf`,
  `listOf`, `setOf`, `recordOf`, `nullable` and `type`. `TypeOf<S>` infers the type, and
  `check(schema, value)` returns the first mismatch, if any.

### Typing

- **Steps.** `transitions` is inferred as an object of steps. For each step, TypeScript
  infers its message from `on` and types `msg` (or `failure`) from that message's schema; a
  step with no `on` is a timer or a guard. `initialState` has no context-sensitive
  parameters, so its type is inferred first, and every `state` is typed from it.
- **Why not `[Charge]` keys.** A computed key can't carry a payload type: TypeScript widens it
  to `string`, and the whole object loses its types. That's why 0.13 needs a registry the
  actors are built inside. A message as a value in the step needs neither.
- **Sends.** `sends: [Charged]` narrows `ctx.send` and `ctx.reply` in that step to the listed
  messages, with each payload checked against its schema's type, as today.
- **Actors as types.** An actor's type records its state and its steps, by name and message,
  so `w.the(Bank).state` is typed in properties and scenarios, and `w.set(Bank, …)` takes a
  partial state.

All of the above was checked with `tsc` before writing this RFD.

### Semantics

- **Payload checks.** A payload sent, replied, or given to `s.deliver`/`s.drop` is checked
  against its schema. A mismatch is a spec error naming the field ("Client sends charge with
  payment: 1, but its schema says string"), like any other spec error found while exploring.
  `type<T>()` isn't checked.
- **Assembly checks**, in `defineSpec`: message ids are unique per spec; no actor has two steps
  on the same message; every message a step sends is received by some actor of the spec; a
  message received but never sent is reported as a warning (a scenario may deliver it); every
  call a step sends is received as `failed(Call)` by the same actor; every actor a step or a
  link refers to is in the spec.
- **Rules.** A rule is a module-level value, but its `on` belongs to the variant being run.
  The engine and the checker set the variant in effect while they run a step, a guard, a
  property, or a display function, and `rule.on` reads it. Reading `rule.on` anywhere else is
  an error. `withoutRules` makes a variant of the same parts with the rules off, without
  rebuilding anything, and workers receive the variant by its rule names.
- **Reuse.** One actor may be in several specs. Each spec checks its own parts.

### What the checker gets from the parts

Types are erased before the checker runs: a verdict doesn't depend on whether a spec
type-checks. So everything the checker can use stays runtime data, and the types are derived
from it:

| Runtime data | Types derived from it | What the checker does with it |
| --- | --- | --- |
| payload schemas | each message's payload type | checks every payload on every explored step |
| each step's `on` | each step's `msg` | knows who handles what before exploring |
| `sends`, `starts` | what `ctx.send`, `ctx.reply`, `ctx.start` accept in a step | knows who may send what before exploring |

The assembly checks above are built from this graph. It's also what partial-order reduction
would need, which is left to its own RFD.

### Invariants

- A spec builds the same `Spec` as its 0.13 version: every migrated example keeps its state
  counts, verdicts, counterexamples, and TLA+ and P oracle results.
- Every payload in a world matches its message's schema.
- Every step has a name unique within its actor, and every message an actor receives has
  exactly one step.

### Compatibility and migration

This replaces the closure API in 0.14. The changelog's Migrating section and the skill show
each change:

| 0.13 | 0.14 |
| --- | --- |
| `defineSpec(name, { messages, description }, (spec) => { … })` | parts at the top level, then `defineSpec({ name, description, actors, … })` |
| `messages: { Charge: call<{ payment: string }>({ name: "charge" }) }` | `const Charge = defineCall("Charge", { payment: String })` |
| `const { Charge } = spec.messages` | (gone) |
| `spec.defineZone`, `spec.defineActor`, `spec.defineLimit`, `spec.defineGroup` | `defineZone`, `defineActor`, `defineLimit`, `defineGroup` |
| `transitions: { [Charge]: { … } }` | `transitions: { charge: { on: Charge, … } }` |
| `transitions: { [spec.failed(Charge)]: { … } }` | `transitions: { retry: { on: failed(Charge), … } }` |
| `run(state, ctx)` in timers and guards | `run(state, _, ctx)`, like every step |
| `spec.defineProperties({ p: … })` | `const p = defineProperty("p", …)`, listed in `properties` |
| `spec.defineScenario({ name, … })` | `defineScenario(name, …)`, listed in `scenarios` |
| `spec.defineRule({ name, … })` | `defineRule(name, …)` |
| `spec.defineFinalState(…)` | `finalState: …` in `defineSpec` |
| `spec.defineInput(Number, …)`, `["yes", "no"]` | `input(Number, …)`, `oneOf("yes", "no")` |
| `s.deliver(x, "Charge")`, `"failed:Charge"` | `s.deliver(x, Charge)`, `failed(Charge)` |
| `links: … { to: "HostDO" }` | `{ to: HostDO }` |
| `return { Client, Bank }` | (gone; import the actors) |
| `(state: any, ctx: any)` helpers | `(state: State, ctx: Ctx)` |

The migration is mechanical, and agents do it well, so it ships as a guide, not a codemod.
`--as-scenario` writes the new scenario form.

### Rollout and validation

1. Schemas: the vocabulary, `TypeOf`, runtime checks, with tests for every form.
2. The new DSL, building today's `Spec`, beside the old one in the source tree only.
3. Migrate every example, test spec, fixture and the fuzzer's generated specs. Each must
   keep its state counts and verdicts: the corpus tests, the TLA+ and P oracles, and the
   engine comparisons apply unchanged.
4. Remove the closure API; update the views, playground files, the skill, the README, the
   site and `llms.txt`.
5. Release 0.14 with the migration guide. share moves to 0.14 after.

## Drawbacks

- Every spec changes. Agents make this cheap, but users with many specs pay it once.
- Every step needs a name. Most names help; a few, on steps that only forward a message,
  add little (`routeAppend`).
- A spec gets slightly longer: an `on:` line per step, a `defineProperty` per property, and
  vertical lists in `defineSpec`. The rewritten 640-line spec grew by about 8%.
- Rules read through the variant in effect: a small piece of dynamic scope, confined to
  `rule.on`, and an error outside the places it applies.
- Schemas cover less than TypeScript's types. `type<T>()` is the escape hatch, unchecked.

## Rationale and alternatives

### Proposed design

Parts as values are the simplest structure a spec can have: one definition per thing, read
top to bottom, and imported like any other code. A step that holds its message as a value
needs no registry, so the closure has nothing left to do. Everything the checker uses is
runtime data, and the types are derived from it.

### Keeping the closure

Schemas, scenarios by value and the assembly checks would all work inside today's closure.
What needs standalone parts is the flat structure, a message declared once, typed helpers,
and sharing. With steps holding their message, standalone parts cost no more than the
closure, so there's no reason left to keep it.

### A `receives` list and steps keyed by message

```ts
receives: [Charge, failed(Charge)],
on: { Charge: { … } },
failed: { Charge: { … } },
```

Types correctly: `receives` is the registry, moved onto the actor. But it repeats the keys of
`on`, splits failures into their own object, and keys steps by what they receive rather than
what they do.

### `[Charge.key]` keys

Keeps 0.13's shape with `receives` as the registry. The keys get a `.key` suffix, failures
become `[failed(Charge).key]`, and timers and guards can't share the object without losing
its types.

### One handler per actor, with a `switch`

```ts
handle(state, msg, ctx) { switch (msg.type) { case "Charge": … } }
```

Natural code, and exhaustiveness checks for free. But it loses the step as a unit: `sends`,
`description`, `say` and guards per step have nowhere to live, and the checker, coverage and
the views all work per step.

### An actor body, or helpers that build steps

```ts
run(self) { self.on(Charge, (state, msg) => { … }); }
handles: ({ on }) => [on(Charge, { … })],
```

Both type each handler from its message. Statements can't build the actor's type
(TypeScript infers from arguments and return values, never from how a parameter is used in a
body), and the list of calls reads worse than an object of named steps.

### Handlers that return their effects

```ts
charge: { on: Charge, run: (state, msg, self) => self.reply(Charged, { … }) }
```

As an Erlang `gen_server` returns its reply. TypeScript infers each step's outputs from what
it returns, with no `sends`. But types are erased: the checker never sees them, so what a step
sends moves from runtime data into a type, the wrong way round. Every send must also be
returned through helpers and loops.

### Deriving `sends` from the code

A static pass over the source could list what each step sends. The lists are worth keeping:
they show what a step may do before reading it, and they're checked when it runs.

### Actions defined apart

```ts
const pay = defineAction(clientState, { label: "Pay", run(state) { … } });
```

Types correctly, but needs each actor's state named apart, and moves actions away from the
state they change. Actions stay in their actor; a shared step can be a function returning one.

### Keeping types for payloads

`defineMessage<{ payment: string }>("Charge")` reads well, but loses runtime checks, fields in
the views and shared schema parts, and keeps two vocabularies. `type<T>()` covers what a
schema can't.

## Prior art

- **XState** (v5) moved from one configuration object towards `setup({ types, actions })` and
  standalone machines, for typing without a single registry, and for reuse.
- **Zod, Valibot, io-ts** infer types from runtime schemas. Feynman's vocabulary is a small
  subset.
- **P** declares events with payload types at the top level, and machines handle them with
  named states and `on eCharge do …`; a test assembles them.
- **Erlang/OTP** names each callback by what it handles (`handle_call`, `handle_info`), and
  returns the reply.
- **TLA+** has no assembly at all: a module is a flat list of named definitions, and the spec
  is the formula that combines them. Named steps are TLA+'s named actions.

## Unresolved questions

### Before acceptance

- Should a message's `name` default to its id in words, or stay required?

### During implementation

- Whether payload checks are cached per payload object: payloads are frozen and shared
  between worlds, so one check per distinct payload is enough.
- How the views show schemas (a payload's fields in the send form, or examples).

### Out of scope

- Faults as steps, durability, and several steps per message: RFD0012.
- Schemas for actor state (`initialState` stays a function whose type is inferred).
- Discriminated unions in schemas; `type<T>()` covers them until there's a need.

## Future possibilities

- **Reusable steps.** A function returning a step, generic in the state and message it
  touches, shared across actors and specs: a retry with backoff, a lease that expires. RFD0012
  builds faults this way.
- **Coverage.** The check output could list the steps that never ran within the bounds, by
  name ("never ran: Client.retry"): a property that held is weaker than it looks if the steps
  that could break it never ran.
- **Partial-order reduction** from the communication graph.
- **Generated payloads** from schemas, for the fuzzer and the playground.
