# 1. A first spec

Most bugs that reach production are not typos. The code does what it says. The trouble is
what happens when two pieces of it run at the same time, or a message arrives late, or a
process restarts halfway through. Nobody wrote that behaviour down, so nobody reviewed it.

A Feynman spec writes it down as a small program, and a model checker runs that program in
every order it can. This chapter builds one spec from nothing and finds a real bug with it.
We will not explain every line yet. The point is to see the whole loop once: describe the
system, say what must stay true, let the checker look, and read what it found.

## The system

A bank moves money between two accounts, Alice's and Bob's. Each starts with 5. A transfer
is handled by a worker, and the worker does three things:

1. it reads the balance of the account the money comes from;
2. if the balance covers the amount, it debits that account;
3. once the debit is done, it credits the other account.

The balances live in a database, the ledger. Workers talk to it over the network. There can
be more than one worker, each handling its own transfer.

One thing must always be true: **no account goes below zero.** The worker checks the balance
before it debits, so it looks safe. Let's find out.

## Writing it down

A spec is a TypeScript file. It starts by importing Feynman and naming the things the
system is made of. First, the accounts:

```ts
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const ACCOUNTS = ["alice", "bob"] as const;
type Account = (typeof ACCOUNTS)[number];
const OPENING_BALANCE = 5;
const TOTAL = OPENING_BALANCE * ACCOUNTS.length;

/** The other account: a transfer always goes from one to the other, never to itself. */
const payee = (from: Account): Account => (from === "alice" ? "bob" : "alice");
const covers = (balance: number, amount: number) => balance >= amount;
```

This is ordinary TypeScript. There are two accounts, they open with 5 each, and a transfer
goes from one to the other. Small helpers like `covers` give names to the decisions the
system makes, so that the rest of the spec reads like the description above.

### Messages

The worker and the ledger are separate programs, so they talk with **messages**. Each
message has an id and the shape of what it carries:

```ts
const account = oneOf(...ACCOUNTS);
const Read = defineMessage("Read", { account });
const Balance = defineMessage("Balance", { balance: Number }, { tone: "reply" });
const Debit = defineMessage("Debit", { account, amount: Number });
const Debited = defineMessage("Debited", {}, { tone: "reply" });
const Credit = defineMessage("Credit", { account, amount: Number });
```

`{ account, amount: Number }` is a schema. Feynman checks every message sent against it, and
TypeScript gets its type from it, so a handler for `Debit` knows `msg.account` is one of the
two accounts and `msg.amount` is a number. `tone: "reply"` only tells the views to draw it
as an answer.

### Actors

The things that run separately and keep their own state are **actors**. The ledger is one:

```ts
const storage = defineZone({ name: "Storage", description: "the ledger" });

const Ledger = defineActor({
  name: "Ledger",
  description: "The database that holds every account's balance.",
  zone: storage,
  singleton: true,
  initialState: () => ({ balances: { alice: OPENING_BALANCE, bob: OPENING_BALANCE } as Record<Account, number> }),
  transitions: {
    read: {
      on: Read,
      description: "Answers with the account's balance.",
      sends: [Balance],
      run: (state, msg, ctx) => ctx.reply(Balance, { balance: state.balances[msg.account] }),
    },
    debit: {
      on: Debit,
      description: "Takes the amount out of the account.",
      sends: [Debited],
      run(state, msg, ctx) {
        state.balances[msg.account] -= msg.amount;
        ctx.reply(Debited, {});
      },
    },
    credit: {
      on: Credit,
      description: "Puts the amount into the account.",
      run: (state, msg) => void (state.balances[msg.account] += msg.amount),
    },
  },
});
```

Read it top to bottom:

- `zone` says where it lives. Zones group actors on the map the playground draws.
- `singleton: true` says there is exactly one ledger, there from the start.
- `initialState` is what it holds when the world begins.
- `transitions` are its **steps**. Each one is `on` a message: when a `Read` arrives, the
  `read` step runs. `run` changes the state in place and may send messages. `sends` lists
  what it may send, and Feynman holds it to that.
- `ctx.reply` answers whoever sent the message being handled.

The worker is the other actor. It has a little more state, because it goes through stages,
waiting for one answer from the ledger at a time:

