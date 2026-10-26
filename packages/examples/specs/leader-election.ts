// Leader election: every node announces itself, and adopts the highest id it hears.
//
// The buggy node adopts whatever it heard last, so with messages overtaking each other nodes
// can settle on different leaders. The fixed node keeps the highest id, which every node
// ends up hearing, so they agree.
//
// This spec orders instances by id, so its instances are not interchangeable: swapping two
// nodes changes who wins. Symmetry must not apply to it.
//
// Expected, with three nodes: buggy breaks `agree` in 4 steps: every node announces, and one
// announcement arrives early; left alone, the rest arrive in an order that leaves the nodes on
// different leaders. Fixed holds. Declaring the nodes symmetric is wrong for the fixed one,
// which orders ids, and the checker must notice and say so; the buggy one never compares ids,
// so for it the claim is true.
import { defineSpec, message, SEC } from "@feynman/spec";

export function leaderElection(variant: "buggy" | "fixed") {
  return defineSpec(
    `Leader election (${variant})`,
    { messages: { Elect: message<{ id: string }>({ name: "elect" }) } },
    (spec) => {
      const { Elect } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster" });
      const Node = spec.defineActor({
        name: "Node",
        zone,
        // Wrong for the fixed variant: the highest id wins, so nodes are not interchangeable.
        symmetric: true,
        initialState: (ctx) => ({ leader: ctx.id, announced: false }),
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
            run(state, msg) {
              if (variant === "buggy" || msg.id > state.leader) state.leader = msg.id;
            },
          },
        },
      });
      spec.defineInvariants({
        agreeOnceQuiet: {
          description: "Once every node has announced and nothing is in flight, they agree on one leader.",
          always: (w) => !(w.quiet && w.all(Node).every((n) => n.state.announced)) || new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
        },
        agree: {
          description: "Once every node has announced, they all end up agreeing on one leader.",
          after: (w) => w.all(Node).every((n) => n.state.announced),
          eventually: (w) => new Set(w.all(Node).map((n) => n.state.leader)).size === 1,
          within: 10 * SEC,
        },
      });
      return { Node };
    },
  );
}
