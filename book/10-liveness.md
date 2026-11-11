# 10. Does it ever finish?

> *Does every request get an answer? Does every hold end?*

Every property so far said something bad never happens. A box office that does nothing
satisfies all of them: it never sells a seat twice, because it never sells a seat. So we need
a second kind of property, about things that must *eventually* happen. These are **liveness**
properties, and they come with a question that safety never asks: what is the system allowed
to just not do?

## Step 1: three things that should happen

Three candidates, from the box office's point of view:

```ts
const seatIsSold = defineProperty("seatIsSold", {
  description: "The last seat is eventually sold.",
  eventually: (w) => w.the(BoxOffice).state.seat.kind === "sold",
});

const paymentsEnd = defineProperty("paymentsEnd", {
  description: "Whoever pays eventually hears back: a ticket, or that their hold expired.",
  leadsTo: {
    whenever: (w) => w.all(Person).some((p) => p.state.phone === "paying"),
    then: (w) => w.all(Person).every((p) => p.state.phone !== "paying"),
  },
});

const holdsEnd = defineProperty("holdsEnd", {
  description: "A hold ends: the seat is eventually paid for or free again.",
  leadsTo: {
    whenever: (w) => w.the(BoxOffice).state.seat.kind === "held",
    then: (w) => w.the(BoxOffice).state.seat.kind !== "held",
  },
});
```

- `eventually: P`: in every behaviour, from the start, P holds at some point.
- `leadsTo: { whenever: P, then: Q }`: every time P holds, Q holds then or later. This is the
  workhorse: "every request is answered", "every hold ends".

