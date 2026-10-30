# 16. Two-phase commit

> *How do two databases agree to do something together, or not at all?*

Part III builds well-known protocols from nothing, one step at a time, letting the checker show
why each part of the protocol is there. These are the systems in every distributed-systems
course, and they make good exercises for the same reason: each part exists because something
breaks without it.

The first is a checkout. An order takes money from the card, in the payments service, and a
unit from the warehouse, in the stock service. Each has its own database. The order must happen
in both, or in neither. A paid order that can't ship is a refund and an apology. A shipped order
nobody paid for is a loss.

## Step 1: tell everyone to commit

The simplest thing: the shop tells each service to commit its part
([`specs/16-two-phase-commit/1-one-phase.ts`](specs/16-two-phase-commit/1-one-phase.ts)).

```ts
const Participant = defineActor({
  name: "Participant",
  description: "A service with its own database: payments, or stock.",
  zone: services,
  symmetric: true,
  initialState: () => ({ canCommit: true, outcome: null as Outcome | null }),
  // …
  actions: {
    conflict: {
      with: [atMost(1)],
      label: "Hit a conflict",
      description: "Something makes this service unable to commit: the card is declined, the stock ran out.",
      when: (s) => s.outcome === null && s.canCommit,
      run: (s) => void (s.canCommit = false),
    },
  },
  transitions: {
    commit: {
      on: Commit,
      description: "Commits its part of the order if it can, and rolls it back if not.",
      run: (s) => void (s.outcome = s.canCommit ? "committed" : "aborted"),
    },
  },
});
```

A **conflict** is anything that makes a service unable to commit: a declined card, an empty
shelf, a constraint, a deadlock. It's an action because it happens from outside, whenever it
likes, and `atMost(1)` keeps it to once.

The property is the whole point of the protocol:

```ts
const atomic = defineProperty("atomic", {
  description: "No service commits while another rolls back: the order happens everywhere, or nowhere.",
  always: (w) => {
    const outcomes = w.all(Participant).map((p) => p.state.outcome);
    return !(outcomes.includes("committed") && outcomes.includes("aborted"));
  },
});
```

```text
  ✗ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
    shortest counterexample, 4 event(s), needs no faults, from the setup of scenario "A checkout":
       1  Shop (Shop)  checkout
          → Payments: commit {}
          → Stock: commit {}
       2  Payments (Participant)  conflict
          canCommit: true → false
       3  Payments (Participant)  commit  {}  from Shop
          outcome: null → "aborted"
       4  Stock (Participant)  commit  {}  from Shop
          outcome: null → "committed"
          ✗ breaks atomic
```

*The card is declined. Payments rolls back, and stock ships.* No faults needed. Telling isn't
enough, because a service can only say whether it *can* commit by trying.

## Step 2: ask first

Split it in two. First every service **prepares**: it does the work, holds its locks, and votes.
A yes is a promise: *I can commit, and I will do whatever you decide*. A no rolls back on the
spot. Then the coordinator **decides**: commit if everyone voted yes, abort otherwise
([`specs/16-two-phase-commit/2-two-phases.ts`](specs/16-two-phase-commit/2-two-phases.ts)).

```ts
    prepare: {
      on: Prepare,
      description: "Votes yes and holds its locks if it can commit; votes no and rolls back if not.",
      sends: [Vote],
      run(state, _msg, ctx) {
        if (state.canCommit) state.prepared = true;
        else state.outcome = "aborted";
        ctx.reply(Vote, { yes: state.canCommit });
      },
    },
    decide: {
      on: Decide,
      description: "Does what the coordinator decided.",
      run(state, msg) {
        if (state.outcome === null) state.outcome = msg.commit ? "committed" : "aborted";
      },
    },
```

```ts
    vote: {
      on: Vote,
      description: "Counts a vote: a no aborts at once, and the last yes commits.",
      sends: [Decide],
      run(state, msg, ctx) {
        if (state.decision !== null) return;
        if (msg.yes) state.yes.add(ctx.from.id);
        const everyone = ctx.all(Participant);
        if (msg.yes && state.yes.size < everyone.length) return;
        state.decision = msg.yes;
        for (const p of everyone) ctx.send(p, Decide, { commit: state.decision });
      },
    },
```

