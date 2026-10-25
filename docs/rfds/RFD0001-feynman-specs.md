# RFD0001 - Feynman specs: describe a system, then play, check, and diff it

- Feature Name: `feynman-specs`
- Status: Draft
- Author: `leostera`
- Start Date: `2026-10-25`
- Updated: `2026-10-25`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

Feynman becomes a TypeScript library for writing **specs**: small, executable models of how
part of a system behaves. A spec declares actors and the state they hold, the messages
between them, the actions people take, the timers and limits that shape them, and the
invariants that must hold. Each rule is anchored to the code it mirrors. Everything else is
derived from that one file:

- a playground to run the system in the browser;
- a flows page with every scenario materialized, and diffs of those flows between commits;
- a built-in checker that explores the spec's state space and reports any invariant it
  breaks, with the trace;
- call stacks from each event down to the real code.

Agents write and maintain specs; Feynman owns the engine, the checker, and every view. This
replaces the extracted JSON model and its fixed renderer.

## Motivation

Feynman's first iteration extracts a JSON model of a whole repository (journeys, actors,
flows, protocols, invariants) and renders it as a static explainer. The part people find
valuable is "How it works": flows with anchored steps and their call stacks. Three
problems remain:

1. **It only does whole systems.** Understanding one part ("how host connectivity works",
   "how repository creation works") means extracting everything first: 8 to 23 minutes
   and tens of thousands of output tokens.
2. **Reading is not understanding.** In two sessions on 2026-10-25, agents asked for an
   interactive explainer of one topic produced something far easier to understand: a
   simulator you could play with. You add Macs and phones, press the buttons a user
   would, step through each message, watch each part's state change, and go back in a
   timeline. The axo simulator surfaced behaviour that nobody had written down: a link
   whose reply is lost can be retried safely; the Mac notices an outage before the
   relay does; a revoked Mac keeps retrying, with growing waits.
3. **Those simulators are throwaway.** Each session rebuilt its UI three or four times,
   at about 10 minutes and 35k tokens per round. Layouts were cramped and missing
   stylesheets went unnoticed, while screenshot checks reported "looks great". Meanwhile
   the engine (`sim.ts`, about 1,100 lines) survived every round unchanged: it held all
   the knowledge. It was also a hand-written copy of the rules, tied to the code only by
   comments, with no way to check it or compare it across commits.

The way forward is to keep the part that survived (an executable description of the
rules) and make it a first-class, versioned, checkable artifact. Feynman provides
everything around it.

Use cases:

- **Onboard:** "show me how remote access works": open the playground, then read the
  flows.
- **Develop:** spec a feature before or while building it, play with it, and check its
  invariants. Try proposed changes as switches.
- **Review:** a merge request changes code and its spec; the explainer shows which flows
  changed ("this used to do this, now it does that"), which call stacks changed, and
  whether the invariants still hold.

## Goals

- A TypeScript DSL for specs that reads naturally to people, and that agents can write
  reliably.
- Deterministic execution: the same actions give the same trace, always.
- One spec produces every view: the playground, timeline, flows, flow diffs, call stacks,
  and reference pages.
- A built-in bounded checker for invariants and bounded liveness, which reports the
  shortest failing trace.
- Every rule anchored to code, with stale rules detected when that code changes.
- One command and a single self-contained HTML output.
- Agents write only the spec, never UI code.

## Non-goals

- Proofs, or unbounded model checking. The checker is bounded and says what it covered.
- Translating TypeScript handlers to TLA+ or Quint, or depending on third-party checkers.
- Conformance against the running system, meaning replaying scenarios against real code.
  This is a future possibility.
- Automatically modelling a whole repository. A spec covers the part someone wants to
  understand. Several specs can cover a system.
- Keeping the JSON model, phases, and extraction driver. They are retired, not adapted.

## Guide-level explanation

### The mental model

A **spec** is a small world:

- **Actors** are kinds of things: a Mac, a phone, a relay. They are spawned as instances,
  so you can have three Macs.
