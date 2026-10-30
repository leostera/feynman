// Chapter 16, step 7: the coordinator restarts, and has to remember what it decided.
//
// Expected, at `--depth 30`: every property holds, and `logDecision` is needed: without it,
// `atomic` breaks with one restart.
import { atMost, budget, crash, defineCall, failed, defineActor, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineZone, lose, type Setup } from "@leostera/feynman";

/** At most two faults on any path: a restart, and a lost message. */
const faults = budget("faults", 2);

const logDecision = defineRule("logDecision", { description: "The coordinator writes its decision to disk before it tells anyone." });

type Outcome = "committed" | "aborted";

const Prepare = defineMessage("Prepare");
const Vote = defineMessage("Vote", { yes: Boolean });
const Decide = defineMessage("Decide", { commit: Boolean });
// A call: the service hears if it fails, as a request that times out throws.
const Ask = defineCall("Ask", {}, { name: "what was decided?" });

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
      starts: ["inDoubt"],
      run(state, _msg, ctx) {
        if (state.canCommit) state.prepared = true;
        else state.outcome = "aborted";
        ctx.reply(Vote, { yes: state.canCommit });
        if (state.prepared) ctx.start("inDoubt");
      },
    },
    inDoubt: {
      description: "The decision has not come: asks the coordinator.",
      after: "1 minute",
      sends: [Ask],
      run(state, _, ctx) {
        if (state.outcome === null) ctx.send(ctx.the(Coordinator), Ask, {});
      },
    },
    askFailed: {
      on: failed(Ask),
      description: "The question went unanswered: asks again.",
      sends: [Ask],
      run(state, failure, ctx) {
        if (state.outcome === null) ctx.send(failure.to, Ask, {});
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
    // A lost answer to a question fails it; a lost decision sent unasked fails nothing.
    decideLost: lose(Decide, { fails: Ask, spend: faults }),
  },
});

interface CoordinatorState {
  decision: boolean | null;
  log: boolean | null;
}

/** What it knows was decided: in memory, or, after a restart, on disk. */
function known(state: CoordinatorState): boolean | null {
  return state.decision ?? state.log;
}

/** Decides, writing the decision to disk first when the rule is on. */
function decide(state: CoordinatorState, commit: boolean): void {
  if (logDecision.on) state.log = commit;
  state.decision = commit;
}

const Coordinator = defineActor({
  name: "Coordinator",
  description: "The checkout, coordinating the services' commit.",
  zone: shop,
  singleton: true,
  // `started` and `log` are on disk. The votes and `decision` are in memory, and a restart
  // loses them.
  initialState: () => ({ started: false, yes: new Set<string>(), decision: null as boolean | null, log: null as boolean | null }),
  display: {
    icon: "gear",
    status: (s) => (known(s) === null ? (s.started ? `${s.yes.size} yes vote(s)` : "idle") : known(s) ? "decided: commit" : "decided: abort"),
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
        if (known(state) !== null) return;
        if (msg.yes) state.yes.add(ctx.from.id);
        const everyone = ctx.all(Participant);
        if (msg.yes && state.yes.size < everyone.length) return;
        decide(state, msg.yes);
        ctx.cancel("giveUp");
        for (const p of everyone) ctx.send(p, Decide, { commit: msg.yes });
      },
    },
    giveUp: {
      description: "A vote did not come in time: aborts, and tells everyone.",
      after: "30 seconds",
      sends: [Decide],
      run(state, _, ctx) {
        if (known(state) !== null) return;
        decide(state, false);
        for (const p of ctx.all(Participant)) ctx.send(p, Decide, { commit: false });
      },
    },
    ask: {
      on: Ask,
      description: "Tells a service in doubt what was decided; if nothing was, aborts, and tells everyone.",
      sends: [Decide],
      run(state, _msg, ctx) {
        const decided = known(state);
        if (decided !== null) return ctx.reply(Decide, { commit: decided });
        // Nothing on record: nobody was told to commit, since decisions are logged before
        // they are sent. Abort is safe.
        decide(state, false);
        ctx.cancel("giveUp");
        ctx.reply(Decide, { commit: false });
        for (const p of ctx.all(Participant)) if (p.id !== ctx.from.id) ctx.send(p, Decide, { commit: false });
      },
    },
    voteLost: lose(Vote, { spend: faults }),
    askLost: lose(Ask, { spend: faults }),
    // The coordinator restarts: what is on disk stays.
    crash: crash({ keeps: ["started", "log"], spend: faults }),
  },
});

const atomic = defineProperty("atomic", {
  needs: [logDecision],
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
