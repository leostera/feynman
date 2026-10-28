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
import { defineSpec, message } from "@leostera/feynman";

export function leaderElection(variant: "buggy" | "fixed") {
  return defineSpec(
    `Leader election (${variant})`,
    { messages: { Elect: message<{ id: string }>({ name: "elect" }) } },
    (spec) => {
      const { Elect } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster", description: "the highest id should lead", place: { arrange: "ring" } });
      const Node = spec.defineActor({
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
          [Elect]: {
            description: "Adopts the announced node, if it should.",
            say: (s, msg) => (s.leader === msg.id ? `Now follows ${msg.id}` : `Keeps following ${s.leader}, not ${msg.id}`),
            run(state, msg) {
              if (variant === "buggy" || msg.id > state.leader) state.leader = msg.id;
            },
          },
        },
      });
      spec.defineFinalState({
        description: "Every node has announced itself, and every announcement has arrived.",
        when: (w) => w.all(Node).every((n) => n.state.announced),
      });
      spec.defineProperties({
        agreeOnceQuiet: {
          description: "Once every node has announced and nothing is in flight, they agree on one leader.",
          always: (w) => !(w.quiet && w.all(Node).every((n) => n.state.announced)) || new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
        },
        agree: {
          description: "Once every node has announced, they all end up agreeing on one leader.",
          leadsTo: {
            whenever: (w) => w.all(Node).every((n) => n.state.announced),
            then: (w) => new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
          },
        },
      });
      spec.defineScenario({
        name: "Everyone announces",
        description: variant === "buggy" ? "Each node follows the last it hears: A and B end up on C, but C on B." : "Each node keeps the highest id it hears: all three end up on C.",
        run(s) {
          const nodes = ["A", "B", "C"].map((name) => s.spawn(Node, name));
          for (const n of nodes) s.act(n, "announce");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "The highest is heard first",
        description: variant === "buggy" ? "Every node hears C first, then a lower id, and follows that one instead." : "Every node hears C first and keeps it.",
        run(s) {
          const [a, b, c] = ["A", "B", "C"].map((name) => s.spawn(Node, name));
          for (const n of [a, b, c]) s.act(n, "announce");
          s.deliver(a, "Elect", { id: c.id });
          s.deliver(b, "Elect", { id: c.id });
          s.deliver(c, "Elect", { id: b.id });
          s.settle();
        },
      });
      return { Node };
    },
  );
}

/** `feynman check leader-election` checks the buggy variant, so you see the checker find the bug. */
export default leaderElection("buggy");
export const fixed = leaderElection("fixed");