There are two more. `infinitelyOften: P` says P keeps happening forever ("every philosopher
eats again and again"). `eventuallyAlways: P` says from some point on, P holds for good ("the
replicas converge, and stay converged").

([`specs/10-liveness/1-eventually.ts`](specs/10-liveness/1-eventually.ts))

```text
Box office: explored 4,474 states (…, faults=1) in 138ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✗ seatIsSold  The last seat is eventually sold.
    shortest counterexample, 0 event(s), needs no faults; see it with feynman check specs/10-liveness/1-eventually.ts --only seatIsSold
  ✓ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
  ✗ holdsEnd  A hold ends: the seat is eventually paid for or free again.
    shortest counterexample, 4 event(s), needs 1 fault(s); see it with feynman check specs/10-liveness/1-eventually.ts --only holdsEnd
```

Three properties, two different answers, and one of them has a twist. Take them one at a time.

### "The seat is eventually sold": no

```text
  ✗ seatIsSold  The last seat is eventually sold.
    shortest counterexample, 0 event(s), needs no faults:

    then nothing fair can happen: it stays there forever, and never holds
```

A counterexample with no events. The world as it starts already breaks it: *nobody does
anything, ever*. Nobody has to buy a seat. To see why that is allowed, we need fairness.

## Fairness

A liveness property is judged over infinite behaviours, and some infinite behaviours are
silly. A message sits in flight forever and is never delivered. A timer stays set and never
fires. If those counted, nothing could ever be guaranteed. So the checker only considers
**fair** behaviours, and Feynman's defaults say what is fair:

| Kind of step | Fair? | Meaning |
| --- | --- | --- |
| a message in flight | yes (weak) | if it stays deliverable, it is eventually delivered |
| a timer that is set | yes (weak) | if it stays set, it eventually fires |
| a guarded step | yes (weak) | if its guard stays true, it eventually runs |
| an action | **no** | people may stop; nobody has to press the button |
| a fault | **no** | the network may lose a message, and may stop losing them |

**Weak** fairness: a step that stays possible from some point on eventually happens. A step
that keeps becoming possible and impossible again, and could be starved forever, needs
**strong** fairness: `fair: "strong"` on the step. One that the system need never take says
`fair: false`.

So `seatIsSold` is false for the right reason. The theatre can't promise someone will buy
the seat. It isn't a property of the box office at all. When a liveness property fails on
"nothing fair can happen" at the start, ask whether it depends on someone choosing to act. If
it does, it's the wrong property. Rewrite it as a `leadsTo` from the moment they act: *if
someone pays, they hear back.* That is `paymentsEnd`.

### "Every hold ends": not after a restart

```text
  ✗ holdsEnd  A hold ends: the seat is eventually paid for or free again.
    shortest counterexample, 4 event(s), needs 1 fault(s):
       1  Person (Person)  hold
          phone: "browsing" → "asking"
          → Box office: hold the seat {}
       2  Box office (Box office)  hold the seat  {}  from Person
          seat.kind: "free" → "held"
          → Person: held {}
          ⏱ expire set
       3  Box office (Box office)  crash
          @faults: 1 → 0
          ⏱ expire cancelled
       4  Person (Person)  held  {}  from Box office
          phone: "asking" → "holding"
    then nothing fair can happen: it stays there forever, and never holds
```

A liveness counterexample is a path, then what happens forever after. Here the forever is
"nothing fair can happen". *The person holds the seat. The box office restarts, and the
restart takes the hold's expiry timer with it. The person never pays.* They don't have to:
paying is an action. And with the timer gone, nothing else will ever free the seat. The last
seat is gone until someone notices.

Chapter 9 warned about this: timers live in memory. No safety property noticed, because
nothing *bad* happened. Something good failed to happen. That is what liveness is for.

When the forever is a loop rather than a standstill, the checker prints the path to the loop,
then the loop: the events that repeat forever, avoiding the goal. Retries that always fail, a
leader election that always splits, a message bounced back and forth.

### "Every payment ends": yes

```text
  ✓ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
```

To judge liveness, the checker needs the whole graph of states: a loop that never pays could
be anywhere in it. It explored 4,474 states, every world the box office can reach with one
fault, and found no such loop. So `✓` means what it says: every payment ends, in every fair
behaviour, with up to one fault.

A search that stops early can't say that. Give it a depth bound, and it stops at 14 events:

```sh
feynman check specs/10-liveness/1-eventually.ts --only paymentsEnd --depth 14
```

```text
Box office: explored 1,702 states (…, depth 14, faults=1) in 269ms
  ~ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.  held to depth 14, but paths that had not got there yet were cut off at that depth: it may break further on
  "~" is not a proof: raise --depth (check.depth in feynman.config.ts; it is 14 now), or leave it out to search every depth, until no path is cut off before it gets there or loops.
```

`~` is the checker being honest. Some paths were still going at 14 events, and a loop that
never pays could be hiding past them. The same goes for safety: what held up to a depth bound
held on the paths explored, not on all of them, and reads `~` too. Without `--depth`, the
search goes on until it has every world, or meets its state, time or memory limit (chapter
12). A system that never runs out of new worlds meets a limit, and that is a `~` as well.

## Step 2: re-arming timers after a restart

The fix for `holdsEnd` is what real code does on startup: look in the database for holds, and
schedule their expiry again. The box office keeps an in-memory flag for whether the timer is
set, and a guarded step re-arms it when the database says a seat is held and the flag says
nobody is timing it:

```ts
  // `expiring`: whether the hold's timer is set. Timers live in memory too, so a restart
  // forgets it, and `rearm` sets the timer again for a seat the database says is held.
  initialState: () => ({ seat: { kind: "free" } as Seat, calling: false, expiring: false }),
```

```ts
    rearm: {
      description: "After a restart, sets the expiry timer again for the seat on hold.",
      when: (s) => s.seat.kind === "held" && !s.expiring,
      starts: ["expire"],
      run(state, _, ctx) {
        state.expiring = true;
        ctx.start("expire");
      },
    },
```

`hold` sets `expiring`, and `pay` and `expire` clear it. We also drop `seatIsSold`. It was
never a promise the box office could make.

([`specs/10-liveness/2-rearm.ts`](specs/10-liveness/2-rearm.ts))

```sh
feynman check specs/10-liveness/2-rearm.ts
```

```text
Box office: explored 4,474 states (1 of each actor, and from the end of 3 scenario(s) and the setup of 3, faults=1) in 180ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✓ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
  ✓ holdsEnd  A hold ends: the seat is eventually paid for or free again.
```

We tried one other fix first, and it's worth knowing why it was wrong. We replaced the timer
with a sweeper: a guarded step, `when: seat is held`, that frees the seat. A guard reads durable
state, so it survives restarts. But a fair guard that holds runs as soon as the system is left
alone, and `s.settle()` in our scenarios swept every hold before anyone could pay. A sweeper
that may run "whenever a seat is held" is a hold of zero minutes. Modelling a timer as a guard
changes what the system does, so check your scenarios still tell the story you meant.

## Stuck, final, and liveness

Feynman reports three related things. They are easy to mix up:

- **Stuck**: a world where nothing at all can happen (nothing in flight, no timer, no action,
  no fair guard), and the spec's `finalState` doesn't call it finished. Reported for every
  spec, without being asked. Usually a deadlock, or someone waiting forever.
- **`finalState`**: where the system may stop. Say what finished means (everyone has an
  answer), not just `w.quiet`.
- **A liveness property**: something that must keep happening or eventually happen, even in
  worlds that are never stuck. A system can loop forever without being stuck: retries that
  never succeed. Only a liveness property catches that.

## Writing liveness properties

- **Always write both.** Safety says nothing bad happens. Liveness says something good does. A
  spec with only safety is satisfied by a system that does nothing.
- **Start from something that happened.** `leadsTo: { whenever: someone asked, then: they were
  answered }`. Liveness from the start, `eventually`, is rarely what a system promises.
- **Don't depend on people.** Actions aren't fair. If a property needs someone to press a
  button, it's about the person, not the system.
- **Don't depend on faults stopping.** The network may keep failing. A system that only
  finishes when the network behaves needs a property that says "when the network behaves".
  Or a budget: with `budget("faults", 1)`, every path has at most one fault, so retries
  eventually get through.
- **Don't stop at `~`.** Leave out `--depth`, raise the limit the search met, or make the model
  smaller (chapter 12), until the verdict is `✓` or `✗`.

## Exercises

1. Mark `chargeFailed` (the retry) `fair: false`. Which property breaks, and what does the loop
   look like?
2. Write `infinitelyOften` for the bank: "the bank keeps charging". Why is it false, and why is
   that fine?
3. In step 2, remove the `expiring` flag from `pay`'s `run` (leave it `true` while paying). Is
   anything wrong? Which properties would notice?
