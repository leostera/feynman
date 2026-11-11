# 3. Things and what they hold

> *What runs separately, and what does it remember?*

From here to the end of Part I we model one system: the box office of a small theatre. It
starts as a counter at the door with a clerk behind it. By chapter 12 it is a website that
holds seats, takes card payments through a bank and survives restarts, and each chapter adds
one thing that can go wrong.

This chapter is about the smallest pieces: **actors**, their **state**, and the **actions**
the outside world takes on them.

## Step 1: an actor

An actor is anything that runs separately or keeps its own state: a process, a service, a
database you don't own, a device, a person. Tonight's show has two seats, and the box office
knows how many are left:

```ts
import { defineActor, defineSpec, defineZone } from "@leostera/feynman";

const theatre = defineZone({ name: "Theatre", description: "the box office at the door" });

const BoxOffice = defineActor({
  name: "Box office",
  description: "The counter at the door, where a clerk sells seats for tonight's show.",
  zone: theatre,
  singleton: true,
  initialState: () => ({ left: 2 }),
});

export default defineSpec({ name: "Box office", actors: [BoxOffice] });
```

Every actor needs:

- a `name`, in the words the people who run the system use ("Box office", not
  "TicketService");
- a `zone`, the part of the system it belongs to, which the playground draws as a region;
- an `initialState`, a function returning what it holds when the world begins.

`singleton: true` means there is exactly one, there from the start. Things there are many of,
such as people or workers, leave it out (chapter 4).

Check it ([`specs/03-counter/1-an-actor.ts`](specs/03-counter/1-an-actor.ts)):

```text
Box office: explored 1 states (1 of each actor) in 6ms
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
```

One state, and the checker calls it **stuck**: nothing can happen in it. Feynman reports a
world where nothing can happen, because in a real system that is usually a deadlock, or
someone waiting for an answer that will never come. Here it is simply true: we have given the
box office nothing to do.

## Step 2: an action

**Actions** are what the outside world does to the system: a person presses a button, an
operator runs a command, a clerk sells a seat. They are the buttons in the playground, and the
checker tries them in every order.

```ts
  actions: {
    sell: {
      label: "Sell a seat",
      description: "The clerk sells a seat, while there is one left.",
      when: (s) => s.left > 0,
      run(state) {
        state.left -= 1;
      },
    },
  },
```

- `label` is the button's text.
- `description` says what happens, in a sentence, in everyday words. The timeline shows it
  for every event.
- `when` is a guard: the action is offered only while it holds. No seats left, no selling.
- `run` changes the state **in place**. The engine watches what changes and records it as
  `path: before → after`.

```text
Box office: explored 3 states (1 of each actor) in 20ms
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       1  Box office (Box office)  sell
          The clerk sells a seat, while there is one left.
          left: 2 → 1
       2  Box office (Box office)  sell
          The clerk sells a seat, while there is one left.
          left: 1 → 0
```

Three states: 2, 1 and 0 seats left. It is stuck again, but now the checker shows how it got
there: two sales, and the show is sold out. That isn't a bug. We'll say so in step 4.

### A mistake worth making once

If you write steps the way you'd write a reducer, returning a new state:

```ts
      run: (state) => ({ left: state.left - 1 }),
```

the checker stops at the first sale:

```text
  ✗ spec error: Box office.sell: its run returned an object, which is ignored: a step changes its state in place (state.n += 1), it does not return a new one
```

A **spec error** is Feynman telling you the model is wrong, as opposed to the system. A step
that fails has no effects at all. Its changes and messages are thrown away, so a broken
model never produces a misleading verdict.

The engine also holds steps to a few rules that keep exploration honest:

- **Steps are deterministic.** They see the world only through `ctx`, the third argument.
  No `Date.now()`, no `Math.random()`, no `await`, no I/O, no module-level variables that
  change. Need a fresh id? `ctx.fresh("order")`. A hash? `ctx.hash(secret)`. A random number?
  `ctx.random()`, which is seeded: each draw gives one value, so the checker follows one
  outcome and says `~`, not `✓`, of what held there. For a choice the checker should try
  both ways, use an input or two steps.
- **State is plain data:** strings, numbers, booleans, `null`, arrays, plain objects, `Set`s,
  `Map`s and dates. No class instances, no functions.
- **A step changes only its own actor's state.** To affect another actor, it sends a message.

These rules are what let the checker go back to any moment and try a different order. They
are also good discipline: a step that needs the wall clock is hiding a race with it
(chapter 7).

## Step 3: which seat

The clerk doesn't sell "a seat", but A1 or A2. Inputs say what an action takes:

```ts
const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];

interface Office {
  sold: Set<Seat>;
}

const freeSeats = (office: Readonly<Office>): Seat[] => SEATS.filter((seat) => !office.sold.has(seat));
```