A prepared service holds its locks until it hears, so a second property matters as much as the
first: nobody holds them forever.

```ts
const nobodyWaitsForever = defineProperty("nobodyWaitsForever", {
  description: "A service that voted yes eventually commits or rolls back: it does not hold its locks forever.",
  leadsTo: {
    whenever: (w) => w.all(Participant).some((p) => p.state.prepared && p.state.outcome === null),
    then: (w) => w.all(Participant).every((p) => !p.state.prepared || p.state.outcome !== null),
  },
});
```

```text
Checkout: explored 94 states (1 of each actor, and from the end of 2 scenario(s) and the setup of 2, depth 14) in 75ms
! no faults: every path has a perfect network and no crashes. Declare the ones the system meets, like lose(Debit) or crash().
  ✓ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
  ✓ nobodyWaitsForever  A service that voted yes eventually commits or rolls back: it does not hold its locks forever.
```

Both hold, on a perfect network, as the warning says.

## Step 3: the network

Any of the three messages can be lost
([`specs/16-two-phase-commit/3-lost-messages.ts`](specs/16-two-phase-commit/3-lost-messages.ts)):

```ts
const faults = budget("faults", 1);
// …
    prepareLost: lose(Prepare, { spend: faults }),
    decideLost: lose(Decide, { spend: faults }),
// …
    voteLost: lose(Vote, { spend: faults }),
```

```text
  ✓ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
  ✗ nobodyWaitsForever  A service that voted yes eventually commits or rolls back: it does not hold its locks forever.
    shortest counterexample, 3 event(s), needs 1 fault(s):
       1  Coordinator (Coordinator)  checkout
       2  Participant (Participant)  prepare  {}  from Coordinator
       3  Coordinator (Coordinator)  vote → voteLost  {"yes":true}  from Participant
    then nothing fair can happen: it stays there forever, and never holds
```

Atomicity survives: losing a message never makes anyone commit. But a lost vote leaves the
coordinator waiting for it, and the service that voted waiting for a decision, both forever.
(Check models the checkout with one service here, which is all it takes.)

## Step 4: the coordinator gives up

The coordinator can't wait forever for a vote. Give it a timer: if the votes aren't in, abort
([`specs/16-two-phase-commit/4-a-timeout.ts`](specs/16-two-phase-commit/4-a-timeout.ts)):

```ts
    giveUp: {
      description: "A vote did not come in time: aborts, and tells everyone.",
      after: "30 seconds",
      sends: [Decide],
      run(state, _, ctx) {
        if (state.decision !== null) return;
        state.decision = false;
        for (const p of ctx.all(Participant)) ctx.send(p, Decide, { commit: false });
      },
    },
```

