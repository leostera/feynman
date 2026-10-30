# 13. Pointing at the code

> *Could someone who knows this code point at every part of the spec?*

Part I designed a box office in a spec. In real work, the code usually comes first, and
the spec explains it. This chapter reads a small implementation of the box office
([`code/box-office`](code/box-office)), models it, ties every step to the code it stands for,
and then uses that tie: a check that notices when the code changes under the spec, and a diff
that shows a reviewer what a change does to the system's behaviour.

## Reading the code first

Before writing anything, find five things in the code, and write down where each is:

1. **The actors**: what runs separately or keeps its own state. Processes, services, external
   APIs, databases you don't own, people, devices.
2. **The stages inside each process**, in the order the code runs them. In async code, every
   `await` on another process ends a stage.
3. **What each one stores**, and whether it survives a restart.
4. **What each one sends, and when**: requests, replies, callbacks.
5. **Timeouts and limits**: the numbers the code names.

Here is the box office's web server, abridged:

```ts
export const HOLD_MINUTES = 10;
const SEAT = "A1";

/** Timers set in this process, by order. A restart loses them; `onStartup` sets them again. */
const expiries = new Map<string, ReturnType<typeof setTimeout>>();

export async function handleHold(db: Db, person: string): Promise<{ held: boolean }> {
  const order = crypto.randomUUID();
  const row = await db.holdIfFree(SEAT, person, order, new Date(Date.now() + HOLD_MINUTES * 60_000));
  if (!row) return { held: false };
  scheduleExpiry(db, order);
  return { held: true };
}

export async function handlePay(db: Db, person: string): Promise<{ ticket: boolean }> {
  const row = await db.startPayment(SEAT, person);
  if (!row || row.state !== "paying") return { ticket: false };
  clearTimeout(expiries.get(row.order));
  await chargeUntilAnswered(row.order);
  return { ticket: (await db.markSold(SEAT, row.order)) !== null };
}

/** The charge, again and again until the bank answers. Safe because the order is the idempotency key. */
export async function chargeUntilAnswered(order: string): Promise<void> {
  for (;;) {
    try {
      await charge(order);
      return;
    } catch {
      // The call failed: the bank may or may not have charged. Ask again with the same key.
    }
  }
}

/** After a restart: every hold gets its timer back, and every payment in progress is charged again. */
export async function onStartup(db: Db): Promise<void> {
  for (const row of await db.unfinished()) {
    if (row.state === "held") scheduleExpiry(db, row.order);
    if (row.state === "paying") await resumePayment(db, row.order);
  }
}
```

What it tells us:

| In the code | In the spec |
| --- | --- |
| the phone app (`phone.ts`), the server (`server.ts`), the card processor's API (`bank.ts`) | three actors: Person, Box office, Bank |
| the `seats` table, updated with conditional `UPDATE … WHERE` statements (`db.ts`) | the box office's `seat`, decided in one step per statement |
| `expiries`, a `Map` of `setTimeout`s, in memory | the `expire` timer, and the `expiring` flag; lost on `crash` |
| the seat's row: free, held, paying, sold | `seat`, kept by `crash({ keeps: ["seat"] })` |
| `handlePay` up to `await chargeUntilAnswered` | the `pay` step, which sends `Charge` |
| `handlePay` after the `await` | the `charged` step |
| the `catch` in `chargeUntilAnswered` | the `chargeFailed` step, on `failed(Charge)` |
| `onStartup` | the `resume` and `rearm` guarded steps |
| `HOLD_MINUTES` | a limit |

Three modelling decisions come out of this reading.

- **The database is not an actor.** The server owns it, and each of its statements is
  conditional and atomic, so each decision the database makes happens inside one of the
  server's steps. If other services wrote to the same table, it would be its own actor, like
  `Seats` in chapter 5.
- **`handlePay` is two steps.** It waits for the bank in the middle, and while it waits,
  anything can happen: an expiry, another request, a restart. A step must end where the code
  `await`s another process.
- **The bank is an actor whose code we don't have.** We model what its API promises
  (idempotent on the key), and point its step at our client for it.

## Sources

Every step can say which code it stands for, with `sources`: an ordered trail from the entry
point inwards.

```ts
    hold: {
      on: Hold,
      description: "Holds the seat for ten minutes, if it is free, and opens an order for it.",
      sources: ["book/code/box-office/src/server.ts#handleHold", "book/code/box-office/src/db.ts:9-10"],
      // …
    },
    pay: {
      on: Pay,
      description: "Charges the card of whoever holds the seat; anyone else's hold has expired.",
      sources: ["book/code/box-office/src/server.ts:19-23", "book/code/box-office/src/db.ts:11-12"],
      // …
    },
    charged: {
      on: Charged,
      description: "The card was charged: sells the seat and sends the ticket.",
      sources: ["book/code/box-office/src/server.ts:24-24", "book/code/box-office/src/db.ts:13-14"],
      // …
    },
```

Each entry is one of:

- `path#symbol`: a function, method, class or constant, found by its definition. Methods are
  `Outer.method` or `Outer::method`. It works in TypeScript, JavaScript, Rust, Swift, Go,
  Python and more.