- Each actor holds **state** and offers **actions** that a person can take on it.
- It **handles** messages and timers.
- **Time** is simulated. Messages take time to arrive, and timers fire later.
- **Invariants** say what must always hold, and **scenarios** are named stories.
- **Proposals** are switches for changes under consideration.

Feynman runs this world. Each step is an **event**: an action, a message delivery, a
timer, or an injected fault. Every event records the handler that ran, the code that
handler mirrors, what it sent, and exactly what state it changed.

### Writing a spec

Specs live in the repository under `feynman/`, one system per file, reviewed like any
other code. (The anchors below are illustrative.)

```ts
// feynman/remote-access.ts
import { spec, MIN, SEC } from "@feynman/spec";

export default spec("Remote access", ({ actor, message, limit, zone, invariant, eventually, scenario, proposal }) => {
  zone("devices", "People's devices");
  zone("cloudflare", "Cloudflare");
  zone("macs", "Macs");

  const CODE_LIFETIME = limit("Pairing code lifetime", 10 * MIN, {
    mirrors: "packages/axo-api-worker/src/auth/pairing.ts#CODE_TTL",
  });

  const NewCode = message<{ account: string }>("new pairing code", { over: "https" });
  const Code = message<{ code: string }>("pairing code", { over: "https", tone: "reply" });
  const Redeem = message<{ code: string; host: string; credential: string }>("redeem", { over: "https" });
  const Redeemed = message<{ account: string }>("redeemed", { over: "https", tone: "reply" });
  const Refused = message<{ status: 403 | 404 }>("refused", { tone: "refused" });

  const Relay = actor("Axo relay", { zone: "cloudflare", singleton: true })
    .state({ codes: {} as Record<string, { account: string; used: boolean; expires: number }>,
             hosts: {} as Record<string, { account: string; verifier: string }> })
    .on(NewCode, "packages/axo-api-worker/src/auth/pairing.ts#issue", (ctx, msg, from) => {
      const code = ctx.fresh("code");
      ctx.state.codes[ctx.hash(code)] = { account: msg.account, used: false, expires: ctx.now + CODE_LIFETIME.value };
      ctx.timer(`expire ${code}`, CODE_LIFETIME.value);
      ctx.reply(from, Code, { code }, "A one-time code, valid for 10 minutes.");
    })
    .on(Redeem, "packages/axo-api-worker/src/auth/pairing.ts#redeem", (ctx, msg, from) => {
      const code = ctx.state.codes[ctx.hash(msg.code)];
      if (!code || code.used || code.expires < ctx.now) {
        return ctx.reply(from, Refused, { status: 404 }, "The code is unknown, used, or expired.");
      }
      code.used = true;
      ctx.state.hosts[msg.host] = { account: code.account, verifier: ctx.hash(msg.credential) };
      ctx.reply(from, Redeemed, { account: code.account }, "The relay accepts the code and remembers the Mac.");
    });

  const Person = actor("Person", { zone: "devices" })
    .state({ account: "" as string, codes: [] as string[] })
    .init((ctx) => void (ctx.state.account = `acct-${ctx.label}`))
    .action("Pair a host", {}, "apps/web/src/settings/pair.tsx#createCode", (ctx) => {
      ctx.send(ctx.the(Relay), NewCode, { account: ctx.state.account });
    })
    .on(Code, "apps/web/src/settings/pair.tsx#showCode", (ctx, msg) => {
      ctx.state.codes.push(msg.code);
    });

  const Mac = actor("Mac", { zone: "macs" })
    .state({ link: { account: null as string | null, pending: null as string | null }, keychain: [] as string[] })
    .action("Paste a pairing code", { code: "code" }, "apps/macos/RemoteAccess.swift#link", (ctx, { code }) => {
      const credential = ctx.fresh("cred");
      ctx.state.link.pending = credential;
      ctx.state.keychain.push(credential);
      ctx.send(ctx.the(Relay), Redeem, { code, host: ctx.id, credential });
      ctx.timer("redeem timeout", 5 * SEC);
    })
    .on(Redeemed, "crates/axo-relay/src/pairing.rs#finish", (ctx, msg) => {
      ctx.state.link = { account: msg.account, pending: null };
      ctx.cancel("redeem timeout");
    });

  invariant("The relay never stores a secret", (world) =>
    world.all(Relay).every((relay) => Object.values(relay.state.hosts).every((h) => h.verifier.startsWith("hash:"))));

  eventually("A Mac with a valid code ends up linked", { within: 20 }, (world) =>
    world.all(Mac).every((mac) => mac.state.link.account !== null));

  proposal("Unlink button", "Macs can unlink themselves from Settings.");

  scenario("Link a Mac", (s) => {
    const alice = s.spawn(Person, "Alice");
    const studio = s.spawn(Mac, "Studio");
    s.act(alice, "Pair a host");
    s.settle();
    s.act(studio, "Paste a pairing code", { code: alice.state.codes[0] });
    s.settle();
  });
});
```

