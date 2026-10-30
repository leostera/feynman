// Payments retried without idempotency.
//
// A client asks the bank to debit an account and retries if no answer comes within a second.
// Without an idempotency key, a retry that crosses a slow first request debits twice: no
// fault needed, only a network slower than the retry timer. The fix: the bank remembers
// request ids and answers a repeat without debiting again.
//
// Expected: buggy breaks `debitedOnce` in 4 steps (pay, retry, debit, debit) with no fault;
// fixed holds. `paymentsSettle` is unfinished: each retry adds a copy in flight, so the
// worlds never run out, and a loop that never confirms could lie past any depth.
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

const Debit = defineMessage("Debit", { id: String, amount: Number });
const Debited = defineMessage("Debited", { id: String }, { tone: "reply" });

export function payments(variant: "buggy" | "fixed") {
  const people = defineZone({ name: "Customers", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Payments", description: "the bank debits what it is asked to", place: { column: 1 } });

  const Bank = defineActor({
    name: "Bank",
    zone,
    singleton: true,
    initialState: () => ({ balance: 100, debits: 0, seen: [] as string[] }),
    display: {
      icon: "database",
      status: (s) => `balance ${s.balance} · ${s.debits} debit(s)`,
      mood: (s) => (s.debits > s.seen.length ? "bad" : "ok"),
      rows: (s) => s.seen.map((id) => ({ group: "payments", label: id, detail: "debited" })),
    },
    transitions: {
      debit: {
        on: Debit,
        description: "Debits the account and confirms.",
        say: (s, msg) => (variant === "fixed" && s.seen.filter((id) => id === msg.id).length && s.debits === s.seen.length ? `Debited ${msg.id}, or had already: confirms` : `Debits ${msg.amount} for ${msg.id}: balance ${s.balance}`),
        sends: [Debited],
        run(state, msg, ctx) {
          if (variant === "fixed" && state.seen.includes(msg.id)) return ctx.reply(Debited, { id: msg.id });
          state.balance -= msg.amount;
          state.debits += 1;
          state.seen.push(msg.id);
          ctx.reply(Debited, { id: msg.id });
        },
      },
    },
  });

  const Client = defineActor({
    name: "Client",
    zone: people,
    symmetric: true,
    // A client that retries keeps its outbox on disk: a restart must not forget a payment.
    durable: ["paid", "pending"],
    initialState: () => ({ paid: 0, pending: null as string | null }),
    display: {
      icon: "phone",
      names: ["Ada", "Grace"],
      status: (s) => (s.pending ? `paying ${s.pending}` : s.paid ? `${s.paid} payment(s) made` : "ready to pay"),
      mood: (s) => (s.pending ? "busy" : "ok"),
    },
    actions: {
      pay: {
        label: "Pay",
        description: "Pays 10, retrying until the bank confirms.",
        when: (state) => state.pending === null,
        sends: [Debit],
        starts: ["retry"],
        run(state, _inputs, ctx) {
          state.pending = ctx.fresh("payment");
          state.paid += 1;
          ctx.send(ctx.the(Bank), Debit, { id: state.pending, amount: 10 });
          ctx.start("retry");
        },
      },
    },
    transitions: {
      debited: {
        on: Debited,
        description: "The payment went through.",
        run(state, msg, ctx) {
          if (state.pending !== msg.id) return;
          state.pending = null;
          ctx.cancel("retry");
        },
      },
      retry: {
        description: "No answer yet: send the same payment again.",
        after: "1 second",
        sends: [Debit],
        starts: ["retry"],
        run(state, _, ctx) {
          if (!state.pending) return;
          ctx.send(ctx.the(Bank), Debit, { id: state.pending, amount: 10 });
          ctx.start("retry");
        },
      },
    },
  });

  const debitedOnce = defineProperty("debitedOnce", {
    description: "The bank debits once per payment, however often it is asked.",
    always: (w) => w.the(Bank).state.debits <= w.all(Client).reduce((n, c) => n + c.state.paid, 0),
  });

  const paymentsSettle = defineProperty("paymentsSettle", {
    description: "A payment in flight is eventually confirmed.",
    leadsTo: { whenever: (w) => w.all(Client).some((c) => c.state.pending !== null), then: (w) => w.all(Client).every((c) => c.state.pending === null) },
  });

  const aPayment = defineScenario("A payment", {
    description: "Ada pays 10; the bank debits it and confirms.",
    run(s) {
      const ada = s.spawn(Client, "Ada");
      s.act(ada, "pay");
      s.settle();
    },
  });

  const theRetryFiresFirst = defineScenario("The retry fires first", {
    description:
      variant === "buggy"
        ? "Ada's retry goes out before the bank's answer arrives, and the bank debits the same payment twice."
        : "Ada's retry goes out before the bank's answer arrives; the bank knows the payment, and confirms without debiting again.",
    run(s) {
      const ada = s.spawn(Client, "Ada");
      s.act(ada, "pay");
      s.fire(ada, "retry");
      s.settle();
    },
  });

  return defineSpec({
    name: `Payments (${variant})`,
    actors: [Bank, Client],
    properties: [debitedOnce, paymentsSettle],
    scenarios: [aPayment, theRetryFiresFirst],
  });
}

/** `feynman check payments` checks the buggy variant, so you see the checker find the bug. */
export default payments("buggy");
export const fixed = payments("fixed");
