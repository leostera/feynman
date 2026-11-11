# 8. When the answer never comes

> *What if the request is lost? What if the reply is?*

Until now, every message arrived. Real networks lose messages, deliver them twice, and time out
on requests that actually succeeded. In Feynman none of that happens unless the spec says it
can. This chapter is about saying so: **faults** are steps the spec declares, from a small
library that ships with Feynman.

Why not just let everything fail? Because not everything does. A message on an open TCP
connection isn't lost on its own. A write to a database that returned isn't undone. A spec
that loses every message checks a system that doesn't exist, and buries the real findings
under impossible ones. So you declare the faults your system meets, and every verdict then
says which faults it covers.

## Step 1: a bank

People now pay with a card. When the box office gets a `Pay` from whoever holds the seat, it
asks the theatre's card processor, the bank, to charge the order. When the bank answers, the
box office sells the seat and sends the ticket.

A hold now opens an **order**, with a fresh id, so the bank knows what it's charging for:

```ts
/** The last seat, and the order a hold opens: a payment is for one order. */
type Seat = { kind: "free" } | { kind: "held"; by: string; order: string } | { kind: "paying"; by: string; order: string } | { kind: "sold"; to: string };

const Charge = defineMessage("Charge", { order: String }, { over: "https" });
const Charged = defineMessage("Charged", { order: String }, { tone: "reply" });
```

```ts
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free, and opens an order for it.",
      sends: [Held, Unavailable],
      starts: ["expire"],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id, order: ctx.fresh("order") };
        ctx.start("expire");
        ctx.reply(Held, {});
      },
    },
    pay: {
      on: Pay,
      description: "Charges the card of whoever holds the seat; anyone else's hold has expired.",
      sends: [Charge, Expired],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "held" || state.seat.by !== ctx.from.id) return ctx.reply(Expired, {});
        state.seat = { ...state.seat, kind: "paying" };
        ctx.cancel("expire");
        ctx.send(ctx.the(Bank), Charge, { order: state.seat.order });
      },
    },
    charged: {
      on: Charged,
      description: "The card was charged: sells the seat and sends the ticket.",
      sends: [Ticket],
      run(state, _msg, ctx) {
        if (state.seat.kind !== "paying") return; // a late answer for an order already settled
        const buyer = state.seat.by;
        state.seat = { kind: "sold", to: buyer };
        ctx.send({ id: buyer }, Ticket, {});
      },
    },
```

`ctx.fresh("order")` gives a new id, `order-1`, `order-2`, the same way on every run, so the
checker can replay it. Once a payment starts, the hold timer is cancelled: a seat being paid for
doesn't expire under the buyer.

The bank keeps a list of the charges it made, and only properties read it:

```ts
const bank = defineZone({ name: "Bank", description: "the card processor", place: { column: 2 } });

const Bank = defineActor({
  name: "Bank",
  description: "The card processor the theatre uses.",
  zone: bank,
  singleton: true,
  initialState: () => ({ charges: [] as string[] }),
  transitions: {
    charge: {
      on: Charge,
      description: "Charges the card for the order, and answers.",
      sends: [Charged],
      run(state, msg, ctx) {
        state.charges.push(msg.order);
        ctx.reply(Charged, msg);
      },
    },
  },
});

const chargedOnce = defineProperty("chargedOnce", {
  description: "No order is charged twice.",
  always: (w) => {
    const charges = w.the(Bank).state.charges;
    return new Set(charges).size === charges.length;
  },
});
```

([`specs/08-faults/1-a-bank.ts`](specs/08-faults/1-a-bank.ts))

```text
Box office: explored 554 states (1 of each actor, and from the end of 1 scenario(s) and the setup of 1) in 130ms
! no faults: every path has a perfect network and no crashes. Declare the ones the system meets, like lose(Debit) or crash().
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

Every check so far has printed that `! no faults` line. It's there to remind us what a `✓`
covers: a perfect network, and nothing ever crashing.

## Step 2: the network can lose a message

The box office talks to the bank over the internet. Either the request or the answer can be
lost. We say so in two steps, one on each side:

```ts
import { budget, lose } from "@leostera/feynman";

