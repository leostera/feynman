---
name: feynman
description: Write and check Feynman specs, which are small executable models of how part of a system behaves (actors, messages, timers, invariants, scenarios) tied to the code by sources. The feynman CLI derives a playground, flows, model checking and diffs from them. Use to explain how a feature works, to review how a change affects behaviour, or to design a feature before or while building it.
---

# Feynman specs

A spec is a TypeScript file that models one behaviour of a system as a deterministic,
discrete-event program. You write only the spec. The `feynman` CLI derives everything else
from it:

- a playground to try it in;
- the flows of every scenario;
- a bounded model checker for its invariants;
- diffs between commits;
- links from every step to the code.

**Never write UI code for an explainer.**

## When to write one, and how big

- **Explain:** one spec per behaviour a newcomer would ask about, such as "how does a Mac
  get linked to an account?" Do not write one spec per service.
- **Review:** extend or adjust the spec that covers the change. `feynman diff` shows what
  changed in each scenario.
- **Develop:** write the spec first, check it, then write code that matches it. A spec
  needs no code: leave `sources` out of steps that are not built yet, and `feynman check`
  says which those are. The checker finds design flaws before there is anything to
  debug. Add `sources` to each step as its code appears; a source that is given must
  point at real code.

A spec models **this** system, not a kind of system. Someone who knows the code should be
able to point at every actor, message and step and say where it is.

- **An actor is something that runs separately or keeps its own state:** a process, a
  service, an external API, a database you do not own, a person, a device. Never merge two
  of them into one actor, and never split one process into several actors.
- **Calls inside one process are steps, not messages.** If `pipeline.py` calls download,
  then transcribe, then analyze, those are three steps of one actor, each with its own
  `sources`, chained with `ctx.start("transcribe", 0)` or a `when` guard on the state. A
  message means something crosses a process or network boundary.
- **One step per stage the code has.** A step whose sources span several functions in
  several files is hiding the system; split it.
- **Use the system's own words** for actors, messages, steps, statuses, files and tables:
  `READY`, `analysis.json`, "Pending folder". Don't invent generic roles such as
  "processor", "pipeline" or "store" unless the code uses them. Keep names short; put the
  tool list ("yt-dlp / Instaloader") in `description` or `look.status`, not the name.
- **Scope follows the request.** "The whole pipeline" means all of it. If that is too much
  for one spec, write several specs, one per behaviour. Never compress it into fewer,
  vaguer steps.

What to leave out: logging, metrics, retries the user can't observe. Leave state out only
if it never decides what happens next.

Before you finish, go through the spec once more. For each actor, message and step, ask:
"Could someone who knows this code point at it?" Rename or split anything that fails.

## Workflow

1. **Read the code first.** Find:
   - the actors: processes, services, people, devices (what runs separately);
   - the stages inside each process, in the order the code runs them;
   - what each one stores;
   - what each one sends, and when;
   - the timeouts and limits.

   Note the exact `path#symbol` for every step.
2. **Write `specs/<behaviour>.ts`** next to the package's `package.json` (the repository
   root counts).
3. Run `feynman check <behaviour>`. It does three things:
   - type-checks the spec;
   - runs every scenario;
   - explores every interleaving within bounds, then checks the invariants and that every
     source resolves.

   Fix what it reports. "Stands for N pieces of code in M files" means one step is
   hiding several stages: split it. "Never ran" means no scenario or explored path
   reached those steps, so nothing about them was tested.
4. **When a counterexample appears**, decide whether it is a bug in the spec (the model
   is wrong) or a finding in the system (the code really does this). Do not weaken an
   invariant to make a finding go away; report it.
5. Run `feynman run <behaviour>` to read the traces of the scenarios as text.
6. Once the spec is right, run `feynman lock`. It records the code each source stands
   for, so later checks flag sources whose code changed.
7. Optionally, run `feynman dev` (or `build`/`open`) to open the explorer. Use
   `--base main` to compare with a branch.

**Do not commit unless asked.**

## The DSL