Things to notice:

- **Handlers mutate `ctx.state` directly.** Feynman records each change as
  `field: before → after`; nobody logs changes by hand.
- **The second argument of `.on` and `.action` is the anchor:** the code this rule
  mirrors, written `path#symbol`.
- **The last argument of `send` and `reply` is optional text,** shown in the timeline in
  everyday words.
- **Everything a handler can observe comes from `ctx`:** the time (`ctx.now`), fresh ids,
  hashing, and randomness. That is what makes runs replayable and checkable.

### Running it

```console
$ feynman dev
  Remote access  http://localhost:4173/#/play
  2 actors · 1 limit · 3 messages · 1 invariant · 1 scenario · 1 proposal
  watching feynman/remote-access.ts
```

The playground opens:

- **The canvas:** a full-window map with a zone per `zone` and a node per actor
  instance, each showing its state. Clicking a node lists its actions.
- **Animation:** messages travel along edges, and the node that handled an event says
  what happened.
- **The timeline on the right:**
  - hovering an event shows the world at that moment without changing anything;
  - clicking an event rolls back to it;
  - opening an event shows its call stack and code.
- **The sidebar** holds Playground, Flows (one page per scenario, plus flows found by the
  checker), and Reference (actors, messages, limits, invariants, proposals).

Saving the spec reloads the page and replays your current session.

### Checking it

```console
$ feynman check
  Remote access: explored 48,211 states (2 people, 3 Macs, depth 30, 2 faults) in 3.1s
  ✓ The relay never stores a secret
  ✗ A Mac with a valid code ends up linked
      shortest counterexample: 7 events; open with: feynman open --trace check/0
        1 Alice   Pair a host              codes.h(K7Q2) = {account: alice, used: false}
        2 Studio  Paste a pairing code     link.pending: null → cred-1
        3 relay   redeem                   codes.h(K7Q2).used: false → true
        4 fault   lose "redeemed"          (the reply never arrives)
        5 Studio  redeem timeout           …
  coverage: 11 of 12 handlers reached; never ran: Mac.on(refused)
  stale: Relay.on(redeem) mirrors packages/axo-api-worker/src/auth/pairing.ts#redeem, which changed since the spec was last checked
```

Turning a proposal on checks it too: `feynman check --with "Unlink button"`.

### Comparing commits

```console
$ feynman diff main
  Remote access, main → HEAD
  flows/link-a-mac       changed: step 3 now also sets hosts[studio].status = "offline"
  flows/revoke-a-mac     unchanged behaviour; call stack under step 2 changed (2 functions)
  invariants             all hold at both
```

The flows page shows the same diff: steps added, removed, and changed, state effects
compared side by side, and the call tree under each step marked with what CallDiff
reports as added or removed.

### With an agent

In Pi, `/feynman-explain remote access` asks the agent to write or extend
`feynman/remote-access.ts` for that topic. The agent reads the code it needs, writes the
spec, and runs the `feynman_check` tool until it passes; then Feynman renders the
explainer. The agent never writes UI code. Asking for a change to the explainer means a
change to the spec ("let me push from the git client" adds an action); a change to how
something looks is a change to Feynman.

## Reference-level explanation

### Architecture and boundaries

