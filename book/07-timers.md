# 7. When the timer fires first

> *What if the timeout fires before the answer arrives?*

Every real system waits for something: a reply, a payment, a person. And every real system
stops waiting at some point: a timeout, an expiry, a lease that runs out. This chapter is about
**timers**, and about the most important idea in how Feynman treats time: there is no clock.

## Holds

The theatre has one seat left, A1, and a problem. People pick it, type their card details for
three minutes, and find that someone else bought it while they typed. So the box office now
**holds** a seat for whoever picks it, and they pay afterwards:

1. a person asks to hold the seat; if it is free, the box office holds it for them;
2. the person pays; the box office sells them the seat and sends a ticket.

From here on, the website and its database are one actor, the box office. In chapter 5 the
website passed messages on and decided nothing: every decision was one conditional statement
in the database. A part of the system that decides nothing adds states without adding
behaviour, so we take it out. Chapters 12 and 13 have more on what to leave out.

## Step 1: holding, then paying

One seat means the box office's state is a single value with three cases:

```ts
// The last seat: one seat, and what the box office knows about it.
type Seat = { kind: "free" } | { kind: "held"; by: string } | { kind: "sold"; to: string };
```

```ts
const Hold = defineMessage("Hold", {}, { name: "hold the seat", over: "https" });
const Held = defineMessage("Held", {}, { tone: "reply" });
const Unavailable = defineMessage("Unavailable", {}, { tone: "refused" });
const Pay = defineMessage("Pay", {}, { over: "https" });
const Ticket = defineMessage("Ticket", {}, { tone: "reply" });
const Expired = defineMessage("Expired", {}, { name: "hold expired", tone: "refused" });
```

```ts
const BoxOffice = defineActor({
  name: "Box office",
  description: "The theatre's website and its database, deciding each request in one statement.",
  zone: theatre,
  singleton: true,
  initialState: () => ({ seat: { kind: "free" } as Seat }),
  transitions: {
    hold: {
      on: Hold,
      description: "Holds the seat, if it is free.",
      sends: [Held, Unavailable],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id };
        ctx.reply(Held, {});
      },
    },
    pay: {
      on: Pay,
      description: "Sells the seat to whoever pays, unless it is sold already.",
      sends: [Ticket, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind === "sold") return ctx.reply(Expired, {});
        state.seat = { kind: "sold", to: ctx.from.id };
        ctx.reply(Ticket, {});
      },
    },
  },
});
```

The person's phone goes through screens, and a single `phone` value says which one it is on:

```ts
type Phone = "browsing" | "holding" | "asking" | "paying" | "done";

const Person = defineActor({
  name: "Person",
  zone: people,
  symmetric: true,
  initialState: () => ({ phone: "browsing" as Phone, ticket: false }),
  actions: {
    hold: {
      with: [atMost(2)],
      label: "Hold the seat",
      description: "Asks the box office to hold the last seat.",
      when: (s) => s.phone === "browsing",
      sends: [Hold],
      run(state, _inputs, ctx) {
        state.phone = "asking";
        ctx.send(ctx.the(BoxOffice), Hold, {});
      },
    },
    pay: {
      label: "Pay",
      description: "Pays for the seat on hold.",
      when: (s) => s.phone === "holding",
      sends: [Pay],
      run(state, _inputs, ctx) {
        state.phone = "paying";
        ctx.send(ctx.the(BoxOffice), Pay, {});
      },
    },
  },
  transitions: {
    held: { on: Held, description: "Sees the seat is held for them.", run: (s) => void (s.phone = "holding") },
    unavailable: { on: Unavailable, description: "Sees someone else has the seat.", run: (s) => void (s.phone = "browsing") },
    ticket: {
      on: Ticket,
      description: "Gets the ticket.",
      run(s) {
        s.ticket = true;
        s.phone = "done";
      },
    },
    expired: { on: Expired, description: "Hears the seat went to someone else.", run: (s) => void (s.phone = "browsing") },
  },
});
```

`pay` has no `atMost`: it is offered only while the phone shows a hold, and each hold allows at
most one payment. Only actions that could repeat forever need a bound.

Two properties. The theatre's promise, and the old one about tickets:

```ts
const holdsAreRespected = defineProperty("holdsAreRespected", {
  description: "A seat held for one person is never sold to another.",
  everyStep: (before, after) => {
    const was = before.the(BoxOffice).state.seat;
    const now = after.the(BoxOffice).state.seat;
    return !(was.kind === "held" && now.kind === "sold" && now.to !== was.by);
  },
});

const oneTicket = defineProperty("oneTicket", {
  description: "At most one person has a ticket for the last seat.",
  always: (w) => w.all(Person).filter((p) => p.state.ticket).length <= 1,
});
```

And a scenario, whose setup brings in Alice and Bob, so every check has two people:

