# 5. What must stay true

> *What would we never want to happen, no matter the order of events?*

So far we have modelled the box office and watched it run. That is half of a spec. The other
half says what must be true of every run. Those are **properties**, and they are why the
checker exists: it can't tell a bug from a feature unless we say which is which.

This chapter writes properties for the box office, then moves the box office's data into a
database, the way real websites are built. The properties find what that move broke.

## Step 1: two properties

What would the theatre never want? Two people with tickets for the same seat. And a ticket in
someone's hand that the books don't agree with. Each becomes a property:

```ts
const oneOwnerPerSeat = defineProperty("oneOwnerPerSeat", {
  description: "No two people hold a ticket for the same seat.",
  always: (w) => {
    const seats = w.all(Person).flatMap((p) => [...p.state.tickets]);
    return new Set(seats).size === seats.length;
  },
});

const ticketsMatchTheBooks = defineProperty("ticketsMatchTheBooks", {
  description: "Whoever holds a ticket is who the books say bought that seat.",
  always: (w) => w.all(Person).every((p) => [...p.state.tickets].every((seat) => w.the(BoxOffice).state.sold.get(seat) === p.id)),
});
```

```ts
export default defineSpec({
  // …
  properties: [oneOwnerPerSeat, ticketsMatchTheBooks],
});
```

A property has an id (the word the CLI and `--only` use), a description in everyday words,
and a predicate. `always` is called with the world, and returns whether the property holds
there. The world gives read-only access to every actor's state:

- `w.the(Actor)`: the one instance of a singleton (or the only one there is);
- `w.all(Actor)`: every instance of an actor;
- `instance.state`, `instance.id`, `instance.label`;
- `w.quiet`: nothing in flight, no timer set.

Notice that the two properties overlap but aren't the same. If the box office sold A1 to Bob
and Alice's phone showed A1 too, both would break. If the box office lost a sale (Alice holds
A1 but the books say A1 is free), only the second would. Several precise properties tell you
more than one vague one, because the one that breaks names the problem.

```text
Box office: explored 67 states (1 of each actor, and from the end of 1 scenario(s)) in 74ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
```

Both hold. As we saw last chapter, the box office checks and sells in one step, so there is
no gap to fall into.

## Step 2: a database

Real box offices don't keep seats in a web server's memory. The web server is stateless, and
the seats live in a database. A request looks like this:

1. a person sends `Buy { seat }` to the website;
2. the website asks the database whether the seat is free;
3. if it is, the website writes the buyer against the seat;
4. once written, the website sends the ticket.

Two actors now stand where the box office was:

```ts
// Between the website and the database. The website keeps nothing between requests: each
// message carries the buyer it is about, as a request handler's local variables would.
const IsFree = defineMessage("IsFree", { seat, buyer: String }, { name: "is it free?", over: "sql" });
const Answer = defineMessage("Answer", { seat, buyer: String, free: Boolean }, { tone: "reply" });
const Reserve = defineMessage("Reserve", { seat, buyer: String }, { over: "sql" });
const Reserved = defineMessage("Reserved", { seat, buyer: String }, { tone: "reply" });
```

```ts
const Seats = defineActor({
  name: "Seats",
  description: "The database table of tonight's seats and who bought them.",
  zone: theatre,
  singleton: true,
  initialState: (): Books => ({ sold: new Map() }),
  transitions: {
    isFree: {
      on: IsFree,
      description: "Says whether the seat is free.",
      sends: [Answer],
      run: (state, msg, ctx) => ctx.reply(Answer, { ...msg, free: !state.sold.has(msg.seat) }),
    },
    reserve: {
      on: Reserve,
      description: "Writes the buyer against the seat.",
      sends: [Reserved],
      run(state, msg, ctx) {
        state.sold.set(msg.seat, msg.buyer);
        ctx.reply(Reserved, msg);
      },
    },
  },
});
```

