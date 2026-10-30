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
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const Token = defineMessage("Token", { count: Number });
const Ack = defineMessage("Ack", { count: Number }, { tone: "reply" });

export function tokenRing(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Ring", description: "one token, handed round", place: { arrange: "ring" } });

  const Node = defineActor({
    name: "Node",
    zone,
    // The ring starts with the token at its first node.
    initialState: ({ label }) => ({ holds: label === "Node A", count: 0, unacked: null as number | null }),
    display: {
      icon: "key",
      status: (s) => (s.holds ? "holds the token" : s.unacked !== null ? "passed it, waiting for an ack" : "waiting"),
      mood: (s) => (s.holds ? "ok" : s.unacked !== null ? "busy" : "off"),
    },
    actions: {
      pass: {
        with: [atMost(2)],
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
      token: {
        on: Token,
        description: "Takes the token, if newer than any seen when fixed, and acknowledges it either way.",
        say: (s, msg) => (s.holds && s.count === msg.count ? `Takes token #${msg.count}` : `Ignores token #${msg.count}, older than #${s.count}`),
        sends: [Ack],
        run(state, msg, ctx) {
          if (variant === "buggy" || msg.count > state.count) {
            state.holds = true;
            state.count = msg.count;
          }
          ctx.reply(Ack, { count: msg.count });
        },
      },
      ack: {
        on: Ack,
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
        run(state, _, ctx) {
          if (state.unacked === null) return;
          const ring = ctx.all(Node);
          ctx.send(ring[(ring.findIndex((n) => n.id === ctx.id) + 1) % ring.length], Token, { count: state.unacked });
          ctx.start("resend");
        },
      },
      tokenLost: lose(Token, { spend: faults }),
      ackLost: lose(Ack, { spend: faults }),
      crash: crash({ keeps: ["holds", "count", "unacked"], spend: faults }),
    },
  });

  const oneToken = defineProperty("oneToken", {
    description: "At most one node holds the token.",
    always: (w) => w.all(Node).filter((n) => n.state.holds).length <= 1,
  });

  const roundTheRing = defineScenario("Round the ring", {
    description: "The token goes from A to B to C and back to A, each hand-over acknowledged.",
    run(s) {
      const nodes = ["Node A", "Node B", "Node C"].map((name) => s.spawn(Node, name));
      for (const n of nodes) {
        s.act(n, "pass");
        s.settle();
      }
    },
  });

  const aResendCrossesTheFirstCopy = defineScenario("A resend crosses the first copy", {
    description:
      variant === "buggy"
        ? "A resends before B's ack arrives; B takes the first copy and passes it on, then takes the second: B and C both hold the token."
        : "A resends before B's ack arrives; B takes the first copy and passes it on, and ignores the second, which is older.",
    run(s) {
      const [a, b] = ["Node A", "Node B", "Node C"].map((name) => s.spawn(Node, name));
      s.act(a, "pass");
      s.fire(a, "resend");
      s.deliver(b, Token);
      s.act(b, "pass");
      s.deliver(b, Token);
      s.settle();
    },
  });

  return defineSpec({
    name: `Token ring (${variant})`,
    actors: [Node],
    properties: [oneToken],
    scenarios: [roundTheRing, aResendCrossesTheFirstCopy],
  });
}

/** `feynman check token-ring` checks the buggy variant, so you see the checker find the bug. */
export default tokenRing("buggy");
export const fixed = tokenRing("fixed");
