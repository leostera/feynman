// Leader election: every node announces itself, and adopts the highest id it hears.
//
// The buggy node adopts whatever it heard last, so with messages overtaking each other nodes
// can settle on different leaders. The fixed node keeps the highest id, which every node
// ends up hearing, so they agree.
//
// This spec orders instances by id, so its instances are not interchangeable: swapping two
// nodes changes who wins. Symmetry must not apply to it.
//
// Expected, with three nodes: buggy breaks `agree` in 9 steps: every node announces, and the
// announcements arrive in an order that leaves the nodes on different leaders, for good.
// Fixed holds. Declaring the nodes symmetric is wrong for the fixed one, which orders ids,
// and the checker must notice and say so; the buggy one never compares ids, so for it the
// claim is true.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const Elect = defineMessage("Elect", { id: String });

export function leaderElection(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Cluster", description: "the highest id should lead", place: { arrange: "ring" } });
  const Node = defineActor({
    name: "Node",
    zone,
    // Wrong for the fixed variant: the highest id wins, so nodes are not interchangeable.
    symmetric: true,
    initialState: (ctx) => ({ leader: ctx.id, announced: false }),
    display: {
      icon: "server",
      names: ["A", "B", "C"],
      status: (s) => `follows ${s.leader}`,
      mood: (s) => (s.announced ? "info" : "off"),
    },
    actions: {
      announce: {
        with: [atMost(2)],
        label: "Announce",
        description: "Tells every other node about itself.",
        when: (state) => !state.announced,
        sends: [Elect],
        run(state, _inputs, ctx) {
          state.announced = true;
          for (const n of ctx.all(Node)) if (n.id !== ctx.id) ctx.send(n, Elect, { id: ctx.id });
        },
      },
    },
    transitions: {
      elect: {
        on: Elect,
        description: "Adopts the announced node, if it should.",
        say: (s, msg) => (s.leader === msg.id ? `Now follows ${msg.id}` : `Keeps following ${s.leader}, not ${msg.id}`),
        run(state, msg) {
          if (variant === "buggy" || msg.id > state.leader) state.leader = msg.id;
        },
      },
      electLost: lose(Elect, { spend: faults }),
      crash: crash({ spend: faults }),
    },
  });

  const agreeOnceQuiet = defineProperty("agreeOnceQuiet", {
    description: "Once every node has announced and nothing is in flight, they agree on one leader.",
    always: (w) => !(w.quiet && w.all(Node).every((n) => n.state.announced)) || new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
  });

  const agree = defineProperty("agree", {
    description: "Once every node has announced, they all end up agreeing on one leader.",
    leadsTo: {
      whenever: (w) => w.all(Node).every((n) => n.state.announced),
      then: (w) => new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
    },
  });

  const everyoneAnnounces = defineScenario("Everyone announces", {
    description: variant === "buggy" ? "Each node follows the last it hears: A and B end up on C, but C on B." : "Each node keeps the highest id it hears: all three end up on C.",
    run(s) {
      const nodes = ["A", "B", "C"].map((name) => s.spawn(Node, name));
      for (const n of nodes) s.act(n, "announce");
      s.settle();
    },
  });

  const theHighestIsHeardFirst = defineScenario("The highest is heard first", {
    description: variant === "buggy" ? "Every node hears C first, then a lower id, and follows that one instead." : "Every node hears C first and keeps it.",
    run(s) {
      const [a, b, c] = ["A", "B", "C"].map((name) => s.spawn(Node, name));
      for (const n of [a, b, c]) s.act(n, "announce");
      s.deliver(a, Elect, { id: c.id });
      s.deliver(b, Elect, { id: c.id });
      s.deliver(c, Elect, { id: b.id });
      s.settle();
    },
  });

  return defineSpec({
    name: `Leader election (${variant})`,
    actors: [Node],
    properties: [agreeOnceQuiet, agree],
    finalState: {
      description: "Every node has announced itself, and every announcement has arrived.",
      when: (w) => w.all(Node).every((n) => n.state.announced),
    },
    scenarios: [everyoneAnnounces, theHighestIsHeardFirst],
  });
}

/** `feynman check leader-election` checks the buggy variant, so you see the checker find the bug. */
export default leaderElection("buggy");
export const fixed = leaderElection("fixed");
