# 15. My agent found a bug. Is it real?

> *Is the spec wrong, or the system?*

More and more specs will be written by agents. An agent reads the code, writes the spec, runs
the check, and comes back with three counterexamples. Some are bugs. Some are the spec getting
the code wrong. This chapter is about telling them apart, with a real case: an agent's spec of
the box office code from chapter 13.

## The agent's findings

The agent read `book/code/box-office` and wrote
[`specs/15-triage/1-the-agents-draft.ts`](specs/15-triage/1-the-agents-draft.ts). Every step has
sources, the sources resolve, and the check says:

```text
Box office: explored 55,144 states (1 of each actor, …, faults=2) in 719ms
  ✗ oneTicket  At most one person has a ticket for the last seat.
    shortest counterexample, 18 event(s), needs no faults, from the setup of scenario "Alice buys the last seat"
  ✗ holdsAreKept  A hold is never handed to someone else while it lasts.
    shortest counterexample, 6 event(s), needs no faults, from the setup of scenario "Alice buys the last seat"
  ✗ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
    shortest counterexample, 13 event(s), needs no faults, from the setup of scenario "Alice buys the last seat"
```

Two tickets for one seat, with no faults at all: that would be a serious bug. Before anyone files
it, triage.

## Start with the shortest

Findings often share a cause, and the shortest counterexample shows it most plainly. Here that's
`holdsAreKept`, in six events:

```text
  ✗ holdsAreKept  A hold is never handed to someone else while it lasts.
    shortest counterexample, 6 event(s), needs no faults, from the setup of scenario "Alice buys the last seat":
       1  Alice (Person)  hold
       2  Bob (Person)  hold
       3  Box office (Box office)  hold the seat  {}  from Alice
          Looks the seat up, and if it is free, goes on to claim it.
          → Box office: claim {"by":"person-alice"}
       4  Box office (Box office)  hold the seat  {}  from Bob
          Looks the seat up, and if it is free, goes on to claim it.
          → Box office: claim {"by":"person-bob"}
       5  Box office (Box office)  claim  {"by":"person-alice"}  from Box office
          Holds the seat for ten minutes, and opens an order for it.
          seat.kind: "free" → "held"
          seat.by: — → "person-alice"
       6  Box office (Box office)  claim  {"by":"person-bob"}  from Box office
          Holds the seat for ten minutes, and opens an order for it.
          seat.by: "person-alice" → "person-bob"
```

**Retell it in words.** *Alice and Bob both ask for the seat. The box office looks it up for
each, and it's free both times. Then it holds it for Alice, then for Bob, over Alice's hold.*
That's chapter 5's race, the one every book on concurrency starts with.

**Now check each step against its sources.** The agent's spec:

```ts
    hold: {
      on: Hold,
      description: "Looks the seat up, and if it is free, goes on to claim it.",
      sources: ["book/code/box-office/src/server.ts#handleHold", "book/code/box-office/src/db.ts:9-10"],
      // …
        ctx.send(ctx.self, Claim, { by: ctx.from.id });
    },
    claim: {
      on: Claim,
      description: "Holds the seat for ten minutes, and opens an order for it.",
      sources: ["book/code/box-office/src/db.ts:9-10"],
      // …
    },
```

Both steps point at the same two lines of `db.ts`:

```ts
  /** `UPDATE seats SET state = 'held', … WHERE seat = $1 AND state = 'free' RETURNING *`. */
  holdIfFree(seat: string, holder: string, order: string, expiresAt: Date): Promise<SeatRow | null>;
```

One conditional `UPDATE`. The database looks the seat up and holds it in one statement. Nothing
can come between the two, but the spec put a message between them, and anything can come
between a message and its delivery. **The spec does something the code can't.** That's a spec
mistake.

This is the most common one, in both directions: a step that splits what the code does
atomically (this one), and a step that joins what the code does in stages, across an `await`.
Chapter 13's rule covers both. A step ends exactly where the code waits for another process.

