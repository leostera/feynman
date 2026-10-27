// Quorum reads and writes that do not overlap.
//
// A value is kept on three replicas. A write goes to all of them and succeeds once W have
// acknowledged it; a read asks all of them and takes the newest of the first R answers.
// A read is sure to see a finished write only if every read quorum shares a replica with
// every write quorum: R + W > N. Writing to a majority (W = 2) and reading from one replica
// (R = 1) adds up to N, not more: the write lands on two replicas, the read asks the third,
// and the client reads what was there before. The fix: read from a majority too (R = 2).
//
// This covers quorum intersection, and messages to every instance of an actor.
//
// Expected, with three replicas: buggy breaks `readSeesWrite` in 8 steps without faults
// (write, two replicas store it, both acknowledgements arrive, read, the third replica
// answers, its answer arrives); fixed holds, with a fault too.
import { defineSpec, message } from "@leostera/feynman";

export function quorum(variant: "buggy" | "fixed") {
  const W = 2;
  const R = variant === "buggy" ? 1 : 2;
  return defineSpec(
    `Quorum (${variant}): W = ${W}, R = ${R}, N = 3`,
    {
      messages: {
        Write: message<{ version: number }>({ name: "write" }),
        Ack: message<{}>({ name: "ack", tone: "reply" }),
        Read: message<{}>({ name: "read" }),
        Value: message<{ version: number }>({ name: "value", tone: "reply" }),
      },
    },
    (spec) => {
      const { Write, Ack, Read, Value } = spec.messages;
      const zone = spec.defineZone({ name: "Cluster", place: { arrange: "row" } });

      const Client = spec.defineActor({
        name: "Client",
        zone,
        singleton: true,
        initialState: () => ({ phase: "idle" as "idle" | "writing" | "written" | "reading" | "read", acks: 0, answers: 0, newest: 0 }),
        actions: {
          write: {
            label: "Write",
            description: "Writes version 1 to every replica.",
            when: (state) => state.phase === "idle",
            sends: [Write],
            run(state, _inputs, ctx) {
              state.phase = "writing";
              for (const replica of ctx.all(Replica)) ctx.send(replica, Write, { version: 1 });
            },
          },
          read: {
            label: "Read",
            description: "Once the write has succeeded, asks every replica for the value.",
            when: (state) => state.phase === "written",
            sends: [Read],
            run(state, _inputs, ctx) {
              state.phase = "reading";
              for (const replica of ctx.all(Replica)) ctx.send(replica, Read, {});
            },
          },
        },
        transitions: {
          [Ack]: {
            description: `Counts acknowledgements; the write has succeeded at ${W}.`,
            run(state) {
              if (state.phase !== "writing") return;
              state.acks += 1;
              if (state.acks === W) state.phase = "written";
            },
          },
          [Value]: {
            description: `Keeps the newest answer; the read is done at ${R}.`,
            run(state, msg) {
              if (state.phase !== "reading") return;
              state.answers += 1;
              state.newest = Math.max(state.newest, msg.version);
              if (state.answers === R) state.phase = "read";
            },
          },
        },
      });

      const Replica = spec.defineActor({
        name: "Replica",
        zone,
        symmetric: true,
        durable: ["version"],
        initialState: () => ({ version: 0 }),
        transitions: {
          [Write]: {
            description: "Stores the write and acknowledges it.",
            sends: [Ack],
            run(state, msg, ctx) {
              state.version = Math.max(state.version, msg.version);
              ctx.reply(Ack, {});
            },
          },
          [Read]: { description: "Answers with the version it has.", sends: [Value], run: (state, _msg, ctx) => ctx.reply(Value, { version: state.version }) },
        },
      });

      spec.defineInvariants({
        readSeesWrite: {
          description: "A read that starts after a write has succeeded sees it.",
          always: (w) => w.the(Client).state.phase !== "read" || w.the(Client).state.newest >= 1,
        },
      });
      return { Client, Replica };
    },
  );
}

/** `feynman check quorum` checks the buggy variant, so you see the checker find the bug. */
export default quorum("buggy");
export const fixed = quorum("fixed");