/** At most one fault on any path. `--set faults=2` raises it. */
const faults = budget("faults", 1);
```

```ts
const Bank = defineActor({
  // …
  transitions: {
    charge: { on: Charge, /* … */ },
    chargeLost: lose(Charge, { spend: faults }),
  },
});
```

```ts
const BoxOffice = defineActor({
  // …
  transitions: {
    // …
    chargedLost: lose(Charged, { spend: faults }),
  },
});
```

`lose(Message)` is a step on that message, in the actor that would receive it, which takes the
message and does nothing with it. It is an ordinary step: you could write it yourself. Like
every fault, it is **not fair**. The network *may* lose a message, but it doesn't have to, and
it may stop. So nothing in the spec can count on a loss happening.

A **budget** bounds how many faults may happen on one path. One fault per run finds most bugs
that faults cause, and keeps the search small. `--set faults=0` checks without faults, and
`--set faults=2` with two.

([`specs/08-faults/2-lost.ts`](specs/08-faults/2-lost.ts))

```text
Box office: explored 654 states (1 of each actor, and from the end of 1 scenario(s) and the setup of 1, faults=1) in 133ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
       1  Person (Person)  hold
       2  Box office (Box office)  hold the seat  {}  from Person
          seat.order: — → "order-1"
          ⏱ expire set
       3  Person (Person)  held  {}  from Box office
       4  Person (Person)  pay
       5  Box office (Box office)  pay  {}  from Person
          seat.kind: "held" → "paying"
          → Bank: charge {"order":"order-1"}
          ⏱ expire cancelled
       6  Bank (Bank)  charge → chargeLost  {"order":"order-1"}  from Box office
          Charge is lost on the way.
          @faults: 1 → 0
    The lost charge to Bank is never sent again, so Box office waits for an answer that cannot come.
    Model what the code does when none comes: if the code is told (an RPC or fetch that throws), define Charge with defineCall and handle its failure with a step on failed(Charge); otherwise a timer that retries. If it cannot be lost here, drop its lose step.
    If the code has no answer for it, that is a finding: report it, rather than weaken the property or call this world final.
```

The properties hold, but the system is **stuck**: the charge was lost, and the box office waits
for an answer that will never come. The person's phone says "paying" forever. The seat is
neither sold nor free.

Look at the advice under the trace. It's the question to ask the code: *what does it do when
no answer comes?* There are three possible answers:

1. **The code is told.** An HTTP request, an RPC or a `fetch` throws when it fails. The failure
   reaches the caller. That is a **call**, and we model it as one (step 3).
2. **The code isn't told, but it gives up.** A queue message with nobody waiting, a datagram,
   fire-and-forget. Then it needs a timer that retries or gives up (chapter 7).
3. **The code has no answer.** That's a finding. Report it. Don't weaken the property, and
   don't call the stuck world final.

## Step 3: calls, and retrying them

The box office talks to the bank with `fetch`. When the request fails, the `fetch` throws, and
the code's `catch` block tries again. So `Charge` is a call:

```ts
import { defineCall, failed } from "@leostera/feynman";

// A call: an HTTPS request whose failure the box office hears about, as a fetch throws.
const Charge = defineCall("Charge", { order: String }, { over: "https" });
```

`defineCall` makes a message, and a second message for its failure, `failed(Charge)`. The
caller handles it like any other message:

```ts
    chargeFailed: {
      on: failed(Charge),
      description: "The call to the bank failed: sends the same charge again.",
      sends: [Charge],
      run: (_state, failure, ctx) => ctx.send(failure.to, Charge, failure.payload),
    },