```ts
interface Transfer {
  from: Account;
  to: Account;
  amount: number;
}

/** Where a worker is in its transfer: each stage waits for one answer from the ledger. */
type Stage = { kind: "idle" } | { kind: "reading"; transfer: Transfer } | { kind: "debiting"; transfer: Transfer };

/**
 * The stage a step expects, or a spec error: the ledger answers only what a worker asked, so
 * an answer in any other stage means the model is wrong, and the checker should say so.
 */
function expectStage<K extends Stage["kind"]>(stage: Stage, kind: K): Extract<Stage, { kind: K }> {
  if (stage.kind !== kind) throw new Error(`a worker ${stage.kind} got an answer meant for one ${kind}`);
  return stage as Extract<Stage, { kind: K }>;
}
```

A stage is one value, not a handful of booleans, so a worker can't be "reading" and
"debiting" at once. `expectStage` is there for us, the authors. If the model ever delivers an
answer the worker didn't ask for, the step throws. Feynman reports that as a spec error rather
than carrying on with a world that makes no sense.

```ts
const app = defineZone({ name: "App", description: "workers handling transfers" });

const Wire = defineActor({
  name: "Wire",
  description: "A worker that handles one transfer at a time.",
  zone: app,
  symmetric: true,
  initialState: () => ({ stage: { kind: "idle" } as Stage }),
  actions: {
    transfer: {
      with: [atMost(1)],
      label: "Transfer",
      description: "Starts a transfer by reading the balance of the account it comes from.",
      when: (s) => s.stage.kind === "idle",
      inputs: { from: account, amount: oneOf(3, 5) },
      sends: [Read],
      run(state, { from, amount }, ctx) {
        state.stage = { kind: "reading", transfer: { from, to: payee(from), amount } };
        ctx.send(ctx.the(Ledger), Read, { account: from });
      },
    },
  },
  transitions: {
    balance: {
      on: Balance,
      description: "Debits the account if the balance covers the amount; otherwise gives up.",
      sends: [Debit],
      run(state, msg, ctx) {
        const { transfer } = expectStage(state.stage, "reading");
        if (!covers(msg.balance, transfer.amount)) return void (state.stage = { kind: "idle" });
        state.stage = { kind: "debiting", transfer };
        ctx.reply(Debit, { account: transfer.from, amount: transfer.amount });
      },
    },
    debited: {
      on: Debited,
      description: "Credits the other account; the transfer is done.",
      sends: [Credit],
      run(state, _msg, ctx) {
        const { transfer } = expectStage(state.stage, "debiting");
        ctx.send(ctx.the(Ledger), Credit, { account: transfer.to, amount: transfer.amount });
        state.stage = { kind: "idle" };
      },
    },
  },
});
```

Two new things:

- **Actions** are what the outside world does: here, someone asks for a transfer. An action
  has inputs. The checker tries every value they can take: from Alice or from Bob, 3 or 5.
  `when` says when the action is offered, and `with: [atMost(1)]` says each worker handles
  one transfer on any one run. Without a bound, a person could ask forever, and the checker
  would never finish.
- `symmetric: true` says workers are interchangeable. The checker may then treat "worker A
  does this, worker B does that" and the reverse as the same situation. Chapter 12 explains
  when that claim is safe.

### What must be true

A **property** is something that must hold. This one says what we asked at the start:

```ts
const noOverdrafts = defineProperty("noOverdrafts", {
  description: "No account goes below zero.",
  always: (w) => ACCOUNTS.every((a) => w.the(Ledger).state.balances[a] >= 0),
});
```

`always` takes the world, `w`, and returns whether the property holds there. The checker
asks it about every world it reaches.

There is a second thing we expect without saying it: money is neither made nor lost. While a
transfer is half done, the debit has happened and the credit has not, so the total is short.
Once nothing is in flight it must add up again:

```ts
const moneyIsKept = defineProperty("moneyIsKept", {
  description: "Once nothing is in flight, the accounts hold what they opened with.",
  always: (w) => !w.quiet || ACCOUNTS.reduce((sum, a) => sum + w.the(Ledger).state.balances[a], 0) === TOTAL,
});
```

`w.quiet` is true when no message is on its way and no timer is set. "Once quiet, …" is how
a spec says "in the end".

### A scenario, and the spec

Last, a **scenario**: one run, scripted, that a reader can watch. Then `defineSpec` puts the
parts together:

```ts
const oneTransfer = defineScenario("One transfer", {
  description: "Alice sends Bob 3: she has 2 left, and he has 8.",
  run(s) {
    const wire = s.spawn(Wire, "Wire 1");
    s.act(wire, "transfer", { from: "alice", amount: 3 });
    s.settle();
  },
});

export default defineSpec({
  name: "Wire transfers",
  description: "Moving money between two accounts, one worker per transfer.",
  actors: [Ledger, Wire],
  properties: [noOverdrafts, moneyIsKept],
  scenarios: [oneTransfer],
});
```

