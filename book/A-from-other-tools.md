# Appendix A. Coming from TLA+, Alloy or P

Feynman borrows from all three, and differs from each. If you know one of them, this page maps
what you know onto what this book uses.

## The big differences

- **It's TypeScript.** The spec is a program in the language your team already reads, with
  the editor, types and imports it already has. No new notation to learn or review.
- **Actors and messages are built in.** TLA+ and Alloy model anything, and you build
  processes and networks yourself. P and Feynman start from communicating state machines.
- **Faults are declared, not built.** Lost, repeated and failed messages, and crashes, come
  from a library (`lose`, `duplicate`, `defineCall`, `crash`) with a budget, not from network
  variables you write by hand.
- **Specs point at code.** `sources`, `feynman lock`, and `feynman diff` tie each step to the
  code it describes, and say when the code moved (chapter 13).
- **The same file is the explanation.** Playground, flows and checks are derived from it
  (chapter 14).
- **Time is order only.** There's no clock: a timer may fire at any moment after it's set
  (chapter 7). TLA+ specs usually do the same. Real-time TLA+ and Alloy's integer time have
  no counterpart here.
- **Small bounds, explicit.** Like TLC and Alloy's analyser, Feynman checks a bounded world
  exhaustively. It says which bounds it used, and calls an unfinished search `~`, not `✓`
  (chapter 12).

## TLA+

| TLA+ | Feynman |
| --- | --- |
| `VARIABLES`, the state | each actor's `initialState`; the world is every instance's state plus what's in flight |
| `Init` | `initialState`, a scenario's `setup` |
| an action, `Next == A \/ B` | a step: an action, a transition `on` a message, a guarded transition (`when`), or a timer (`after`) |
| `UNCHANGED` | implicit: a step changes only what its `run` assigns |
| a message set or channel variable | built in: `ctx.send`, and what's pending, a bag |
| a sequence per channel (FIFO) | `defineMessage(…, { ordered: true })`: the oldest from one sender to one receiver goes first |
| `INVARIANT` | `defineProperty({ always })` |
| an invariant `~P`, written to get a trace to P | `defineProperty({ reachable: P })`: a shortest way there, or ✗ if no world gets there |
| `[][A => B]_v` (action property) | `defineProperty({ everyStep: (before, after) => … })` |
| `P ~> Q` | `defineProperty({ leadsTo: { whenever, then } })` |
| `WF_vars(A)`, `SF_vars(A)` | deliveries, timers and guarded transitions are weakly fair; `fair: "strong"` for strong; `fair: false` for steps that may never happen, as faults are; actions (what people do) are never fair |
| `<>P`, `<>[]P`, `[]<>P` | `eventually`, `eventuallyAlways`, `infinitelyOften` |
| `CONSTANTS` and a model's values | `--instances`, `atMost`, `budget`, scenario setups |
| `SYMMETRY` | `symmetric: true` on an actor, tested as it goes (chapter 12) |
| TLC's error trace | the counterexample, with each step's description, changes and sends |
| deadlock | "stuck": nothing can happen, and the world isn't `finalState` |
| refinement mapping | no counterpart; `sources` ties a spec to code instead |

The examples in `packages/feynman/examples` come with TLA+ specs of the same systems in
`examples/oracles`, checked by TLC in Feynman's own tests: the same bugs, the same fixes. Reading
one of them next to its oracle is the fastest way across.

## Alloy

| Alloy | Feynman |
| --- | --- |
| `sig` | an actor (for things that act) or a type in its state (for data) |
| fields and relations | state: records, `Set`s, `Map`s, tagged unions |
| `fact` | a guard (`when`), or a `setup`: Feynman specs are built forwards, not constrained |
| `pred` with `pre`/`post` (Alloy 6 `'`) | a step's `when` and `run` |
| `assert` + `check` | `defineProperty` + `feynman check` |
| `run` to find an instance | `defineProperty({ reachable })` finds a shortest way to one; `defineScenario` scripts one |
| scope (`for 3`) | `--instances`, `atMost`, `--depth` |
| the visualiser and themes | the playground and `display` (chapter 14) |
| `always`, `eventually`, `after` (Alloy 6) | `always`, `eventually`, `leadsTo`, `everyStep` |

Alloy's strength is structure: finding a world that satisfies constraints. Feynman has no solver
for that. It runs steps forwards from a start. For protocols, which is what Practical Alloy's
behavioural chapters model, the two line up closely.

## P

| P | Feynman |
| --- | --- |
| `machine` | `defineActor` |
| `state` and `on e do` | state in `initialState` (often a tagged union) and `transitions: { … on: E }` |
| `event` with payload | `defineMessage("E", { field: Type })` |
| `send m, e, payload` | `ctx.send(to, E, payload)`; `ctx.reply` to answer |
| P's in-order delivery between two machines | `defineMessage(…, { ordered: true })`; Feynman reorders unless told |
| `goto` | assign the state field |
| `defer` and `ignore` | a guard that leaves it for later, or a `run` that returns early |
| `spec` monitor machine (safety) | `defineProperty({ always })` or `everyStep` |
| a test that asserts a goal is reached | `defineProperty({ reachable })` |
| `hot` states (liveness) | `leadsTo` and the other liveness kinds |
| `test` and its driver | `defineScenario`, a `setup`, and `feynman check` |
| failure injector | `lose`, `duplicate`, `crash`, `defineCall` + `failed`, with a `budget` |
| `$` nondeterministic choice | an action with `inputs: { x: oneOf(…) }`, or two guarded steps |
| timers (from the P common library) | `after` and `ctx.start`, with no clock |
| PObserve / logs | no counterpart; `sources` and `lock` work on the code itself |

The P tutorials this book borrows from (client-server, two-phase commit, espresso machine,
failure detector) translate almost line for line. Chapter 16 is the two-phase commit one, built
up step by step.

## What Feynman doesn't do

- **Proofs.** TLAPS proves TLA+ specs for every size. Feynman checks bounded worlds.
- **Arbitrary structure.** No relational logic or solver, as Alloy has. State is what TypeScript
  can hold.
- **Running in production.** P's runtime and PObserve check real systems' logs. Feynman checks
  specs, and points at code.
- **Large state spaces.** TLC distributes, and Apalache uses SMT. Feynman runs on one thread,
  fast for the small worlds where design bugs live (chapter 12).