```

`failure.payload` is the payload of the call that failed, and `failure.to` is whom it was to.

Now, which losses fail the call? Losing the request does: `lose(Charge)` on a call sends its
failure back to the caller automatically. Losing the *answer* does too, in real code, because
`fetch` can't tell "my request never arrived" from "the response never came back". Both are a
timeout or a reset connection. We say so with `fails`:

```ts
    // A lost answer fails the call too: the bank did the work, and the box office cannot tell.
    chargedLost: lose(Charged, { fails: Charge, spend: faults }),
```

([`specs/08-faults/3-retry.ts`](specs/08-faults/3-retry.ts))

```text
Box office: explored 1,054 states (1 of each actor, and from the end of 1 scenario(s) and the setup of 1, faults=1) in 140ms
  ✗ chargedOnce  No order is charged twice.
    shortest counterexample, 9 event(s), needs 1 fault(s):
       1  Person (Person)  hold
       2  Box office (Box office)  hold the seat  {}  from Person
       3  Person (Person)  held  {}  from Box office
       4  Person (Person)  pay
       5  Box office (Box office)  pay  {}  from Person
          → Bank: charge {"order":"order-1"}
       6  Bank (Bank)  charge  {"order":"order-1"}  from Box office
          charges: [] → ["order-1"]
          → Box office: charged {"order":"order-1"}
       7  Box office (Box office)  charged → chargedLost  {"order":"order-1"}  from Bank
          Charged is lost on the way.
          @faults: 1 → 0
          → Box office: charge failed {"payload":{"order":"order-1"},"to":{"id":"bank"}}
       8  Box office (Box office)  charge failed  {"payload":{"order":"order-1"},"to":{"id":"bank"}}  from Bank
          The call to the bank failed: sends the same charge again.
          → Bank: charge {"order":"order-1"}
       9  Bank (Bank)  charge  {"order":"order-1"}  from Box office
          charges: ["order-1"] → ["order-1","order-1"]
          ✗ breaks chargedOnce
```

*The bank charges Alice's card and answers. The answer is lost. The box office's `fetch`
throws, so it charges again, and the bank does.* Alice is charged twice for one seat.

The checker says **it needs 1 fault**. It searched again with fewer and found no shorter way.
That matters when judging a finding. This bug doesn't happen on a good day. It happens when
one answer is lost, which over millions of payments means it happens every day.

This is the most common bug in distributed systems, and it isn't in any single line of code.
The retry is right: calls fail, and retrying is what you do. The bank is right: it charges when
asked. The bug is that a retry after a lost answer is a second request for the same thing, and
nobody said what the second one means.

## Step 4: an idempotency key

The fix is for the bank to recognise a repeat. The order id is already on every charge, and a
retry sends the same one. So the bank remembers the orders it has charged, and answers a repeat
without charging again. Real card processors offer exactly this, as an *idempotency key*:

```ts
  initialState: () => ({ charges: [] as string[], seen: new Set<string>() }),
```

```ts
    charge: {
      on: Charge,
      description: "Charges the card for the order, unless it has charged that order already, and answers.",
      sends: [Charged],
      run(state, msg, ctx) {
        if (!state.seen.has(msg.order)) {
          state.seen.add(msg.order);
          state.charges.push(msg.order);
        }
        ctx.reply(Charged, msg);
      },
    },
```

And the story becomes a scenario. `s.step(office, "chargedLost")` takes the fault step by name:
it loses the `Charged` in flight, right after the bank charges:

```ts
const answerLost = defineScenario("The bank's answer is lost", {
  description: "The bank charges Alice's card, but its answer is lost. The call fails, the box office charges again, and the bank recognises the order: one charge, and Alice gets her ticket.",
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
    s.step(office, "chargedLost");
    s.settle();
  },
});
```

```text
The bank's answer is lost
   1  Alice (Person)  hold
   2  Box office (Box office)  hold the seat  {}  from Alice
   3  Alice (Person)  held  {}  from Box office
   4  Alice (Person)  pay
   5  Box office (Box office)  pay  {}  from Alice
   6  Bank (Bank)  charge  {"order":"order-1"}  from Box office
      charges: [] → ["order-1"]
   7  Box office (Box office)  charged → chargedLost  {"order":"order-1"}  from Bank
   8  Box office (Box office)  charge failed  {"payload":{"order":"order-1"},"to":{"id":"bank"}}  from Bank
   9  Bank (Bank)  charge  {"order":"order-1"}  from Box office
  10  Box office (Box office)  charged  {"order":"order-1"}  from Bank
  11  Alice (Person)  ticket  {}  from Box office
