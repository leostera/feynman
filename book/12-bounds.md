# 12. How sure are we?

> *What did the checker actually look at?*

A `✓` from Feynman means a property held in every world the checker reached, and that it
reached every world within its bounds. Both halves matter. This chapter is about the bounds:
what they are, how to read what the checker says about them, and what to do when a spec gets
too big to check.

## Small worlds

The checker can't try every number of people, every length of run, every combination of
failures. Nobody can. It tries all of them up to a bound: one or two people, fourteen or forty
events, one or two faults. This is less of a limit than it sounds. Most design bugs show up in
small worlds: two people, one lost message, one restart. Every counterexample in this book is
under fifteen events. The bugs that need a hundred machines usually need two machines and the
right order.

So the craft is to choose bounds small enough to finish and large enough to matter, and to say
in the spec which ones matter.

## The bounds

| Bound | Default | Set with | What it limits |
| --- | --- | --- | --- |
| instances | one of each actor, plus what scenarios bring | `--instances Person=3`, `check.instances`, a scenario's setup | how many of each non-singleton actor |
| depth | 14 | `--depth 40`, `check.depth` | how many events on one path |
| repeats | per action | `with: [atMost(2)]`, a shared `defineVariable` | how often each instance takes an action |
| faults | per budget | `budget("faults", 1)`, `--set faults=2` | how many faults on one path |
| states | 300,000 | `--max-states` | how many distinct worlds before stopping |
| time | 20 s | `--time-limit` | how long before stopping |
| memory | 24 GB | `--memory-limit` | how much memory before stopping |
| random runs | 2,000, 120 deep | `--walks`, `--walk-depth` | runs past the search, to find deeper bugs |

The first line of check's output always says which bounds it used:

```text
Box office: explored 8,661 states (1 of each actor, and from the end of 3 scenario(s) and the setup of 3, depth 40, faults=2) in 272ms
```

## The four verdicts, again

- **`✓`** every world within the bounds was explored, and the property held in all of them.
- **`~`** a limit stopped the search first. The output says how far it got: *"held on every
  path of up to 12 event(s)"*. Not a proof.
- **`?`** nothing the checker reached was a world the property is about. It tested nothing.
- **`✗`** broken, with the trace. A `✗` is never in doubt, whatever the bounds.

The rest of this chapter is about turning `~` and `?` into `✓` or `✗`.

## More people

The final box office ([`specs/11-rules/3-the-payer.ts`](specs/11-rules/3-the-payer.ts)) checks
with one person from the start, and the people its scenarios bring: two at most. Three?

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 40 --instances Person=2
feynman check specs/11-rules/3-the-payer.ts --depth 40 --instances Person=3
```

```text
Box office: explored 16,755 states (2 Person, …, depth 40, faults=2) in 411ms
Box office: explored 260,933 states (3 Person, …, depth 40, faults=2) in 4.23s
  ~ paymentsEnd  …  held to depth 40, but paths that had not got there yet were cut off at that depth: it may break further on
  ~ holdsEnd  …  held to depth 40, but paths that had not got there yet were cut off at that depth: it may break further on
```

Each extra person multiplies the states by about fifteen. With three, forty events is no
longer enough for every path to finish, and the liveness verdicts are unfinished. Raise the
depth:

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 60 --instances Person=3
```

```text
Box office: explored 262,476 states (3 Person, …, depth 60, faults=2) in 4.21s
```

Every verdict is `✓` now. 262,476 states, four seconds. A fourth person would take minutes.
For this spec, that's where to stop: nothing about the box office treats a third person
differently from a second, and the properties held for three.

## Symmetry

Alice and Bob are interchangeable: `symmetric: true` on `Person`. The checker may then treat
"Alice holds, Bob pays" and "Bob holds, Alice pays" as one world, and visit only one of them.
It applies only to safety, since liveness turns symmetry off. So compare the safety properties
alone:

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 40 --instances Person=3 --only chargedOnce,oneTicket,holdsAreRespected
feynman check specs/11-rules/3-the-payer.ts --depth 40 --instances Person=3 --only chargedOnce,oneTicket,holdsAreRespected --no-symmetry
```

```text
Box office: explored 49,610 states (3 Person, …) in 799ms
Box office: explored 260,933 states (3 Person, …) in 2.27s
```

Five times fewer states, for the same verdicts. With three people there are six ways to name
them, and symmetry folds most of them together.

**Symmetry is a claim**, and a false one hides bugs. Declare it only when the spec compares an
actor's ids and labels for equality and never orders or computes with them. Electing the
highest id, sorting by id, hashing an id: any of those makes instances different.

The checker tests the claim on the states it merges: when a world lands on a merged one, it
checks the two really are the same after renaming, and if not it says the claim is false and
starts again without it. But it can only test what it sees. Here is a ballot for the last
seat. The box office draws the entrant whose id sorts first, and the spec wrongly says people
are interchangeable ([`specs/12-bounds/1-false-symmetry.ts`](specs/12-bounds/1-false-symmetry.ts)):

```ts
    draw: {
      description: "Draws the winner: the entrant whose id sorts first.",
      when: (s) => s.entrants.length >= 2 && s.winner === null,
      sends: [Won],
      run(state, _, ctx) {
        const winner = [...state.entrants].sort()[0]!;
        state.winner = winner;
        ctx.send({ id: winner }, Won, {});
      },
    },
```

```ts
const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true, // false: the draw sorts ids
  // …
});