| Package | Owns | Depends on |
|---|---|---|
| `@feynman/spec` | The DSL, the engine (world, events, clock, drafts), traces. Browser-safe, with no runtime dependencies. | nothing |
| `@feynman/check` | Exploration, properties, shrinking, coverage, stale anchors. | spec |
| `@feynman/code` | Snapshots, anchors, source versions, call trees through CallDiff, worktrees for other commits. Moved from `@feynman/model`. | git, calldiff |
| `@feynman/view` | React and Kumo views: Playground, Timeline, Flows, FlowDiff, CallStack, Reference. Layout. | spec |
| `@feynman/cli` | `feynman dev`, `check`, `build`, `diff`, `open`. Single-file builds. | all |
| `pi-feynman` | A thin adapter: `/feynman-explain`, plus the `feynman_check` and `feynman_render` tools, and the skill that teaches the DSL. | cli |

`@feynman/model`, `@feynman/modeler`, and `@feynman/renderer` are retired. What
survives moves to `@feynman/code`: snapshots, anchors, call trees, and source versions.

### Data model and interfaces

**Declarations.** These are plain data, available to every view, the checker, and the
diff:

- `Actor`: name, zone, singleton or spawnable, an initial-state factory, actions,
  handlers, and an optional per-instance label.
- `Message<P>`: name, protocol (`over`), tone, and the payload type.
- `Handler`: the actor, its trigger (a message, a timer, or an action), its anchor, and
  its function.
- `Limit`: name, value, unit, and anchor. `Zone`: id and label.
- `Property`: `invariant`, `eventually` (within N events, with fair timers), or `never`
  (a forbidden event pattern).
- `Scenario`: a name and a script against the scenario API.
- `Proposal`: a name and a description. Handlers read it with
  `ctx.proposal("Unlink button")`.

**Runtime.**

- `World`:
  - instances, with their state;
  - the queue of pending deliveries and timers, each with its due time;
  - the clock, the seed, and the id counters;
  - the proposals that are on.

  It is plain data, so it can be serialized, hashed, and copied cheaply.
- `Event`:
  - `{ index, at, kind: "action" | "deliver" | "timer" | "fault", actor, handler, anchor }`;
  - `changes: { path, before, after }[]`, `sent: Delivery[]`, `text?`.
- `Trace`: the initial world, the events, and a snapshot of the world every K events, so
  that seeking is fast.

**The ctx API** is the only way a handler sees the world:

- Reads: `state`, `id`, `now`, `the(Actor)`, `all(Actor)`.
- Messages: `send`, `reply`, `broadcast`.
- Timers: `timer(name, after)`, `cancel(name)`.
- Values: `fresh(prefix)`, `hash(value)`, `random()` (seeded), `proposal(name)`.
- Failure: `fail(reason)`, which ends the event with a recorded refusal.

**Anchors** are `path#symbol` or `path:line`, resolved with the existing anchor code.
`feynman.lock` (generated, committed) records the git blob id of each anchored file when
the spec was last checked. A handler is stale when the file it mirrors has changed since.

### The engine

- **Step:**
  1. Pick the next event: either a scripted or playground action, or the earliest due
     delivery or timer, with ties broken by insertion order.
  2. Run its handler on a copy-on-write draft.
  3. Record the changes and sends, then check the invariants.
- **Delivery latency** defaults to a per-zone-pair value that the spec can override, and
  is shown as assumed.
- **Determinism:** handlers run with no access to `Date`, `Math.random`, I/O, or `async`.
  The DSL types forbid promises in handlers; the engine forbids the globals through a
  frozen scope in development and freezes state between events. Detected nondeterminism
  (a replay giving a different trace) is a hard error.

### The checker

- **Choices at each state:**
  - every enabled action on every instance, with inputs drawn from values in the world
    (existing codes, ids) plus one invalid value of each input type;
  - every pending delivery or timer that could fire next;
  - every fault in the budget: lose a delivery, partition a zone, restart an instance
    (state declared `durable` survives).
- **Time is ordering:** any due event may fire next, and timers keep their order among
  themselves.
- **Bounds:** the instances per actor, the depth, the fault budget, and a time limit. The
  defaults finish in seconds; `--deep` is for CI.
- **Reduction:**
  - states are hashed after canonicalization;
  - instances of the same actor kind are symmetric up to renaming;
  - breadth-first search gives the shortest counterexamples.
