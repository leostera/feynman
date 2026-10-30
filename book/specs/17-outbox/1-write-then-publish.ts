// Chapter 17, step 1: the shop saves the order, then publishes an event about it.
//
// Expected: `everyOrderShips` breaks with one fault: the shop restarts between saving the
// order and publishing it, and the warehouse never hears.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

const OrderPlaced = defineMessage("OrderPlaced", { order: String }, { name: "order placed", over: "broker" });

const shopZone = defineZone({ name: "Shop", description: "the orders service and its database", place: { column: 0 } });
const warehouseZone = defineZone({ name: "Warehouse", place: { column: 1 } });

const Shop = defineActor({
  name: "Shop",
  description: "The orders service: saves each order, then tells the warehouse.",
  zone: shopZone,
  singleton: true,
  // `orders` is the database. `publishing` is the order this process is about to announce,
  // in memory: the code is between `await db.insert(order)` and `await broker.publish(…)`.
  initialState: () => ({ orders: new Set<string>(), publishing: null as string | null }),
  display: { icon: "server", status: (s) => `${s.orders.size} order(s)` },
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
  finalState: { description: "Nothing is in flight.", when: (w) => w.quiet && w.the(Shop).state.publishing === null },
});
