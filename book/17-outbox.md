# 17. The outbox

> *How do you save something and tell someone about it, when either can fail?*

Two-phase commit (chapter 16) makes two databases agree, and pays for it in locks and blocking.
Most systems don't use it. They save to their own database and publish an event, and let the
rest of the world catch up. That's two writes to two systems, a *dual write*, and there's no
order to do them in that survives a restart. This chapter shows why, and then builds the usual
answer, the transactional outbox, and what it still needs from the consumer.

The system: a shop saves orders, and a warehouse ships them when it hears about them.

## Step 1: save, then publish

([`specs/17-outbox/1-write-then-publish.ts`](specs/17-outbox/1-write-then-publish.ts))

In code, this is two lines:

```ts
await db.insert(order);
await broker.publish({ type: "OrderPlaced", order: order.id });
```

There's an `await` between them, so they're two steps (chapter 13). What the process remembers
between the two is in memory:

```ts
const Shop = defineActor({
  name: "Shop",
  description: "The orders service: saves each order, then tells the warehouse.",
  zone: shopZone,
  singleton: true,
  // `orders` is the database. `publishing` is the order this process is about to announce,
  // in memory: the code is between `await db.insert(order)` and `await broker.publish(…)`.
  initialState: () => ({ orders: new Set<string>(), publishing: null as string | null }),
  actions: {
    placeOrder: {
      with: [atMost(1)],
      label: "Place an order",
      description: "Saves a new order in the database.",
      run(state, _inputs, ctx) {
        const order = ctx.fresh("order");
        state.orders.add(order);
        state.publishing = order;
      },
    },
  },
  transitions: {
    publish: {
      description: "Publishes the order it just saved.",
      when: (s) => s.publishing !== null,
      sends: [OrderPlaced],
      run(state, _, ctx) {
        ctx.send(ctx.the(Warehouse), OrderPlaced, { order: state.publishing! });
        state.publishing = null;
      },
    },
    crash: crash({ keeps: ["orders"], spend: faults }),
  },
});
```

Three properties say what we want:

```ts
const everyOrderShips = defineProperty("everyOrderShips", {
  description: "Every order saved is eventually shipped.",
  leadsTo: {
    whenever: (w) => [...w.the(Shop).state.orders].some((o) => !w.the(Warehouse).state.shipments.includes(o)),
    then: (w) => [...w.the(Shop).state.orders].every((o) => w.the(Warehouse).state.shipments.includes(o)),
  },
});

const onlyOrdersShip = defineProperty("onlyOrdersShip", {
  description: "Nothing ships that was not ordered.",
  always: (w) => w.the(Warehouse).state.shipments.every((o) => w.the(Shop).state.orders.has(o)),
});

const shippedOnce = defineProperty("shippedOnce", {
  description: "No order ships twice.",
  always: (w) => new Set(w.the(Warehouse).state.shipments).size === w.the(Warehouse).state.shipments.length,
});
```

```text
  ✗ everyOrderShips  Every order saved is eventually shipped.
    shortest counterexample, 2 event(s), needs 1 fault(s):
       1  Shop (Shop)  placeOrder
          orders: [] → ["order-1"]
          publishing: null → "order-1"
       2  Shop (Shop)  crash
          publishing: "order-1" → null
    then nothing fair can happen: it stays there forever, and never holds
  ✓ onlyOrdersShip  Nothing ships that was not ordered.
  ✓ shippedOnce  No order ships twice.
```

*The order is saved, and the shop restarts before it publishes.* The customer has an order
confirmation, and the warehouse will never hear of it. One restart, at the wrong moment: a
deploy, an out-of-memory kill, a node drained.

## Step 2: publish, then save

Swap them ([`specs/17-outbox/2-publish-then-write.ts`](specs/17-outbox/2-publish-then-write.ts)):