```ts
import { defineSpec, message, MIN, SEC } from "@feynman/spec";

export default defineSpec(
  "Remote access",
  {
    description: "How a Mac gets linked to an account with a one-time pairing code.",
    // Every message, declared first. Payload types are what the checker and editor see.
    messages: {
      NewCode: message<{ account: string }>({ name: "new pairing code", over: "https" }),
      Code: message<{ code: string }>({ name: "pairing code", over: "https", tone: "reply" }),
      Redeem: message<{ code: string; host: string }>({ name: "redeem", over: "https" }),
      Redeemed: message<{ account: string }>({ name: "redeemed", tone: "reply" }),
      Refused: message<{ status: 404 }>({ name: "refused", tone: "refused" }),
    },
  },
  (spec) => {
    const { NewCode, Code, Redeem, Redeemed, Refused } = spec.messages;

    const devices = spec.defineZone({ name: "People's devices" });
    const cloud = spec.defineZone({ name: "Cloudflare" });

    const CODE_LIFETIME = spec.defineLimit({
      name: "Pairing code lifetime",
      value: 10 * MIN,
      sources: ["packages/api/src/pairing.ts#CODE_TTL"],
    });

    const Relay = spec.defineActor({
      name: "Relay",
      description: "The Worker that issues and redeems pairing codes.",
      zone: cloud,
      singleton: true, // exactly one, present from the start
      initialState: () => ({ codes: {} as Record<string, { account: string; used: boolean; expires: number }> }),
      durable: ["codes"], // survives a restart (it lives in a database)
      // How it is drawn in the playground: an icon, a status, and its state as rows.
      look: {
        icon: "cloud",
        status: (s) => `${Object.values(s.codes).filter((c) => !c.used).length} code(s) waiting`,
        rows: (s) => Object.values(s.codes).map((c) => ({ group: `${c.account}'s account`, label: "pairing code", detail: c.used ? "used" : "unused", mood: c.used ? "off" : "info" })),
      },
      transitions: {
        // Keyed by message: runs when the message is delivered.
        [NewCode]: {
          description: "Issues a one-time code for the account.",
          sources: ["packages/api/src/routes/pairing.ts#createPairing"],
          sends: [Code],
          // The timeline's sentence for this event, from the state after it.
          say: (_s, msg) => `Made a code for ${msg.account}, valid 10 minutes; only its hash is kept`,
          run(state, msg, ctx) {
            const code = ctx.fresh("code");
            state.codes[ctx.hash(code)] = { account: msg.account, used: false, expires: ctx.now + CODE_LIFETIME.value };
            ctx.reply(Code, { code });
          },
        },
        [Redeem]: {
          description: "Checks the code and, if valid, links the Mac.",
          sources: ["packages/api/src/routes/pairing.ts#redeemPairing", "packages/api/src/pairing.ts:31-58"],
          sends: [Redeemed, Refused],
          run(state, msg, ctx) {
            const entry = state.codes[ctx.hash(msg.code)];
            if (!entry || entry.used || entry.expires < ctx.now) return ctx.reply(Refused, { status: 404 }, "Unknown, used, or expired.");
            entry.used = true;
            ctx.reply(Redeemed, { account: entry.account });
          },
        },
      },
    });

    const Person = spec.defineActor({
      name: "Person",
      zone: devices,
      initialState: (ctx) => ({ account: `acct-${ctx.label}`, codes: [] as string[] }),
      look: {
        icon: "phone",
        status: (s) => (s.codes.length ? `code ${s.codes.at(-1)}` : "signed in"),
        // The code on screen, to drag onto a Mac (see `accepts` on the Mac's `link` input).
        tokens: (s) => s.codes.slice(-1).map((code) => ({ kind: "pairing code", value: code })),
      },
      // Actions: what a person (or the outside world) can do. They are buttons in the playground,
      // and the checker tries them in every order.
      actions: {
        pair: {
          label: "Pair a Mac",
          description: "Asks the relay for a code to type on a Mac.",
          sources: ["apps/web/src/pair.tsx#createCode"],
          sends: [NewCode],
          run: (state, _inputs, ctx) => ctx.send(ctx.the(Relay), NewCode, { account: state.account }),
        },
      },
      transitions: {
        [Code]: { description: "Shows the code.", sources: ["apps/web/src/pair.tsx#showCode"], run: (s, msg) => void s.codes.push(msg.code) },
      },
    });

    const Mac = spec.defineActor({
      name: "Mac",
      zone: devices,
      initialState: () => ({ account: null as string | null, pending: null as string | null }),
      look: {
        icon: "laptop",
        status: (s) => (s.account ? "linked" : s.pending ? "linking" : "not linked"),
        mood: (s) => (s.account ? "ok" : s.pending ? "busy" : "off"),
      },
      // The live connections it holds, drawn as lines; `to` is an instance id or label, or a singleton's name.
      links: (s) => (s.pending ? [{ to: "Relay", kind: "https", style: "dotted" }] : []),
      actions: {
        link: {
          label: "Paste a pairing code",
          description: "Links this Mac to the account that issued the code.",
          // Inputs have a type; examples are what the playground offers and the checker tries.
          // Examples are what the playground offers and the checker tries: a list, or a function of the world.
          // Give such functions a return type when they name another actor (see "Types" below).
          inputs: { code: spec.defineInput(String, { examples: (w): string[] => [...w.all(Person).flatMap((p) => p.state.codes), "never-issued"], accepts: "pairing code" }) },
          when: (s) => s.account === null, // offered only while this holds
          sources: ["apps/macos/RemoteAccess.swift#RemoteAccess.link"],
          sends: [Redeem],
          starts: ["redeemTimeout"],
          run(state, { code }, ctx) {
            state.pending = code;
            ctx.send(ctx.the(Relay), Redeem, { code, host: ctx.id });
            ctx.start("redeemTimeout", 5 * SEC);
          },
        },
      },
      transitions: {
        [Redeemed]: {
          description: "The Mac is linked.",
          sources: ["crates/axod/src/pairing.rs#finish"],
          run(state, msg, ctx) {
            state.account = msg.account;
            state.pending = null;
            ctx.cancel("redeemTimeout");
          },
        },
        [Refused]: { description: "Stays unlinked.", sources: ["crates/axod/src/pairing.rs#refused"], run: (s, _m, ctx) => ((s.pending = null), ctx.cancel("redeemTimeout")) },
        // Keyed by a label: an internal transition, run as a timer (ctx.start) or whenever `when` holds.
        redeemTimeout: {
          description: "No answer in time; gives up.",
          sources: ["crates/axod/src/pairing.rs#timeout"],
          run: (s) => void (s.pending = null),
        },
      },
    });

    spec.defineInvariants({
      // always: holds in every state.
      codesAreHashed: { description: "The relay stores only hashes of codes.", always: (w) => Object.keys(w.the(Relay).state.codes).every((k) => k.startsWith("hash:")) },
      // eventually: once `after` holds, the system running by itself gets there within `within` ms.
      pendingResolves: { description: "A Mac waiting for an answer gets one.", eventually: (w) => w.all(Mac).every((m) => m.state.pending === null), within: 10 * SEC },
      // never: no trace has this shape.
      redeemedOnce: { description: "A code is never redeemed twice.", never: (t) => t.count((e) => e.replied(Redeemed)) > t.count((e) => e.is(Person, "pair")) },
    });

    // Scenarios: the flows a reader should see, scripted. Each becomes a flow and a playground start.
    spec.defineScenario({
      name: "Link a Mac",
      description: "The happy path: a person pairs, the Mac redeems the code.",
      run(s) {
        const alice = s.spawn(Person, "Alice");
        const studio = s.spawn(Mac, "Studio");
        s.act(alice, "pair");
        s.settle();
        s.act(studio, "link", { code: alice.state.codes[0] });
        s.settle();
        // s.the(Actor) reaches singletons; s.world reads the whole world.
        if (!s.the(Relay).state.codes) throw new Error("unreachable");
      },
    });
  },
);
```

### Rules the engine enforces

- **Determinism.** Handlers see the world only through `ctx`:
  - `now`, `id`, `label`;
  - `fresh(prefix)` for ids, `hash(value)` and `random()`;
  - `send`, `reply`, `start(label, ms)` and `cancel(label)`;
  - `the(Actor)`/`all(Actor)` to find instances, and `note(text)`.

  Don't use `Date`, `Math.random`, `async`, I/O or module-level mutable state.
- **Mutate `state` in place.** The engine records each change as `path: before → after`.
- **Declare effects.** Every message a step sends must be listed in its `sends`, and every
  timer it starts in its `starts`. The types check most of this. An undeclared send at
  runtime is a spec error, and the step's effects are discarded.
- **Every message needs a handler.** A delivered message with no transition on the
  receiver is a spec error.
- **Write descriptions in everyday words**, one sentence, about what happens and not how
  the code does it. Use `ctx.note(text)` or the `text` argument of `send`/`reply` for what
  is specific to one event.

### Make the playground worth looking at

The playground is drawn from the spec, so the spec decides how good it looks. For every
actor, add:

- **`look.icon`.** One of `person`, `people`, `phone`, `laptop`, `desktop`, `browser`,
  `server`, `cloud`, `database`, `shield`, `key`, `lock`, `terminal`, `robot`, `queue`,
  `folder`, `file`, `sheet`, `globe`, `gear`, `camera`, `video`, `mail`, `bell`, `clock`,
  `cpu`, `box`, `plug`, `wifi`, `chat`, `router`, `storage`, `code`, `pipeline`, `eye` or
  `card`.
- **`look.status`:** a few words under the name, such as "connected", "not linked" or
  "3 jobs queued".
- **`look.mood`:** `ok`, `warn`, `bad`, `busy`, `off` or `info`, which colours the node.
- **`look.rows`** for state worth seeing as structure, such as a service's accounts and
  hosts, or a queue's jobs. Give each row a `label`, an optional `detail` and `mood`, and
  a `group` to box rows together. Use it on hubs (singletons); on other actors, keep it to
  one to three rows.
- **`links`** for connections that come and go: sockets, sessions, subscriptions. Only
  live links are drawn prominently.
- **`look.tokens`** for things a person would carry from one node to another: a pairing
  code shown on a phone, a link to share, a file to upload. Each is `{ kind, value, label? }`,
  and it floats beside the node. Give the receiving action's input `accepts: kind`, as in
  `spec.defineInput(String, { examples, accepts: "pairing code" })`. Dragging the token onto
  that node then runs the action with it. This is the most memorable way to show a
  hand-off between actors.
- **`row`** on a link: the label of the target's row it ends at. With it, a Mac's socket
  meets that Mac's line in the relay rather than the relay's icon.
- **`owner`** on a row: the instance it belongs to, by id or label. The row's group, and
  the row itself if it has no mood, take that instance's colour; links take their
  source's. Readers can then follow Alice through the system.
- **Zone `description`**: a few words beside its name, such as "sign in with Access".
- **`say`** on the steps a reader cares about. It is the sentence the timeline and the
  speech bubbles show, such as "Made code 19YP for alice, valid 10 minutes". Without it,
  they show the `description`.

These functions take only the actor's own state. Keep them cheap and total: a throw
shows nothing rather than an error.

### Types

- `import { defineSpec, message, SEC, MIN } from "@feynman/spec"` is all a spec needs.
  For helpers, the types are `Actor`, `Instance`, `World`, `Ctx`, `Script`, `Look`,
  `Link`, `Row`, `Icon` and `Mood`.
- **Let inference work; don't annotate actors.** If tsc says an actor "implicitly has type
  'any' because it … is referenced directly or indirectly in its own initializer", two
  actors refer to each other inside a function whose return type TypeScript has to infer.
  This is usually input `examples`. Give that function a return type:
  `examples: (w): string[] => …`.
- To send to yourself, use `ctx.send(ctx.self, …)`. Avoid `ctx.the(ThisActor)`.
- **Actions without inputs** leave out `inputs`. Scenarios call them as `s.act(x, "pair")`.
- **Use one message per meaning.** If a refusal means different things in different
  places, declare different messages. Don't add a field to tell them apart.
- Write `durable` as a list of state fields, like `durable: ["codes"]`.

### Sources

`sources` is an ordered trail from the entry point inwards. Each entry is either:

- `path#symbol`, with `Outer.method` or `Outer::method` for methods, found by definition in
  TypeScript, JavaScript, Rust, Swift, Go, Python and more;
