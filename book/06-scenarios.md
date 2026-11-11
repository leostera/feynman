# 6. Showing that it happens

> *Does the model do what we think it does?*

Properties say what must never happen. Scenarios say what should happen, and show it. A
scenario is one run, scripted event by event, that a reader can follow. They are the part of a
spec people read first, and they do three jobs:

1. **They check the model allows what we expect.** A model that does nothing satisfies every
   property. A scenario where Alice buys a seat proves she can.
2. **They keep bugs as stories.** A counterexample, pasted in as a scenario, stays in the spec
   as a flow anyone can replay, and a regression to watch for.
3. **They tell the checker where to look.** The checker explores from the end of every
   scenario, and from the start of every scenario's setup. A scenario that brings in two
   people, or sets up the last seat, makes every check consider that world.

## The scenario API

A scenario's `run` receives a script, `s`, and changes the world only through events:

| Call | What it does |
| --- | --- |
| `s.spawn(Actor, "Alice")` | Brings in an instance, with its `initialState`. Returns it. |
| `s.the(Actor)`, `s.all(Actor)` | Finds instances: a singleton, or every instance of an actor. |
| `s.act(who, "action", inputs)` | Takes an action. |
| `s.deliver(who, Message, payload?)` | Delivers a message in flight to `who` now, ahead of the rest: the oldest one, or the oldest with that payload. |
| `s.step(who, "step", payload?)` | Takes any step by name: a guarded step, or a step on a message (a fault, say, in chapter 8). |
| `s.fire(who, "timer")` | Fires a timer now (chapter 7). |
| `s.settle()` | Leaves the system alone until nothing is pending: messages in the order they were sent, then timers, oldest first. |
| `s.settle({ until })` | The same, but stops as soon as `until` holds, to step in at that moment. |
| `s.world` | The world now, to read between steps. |

A scenario may also have a `setup`, which sets the world it starts in rather than reaching it
through events (step 3 below).

## Step 1: keeping a counterexample

In chapter 5 the checker found that two people could both get A2. We fixed it, but the story
of the bug is worth keeping. `--as-scenario` turns a counterexample into scenario code:

```sh
feynman check specs/05-properties/3-steps-and-paths.ts --only soldSeatsStaySold --as-scenario
```

```ts
const soldSeatsStaySoldIsBroken = defineScenario("soldSeatsStaySold is broken", {
  description: "Once a seat is sold, it stays sold to the same person.",
  // The world where scenario "Both want A1" ends.
  setup(w) {
    w.set(Seats, { sold: new Map([["A1", "person-alice"]]) });
    w.spawn(Person, "Alice", { tickets: new Set(["A1"]) });
    w.spawn(Person, "Bob");
  },
  run(s) {
    const website = s.the(Website);
    const seats = s.the(Seats);
    const alice = s.all(Person).find((i) => i.label === "Alice")!;
    const bob = s.all(Person).find((i) => i.label === "Bob")!;
    s.act(alice, "buy", {"seat":"A2"});
    s.act(bob, "buy", {"seat":"A2"});
    s.deliver(website, Buy); // from alice
    s.deliver(website, Buy); // from bob
    s.deliver(seats, IsFree); // from website
    s.deliver(seats, IsFree); // from website
    s.deliver(website, Answer); // from seats
    s.deliver(website, Answer); // from seats
    s.deliver(seats, Reserve); // from website
    s.deliver(seats, Reserve); // from website
    // soldSeatsStaySold is broken here: Once a seat is sold, it stays sold to the same person.
  },
});
```

It is a starting point, not a finished scenario. Three edits make it one a reader wants:

- **Name it and describe it** as the story we told in chapter 5, not as the property.
- **Keep only the deliveries that matter.** The race is decided by the two `IsFree` checks
  both arriving before either `Reserve`. After that, `s.settle()` can do the rest.
- **Keep the setup.** The counterexample started where "Both want A1" ended, with Alice
  holding A1. Setting that world up is clearer than replaying it.

