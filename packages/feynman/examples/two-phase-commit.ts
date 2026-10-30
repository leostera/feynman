// Two-phase commit.
//
// A coordinator asks every participant to prepare; each votes yes or no (a no aborts on the
// spot); the coordinator commits only if all voted yes. The buggy coordinator decides on the
// first vote it hears. Even correct, 2PC blocks when a vote is lost: the coordinator waits
// for it forever (there are no timeouts here, on purpose).
//
// Expected, with two participants:
// - buggy breaks `atomic` in 7 steps (begin, prepare one, it votes yes, the coordinator
//   commits, the commit arrives, prepare the other, it votes no) with no fault;
// - fixed keeps `atomic`; `decides` holds without faults and breaks with one, in 7 steps
//   (begin, two prepares, two votes, one vote lost, the other counted), after which nothing
//   can happen: the coordinator waits forever. The checker reports that as stuck, too, as
//   early as it can: in 5 steps (begin, prepare one, it votes, the vote is counted, the
//   other prepare lost).
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, oneOf, type Script } from "@leostera/feynman";

const Prepare = defineMessage("Prepare");
const Vote = defineMessage("Vote", { yes: Boolean });
const Decide = defineMessage("Decide", { commit: Boolean });

export function twoPhaseCommit(variant: "buggy" | "fixed") {
  const zone = defineZone({ name: "Database", description: "every participant commits, or none does", place: { arrange: "row" } });

  const Participant = defineActor({
    name: "Participant",
    zone,
    place: { order: 1 },
    symmetric: true,
    // Votes are written to a log before they are sent, so restarts change nothing.
    durable: ["prepared", "vote", "outcome"],
    initialState: () => ({ prepared: false, vote: null as "yes" | "no" | null, outcome: null as "commit" | "abort" | null }),
    display: {
      icon: "database",
      status: (s) => (s.outcome ? (s.outcome === "commit" ? "committed" : "aborted") : s.vote ? `voted ${s.vote}, waiting` : s.prepared ? "prepared" : "idle"),
      mood: (s) => (s.outcome === "commit" ? "ok" : s.outcome === "abort" ? "warn" : s.vote ? "busy" : "off"),
    },
    actions: {
      vote: {
        label: "Vote",
        description: "Votes on the transaction; a no aborts it here at once.",
        when: (state) => state.prepared && state.vote === null,
        inputs: { choice: oneOf("yes", "no") },
        sends: [Vote],
        run(state, { choice }, ctx) {
          state.vote = choice;
          if (choice === "no") state.outcome = "abort";
          ctx.send(ctx.the(Coordinator), Vote, { yes: choice === "yes" });
        },
      },
    },
    transitions: {
      prepare: { on: Prepare, description: "Gets ready to vote.", run: (state) => void (state.prepared = true) },
      decide: {
        on: Decide,
        description: "Applies the decision.",
        run(state, msg) {
          if (state.outcome === null) state.outcome = msg.commit ? "commit" : "abort";
        },
      },
    },
  });

  const Coordinator = defineActor({
    name: "Coordinator",
    zone,
    place: { order: 0 },
    singleton: true,
    initialState: () => ({ begun: false, votes: {} as Record<string, boolean>, decided: null as boolean | null }),
    display: {
      icon: "gear",
      status: (s) => (s.decided === null ? (s.begun ? `${Object.keys(s.votes).length} vote(s) in` : "idle") : s.decided ? "decided: commit" : "decided: abort"),
      mood: (s) => (s.decided === null ? (s.begun ? "busy" : "off") : "ok"),
      rows: (s) => Object.entries(s.votes).map(([id, yes]) => ({ label: id, detail: yes ? "yes" : "no", mood: yes ? ("ok" as const) : ("warn" as const) })),
    },
    actions: {
      begin: {
        label: "Begin",
        description: "Asks every participant to prepare.",
        when: (state) => !state.begun,
        sends: [Prepare],
        run(state, _inputs, ctx) {
          state.begun = true;
          for (const p of ctx.all(Participant)) ctx.send(p, Prepare, {});
        },
      },
    },
    transitions: {
      vote: {
        on: Vote,
        description: "Counts a vote, and decides once it can.",
        say: (s, msg) => (s.decided === null ? `Counts a ${msg.yes ? "yes" : "no"}, waits for the rest` : `Counts a ${msg.yes ? "yes" : "no"}: ${s.decided ? "commit" : "abort"}`),
        sends: [Decide],
        run(state, msg, ctx) {
          state.votes[ctx.from!.id] = msg.yes;
          if (state.decided !== null) return;
          const participants = ctx.all(Participant);
          const all = participants.every((p) => p.id in state.votes);
          const decide = variant === "buggy" ? true : all || !msg.yes;
          if (!decide) return;
          state.decided = variant === "buggy" ? msg.yes : Object.values(state.votes).every(Boolean) && all;
          for (const p of participants) ctx.send(p, Decide, { commit: state.decided });
        },
      },
    },
  });

  const atomic = defineProperty("atomic", {
    description: "No participant commits while another aborts.",
    always: (w) => {
      const outcomes = w.all(Participant).map((p) => p.state.outcome);
      return !(outcomes.includes("commit") && outcomes.includes("abort"));
    },
  });

  const decidedOnceQuiet = defineProperty("decidedOnceQuiet", {
    description: "Once everyone has voted and nothing is in flight, the coordinator has decided.",
    always: (w) => !(w.quiet && w.all(Participant).every((p) => p.state.vote !== null)) || w.the(Coordinator).state.decided !== null,
  });

  const decides = defineProperty("decides", {
    description: "Once everyone has voted, the coordinator decides.",
    leadsTo: {
      whenever: (w) => w.all(Participant).every((p) => p.state.vote !== null),
      then: (w) => w.the(Coordinator).state.decided !== null,
    },
  });
  const start = (s: Script) => {
    const [a, b] = ["Participant A", "Participant B"].map((name) => s.spawn(Participant, name));
    s.act(s.the(Coordinator), "begin");
    s.settle();
    return [a, b];
  };

  const everyoneVotesYes = defineScenario("Everyone votes yes", {
    description: "Both participants vote yes, and both commit.",
    run(s) {
      const [a, b] = start(s);
      s.act(a, "vote", { choice: "yes" });
      s.act(b, "vote", { choice: "yes" });
      s.settle();
    },
  });

  const oneVotesNo = defineScenario("One votes no", {
    description:
      variant === "buggy"
        ? "A's yes arrives first, and the coordinator commits on it; B has voted no and aborted."
        : "A's yes arrives first, and the coordinator waits; B's no aborts everyone.",
    run(s) {
      const [a, b] = start(s);
      s.act(a, "vote", { choice: "yes" });
      s.deliver(s.the(Coordinator), Vote);
      s.act(b, "vote", { choice: "no" });
      s.settle();
    },
  });

  const aVoteIsLost = defineScenario("A vote is lost", {
    description:
      variant === "buggy"
        ? "A's vote is lost; the coordinator decides on B's alone."
        : "A's vote is lost, and the coordinator waits for it forever: two-phase commit blocks.",
    run(s) {
      const [a, b] = start(s);
      s.act(a, "vote", { choice: "yes" });
      s.act(b, "vote", { choice: "yes" });
      s.drop(s.the(Coordinator), Vote);
      s.settle();
    },
  });

  return defineSpec({
    name: `Two-phase commit (${variant})`,
    actors: [Participant, Coordinator],
    properties: [atomic, decidedOnceQuiet, decides],
    finalState: {
      description: "Every participant knows the outcome.",
      when: (w) => w.all(Participant).every((p) => p.state.outcome !== null),
    },
    scenarios: [everyoneVotesYes, oneVotesNo, aVoteIsLost],
  });
}

/** `feynman check two-phase-commit` checks the buggy variant, so you see the checker find the bug. */
export default twoPhaseCommit("buggy");
export const fixed = twoPhaseCommit("fixed");
