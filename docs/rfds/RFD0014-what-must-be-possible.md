# RFD0014 - What must be possible

- Feature Name: `reachable`
- Status: Accepted
- Author: `leostera`
- Start Date: `2026-11-11`
- Updated: `2026-11-11`
- Discussion PR: `TBD`
- Tracking Issue: `TBD`

## Summary

A property can say what must be able to happen, not only what must never happen:

```ts
const someoneGetsASeat = defineProperty("someoneGetsASeat", {
  description: "Someone can buy a ticket.",
  reachable: (w) => w.all(Person).some((p) => p.state.tickets.size > 0),
});
```

`feynman check` holds it when some world on some path satisfies the predicate, and shows the
shortest way there. It breaks it, `✗ never reached`, only when the search explored every
world and none does. A search cut off before then reads `~`: not reached yet.

## Motivation

Every property Feynman had was a claim about all paths: `always`, `everyStep` and `never`
say nothing bad happens, and liveness says something good happens on every fair path. A
system that does nothing keeps every safety claim. In the book's box office, a database
whose conditional write always fails keeps `oneOwnerPerSeat`, `ticketsMatchTheBooks` and
`soldSeatsStaySold`, and sells no seats. Three ✓ for a broken system.

Coverage ("never ran: Person.ticket") catches a step that never runs. It misses a step that
runs and never does its job, a guard that holds only in a world nobody gets to, and bounds
too small to get anywhere interesting (one instance where the bug needs two). Liveness
catches some of these, at the cost of fairness, symmetry turned off, and a claim about every
path when the author meant "at least one".

The other tools have this: Alloy's `run` next to `check`, a TLA+ user's invariant `~Goal`
written to get TLC to print a trace to `Goal`, CTL's `EF`, a P test that asserts a goal.

## Goals

- A property kind that is a claim about one path: some reachable world satisfies it.
- The shortest way there, replayable, shown as a counterexample is, and kept as a scenario
  with `--as-scenario`.
- `✗` only when it is true that no world gets there: every world was explored.
- The same answers as independent checkers: TLC, NuSMV and Alloy, each given the invariant
  that the goal is never reached.

## Non-goals

- Reachability under fairness, or "possible from every world" (CTL's `AG EF`). Those are
  stronger claims; `leadsTo` covers the common one.
- Rules (`needs`). A rule keeps a property true; a reachable property is not kept by a rule
  but made possible by the design. `needs` on one is refused.

## Guide-level explanation

Write one for each thing the system is for: an order goes through, a leader is elected, a
payment settles. Check prints one of:

```text
  ✓ someoneGetsASeat  Someone can buy a ticket.  reached in 5 event(s); see the way there with feynman check … --only <property>
  ✓ someoneGetsASeat  Someone can buy a ticket.  reached at the end of scenario "Both want A1"
  ✗ someoneGetsASeat  Someone can buy a ticket.  never reached: no world within the bounds gets there, of the 132 explored
  ~ someoneGetsASeat  Someone can buy a ticket.  not reached by depth 4, but paths that had not got there yet were cut off at that depth: it may be reached further on
```

A ✗ has no counterexample: nothing went wrong on any path. The hint names the usual causes:
a guard too strict, a step that can never run, bounds too small.

## Reference-level explanation

### Semantics

A reachable property `R` holds when some world reached from a root (the initial world, a
scenario's setup, or a scenario's end) satisfies `R`. The search judges it as `always: ¬R`,
so the first world that breaks `¬R`, in breadth-first order, ends a shortest path to `R`:
that path is the witness. A predicate that throws counts as not reached there.

Random runs judge it too. A run that gets there past the search's depth gives a witness
(`witnessBy: "walk"`), shrunk as counterexamples are, maybe not shortest.

### Verdicts

| What happened | Verdict |
| --- | --- |
| A world satisfies `R` | holds (`✓`), with `witness` |
| No world does, and the search was exhaustive and nothing cut it off (`exhaustive && !cutAtDepth`, no `ctx.random`) | broken (`✗`), `unreached: true`, no counterexample |
| No world does, but the search stopped at a bound or a limit, or a step drew `ctx.random` | unfinished (`~`), with `upTo` when a depth cut it off |
| `known` and not reached | known; `known` and reached is fixed, which fails |

### Data model

`PropertyHeld` gains `witness?: Counterexample` and `witnessBy?: "search" | "walk"`. A new
`PropertyUnreached` is `{ holds: false, unreached: true, upTo? }`; `PropertyBroken` has
`unreached?: undefined`, so code that reads a counterexample narrows on it. JSON gains
`witness` and `notReachedUpTo`.

### Invariants

- A witness replays to the same events, and its last world satisfies `R`.
- A witness found by the search is no longer than any path to `R` the reference explorer
  finds (test/check/reference.ts), and fits the bounds.
- `✗` implies every world was explored and none satisfies `R`.

### Rollout and validation

- `test/check/reachable.test.ts`: the witness against the reference explorer, never reached,
  unfinished at a depth and at a state limit, a walk's witness, from a setup and a scenario's
  end, under symmetry, a throwing predicate, known and fixed, and the scenario code.
- The fuzzer gives 60% of its seeds a goal that starts false and checks the witness length
  against the reference, that it holds and fits the bounds, and that no random run reaches
  what the search called never. Breaking the search on purpose is caught.
- Oracles: two-phase commit's `everyoneCommits` and `everyoneAborts` against TLC, NuSMV and
  Alloy, each checking `<id>Never`; dining philosophers' `apartEat` (4 events) and
  `neighboursEat` (never) against TLC.
- The book's chapter 5 gains steps 5–7: a box office that sells nothing, the property that
  catches it, and the fix.

## Drawbacks

- One more kind to learn, with a ✗ that has no counterexample to show.
- A witness from a scenario's end can be zero events long, which says less than a path from
  the initial world would.

## Rationale and alternatives

- **Write `always: ¬R` and read the counterexample.** This is the TLA+ idiom, and the
  implementation. As a user-facing idiom it inverts the verdict: the spec "fails" when the
  design works, so it can't sit in a spec that must pass.
- **A scenario that asserts it gets there.** A scenario shows one path someone wrote down; a
  reachable property asks the checker to find any, and to say when there is none.
- **Make every scenario's end a reachability claim.** Scenarios already must not break
  properties; they say nothing about goals, and a goal no scenario reaches is the case that
  matters.

## Prior art

Alloy's `run`; CTL's `EF`; TLC's invariant `~Goal` to get a trace; P tests that assert a
goal state; SPIN's `never` claims written to find a path.

## Unresolved questions

- Whether to prefer a witness from the initial world over one from a scenario's end.
- Whether `AG EF R` ("always still possible") is worth its cost.

## Future possibilities

- `possible` from every reachable world, for systems that must not lose the ability to
  recover.
- Coverage that reports which reachable properties a scenario reaches.