```ts
const Website = defineActor({
  name: "Website",
  description: "The box office's web server: it takes orders and asks the database.",
  zone: theatre,
  singleton: true,
  initialState: () => ({}),
  transitions: {
    buy: {
      on: Buy,
      description: "Asks the database whether the seat is free.",
      sends: [IsFree],
      run: (_state, msg, ctx) => ctx.send(ctx.the(Seats), IsFree, { seat: msg.seat, buyer: ctx.from.id }),
    },
    answer: {
      on: Answer,
      description: "Reserves the seat if it was free; otherwise tells the buyer it is sold out.",
      sends: [Reserve, SoldOut],
      run(_state, msg, ctx) {
        if (!msg.free) return ctx.send({ id: msg.buyer }, SoldOut, { seat: msg.seat });
        ctx.reply(Reserve, { seat: msg.seat, buyer: msg.buyer });
      },
    },
    reserved: {
      on: Reserved,
      description: "Sends the buyer their ticket.",
      sends: [Ticket],
      run: (_state, msg, ctx) => ctx.send({ id: msg.buyer }, Ticket, { seat: msg.seat }),
    },
  },
});
```

The website has no state at all. Each handler gets what it needs from the message, as a real
request handler gets it from its local variables across an `await`. `ctx.send({ id: msg.buyer },
…)` sends to an instance by its id.

This is a faithful model of a lot of real code:

```ts
app.post("/buy", async (req) => {
  const row = await db.query("SELECT buyer FROM seats WHERE seat = $1", [req.seat]);
  if (row.buyer) return soldOut();
  await db.query("UPDATE seats SET buyer = $1 WHERE seat = $2", [req.user, req.seat]);
  return ticket();
});
```

Each `await` is where one step ends and the next begins. Between them, other requests run.

The properties now read the books from `Seats` instead of the box office. A helper saves
writing the same loop twice:

```ts
/** Every ticket people hold, as seat and holder. */
const ticketsHeld = (w: { all: (actor: typeof Person) => { id: string; state: { tickets: ReadonlySet<Seat> } }[] }) =>
  w.all(Person).flatMap((p) => [...p.state.tickets].map((seat) => ({ seat, holder: p.id })));

const oneOwnerPerSeat = defineProperty("oneOwnerPerSeat", {
  description: "No two people hold a ticket for the same seat.",
  always: (w) => {
    const seats = ticketsHeld(w).map((t) => t.seat);
    return new Set(seats).size === seats.length;
  },
});

const ticketsMatchTheBooks = defineProperty("ticketsMatchTheBooks", {
  description: "Whoever holds a ticket is who the books say bought that seat.",
  always: (w) => ticketsHeld(w).every((t) => w.the(Seats).state.sold.get(t.seat) === t.holder),
});
```

We changed the scenario a little, too. Alice's request now goes all the way through before
Bob asks, so the story it tells is the one we expect:

```ts
const bothWantA1 = defineScenario("Both want A1", {
  description: "Alice and Bob ask for A1 at once; Alice's request goes all the way through first, so she gets it and Bob hears it is sold out.",
  run(s) {
    const alice = s.spawn(Person, "Alice");
    const bob = s.spawn(Person, "Bob");
    s.act(alice, "buy", { seat: "A1" });
    s.settle();
    s.act(bob, "buy", { seat: "A1" });
    s.settle();
  },
});
```

Check it ([`specs/05-properties/2-a-database.ts`](specs/05-properties/2-a-database.ts)):

```text
Box office: explored 228 states (1 of each actor, and from the end of 1 scenario(s)) in 131ms
  ✗ oneOwnerPerSeat  No two people hold a ticket for the same seat.
    shortest counterexample, 14 event(s), needs no faults, from the end of scenario "Both want A1"
  ✗ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
    shortest counterexample, 12 event(s), needs no faults, from the end of scenario "Both want A1"
```

Both broken. The scenario ran cleanly, as described. But the checker went on exploring from
where it ended, with Alice and Bob both in the world, and found trouble there.

## Reading a counterexample

`--only` shows one property's counterexample in full:

```sh
feynman check specs/05-properties/2-a-database.ts --only ticketsMatchTheBooks
```