```ts
const bothWantA2 = defineScenario("Both want A2 at once", {
  description: "Both check A2 before either writes: both hear it is free, both reserve it, and the database keeps Bob, though Alice gets a ticket too.",
  // The world where "Both want A1" ends: Alice has A1, and Bob has nothing.
  setup(w) {
    w.set(Seats, { sold: new Map([["A1", "person-alice"]]) });
    w.spawn(Person, "Alice", { tickets: new Set(["A1"]) });
    w.spawn(Person, "Bob");
  },
  run(s) {
    const website = s.the(Website);
    const seats = s.the(Seats);
    const [alice, bob] = ["Alice", "Bob"].map((label) => s.all(Person).find((p) => p.label === label)!);
    s.act(alice!, "buy", { seat: "A2" });
    s.act(bob!, "buy", { seat: "A2" });
    s.deliver(website, Buy); // Alice's
    s.deliver(website, Buy); // Bob's
    s.deliver(seats, IsFree); // about Alice
    s.deliver(seats, IsFree); // about Bob: A2 is still free
    s.settle();
  },
});
```

Added to the buggy design ([`specs/06-scenarios/1-the-race.ts`](specs/06-scenarios/1-the-race.ts)),
`check` reports the scenario itself, before anything it explores:

```text
  ✗ scenario "Both want A2 at once": ticketsMatchTheBooks, oneOwnerPerSeat
```

And `feynman run`, which runs the scenarios and prints a line each:

```text
  ✓ Both want A1  14 event(s)
  ✗ Both want A2 at once  14 event(s), breaks ticketsMatchTheBooks, oneOwnerPerSeat
```

A scenario that breaks a property is a failing check. That is what we want while the bug is
there. It is a regression test written in the spec's own terms.

## Step 2: the same story, after the fix

With the database's conditional write in place, the same events tell a different story. The
description must change with them, because a scenario's description is a claim, and readers
believe it:

```ts
  description: "Both check A2 before either writes: both hear it is free, the database takes Alice's reservation and refuses Bob's, and Bob hears it is sold out.",
```

The run itself is unchanged. We kept the order that used to break things, and now it
doesn't. When someone later asks "what if both check before either writes?", there is a flow
that answers.

## Step 3: setting up a moment

The last seat is where box offices get interesting. Getting there through events means
replaying a sale nobody cares about. A **setup** puts the world there directly:

```ts
const theLastSeat = defineScenario("The last seat", {
  description: "Carol bought A1 earlier. Alice and Bob both try for A2; Alice's write lands first, and Bob hears it is sold out.",
  setup(w) {
    w.set(Seats, { sold: new Map([["A1", "person-carol"]]) });
    w.spawn(Person, "Carol", { tickets: new Set(["A1"]) });
    w.spawn(Person, "Alice");
    w.spawn(Person, "Bob");
  },
  run(s) {
    const [alice, bob] = ["Alice", "Bob"].map((label) => s.all(Person).find((p) => p.label === label)!);
    s.act(alice!, "buy", { seat: "A2" });
    s.act(bob!, "buy", { seat: "A2" });
    // Left alone until the database has given A2 to someone, then the rest.
    s.settle({ until: (w) => w.the(Seats).state.sold.has("A2") });
    s.settle();
  },
});
```

- `w.set(Singleton, fields)` lays fields over a singleton's `initialState`.
- `w.spawn(Actor, label, fields?)` brings in an instance that is there from the start, with
  fields over its `initialState`. In `run`, find it with `s.all` or `s.the`.
- A setup sets only states. Messages in flight and timers come from events.

**A setup is a claim** that the system can get there. The checker takes it at its word and
explores from it too, so a setup the system could never reach gives answers about a world that
doesn't exist. If the setup itself breaks a property (a seat in the books with nobody holding
its ticket, say), check reports it against the scenario: *"its setup breaks …"*. Set up only
what you could reach, and prefer the smallest world that makes the point.

`s.settle({ until })` runs the system left alone until the world gets somewhere, here until
A2 is sold, so the scenario could step in at that exact moment. That will matter in chapter 9,
where we crash the website right after the database writes. Without `until`, we'd have to
deliver each message by hand to get there.

