// Read-your-writes, with reads served by a follower.
//
// A client writes to a leader, which numbers each write, answers with the number, and
// sends it on to a follower. Reads go to the follower, to spare the leader. Replication is
// asynchronous, so a client that has just been told its write succeeded can read from a
// follower that has not got it yet, and see the value from before its own write. The fix:
// a read says which write it must see (the last one the client was told about), and the
// follower holds it until it has caught up that far. A follower that restarts forgets the
// reads it was holding: they go unanswered, never answered wrong.
//
// This covers session guarantees over asynchronous replication, and requests held until
// state catches up.
//
// Expected: buggy breaks `readsOwnWrites` in 6 steps without faults (write, the leader
// numbers it, the client is told, read, the follower answers from before, the answer
// arrives); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function readYourWrites(variant: "buggy" | "fixed") {
  return defineSpec(
    `Read your writes (${variant})`,
    {
      messages: {
        Write: message<{}>({ name: "write" }),
        Written: message<{ version: number }>({ name: "written", tone: "reply" }),
        Replicate: message<{ version: number }>({ name: "replicate" }),
        Read: message<{ atLeast: number }>({ name: "read" }),
        Value: message<{ version: number; atLeast: number }>({ name: "value", tone: "reply" }),
      },
    },
    (spec) => {
      const { Write, Written, Replicate, Read, Value } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster" });

      const Client = spec.defineActor({
        name: "Client",
        zone,
        singleton: true,
        // `wrote`: the last write the client was told succeeded. `stale`: a read came back older.
        initialState: () => ({ wrote: 0, stale: false }),
        actions: {
          write: { label: "Write", description: "Writes, through the leader.", sends: [Write], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Leader), Write, {}) },
          read: {
            label: "Read",
            description: "Reads from the follower, saying which write it must see.",
            sends: [Read],
            run: (state, _inputs, ctx) => ctx.send(ctx.the(Follower), Read, { atLeast: state.wrote }),
          },
        },
        transitions: {
          [Written]: { description: "Is told its write succeeded, and its number.", run: (state, msg) => void (state.wrote = Math.max(state.wrote, msg.version)) },
          [Value]: { description: "Gets the value it read.", run: (state, msg) => void (state.stale ||= msg.version < msg.atLeast) },
        },
      });

      const Leader = spec.defineActor({
        name: "Leader",
        zone,
        durable: ["version"],
        initialState: () => ({ version: 0 }),
        transitions: {
          [Write]: {
            description: "Numbers the write, answers with its number, and replicates it.",
            sends: [Written, Replicate],
            run(state, _msg, ctx) {
              state.version += 1;
              ctx.reply(Written, { version: state.version });
              ctx.send(ctx.the(Follower), Replicate, { version: state.version });
            },
          },
        },
      });

      const Follower = spec.defineActor({
        name: "Follower",
        zone,
        // What it has replicated is on disk; the reads it holds (sorted) are not.
        durable: ["version"],
        initialState: () => ({ version: 0, holding: [] as number[] }),
        transitions: {
          [Replicate]: {
            description: "Catches up, and answers the reads it was holding that it now can.",
            sends: [Value],
            run(state, msg, ctx) {
              state.version = Math.max(state.version, msg.version);
              for (const atLeast of state.holding.filter((a) => a <= state.version)) ctx.send(ctx.the(Client), Value, { version: state.version, atLeast });
              state.holding = state.holding.filter((a) => a > state.version);
            },
          },
          [Read]: {
            description: variant === "buggy" ? "Answers with what it has." : "Answers if it has the write the read must see, else holds the read.",
            sends: [Value],
            run(state, msg, ctx) {
              if (variant === "fixed" && state.version < msg.atLeast) {
                state.holding = [...state.holding, msg.atLeast].sort((a, b) => a - b);
                return;
              }
              ctx.reply(Value, { version: state.version, atLeast: msg.atLeast });
            },
          },
        },
      });

      spec.defineInvariants({
        readsOwnWrites: { description: "A read never comes back older than the client's own writes it was told about.", always: (w) => !w.the(Client).state.stale },
      });
      return { Client, Leader, Follower };
    },
  );
}

/** `feynman check read-your-writes` checks the buggy variant, so you see the checker find the bug. */
export default readYourWrites("buggy");
export const fixed = readYourWrites("fixed");