```text
  ✗ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
    shortest counterexample, 12 event(s), needs no faults, from the end of scenario "Both want A1":
       1  Alice (Person)  buy  {"seat":"A2"}
          → Website: buy {"seat":"A2"}
       2  Bob (Person)  buy  {"seat":"A2"}
          → Website: buy {"seat":"A2"}
       3  Website (Website)  buy  {"seat":"A2"}  from Alice
          → Seats: is it free? {"seat":"A2","buyer":"person-alice"}
       4  Website (Website)  buy  {"seat":"A2"}  from Bob
          → Seats: is it free? {"seat":"A2","buyer":"person-bob"}
       5  Seats (Seats)  is it free?  {"seat":"A2","buyer":"person-alice"}  from Website
          → Website: answer {"seat":"A2","buyer":"person-alice","free":true}
       6  Seats (Seats)  is it free?  {"seat":"A2","buyer":"person-bob"}  from Website
          → Website: answer {"seat":"A2","buyer":"person-bob","free":true}
       7  Website (Website)  answer  {"seat":"A2","buyer":"person-alice","free":true}  from Seats
          → Seats: reserve {"seat":"A2","buyer":"person-alice"}
       8  Website (Website)  answer  {"seat":"A2","buyer":"person-bob","free":true}  from Seats
          → Seats: reserve {"seat":"A2","buyer":"person-bob"}
       9  Seats (Seats)  reserve  {"seat":"A2","buyer":"person-alice"}  from Website
          sold: {"A1":"person-alice"} → {"A1":"person-alice","A2":"person-alice"}
          → Website: reserved {"seat":"A2","buyer":"person-alice"}
      10  Seats (Seats)  reserve  {"seat":"A2","buyer":"person-bob"}  from Website
          sold: {"A1":"person-alice","A2":"person-alice"} → {"A1":"person-alice","A2":"person-bob"}
          → Website: reserved {"seat":"A2","buyer":"person-bob"}
      11  Website (Website)  reserved  {"seat":"A2","buyer":"person-alice"}  from Seats
          → Alice: ticket {"seat":"A2"}
      12  Alice (Person)  ticket  {"seat":"A2"}  from Website
          tickets: ["A1"] → ["A1","A2"]
          ✗ breaks ticketsMatchTheBooks
```

How to read one:

1. **Start at the end.** Event 12 broke the property: Alice now holds A2. Look at the state
   just before. The books say A2 is Bob's (event 10).
2. **Find where the world went wrong**, which is usually earlier than where the property
   noticed. Event 10 is the moment: the database overwrote Alice's reservation with Bob's.
   Nothing complained, because nothing checked.
3. **Find why it was allowed.** Events 5 and 6: both checks said "free", because both ran
   before either write. The check and the write are different steps, and the other request
   got in between.
4. **Tell it as a story** in one or two sentences, in the system's words. Here: *"Alice and
   Bob both ask for A2. The database tells each of them it's free, then writes Alice, then
   overwrites her with Bob. Alice gets a ticket for Bob's seat."*

If you can't tell the story, you don't understand the bug yet. If the story describes
something the real system can't do, the spec is wrong, not the system (chapter 15 is about
telling which).

The other property, `oneOwnerPerSeat`, breaks two events later, when Bob's ticket arrives
too. Different properties see the same bug at different moments, and the earliest one is
usually the most useful to read.

## Step 3: properties of steps, and of paths

`always` judges one world at a time. Some rules are about change, not about any one world.
"Once sold, a seat stays sold to the same person" can't be checked from a single state: the
world after the overwrite looks perfectly normal. It's about the step from one to the next.

```ts
const soldSeatsStaySold = defineProperty("soldSeatsStaySold", {
  description: "Once a seat is sold, it stays sold to the same person.",
  everyStep: (before, after) =>
    [...before.the(Seats).state.sold].every(([seat, buyer]) => after.the(Seats).state.sold.get(seat) === buyer),
});
```

`everyStep` receives the world before a step, the world after it, and the event itself
(`e.is(Seats, "reserve")`, `e.sent(Ticket)`), and judges every step the checker takes.

```text
  ✗ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
    shortest counterexample, 10 event(s), needs no faults, from the end of scenario "Both want A1"
```