`s.spawn` adds a worker, `s.act` takes an action, and `s.settle()` leaves the system alone
until nothing is pending. The whole file is
[`specs/01-wire/1-overdraft.ts`](specs/01-wire/1-overdraft.ts).

## Checking it

```sh
feynman check specs/01-wire/1-overdraft.ts
```

```text
Wire transfers: explored 26 states (1 of each actor, and from the end of 1 scenario(s), depth 14) in 43ms
! no faults: every path has a perfect network and no crashes. Declare the ones the system meets, like lose(Debit) or crash().
  ✓ noOverdrafts  No account goes below zero.
  ✓ moneyIsKept  Once nothing is in flight, the accounts hold what they opened with.
  no step points at code yet; this spec is a design. Add sources as the code appears.
```

Both hold. The checker started from a world with one ledger and one worker. It tried every
transfer the worker could ask for, and every order in which the messages could arrive: 26
distinct states, all of them. The `✓` means the property held in every one.

It also tells us what it did *not* do. The network never lost a message, because we didn't
say it could (chapter 8). And nothing points at real code yet, because there is no code
(chapter 13).

But one worker is not the system we described. We said there can be more than one, so ask
for two:

```sh
feynman check specs/01-wire/1-overdraft.ts --instances Wire=2
```

```text
Wire transfers: explored 369 states (2 Wire, and from the end of 1 scenario(s), depth 14) in 80ms
  treated as interchangeable: Wire A = Wire B
  ✗ noOverdrafts  No account goes below zero.
    shortest counterexample, 8 event(s), needs no faults:
       1  Wire A (Wire)  transfer  {"from":"alice","amount":3}
          Starts a transfer by reading the balance of the account it comes from.
          stage.kind: "idle" → "reading"
          stage.transfer: — → {"from":"alice","to":"bob","amount":3}
          → Ledger: read {"account":"alice"}
       2  Wire B (Wire)  transfer  {"from":"alice","amount":3}
          → Ledger: read {"account":"alice"}
       3  Ledger (Ledger)  read  {"account":"alice"}  from Wire A
          → Wire A: balance {"balance":5}
       4  Ledger (Ledger)  read  {"account":"alice"}  from Wire B
          → Wire B: balance {"balance":5}
       5  Wire A (Wire)  balance  {"balance":5}  from Ledger
          stage.kind: "reading" → "debiting"
          → Ledger: debit {"account":"alice","amount":3}
       6  Wire B (Wire)  balance  {"balance":5}  from Ledger
          stage.kind: "reading" → "debiting"
          → Ledger: debit {"account":"alice","amount":3}
       7  Ledger (Ledger)  debit  {"account":"alice","amount":3}  from Wire A
          balances.alice: 5 → 2
          → Wire A: debited {}
       8  Ledger (Ledger)  debit  {"account":"alice","amount":3}  from Wire B
          balances.alice: 2 → -1
          → Wire B: debited {}
          ✗ breaks noOverdrafts
```

(We trimmed a few repeated lines. The full output also prints each step's description and
the `atMost` counters.)

## Reading the counterexample

A counterexample is a story. Read it as one:

1. Two people ask to move 3 out of Alice's account, at about the same time. Each request goes
   to a different worker.
2. Both workers ask the ledger for Alice's balance.
3. The ledger answers both: 5.
4. Each worker checks 5 covers 3. It does, so each sends a debit.
5. The ledger takes 3, then 3 again. Alice has −1.

Each worker checked. Each check was true when it was made. The bug is in the gap between
checking and acting, and no single function contains that gap. A code review of `balance()`
would pass it. A unit test of the worker would pass it. It took two workers, and an order of
events nobody thought to try.

Three things about this answer are worth noticing.

- **It is the shortest.** The checker searches breadth first, so no run of fewer than 8
  events breaks the property. The story is never longer than it needs to be.
- **It needs no faults.** No message was lost, and nothing crashed. This happens on a good day,
  under load.
- **The other property still holds.** Money is kept: Bob still gets his 3, twice. The bank
  didn't lose money; it gave out money it didn't have. Two properties, two different
  questions.

## Fixing it

