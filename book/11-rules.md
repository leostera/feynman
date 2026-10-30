# 11. Which part does the work?

> *If we removed this check, would anything notice?*

The box office now has four safeguards, each added after a counterexample:

1. a payment counts only for the hold it pays for (chapter 7);
2. the bank charges each order once (chapter 8);
3. after a restart, payments in progress are resumed (chapter 9);
4. after a restart, holds get their expiry back (chapter 10).

Every property holds. But a property that holds says the design is safe. It doesn't say
*which parts* make it safe, or whether the property would notice if one of them went missing.
A year from now someone will look at `resume` and ask whether it's still needed. This chapter
makes the spec answer.

## Rules

A **rule** is a named part of the design that exists to keep properties true. You define it,
read `rule.on` where it applies, and say which properties need it:

```ts
// The safeguards, each named. Steps read `rule.on` where it applies; properties say which
// they need, and check makes sure each is.
const payOnlyTheHolder = defineRule("payOnlyTheHolder", { description: "A payment counts only for the hold it pays for." });
const idempotencyKey = defineRule("idempotencyKey", { description: "The bank charges each order once." });
const resumePayments = defineRule("resumePayments", { description: "After a restart, the box office resumes the payments the database says are in progress." });
const rearmHolds = defineRule("rearmHolds", { description: "After a restart, the box office sets the expiry of every hold again." });
```

Where each applies:

```ts
    pay: {
      // …
      run(state, _msg, ctx) {
        if (state.seat.kind !== "held") return ctx.reply(Expired, {});
        if (payOnlyTheHolder.on && state.seat.by !== ctx.from.id) return ctx.reply(Expired, {});
        // …
      },
    },
```

```ts
    resume: {
      when: (s) => resumePayments.on && s.seat.kind === "paying" && !s.calling,
      // …
    },
    rearm: {
      when: (s) => rearmHolds.on && s.seat.kind === "held" && !s.expiring,
      // …
    },
```

```ts
    charge: {
      // …
      run(state, msg, ctx) {
        if (!idempotencyKey.on || !state.seen.has(msg.order)) {
          state.seen.add(msg.order);
          state.charges.push(msg.order);
        }
        ctx.reply(Charged, msg);
      },
    },
```

And what needs each:

```ts
const chargedOnce = defineProperty("chargedOnce", {
  description: "No order is charged twice.",
  needs: [idempotencyKey],
  // …
});
```

A rule is on in the spec as written. `feynman check` checks the design as written, then again
without each rule, and expects every property that needs it to break.

## Step 1: claiming what each rule is for

Our first guess at the claims:

- `oneTicket` needs `payOnlyTheHolder`;
- `chargedOnce` needs `idempotencyKey`;
- `paymentsEnd` needs `resumePayments`;
- `holdsEnd` needs `rearmHolds`.

([`specs/11-rules/1-rules.ts`](specs/11-rules/1-rules.ts))

```text
Box office: explored 3,674 states (…, depth 40, faults=1) in 164ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✓ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
  ✓ holdsEnd  A hold ends: the seat is eventually paid for or free again.
  rules
    ✗ payOnlyTheHolder  not needed by oneTicket: held without the rule, in every state. The rule does nothing here, or the property is too weak to see what it prevents.
    ✓ idempotencyKey    needed: without it, chargedOnce breaks (8 events)
    ✗ resumePayments    not needed by paymentsEnd: held without the rule, in every state. The rule does nothing here, or the property is too weak to see what it prevents.
    ✓ rearmHolds        needed: without it, holdsEnd breaks (4 events)
```

Two claims hold and two don't. A `✗` on a rule means one of three things, and each is worth
knowing:

1. **The rule does nothing.** Something else already prevents the bug. Then the rule is dead
   code, or a second line of defence you should say is one.
2. **The property is too weak** to see what the rule prevents.
3. **The bounds are too small** to reach the bug.

`resumePayments` is the third. In chapter 9, the bug it fixes needed *two* faults: a lost charge
and a restart before the failure arrives. With a budget of one, the checker can't reach it:

```sh
feynman check specs/11-rules/1-rules.ts --depth 40 --set faults=2
```

```text
    ✓ resumePayments    needed: without it, paymentsEnd breaks (7 events)
```

The spec should say that, rather than leave it to whoever runs the command. Chapter 12 is about
bounds. For now, the budget moves into the spec, with a comment saying why:

```ts
/**
 * At most two faults on any path: resuming payments after a restart only matters when a
 * charge is lost and the box office restarts before it hears. `--set faults=1` lowers it.
 */
const faults = budget("faults", 2);
```

`payOnlyTheHolder` is the second case: `oneTicket` is too weak. Chapter 7 showed it: without the
check, Alice's late payment bought the seat Bob was holding. She got one ticket, he got none,
and "at most one ticket" held throughout. The property that saw that bug was
`holdsAreRespected`, and we dropped it along the way. A rule check is how you find that out.

## Step 2: a property for every rule

We bring the property back, on payments this time, and move the claim to it:

```ts
const holdsAreRespected = defineProperty("holdsAreRespected", {
  description: "A seat held for one person is never paid for by another.",
  everyStep: (before, after) => {
    const was = before.the(BoxOffice).state.seat;
    const now = after.the(BoxOffice).state.seat;
    return !(was.kind === "held" && now.kind === "paying" && now.by !== was.by);
  },
  needs: [payOnlyTheHolder],
});
```

