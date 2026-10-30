// A transactional outbox.
//
// A shop stores an order, then announces it to a mailer. Storing and announcing are two
// steps; whatever is to be announced waits in a queue in between. Kept in memory, that
// queue is lost when the shop restarts between the two: the order is stored and never
// announced. The fix: the outbox is a table in the same database as the orders, written in
// the same step, so it survives a restart and is drained afterwards. A lost announcement is
// another matter: the outbox hands it to the network once, and would need the mailer's
// acknowledgement to send it again.
//
// This covers guarded transitions draining durable state, and restarts.
//
// Expected: buggy breaks `announcedOnceQuiet` in 3 steps with one fault (order, the shop
// stores it, the shop restarts); fixed holds through a restart, and breaks in 4 when the
// announcement is lost (order, store, announce, lost).
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

const PlaceOrder = defineMessage("PlaceOrder");
const OrderPlaced = defineMessage("OrderPlaced");

export function outbox(variant: "buggy" | "fixed") {
  const customers = defineZone({ name: "Customers", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Shop", description: "stores an order, then announces it", place: { column: 1, arrange: "row", region: true } });

  const Mailer = defineActor({
    name: "Mailer",
    zone,
    singleton: true,
    initialState: () => ({ announced: 0 }),
    place: { order: 1 },
    display: { icon: "mail", status: (s) => `${s.announced} email(s) sent`, mood: (s) => (s.announced ? "ok" : "off") },
    transitions: { orderPlaced: { on: OrderPlaced, description: "Emails the customer.", run: (state) => void (state.announced += 1) } },
  });

  const Shop = defineActor({
    name: "Shop",
    zone,
    // Orders are in the database either way; fixed, so is the outbox.
    durable: variant === "fixed" ? ["orders", "outbox"] : ["orders"],
    initialState: () => ({ orders: 0, outbox: 0 }),
    place: { order: 0 },
    display: {
      icon: "server",
      status: (s) => `${s.orders} order(s)${s.outbox ? `, ${s.outbox} to announce` : ""}`,
      mood: (s) => (s.outbox ? "busy" : "ok"),
      rows: (s) => [
        { label: "orders", detail: String(s.orders) },
        { label: variant === "buggy" ? "queue, in memory" : "outbox table", detail: String(s.outbox), mood: s.outbox ? ("busy" as const) : ("off" as const) },
      ],
    },
    transitions: {
      placeOrder: {
        on: PlaceOrder,
        description: "Stores the order, and queues its announcement.",
        run(state) {
          state.orders += 1;
          state.outbox += 1;
        },
      },
      publish: {
        description: "Announces the next queued order.",
        when: (state) => state.outbox > 0,
        sends: [OrderPlaced],
        run(state, _, ctx) {
          state.outbox -= 1;
          ctx.send(ctx.the(Mailer), OrderPlaced, {});
        },
      },
    },
  });

  const Customer = defineActor({
    name: "Customer",
    zone: customers,
    singleton: true,
    initialState: () => ({}),
    display: { icon: "person", status: () => "shopping" },
    actions: {
      order: { label: "Order", description: "Places an order.", sends: [PlaceOrder], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Shop), PlaceOrder, {}) },
    },
  });

  const announcedOnceQuiet = defineProperty("announcedOnceQuiet", {
    description: "Once nothing is in flight or queued, every stored order has been announced.",
    always: (w) => !w.quiet || w.the(Shop).state.outbox > 0 || w.the(Mailer).state.announced === w.the(Shop).state.orders,
  });

  const anOrder = defineScenario("An order", {
    description: "The shop stores the order and announces it; the mailer emails the customer.",
    run(s) {
      s.spawn(Shop, "Shop");
      s.act(s.the(Customer), "order");
      s.settle();
    },
  });

  const theShopRestartsAfterStoring = defineScenario("The shop restarts after storing", {
    description:
      variant === "buggy"
        ? "The shop stores the order and restarts before announcing it: the announcement, queued in memory, is gone."
        : "The shop stores the order and restarts before announcing it: the outbox is on disk, and the announcement goes out after the restart.",
    run(s) {
      const shop = s.spawn(Shop, "Shop");
      s.act(s.the(Customer), "order");
      s.deliver(shop, PlaceOrder);
      s.restart(shop);
      s.settle();
    },
  });

  return defineSpec({
    name: `Outbox (${variant})`,
    actors: [Mailer, Shop, Customer],
    properties: [announcedOnceQuiet],
    scenarios: [anOrder, theShopRestartsAfterStoring],
  });
}

/** `feynman check outbox` checks the buggy variant, so you see the checker find the bug. */
export default outbox("buggy");
export const fixed = outbox("fixed");
