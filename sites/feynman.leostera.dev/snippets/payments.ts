import { defineActor, defineMessage, defineProperty, defineSpec, defineZone } from "@leostera/feynman";

const Debit = defineMessage("Debit", { id: String });
const zone = defineZone({ name: "Payments" });

const Bank = defineActor({
  name: "Bank", zone, singleton: true,
  initialState: () => ({ debits: 0 }),
  transitions: {
    debit: {
      on: Debit,
      description: "Debits the account.",
      run: (state) => void (state.debits += 1),
    },
  },
});

const Client = defineActor({
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
      run(state, _, ctx) {
        ctx.send(ctx.the(Bank), Debit, { id: state.pending });
      },
    },
  },
});

const debitedOnce = defineProperty("debitedOnce", {
  description: "The bank debits once per payment.",
  always: (w) => w.the(Bank).state.debits <= w.the(Client).state.paid,
});

export default defineSpec({
  name: "Payments",
  actors: [Bank, Client],
  properties: [debitedOnce],
});