([`specs/11-rules/2-every-rule.ts`](specs/11-rules/2-every-rule.ts))

```text
Box office: explored 8,661 states (…, depth 40, faults=2) in 274ms
  ✓ holdsAreRespected  A seat held for one person is never paid for by another.
  rules
    ✗ payOnlyTheHolder  not needed by holdsAreRespected: held without the rule, in every state. The rule does nothing here, or the property is too weak to see what it prevents.
    ✓ idempotencyKey    needed: without it, chargedOnce breaks (8 events)
    ✓ resumePayments    needed: without it, paymentsEnd breaks (7 events)
    ✓ rearmHolds        needed: without it, holdsEnd breaks (4 events)
```

Still not needed. This time it's neither the rule nor the property. It's the model. Look at
`pay`:

```ts
        state.seat = { ...state.seat, kind: "paying" };
```

It keeps the seat's `by`, the *holder*, as the one paying. Without the rule, Bob's payment for
Alice's hold makes Alice's order "paying", and Alice gets the ticket Bob paid for. The new
property compares `by` before and after, and they are the same, so it sees nothing. The model
records the payment against the wrong person, so no property about payers can be right.

This is the most useful thing a rule check does. Asking "would anything notice if this were
gone?" led us to a line of the spec that says something the system doesn't do.

## Step 3: the payer

A payment belongs to whoever pays:

```ts
        state.seat = { kind: "paying", by: ctx.from.id, order: state.seat.order };
```

([`specs/11-rules/3-the-payer.ts`](specs/11-rules/3-the-payer.ts))

```text
Box office: explored 8,661 states (1 of each actor, and from the end of 3 scenario(s) and the setup of 3, depth 40, faults=2) in 272ms
  ✓ chargedOnce  No order is charged twice.
  ✓ oneTicket  At most one person has a ticket for the last seat.
  ✓ holdsAreRespected  A seat held for one person is never paid for by another.
  ✓ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
  ✓ holdsEnd  A hold ends: the seat is eventually paid for or free again.
  rules
    ✓ payOnlyTheHolder  needed: without it, holdsAreRespected breaks (8 events)
    ✓ idempotencyKey    needed: without it, chargedOnce breaks (8 events)
    ✓ resumePayments    needed: without it, paymentsEnd breaks (7 events)
    ✓ rearmHolds        needed: without it, holdsEnd breaks (4 events)
```

Every rule is needed, and the spec says by what. Those four lines are the best summary of the
design anyone could ask for: each safeguard, what it protects, and how quickly things go
wrong without it.

## `--without`: what goes wrong if we drop it

`--without RULE` checks the design without one or more rules, with full counterexamples. It's
how you answer "why is this here?":

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 40 --without payOnlyTheHolder --only holdsAreRespected
```

```text
    shortest counterexample, 8 event(s), needs no faults, from the setup of scenario "Alice buys the last seat":
       1  Alice (Person)  hold
       2  Bob (Person)  hold
       3  Box office (Box office)  hold the seat  {}  from Alice
          seat.kind: "free" → "held"
          seat.by: — → "person-alice"
       4  Alice (Person)  held  {}  from Box office
       5  Alice (Person)  pay
       6  Box office (Box office)  expire
          seat.kind: "held" → "free"
       7  Box office (Box office)  hold the seat  {}  from Bob
          seat.kind: "free" → "held"
          seat.by: — → "person-bob"
       8  Box office (Box office)  pay  {}  from Alice
          seat.kind: "held" → "paying"
          seat.by: "person-bob" → "person-alice"
```

Chapter 7's bug, word for word. And without the idempotency key:

```sh
feynman check specs/11-rules/3-the-payer.ts --depth 40 --without idempotencyKey --brief
```

```text
  ✗ scenario "The bank's answer is lost": chargedOnce
  ✗ scenario "A restart mid-payment": chargedOnce
Box office without idempotencyKey: explored 10,761 states (…) in 329ms
  ✗ chargedOnce  No order is charged twice.
```

The scenarios break too, because their descriptions promise one charge. `feynman run --without
idempotencyKey` replays them without the rule, and `feynman dev` shows the playground of the
design without it.

Never copy a spec to turn a safeguard off. The copy drifts from the original, and nothing
re-checks it. A rule is the same check, kept in the spec, re-run every time.

## Writing rules

- **Make each fix a rule as you make it.** Write the property, watch it break, fix it, and wrap
  the fix in a rule that the property needs. The counterexample that made you write it is then
  one `--without` away, forever.
- **Read `rule.on` where the decision is made**, in the step or the guard, not by switching
  between two copies of a step.
- **Read it at run time only.** `rule.on` is known while the checker runs a step, a guard, a
  property or a display. Reading it when the file loads is an error.
- **A `✗` is a finding about the spec.** Dead rule, weak property, or bounds too small: decide
  which, and fix the one that's wrong.
- **Put the bounds a rule needs in the spec.** If a rule only matters with two faults, the
  budget is two, with a comment.

## Exercises

1. Add a rule for the database's `keeps: ["seat"]` from chapter 9. Why can't `rule.on` go in
   `keeps` directly? Where can it go instead?
2. `rearmHolds` breaks `holdsEnd` in 4 events. Write a scenario that shows it, and give it a
   description that is true with the rule and false without it.
3. Write a rule that's dead on purpose: a second check in `charged` that the seat is being
   paid for. What does the checker say about it?
