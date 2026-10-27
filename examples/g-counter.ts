// A grow-only counter, merged by its total.
//
// Two replicas count increments, each taking its own, and send their state to the other
// after every one. Merging by taking the larger of the two totals looks right, since a
// counter only grows, but it loses increments made at the same time: each replica counts
// one, each hears the other's total of one, and both settle on one when there were two.
// The fix, a G-Counter: each replica keeps a count per replica, merges by taking the larger
// of each, and its value is the sum. A lost state is another matter: without anti-entropy,
// a replica that never hears of an increment never counts it.
//
// This covers state-based CRDTs: a merge must be commutative, associative and idempotent,
// and must not lose what either side knows.
//
// Expected, with two replicas: buggy breaks `countsEveryIncrementOnceQuiet` in 4 steps
// without faults (both increment, each hears the other); fixed holds without faults, and
// both break in 2 steps with one (an increment, and its state lost).
import { defineSpec, message } from "@leostera/feynman";

export function gCounter(variant: "buggy" | "fixed") {
  return defineSpec(
    `G-Counter (${variant})`,
    {
      messages: {
        // Buggy, the total; fixed, the count per replica.
        Gossip: message<{ total: number; counts: Record<string, number> }>({ name: "state" }),
      },
    },
    (spec) => {
      const { Gossip } = spec.messages;
      const zone = spec.defineZone({ name: "Replicas", description: "counting page views, each on its own", place: { arrange: "row" } });

      const valueOf = (state: { total: number; counts: Record<string, number> }) => (variant === "buggy" ? state.total : Object.values(state.counts).reduce((a, b) => a + b, 0));

      const Replica = spec.defineActor({
        name: "Replica",
        zone,
        symmetric: true,
        durable: ["total", "counts", "increments"],
        // `increments`: how many this replica took itself, to judge the count by.
        initialState: () => ({ total: 0, counts: {} as Record<string, number>, increments: 0 }),
        look: {
          icon: "database",
          status: (s) => `counts ${valueOf(s)}`,
          mood: () => "info",
          rows: (s) => (variant === "fixed" ? Object.entries(s.counts).map(([id, n]) => ({ group: "per replica", label: id, detail: String(n) })) : []),
        },
        actions: {
          increment: {
            label: "Increment",
            description: "Counts one more, and sends its state to the other replica.",
            sends: [Gossip],
            run(state, _inputs, ctx) {
              state.increments += 1;
              if (variant === "buggy") state.total += 1;
              else state.counts = { ...state.counts, [ctx.id]: (state.counts[ctx.id] ?? 0) + 1 };
              for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Gossip, { total: state.total, counts: state.counts });
            },
          },
        },
        transitions: {
          [Gossip]: {
            description: variant === "buggy" ? "Merges by keeping the larger total." : "Merges by keeping the larger count for each replica.",
            say: (s) => `Merges: counts ${valueOf(s)}`,
            run(state, msg) {
              if (variant === "buggy") return void (state.total = Math.max(state.total, msg.total));
              const merged = { ...state.counts };
              for (const [id, n] of Object.entries(msg.counts)) merged[id] = Math.max(merged[id] ?? 0, n);
              state.counts = merged;
            },
          },
        },
      });

      spec.defineProperties({
        countsEveryIncrementOnceQuiet: {
          description: "Once nothing is in flight, every replica counts every increment.",
          always: (w) => {
            const increments = w.all(Replica).reduce((n, r) => n + r.state.increments, 0);
            return !w.quiet || w.all(Replica).every((r) => valueOf(r.state) === increments);
          },
        },
      });

      spec.defineScenario({
        name: "One after the other",
        description: "A counts one and tells B; then B counts one and tells A: both count two.",
        run(s) {
          const [a, b] = ["Replica A", "Replica B"].map((name) => s.spawn(Replica, name));
          s.act(a, "increment");
          s.settle();
          s.act(b, "increment");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "At the same time",
        description:
          variant === "buggy"
            ? "Both count one before hearing from the other; each keeps the larger total, one, and an increment is lost."
            : "Both count one before hearing from the other; each keeps both counts, and both count two.",
        run(s) {
          const [a, b] = ["Replica A", "Replica B"].map((name) => s.spawn(Replica, name));
          s.act(a, "increment");
          s.act(b, "increment");
          s.settle();
        },
      });
      return { Replica };
    },
  );
}

/** `feynman check g-counter` checks the buggy variant, so you see the checker find the bug. */
export default gCounter("buggy");
export const fixed = gCounter("fixed");
