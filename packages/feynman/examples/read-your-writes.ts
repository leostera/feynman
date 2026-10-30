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
import { defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone } from "@leostera/feynman";

const Write = defineMessage("Write");
const Written = defineMessage("Written", { version: Number }, { tone: "reply" });
const Replicate = defineMessage("Replicate", { version: Number });
const Read = defineMessage("Read", { atLeast: Number });
const Value = defineMessage("Value", { version: Number, atLeast: Number }, { tone: "reply" });

export function readYourWrites(variant: "buggy" | "fixed") {
  const clients = defineZone({ name: "Clients", place: { column: 0, region: false } });
  const zone = defineZone({ name: "Cluster", description: "writes at the leader, reads at the follower", place: { column: 1, arrange: "row", region: true } });

  const Client = defineActor({
    name: "Client",
    zone: clients,
    singleton: true,
    // `wrote`: the last write the client was told succeeded. `stale`: a read came back older.
    initialState: () => ({ wrote: 0, stale: false }),
    display: {
      icon: "laptop",
      status: (s) => (s.stale ? "read an old value" : s.wrote ? `wrote version ${s.wrote}` : "nothing written"),
      mood: (s) => (s.stale ? "bad" : "ok"),
    },
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
      written: { on: Written, description: "Is told its write succeeded, and its number.", run: (state, msg) => void (state.wrote = Math.max(state.wrote, msg.version)) },
      value: { on: Value, description: "Gets the value it read.", run: (state, msg) => void (state.stale ||= msg.version < msg.atLeast) },
    },
  });

  const Leader = defineActor({
    name: "Leader",
    zone,
    place: { order: 0 },
    durable: ["version"],
    initialState: () => ({ version: 0 }),
    display: { icon: "database", status: (s) => `at version ${s.version}`, mood: () => "ok" },
    transitions: {
      write: {
        on: Write,
        description: "Numbers the write, answers with its number, and replicates it.",
        say: (s) => `Stored version ${s.version}, told the client, and sent it to the follower`,
        sends: [Written, Replicate],
        run(state, _msg, ctx) {
          state.version += 1;
          ctx.reply(Written, { version: state.version });
          ctx.send(ctx.the(Follower), Replicate, { version: state.version });
        },
      },
    },
  });

  const Follower = defineActor({
    name: "Follower",
    zone,
    place: { order: 1 },
    // What it has replicated is on disk; the reads it holds (sorted) are not.
    durable: ["version"],
    initialState: () => ({ version: 0, holding: [] as number[] }),
    display: {
      icon: "database",
      status: (s) => `at version ${s.version}${s.holding.length ? `, holding ${s.holding.length} read(s)` : ""}`,
      mood: (s) => (s.holding.length ? "busy" : "info"),
    },
    transitions: {
      replicate: {
        on: Replicate,
        description: "Catches up, and answers the reads it was holding that it now can.",
        sends: [Value],
        run(state, msg, ctx) {
          state.version = Math.max(state.version, msg.version);
          for (const atLeast of state.holding.filter((a) => a <= state.version)) ctx.send(ctx.the(Client), Value, { version: state.version, atLeast });
          state.holding = state.holding.filter((a) => a > state.version);
        },
      },
      read: {
        on: Read,
        description: variant === "buggy" ? "Answers with what it has." : "Answers if it has the write the read must see, else holds the read.",
        say: (s, msg) => (s.version >= msg.atLeast ? `Answered version ${s.version}` : variant === "buggy" ? `Answered version ${s.version}, older than the client's own ${msg.atLeast}` : `Holds the read until it has version ${msg.atLeast}`),
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

  const readsOwnWrites = defineProperty("readsOwnWrites", { description: "A read never comes back older than the client's own writes it was told about.", always: (w) => !w.the(Client).state.stale });

  const writeThenRead = defineScenario("Write, then read", {
    description: variant === "buggy" ? "The client reads before the follower has its write, and sees the old value." : "The client reads before the follower has its write; the follower holds the read until it catches up.",
    run(s) {
      const client = s.the(Client);
      const leader = s.spawn(Leader, "Leader");
      const follower = s.spawn(Follower, "Follower");
      s.act(client, "write");
      s.deliver(leader, Write);
      s.deliver(client, Written);
      s.act(client, "read");
      s.deliver(follower, Read);
      s.settle();
    },
  });

  const readingAfterReplication = defineScenario("Reading after replication", {
    description: "The follower has caught up before the read arrives: the client sees its write either way.",
    run(s) {
      const client = s.the(Client);
      s.spawn(Leader, "Leader");
      s.spawn(Follower, "Follower");
      s.act(client, "write");
      s.settle();
      s.act(client, "read");
      s.settle();
    },
  });

  return defineSpec({
    name: `Read your writes (${variant})`,
    actors: [Client, Leader, Follower],
    properties: [readsOwnWrites],
    scenarios: [writeThenRead, readingAfterReplication],
  });
}

/** `feynman check read-your-writes` checks the buggy variant, so you see the checker find the bug. */
export default readYourWrites("buggy");
export const fixed = readYourWrites("fixed");
