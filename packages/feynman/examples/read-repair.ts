// Read repair that overwrites without comparing versions.
//
// A coordinator writes versioned values to three replicas, and a write can reach some
// replicas long before others. On a read it asks the replicas, takes the first two replies,
// returns the newest, and repairs whichever replier was behind by sending it that value.
// Replicas apply writes only if they are newer, but apply a repair as it comes. A repair is
// a write too, and it can be slow: if a newer write reaches the stale replica first, the
// late repair takes it back to the older value. The fix: a repair is a versioned write,
// applied only if newer.
//
// This covers read repair, versioned writes, and the ghost state that lets an invariant
// see the past: each replica remembers the newest version it ever held.
//
// Expected, with three replicas: buggy breaks `neverGoesBack` in 10 steps without faults
// (v1 reaches one replica; a read hears from it and a stale one, and repairs the stale one;
// v2 reaches the stale one; the repair arrives); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function readRepair(variant: "buggy" | "fixed") {
  return defineSpec(
    `Read repair (${variant})`,
    {
      messages: {
        Put: message<{ version: number }>({ name: "put" }),
        Get: message<{}>({ name: "get" }),
        Got: message<{ version: number }>({ name: "got", tone: "reply" }),
        Repair: message<{ version: number }>({ name: "repair" }),
      },
    },
    (spec) => {
      const { Put, Get, Got, Repair } = spec.messages;
      const front = spec.defineZone({ name: "Front", description: "writes to all, reads from the first two", place: { column: 0 } });
      const store = spec.defineZone({ name: "Store", description: "three replicas of one key", place: { column: 1, arrange: "ring", region: true } });

      const Coordinator = spec.defineActor({
        name: "Coordinator",
        zone: front,
        singleton: true,
        // `replies`: the read in progress, by replica; null when not reading.
        initialState: () => ({ written: 0, replies: null as Record<string, number> | null, read: null as number | null }),
        display: {
          icon: "router",
          status: (s) => (s.replies ? `reading: ${Object.keys(s.replies).length} of 2 replies` : s.read !== null ? `read v${s.read}` : s.written ? `wrote v${s.written}` : "idle"),
          mood: (s) => (s.replies ? "busy" : "info"),
        },
        actions: {
          write: {
            label: "Write",
            description: "Writes the next version to every replica.",
            when: (state) => state.written < 2,
            sends: [Put],
            run(state, _inputs, ctx) {
              state.written += 1;
              for (const replica of ctx.all(Replica)) ctx.send(replica, Put, { version: state.written });
            },
          },
          read: {
            label: "Read",
            description: "Asks every replica for the key.",
            when: (state) => state.replies === null && state.read === null,
            sends: [Get],
            run(state, _inputs, ctx) {
              state.replies = {};
              for (const replica of ctx.all(Replica)) ctx.send(replica, Get, {});
            },
          },
        },
        transitions: {
          [Got]: {
            description: "Keeps the reply; with two, returns the newest and repairs a replier that was behind.",
            sends: [Repair],
            say: (s, msg) => (s.read !== null && s.replies === null ? `Reads v${s.read}` : `Hears v${msg.version}`),
            run(state, msg, ctx) {
              if (state.replies === null) return;
              state.replies = { ...state.replies, [ctx.from.id]: msg.version };
              const replies = Object.entries(state.replies);
              if (replies.length < 2) return;
              const newest = Math.max(...replies.map(([, v]) => v));
              for (const replica of ctx.all(Replica)) if ((state.replies[replica.id] ?? newest) < newest) ctx.send(replica, Repair, { version: newest });
              state.read = newest;
              state.replies = null;
            },
          },
        },
      });

      const Replica = spec.defineActor({
        name: "Replica",
        zone: store,
        symmetric: true,
        durable: ["version", "highest"],
        // `highest`: the newest version it ever held, which only the invariant reads.
        initialState: () => ({ version: 0, highest: 0 }),
        display: {
          icon: "database",
          status: (s) => (s.version ? `v${s.version}` : "empty"),
          mood: (s) => (s.version < s.highest ? "bad" : s.version ? "ok" : "off"),
        },
        transitions: {
          [Put]: {
            description: "Takes the write if it is newer.",
            say: (s, msg) => (s.version === msg.version ? `Takes v${msg.version}` : `Ignores v${msg.version}`),
            run(state, msg) {
              if (msg.version > state.version) state.version = msg.version;
              state.highest = Math.max(state.highest, state.version);
            },
          },
          [Get]: {
            description: "Replies with its version.",
            sends: [Got],
            run: (state, _msg, ctx) => ctx.reply(Got, { version: state.version }),
          },
          [Repair]: {
            description: variant === "buggy" ? "Takes the repaired value." : "Takes the repaired value if it is newer.",
            say: (s, msg) => (s.version < s.highest ? `Goes back to v${msg.version}` : s.version === msg.version ? `Repaired to v${msg.version}` : `Ignores the repair to v${msg.version}`),
            run(state, msg) {
              if (variant === "buggy" || msg.version > state.version) state.version = msg.version;
              state.highest = Math.max(state.highest, state.version);
            },
          },
        },
      });

      spec.defineFinalState({
        description: "Both writes are sent and the read is answered.",
        when: (w) => w.the(Coordinator).state.written === 2 && w.the(Coordinator).state.read !== null,
      });
      spec.defineProperties({
        neverGoesBack: {
          description: "No replica ever goes back to an older version than one it held.",
          always: (w) => w.all(Replica).every((r) => r.state.version >= r.state.highest),
        },
      });

      spec.defineScenario({
        name: "A read repairs a stale replica",
        description: "v1 reaches two replicas; a read hears from one of them and the stale one, returns v1 and repairs it.",
        run(s) {
          const [a, b, c] = ["Replica A", "Replica B", "Replica C"].map((name) => s.spawn(Replica, name));
          const coordinator = s.the(Coordinator);
          s.act(coordinator, "write");
          s.deliver(a, "Put");
          s.deliver(b, "Put");
          s.act(coordinator, "read");
          s.deliver(a, "Get");
          s.deliver(c, "Get");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "A slow repair",
        description:
          variant === "buggy"
            ? "The repair to v1 is slow; v2 reaches the stale replica first, and the repair takes it back to v1."
            : "The repair to v1 is slow; v2 reaches the stale replica first, and it ignores the older repair.",
        run(s) {
          const [a, , c] = ["Replica A", "Replica B", "Replica C"].map((name) => s.spawn(Replica, name));
          const coordinator = s.the(Coordinator);
          s.act(coordinator, "write");
          s.deliver(a, "Put");
          s.act(coordinator, "read");
          s.deliver(a, "Get");
          s.deliver(c, "Get");
          s.deliver(coordinator, "Got", { version: 1 });
          s.deliver(coordinator, "Got", { version: 0 });
          s.act(coordinator, "write");
          s.deliver(c, "Put", { version: 2 });
          s.deliver(c, "Repair");
          s.settle();
        },
      });
      return { Coordinator, Replica };
    },
  );
}

/** `feynman check read-repair` checks the buggy variant, so you see the checker find the bug. */
export default readRepair("buggy");
export const fixed = readRepair("fixed");