- `path:start-end`: lines, when there's no symbol. Here, the two halves of `handlePay`, and the
  members of the `Db` interface.

Paths are relative to the repository root. The first `path#symbol` is the root of the step's
call tree in the explorer, which shows the functions that code reaches, each readable in place.

Point each step at the function that does it (`server.ts#handleHold`), not the module or the
class around it. A class is every step at once.

A limit takes sources too:

```ts
const holdLifetime = defineLimit({ name: "Hold lifetime", value: 10, unit: "minutes", sources: ["book/code/box-office/src/server.ts#HOLD_MINUTES"] });
```

`feynman check` resolves every source. One that points at nothing fails the check:

```text
  ✗ source book/code/box-office/src/db.ts#Db.holdIfFree Db.holdIfFree is not defined in book/code/box-office/src/db.ts
```

(That one was ours: an interface's members aren't definitions. We used line ranges instead.)
Never invent a path. If the code doesn't exist yet, leave `sources` out of that step, and check
lists it: *"2 step(s) have no code yet: Box office resume, Box office rearm"*. Faults never
need sources. A lost message is the network's doing, not the code's.

Check also warns when one step's sources span four or more files: *"stands for N pieces of
code in M files"*. A step like that is usually several stages of the code pretending to be
one. Split it.

([`specs/13-code/box-office.ts`](specs/13-code/box-office.ts))

## Locking

Once the spec is right, record what the code looked like:

```sh
feynman lock
```

```text
feynman.lock: 18 source(s) locked
```

`feynman.lock` keeps a hash of the code each source stands for. Commit it with the spec. From
then on, `check` compares, and says when code changed under the spec.

Months later, someone reads `onStartup` and decides the bank will call back anyway:

```ts
export async function onStartup(db: Db): Promise<void> {
  for (const row of await db.unfinished()) {
    if (row.state === "held") scheduleExpiry(db, row.order);
    // Payments in progress finish on their own: the bank calls back.
  }
}
```

```text
  ! stale: src/server.ts#onStartup changed since the spec was last locked; check the steps that name it, then run feynman lock
```

The spec's steps that name `onStartup`, `resume` and `rearm`, may no longer say what the code
does. Check can't know whether they still do. That's for a person: read the change, update the
steps, and lock again.

## Reviewing a change

So the reviewer updates the spec to match the code. `resume` goes, and with it the rule and its
claim. Then they ask the question a review is for: *what does this change do to the system?*

```sh
feynman diff box-office --base HEAD
```

```text
Box office, HEAD (91d9f61) → working tree
Alice buys the last seat: unchanged
The bank's answer is lost: unchanged
A restart mid-payment: changed
    Person.hold
    Box office.hold the seat
    Person.held
    Person.pay
    Box office.pay
    Bank.charge
    Box office.crash
  - Box office.resume
  ~ Box office.charged
  - Bank.charge
    Person.ticket
  - Box office.charged
```

`diff` runs every scenario on both commits and compares their flows. Two are unchanged. The
restart mid-payment no longer resumes: `-` marks events that are gone, `~` events that changed.
In this scenario Alice still gets her ticket, because the bank's first answer was already in
flight. The diff alone looks harmless.

The check doesn't:

```text
  ✗ paymentsEnd  Whoever pays eventually hears back: a ticket, or that their hold expired.
  ✗ stuck: nothing can happen, and the spec does not call this world final (finalState in defineSpec)
```

```text
    shortest counterexample, 7 event(s), needs 2 fault(s):
       1  Person (Person)  hold
       2  Box office (Box office)  hold the seat  {}  from Person
       3  Person (Person)  held  {}  from Box office
       4  Person (Person)  pay
       5  Box office (Box office)  pay  {}  from Person
       6  Bank (Bank)  charge → chargeLost  {"order":"order-1"}  from Box office
       7  Box office (Box office)  crash
    then nothing fair can happen: it stays there forever, and never holds
```

*The charge is lost, and the server restarts before its retry loop notices.* Nobody will ever
charge again, and the buyer's phone says "paying" forever. "The bank calls back" is true for
charges the bank received. This one never arrived.

That is the review: a two-line change to a startup function, and the spec shows the story it
breaks, with the faults it needs. The reviewer can now ask the author the right question:
*what happens to a payment whose charge never reached the bank?*

`feynman dev --base main` shows the same comparison in the explorer, flow by flow.

## Writing the spec first

The other way round works too. When the code doesn't exist yet:

1. Write the spec with no `sources`. Check says *"no step points at code yet; this spec is a
   design"*, which is fine.
2. Check it until the design holds, with its rules.
3. Write the code. As each stage appears, add its `sources` to the step.
4. Lock.

The checker finds design flaws before there is anything to debug, and the spec then keeps
pointing at the code that implements each step. Part I of this book was written that way.

## Exercises

1. `chargeUntilAnswered` retries forever, with no delay between tries. Model the delay as a
   timer. Does any verdict change? Should it?
2. The phone's `pay` waits for one HTTP response. What happens to the person if that response is
   lost after the server sold the seat? Model it: which message is a call, and what does the
   phone do when it fails?
3. Run `feynman lock`, then rename `scheduleExpiry` in the code. What does check say? Which kind
   of change does `lock` catch, and which does only reading catch?