```ts
    placeOrder: {
      with: [atMost(1)],
      label: "Place an order",
      description: "Publishes a new order, before saving it.",
      sends: [OrderPlaced],
      run(state, _inputs, ctx) {
        const order = ctx.fresh("order");
        ctx.send(ctx.the(Warehouse), OrderPlaced, { order });
        state.saving = order;
      },
    },
  },
  transitions: {
    save: {
      description: "Saves the order it just published.",
      when: (s) => s.saving !== null,
      run(state) {
        state.orders.add(state.saving!);
        state.saving = null;
      },
    },
```

```text
  ✓ everyOrderShips  Every order saved is eventually shipped.
  ✗ onlyOrdersShip  Nothing ships that was not ordered.
    shortest counterexample, 2 event(s), needs no faults:
       1  Shop (Shop)  placeOrder
          saving: null → "order-1"
       2  Warehouse (Warehouse)  order placed  {"order":"order-1"}  from Shop
          shipments: [] → ["order-1"]
          ✗ breaks onlyOrdersShip
```

Worse: it needs no faults. *The warehouse hears about the order before the shop has saved
it.* If the warehouse looks the order up for the address, it isn't there yet. And with one
restart between the two lines, it never will be. The warehouse ships an order that doesn't
exist.

Neither order works, because there are two systems and no transaction spans both.

## Step 3: the outbox

The fix is to make it one write. Save the order *and the event* in the same database, in one
transaction. A separate loop, the relay, reads the events and publishes them, and deletes each
one once the broker has it
([`specs/17-outbox/3-the-outbox.ts`](specs/17-outbox/3-the-outbox.ts)):

```ts
  // `orders` and `outbox` are tables in one database. `sending` is the event the relay is
  // publishing, in memory.
  initialState: () => ({ orders: new Set<string>(), outbox: new Set<string>(), sending: null as string | null }),
  actions: {
    placeOrder: {
      with: [atMost(1)],
      label: "Place an order",
      description: "Saves a new order and its event, in one transaction.",
      run(state, _inputs, ctx) {
        const order = ctx.fresh("order");
        state.orders.add(order);
        state.outbox.add(order);
      },
    },
  },
```

Publishing is now a call to a broker, which acknowledges it:

```ts
// A call: the relay hears if publishing fails, as the broker client throws.
const Publish = defineCall("Publish", { order: String }, { over: "broker" });
```

```ts
    relay: {
      description: "Publishes the next event in the outbox.",
      when: (s) => s.sending === null && s.outbox.size > 0,
      sends: [Publish],
      run(state, _, ctx) {
        const [order] = state.outbox;
        state.sending = order!;
        ctx.send(ctx.the(Broker), Publish, { order: order! });
      },
    },
    published: {
      on: Published,
      description: "The broker has the event: deletes it from the outbox.",
      run(state, msg) {
        state.outbox.delete(msg.order);
        state.sending = null;
      },
    },
    publishFailed: {
      on: failed(Publish),
      description: "Publishing failed: leaves the event in the outbox, to publish again.",
      run: (state) => void (state.sending = null),
    },
    crash: crash({ keeps: ["orders", "outbox"], spend: faults }),
```

The broker can lose a publish, or lose its acknowledgement:

```ts
    publishLost: lose(Publish, { spend: faults }),
    // A lost acknowledgement fails the call too: the broker has the event, and the relay cannot tell.
    publishedLost: lose(Published, { fails: Publish, spend: faults }),
```

```text
  ✓ everyOrderShips  Every order saved is eventually shipped.
  ✓ onlyOrdersShip  Nothing ships that was not ordered.
  ✗ shippedOnce  No order ships twice.
    shortest counterexample, 8 event(s), needs 1 fault(s):
       1  Shop (Shop)  placeOrder
          outbox: [] → ["order-1"]
       2  Shop (Shop)  relay
          sending: null → "order-1"
       3  Shop (Shop)  crash
          sending: "order-1" → null
       4  Shop (Shop)  relay
          sending: null → "order-1"
       5  Broker (Broker)  publish  {"order":"order-1"}  from Shop
       6  Broker (Broker)  publish  {"order":"order-1"}  from Shop
       7  Warehouse (Warehouse)  order placed  {"order":"order-1"}  from Broker
          shipments: [] → ["order-1"]
       8  Warehouse (Warehouse)  order placed  {"order":"order-1"}  from Broker
          shipments: ["order-1"] → ["order-1","order-1"]
          ✗ breaks shippedOnce
```