```ts
const aliceBuys = defineScenario("Alice buys the last seat", {
  description: "Alice holds the seat, pays in time, and gets the ticket.",
  setup(w) {
    w.spawn(Person, "Alice");
    w.spawn(Person, "Bob");
  },
  run(s) {
    const alice = s.all(Person).find((p) => p.label === "Alice")!;
    s.act(alice, "hold");
    s.settle({ until: (w) => w.all(Person).some((p) => p.state.phone === "holding") });
    s.act(alice, "pay");
    s.settle();
  },
});
```

([`specs/07-timers/1-holds.ts`](specs/07-timers/1-holds.ts))

```text
Box office: explored 45 states (1 of each actor, and from the end of 1 scenario(s) and the setup of 1, depth 14) in 80ms
  ✓ holdsAreRespected  A seat held for one person is never sold to another.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  never ran: Person.expired
```

Both hold, and `Person.expired` never ran: once a seat is held, nobody else can get it, so
nobody's payment ever finds it sold. That is also the problem. Alice holds the seat, closes her
phone, and the last seat is gone for good. A hold has to end.

## Step 2: holds that expire

The box office lets a hold go after ten minutes. In code, that is a `setTimeout`, a job
scheduled for later, or a row with an `expires_at` that a sweeper clears. In a spec, it is a
timer:

```ts
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free.",
      sends: [Held, Unavailable],
      starts: ["expire"],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id };
        ctx.start("expire");
        ctx.reply(Held, {});
      },
    },
```

```ts
    expire: {
      description: "The hold runs out, and the seat is free again.",
      after: "10 minutes",
      run(state) {
        if (state.seat.kind === "held") state.seat = { kind: "free" };
      },
    },
```

And `pay` cancels it, with `ctx.cancel("expire")`, when it sells the seat.

A timer is a step with no `on`, named like the timer. `ctx.start("expire")` sets it, and
`starts: ["expire"]` declares that the step may. From that moment on, **the timer may fire at
any moment**: before anything else pending, or after all of it. `ctx.cancel` unsets it.
Setting it again replaces it.

`after: "10 minutes"` does nothing to when it fires. It is for readers, and the timeline shows
it. To record the number itself, as the code has it, declare a limit:

```ts
const holdLifetime = defineLimit({ name: "Hold lifetime", value: 10, unit: "minutes" });
```

and list it in `defineSpec({ limits: [holdLifetime] })`. Limits document the system. They
don't run.

([`specs/07-timers/2-expiry.ts`](specs/07-timers/2-expiry.ts))

```text
  ✗ holdsAreRespected  A seat held for one person is never sold to another.
    shortest counterexample, 8 event(s), needs no faults, from the setup of scenario "Alice buys the last seat":
       1  Alice (Person)  hold
          → Box office: hold the seat {}
       2  Bob (Person)  hold
          → Box office: hold the seat {}
       3  Box office (Box office)  hold the seat  {}  from Alice
          seat.kind: "free" → "held"
          seat.by: — → "person-alice"
          → Alice: held {}
          ⏱ expire set
       4  Alice (Person)  held  {}  from Box office
          phone: "asking" → "holding"
       5  Alice (Person)  pay
          phone: "holding" → "paying"
          → Box office: pay {}
       6  Box office (Box office)  expire
          seat.kind: "held" → "free"
          seat.by: "person-alice" → —
       7  Box office (Box office)  hold the seat  {}  from Bob
          seat.kind: "free" → "held"
          seat.by: — → "person-bob"
          → Bob: held {}
          ⏱ expire set
       8  Box office (Box office)  pay  {}  from Alice
          seat.kind: "held" → "sold"
          seat.by: "person-bob" → —
          seat.to: — → "person-alice"
          → Alice: ticket {}
          ⏱ expire cancelled
```

The story: *Alice holds the seat and pays. Her payment is slow, and her hold expires before it
arrives. Bob's request to hold the seat was already waiting; it gets the seat. Then Alice's
payment arrives, and the box office sells her the seat Bob is holding.* Bob's phone says the
seat is his for ten minutes. It isn't.

Notice event 5. Alice paid *before* the hold expired. Nothing in the spec says how long a
payment takes, and nothing should: a phone on a train, a card processor having a bad minute, a
garbage-collection pause on the server. Any of them puts ten minutes between "pay" and the
payment arriving.

## There is no clock

This is the most important idea in this chapter. Feynman specs have no time. There is no
`ctx.now`, no latency, and no duration. A run is an order of events, and a timer that is set
may fire before or after anything else that is pending.

That may feel too pessimistic. Surely ten minutes is long enough to pay? Usually it is. But
"usually" is exactly where the bugs hide:

- If the spec knew a payment takes at most a minute, the checker would never try a slow one,
  and this bug would be invisible. It would still happen in production, on the bad day.
- A spec with durations would have to say how long everything takes, and every number would
  be a guess.
- Without a clock, two worlds that differ only in when they are merge into one, and the
  checker explores far fewer states.

