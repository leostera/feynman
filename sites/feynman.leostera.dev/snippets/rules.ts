const idempotencyKey = spec.defineRule({
  name: "idempotencyKey",
  description: "The bank charges each payment once.",
});

// in the bank's handler:
if (idempotencyKey.on && state.seen.includes(msg.id)) return;
state.charges += 1;

// and on the property it protects:
spec.defineProperties({
  chargedOnce: {
    description: "The customer is never charged twice.",
    always: (w) => w.the(Bank).state.charges <= 1,
    needs: [idempotencyKey],
  },
});