```text
The last seat (book/specs/06-scenarios/2-fixed.ts)
   1  Alice (Person)  buy  {"seat":"A2"}
   2  Bob (Person)  buy  {"seat":"A2"}
   3  Website (Website)  buy  {"seat":"A2"}  from Alice
   4  Website (Website)  buy  {"seat":"A2"}  from Bob
   5  Seats (Seats)  is it free?  {"seat":"A2","buyer":"person-alice"}  from Website
   6  Seats (Seats)  is it free?  {"seat":"A2","buyer":"person-bob"}  from Website
   7  Website (Website)  answer  {"seat":"A2","buyer":"person-alice","free":true}  from Seats
   8  Website (Website)  answer  {"seat":"A2","buyer":"person-bob","free":true}  from Seats
   9  Seats (Seats)  reserve  {"seat":"A2","buyer":"person-alice"}  from Website
      sold: {"A1":"person-carol"} → {"A1":"person-carol","A2":"person-alice"}
  10  Seats (Seats)  reserve  {"seat":"A2","buyer":"person-bob"}  from Website
      → Website: taken {"seat":"A2","buyer":"person-bob"}
  11  Website (Website)  reserved  {"seat":"A2","buyer":"person-alice"}  from Seats
  12  Website (Website)  taken  {"seat":"A2","buyer":"person-bob"}  from Seats
  13  Alice (Person)  ticket  {"seat":"A2"}  from Website
  14  Bob (Person)  sold out  {"seat":"A2"}  from Website
```

Left alone, messages arrive in the order they were sent, so both checks happen before either
write. This is the race, on an ordinary day, and the fix handles it.

With three scenarios, the check covers far more ground:

```text
Box office: explored 18,009 states (1 of each actor, and from the end of 3 scenario(s) and the setup of 2) in 289ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
  ✓ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
```

18,009 states, up from 216. Three people, and a world with one seat left, are now in every
check. This is how a spec says "check it with three people" without a flag: a scenario that
has three.

## When a scenario is wrong

A scenario can ask for something that can't happen. Deliver a `Reserve` before the website has
sent one:

```ts
    s.act(alice!, "buy", { seat: "A2" });
    s.deliver(s.the(Seats), Reserve);
```

```text
  ✗ The last seat  stopped after 1 event(s): No Reserve is in flight to seats
```

The scenario stops at the first event that can't happen, and says why. This is often how you
find a mistake in your understanding: you write down the flow you believe in, and the model
says it can't go that way.

## The playground

`feynman dev` opens the simulator. It is the same spec, drawn:

- **The map.** Zones are regions, actors are nodes, and messages in flight travel between
  them. Nodes show their `display.status` and `rows`, coloured by `mood` and by `owner`.
- **Start from.** Pick the start, or any scenario, and the playground opens on that world.
  A scenario with a setup starts after it.
- **Play, Step, Back.** Play runs the system left alone, as `s.settle()` does. Step (→) takes
  one event, and ← goes back one. Every moment is kept, so you can go back and try
  something else from there.
- **Act.** Click a node to see its actions. Inputs offer the values the spec gives, and
  "Other…" lets you type one.
- **Deliver out of order.** Click a message in flight to deliver it next. This is how you show
  someone a race: deliver Bob's check before Alice's write.
- **The timeline** lists every event in words: the step's `say` sentence if it has one,
  otherwise its `description`.
- **Share it.** The URL holds the scenario, the timeline and the view, so a link reopens
  exactly this moment. "Copy timeline" gives the events as JSON, which is a quick way to
  write a scenario from something you clicked through.

`feynman build` writes the whole thing as one HTML file, which is how specs end up on a wiki
page or in a pull request.

## What makes a good scenario

- **One story each**, named as people would name it: "The last seat", "Both want A2 at once",
  "Alice pays after her hold expired".
- **The description says what happens and how it ends**, in a sentence. It is a claim the
  reader will trust, so update it when the design changes.
- **The happy path first.** Every spec should have the flow a newcomer asks about before any
  of the races.
- **Deliver by hand only what decides the story**, then settle.
- **Set up, don't replay.** If the story starts after some history, put the world there.
- **Keep the bugs.** A fixed bug's scenario still shows what the fix is for.

## Exercises

1. Write a scenario where Bob gets A2 in "The last seat". You need one `s.deliver` before the
   `settle`. Which message?
2. Write a setup for a sold-out show, and a scenario in which a fourth person, Dan, tries to
   buy. What do the properties say about the world your setup made?
3. Make "Both want A1" a setup-only scenario: move the two spawns into `setup`, and leave
   `run` with the two buys. How does the number of explored states change? Why?
