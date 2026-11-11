# 9. When it restarts right here

> *What does it remember, and what does it forget?*

Processes restart. They're deployed, they run out of memory, the machine under them is moved.
When a process comes back, it has whatever it wrote somewhere durable, and nothing else: no
variables, no timers, no `await` it was in the middle of. The bugs live in the difference
between what the code thinks it remembers and what it actually wrote down.

## Step 1: a restart that forgets everything

`crash()` is a fault, like `lose`. Declared in an actor, it lets that actor restart at any
moment, within the budget:

```ts
    crash: crash({ spend: faults }),
```

A crash puts the instance back to its `initialState`, cancels its timers, and drops any call
failures on their way to it (the code that would have caught them is gone). The calls it had
made are orphaned for the same reason: if one is lost after the crash, or its answer is, no
failure comes back, because nobody is waiting for one. Messages in flight to it stay in
flight. The network doesn't know it restarted.

([`specs/09-restarts/1-forgets.ts`](specs/09-restarts/1-forgets.ts))

```text
Box office: explored 2,520 states (1 of each actor, and from the end of 2 scenario(s) and the setup of 2, faults=1) in 144ms
  ✓ chargedOnce  No order is charged twice.
  ✗ oneTicket  At most one person has a ticket for the last seat.
    shortest counterexample, 9 event(s), needs 1 fault(s), from the end of scenario "Alice buys the last seat":
       1  Bob (Person)  hold
          → Box office: hold the seat {}
       2  Box office (Box office)  crash
          seat.kind: "sold" → "free"
          seat.to: "person-alice" → —
       3  Box office (Box office)  hold the seat  {}  from Bob
          seat.kind: "free" → "held"
          seat.by: — → "person-bob"
       …
       8  Box office (Box office)  charged  {"order":"order-2"}  from Bank
          seat.kind: "paying" → "sold"
          seat.to: — → "person-bob"
       9  Bob (Person)  ticket  {}  from Box office
          ticket: false → true
          ✗ breaks oneTicket
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       …
       5  Box office (Box office)  pay  {}  from Person
          seat.kind: "held" → "paying"
       6  Box office (Box office)  crash
          seat.kind: "paying" → "free"
       7  Bank (Bank)  charge  {"order":"order-1"}  from Box office
       8  Box office (Box office)  charged  {"order":"order-1"}  from Bank
```

Two findings, each from one restart:

- **It forgets a sale.** From where Alice bought the seat, the box office restarts, the seat is
  "free", and Bob buys it. Two tickets.
- **It forgets a payment.** The box office restarts while the bank is charging. The bank's
  answer arrives at a process that has no idea what it's for, and is ignored. The person's
  phone says "paying" forever, and their card is charged.

Of course a box office keeps its seats in a database. Until we said so, the spec didn't know
that.

## Step 2: what's on disk

