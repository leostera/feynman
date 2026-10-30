// A client that retries a payment when the call to the bank fails.
//
// The client charges a customer through an RPC to the bank. When the call throws, it sends the
// same charge again: the code's catch block. But a call can fail after the bank has done the
// work, when its answer is lost on the way back, and the client cannot tell that apart from a
// request that never arrived. Retrying then charges the customer twice. The fix: an
// idempotency key. The bank remembers the payments it has charged, and answers a repeat
// without charging again.
//
// This covers calls whose failure reaches the caller (RFD0009), at-least-once retries, and
// idempotency keys.
//
// Expected: buggy holds without faults, and breaks `chargedOnce` in 5 steps with one (the bank
// charges, its answer is lost, the call fails, the client retries, the bank charges again);
// fixed holds, with faults too. Every payment ends, in both: the retry is fair.
import { defineActor, defineCall, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineZone, failed } from "@leostera/feynman";

const PAYMENT = "pay-1";

const Charge = defineCall("Charge", { payment: String }, { over: "rpc" });
const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });

export function retriedCall(variant: "buggy" | "fixed") {
  const shop = defineZone({ name: "Shop", description: "takes the order and pays for it", place: { column: 0 } });
  const bank = defineZone({ name: "Bank", description: "moves the money", place: { column: 1, region: true } });
  // The fix, as a rule of the design: `feynman check retried-call --without idempotencyKey` shows what it prevents.
  const idempotencyKey = defineRule("idempotencyKey", { description: "The bank remembers the payments it has charged, and charges each one once." });
  const remembers = variant === "fixed";

  const Client = defineActor({
    name: "Client",
    zone: shop,
    singleton: true,
    initialState: () => ({ paying: false, paid: false }),
    display: {
      icon: "browser",
      status: (s) => (s.paid ? "paid" : s.paying ? "paying" : "not paid"),
      mood: (s) => (s.paid ? "ok" : s.paying ? "busy" : "off"),
    },
    actions: {
      pay: {
        label: "Pay",
        description: "Charges the customer for the order, through the bank.",
        when: (s) => !s.paying && !s.paid,
        sends: [Charge],
        run(state, _inputs, ctx) {
          state.paying = true;
          ctx.send(ctx.the(Bank), Charge, { payment: PAYMENT });
        },
      },
    },
    transitions: {
      charged: {
        on: Charged,
        description: "The bank charged the payment: the order is paid.",
        run(state) {
          state.paying = false;
          state.paid = true;
        },
      },
      chargeFailed: {
        on: failed(Charge),
        description: "The call threw: the client sends the same charge again.",
        sends: [Charge],
        say: (_s, failure) => `Retries ${failure.payload.payment}`,
        run(_state, failure, ctx) {
          ctx.send(failure.to, Charge, failure.payload);
        },
      },
    },
  });

  const Bank = defineActor({
    name: "Bank",
    zone: bank,
    singleton: true,
    initialState: () => ({ charges: 0, seen: [] as string[] }),
    display: {
      icon: "card",
      status: (s) => `charged ${s.charges} time(s)`,
      mood: (s) => (s.charges > 1 ? "bad" : "ok"),
    },
    transitions: {
      charge: {
        on: Charge,
        description:
          !remembers
            ? "Charges the customer and answers."
            : "Charges the customer, unless it has charged this payment already, and answers.",
        sends: [Charged],
        say: (s) => (s.charges > 1 ? "Charges the customer again" : "Charges the customer"),
        run(state, msg, ctx) {
          const keyed = remembers && idempotencyKey.on;
          if (!keyed || !state.seen.includes(msg.payment)) {
            state.charges += 1;
            if (keyed) state.seen.push(msg.payment);
          }
          ctx.reply(Charged, { payment: msg.payment });
        },
      },
    },
  });

  const chargedOnce = defineProperty("chargedOnce", { description: "The customer is never charged twice.", always: (w) => w.the(Bank).state.charges <= 1, needs: [idempotencyKey] });

  const paymentsEnd = defineProperty("paymentsEnd", {
    description: "A payment in progress ends paid.",
    leadsTo: { whenever: (w) => w.the(Client).state.paying, then: (w) => w.the(Client).state.paid },
  });

  const aPayment = defineScenario("A payment", {
    description: "The bank charges once and answers; the order is paid.",
    run(s) {
      s.act(s.the(Client), "pay");
      s.settle();
    },
  });

  const theAnswerIsLost = defineScenario("The answer is lost", {
    description:
      variant === "buggy"
        ? "The bank charges, its answer is lost, the call throws, and the client retries: the customer is charged twice."
        : "The bank charges, its answer is lost, the call throws, and the client retries: the bank recognises the payment and answers without charging.",
    run(s) {
      s.act(s.the(Client), "pay");
      s.deliver(s.the(Bank), Charge);
      s.drop(s.the(Client), Charged);
      s.settle();
    },
  });

  return defineSpec({
    name: `Retried call (${variant})`,
    actors: [Client, Bank],
    rules: [idempotencyKey],
    properties: [chargedOnce, paymentsEnd],
    finalState: { description: "The order is paid.", when: (w) => w.the(Client).state.paid },
    scenarios: [aPayment, theAnswerIsLost],
  });
}

/** `feynman check retried-call` checks the buggy variant, so you see the checker find the bug. */
export default retriedCall("buggy");
export const fixed = retriedCall("fixed");