The worker can't know the balance is still 5 when its debit lands. Only the ledger knows that,
at the moment it applies the debit. So the check must happen there: the ledger refuses a
debit the balance does not cover. In SQL that is `UPDATE … SET balance = balance - 3 WHERE
balance >= 3`.

We add a message for the refusal, check in `debit`, and let the worker give up when it is
refused:

```ts
const Refused = defineMessage("Refused", {}, { tone: "refused" });
```

```ts
    debit: {
      on: Debit,
      description: "Takes the amount out of the account.",
      sends: [Debited, Refused],
      run(state, msg, ctx) {
        if (!covers(state.balances[msg.account], msg.amount)) return ctx.reply(Refused, {});
        state.balances[msg.account] -= msg.amount;
        ctx.reply(Debited, {});
      },
    },
```

```ts
    refused: {
      on: Refused,
      description: "The ledger refused the debit; gives up.",
      run(state) {
        expectStage(state.stage, "debiting");
        state.stage = { kind: "idle" };
      },
    },
```

We don't want to remember `--instances Wire=2` every time, so we add a scenario that sets up
two workers and shows the race. The checker explores from the start of every scenario's
setup as well as from the plain start:

```ts
const twoAtOnce = defineScenario("Two at once", {
  description: "Two workers each move 3 out of Alice's 5: both read 5, and the ledger refuses the second debit.",
  setup(w) {
    w.spawn(Wire, "Wire 1");
    w.spawn(Wire, "Wire 2");
  },
  run(s) {
    for (const wire of s.all(Wire)) s.act(wire, "transfer", { from: "alice", amount: 3 });
    s.settle();
  },
});
```

Now `feynman check specs/01-wire/2-fixed.ts` says both properties hold, with two workers.

## Keeping the fix honest

One question is left. The property holds, but would it notice if someone removed the check
next year? Feynman lets us say which part of the design a property depends on. We name the
fix as a **rule**, read it where it applies, and say the property `needs` it:

```ts
// The fix, named: the ledger checks the balance in the same step that takes the money.
const atomicDebit = defineRule("atomicDebit", { description: "The ledger refuses a debit the balance does not cover." });
```

```ts
        if (atomicDebit.on && !covers(state.balances[msg.account], msg.amount)) return ctx.reply(Refused, {});
```

```ts
const noOverdrafts = defineProperty("noOverdrafts", {
  description: "No account goes below zero.",
  always: (w) => ACCOUNTS.every((a) => w.the(Ledger).state.balances[a] >= 0),
  needs: [atomicDebit],
});
```

```text
Wire transfers: explored 376 states (1 of each actor, and from the end of 2 scenario(s) and the setup of 1, depth 14) in 67ms
  ✓ noOverdrafts  No account goes below zero.
  ✓ moneyIsKept  Once nothing is in flight, the accounts hold what they opened with.
  rules
    ✓ atomicDebit  needed: without it, noOverdrafts breaks (8 events)
```

The checker checked the design as written, and again without the rule. Without it, the
overdraft came back in 8 events, so the rule is doing its job and the property can see it.
`feynman check specs/01-wire/3-rule.ts --without atomicDebit` shows that counterexample
whenever someone asks why the check is there. Chapter 11 is about rules.

## What just happened

We described a system in about 150 lines of TypeScript. None of it was the bank's real code.
It was the bank's behaviour: who keeps what, who tells whom, and what people do. From that,
Feynman:

- explored every order of events within its bounds, and told us how many worlds that was;
- found the shortest run that breaks the rule, and showed it event by event;
- told us the bug needs no faults;
- after the fix, confirmed the fix is what keeps the property true.

`feynman dev` opens the same spec in the simulator. You can press "Transfer" on two workers,
deliver the messages in any order, and watch Alice go to −1. Chapter 14 is about making that
view worth looking at.

The rest of the book takes each part of this loop slowly. Part I follows one system, a
theatre's box office, from a single counter to a website that holds seats, takes payments
and survives restarts. Each chapter asks one question that code can't answer: what happens
when two people press the button, when the answer never comes, when the timer fires first,
when it restarts right here. Part II takes specs into a real codebase. Part III works
through well-known systems, with exercises.

## Exercises

1. Change `oneOf(3, 5)` to `oneOf(5)`. Does the bug still need two workers? How long is the
   counterexample now?
2. Take the fixed spec (`2-fixed.ts`) and make the worker debit before it reads the balance.
   Which property breaks?
3. Add a third account. What changes in `payee`? Does the number of states grow by as much as
   you expected?