`keeps` names the fields that survive a restart: whatever the code writes to disk, a database,
durable storage. Here the seat (who holds it, the order, whether it's sold) is a row in the
database. Everything else is in memory.

```ts
    // The process restarts; the database keeps the seat, and memory and timers are gone.
    crash: crash({ keeps: ["seat"], spend: faults }),
```

([`specs/09-restarts/2-keeps.ts`](specs/09-restarts/2-keeps.ts))

```text
Box office: explored 849 states (…, faults=1) in 132ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

Both findings are gone with one fault. Now give the checker two:

```sh
feynman check specs/09-restarts/2-keeps.ts --set faults=2
```

```text
Box office: explored 4,655 states (…, faults=2) in 120ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       1  Person (Person)  hold
       2  Box office (Box office)  hold the seat  {}  from Person
          seat.kind: "free" → "held"
       3  Person (Person)  held  {}  from Box office
       4  Person (Person)  pay
       5  Box office (Box office)  pay  {}  from Person
          seat.kind: "held" → "paying"
       6  Box office (Box office)  crash
          @faults: 2 → 1
       7  Bank (Bank)  charge → chargeLost  {"order":"order-1"}  from Box office
          @faults: 1 → 0
```

*The box office restarts while its charge is on the way to the bank. Then the charge is
lost.* The failure would have gone to a `catch` block that no longer exists. After the restart, the database says the
seat is being paid for, and nothing in the process is paying for it. The retry lived in memory.

This is the general shape of restart bugs. **A process that crashes between two steps must be
able to tell, from what it kept, what it was doing.** Here the database says "paying", and the
code needs to do something with that.

## Step 3: resuming

When the box office comes back, it looks for payments in progress that it isn't calling the
bank about, and calls again. Calling again is safe for exactly the reason chapter 8 made it
safe: the order id is an idempotency key.

To know whether it's calling the bank, the process keeps a flag. The flag lives in memory, so a
restart clears it:

```ts
  // `calling`: whether this process is waiting on the bank. It lives in memory, so a restart
  // forgets it, and `resume` sees a payment nobody is calling the bank about.
  initialState: () => ({ seat: { kind: "free" } as Seat, calling: false }),
```

`pay` sets it and `charged` clears it. Then a guarded step does the rest:

```ts
    resume: {
      description: "After a restart, charges again for a payment the database says is in progress.",
      when: (s) => s.seat.kind === "paying" && !s.calling,
      sends: [Charge],
      run(state, _, ctx) {
        if (state.seat.kind !== "paying") return;
        state.calling = true;
        ctx.send(ctx.the(Bank), Charge, { order: state.seat.order });
      },
    },
```

In code, this is the startup job that scans for rows stuck in `paying`. In the spec it's a
guarded step: it runs whenever its guard holds, and the guard can only hold after a restart.

The scenario shows the moment. `s.settle({ until })` runs until the bank has charged, and
`s.step(office, "crash")` restarts the box office right then:

```ts
const restartMidPayment = defineScenario("A restart mid-payment", {
  description: "Alice pays; the box office restarts while the bank is charging. It finds the payment in the database, charges again, and the bank recognises the order: one charge, and Alice gets her ticket.",
  setup(w) {
    w.spawn(Person, "Alice");
  },
  run(s) {
    const office = s.the(BoxOffice);
    const alice = s.the(Person);
    s.act(alice, "hold");
    s.settle({ until: (w) => w.the(Person).state.phone === "holding" });
    s.act(alice, "pay");
    s.settle({ until: (w) => w.the(Bank).state.charges.length === 1 });
    s.step(office, "crash");
    s.settle();
  },
});
```

```text
A restart mid-payment
   1  Alice (Person)  hold
   2  Box office (Box office)  hold the seat  {}  from Alice
   3  Alice (Person)  held  {}  from Box office
   4  Alice (Person)  pay
   5  Box office (Box office)  pay  {}  from Alice
      calling: false → true
   6  Bank (Bank)  charge  {"order":"order-1"}  from Box office
      charges: [] → ["order-1"]
   7  Box office (Box office)  crash
      calling: true → false
   8  Box office (Box office)  resume
      calling: false → true
   9  Box office (Box office)  charged  {"order":"order-1"}  from Bank
      calling: true → false
  10  Bank (Bank)  charge  {"order":"order-1"}  from Box office
  11  Alice (Person)  ticket  {}  from Box office
  12  Box office (Box office)  charged  {"order":"order-1"}  from Bank
```

Read it closely, because a lot happens. The bank's first answer (event 9) was already in flight
when the box office restarted, and it still arrived. That sold the seat. The resumed charge
(event 10) reached the bank anyway, and the bank recognised the order and didn't charge again.
Its answer (event 12) arrived for an order already settled, and was ignored. One charge, one
ticket, two calls to the bank, and every one of them was necessary for some order of events.

([`specs/09-restarts/3-resume.ts`](specs/09-restarts/3-resume.ts))

```text
Box office: explored 943 states (…, faults=1) in 122ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
Box office: explored 2,003 states (…, faults=2) in 137ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

Nothing stuck, with two faults.

## What a restart takes away

When you declare `crash`, go through the actor's state and ask of every field: *is this on
disk?* The usual answers:

| Kept (`keeps`) | Lost |
| --- | --- |
| rows in a database the process writes to | variables, caches, in-memory queues |
| files it has flushed | buffers it hasn't |
| Durable Object storage | a Durable Object's in-memory fields |
| messages in a durable queue | promises it was awaiting, `catch` blocks, retries in progress |
| | timers: `setTimeout`, intervals, scheduled callbacks that aren't persisted |

Timers deserve a second look. A hold's expiry was a `setTimeout` in the box office. A restart
cancels it, and now nothing will ever free that seat, unless its holder pays. That isn't a
safety bug: no property breaks. It's a different kind of wrong, something that should
eventually happen and never does. That's the next chapter.

## Exercises

1. Keep `seat` but forget to clear `calling` in `charged`. What happens? Is it a safety problem
   or a progress problem?
2. Move `seat` out of `keeps` again, and keep the bank's idempotency. Which finding from step 1
   remains, and why doesn't the idempotency key help with it?
3. Give the bank a `crash` too. What should it keep? What happens if it forgets `seen`?
