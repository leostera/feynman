// Chain replication, reading from the wrong end.
//
// Two replicas form a chain: writes enter at the head, which passes each on to the tail.
// The tail is the only replica sure to have nothing the other lacks, so chain replication
// serves reads from the tail. Reading from whichever replica is nearer, a client can read a
// write from the head, then read from the tail, which has not got it yet, and see the value
// go back in time. The fix: reads go to the tail. One read at a time, a client then never
// sees a value older than one it has seen: the tail only moves forward.
//
// This covers monotonic reads, and an action input that picks the instance to ask.
//
// Expected: buggy breaks `monotonicReads` in 8 steps without faults (write, the head stores
// it and passes it on, read from the head, the head answers, the answer arrives, read from
// the tail, the tail answers from before, the answer arrives); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function chainReplication(variant: "buggy" | "fixed") {
  return defineSpec(
    `Chain replication (${variant})`,
    {
      messages: {
        Write: message<{}>({ name: "write" }),
        Update: message<{ version: number }>({ name: "update" }),
        Read: message<{}>({ name: "read" }),
        Value: message<{ version: number }>({ name: "value", tone: "reply" }),
      },
    },
    (spec) => {
      const { Write, Update, Read, Value } = spec.messages;
      const zone = spec.defineZone({ name: "Chain", place: { arrange: "row" } });

      const Client = spec.defineActor({
        name: "Client",
        zone,
        singleton: true,
        // `seen`: the newest version read so far. `regressed`: a read came back older.
        initialState: () => ({ reading: false, seen: 0, regressed: false }),
        actions: {
          write: { label: "Write", description: "Writes, at the head.", sends: [Write], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Head), Write, {}) },
          read: {
            label: "Read",
            description: variant === "buggy" ? "Reads from either replica, one read at a time." : "Reads from the tail, one read at a time.",
            when: (state) => !state.reading,
            inputs: { from: { type: variant === "buggy" ? (["head", "tail"] as const) : (["tail"] as const) } },
            sends: [Read],
            run(state, inputs, ctx) {
              state.reading = true;
              ctx.send(inputs.from === "head" ? ctx.the(Head) : ctx.the(Tail), Read, {});
            },
          },
        },
        transitions: {
          [Value]: {
            description: "Gets the value it read.",
            run(state, msg) {
              state.reading = false;
              state.regressed ||= msg.version < state.seen;
              state.seen = Math.max(state.seen, msg.version);
            },
          },
        },
      });

      const Head = spec.defineActor({
        name: "Head",
        zone,
        durable: ["version"],
        initialState: () => ({ version: 0 }),
        transitions: {
          [Write]: {
            description: "Stores the write and passes it down the chain.",
            sends: [Update],
            run(state, _msg, ctx) {
              state.version += 1;
              ctx.send(ctx.the(Tail), Update, { version: state.version });
            },
          },
          [Read]: { description: "Answers with what it has.", sends: [Value], run: (state, _msg, ctx) => ctx.reply(Value, { version: state.version }) },
        },
      });

      const Tail = spec.defineActor({
        name: "Tail",
        zone,
        durable: ["version"],
        initialState: () => ({ version: 0 }),
        transitions: {
          [Update]: { description: "Stores the write.", run: (state, msg) => void (state.version = Math.max(state.version, msg.version)) },
          [Read]: { description: "Answers with what it has.", sends: [Value], run: (state, _msg, ctx) => ctx.reply(Value, { version: state.version }) },
        },
      });

      spec.defineInvariants({
        monotonicReads: { description: "A read never comes back older than one the client already read.", always: (w) => !w.the(Client).state.regressed },
      });
      return { Client, Head, Tail };
    },
  );
}

/** `feynman check chain-replication` checks the buggy variant, so you see the checker find the bug. */
export default chainReplication("buggy");
export const fixed = chainReplication("fixed");
