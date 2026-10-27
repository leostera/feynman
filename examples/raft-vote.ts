// Raft's vote, kept on disk.
//
// Three nodes elect a leader for one term. A node campaigns by voting for itself and asking
// the others; a node grants its vote to the first candidate that asks, and a candidate with
// votes from a majority (two of three) leads. Raft keeps each node's vote on disk for this
// reason: a node that forgets it, by restarting, can vote again in the same term, and two
// candidates can both reach a majority. The fix: the vote is durable.
//
// This covers durable state and restarts.
//
// Expected, with three nodes: buggy breaks `oneLeader` in 7 steps with one fault (A
// campaigns, B votes for A, A leads; B restarts and forgets its vote, B campaigns, C votes for
// B, B leads); fixed holds, with a restart too.
import { defineSpec, message } from "@leostera/feynman";

export function raftVote(variant: "buggy" | "fixed") {
  return defineSpec(
    `Raft vote (${variant})`,
    {
      messages: {
        RequestVote: message<{}>({ name: "request vote" }),
        Vote: message<{}>({ name: "vote", tone: "reply" }),
      },
    },
    (spec) => {
      const { RequestVote, Vote } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster" });

      const Node = spec.defineActor({
        name: "Node",
        zone,
        symmetric: true,
        // Raft keeps `votedFor` on stable storage, so a restart cannot make a node vote twice.
        durable: variant === "fixed" ? ["votedFor"] : [],
        initialState: () => ({ votedFor: null as string | null, votes: [] as string[], leader: false }),
        actions: {
          campaign: {
            label: "Campaign",
            description: "Votes for itself and asks the others for their votes.",
            when: (state) => state.votedFor === null,
            sends: [RequestVote],
            run(state, _inputs, ctx) {
              state.votedFor = ctx.id;
              state.votes = [ctx.id];
              for (const other of ctx.all(Node)) if (other.id !== ctx.id) ctx.send(other, RequestVote, {});
            },
          },
        },
        transitions: {
          [RequestVote]: {
            description: "Votes for the candidate, unless it has voted in this term already.",
            sends: [Vote],
            run(state, _msg, ctx) {
              if (state.votedFor !== null) return;
              state.votedFor = ctx.from!.id;
              ctx.reply(Vote, {});
            },
          },
          [Vote]: {
            description: "Counts the vote; with a majority, leads.",
            run(state, _msg, ctx) {
              if (state.votes.includes(ctx.from!.id)) return;
              state.votes.push(ctx.from!.id);
              if (state.votes.length >= 2) state.leader = true;
            },
          },
        },
      });

      spec.defineInvariants({
        oneLeader: {
          description: "At most one node leads the term.",
          always: (w) => w.all(Node).filter((n) => n.state.leader).length <= 1,
        },
      });
      return { Node };
    },
  );
}

/** `feynman check raft-vote` checks the buggy variant, so you see the checker find the bug. */
export default raftVote("buggy");
export const fixed = raftVote("fixed");
