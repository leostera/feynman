// Chapter 16, step 1: a checkout that tells each service to commit, and hopes.
//
// Expected: `atomic` breaks in 4 events, with no faults: the stock runs out, the shop tells
// both services to commit, and the payment goes through for an order that cannot ship.
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

type Outcome = "committed" | "aborted";

const Commit = defineMessage("Commit");

const shop = defineZone({ name: "Shop", place: { column: 0 } });
const services = defineZone({ name: "Services", description: "each with its own database", place: { column: 1 } });

const Participant = defineActor({
  name: "Participant",
  description: "A service with its own database: payments, or stock.",
  zone: services,
  symmetric: true,
  initialState: () => ({ canCommit: true, outcome: null as Outcome | null }),
  display: {
    icon: "database",
    names: ["Payments", "Stock"],
    status: (s) => s.outcome ?? (s.canCommit ? "ready" : "cannot commit"),
    mood: (s) => (s.outcome === "committed" ? "ok" : s.outcome === "aborted" ? "warn" : "off"),
  },
  actions: {
    conflict: {
      with: [atMost(1)],
      label: "Hit a conflict",
      description: "Something makes this service unable to commit: the card is declined, the stock ran out.",
      when: (s) => s.outcome === null && s.canCommit,
      run: (s) => void (s.canCommit = false),
    },
  },
  transitions: {
    commit: {
      on: Commit,
      description: "Commits its part of the order if it can, and rolls it back if not.",
      run: (s) => void (s.outcome = s.canCommit ? "committed" : "aborted"),
    },
  },
});

const Shop = defineActor({
  name: "Shop",
  description: "The checkout, which spans both services.",
  zone: shop,
  singleton: true,
  initialState: () => ({ started: false }),
  display: { icon: "browser", status: (s) => (s.started ? "checking out" : "idle") },
  actions: {
    checkout: {
      label: "Check out",
      description: "Tells every service to commit its part of the order.",
      when: (s) => !s.started,
      sends: [Commit],
      run(state, _inputs, ctx) {
        state.started = true;
        for (const p of ctx.all(Participant)) ctx.send(p, Commit, {});
      },
    },
  },
});

const atomic = defineProperty("atomic", {
  description: "No service commits while another rolls back: the order happens everywhere, or nowhere.",
  always: (w) => {
    const outcomes = w.all(Participant).map((p) => p.state.outcome);
    return !(outcomes.includes("committed") && outcomes.includes("aborted"));
  },
});

const happyCheckout = defineScenario("A checkout", {
  description: "Both services can commit, and both do.",
  setup(w) {
    w.spawn(Participant, "Payments");
    w.spawn(Participant, "Stock");
  },
  run(s) {
    s.act(s.the(Shop), "checkout");
    s.settle();
  },
});

export default defineSpec({
  name: "Checkout",
  description: "One order, two services, each with its own database.",
  actors: [Shop, Participant],
  properties: [atomic],
  finalState: { description: "Every service has an outcome, or nothing started.", when: (w) => w.quiet },
  scenarios: [happyCheckout],
});
