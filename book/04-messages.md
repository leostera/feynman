# 4. Telling each other

> *What happens when two people press the button at the same time?*

The box office goes online. People buy seats on their phones, and the theatre's website sells
them. The phones and the website are separate programs, on separate machines, so they talk
the only way separate programs can: with **messages**.

## What changes when there are messages

At the counter, one clerk did one thing at a time. Online, a person sends a request and goes
on with their life, and the answer comes back later. In between, anything else may happen:
another person's request may arrive first, and replies may arrive in any order.

Feynman has no clock. A run is an order of events, and at every moment, anything pending may
go next: any message in flight, any action someone could take. A message sent first does not
have to arrive first. This is how networks behave once you allow them to be slow, and it is
where the interesting bugs live. (Messages on one connection do keep their order: chapter 8
says how to declare that.)

## Step 1: asking for a seat

Messages are defined at the top of the file, each with an id and the schema of its payload:

```ts
const SEATS = ["A1", "A2"] as const;
type Seat = (typeof SEATS)[number];
const seat = oneOf(...SEATS);

const Buy = defineMessage("Buy", { seat }, { over: "https" });
const Ticket = defineMessage("Ticket", { seat }, { tone: "reply" });
```

The third argument is optional and only for readers:

- `over` names how the message travels (`"https"`, `"websocket"`, `"rpc"`, `"queue"`);
- `tone` tells the views how to draw it: `"request"`, `"reply"`, `"refused"` or `"stream"`;
- `name` gives it a name in words, when its id isn't one. It defaults to the id in words.

People are an actor too. There are many of them, so the actor is not a singleton:

```ts
const people = defineZone({ name: "People", description: "buying on their phones" });

const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true,
  initialState: () => ({ tickets: new Set<Seat>(), waiting: false }),
  display: {
    icon: "phone",
    names: ["Alice", "Bob"],
  },
  actions: {
    buy: {
      with: [atMost(2)],
      label: "Buy a seat",
      description: "Asks the box office for a seat.",
      inputs: { seat },
      when: (s) => !s.waiting,
      sends: [Buy],
      run(state, { seat }, ctx) {
        state.waiting = true;
        ctx.send(ctx.the(BoxOffice), Buy, { seat });
      },
    },
  },
});
```

- `ctx.send(to, message, payload)` puts a message in flight. `ctx.the(BoxOffice)` finds the
  one box office.
- `sends: [Buy]` declares what the action may send. TypeScript checks the payload against the
  schema, and the engine refuses a send that isn't declared.
- `with: [atMost(2)]` bounds the action: each person buys at most twice on any run. People
  could keep buying forever, but the checker must stop somewhere. Chapter 12 is about
  choosing bounds.
- `display.names` are the labels the playground gives people as you add them.

The website receives `Buy` and answers with a ticket:

```ts
const theatre = defineZone({ name: "Theatre", description: "the box office's website" });

interface Office {
  /** Who bought each seat, by instance id. A seat not in it is free. */
  sold: Map<Seat, string>;
}

const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website, which sells seats for tonight's show.",
  zone: theatre,
  singleton: true,
  initialState: (): Office => ({ sold: new Map() }),
  transitions: {
    buy: {
      on: Buy,
      description: "Sells the seat if it is free.",
      sends: [Ticket],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return;
        state.sold.set(msg.seat, ctx.from.id);
        ctx.reply(Ticket, { seat: msg.seat });
      },
    },
  },
});
```

A step `on` a message receives its payload as `msg`, and `ctx.from` is who sent it.
`ctx.reply` sends to `ctx.from`. The box office now remembers *who* bought each seat: a `Map`
from seat to buyer.

Check it ([`specs/04-online/1-buy.ts`](specs/04-online/1-buy.ts)):

```text
Box office.buy: sends ticket, but no actor of Box office has a step on Ticket
```

Nothing ran. `defineSpec` looked at the parts before anything started, and found a message
sent that nobody receives. In a real system that message would arrive at a phone that doesn't
know what to do with it. Feynman refuses such a spec outright. It refuses other parts that
don't fit, too: two parts with one id, or a send the step doesn't declare.

## Step 2: getting the ticket

