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
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

const RequestVote = defineMessage("RequestVote");
const Vote = defineMessage("Vote", {}, { tone: "reply" });

export function raftVote(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Cluster", description: "one term; a majority is two of three", place: { arrange: "ring" } });

  const Node = defineActor({
    name: "Node",
    zone,
    symmetric: true,
    // Raft keeps `votedFor` on stable storage, so a restart cannot make a node vote twice.
    durable: variant === "fixed" ? ["votedFor"] : [],
    initialState: () => ({ votedFor: null as string | null, votes: [] as string[], leader: false }),
    display: {
      icon: "server",
      names: ["A", "B", "C"],
      status: (s) => (s.leader ? `leader, ${s.votes.length} votes` : s.votes.length ? `candidate, ${s.votes.length} vote(s)` : s.votedFor ? `voted for ${s.votedFor}` : "follower"),
      mood: (s) => (s.leader ? "ok" : s.votes.length ? "busy" : s.votedFor ? "info" : "off"),
    },
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
      requestVote: {
        on: RequestVote,
        description: "Votes for the candidate, unless it has voted in this term already.",
        say: (s, _msg) => `Votes for ${s.votedFor}`,
        sends: [Vote],
        run(state, _msg, ctx) {
          if (state.votedFor !== null) return;
          state.votedFor = ctx.from!.id;
          ctx.reply(Vote, {});
        },
      },
      vote: {
        on: Vote,
        description: "Counts the vote; with a majority, leads.",
        say: (s) => (s.leader ? `Leads, with ${s.votes.length} votes of three` : `Has ${s.votes.length} vote(s)`),
        run(state, _msg, ctx) {
          if (state.votes.includes(ctx.from!.id)) return;
          state.votes.push(ctx.from!.id);
          if (state.votes.length >= 2) state.leader = true;
        },
      },
    },
  });

  const oneLeader = defineProperty("oneLeader", {
    description: "At most one node leads the term.",
    always: (w) => w.all(Node).filter((n) => n.state.leader).length <= 1,
  });

  const anElection = defineScenario("An election", {
    description: "A campaigns, wins B's and C's votes, and leads.",
    run(s) {
      const [a] = ["A", "B", "C"].map((name) => s.spawn(Node, name));
      s.act(a, "campaign");
      s.settle();
    },
  });

  const aVoterRestarts = defineScenario("A voter restarts", {
    description:
      variant === "buggy"
        ? "B votes for A, which leads; B restarts and forgets its vote, votes for C too, and C leads as well."
        : "B votes for A, which leads; B restarts, remembers its vote, and turns C down.",
    run(s) {
      const [a, b, c] = ["A", "B", "C"].map((name) => s.spawn(Node, name));
      s.act(a, "campaign");
      s.deliver(b, RequestVote);
      s.deliver(a, Vote);
      s.restart(b);
      s.act(c, "campaign");
      s.deliver(b, RequestVote);
      s.settle();
    },
  });

  return defineSpec({
    name: `Raft vote (${variant})`,
    actors: [Node],
    properties: [oneLeader],
    finalState: {
      description: "Every node has voted in the term.",
      when: (w) => w.all(Node).every((n) => n.state.votedFor !== null),
    },
    scenarios: [anElection, aVoterRestarts],
  });
}

/** `feynman check raft-vote` checks the buggy variant, so you see the checker find the bug. */
export default raftVote("buggy");
export const fixed = raftVote("fixed");