- **Properties:**
  - `invariant` is checked on every state;
  - `eventually` is checked on every path within N events, with fair timers;
  - `never` matches event patterns.
- **Shrinking:** a counterexample is shortened by dropping or reordering events while it
  still fails, then saved as a trace under `.feynman/traces/`.
- **Coverage:** the handlers, actions, and branches reached, reported alongside the
  results.
- **Flow discovery:** each distinct trace shape (the sequence of actor, handler, and
  message) is a candidate flow. The Flows page shows the named scenarios first and the
  discovered shapes in a separate, collapsed section.

### Views

Each requirement comes from the 2026-10-25 sessions:

- **A full-bleed canvas,** with no header block and no row that holds a single control.
- **Actions belong to nodes.** Clicking a node lists its actions; there are no global
  forms. The first thing to try is suggested on the canvas.
- **A timeline on the right, which is the event log:** hovering previews, clicking rolls
  back, and opening an event shows its call stack. There is no separate "what changed"
  panel.
- **Layout is computed, never placed by hand:** ELK with zones as compound nodes, and
  containment for state drawn as boxes.
- **Kumo components and semantic tokens only,** with light and dark modes through
  `data-mode`.
- **Flows:**
  - a sequence view with steps, the state changes of each step, and the call stack under
    each step;
  - a commit picker that turns the page into a diff.
- **Anchors open the code,** embedded in the build for the files that anchors reference.

### Diff semantics

`feynman diff <base>` checks out the spec and the code at `<base>` in a worktree, then
runs every scenario at both commits.

- **Alignment:** the two traces are aligned on `(actor kind, handler, message)` with a
  longest common subsequence.
- **Step status:** each step is `same`, `changed` (its state changes or sends differ), or
  `added`/`removed`.
- **Call trees:** each step's anchor is measured at both commits, and CallDiff marks the
  functions added, removed, or changed.
- **Classification for each flow:**
  - **behaviour changed:** the traces differ;
  - **implementation only:** the traces are the same but call trees changed;
  - **possibly stale:** anchored code changed, but neither the spec nor the trace did.

A scenario missing at the base is all new. A spec missing at the base means the whole
system is new.

### Invariants of this design

- A spec plus a seed plus actions gives exactly one trace.
- Every handler has an anchor, and every event in a trace names its handler and anchor.
- Views read only declarations and traces; they contain no knowledge of any system.
- `feynman check` output names its bounds; nothing claims more than was explored.

### Compatibility and migration

The JSON model (`.feynman/model/`), its schemas, the three-phase extraction, and the
renderer are removed in one cutover, with no compatibility layer. Models already
generated are not migrated: specs are written for the topics people care about. The
`feynman.leostera.dev` site is rebuilt from specs.

### Security, privacy, and observability

- **Specs are code in the user's repository,** run by the CLI with the user's
  permissions, like tests.
- **Built explainers embed only what anchors reference,** plus the spec.
- **Names, not values.** Specs should model secrets symbolically (`hash:…`, `cred-1`),
  never with real values. The skill says so, and the checker warns about strings that
  look like keys.

### Rollout and validation

1. `@feynman/spec`: the DSL, engine, and traces, with a test suite of small specs and
   determinism tests that replay every trace.
2. `@feynman/view`: the playground and timeline, then flows. Build the axo remote-access
   spec by hand from the existing `sim.ts`, and compare it with the session's playground.
3. `@feynman/check`: invariants, faults, shrinking, coverage, and stale anchors.
4. `@feynman/code` and `feynman diff`: trace alignment and call-tree diffs.
5. `pi-feynman`: `/feynman-explain <topic>`, the tools, and the skill.

**Acceptance:** an agent writes a remote-access spec for axo in under 10 minutes with no
UI code. `feynman check` finds the lost-reply case, either as a counterexample or as a
covered path. `feynman diff` shows a real change between two axo commits.

## Drawbacks

- **A spec is a second description of the system.** Anchors and staleness detect drift,
  but they don't prevent it. Until conformance exists, a spec can be wrong and still
  pass its checks.
