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
// - fixed keeps `atomic`; `decides` holds without faults and breaks with one, in 6 steps
//   (begin, two prepares, two votes, one vote lost).
import { defineSpec, message, SEC } from "@feynman/spec";

export function twoPhaseCommit(variant: "buggy" | "fixed") {
  return defineSpec(
    `Two-phase commit (${variant})`,
    {
      messages: {
        Prepare: message<{}>({ name: "prepare" }),
        Vote: message<{ yes: boolean }>({ name: "vote" }),
        Decide: message<{ commit: boolean }>({ name: "decide" }),
      },
    },
    (spec) => {
      const { Prepare, Vote, Decide } = spec.messages;
      const zone = spec.defineZone({ name: "Database" });

      const Participant = spec.defineActor({
        name: "Participant",
        zone,
        symmetric: true,
        // Votes are written to a log before they are sent, so restarts change nothing.
        durable: ["prepared", "vote", "outcome"],
        initialState: () => ({ prepared: false, vote: null as "yes" | "no" | null, outcome: null as "commit" | "abort" | null }),
        actions: {
          vote: {
            label: "Vote",
            description: "Votes on the transaction; a no aborts it here at once.",
            when: (state) => state.prepared && state.vote === null,
            inputs: { choice: { type: ["yes", "no"] as const } },
            sends: [Vote],
            run(state, { choice }, ctx) {
              state.vote = choice;
              if (choice === "no") state.outcome = "abort";
              ctx.send(ctx.the(Coordinator), Vote, { yes: choice === "yes" });
            },
          },
        },
        transitions: {
          [Prepare]: { description: "Gets ready to vote.", run: (state) => void (state.prepared = true) },
          [Decide]: {
            description: "Applies the decision.",
            run(state, msg) {
              if (state.outcome === null) state.outcome = msg.commit ? "commit" : "abort";
            },
          },
        },
      });

      const Coordinator = spec.defineActor({
        name: "Coordinator",
        zone,
        singleton: true,
        initialState: () => ({ begun: false, votes: {} as Record<string, boolean>, decided: null as boolean | null }),
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
          [Vote]: {
            description: "Counts a vote, and decides once it can.",
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

      spec.defineInvariants({
        atomic: {
          description: "No participant commits while another aborts.",
          always: (w) => {
            const outcomes = w.all(Participant).map((p) => p.state.outcome);
            return !(outcomes.includes("commit") && outcomes.includes("abort"));
          },
        },
        decidedOnceQuiet: {
          description: "Once everyone has voted and nothing is in flight, the coordinator has decided.",
          always: (w) => !(w.quiet && w.all(Participant).every((p) => p.state.vote !== null)) || w.the(Coordinator).state.decided !== null,
        },
        decides: {
          description: "Once everyone has voted, the coordinator decides.",
          after: (w) => w.all(Participant).every((p) => p.state.vote !== null),
          eventually: (w) => w.the(Coordinator).state.decided !== null,
          within: 10 * SEC,
        },
      });
      return { Participant, Coordinator };
    },
  );
}
