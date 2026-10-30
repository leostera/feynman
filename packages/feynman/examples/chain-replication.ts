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
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, oneOf } from "@leostera/feynman";

const Write = defineMessage("Write");
const Update = defineMessage("Update", { version: Number });
const Read = defineMessage("Read");
const Value = defineMessage("Value", { version: Number }, { tone: "reply" });

export function chainReplication(variant: "buggy" | "fixed") {
  const clients = defineZone({ name: "Clients", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Chain", description: "writes in at the head, out at the tail", place: { column: 1, arrange: "row", region: true } });

  const Client = defineActor({
    name: "Client",
    zone: clients,
    singleton: true,
    // `seen`: the newest version read so far. `regressed`: a read came back older.
    initialState: () => ({ reading: false, seen: 0, regressed: false }),
    display: {
      icon: "laptop",
      status: (s) => (s.regressed ? "saw a value go back in time" : s.reading ? "reading" : s.seen ? `last read version ${s.seen}` : "nothing read"),
      mood: (s) => (s.regressed ? "bad" : s.reading ? "busy" : "ok"),
    },
    actions: {
      write: { label: "Write", description: "Writes, at the head.", sends: [Write], run: (_state, _inputs, ctx) => ctx.send(ctx.the(Head), Write, {}) },
      read: {
        label: "Read",
        description: variant === "buggy" ? "Reads from either replica, one read at a time." : "Reads from the tail, one read at a time.",
        when: (state) => !state.reading,
        inputs: { from: variant === "buggy" ? oneOf("head", "tail") : oneOf("tail") },
        sends: [Read],
        run(state, inputs, ctx) {
          state.reading = true;
          ctx.send(inputs.from === "head" ? ctx.the(Head) : ctx.the(Tail), Read, {});
        },
      },
    },
    transitions: {
      value: {
        on: Value,
        description: "Gets the value it read.",
        run(state, msg) {
          state.reading = false;
          state.regressed ||= msg.version < state.seen;
          state.seen = Math.max(state.seen, msg.version);
        },
      },
    },
  });

  const Head = defineActor({
    name: "Head",
    zone,
    place: { order: 0 },
    durable: ["version"],
    initialState: () => ({ version: 0 }),
    display: { icon: "database", status: (s) => `at version ${s.version}`, mood: () => "info" },
    transitions: {
      write: {
        on: Write,
        description: "Stores the write and passes it down the chain.",
        sends: [Update],
        run(state, _msg, ctx) {
          state.version += 1;
          ctx.send(ctx.the(Tail), Update, { version: state.version });
        },
      },
      read: { on: Read, description: "Answers with what it has.", sends: [Value], run: (state, _msg, ctx) => ctx.reply(Value, { version: state.version }) },
    },
  });

  const Tail = defineActor({
    name: "Tail",
    zone,
    place: { order: 1 },
    durable: ["version"],
    initialState: () => ({ version: 0 }),
    display: { icon: "database", status: (s) => `at version ${s.version}`, mood: () => "ok" },
    transitions: {
      update: { on: Update, description: "Stores the write.", run: (state, msg) => void (state.version = Math.max(state.version, msg.version)) },
      read: { on: Read, description: "Answers with what it has.", sends: [Value], run: (state, _msg, ctx) => ctx.reply(Value, { version: state.version }) },
    },
  });

  const monotonicReads = defineProperty("monotonicReads", { description: "A read never comes back older than one the client already read.", always: (w) => !w.the(Client).state.regressed });

  const readingFromBothEnds = defineScenario("Reading from both ends", {
    description: variant === "buggy" ? "A read at the head sees the new write; the next, at the tail, does not." : "Both reads go to the tail: the first sees the old value, the second the new one.",
    run(s) {
      const client = s.the(Client);
      const head = s.spawn(Head, "Head");
      const tail = s.spawn(Tail, "Tail");
      s.act(client, "write");
      s.deliver(head, Write);
      s.act(client, "read", { from: variant === "buggy" ? "head" : "tail" } as never);
      s.deliver(variant === "buggy" ? head : tail, Read);
      s.deliver(client, Value);
      s.act(client, "read", { from: "tail" });
      s.deliver(tail, Read);
      s.settle();
    },
  });

  const aWriteDownTheChain = defineScenario("A write down the chain", {
    description: "The write reaches the tail before the read: the client sees it.",
    run(s) {
      const client = s.the(Client);
      s.spawn(Head, "Head");
      s.spawn(Tail, "Tail");
      s.act(client, "write");
      s.settle();
      s.act(client, "read", { from: "tail" });
      s.settle();
    },
  });

  return defineSpec({
    name: `Chain replication (${variant})`,
    actors: [Client, Head, Tail],
    properties: [monotonicReads],
    scenarios: [readingFromBothEnds, aWriteDownTheChain],
  });
}

/** `feynman check chain-replication` checks the buggy variant, so you see the checker find the bug. */
export default chainReplication("buggy");
export const fixed = chainReplication("fixed");