The person needs a step on `Ticket`:

```ts
  transitions: {
    ticket: {
      on: Ticket,
      description: "Gets the ticket.",
      run(state, msg) {
        state.tickets.add(msg.seat);
        state.waiting = false;
      },
    },
  },
```

And the spec needs to say when it is done. A first try: the system is finished when nothing is
in flight.

```ts
  finalState: { description: "Everyone who asked has an answer.", when: (w) => w.quiet },
```

```text
Box office: explored 16 states (1 of each actor) in 76ms
```

Nothing to report. That should make us suspicious, because the box office ignores a `Buy` for
a seat it has sold. What happens to the person who asked?

The `description` of the final state says "everyone who asked has an answer", but the `when`
says something weaker: nothing is in flight. A person waiting forever for an answer that will
never come is also "nothing in flight". We told the checker a deadlock is fine.

Say what finished means:

```ts
  finalState: { description: "Everyone who asked has an answer.", when: (w) => w.quiet && w.all(Person).every((p) => !p.state.waiting) },
```

`w.all(Person)` is every person in the world. Now
([`specs/04-online/2-tickets.ts`](specs/04-online/2-tickets.ts)):

```text
Box office: explored 16 states (1 of each actor) in 59ms
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       1  Person (Person)  buy  {"seat":"A1"}
          Asks the box office for a seat.
          waiting: false → true
          → Box office: buy {"seat":"A1"}
       2  Box office (Box office)  buy  {"seat":"A1"}  from Person
          Sells the seat if it is free.
          sold: {} → {"A1":"person-person"}
          → Person: ticket {"seat":"A1"}
       3  Person (Person)  ticket  {"seat":"A1"}  from Box office
          Gets the ticket.
          tickets: [] → ["A1"]
          waiting: true → false
       4  Person (Person)  buy  {"seat":"A1"}
          Asks the box office for a seat.
          waiting: false → true
          → Box office: buy {"seat":"A1"}
       5  Box office (Box office)  buy  {"seat":"A1"}  from Person
          Sells the seat if it is free.
```

The person bought A1, asked for A1 again, and the box office said nothing. The phone spins
forever. In code this is a request handler that returns early without writing a response, and
it is one of the most common bugs there is.

Notice who found it: there was only one person (the checker starts with one of each actor),
and they found it by buying the same seat twice. `atMost(2)` gave them the chance.

**A lesson worth keeping:** `finalState` is a claim. `w.quiet` alone claims that every
deadlock is finished. Say what finished means: nothing in flight *and* nobody waiting.

## Step 3: saying no

An answer that says "no" is still an answer:

```ts
const SoldOut = defineMessage("SoldOut", { seat }, { name: "sold out", tone: "refused" });
```

```ts
    buy: {
      on: Buy,
      description: "Sells the seat if it is free; otherwise says it is sold out.",
      sends: [Ticket, SoldOut],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return ctx.reply(SoldOut, { seat: msg.seat });
        state.sold.set(msg.seat, ctx.from.id);
        ctx.reply(Ticket, { seat: msg.seat });
      },
    },
```

```ts
    soldOut: {
      on: SoldOut,
      description: "Hears the seat is gone.",
      run: (state) => void (state.waiting = false),
    },
```

One message per meaning: `SoldOut` is its own message, not a `Ticket` with an `ok: false`
field. Each gets its own step, its own description, and its own line on the timeline.

```text
Box office: explored 18 states (1 of each actor) in 64ms
```

## Step 4: two people

Everything so far had one person in it. The question this chapter opened with needs two.
There are two ways to get them.

On the command line, `--instances Person=2` checks with two people from the start:

```text
Box office: explored 259 states (2 Person, and from the end of 1 scenario(s)) in 93ms
```

Or, better, write a **scenario** that sets up the moment we care about. The checker explores
from the end of every scenario too, so a scenario that brings in two people makes every later
check consider two:

```ts
const bothWantA1 = defineScenario("Both want A1", {
  description: "Alice and Bob ask for A1 at once; Alice's request arrives first, so she gets it and Bob hears it is sold out.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    const bob = s.spawn(Person, "Bob");
    s.act(alice, "buy", { seat: "A1" });
    s.act(bob, "buy", { seat: "A1" });
    s.deliver(s.the(BoxOffice), Buy, { seat: "A1" }); // the oldest Buy in flight: Alice's
    s.settle();
  },
});
```