The first two properties hold now. An order is saved if and only if its event is, so every order
ships, and only orders ship. But the relay can't know whether a publish went through before it
deletes the row. *It publishes, restarts before it hears back, and publishes again.* A lost
acknowledgement does the same. The outbox turns "maybe never" into "at least once".

That's the trade every messaging system makes: exactly-once delivery isn't on offer. At least
once is, if the consumer can cope with repeats.

## Step 4: the consumer remembers

The warehouse keeps the orders it has shipped, in its own database, in the same transaction as
the shipment, and ignores repeats. And since most brokers deliver at least once too, the broker
may now duplicate a delivery
([`specs/17-outbox/4-idempotent.ts`](specs/17-outbox/4-idempotent.ts)):

```ts
const dedupe = defineRule("dedupe", { description: "The warehouse ignores an order it has already shipped." });
```

```ts
  // `seen` is a table in the warehouse's database, written in the same transaction as the shipment.
  initialState: () => ({ shipments: [] as string[], seen: new Set<string>() }),
  transitions: {
    ship: {
      on: OrderPlaced,
      description: "Ships the order, unless it has shipped it already.",
      run(state, msg) {
        if (dedupe.on && state.seen.has(msg.order)) return;
        state.seen.add(msg.order);
        state.shipments.push(msg.order);
      },
    },
    // At-least-once delivery: the broker may deliver an event twice.
    deliveredTwice: duplicate(OrderPlaced, { spend: faults }),
  },
```

```text
  ✓ everyOrderShips  Every order saved is eventually shipped.
  ✓ onlyOrdersShip  Nothing ships that was not ordered.
  ✓ shippedOnce  No order ships twice.
  rules
    ✓ dedupe  needed: without it, shippedOnce breaks (6 events)
```

Notice the comment on `seen`: *written in the same transaction as the shipment*. If the
warehouse recorded the order after shipping, in a second write, a restart between the two would
ship it twice. That's step 1's bug again, one system along. Exercise 2 checks it.

## The pattern

Every dual write has this shape, and the fix is always the same two halves:

1. **Make the sender's write atomic.** Put the state and the intent to tell in one transaction:
   an outbox table, a change-data-capture log, an event-sourced store.
2. **Make the receiver idempotent.** It will see some messages twice, so it must recognise them:
   by a key it records in the same transaction as its effect.

This is chapter 8's idempotency key again, with a broker in the middle. Chapter 15's ticket
bug was a dual write too: a database write and an HTTP response.

## What we left out

- **The broker's own durability.** We assume an acknowledged event is never lost. Real brokers
  make that true with replication, which is a spec of its own.
- **Ordering.** With one order, nothing can arrive out of order. With two, an outbox relay
  that publishes in parallel can deliver "cancelled" before "placed" (exercise 3).
- **Cleaning up `seen`.** It grows forever. Real systems keep it for longer than the broker can
  redeliver.

## Exercises

1. In step 1, add a sweeper: a guarded step that publishes every saved order the warehouse
   hasn't shipped. Why can't the shop write that step? What would it need to know?
2. In step 4, split `ship` in two: one step ships, the next records the order in `seen`. Add
   `crash` to the warehouse. Which property breaks, and in how many events?
3. Let the shop place two orders (`atMost(2)`), and add an `OrderCancelled` event for the first.
   Can the warehouse see the cancellation before the order? What would make it impossible?