Aborting is always safe for the coordinator: nobody has been told to commit. (Remember from
chapter 7 that "30 seconds" is only a label. The timer can fire at any moment, even before
the votes would have arrived. The coordinator must be right whenever it fires, not just when
it's late.)

```text
  ✗ nobodyWaitsForever  A service that voted yes eventually commits or rolls back: it does not hold its locks forever.
    shortest counterexample, 4 event(s), needs 1 fault(s):
       1  Coordinator (Coordinator)  checkout
       2  Participant (Participant)  prepare  {}  from Coordinator
       3  Coordinator (Coordinator)  vote  {"yes":true}  from Participant
       4  Participant (Participant)  decide → decideLost  {"commit":true}  from Coordinator
    then nothing fair can happen: it stays there forever, and never holds
```

Now the decision is lost. The coordinator is done, but the service voted yes, and it's still
holding its locks, waiting.

## Step 5: the service gives up too?

The obvious move: give the service a timer as well. If no decision comes, roll back
([`specs/16-two-phase-commit/5-giving-up-alone.ts`](specs/16-two-phase-commit/5-giving-up-alone.ts)):

```ts
    waitTooLong: {
      description: "The decision did not come in time: rolls back on its own, and lets go of its locks.",
      after: "1 minute",
      run(state) {
        if (state.outcome === null) state.outcome = "aborted";
      },
    },
```

```text
  ✗ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
    shortest counterexample, 7 event(s), needs no faults, from the setup of scenario "A checkout":
       1  Coordinator (Coordinator)  checkout
       2  Payments (Participant)  prepare  {}  from Coordinator
       3  Stock (Participant)  prepare  {}  from Coordinator
       4  Coordinator (Coordinator)  vote  {"yes":true}  from Payments
       5  Coordinator (Coordinator)  vote  {"yes":true}  from Stock
       6  Payments (Participant)  decide  {"commit":true}  from Coordinator
          outcome: null → "committed"
       7  Stock (Participant)  waitTooLong
          outcome: null → "aborted"
          ✗ breaks atomic
```

*Both vote yes, and the coordinator decides to commit. Payments commits. Stock's timer fires
before the decision reaches it, and it rolls back.* No faults: a slow message is enough.

This is the heart of two-phase commit. **Once a service votes yes, it can't decide alone.** It
promised to do whatever the coordinator decides, and it doesn't know what that is. It's *in
doubt*. Neither committing nor aborting on its own is safe.

## Step 6: ask

A service in doubt can't decide, but it can ask
([`specs/16-two-phase-commit/6-ask.ts`](specs/16-two-phase-commit/6-ask.ts)). The question is
a call (chapter 8), so the service hears when it goes unanswered, and asks again:

```ts
// A call: the service hears if it fails, as a request that times out throws.
const Ask = defineCall("Ask", {}, { name: "what was decided?" });
```

```ts
    inDoubt: {
      description: "The decision has not come: asks the coordinator.",
      after: "1 minute",
      sends: [Ask],
      run(state, _, ctx) {
        if (state.outcome === null) ctx.send(ctx.the(Coordinator), Ask, {});
      },
    },
    askFailed: {
      on: failed(Ask),
      description: "The question went unanswered: asks again.",
      sends: [Ask],
      run(state, failure, ctx) {
        if (state.outcome === null) ctx.send(failure.to, Ask, {});
      },
    },
    // A lost answer to a question fails it; a lost decision sent unasked fails nothing.
    decideLost: lose(Decide, { fails: Ask, spend: faults }),
```

The coordinator answers with its decision. If it hasn't decided, it aborts now, which is always
safe for it, and tells everyone:

```ts
    ask: {
      on: Ask,
      description: "Tells a service in doubt what was decided; if nothing was, aborts, and tells everyone.",
      sends: [Decide],
      run(state, _msg, ctx) {
        if (state.decision !== null) return ctx.reply(Decide, { commit: state.decision });
        state.decision = false;
        ctx.cancel("giveUp");
        ctx.reply(Decide, { commit: false });
        for (const p of ctx.all(Participant)) if (p.id !== ctx.from.id) ctx.send(p, Decide, { commit: false });
      },
    },
```

The answer to the asker is a `reply`, so that losing it fails the call. The others get plain
sends. (The first version of this step broadcast to everyone, the asker included. The checker
found the asker waiting forever on a lost "reply" that wasn't one.)

```sh
feynman check specs/16-two-phase-commit/6-ask.ts --depth 30
```

```text
Checkout: explored 4,057 states (…, depth 30, faults=1) in 187ms
  ✓ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
  ✓ nobodyWaitsForever  A service that voted yes eventually commits or rolls back: it does not hold its locks forever.
```

The asking loop needs a deeper search than the default to finish every path, hence
`--depth 30` (chapter 12).

## Step 7: the coordinator restarts

So far the coordinator never restarts. When it does, what it decided is gone, unless it wrote it
down. Its state now says what's on disk
([`specs/16-two-phase-commit/7-a-restart.ts`](specs/16-two-phase-commit/7-a-restart.ts)):

```ts
  // `started` and `log` are on disk. The votes and `decision` are in memory, and a restart
  // loses them.
  initialState: () => ({ started: false, yes: new Set<string>(), decision: null as boolean | null, log: null as boolean | null }),
```

```ts
    crash: crash({ keeps: ["started", "log"], spend: faults }),
```

Whether it writes the decision down before telling anyone is a rule:

```ts
const logDecision = defineRule("logDecision", { description: "The coordinator writes its decision to disk before it tells anyone." });

/** Decides, writing the decision to disk first when the rule is on. */
function decide(state: CoordinatorState, commit: boolean): void {
  if (logDecision.on) state.log = commit;
  state.decision = commit;
}
```

Our first attempt read the log only when a service asked, and the checker found this, even with
the rule on:

```text
       4  Coordinator (Coordinator)  giveUp
          decision: null → false
          log: null → false
       5  Coordinator (Coordinator)  crash
          decision: false → null
       6  Coordinator (Coordinator)  vote  {"yes":true}  from Payments
       7  Coordinator (Coordinator)  vote  {"yes":true}  from Stock
          decision: null → true
          log: false → true
       8  Payments (Participant)  decide  {"commit":false}  from Coordinator
       9  Stock (Participant)  decide  {"commit":true}  from Coordinator
          ✗ breaks atomic
```

*The coordinator gives up and aborts, writing it down. It restarts. The two votes, slow but
not lost, arrive, and the restarted coordinator counts them and commits, writing over its own
log.* What's on disk is the truth, and memory is only a copy of it. Every step must consult it:

```ts
/** What it knows was decided: in memory, or, after a restart, on disk. */
function known(state: CoordinatorState): boolean | null {
  return state.decision ?? state.log;
}
```

```ts
    vote: {
      // …
      run(state, msg, ctx) {
        if (known(state) !== null) return;
```

```text
Checkout: explored 10,468 states (…, depth 30, faults=2) in 230ms
  ✓ atomic  No service commits while another rolls back: the order happens everywhere, or nowhere.
  ✓ nobodyWaitsForever  A service that voted yes eventually commits or rolls back: it does not hold its locks forever.
  rules
    ✓ logDecision  needed: without it, atomic breaks (9 events)
```

And without the rule:

```sh
feynman check specs/16-two-phase-commit/7-a-restart.ts --depth 30 --without logDecision --only atomic
```

```text
       4  Coordinator (Coordinator)  giveUp
          decision: null → false
       5  Coordinator (Coordinator)  crash
          decision: false → null
       6  Coordinator (Coordinator)  vote  {"yes":true}  from Payments
       7  Coordinator (Coordinator)  vote  {"yes":true}  from Stock
          decision: null → true
       8  Payments (Participant)  decide  {"commit":false}  from Coordinator
          outcome: null → "aborted"
       9  Stock (Participant)  decide  {"commit":true}  from Coordinator
          outcome: null → "committed"
          ✗ breaks atomic
```

The same story, and this time nothing on disk stops it. This is why every database writes
its log before it acts.

We also tried a second rule, for a coordinator that aborts undecided checkouts after a restart.
The checker said:

```text
    ✗ recoverOnRestart  not needed by nobodyWaitsForever: held without the rule, in every state. The rule does nothing here, or the property is too weak to see what it prevents.
```

It was right. A checkout whose prepares were lost locks nothing, and any service that did
prepare will ask, and the ask aborts it. The rule went.

## What two-phase commit can't do

Look at what step 7 still needs: a coordinator that comes back. If it never does, a service
that voted yes asks forever, holding its locks. Two-phase commit **blocks** when the
coordinator fails. With `crash`, the coordinator always restarts, so the checker can't show
this. To see it, model a coordinator that can stop for good. Exercise 3 does.

Avoiding the block takes more machinery: a coordinator replicated by consensus, or
three-phase commit's extra round. And outside databases, the usual answer is not to need
atomic commit at all. Chapter 17's outbox is one way.

## What we left out

- **Participants restarting.** A real participant writes its vote to disk before sending it,
  for the same reason the coordinator logs its decision (exercise 1).
- **Many checkouts at once.** One is enough to show every bug here. More multiply the states
  and teach nothing new.
- **What "prepare" does inside the database.** Locks, undo logs, and isolation are each a spec
  of their own.

## Exercises

1. Let participants restart: `crash({ keeps: [...] })`. What must they keep? What breaks if a
   prepared participant forgets it voted yes?
2. In step 6, make the coordinator answer "not decided yet" instead of aborting. What does the
   checker say about `nobodyWaitsForever`? Why?
3. Replace the coordinator's `crash` with a fault that stops it for good: a step, with
   `fair: false`, that sets `down: true`, after which it does nothing. Check
   `nobodyWaitsForever`. What does the trace look like?
4. Add a third service. How many more states? Does any verdict change?