Fix the spec. Holding is one step, as in chapter 5
([`specs/15-triage/2-one-statement.ts`](specs/15-triage/2-one-statement.ts)):

```ts
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free, and opens an order for it.",
      sources: ["book/code/box-office/src/server.ts#handleHold", "book/code/box-office/src/db.ts:9-10"],
      sends: [Held, Unavailable],
      starts: ["expire"],
      run(state, _msg, ctx) {
        // One conditional UPDATE: looking the seat up and holding it are one step.
        if (state.seat.kind !== "free") return ctx.reply(Unavailable, {});
        state.seat = { kind: "held", by: ctx.from.id, order: ctx.fresh("order") };
        // …
      },
    },
```

```text
Box office: explored 13,661 states (1 of each actor, …, faults=2) in 355ms
  ✗ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
    shortest counterexample, 8 event(s), needs 1 fault(s)
```

`holdsAreKept` holds now, and so does `oneTicket`. The two tickets were the same mistake, 18
events later. And `paymentsEnd` changed: it needed no faults before (another consequence of the
split), and now needs one.

## The second finding

```text
  ✗ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
    shortest counterexample, 8 event(s), needs 1 fault(s):
       1  Person (Person)  hold
       2  Box office (Box office)  hold the seat  {}  from Person
       3  Person (Person)  held  {}  from Box office
       4  Person (Person)  pay
       5  Box office (Box office)  pay  {}  from Person
          seat.kind: "held" → "paying"
          answering: null → "person-person"
          → Bank: charge {"order":"order-1"}
       6  Box office (Box office)  crash
          answering: "person-person" → null
       7  Bank (Bank)  charge  {"order":"order-1"}  from Box office
          charges: [] → ["order-1"]
       8  Box office (Box office)  charged  {"order":"order-1"}  from Bank
          seat.kind: "paying" → "sold"
    then nothing fair can happen: it stays there forever, and never holds
```

*Alice pays. While the bank is charging her card, the server restarts. The bank charges her, the
seat is sold to her, and her phone never hears.*

Step by step, against the code:

- **Step 5**, `pay`, points at `server.ts:19-23`: `handlePay` up to
  `await chargeUntilAnswered`. The agent modelled the open HTTP request as `answering`, in
  memory. That's right: the request is a socket held by this process.
- **Step 6**, `crash`. Does the server restart? Every deploy restarts it. Memory goes, the
  database stays. `answering` is in memory: right.
- **Step 7**, the bank charges. Right: the charge was already on its way.
- **Step 8**, `charged`, points at `server.ts:24`. **Here's a doubt.** In the code, the bank's
  answer is the response to an HTTPS request the *old* process made. The restarted process
  never sees it. The spec lets it arrive anyway.

A doubt about one step doesn't mean the finding is false. It means the spec is wrong about that
step. Does the finding survive when it's fixed? Fix it and check again
([`specs/15-triage/3-a-faithful-restart.ts`](specs/15-triage/3-a-faithful-restart.ts)):

```ts
    charged: {
      // …
      run(state, _msg, ctx) {
        if (state.seat.kind !== "paying") return; // a late answer for an order already settled
        // The answer to a request made before a restart: the code that awaited it is gone.
        if (!state.calling) return;
```

```text
  ✗ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
    shortest counterexample, 11 event(s), needs 1 fault(s):
       …
       5  Box office (Box office)  pay  {}  from Person
       6  Box office (Box office)  crash
       7  Box office (Box office)  resume
          After a restart, charges again for a payment the database says is in progress.
       8  Bank (Bank)  charge  {"order":"order-1"}  from Box office
       9  Bank (Bank)  charge  {"order":"order-1"}  from Box office
      10  Box office (Box office)  charged  {"order":"order-1"}  from Bank
          seat.kind: "paying" → "sold"
      11  Box office (Box office)  charged  {"order":"order-1"}  from Bank
    then nothing fair can happen: it stays there forever, and never holds
```