```

([`specs/08-faults/4-idempotent.ts`](specs/08-faults/4-idempotent.ts))

```sh
feynman check specs/08-faults/4-idempotent.ts --brief
feynman check specs/08-faults/4-idempotent.ts --brief --set faults=2
```

```text
Box office: explored 945 states (1 of each actor, and from the end of 2 scenario(s) and the setup of 2, faults=1) in 116ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
Box office: explored 1,309 states (…, faults=2) in 112ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

Both hold, with one fault and with two.

## Step 5: duplicates

Networks also deliver a message twice: a load balancer retries on your behalf, a queue
redelivers after a timeout. `duplicate(Message)` says so:

```ts
    chargeLost: lose(Charge, { spend: faults }),
    chargeTwice: duplicate(Charge, { spend: faults }),
```

([`specs/08-faults/5-duplicates.ts`](specs/08-faults/5-duplicates.ts))

```text
Box office: explored 741 states (…, faults=2) in 143ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
```

The idempotency key covers it too, as it should: a duplicate and a retry look the same to the
bank. Without the key, the duplicate alone would charge twice with no lost message at all.

## The faults library

Everything in it is built from ordinary steps, and a fault it lacks is a step you write.

| Fault | Declared where | What it does |
| --- | --- | --- |
| `lose(M, { spend })` | the actor that would receive `M` | `M` is lost on the way. On a call, the caller gets `failed(M)`. |
| `lose(Reply, { fails: Call, spend })` | the caller | The answer is lost, and the call fails: the callee did the work, the caller can't tell. |
| `duplicate(M, { spend })` | the receiver | `M` arrives twice. |
| `crash({ keeps, spend })` | the actor that crashes | It restarts from its initial state, keeping only `keeps` (chapter 9). |
| `budget(name, n)` | the top of the file | At most `n` faults spending it on any path. `--set name=k` changes it. |
| `defineCall(id, schema)`, `failed(Call)` | messages | A message whose failure reaches the caller, and that failure. |
| `atMost(n)` | on an action, `with: [atMost(n)]` | Each instance takes the action at most `n` times on any path. |

Every fault step is unfair, tagged `fault`, and counted: each counterexample says how many it
needs, and whether a shorter one needs more.

How to choose what to declare:

- **Declare what your system really meets**, in the scope of the spec. HTTP calls between
  services: `lose` on the request and on the answer, with `fails`. A queue with at-least-once
  delivery: `duplicate`. A process that restarts: `crash`.
- **Don't declare what can't happen.** A message on one open WebSocket isn't lost on its own
  while the socket lives. A database's commit isn't undone after it returns.
- **Start with a budget of one.** Most fault bugs need one. Raise it when the system has
  defences that need two failures to beat, and check that they hold.
- **Read "needs N faults" before you file a finding.** "Needs no faults" means it happens in
  normal operation. "Needs 1 fault" on a rare path is a different priority from a bug every
  user can hit.

## Exercises

1. Take the idempotent spec and make the retry use a fresh order id (`ctx.fresh("order")`)
   instead of `failure.payload`. What breaks?
2. Remove `fails: Charge` from `chargedLost`. What does the checker report now, and what does
   it mean about the code?
3. The person's phone can lose the ticket. Add `lose(Ticket, { spend: faults })` to `Person`.
   What happens, and what should the phone do about it?