```ts
  initialState: (): Office => ({ sold: new Set() }),
  actions: {
    sell: {
      label: "Sell a seat",
      description: "The clerk sells a seat that is still free.",
      inputs: { seat: oneOf(...SEATS) },
      when: (s) => freeSeats(s).length > 0,
      run(state, { seat }) {
        state.sold.add(seat);
      },
    },
  },
```

Three choices here are worth a moment.

- **The seat is a type, not a string.** `oneOf("A1", "A2")` is a schema: the checker tries
  each value, the playground offers each as a button, and TypeScript knows `seat` is a
  `Seat`. Nothing else can get in.
- **`sold` is a `Set`.** The order seats were sold in doesn't decide anything, so don't keep
  it. Two worlds where A1 and A2 are sold are the same world, whichever went first, and the
  checker merges them. State that decides nothing still costs states.
- **`left` is gone.** It would be a second copy of the same fact (`left === 2 - sold.size`),
  and two copies can drift apart. Keep one, and compute the other.

```text
Box office: explored 4 states (1 of each actor) in 29ms
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       1  Box office (Box office)  sell  {"seat":"A1"}
          The clerk sells a seat that is still free.
          sold: [] → ["A1"]
       2  Box office (Box office)  sell  {"seat":"A2"}
          The clerk sells a seat that is still free.
          sold: ["A1"] → ["A1","A2"]
```

Four states: nothing sold, A1, A2, both. Notice what the trace says on each line: the input,
the description, and exactly what changed.

There is a quiet problem, though. With A1 sold, the clerk can still "sell" A1: the action is
offered while any seat is free, and `run` adds A1 to a set that already has it. Nothing
changes, so it does no harm here. But it is a step the real clerk can't take, and specs should
not allow what the system doesn't.

## Step 4: only what's possible, and when it's done

Two changes finish the counter. First, the action offers only free seats, and says so when a
scenario forces a sold one:

```ts
      inputs: { seat: input(oneOf(...SEATS), { examples: (w): Seat[] => freeSeats(w.the(BoxOffice).state) }) },
      when: (s) => freeSeats(s).length > 0,
      run(state, { seat }, ctx) {
        if (state.sold.has(seat)) return ctx.note(`${seat} is sold already; the clerk refuses.`);
        state.sold.add(seat);
      },
```

`input(type, { examples })` gives the values to try, from the world as it is. The checker and
the playground both use them. The function needs its return type (`: Seat[]`) because it
reads `BoxOffice` inside `BoxOffice`'s own definition, and TypeScript can't infer a type from
itself. `ctx.note` adds a sentence to this one event in the timeline.

Second, a sold-out show isn't stuck, it's finished. `finalState` says which worlds are allowed
to have nothing left to do:

```ts
export default defineSpec({
  name: "Box office",
  description: "Selling seats for one show.",
  actors: [BoxOffice],
  finalState: { description: "The show is sold out.", when: (w) => freeSeats(w.the(BoxOffice).state).length === 0 },
  scenarios: [sellOut],
});
```

We also add `display` (how the playground draws the box office) and a scenario. Both come up
properly later:

```ts
  display: {
    icon: "card",
    status: (s) => `${freeSeats(s).length} seat(s) left`,
    mood: (s) => (freeSeats(s).length ? "ok" : "off"),
  },
```

```ts
const sellOut = defineScenario("Sell out", {
  description: "The clerk sells A1, then A2: the show is sold out.",
  run(s) {
    const office = s.the(BoxOffice);
    for (const seat of SEATS) s.act(office, "sell", { seat });
  },
});
```

```text
Box office: explored 4 states (1 of each actor, and from the end of 1 scenario(s)) in 20ms
  no step points at code yet; this spec is a design. Add sources as the code appears.
```

Nothing to report. The full spec is
[`specs/03-counter/4-sold-out.ts`](specs/03-counter/4-sold-out.ts).

## What to keep in state

Every field in an actor's state is a question the checker must ask about every world. Keep a
field only if it decides what happens next, or a property needs it. Good questions to ask
of each field:

- **Does any step's `when` or `run` read it?** If not, and no property reads it, delete it.
- **Is it a second copy of something?** Compute it instead.
- **Does its order matter?** If not, use a `Set` or a `Map`, not an array.
- **Does it only grow?** A log, a counter, a history. Those make every world different from
  every other, and the search never ends. Keep what decides behaviour (the last version, the
  ids seen), not the history.
- **Is it a secret?** Keep `ctx.hash(secret)`, never the secret.

## What we have

An actor with state, one action with an input, and a world where the system may stop. No
messages yet: everything happens at one counter, one sale at a time, so nothing can go wrong.
Next chapter, the box office goes online, and two people can try to buy the same seat.

## Exercises

1. Add a third seat. How many states does the checker explore? Why is it 8, not 6?
2. Change `sold` to an array, `Seat[]`, with `state.sold.push(seat)`. Count the states again.
   What are the extra ones?
3. Add a `refund` action that frees a sold seat. What happens to the `finalState` check? Is
   the show ever sold out "for good"?
