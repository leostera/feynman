// A last-writer-wins register without a tie-break.
//
// Two writers each stamp their writes with their own clock and send them to both replicas.
// A replica keeps the write with the newest stamp, so whatever order writes arrive in, the
// replicas should end up holding the same one. But two writers' clocks can show the same
// time: each replica then keeps whichever of the two arrived first, and if they arrived in
// different orders the replicas disagree for good. The fix: break ties the same way
// everywhere, by writer. Even then, last-writer-wins only converges if every write reaches
// every replica; a lost write needs anti-entropy, which this register does not have.
//
// This covers convergence as a safety property ("once quiet, they agree"), and total orders.
//
// Expected, with two writers and two replicas: buggy breaks `convergesOnceQuiet` in 6 steps
// without faults (both write at time 1, and each replica gets them in a different order),
// and in 3 with a fault (a write reaches one replica and is lost on the way to the other);
// fixed holds without faults, and breaks in those 3 steps with one.
import { atMost, budget, crash, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, lose } from "@leostera/feynman";

/** Faults on one path: lost messages and crashes (RFD0012). `--set faults=2` raises it. */
const faults = budget("faults", 1);

const Put = defineMessage("Put", { ts: Number, writer: String });

export function lwwRegister(variant: "buggy" | "fixed") {
  /** Whether a stamp (time, writer) is newer than another: by time, then, fixed, by writer. */
  const newer = (a: { ts: number; writer: string }, b: { ts: number; writer: string }) => a.ts > b.ts || (variant === "fixed" && a.ts === b.ts && a.writer > b.writer);
  const writers = defineZone({ name: "Writers", description: "each with its own clock", place: { column: 0 } });
  const replicas = defineZone({ name: "Replicas", description: "each keeps the newest write", place: { column: 1, region: true } });

  const Writer = defineActor({
    name: "Writer",
    zone: writers,
    initialState: () => ({ clock: 0 }),
    display: { icon: "laptop", status: (s) => (s.clock ? `last wrote at time ${s.clock}` : "nothing written"), mood: (s) => (s.clock ? "info" : "off") },
    actions: {
      write: {
        with: [atMost(2)],
        label: "Write",
        description: "Stamps a write with its clock and sends it to every replica.",
        sends: [Put],
        run(state, _inputs, ctx) {
          state.clock += 1;
          for (const replica of ctx.all(Replica)) ctx.send(replica, Put, { ts: state.clock, writer: ctx.id });
        },
      },
    },
    transitions: {
      crash: crash({ spend: faults }),
    },
  });

  const Replica = defineActor({
    name: "Replica",
    zone: replicas,
    initialState: () => ({ ts: 0, writer: "" }),
    display: { icon: "database", status: (s) => (s.ts ? `holds ${s.writer}'s write at time ${s.ts}` : "empty"), mood: (s) => (s.ts ? "ok" : "off") },
    transitions: {
      put: {
        on: Put,
        description: variant === "buggy" ? "Keeps the write if its time is newer." : "Keeps the write if its time is newer, or the same and from a later writer.",
        say: (s, msg) => (s.ts === msg.ts && s.writer === msg.writer ? `Keeps ${msg.writer}'s write at ${msg.ts}` : `Ignores ${msg.writer}'s write at ${msg.ts}, keeps ${s.writer}'s`),
        run(state, msg) {
          if (!newer(msg, state)) return;
          state.ts = msg.ts;
          state.writer = msg.writer;
        },
      },
      putLost: lose(Put, { spend: faults }),
      crash: crash({ keeps: ["ts", "writer"], spend: faults }),
    },
  });

  const convergesOnceQuiet = defineProperty("convergesOnceQuiet", {
    description: "Once nothing is in flight, every replica holds the same write.",
    always: (w) => !w.quiet || new Set(w.all(Replica).map((r) => `${r.state.ts}|${r.state.writer}`)).size <= 1,
  });

  const oneWriteAfterAnother = defineScenario("One write after another", {
    description:
      variant === "buggy"
        ? "A writes, then B; B's clock also says 1, so both replicas keep A's write and drop B's, later, one. They agree, on the wrong write."
        : "A writes, then B; B's clock also says 1, and the tie goes to B, on both replicas.",
    run(s) {
      const [a, b] = ["Writer A", "Writer B"].map((name) => s.spawn(Writer, name));
      for (const name of ["Replica A", "Replica B"]) s.spawn(Replica, name);
      s.act(a, "write");
      s.settle();
      s.act(b, "write");
      s.settle();
    },
  });

  const twoWritesAtTheSameTime = defineScenario("Two writes at the same time", {
    description:
      variant === "buggy"
        ? "Both write at time 1; replica A gets A's write first, replica B gets B's: each keeps its first, and they disagree for good."
        : "Both write at time 1, arriving in different orders; the tie goes to B everywhere, and the replicas agree.",
    run(s) {
      const [a, b] = ["Writer A", "Writer B"].map((name) => s.spawn(Writer, name));
      const [ra, rb] = ["Replica A", "Replica B"].map((name) => s.spawn(Replica, name));
      s.act(a, "write");
      s.act(b, "write");
      s.deliver(ra, Put, { ts: 1, writer: a.id });
      s.deliver(rb, Put, { ts: 1, writer: b.id });
      s.settle();
    },
  });

  return defineSpec({
    name: `LWW register (${variant})`,
    actors: [Writer, Replica],
    properties: [convergesOnceQuiet],
    scenarios: [oneWriteAfterAnother, twoWritesAtTheSameTime],
  });
}

/** `feynman check lww-register` checks the buggy variant, so you see the checker find the bug. */
export default lwwRegister("buggy");
export const fixed = lwwRegister("fixed");
