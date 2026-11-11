# Appendix B. Quick reference

Everything the book uses, on one page, with the chapter that explains it.

## Commands

| Command | What it does | Chapter |
| --- | --- | --- |
| `feynman list` | the specs it finds, with their size | 2 |
| `feynman run <spec>` | every scenario, one line each: `✓`, or `✗` and why | 6 |
| `feynman run <spec> --scenario NAME` | one scenario's trace; `--all` for every one | 6 |
| `feynman check <spec>` | explore every order of events within the bounds, and judge every property | 1, 5 |
| `feynman lock` | record what the code each source points at looks like | 13 |
| `feynman diff <spec> --base REF` | every scenario's flow, on REF and now, compared | 13 |
| `feynman dev` | the explorer, reloading on save | 14 |
| `feynman build` / `open` | the explorer as one HTML file | 14 |

A spec is found by its path, by its file name without `.ts`, or by `specs/*.ts` next to a
`package.json`, or by the globs in `feynman.config.ts`.

## `check` flags

| Flag | Default | Chapter |
| --- | --- | --- |
| `--depth N` | none: every depth | 10, 12 |
| `--instances Actor=N` | 1 of each, plus scenario setups | 1, 12 |
| `--set name=value` (a budget or variable) | as declared | 8, 12 |
| `--only P,Q` | every property | 5 |
| `--without RULE` / `--no-rules` | every rule on, each checked off | 11 |
| `--brief` / `--json` | full output | 5 |
| `--as-scenario` (with `--only`) | | 15 |
| `--max-states N`, `--time-limit S`, `--memory-limit GB` | 300,000; 20 s; half the machine's memory | 12 |
| `--walks N`, `--walk-depth N` | 2,000; 120 | 12 |
| `--no-symmetry` | symmetry on where declared | 12 |

Defaults for a whole repository go in `feynman.config.ts`:

```ts
import { defineConfig } from "@leostera/feynman/config";

export default defineConfig({ specs: ["specs/*.ts"], check: { maxStates: 500_000 } });
```

## Verdicts

| Mark | Means |
| --- | --- |
| `✓` | held in every world within the bounds, and every world within them was explored |
| `~` | held as far as the search got: a limit stopped it, or a depth bound cut paths off |
| `?` | never tested: no explored world was one it applies to |
| `✗` | broken; the counterexample follows, with the faults it needs |
| `✓ rule  needed` | without the rule, a property that needs it breaks |
| `✗ rule  not needed` | without the rule, everything still holds: the rule or the property is wrong |

## The parts of a spec

| Part | Written as | Chapter |
| --- | --- | --- |
| zone | `defineZone({ name, description, place })` | 3, 14 |
| actor | `defineActor({ name, zone, singleton?, symmetric?, initialState, display, actions, transitions })` | 3 |
| action (what a person does) | `actions: { key: { label, description, with?, when?, inputs?, sends?, run } }` | 3 |
| input | `inputs: { seat: oneOf("A1", "A2") }`, `input(String, { examples })` | 3 |
| message | `defineMessage("Name", { field: Type }, { name?, over?, tone? })` | 4 |
| transition on a message | `transitions: { key: { on: Message, description, sends?, run(state, msg, ctx) } }` | 4 |
| guarded transition | `{ description, when: (state) => …, run }` | 9 |
| timer | `{ description, after: "10 minutes", run }`, set with `ctx.start(key)` | 7 |
| safety property | `defineProperty(id, { description, always: (w) => … })` | 5 |
| step property | `defineProperty(id, { description, everyStep: (before, after) => … })` | 5 |
| must be possible | `defineProperty(id, { description, reachable: (w) => … })` | 5 |
| liveness property | `defineProperty(id, { description, leadsTo: { whenever, then } })`, `eventually` | 10 |
| scenario | `defineScenario(name, { description, setup?, run(s) })` | 6 |
| rule | `defineRule(id, { description })`, read as `rule.on`, named in `needs` | 11 |
| limit | `defineLimit({ name, value, unit, sources })` | 13 |
| spec | `defineSpec({ name, actors, properties, scenarios, finalState?, limits? })` | 1 |

## What a step can do (`ctx`)

| Call | Does |
| --- | --- |
| `ctx.send(to, Message, payload)` | send; `to` is an instance, `ctx.the(Actor)`, or `{ id }` |
| `ctx.reply(Message, payload)` | answer the sender (in a transition on a message) |
| `ctx.start(timer)` / `ctx.cancel(timer)` | set or clear one of this actor's timers |
| `ctx.the(Actor)` / `ctx.all(Actor)` | find instances to send to |
| `ctx.fresh("order")` | a new id: `order-1`, `order-2` |
| `ctx.note(text)` | explain this one event in the trace |
| `ctx.self`, `ctx.id`, `ctx.from` | who is running, and who sent the message |

## Faults and bounds (`@leostera/feynman`)

| Part | Means | Chapter |
| --- | --- | --- |
| `budget("faults", N)` | at most N faults on any path; `--set faults=M` changes it | 8 |
| `lose(Message, { spend })` | the message may be lost | 8 |
| `lose(Reply, { fails: Call, spend })` | a lost reply fails the call it answers | 8 |
| `duplicate(Message, { spend })` | the message may arrive twice | 8 |
| `defineCall("Name", schema)` + `on: failed(Call)` | a request whose failure the caller hears about | 8 |
| `crash({ keeps: ["field"], spend })` | restart: memory and timers gone, `keeps` stays | 9 |
| `atMost(N)` in `with` | an action at most N times per instance | 3 |

## Scenario scripts (`s`)

| Call | Does |
| --- | --- |
| `s.act(instance, "action", inputs?)` | a person does something |
| `s.deliver(instance, Message)` | deliver the oldest such message to it, now |
| `s.step(instance, "step")` | take a step: a fault, a timer, a guarded transition |
| `s.settle()` / `s.settle({ until })` | leave the system alone until nothing is pending, or until `until` holds |
| `s.spawn(Actor, label)` | a new instance |
| `s.the(Actor)`, `s.all(Actor)` | find instances |

## Display (chapter 14)

`display: { icon, names, status, mood, rows, owner, tokens, shape }` on an actor, and `say`
on a step. `<spec>.play.tsx` with `definePlayground` from `@leostera/feynman/play` for
anything else.

## Habits from the book

1. One step per stage of the code: a step ends where the code waits on another process
   (chapters 4, 13, 15).
2. Say what's on disk with `crash({ keeps })`, and what's in memory with everything else
   (chapter 9).
3. Model the faults the system meets. "No faults" is a warning, not a compliment (chapter 8).
4. Give every safeguard a rule and every property its `needs` (chapter 11).
5. Write scenarios for the questions people ask (chapter 6).
6. Read `~` and `?` as "not checked" (chapter 12).
7. Retell every counterexample in a sentence with names before acting on it (chapter 15).
8. Never weaken a property to make a finding go away (chapter 15).
