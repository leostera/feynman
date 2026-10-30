// Chapter 17, step 3: the outbox. The order and the event are saved in one transaction, and a
// relay publishes the event later, deleting it once the broker has it.
//
// Expected: `everyOrderShips` and `onlyOrdersShip` hold; `shippedOnce` breaks with one fault:
// the relay publishes, the broker's acknowledgement is lost, and the relay publishes again.
import { atMost, budget, crash, defineActor, defineCall, defineMessage, defineProperty, defineSpec, defineZone, failed, lose } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

// A call: the relay hears if publishing fails, as the broker client throws.
const Publish = defineCall("Publish", { order: String }, { over: "broker" });
const Published = defineMessage("Published", { order: String }, { tone: "reply" });
const OrderPlaced = defineMessage("OrderPlaced", { order: String }, { name: "order placed", over: "broker" });

const shopZone = defineZone({ name: "Shop", description: "the orders service and its database", place: { column: 0 } });
const brokerZone = defineZone({ name: "Broker", description: "the message queue", place: { column: 1 } });
const warehouseZone = defineZone({ name: "Warehouse", place: { column: 2 } });

const Shop = defineActor({
  name: "Shop",
  description: "The orders service: saves each order and its event together; a relay publishes the events.",
  zone: shopZone,
  singleton: true,
  // `orders` and `outbox` are tables in one database. `sending` is the event the relay is
  // publishing, in memory.
  initialState: () => ({ orders: new Set<string>(), outbox: new Set<string>(), sending: null as string | null }),
  display: { icon: "server", status: (s) => `${s.orders.size} order(s), ${s.outbox.size} event(s) to publish` },
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
  transitions: {
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
  },
});

const Broker = defineActor({
  name: "Broker",
  description: "The message queue between the shop and the warehouse.",
  zone: brokerZone,
  singleton: true,
  initialState: () => ({}),
  display: { icon: "queue" },
  transitions: {
    publish: {
      on: Publish,
      description: "Takes the event, delivers it to the warehouse, and acknowledges it.",
      sends: [OrderPlaced, Published],
      run(_state, msg, ctx) {
        ctx.send(ctx.the(Warehouse), OrderPlaced, msg);
        ctx.reply(Published, msg);
      },
    },
    publishLost: lose(Publish, { spend: faults }),
    // A lost acknowledgement fails the call too: the broker has the event, and the relay cannot tell.
    publishedLost: lose(Published, { fails: Publish, spend: faults }),
  },
});

const Warehouse = defineActor({
  name: "Warehouse",
  description: "Ships what it hears was ordered.",
  zone: warehouseZone,
  singleton: true,
  initialState: () => ({ shipments: [] as string[] }),
  display: { icon: "box", status: (s) => `${s.shipments.length} shipment(s)` },
  transitions: {
    ship: {
      on: OrderPlaced,
      description: "Ships the order.",
      run: (state, msg) => void state.shipments.push(msg.order),
    },
  },
});

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

export default defineSpec({
  name: "Orders",
  description: "An order saved in one database, and an event that tells the warehouse.",
  actors: [Shop, Broker, Warehouse],
  properties: [everyOrderShips, onlyOrdersShip, shippedOnce],
  finalState: { description: "Every event is published.", when: (w) => w.quiet && w.the(Shop).state.outbox.size === 0 },
});