- **State spaces explode.** A bounded checker can miss bugs outside its bounds, and the
  bounds that matter differ per system.
- **The DSL is a new thing to learn,** for people and agents, and every API mistake gets
  copied into many specs.
- **Determinism can't be fully enforced in JavaScript;** a handler can still close over
  mutable module state.
- **Starting over discards working code** (the extraction, coverage ledgers, and
  renderer), along with a first iteration that people found useful.

## Rationale and alternatives

### Proposed design

An executable spec is the smallest artifact that holds what the sessions showed matters:
the rules, the state, and time. Every view is derived from it, and it can be checked and
compared. TypeScript keeps it readable to the people and agents who already write the
code. Building our own engine and checker keeps the whole loop under Feynman's control:
determinism, traces, anchors, and views share one data model.

### Simpler or narrower approach

Keep the JSON model and add step effects and a story player. That gives guided tours, but
not a playground, checking, or exploration: the rules stay prose. It also keeps the
whole-repository extraction cost.

### Other alternatives considered

- **A Feynman runtime for hand-written simulators:** ship the playground and timeline as
  components and let each explainer bring its own engine. It fixes the UI churn, but there
  is no checking, no diff, and no common trace format.
- **XState statecharts:** good for one actor's lifecycle, weak for many actors exchanging
  messages with simulated time. Its runtime is not built for state-space exploration.
- **Quint or TLA+ specs:** strong checking, but people would read and write a different
  language, and the views would depend on a third-party toolchain. Export may come
  later.
- **The P language:** close to this design (actors, events, a model checker), but it is
  C#-based, not TypeScript, and isn't anchored to the code.

### Do nothing

Feynman stays a whole-repository extractor with a static renderer. People who want to
understand one part keep asking agents for throwaway simulators, at about 30 minutes and
125k tokens per explainer, with no checking or diffs.

## Prior art

- **TLA+ and TLC, and Quint:** explicit-state checking, invariants, and fairness. We
  borrow bounded breadth-first search, state hashing, and symmetry reduction.
- **P:** actors and events with systematic testing. It shows that the
  communicating-actors model fits distributed protocols.
- **FoundationDB's deterministic simulation, and Jepsen:** fault injection under a
  simulated clock finds real bugs. Determinism is what makes failures reproducible.
- **fast-check and QuickCheck:** shrinking counterexamples to the smallest one that still
  fails.
- **XState's inspector, and Redux DevTools:** timelines with time travel. We borrow hover
  to preview and click to roll back.
- **The 2026-10-25 sessions** (axo remote access, artifacts repository creation): the
  engine survived every UI rewrite, and users asked for the same interface in both.

## Unresolved questions

### Before acceptance

- **Where specs live:** `feynman/*.ts` at the root, or `.feynman/specs/`. Specs are
  reviewed code, which argues for a visible `feynman/`.
- **API shape:** a builder (`actor().state().on()`), which infers payload types well, or
  object literals, which are shorter but type less precisely.
- **Inputs for exploration:** how the checker enumerates action inputs. Values from the
  world plus one invalid value per type may be too narrow for numeric inputs.
- **Several specs for one system:** whether they share actors, through imports from a
  common file, or stay independent.

### During implementation

- The copy-on-write draft: Immer, Mutative, or our own Proxy.
- Snapshot interval and memory budget for long playground sessions.
- ELK settings for zones and containment; how state drawn as boxes is declared.
- How `eventually` interacts with faults (the fault budget versus fairness).

### Out of scope

- Conformance: replaying scenarios against the running system or its tests.
- Export to Quint or TLA+.
- Hosting, logins, and sharing explainers as a service.
- Watch mode (Read and Watch narrations of a flow).

## Future possibilities

- **Conformance tests:** a scenario drives the real system through adapters, and the
  real trace is compared with the spec's.
- **Specs from extraction:** an agent proposes a spec for a directory, guided by call
  trees, and the checker and the person refine it.
- **Live review:** comments on a timeline event or a flow step go back to the Pi session
  working on the code.
- **Narrated flows:** Read and Watch versions written from traces, so they're grounded in
  the spec by construction.