So the checker treats "the timer fires before the reply arrives" as always possible, because in
a real system it always is. If a counterexample depends on a timer firing early, ask what
happens in the real system when that one call is slow. That is almost always a real risk.

Three rules of thumb follow from it:

- **An expiry is a timer that flips state**, never a stored time compared with a clock. "The
  hold expired" is `seat = { kind: "free" }` in a timer step, not `expiresAt < now`.
- **When an ordering really depends on durations**, say a heartbeat every second that always
  beats a 30-second lease on the same machine, model the guarantee with state, and say in a
  comment that it rests on timing. Better still, ask whether it really always holds.
- **Scenarios pick the order.** `s.fire(office, "expire")` fires the timer now, ahead of what is
  in flight. `s.settle()` fires timers only once no message is in flight, oldest first. So
  settling never makes a timeout fire early, and a scenario that wants it to must say so.

## Step 3: a payment pays for one hold

The box office sold the seat to "whoever pays". It should sell it only to whoever holds it:

```ts
    pay: {
      on: Pay,
      description: "Sells the seat to whoever holds it; anyone else's hold has expired.",
      sends: [Ticket, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "held" || state.seat.by !== ctx.from.id) return ctx.reply(Expired, {});
        state.seat = { kind: "sold", to: ctx.from.id };
        ctx.cancel("expire");
        ctx.reply(Ticket, {});
      },
    },
```

And the counterexample becomes a scenario, so the story stays in the spec:

```ts
const tooLate = defineScenario("Alice pays too late", {
  description: "Alice holds the seat and pays, but her hold expires before the payment arrives. Bob holds the seat; Alice hears her hold expired. Bob never pays, so his hold runs out too.",
  setup(w) {
    w.spawn(Person, "Alice");
    w.spawn(Person, "Bob");
  },
  run(s) {
    const office = s.the(BoxOffice);
    const [alice, bob] = ["Alice", "Bob"].map((label) => s.all(Person).find((p) => p.label === label)!);
    s.act(alice!, "hold");
    s.settle({ until: (w) => w.all(Person).some((p) => p.state.phone === "holding") });
    s.act(alice!, "pay");
    s.fire(office, "expire"); // ten minutes pass before the payment arrives
    s.act(bob!, "hold");
    s.deliver(office, Hold);
    s.settle();
  },
});
```

```text
Alice pays too late
   1  Alice (Person)  hold
   2  Box office (Box office)  hold the seat  {}  from Alice
      ⏱ expire set
   3  Alice (Person)  held  {}  from Box office
   4  Alice (Person)  pay
   5  Box office (Box office)  expire
   6  Bob (Person)  hold
   7  Box office (Box office)  hold the seat  {}  from Bob
      ⏱ expire set
   8  Box office (Box office)  pay  {}  from Alice
   9  Bob (Person)  held  {}  from Box office
  10  Alice (Person)  hold expired  {}  from Box office
  11  Box office (Box office)  expire
```

Event 11 is `settle()` at work: once nothing was in flight, Bob's hold timer fired, because
Bob never paid. Left alone, every timer eventually fires.

```text
Box office: explored 266 states (1 of each actor, and from the end of 2 scenario(s) and the setup of 2, depth 14) in 142ms
  ✓ holdsAreRespected  A seat held for one person is never sold to another.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

([`specs/07-timers/3-fixed.ts`](specs/07-timers/3-fixed.ts))

Is it right that Alice paid and got nothing? She hasn't been charged yet: there's no card
processor in the spec. Next chapter there is, and "paid and got nothing" becomes a question of
money.

## Guarded steps

Timers are one kind of step on no message. The other is a **guarded step**: a step with a
`when` and no `on`, which may run whenever its guard holds. We met one in chapter 2's lamp.
Use them for things a process does by itself, as soon as it can:

```ts
    sweep: {
      description: "Clears a hold whose time is up.",
      when: (s) => s.seat.kind === "held",
      run: (s) => void (s.seat = { kind: "free" }),
    },
```

A guard that stays true eventually runs, unless it says `fair: false` (chapter 10). That
makes guarded steps the way to chain the stages of one process: "download, then transcribe,
then analyse" are three steps of one actor, each guarded on the state the one before left.
They are not three messages, because nothing crosses a process boundary.

Which one to use:

| The code… | Model it as |
| --- | --- |
| sets a timeout, schedules a job, has a TTL | a timer: `ctx.start`, a step named like it |
| polls, sweeps, retries in a loop, or runs the next stage when the last is done | a guarded step: `when` |
| reacts to a request, an event, a callback | a step `on` a message |

## Exercises

1. In step 2, `pay` cancels the timer. Remove `ctx.cancel("expire")` from the fixed spec. What
   breaks, and how long is the counterexample?
2. Replace the timer with the guarded `sweep` step above. Do the verdicts change? What is
   different about a sweep that runs "whenever a seat is held"?
3. Add a `release` action: the person lets the hold go. What must `release` do about the timer?
   What should the box office answer to a `Pay` after a release?
