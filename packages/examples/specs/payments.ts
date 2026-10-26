// Payments retried without idempotency.
//
// A client asks the bank to debit an account and retries if no answer comes within a second.
// Without an idempotency key, a retry that crosses a slow first request debits twice: no
// fault needed, only a network slower than the retry timer. The fix: the bank remembers
// request ids and answers a repeat without debiting again.
//
// Expected: buggy breaks `debitedOnce` in 4 steps (pay, retry, debit, debit) with no fault;
// fixed holds, and every payment settles even when one message is lost.
import { defineSpec, message, SEC } from "@feynman/spec";

export function payments(variant: "buggy" | "fixed") {
  return defineSpec(
    `Payments (${variant})`,
    {
      messages: {
        Debit: message<{ id: string; amount: number }>({ name: "debit" }),
        Debited: message<{ id: string }>({ name: "debited", tone: "reply" }),
      },
    },
    (spec) => {
      const { Debit, Debited } = spec.messages;
      const zone = spec.defineZone({ name: "Payments" });

      const Bank = spec.defineActor({
        name: "Bank",
        zone,
        singleton: true,
        initialState: () => ({ balance: 100, debits: 0, seen: [] as string[] }),
        transitions: {
          [Debit]: {
            description: "Debits the account and confirms.",
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

      const Client = spec.defineActor({
        name: "Client",
        zone,
        symmetric: true,
        // A client that retries keeps its outbox on disk: a restart must not forget a payment.
        durable: ["paid", "pending"],
        initialState: () => ({ paid: 0, pending: null as string | null }),
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
              ctx.start("retry", 1 * SEC);
            },
          },
        },
        transitions: {
          [Debited]: {
            description: "The payment went through.",
            run(state, msg, ctx) {
              if (state.pending !== msg.id) return;
              state.pending = null;
              ctx.cancel("retry");
            },
          },
          retry: {
            description: "No answer yet: send the same payment again.",
            sends: [Debit],
            starts: ["retry"],
            run(state, ctx) {
              if (!state.pending) return;
              ctx.send(ctx.the(Bank), Debit, { id: state.pending, amount: 10 });
              ctx.start("retry", 1 * SEC);
            },
          },
        },
      });

      spec.defineInvariants({
        debitedOnce: {
          description: "The bank debits once per payment, however often it is asked.",
          always: (w) => w.the(Bank).state.debits <= w.all(Client).reduce((n, c) => n + c.state.paid, 0),
        },
        paymentsSettle: {
          description: "A payment in flight is eventually confirmed.",
          after: (w) => w.all(Client).some((c) => c.state.pending !== null),
          eventually: (w) => w.all(Client).every((c) => c.state.pending === null),
          within: 10 * SEC,
        },
      });
      return { Bank, Client };
    },
  );
}
