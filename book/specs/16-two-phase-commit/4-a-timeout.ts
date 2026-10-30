// Chapter 16, step 4: the coordinator aborts if the votes do not come in time.
//
// Expected: `atomic` holds; `nobodyWaitsForever` still breaks with one fault: a lost decision
// leaves a service that voted yes waiting, holding its locks.
import { atMost, budget, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose, type Setup } from "@leostera/feynman";

/** At most one fault on any path. */
const faults = budget("faults", 1);

type Outcome = "committed" | "aborted";

const Prepare = defineMessage("Prepare");
const Vote = defineMessage("Vote", { yes: Boolean });
const Decide = defineMessage("Decide", { commit: Boolean });

const shop = defineZone({ name: "Shop", place: { column: 0 } });
const services = defineZone({ name: "Services", description: "each with its own database", place: { column: 1 } });

const Participant = defineActor({
  name: "Participant",
  description: "A service with its own database: payments, or stock.",
  zone: services,
  symmetric: true,
  // `prepared`: it voted yes, so it holds its locks and must do whatever the coordinator decides.
  initialState: () => ({ canCommit: true, prepared: false, outcome: null as Outcome | null }),
  display: {
    icon: "database",
    names: ["Payments", "Stock"],
    status: (s) => s.outcome ?? (s.prepared ? "voted yes, waiting" : s.canCommit ? "ready" : "cannot commit"),
    mood: (s) => (s.outcome === "committed" ? "ok" : s.outcome === "aborted" ? "warn" : s.prepared ? "busy" : "off"),
  },
  actions: {
    conflict: {
      with: [atMost(1)],
      label: "Hit a conflict",
      description: "Something makes this service unable to commit: the card is declined, the stock ran out.",
      when: (s) => s.outcome === null && !s.prepared && s.canCommit,
      run: (s) => void (s.canCommit = false),
    },
  },
  transitions: {
    prepare: {
      on: Prepare,
      description: "Votes yes and holds its locks if it can commit; votes no and rolls back if not.",
      sends: [Vote],
      run(state, _msg, ctx) {
        if (state.canCommit) state.prepared = true;
        else state.outcome = "aborted";
        ctx.reply(Vote, { yes: state.canCommit });
      },
    },
    decide: {
      on: Decide,
      description: "Does what the coordinator decided.",
      run(state, msg) {
        if (state.outcome === null) state.outcome = msg.commit ? "committed" : "aborted";
      },
    },
    prepareLost: lose(Prepare, { spend: faults }),
    decideLost: lose(Decide, { spend: faults }),
  },
});

const Coordinator = defineActor({
  name: "Coordinator",
  description: "The checkout, coordinating the services' commit.",
  zone: shop,
  singleton: true,
  initialState: () => ({ started: false, yes: new Set<string>(), decision: null as boolean | null }),
  display: {
    icon: "gear",
    status: (s) => (s.decision === null ? (s.started ? `${s.yes.size} yes vote(s)` : "idle") : s.decision ? "decided: commit" : "decided: abort"),
  },
  actions: {
    checkout: {
      label: "Check out",
      description: "Asks every service to prepare its part of the order.",
      when: (s) => !s.started,
      sends: [Prepare],
      starts: ["giveUp"],
      run(state, _inputs, ctx) {
        state.started = true;
        for (const p of ctx.all(Participant)) ctx.send(p, Prepare, {});
        ctx.start("giveUp");
      },
    },
  },
  transitions: {
    vote: {
      on: Vote,
      description: "Counts a vote: a no aborts at once, and the last yes commits.",
      sends: [Decide],
      run(state, msg, ctx) {
        if (state.decision !== null) return;
        if (msg.yes) state.yes.add(ctx.from.id);
        const everyone = ctx.all(Participant);
        if (msg.yes && state.yes.size < everyone.length) return;
        state.decision = msg.yes;
        ctx.cancel("giveUp");
        for (const p of everyone) ctx.send(p, Decide, { commit: state.decision });
      },
    },
    giveUp: {
      description: "A vote did not come in time: aborts, and tells everyone.",
      after: "30 seconds",
      sends: [Decide],
      run(state, _, ctx) {
        if (state.decision !== null) return;
        state.decision = false;
        for (const p of ctx.all(Participant)) ctx.send(p, Decide, { commit: false });
      },
    },
    voteLost: lose(Vote, { spend: faults }),
  },
});

const atomic = defineProperty("atomic", {
  description: "No service commits while another rolls back: the order happens everywhere, or nowhere.",
  always: (w) => {
    const outcomes = w.all(Participant).map((p) => p.state.outcome);
    return !(outcomes.includes("committed") && outcomes.includes("aborted"));
  },
});

const nobodyWaitsForever = defineProperty("nobodyWaitsForever", {
  description: "A service that voted yes eventually commits or rolls back: it does not hold its locks forever.",
  leadsTo: {
    whenever: (w) => w.all(Participant).some((p) => p.state.prepared && p.state.outcome === null),
    then: (w) => w.all(Participant).every((p) => !p.state.prepared || p.state.outcome !== null),
  },
});

/** Both services, there from the start. */
const setup = (w: Setup) => {
  w.spawn(Participant, "Payments");
  w.spawn(Participant, "Stock");
};

const happyCheckout = defineScenario("A checkout", {
  description: "Both services vote yes, and both commit.",
  setup,
  run(s) {
    s.act(s.the(Coordinator), "checkout");
    s.settle();
  },
});

const outOfStock = defineScenario("Out of stock", {
  description: "Stock runs out before the checkout: it votes no, and both roll back.",
  setup,
  run(s) {
    s.act(s.all(Participant).find((p) => p.label === "Stock")!, "conflict");
    s.act(s.the(Coordinator), "checkout");
    s.settle();
  },
});

export default defineSpec({
  name: "Checkout",
  description: "One order, two services, each with its own database.",
  actors: [Coordinator, Participant],
  properties: [atomic, nobodyWaitsForever],
  finalState: { description: "Nothing is in flight.", when: (w) => w.quiet },
  scenarios: [happyCheckout, outOfStock],
});