```text
      10  Seats (Seats)  reserve  {"seat":"A2","buyer":"person-bob"}  from Website
          sold: {"A1":"person-alice","A2":"person-alice"} → {"A1":"person-alice","A2":"person-bob"}
          ✗ breaks soldSeatsStaySold
```

Ten events, not twelve: it stops at the overwrite itself, the moment the world went wrong.
A step property often points at the cause where a state property points at a symptom.

The third kind, `never`, judges the whole path so far. It's for rules about what has
happened, counted over time:

```ts
const noMoreTicketsThanSeats = defineProperty("noMoreTicketsThanSeats", {
  description: "The website never sends more tickets than there are seats.",
  never: (t) => t.count((e) => e.sent(Ticket)) > SEATS.length,
});
```

`never` takes the trace. `t.count(pred)` and `t.some(pred)` ask about its events. The property
breaks when a trace has this shape.

```text
  ✗ noMoreTicketsThanSeats  The website never sends more tickets than there are seats.
    shortest counterexample, 12 event(s), needs no faults, from the end of scenario "Both want A1":
```

It breaks too, but look at where. The checker explores from the end of each scenario, and a
`never` property counts the scenario's steps as part of the path. Alice's ticket for A1, which
the scenario got her, is the first. Then Alice and Bob both get A2: three tickets, two seats.

It needed that third ticket. Two tickets for A2 alone are not more than two, so on a path
where nobody has bought A1 this property sees nothing wrong, while `oneOwnerPerSeat` does. A
property that breaks isn't the same as a property that says what went wrong, and one that
holds isn't the same as one strong enough to notice. This is why we write several, and why
chapter 11 gives a way to check that a property can actually fail.

Which kind to use:

| You want to say | Use |
| --- | --- |
| something about every world: "no account is negative" | `always` |
| something about every change: "a sold seat never changes hands", "versions only go up" | `everyStep` |
| something about what has happened so far: "at most one charge per order" | `never` |

Prefer `always`, then `everyStep`. They are cheaper: a `never` property makes the checker
remember part of the path in every state, and two worlds that look the same but got there
differently can no longer be merged.

## Step 4: the fix

The database must refuse to write over a sold seat, in the same step that writes. In SQL,
that's `UPDATE seats SET buyer = $1 WHERE seat = $2 AND buyer IS NULL`, followed by checking
how many rows it changed. Or a unique constraint, and catching the error.

```ts
const Taken = defineMessage("Taken", { seat, buyer: String }, { tone: "refused" });
```

```ts
    reserve: {
      on: Reserve,
      description: "Writes the buyer against the seat, unless someone has it already.",
      sends: [Reserved, Taken],
      run(state, msg, ctx) {
        if (state.sold.has(msg.seat)) return ctx.reply(Taken, msg);
        state.sold.set(msg.seat, msg.buyer);
        ctx.reply(Reserved, msg);
      },
    },
```

```ts
    taken: {
      on: Taken,
      description: "Someone got there first: tells the buyer it is sold out.",
      sends: [SoldOut],
      run: (_state, msg, ctx) => ctx.send({ id: msg.buyer }, SoldOut, { seat: msg.seat }),
    },
```

We also drop `noMoreTicketsThanSeats`. It counts tickets where the other three say who holds
which seat, so it only adds noise.

```text
Box office: explored 216 states (1 of each actor, and from the end of 1 scenario(s)) in 160ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
  ✓ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
```

The website still asks "is it free?" first, which now only saves a write when the answer is
no. The guarantee comes from the database's conditional write. The full spec is
[`specs/05-properties/4-fixed.ts`](specs/05-properties/4-fixed.ts).

## Step 5: a fix too good to be true

Every property we have says something must never happen. A box office that never sells a
seat keeps all of them. Say the condition on the write is wrong, so the database refuses
every reservation:

```ts
    reserve: {
      on: Reserve,
      description: "Refuses: the condition on the write is wrong, and always fails.",
      sends: [Taken],
      run: (_state, msg, ctx) => ctx.reply(Taken, msg),
    },
```

```text
Box office: explored 132 states (1 of each actor, and from the end of 1 scenario(s)) in 41ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
  ✓ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
  never ran: Person.ticket, Website.reserved
  ! Website reserved is on Reserved, which no step sends: it never runs
```