- `path:start-end`, when there is no symbol.

Paths are relative to the repository root. The first `path#symbol` of a step is the root
of its call tree in the explorer.

**Point at real code; never invent paths.** `feynman check` fails on sources that don't
resolve.

### Modelling choices

- **Instances.** Use `singleton: true` for things there is one of (a service, a database).
  For the rest, scenarios `spawn`, and the checker uses one of each, or more with
  `--instances Mac=2`.
- **State.** Keep only what decides behaviour. Use hashes, not secrets (`ctx.hash`).
- **Repeats.** The checker lets each instance take the same action at most `--repeats N`
  times on one path (2 by default). Raise it when a bug needs more.
- **Faults.** The checker loses messages and restarts instances within `--faults N` (1 by
  default). State listed in `durable` survives a restart.
- **Time.** Messages take `latency` ms (50 by default; set per message with
  `message({ latency })`). Timers fire at `now + ms`. Use real values from the code, and
  `defineLimit` for named ones.
- **`when` guards** gate actions (offered only while true) and internal transitions (which
  then run whenever true, without a timer).

## Commands

```
feynman list                   the specs found
feynman run [spec] [--scenario NAME]
feynman check [spec] [--depth 14] [--faults 1] [--repeats 2] [--instances Actor=N] [--max-states N] [--time-limit S]
feynman lock                   record source hashes in feynman.lock
feynman diff [spec] [--base main]
feynman dev [--port 4321] [--base REF]
feynman build [--out .feynman/site] [--base REF]
feynman open
```

When `check` stops at its state limit, it says so. If that happens, lower `--depth`, use
fewer instances, or narrow the examples of inputs. An explored state space that is too
big usually means the spec models too much.

A `feynman.config.ts` at the repository root can name spec globs and checker defaults:

```ts
import { defineConfig } from "@feynman/cli";
export default defineConfig({ specs: ["docs/specs/*.ts"], check: { depth: 12, instances: { Mac: 2 } } });
```

## What to report back

When you finish, report:

- the spec's path;
- what it covers and what it leaves out;
- the scenarios;
- the check result: which properties hold, within which bounds, and every counterexample,
  each classified as a spec mistake (fixed) or a system finding (with the trace);
- any sources you could not pin down.
