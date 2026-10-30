import { budget, crash, defineCall, defineMessage, failed, lose } from "@leostera/feynman";

// At most one fault on any path; --set faults=2 for two.
const faults = budget("faults", 1);

// A call: losing it, or its answer, throws in the caller.
const Charge = defineCall("Charge", { payment: String }, { over: "rpc" });
const Charged = defineMessage("Charged", { payment: String }, { tone: "reply" });

// in the client's steps:
chargeFailed: {
  on: failed(Charge),
  description: "The call threw: sends the same charge again.",
  run: (_state, failure, ctx) => ctx.send(failure.to, Charge, failure.payload),
},
chargedLost: lose(Charged, { fails: Charge, spend: faults }),

// in the bank's:
chargeLost: lose(Charge, { spend: faults }),
crash: crash({ keeps: ["seen"], spend: faults }), // what is on disk survives