Three ✓, and nobody can buy a ticket. Coverage hints at it: two steps never ran. But coverage
only notices a step that never runs. It can't notice a step that runs and never does its job.
The spec is [`specs/05-properties/5-sells-nothing.ts`](specs/05-properties/5-sells-nothing.ts).

## Step 6: what must be possible

A safety property says what must never happen. A `reachable` property says what must be
able to happen: some world, on some path, where it's true.

```ts
const someoneGetsASeat = defineProperty("someoneGetsASeat", {
  description: "Someone can buy a ticket.",
  reachable: (w) => ticketsHeld(w).length > 0,
});
```

The check finds no such world:

```text
Box office: explored 132 states (1 of each actor, and from the end of 1 scenario(s)) in 46ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
  ✓ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
  ✗ someoneGetsASeat  Someone can buy a ticket.  never reached: no world within the bounds gets there, of the 132 explored
    A guard too strict, a step that can never run, or bounds too small for it: more instances, a bigger budget, a scenario that sets the stage.
```

A ✗ here has no counterexample, because nothing went wrong on any path. The checker
explored every world and none of them sells a seat. If the search had stopped early, at a
depth bound or the state limit, the verdict would be `~`: not reached yet, which is not the
same as never. The spec is [`specs/05-properties/6-can-anyone-buy.ts`](specs/05-properties/6-can-anyone-buy.ts).

Put the real database of step 4 back:

```text
Box office: explored 216 states (1 of each actor, and from the end of 1 scenario(s)) in 42ms
  ✓ oneOwnerPerSeat  No two people hold a ticket for the same seat.
  ✓ ticketsMatchTheBooks  Whoever holds a ticket is who the books say bought that seat.
  ✓ soldSeatsStaySold  Once a seat is sold, it stays sold to the same person.
  ✓ someoneGetsASeat  Someone can buy a ticket.  reached at the end of scenario "Both want A1"
```

The search starts from the initial world and from the end of each scenario (chapter 6).
"Both want A1" ends with Alice holding A1, so the checker got there in no steps at all.
Without a scenario, it says how many events the shortest way takes. `--only someoneGetsASeat`
prints the way, and `--as-scenario` writes it out as a scenario. The spec is
[`specs/05-properties/7-someone-gets-a-seat.ts`](specs/05-properties/7-someone-gets-a-seat.ts).

Write a `reachable` property for each thing the system is for: an order goes through, a
leader is elected, a payment settles. They're cheap, and they catch a spec, or a fix, that
keeps its promises by doing nothing. Alloy users know this as `run`, next to `check`.

## Writing good properties

- **Write the property before the fix.** If you write it after, you'll write the property
  your fix happens to satisfy.
- **Name what must not happen in the system's words.** "Two people hold a ticket for the same
  seat" is something the theatre's manager would recognise. `sold.size <= 2` is not.
- **Several sharp properties beat one broad one.** The one that breaks tells you what broke.
- **Prefer the earliest symptom.** A step property that catches the overwrite beats a state
  property that catches the angry customer.
- **Read your properties against the buggy design.** If a property holds there, it isn't
  checking what you think.
- **Say what must be possible, too.** A system that does nothing keeps every safety
  property. A `reachable` property for each thing it is for catches that.
- **Keep property-only state honest.** If a property needs history the system doesn't keep
  (what was promised, what was paid out), it's fine to add it to an actor's state, but say
  in a comment that only properties read it.

## Exercises

1. Write a property that catches the bug in step 2 at event 9 or earlier. (Hint: what is true
   of the `Reserve` messages in flight?)
2. Replace the database's conditional write with a check on the website: the website
   remembers which seats it has reserved, and refuses to reserve one twice. Does that fix it?
   What if there are two web servers?
3. `noMoreTicketsThanSeats` needed a third ticket to notice. Using `t.count` and `e.sent`,
   can you write a `never` property that notices at the second ticket for one seat?
4. Write a `reachable` property "both seats are sold". Now let each person buy once
   (`atMost(1)`). Is it reached with one person? With `--instances Person=2`? When it isn't,
   why is the verdict a ✗ and not a `~`?