const firstEntrantWins = defineProperty("firstEntrantWins", {
  description: "Whoever entered first wins.",
  always: (w) => w.the(BoxOffice).state.winner === null || w.the(BoxOffice).state.winner === w.the(BoxOffice).state.first,
});
```

With the random runs turned off, the search alone gets this wrong:

```sh
feynman check specs/12-bounds/1-false-symmetry.ts --instances Person=2 --walks 0
```

```text
Ballot: explored 8 states (2 Person, depth 14) in 7ms
  ✓ firstEntrantWins  Whoever entered first wins.
```

"A entered first" and "B entered first" were merged into one world. They *are* the same after
renaming, so the test of the claim passes. Only the draw tells them apart, and the draw only ran
from the one the checker kept. With the default random runs, which don't merge anything, the
bug is found:

```text
  treated as interchangeable: Person A = Person B
  ✗ firstEntrantWins  Whoever entered first wins.
    found by a random run past the search's depth, shrunk to 5 event(s), needs no faults:
```

And with `--no-symmetry`, the search finds it in 14 states. Two lessons:

- **Read the "treated as interchangeable" line**, and ask whether anything in the spec orders,
  sorts or computes with those ids. If anything does, remove `symmetric: true`.
- **Keep the random runs on.** They are cheap, they go deeper than the search, and they share
  none of its reductions.

## `?`: nothing to test

A property only says something about the worlds it applies to. Here is one about crowds
([`specs/12-bounds/2-untested.ts`](specs/12-bounds/2-untested.ts)):

```ts
const waiting = (p: { state: { phone: Phone } }) => p.state.phone === "asking" || p.state.phone === "paying";

const crowdsHearBack = defineProperty("crowdsHearBack", {
  description: "When three people are waiting on the box office at once, they all hear back.",
  leadsTo: {
    whenever: (w) => w.all(Person).filter(waiting).length >= 3,
    then: (w) => !w.all(Person).some(waiting),
  },
});
```

```text
  ? crowdsHearBack  When three people are waiting on the box office at once, they all hear back.  never tested: exploration never reached a world where it applies
  "?" was never tested: add a scenario that gets there, so exploration starts from its end.
```

No world the checker reached had three people, so `whenever` never held, and the property
tested nothing. A tool that rounded up would print `✓` here. Feynman says `?`, and how to fix
it: bring three people in, with a scenario's setup or `--instances`:

```sh
feynman check specs/12-bounds/2-untested.ts --depth 60 --instances Person=3 --only crowdsHearBack
```

```text
Box office: explored 262,476 states (3 Person, …, depth 60, faults=2) in 2.61s
  ✓ crowdsHearBack  When three people are waiting on the box office at once, they all hear back.
```

A `?` is either a bound that's too small, as here, or a property about something the design
rules out. In that case, state what rules it out as a safety property instead, and let that one
hold.

## When the search stops early

Set the state limit low, to see what the checker says when it runs out:

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 40 --max-states 2000
```

```text
Box office: explored 2,000 states (…) in 181ms — stopped at the state limit before exploring everything
  states differ most in: Box office.seat (18 values), Person.phone (5 values), Bank.charges (3 values), Bank.seen (3 values), message hold the seat (3 values); up to 4 message(s) in flight at once. No one field grows much: it is the orders of the steps in flight. Smaller budgets (--set faults=0, --set repeats=1), fewer instances, or fewer requests at once in the scenarios, shrink it.
  ~ chargedOnce  No order is charged twice.  held on every path of up to 12 event(s); the state limit stopped the search before longer ones
  ~ paymentsEnd  …  held in the 2,000 states explored before the state limit, not all of them
```

Three things to read:

- **How far safety got.** "Held on every path of up to 12 events" is a real, if bounded,
  guarantee. The search is breadth first, so every shorter path was covered.
- **What the states differ in.** This is the diagnosis. Here no one field grows much: the
  states come from the orders of messages in flight. When one field has thousands of values,
  it's nearly always the cause.
- **What to do.** The checker suggests it, and the next section has the rest.

## When a spec is too big

Don't just raise `--max-states`. A state space that is too big usually means the spec models
too much. In rough order of payoff:

1. **Find the growing field.** A log, a counter, a history, a list of ids that only grows: each
   makes every world unique, and the search never ends. Keep what decides behaviour (the
   latest version, the set of ids seen), not the history. Use a `Set` for anything whose order
   doesn't matter.
2. **Split the spec.** Two behaviours in one spec multiply each other's states. "More specs, not
   bigger ones": the hold-and-pay flow and the refund flow are two specs, with the same actors.
3. **Take out what decides nothing.** The box office lost its web server in chapter 7 for this
   reason. A component that only forwards messages adds states and no behaviour.
4. **Lower the bounds that don't matter.** `atMost(1)` instead of 2, one fault instead of two,
   two people instead of three, when the property doesn't need more.
5. **Claim symmetry**, where it's true.
6. **Start from scenarios.** A setup that puts the world at the interesting moment (the last
   seat) saves exploring every way to get there.

And put the bounds that matter in the spec, where a reader sees them: a budget of two because
the resume rule needs two faults, a scenario with three people because crowds matter, a
`check: { depth: 40 }` in `feynman.config.ts` because the payment flow is long.

## Exercises

1. Check the final box office with `--set faults=0`. Which rules are still needed? Why?
2. Add a `history: string[]` to the box office that records every event's name, and look at
   what `--max-states 2000` says the states differ in.
3. Fix the ballot by making the draw pick `state.first`. Is `symmetric: true` true now? Check it
   with and without `--no-symmetry`.
