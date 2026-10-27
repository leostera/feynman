import { defineSpec, message } from "@leostera/feynman";

export default defineSpec(
  "Payments",
  { messages: { Debit: message<{ id: string }>({ name: "debit" }) }},
  (spec) => {
    const { Debit } = spec.messages;
    const zone = spec.defineZone({ name: "Payments" });

    const Bank = spec.defineActor({
      name: "Bank", zone, singleton: true,
      initialState: () => ({ debits: 0 }),
      transitions: {
        [Debit]: {
          description: "Debits the account.",
          run: (state) => void (state.debits += 1),
        },
      },
    });

    const Client = spec.defineActor({
      name: "Client", zone, singleton: true,
      initialState: () => ({ paid: 0, pending: "" }),
      actions: {
        pay: {
          label: "Pay",
          description: "Pays, retrying until the bank answers.",
          sends: [Debit], starts: ["retry"],
          run(state, _inputs, ctx) {
            state.pending = ctx.fresh("payment");
            state.paid += 1;
            ctx.send(ctx.the(Bank), Debit, { id: state.pending });
            ctx.start("retry");
          },
        },
      },
      transitions: {
        retry: {
          description: "No answer yet: pays again.",
          sends: [Debit],
          run(state, ctx) {
            ctx.send(ctx.the(Bank), Debit, { id: state.pending });
          },
        },
      },
    });

    spec.defineInvariants({
      debitedOnce: {
        description: "The bank debits once per payment.",
        always: (w) =>
          w.the(Bank).state.debits <= w.the(Client).state.paid,
      },
    });
    return { Bank, Client };
  },
);
