// The checker against the reference explorer (reference.ts) on every case in the corpus: the
// same reachable worlds, the same `always` properties broken in as few steps, the same errors,
// and the same steps run. The reference is slow and plain on purpose; agreeing with it says
// the checker's search, its state identity and its judging lose nothing.
import { describe, expect, test } from "bun:test";
import { check, initialWorld } from "../../src/check/explore.ts";
import { caseName, corpus } from "../examples/corpus.ts";
import { explore, worldKey } from "./reference.ts";

describe("the checker against a reference explorer", () => {
  for (const example of corpus) for (const c of example.cases) {
    test(caseName(example, c), () => {
      const spec = example.spec(c.variant);
      const bounds = { depth: c.bounds.depth ?? 60, faults: c.bounds.faults ?? 0, repeats: 2, instances: example.instances ?? {} };
      const theirs = explore(spec, bounds);

      const worlds = new Set([worldKey(initialWorld(spec, bounds), {}, 0)]);
      const ours = check(spec, { ...bounds, walks: 0, reduce: false, symmetry: false, maxStates: 2_000_000, timeLimit: 120_000 }, [], {
        state: (world, b) => worlds.add(worldKey(world, b.acts, b.faults)),
      });

      expect(ours.exhaustive).toBe(true);
      expect(worlds.size).toBe(theirs.worlds.size);
      expect([...worlds].filter((w) => !theirs.worlds.has(w))).toEqual([]);
      const broken = Object.fromEntries(ours.properties.filter((p) => p.kind === "always" && !p.holds).map((p) => [p.id, p.counterexample!.events.length]));
      expect(broken).toEqual(Object.fromEntries(theirs.broken));
      expect(ours.errors.map((e) => e.message).sort()).toEqual([...theirs.errors].sort());
      expect([...ours.coverage.reached].sort()).toEqual([...theirs.reached].sort());
    }, 300_000);
  }
});
