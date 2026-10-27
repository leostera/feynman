// Ricart and Agrawala's mutual exclusion, with Lamport timestamps.
//
// A node that wants the critical section stamps a request with its clock and asks every
// other node. A node answers at once unless it is inside, or is asking itself with an
// earlier request, in which case it answers once it is done. The earlier request wins, so
// only one node is ever inside. Two requests can carry the same timestamp, though; then
// neither is earlier, and if a tie counts as "not mine first", both nodes answer each other
// and both go in. The fix: ties are broken by the node's id, so of two requests one is
// always first.
//
// Restarts take two more things. The clock is kept on disk: a node that answered a request
// stamped 1 and then restarted would stamp its own next request 1 again, tie, and win. And an
// answer names the request it answers: one meant for a request from before a restart must
// not count towards the next.
//
// Expected, with two nodes: buggy breaks `mutex` in 6 steps without faults (both ask with
// timestamp 1, each request lands and is answered, both answers land); fixed holds, with a
// fault too.
import { defineSpec, message } from "@leostera/feynman";

export function ricartAgrawala(variant: "buggy" | "fixed") {
  return defineSpec(
    `Ricart-Agrawala (${variant})`,
    {
      messages: {
        Request: message<{ ts: number }>({ name: "request" }),
        Ok: message<{ ts: number }>({ name: "ok", tone: "reply" }),
      },
    },
    (spec) => {
      const { Request, Ok } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster", description: "one node at a time in the critical section", place: { arrange: "row" } });

      const Node = spec.defineActor({
        name: "Node",
        zone,
        // A clock that goes back on a restart can stamp a request no later than one already granted.
        durable: variant === "fixed" ? ["clock"] : [],
        initialState: () => ({ clock: 0, asking: null as number | null, oks: 0, inside: false, deferred: [] as { id: string; ts: number }[] }),
        look: {
          icon: "server",
          status: (s) => (s.inside ? "in the critical section" : s.asking !== null ? `asking, at ${s.asking}` : "outside") + ` · clock ${s.clock}`,
          mood: (s) => (s.inside ? "ok" : s.asking !== null ? "busy" : "off"),
          rows: (s) => s.deferred.map((d) => ({ label: `${d.id} waits`, detail: `asked at ${d.ts}`, mood: "warn" as const })),
        },
        actions: {
          request: {
            label: "Ask to go in",
            description: "Stamps a request with its clock and asks every other node.",
            when: (state) => state.asking === null && !state.inside,
            sends: [Request],
            run(state, _inputs, ctx) {
              state.clock += 1;
              state.asking = state.clock;
              state.oks = 0;
              for (const other of ctx.all(Node)) if (other.id !== ctx.id) ctx.send(other, Request, { ts: state.asking });
            },
          },
          exit: {
            label: "Leave",
            description: "Leaves the critical section, and answers everyone it kept waiting.",
            when: (state) => state.inside,
            sends: [Ok],
            run(state, _inputs, ctx) {
              state.inside = false;
              state.asking = null;
              for (const d of state.deferred) ctx.send(ctx.all(Node).find((n) => n.id === d.id)!, Ok, { ts: d.ts });
              state.deferred = [];
            },
          },
        },
        transitions: {
          [Request]: {
            description: "Answers at once, unless it is inside or its own request comes first.",
            say: (s, msg) => (s.deferred.some((d) => d.ts === msg.ts) ? `Keeps a request stamped ${msg.ts} waiting` : `Says ok to a request stamped ${msg.ts}`),
            sends: [Ok],
            run(state, msg, ctx) {
              state.clock = Math.max(state.clock, msg.ts);
              const from = ctx.from!.id;
              const mineFirst = state.asking !== null && (variant === "buggy" ? state.asking < msg.ts : state.asking < msg.ts || (state.asking === msg.ts && ctx.id < from));
              if (state.inside || mineFirst) return void state.deferred.push({ id: from, ts: msg.ts });
              ctx.reply(Ok, { ts: msg.ts });
            },
          },
          [Ok]: {
            description: "Counts an answer to its current request; with everyone's, goes in.",
            run(state, msg, ctx) {
              if (state.asking === null || (variant === "fixed" && msg.ts !== state.asking)) return;
              state.oks += 1;
              if (state.oks === ctx.all(Node).length - 1) state.inside = true;
            },
          },
        },
      });

      spec.defineInvariants({
        mutex: {
          description: "At most one node is in the critical section.",
          always: (w) => w.all(Node).filter((n) => n.state.inside).length <= 1,
        },
      });
      spec.defineScenario({
        name: "In and out",
        description: "A asks, B says ok, A goes in, and leaves.",
        run(s) {
          const a = s.spawn(Node, "Node A");
          s.spawn(Node, "Node B");
          s.act(a, "request");
          s.settle();
          s.act(a, "exit");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "Both ask at once",
        description:
          variant === "buggy"
            ? "Both stamp their request 1; neither counts its own as first, both say ok, and both go in."
            : "Both stamp their request 1; the tie goes to A, which goes in, and lets B in when it leaves.",
        run(s) {
          const a = s.spawn(Node, "Node A");
          const b = s.spawn(Node, "Node B");
          s.act(a, "request");
          s.act(b, "request");
          s.settle();
          s.act(a, "exit");
          s.settle();
        },
      });
      return { Node };
    },
  );
}

/** `feynman check ricart-agrawala` checks the buggy variant, so you see the checker find the bug. */
export default ricartAgrawala("buggy");
export const fixed = ricartAgrawala("fixed");
