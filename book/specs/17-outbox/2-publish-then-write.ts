// Chapter 17, step 2: the other order. The shop publishes first, then saves.
//
// Expected: `onlyOrdersShip` breaks with one fault: the shop restarts between publishing and
// saving, and the warehouse ships an order that does not exist.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

const OrderPlaced = defineMessage("OrderPlaced", { order: String }, { name: "order placed", over: "broker" });

const shopZone = defineZone({ name: "Shop", description: "the orders service and its database", place: { column: 0 } });
const warehouseZone = defineZone({ name: "Warehouse", place: { column: 1 } });

const Shop = defineActor({
  name: "Shop",
  description: "The orders service: tells the warehouse about each order, then saves it.",
  zone: shopZone,
  singleton: true,
  // `orders` is the database. `saving` is the order this process announced and is about to
  // save, in memory: the code is between `await broker.publish(…)` and `await db.insert(order)`.
  initialState: () => ({ orders: new Set<string>(), saving: null as string | null }),
  display: { icon: "server", status: (s) => `${s.orders.size} order(s)` },
  actions: {
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
    crash: crash({ keeps: ["orders"], spend: faults }),
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
  actors: [Shop, Warehouse],
  properties: [everyOrderShips, onlyOrdersShip, shippedOnce],
  finalState: { description: "Nothing is in flight.", when: (w) => w.quiet && w.the(Shop).state.saving === null },
});