Same ending, by a longer road: after the restart, `onStartup` resumes the payment, the bank
recognises the order, and the seat is sold. And still nobody tells Alice. `resumePayment` in
the code:

```ts
export async function resumePayment(db: Db, order: string): Promise<void> {
  await chargeUntilAnswered(order);
  await db.markSold(SEAT, order);
}
```

It marks the seat sold and returns. The ticket only ever travelled as the response to
`/pay`, and that response died with the old process. Alice was charged, the seat is hers, and her
phone shows an error. She tries again, finds the seat sold out, and calls the theatre.

**The code really does this.** That's a finding.

## How likely is it?

Before writing a test or filing an issue, judge it:

- **Faults needed: one.** A restart while a payment is in flight. Every deploy restarts every
  server, and a payment takes a second or two. On a busy night, it will happen.
- **Outcome:** a customer charged with no ticket, and a support call. Not data loss, since the
  database knows who bought the seat, but money taken with nothing to show for it.
- **Evidence:** this is where you look at production. Restarts during `/pay`, `paying` rows
  resumed by `onStartup`, support tickets saying "charged but no ticket". With evidence, it's a
  bug report. Without it, it's still worth a regression test.

A finding that needs three faults in a row on a path nobody takes is a different finding from
one that needs none. The checker always says which.

## Keeping it, and fixing it

Until it's fixed, mark the property `known`, so check reports it without failing on it:

```ts
const paymentsEnd = defineProperty("paymentsEnd", {
  description: "Whoever pays eventually hears back: a ticket, or that their hold expired.",
  known: "BOX-7: a restart during /pay loses the ticket",
  // …
});
```

And keep the story as a flow. `--as-scenario` writes it out:

```sh
feynman check specs/15-triage/3-a-faithful-restart.ts --only paymentsEnd --as-scenario
```

```ts
const paymentsEndIsBroken = defineScenario("paymentsEnd is broken", {
  description: "Whoever pays eventually hears back: a ticket, or that their hold expired.",
  run(s) {
    const boxOffice = s.the(BoxOffice);
    const bank = s.the(Bank);
    const person = s.spawn(Person, "Person");
    s.act(person, "hold");
    s.deliver(boxOffice, Hold); // from person
    s.deliver(person, Held); // from boxOffice
    s.act(person, "pay");
    s.deliver(boxOffice, Pay); // from person
    s.step(boxOffice, "crash");
    s.step(boxOffice, "resume");
    s.deliver(bank, Charge); // from boxOffice
    s.deliver(bank, Charge); // from boxOffice
    s.deliver(boxOffice, Charged); // from bank
    s.deliver(boxOffice, Charged); // from bank
    // From here nothing fair can happen: it stays here forever, and never gets there.
    // paymentsEnd is broken here: Whoever pays eventually hears back: a ticket, or that their hold expired.
  },
});
```

It's also the outline of a regression test in the system's own test suite: start a payment,
restart the server before the bank answers, and assert the buyer gets the ticket.

The fix: the ticket goes to the buyer the database names, by email, not only back down the
request that asked. In the spec, a rule
([`specs/15-triage/4-email-the-ticket.ts`](specs/15-triage/4-email-the-ticket.ts)):

```ts
const emailTickets = defineRule("emailTickets", { description: "The ticket is emailed to the buyer the database names, not only returned to the request." });
```

```ts
        // Without the rule, the ticket is only the answer to the phone's request, which only
        // this process holds. With it, it goes to the buyer the database names.
        const to = emailTickets.on ? state.seat.to : state.answering;
        if (to) ctx.send({ id: to }, Ticket, {});
```

```ts
const paymentsEnd = defineProperty("paymentsEnd", {
  description: "Whoever pays eventually hears back: a ticket, or that their hold expired.",
  needs: [resumePayments, emailTickets],
  // …
});
```

The scenario, renamed and tidied, stays as a flow, with a description that says what now
happens:

