// A replicated set that forgets which add a remove meant.
//
// Two replicas share a set, each applying its own adds and removes at once and sending them
// to the other. A naive set applies "add x" and "remove x" as they come. If one replica adds
// x again while the other removes it, each applies its own first and the other's second, and
// they disagree for good: one has x, the other does not. The fix, an observed-remove set
// (OR-Set): every add carries a tag of its own, a remove takes away only the tags its
// replica has seen, and an element is in the set while any tag for it is. A concurrent add's
// tag was not seen, so it survives, on both replicas: add wins.
//
// The textbook OR-Set assumes causal delivery, and this network does not promise it: A's
// remove can overtake A's add, and the late add puts x back. So the fixed set also keeps the
// tags it removed (tombstones), and ignores an add whose tag is among them.
//
// This covers operation-based CRDTs: concurrent operations must commute, and what they assume
// of delivery must hold.
//
// Expected, with two replicas: buggy breaks `convergesOnceQuiet` in 4 steps without faults (A
// adds and removes, and B hears of the remove first); fixed holds without faults, and both
// break in 2 steps with one (an add, and its message lost).
import { defineSpec, message } from "@leostera/feynman";

export function orSet(variant: "buggy" | "fixed") {
  return defineSpec(
    `OR-Set (${variant})`,
    {
      messages: {
        // Buggy ignores the tags.
        Add: message<{ tag: string }>({ name: "add" }),
        Remove: message<{ tags: Set<string> }>({ name: "remove", tone: "refused" }),
      },
    },
    (spec) => {
      const { Add, Remove } = spec.messages;
      const zone = spec.defineZone({ name: "Replicas", description: "a shared shopping list holding x, or not", place: { arrange: "row" } });

      const Replica = spec.defineActor({
        name: "Replica",
        zone,
        symmetric: true,
        durable: ["has", "tags", "removed", "added"],
        // `has`: buggy's set. `tags`: fixed's, x is in while any is, and `removed`, its
        // tombstones. `added`: adds made here, to name tags.
        initialState: () => ({ has: false, tags: new Set<string>(), removed: new Set<string>(), added: 0 }),
        look: {
          icon: "database",
          status: (s) => (contains(s) ? "has x" : "no x"),
          mood: (s) => (contains(s) ? "ok" : "off"),
          rows: (s) => (variant === "fixed" ? [...s.tags].map((tag) => ({ group: "tags for x", label: tag })) : []),
        },
        actions: {
          add: {
            label: "Add x",
            description: variant === "buggy" ? "Adds x and tells the other replica." : "Adds x with a new tag and tells the other replica.",
            sends: [Add],
            run(state, _inputs, ctx) {
              state.added += 1;
              const tag = `${ctx.id}#${state.added}`;
              state.has = true;
              if (variant === "fixed") state.tags.add(tag);
              for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Add, { tag });
            },
          },
          remove: {
            label: "Remove x",
            description: variant === "buggy" ? "Removes x and tells the other replica." : "Removes the tags it has seen and tells the other replica which.",
            when: (state) => contains(state),
            sends: [Remove],
            run(state, _inputs, ctx) {
              const tags = new Set(state.tags);
              state.has = false;
              state.tags.clear();
              for (const tag of tags) state.removed.add(tag);
              for (const other of ctx.all(Replica)) if (other.id !== ctx.id) ctx.send(other, Remove, { tags });
            },
          },
        },
        transitions: {
          [Add]: {
            description: variant === "buggy" ? "Adds x." : "Adds x with the add's tag, unless that tag was removed already.",
            say: (s, msg) => (s.removed.has(msg.tag) ? "Ignores an add it already saw removed" : "Adds x"),
            run(state, msg) {
              state.has = true;
              if (variant === "fixed" && !state.removed.has(msg.tag)) state.tags.add(msg.tag);
            },
          },
          [Remove]: {
            description: variant === "buggy" ? "Removes x." : "Removes the tags the other replica had seen.",
            say: (s) => (contains(s) ? "Keeps x: an add it was not told about" : "Removes x"),
            run(state, msg) {
              state.has = false;
              if (variant === "buggy") return;
              for (const tag of msg.tags) {
                state.tags.delete(tag);
                state.removed.add(tag);
              }
            },
          },
        },
      });

      const contains = (s: { has: boolean; tags: Set<string> }) => (variant === "buggy" ? s.has : s.tags.size > 0);

      spec.defineProperties({
        convergesOnceQuiet: {
          description: "Once nothing is in flight, the replicas agree on whether x is in the set.",
          always: (w) => !w.quiet || new Set(w.all(Replica).map((r) => contains(r.state))).size <= 1,
        },
      });

      spec.defineScenario({
        name: "Add, then remove",
        description: "A adds x and B hears of it; B removes it and A hears of that. Neither has x.",
        run(s) {
          const [a, b] = ["Replica A", "Replica B"].map((name) => s.spawn(Replica, name));
          s.act(a, "add");
          s.settle();
          s.act(b, "remove");
          s.settle();
        },
      });
      spec.defineScenario({
        name: "Add and remove at the same time",
        description:
          variant === "buggy"
            ? "A adds x again while B removes it; each applies the other's last, and only B has x."
            : "A adds x again while B removes it; B's remove only takes the tag it saw, so A's new add survives on both.",
        run(s) {
          const [a, b] = ["Replica A", "Replica B"].map((name) => s.spawn(Replica, name));
          s.act(a, "add");
          s.settle();
          s.act(a, "add");
          s.act(b, "remove");
          s.settle();
        },
      });
      return { Replica };
    },
  );
}

/** `feynman check or-set` checks the buggy variant, so you see the checker find the bug. */
export default orSet("buggy");
export const fixed = orSet("fixed");
