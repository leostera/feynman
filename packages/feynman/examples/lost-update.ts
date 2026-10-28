// Withdrawals that read a balance, then write a new one.
//
// Two tellers withdraw from one account of 100. Each reads the balance, checks it covers the
// amount, and writes back the balance less the amount. If both read before either writes,
// the second write overwrites the first: one withdrawal is paid out but never taken off the
// balance, a lost update (and, with two large ones, an overdraft nobody checked). The fix:
// compare-and-set. A write names the version it read, the account refuses it if the version
// has moved on, and the teller reads again and retries.
//
// This covers read-modify-write races, optimistic concurrency, and a retry as a guarded
// step: one the teller can take whenever it is in conflict, not on a timer.
//
// Expected, with two tellers: buggy breaks `moneyAddsUp` in 8 steps without faults (both
// ask, both hear 100, both write); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

const OPENING = 100;

export function lostUpdate(variant: "buggy" | "fixed") {
  return defineSpec(
    `Lost update (${variant})`,
    {
      messages: {
        Get: message<{}>({ name: "get" }),
        Balance: message<{ balance: number; version: number }>({ name: "balance", tone: "reply" }),
        // `amount` is what the write pays out, so the account can keep its books.
        Set: message<{ balance: number; version: number; amount: number }>({ name: "set" }),
        Ok: message<{}>({ name: "ok", tone: "reply" }),
        Conflict: message<{}>({ name: "conflict", tone: "refused" }),
      },
    },
    (spec) => {
      const { Get, Balance, Set, Ok, Conflict } = spec.messages;
      const branch = spec.defineZone({ name: "Branch", description: "tellers paying out cash", place: { column: 0 } });
      const core = spec.defineZone({ name: "Core banking", description: "one account, opened with 100", place: { column: 1, region: true } });

      type Status = "idle" | "reading" | "writing" | "conflict";

      const Teller = spec.defineActor({
        name: "Teller",
        zone: branch,
        symmetric: true,
        durable: ["paid"],
        initialState: () => ({ status: "idle" as Status, amount: 0, paid: 0 }),
        display: {
          icon: "person",
          status: (s) => (s.status === "idle" ? (s.paid ? `paid out ${s.paid}` : "idle") : `${s.status}: ${s.amount}`),
          mood: (s) => (s.status === "conflict" ? "warn" : s.status === "idle" ? "info" : "busy"),
        },
        actions: {
          withdraw: {
            label: "Withdraw",
            description: "Starts a withdrawal by asking for the balance.",
            when: (state) => state.status === "idle",
            inputs: { amount: { type: [30, 80] as const } },
            sends: [Get],
            run(state, inputs, ctx) {
              state.status = "reading";
              state.amount = inputs.amount;
              ctx.send(ctx.the(Account), Get, {});
            },
          },
        },
        transitions: {
          [Balance]: {
            description: variant === "buggy" ? "Writes back the balance less the amount, or gives up if it does not cover it." : "Writes back the balance less the amount, naming the version it read, or gives up if it does not cover it.",
            sends: [Set],
            say: (s, msg) => (s.status === "idle" ? `Declines: ${msg.balance} does not cover it` : `Writes ${msg.balance - s.amount}`),
            run(state, msg, ctx) {
              if (state.status !== "reading") return;
              if (msg.balance < state.amount) return void (state.status = "idle");
              state.status = "writing";
              ctx.reply(Set, { balance: msg.balance - state.amount, version: msg.version, amount: state.amount });
            },
          },
          [Ok]: {
            description: "Pays out the cash, if it was waiting to (a restart forgets).",
            say: (s) => `Pays out ${s.amount}`,
            run(state) {
              if (state.status !== "writing") return;
              state.paid += state.amount;
              state.status = "idle";
            },
          },
          [Conflict]: {
            description: "Notes the balance moved on since it read it.",
            run(state) {
              if (state.status === "writing") state.status = "conflict";
            },
          },
          retry: {
            description: "Reads the balance again, to retry the withdrawal.",
            when: (state) => state.status === "conflict",
            sends: [Get],
            run(state, ctx) {
              state.status = "reading";
              ctx.send(ctx.the(Account), Get, {});
            },
          },
        },
      });

      const Account = spec.defineActor({
        name: "Account",
        zone: core,
        singleton: true,
        // `paidOut`: what the writes it took paid out, which only the invariant reads.
        initialState: () => ({ balance: OPENING, version: 0, paidOut: 0 }),
        display: {
          icon: "database",
          status: (s) => `balance ${s.balance}`,
          mood: (s) => (s.balance + s.paidOut === OPENING && s.balance >= 0 ? "ok" : "bad"),
          rows: (s) => [{ group: "books", label: "paid out", detail: String(s.paidOut) }],
        },
        transitions: {
          [Get]: {
            description: "Replies with the balance and its version.",
            sends: [Balance],
            run: (state, _msg, ctx) => ctx.reply(Balance, { balance: state.balance, version: state.version }),
          },
          [Set]: {
            description: variant === "buggy" ? "Takes the new balance." : "Takes the new balance if nothing changed since the teller read it; otherwise refuses.",
            sends: [Ok, Conflict],
            say: (s, msg) => (s.balance === msg.balance ? `Balance now ${msg.balance}` : `Refuses: the balance moved on`),
            run(state, msg, ctx) {
              if (variant === "fixed" && msg.version !== state.version) return void ctx.reply(Conflict, {});
              state.balance = msg.balance;
              state.version += 1;
              state.paidOut += msg.amount;
              ctx.reply(Ok, {});
            },
          },
        },
      });

      spec.defineProperties({
        moneyAddsUp: {
          description: "The balance and what was paid out add up to what the account opened with.",
          always: (w) => w.the(Account).state.balance + w.the(Account).state.paidOut === OPENING,
        },
      });

      spec.defineScenario({
        name: "One after the other",
        description: "A takes 30, then B takes 30: the balance is 40.",
        run(s) {
          const [a, b] = ["Teller A", "Teller B"].map((name) => s.spawn(Teller, name));
          s.act(a, "withdraw", { amount: 30 });
          s.settle();
          s.act(b, "withdraw", { amount: 30 });
          s.settle();
        },
      });
      spec.defineScenario({
        name: "Both read before either writes",
        description:
          variant === "buggy"
            ? "Both hear 100; A writes 70, then B writes 20: 110 is paid out, and the balance says 20."
            : "Both hear 100; A writes 70; B's write names the old version and is refused. B reads again: 70 does not cover 80, and B declines.",
        run(s) {
          const [a, b] = ["Teller A", "Teller B"].map((name) => s.spawn(Teller, name));
          const account = s.the(Account);
          s.act(a, "withdraw", { amount: 30 });
          s.act(b, "withdraw", { amount: 80 });
          s.deliver(account, "Get");
          s.deliver(account, "Get");
          s.deliver(a, "Balance");
          s.deliver(b, "Balance");
          s.deliver(account, "Set", { balance: 70, version: 0, amount: 30 });
          s.deliver(account, "Set", { balance: 20, version: 0, amount: 80 });
          s.settle();
        },
      });
      return { Teller, Account };
    },
  );
}

/** `feynman check lost-update` checks the buggy variant, so you see the checker find the bug. */
export default lostUpdate("buggy");
export const fixed = lostUpdate("fixed");
