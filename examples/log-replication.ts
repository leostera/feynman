// Log replication without checking where an entry goes.
//
// A leader appends entries to its log and sends each to a follower, which should end up
// with the same log. The follower appends whatever arrives. Entries can overtake each
// other, so the second entry can arrive first, and the follower's log no longer matches the
// leader's: a gap where the first entry should be. Raft's fix: each entry says where it
// goes, and the follower takes it only if it comes right after its last entry; otherwise it
// says how far its log reaches, and the leader sends the entry that goes there.
//
// This covers ordering by index over a network that reorders, and catching up by asking.
//
// Expected: buggy breaks `followerIsPrefix` in 3 steps without faults (the leader appends x,
// then y, and y arrives first); fixed holds, with a fault too, but a lost entry is never sent
// again: stuck in 4 steps, the follower short of the leader.
import { defineSpec, message } from "@leostera/feynman";

const ENTRIES = ["x", "y"];

export function logReplication(variant: "buggy" | "fixed") {
  return defineSpec(
    `Log replication (${variant})`,
    {
      messages: {
        Append: message<{ index: number; entry: string }>({ name: "append" }),
        Behind: message<{ length: number }>({ name: "behind", tone: "refused" }),
      },
    },
    (spec) => {
      const { Append, Behind } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster", description: "the follower should hold a copy of the leader's log", place: { arrange: "row" } });

      const Leader = spec.defineActor({
        name: "Leader",
        zone,
        singleton: true,
        place: { order: 0 },
        initialState: () => ({ log: [] as string[] }),
        look: {
          icon: "server",
          status: (s) => (s.log.length ? `log: ${s.log.join(", ")}` : "empty log"),
          mood: () => "ok",
          rows: (s) => s.log.map((entry, i) => ({ group: "log", label: `${i + 1}`, detail: entry })),
        },
        actions: {
          append: {
            label: "Append",
            description: "Appends the next entry to its log and sends it to the follower.",
            when: (state) => state.log.length < ENTRIES.length,
            sends: [Append],
            run(state, _inputs, ctx) {
              const entry = ENTRIES[state.log.length];
              state.log.push(entry);
              ctx.send(ctx.the(Follower), Append, { index: state.log.length - 1, entry });
            },
          },
        },
        transitions: {
          [Behind]: {
            description: "Sends the entry that goes where the follower's log ends.",
            sends: [Append],
            say: (s, msg) => (msg.length < s.log.length ? `Sends entry ${msg.length + 1} again` : "The follower has everything"),
            run(state, msg, ctx) {
              if (msg.length < state.log.length) ctx.send(ctx.the(Follower), Append, { index: msg.length, entry: state.log[msg.length] });
            },
          },
        },
      });

      const Follower = spec.defineActor({
        name: "Follower",
        zone,
        singleton: true,
        place: { order: 1 },
        initialState: () => ({ log: [] as string[] }),
        look: {
          icon: "server",
          status: (s) => (s.log.length ? `log: ${s.log.join(", ")}` : "empty log"),
          mood: (s) => (s.log.every((entry, i) => entry === ENTRIES[i]) ? "info" : "bad"),
          rows: (s) => s.log.map((entry, i) => ({ group: "log", label: `${i + 1}`, detail: entry })),
        },
        transitions: {
          [Append]: {
            description: variant === "buggy" ? "Appends the entry." : "Appends the entry if it goes right after its last one; otherwise says how far its log reaches.",
            sends: variant === "buggy" ? [] : [Behind],
            say: (s, msg) => (s.log[msg.index] === msg.entry && s.log.length === msg.index + 1 ? `Appends ${msg.entry}` : variant === "buggy" ? `Appends ${msg.entry}, at ${s.log.length} not ${msg.index + 1}` : `Turns down ${msg.entry}: its log has ${s.log.length}`),
            run(state, msg, ctx) {
              if (variant === "buggy") return void state.log.push(msg.entry);
              if (msg.index === state.log.length) return void state.log.push(msg.entry);
              ctx.reply(Behind, { length: state.log.length });
            },
          },
        },
      });

      spec.defineFinalState({
        description: "Both logs hold every entry.",
        when: (w) => w.the(Leader).state.log.length === ENTRIES.length && w.the(Follower).state.log.length === ENTRIES.length,
      });
      spec.defineProperties({
        followerIsPrefix: {
          description: "The follower's log is always the start of the leader's.",
          always: (w) => w.the(Follower).state.log.every((entry, i) => entry === w.the(Leader).state.log[i]),
        },
      });

      spec.defineScenario({
        name: "Two entries, in order",
        description: "x arrives, then y: the follower's log matches the leader's.",
        run(s) {
          const leader = s.the(Leader);
          s.act(leader, "append");
          s.act(leader, "append");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "The second entry overtakes the first",
        description:
          variant === "buggy"
            ? "y arrives before x, and the follower appends it first: its log starts with y."
            : "y arrives before x, and the follower turns it down; x arrives, then y again when the leader resends it.",
        run(s) {
          const leader = s.the(Leader);
          const follower = s.the(Follower);
          s.act(leader, "append");
          s.act(leader, "append");
          s.deliver(follower, "Append", { index: 1, entry: "y" });
          s.settle();
        },
      });
      return { Leader, Follower };
    },
  );
}

/** `feynman check log-replication` checks the buggy variant, so you see the checker find the bug. */
export default logReplication("buggy");
export const fixed = logReplication("fixed");