```ts
const restartMidPayment = defineScenario("A restart mid-payment", {
  description: "Alice pays, and the box office restarts before the bank is called. It resumes the payment, the bank charges once, and Alice gets her ticket by email: the request she sent died with the old process.",
  run(s) {
    // …
    s.step(boxOffice, "crash");
    s.step(boxOffice, "resume");
    s.settle();
  },
});
```

```text
    ✓ resumePayments    needed: without it, paymentsEnd breaks (8 events)
    ✓ emailTickets      needed: without it, paymentsEnd breaks (11 events)
```

Then fix the code: `markSold` returns the buyer, and both `handlePay` and `resumePayment` email
the ticket. Point the `charged` and `resume` steps at the new lines, and `feynman lock`.

## The other way round: a `✓` that lies

Look back at chapter 13. Its spec of this same code said every property held. Its `charged` step:

```ts
        const buyer = state.seat.by;
        state.calling = false;
        state.seat = { kind: "sold", to: buyer };
        ctx.send({ id: buyer }, Ticket, {});
```

The ticket goes straight to the buyer, from anywhere, whenever the seat is sold. That's how
Part I designed the box office, and it's what the fix does. But it's not what chapter 13's code
does. That spec was **kinder than the code**, and it hid a bug for a whole chapter. (Chapter 13's
second exercise asked about it.)

A `✓` is a statement about the spec. It's only a statement about the system as far as each step
is true to its code. So triage passing verdicts too:

- **Read each step against its sources**, especially the ones that send: to whom, and how does
  the code know who? An id from the database survives a restart. A socket in memory doesn't.
- **Faults the system meets and the spec doesn't declare.** Every network message can be lost.
  Every process restarts. If `check` says *"no faults: every path has a perfect network and no
  crashes"*, believe it.
- **"never ran" and `?`.** Steps nothing reached, and properties nothing tested, prove nothing.
- **Rules that aren't needed.** `✗ rule  not needed by …` means the safeguard prevents nothing the
  properties can see. Either the safeguard is useless, or a property is missing.
- **State the code keeps that the spec doesn't.** Each field the spec leaves out is a claim that
  it decides nothing. Is it true?

## The three kinds

Every counterexample is one of three:

| Kind | What it means | What to do |
| --- | --- | --- |
| **A spec mistake** | the spec does something the code can't | fix the spec, check again |
| **Intended** | the code means to do this, and the property asked too much | say what the code does guarantee, and show the behaviour in a scenario that says it's intended |
| **A finding** | the code does this, and shouldn't | judge how likely it is; report it; `known` until it's fixed; a rule once it is |

Never weaken a property to make a finding go away. And never call something a spec mistake
without pointing at the line of code that rules it out.

## A checklist for an agent's spec

When an agent hands you a spec and its findings:

1. **Run the check yourself.** Read the first line: bounds, faults, states.
2. **Read the warnings.** Sources that don't resolve, steps standing for many files, steps that
   never ran, `?`, "no faults".
3. **Start with the shortest counterexample.** Retell it in a sentence, with names.
4. **Check every step of it against its sources.** Atomic in the code, atomic in the spec. An
   `await` in the code, two steps in the spec.
5. **Doubt a step? Fix it and check again.** If the finding survives, it's real.
6. **Judge it**: how many faults, what outcome, what evidence.
7. **Keep it**: `--as-scenario`, `known`, then a rule with the fix.
8. **Then read the `✓`s** with the same suspicion.

## Exercises

1. Run `feynman check specs/15-triage/1-the-agents-draft.ts --only oneTicket`. Retell
   the 18-event story. Where does it go wrong, and which step of it would you check first?
2. The fix emails the ticket. What if the email is lost? Add `lose(Ticket)` and see what breaks.
   Is it the same kind of finding?
3. In `2-one-statement.ts`, the bank's answer reaches the restarted server. Name another place in
   the book's specs where a message reaches an instance that, in the code, could not receive it.
4. Ask an agent to write a spec for a small piece of code you know well, then triage its findings
   with the checklist.
