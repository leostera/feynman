// A token ring: whoever holds the one token may act, then passes it on.
//
// Three nodes in a ring hand a token to the next, resending it until the next node
// acknowledges it, since the network may lose it. A node takes whatever token arrives. A
// resend that crosses a slow first copy is a second token: the next node takes the first,
// passes it on, and takes the second too, so two nodes hold one. The fix: the token carries
// a count of hand-overs, and a node takes only a token newer than any it has seen.
//
// The token, its count and an unacknowledged hand-over are on disk: a restart drops only the
// resend timer.
//
// Expected, with three nodes: buggy breaks `oneToken` in 6 steps without faults (A passes
// the token, the resend fires, B takes the first copy and passes it on, B takes the second,
// C takes the first); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function tokenRing(variant: "buggy" | "fixed") {
  return defineSpec(
    `Token ring (${variant})`,
    {
      messages: {
        Token: message<{ count: number }>({ name: "token" }),
        Ack: message<{ count: number }>({ name: "ack", tone: "reply" }),
      },
    },
    (spec) => {
      const { Token, Ack } = spec.messages;
      const zone = spec.defineZone({ name: "Ring", place: { arrange: "ring" } });

      const Node = spec.defineActor({
        name: "Node",
        zone,
        durable: ["holds", "count", "unacked"],
        // The ring starts with the token at its first node.
        initialState: ({ label }) => ({ holds: label === "Node A", count: 0, unacked: null as number | null }),
        actions: {
          pass: {
            label: "Pass the token",
            description: "Hands the token to the next node, and resends it until acknowledged.",
            when: (state) => state.holds,
            sends: [Token],
            starts: ["resend"],
            run(state, _inputs, ctx) {
              const ring = ctx.all(Node);
              const next = ring[(ring.findIndex((n) => n.id === ctx.id) + 1) % ring.length];
              state.holds = false;
              state.count += 1;
              state.unacked = state.count;
              ctx.send(next, Token, { count: state.count });
              ctx.start("resend");
            },
          },
        },
        transitions: {
          [Token]: {
            description: "Takes the token, if newer than any seen when fixed, and acknowledges it either way.",
            sends: [Ack],
            run(state, msg, ctx) {
              if (variant === "buggy" || msg.count > state.count) {
                state.holds = true;
                state.count = msg.count;
              }
              ctx.reply(Ack, { count: msg.count });
            },
          },
          [Ack]: {
            description: "The next node has the token: stops resending.",
            run(state, msg, ctx) {
              if (state.unacked !== msg.count) return;
              state.unacked = null;
              ctx.cancel("resend");
            },
          },
          resend: {
            description: "No acknowledgement yet: sends the token again.",
            after: "1 second",
            sends: [Token],
            starts: ["resend"],
            run(state, ctx) {
              if (state.unacked === null) return;
              const ring = ctx.all(Node);
              ctx.send(ring[(ring.findIndex((n) => n.id === ctx.id) + 1) % ring.length], Token, { count: state.unacked });
              ctx.start("resend");
            },
          },
        },
      });

      spec.defineInvariants({
        oneToken: {
          description: "At most one node holds the token.",
          always: (w) => w.all(Node).filter((n) => n.state.holds).length <= 1,
        },
      });
      return { Node };
    },
  );
}

/** `feynman check token-ring` checks the buggy variant, so you see the checker find the bug. */
export default tokenRing("buggy");
export const fixed = tokenRing("fixed");
