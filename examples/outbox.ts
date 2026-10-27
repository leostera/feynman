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
import { defineSpec, message } from "@leostera/feynman";

export function outbox(variant: "buggy" | "fixed") {
  return defineSpec(
    `Outbox (${variant})`,
    {
      messages: {
        PlaceOrder: message<{}>({ name: "place order" }),
        OrderPlaced: message<{}>({ name: "order placed" }),
      },
    },
    (spec) => {
      const { PlaceOrder, OrderPlaced } = spec.messages;
      const zone = spec.defineZone({ name: "Shop" });

      const Mailer = spec.defineActor({
        name: "Mailer",
        zone,
        singleton: true,
        initialState: () => ({ announced: 0 }),
        transitions: { [OrderPlaced]: { description: "Emails the customer.", run: (state) => void (state.announced += 1) } },
      });

      const Shop = spec.defineActor({
        name: "Shop",
        zone,
        // Orders are in the database either way; fixed, so is the outbox.
        durable: variant === "fixed" ? ["orders", "outbox"] : ["orders"],
        initialState: () => ({ orders: 0, outbox: 0 }),
        transitions: {
          [PlaceOrder]: {
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
            run(state, ctx) {
              state.outbox -= 1;
              ctx.send(ctx.the(Mailer), OrderPlaced, {});
            },
          },
        },
      });

      const Customer = spec.defineActor({
        name: "Customer",
        zone,
        singleton: true,
        initialState: () => ({}),
        actions: {
          order: { label: "Order", description: "Places an order.", sends: [PlaceOrder], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Shop), PlaceOrder, {}) },
        },
      });

      spec.defineInvariants({
        announcedOnceQuiet: {
          description: "Once nothing is in flight or queued, every stored order has been announced.",
          always: (w) => !w.quiet || w.the(Shop).state.outbox > 0 || w.the(Mailer).state.announced === w.the(Shop).state.orders,
        },
      });
      return { Mailer, Shop, Customer };
    },
  );
}

/** `feynman check outbox` checks the buggy variant, so you see the checker find the bug. */
export default outbox("buggy");
export const fixed = outbox("fixed");
