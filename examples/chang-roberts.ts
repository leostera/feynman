// Chang and Roberts' leader election on a ring.
//
// Three nodes in a ring each have an id, and the largest should lead. A node starts an
// election by sending its id to the next node. A node passes on an id larger than its own,
// and drops a smaller one (starting an election of its own if it has not); the node whose
// own id comes all the way back has seen every other id and is the largest. The bug: a node
// that beats a smaller id declares itself leader then and there, though it has only beaten
// that one; two such nodes lead at once. The fix: lead only on hearing one's own id.
//
// Expected, with three nodes: buggy breaks `oneLeader` in 3 steps without faults (A starts;
// B beats A's id, leads, and starts its own election; C beats B's id and leads); fixed holds,
// with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function changRoberts(variant: "buggy" | "fixed") {
  return defineSpec(
    `Chang-Roberts (${variant})`,
    {
      messages: {
        Election: message<{ id: string }>({ name: "election" }),
      },
    },
    (spec) => {
      const { Election } = spec.messages;
      const zone = spec.defineZone({ name: "Ring", place: { arrange: "ring" } });

      const Node = spec.defineActor({
        name: "Node",
        zone,
        initialState: () => ({ started: false, leader: false }),
        actions: {
          start: {
            label: "Start an election",
            description: "Sends its id to the next node.",
            when: (state) => !state.started,
            sends: [Election],
            run(state, _inputs, ctx) {
              state.started = true;
              ctx.send(nextOf(ctx), Election, { id: ctx.id });
            },
          },
        },
        transitions: {
          [Election]: {
            description: "Passes on a larger id, leads on its own, and drops a smaller one.",
            sends: [Election],
            run(state, msg, ctx) {
              if (msg.id > ctx.id) return ctx.send(nextOf(ctx), Election, { id: msg.id });
              if (msg.id === ctx.id) return void (state.leader = true);
              if (variant === "buggy") state.leader = true;
              if (state.started) return;
              state.started = true;
              ctx.send(nextOf(ctx), Election, { id: ctx.id });
            },
          },
        },
      });
      /** The next node round the ring, in the order the nodes were made. */
      const nextOf = (ctx: { id: string; all: (actor: typeof Node) => { id: string }[] }) => {
        const ring = ctx.all(Node);
        return ring[(ring.findIndex((n) => n.id === ctx.id) + 1) % ring.length] as never;
      };

      spec.defineInvariants({
        oneLeader: {
          description: "At most one node leads.",
          always: (w) => w.all(Node).filter((n) => n.state.leader).length <= 1,
        },
      });
      return { Node };
    },
  );
}

/** `feynman check chang-roberts` checks the buggy variant, so you see the checker find the bug. */
export default changRoberts("buggy");
export const fixed = changRoberts("fixed");