- `s.spawn(Person, "Alice")` brings a person into the world, labelled as people would say it.
- `s.act(alice, "buy", { seat: "A1" })` takes her action.
- `s.deliver(to, Message, payload?)` delivers one message in flight now, ahead of anything
  else: the oldest one that matches. This is how a scenario picks an order.
- `s.settle()` leaves the system alone: every message arrives in the order it was sent, until
  nothing is pending.

`feynman run specs/04-online/4-two-people.ts` prints its trace:

```text
Both want A1 (book/specs/04-online/4-two-people.ts)
   1  Alice (Person)  spawn
   2  Bob (Person)  spawn
   3  Alice (Person)  buy  {"seat":"A1"}
      → Box office: buy {"seat":"A1"}
   4  Bob (Person)  buy  {"seat":"A1"}
      → Box office: buy {"seat":"A1"}
   5  Box office (Box office)  buy  {"seat":"A1"}  from Alice
      sold: {} → {"A1":"person-alice"}
      → Alice: ticket {"seat":"A1"}
   6  Box office (Box office)  buy  {"seat":"A1"}  from Bob
      → Bob: sold out {"seat":"A1"}
   7  Alice (Person)  ticket  {"seat":"A1"}  from Box office
      tickets: [] → ["A1"]
      waiting: true → false
   8  Bob (Person)  sold out  {"seat":"A1"}  from Box office
      waiting: true → false
```

The box office handles one message at a time, to the end, so the check and the sale in `buy`
can't be split by another request. That is why this race is harmless: whoever's `Buy` arrives
first gets the seat, and the other hears it is gone. Compare the wire transfer in chapter 1,
where the check and the write were in different steps, and other events could happen in
between.

**Steps are atomic.** Everything in one `run` happens at once. When you model code, a step is
a stretch of code that nothing else can interleave with: a single database statement, a
handler in a single-threaded actor, a critical section. If the real code `await`s in the
middle, that `await` is where your step must end.

### Symmetry

Alice and Bob are interchangeable: nothing in the spec cares which of them is which, only
whether two requests come from the same person. `symmetric: true` on `Person` tells the
checker so, and it treats "Alice buys A1, Bob buys A2" and "Bob buys A1, Alice buys A2" as the
same world, which saves states. A claim like that should be checked, and the checker does
check it, on a sample of the worlds it merges. Chapter 12 has the rules for when it's safe.

### Displays

The full spec ([`specs/04-online/4-two-people.ts`](specs/04-online/4-two-people.ts)) also gives
both actors a `display`, so the playground has something to show. The box office draws a row
per seat, coloured by who bought it:

```ts
  display: {
    icon: "server",
    status: (s) => `${SEATS.length - s.sold.size} seat(s) left`,
    rows: (s) => SEATS.map((seat) => ({ label: seat, detail: s.sold.has(seat) ? "sold" : "free", mood: s.sold.has(seat) ? "off" : "ok", owner: s.sold.get(seat) })),
  },
```

`owner` names the instance a row belongs to, so A1's row wears Alice's colour once she has it.
Run `feynman dev`, pick "Both want A1" as the start, and press Play. Two requests fly to the
box office, and the answers fly back. Then go back to event 4, and deliver Bob's request first
by clicking it in flight.

## What we have

Two actors that talk, each step atomic, any order of delivery. The race in this chapter was
harmless, because the box office checks and sells in one step. The next chapter breaks that
on purpose, the way real websites do, and writes down what must stay true so the checker can
tell us when it doesn't.

## Exercises

1. Remove `symmetric: true` from `Person` and check with `--instances Person=2`. How many
   states now (466, against 259)? Which worlds did symmetry merge?
2. Add a `cancel` action that returns a ticket: the person sends `Cancel { seat }`, and the box
   office frees the seat. What must the box office check before freeing it? What happens if
   it doesn't?
3. Change step 4's scenario so Bob gets A1. Which line do you change?
