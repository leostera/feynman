// The checker against the reference explorer (reference.ts) on every case in the corpus: the
// same reachable worlds, the same `always` properties broken in as few steps, the same errors,
// the same steps run, the same stuck world and the same liveness verdicts. The reference is slow and plain on purpose; agreeing with it says
// the checker's search, its state identity and its judging lose nothing.
import { describe, expect, test } from "bun:test";
import { check, initialWorld } from "../../src/check/explore.ts";
import { faultsIn } from "../../src/check/faults.ts";
import { caseName, configured, corpus } from "../examples/corpus.ts";
import { explore, worldKey } from "./reference.ts";

describe("the checker against a reference explorer", () => {
  for (const example of corpus) for (const c of example.cases) {
    test(caseName(example, c), async () => {
      const { spec } = configured(example.spec(c.variant), { faults: c.bounds.faults ?? 0, repeats: 2 });
      const bounds = { depth: c.bounds.depth ?? 60, instances: example.instances ?? {} };
      const theirs = explore(spec, bounds);

      const worlds = new Set([worldKey(initialWorld(spec, bounds))]);
      const ours = await check(spec, { ...bounds, walks: 0, reduce: false, symmetry: false, maxStates: 2_000_000, timeLimit: 120_000 }, [], {
        watch: { state: (world) => worlds.add(worldKey(world)) },
      });

      expect(ours.exhaustive).toBe(true);
      expect(worlds.size).toBe(theirs.worlds.size);
      expect([...worlds].filter((w) => !theirs.worlds.has(w))).toEqual([]);
      const broken = Object.fromEntries(ours.properties.filter((p) => !p.holds).filter((p) => p.kind === "always").map((p) => [p.id, p.counterexample.events.length]));
      expect(broken).toEqual(Object.fromEntries(theirs.broken));
      expect(ours.errors.map((e) => e.message).sort()).toEqual([...theirs.errors].sort());
      expect([...ours.coverage.reached].sort()).toEqual([...theirs.reached].sort());
      const stuck = ours.stuck && { events: ours.stuck.counterexample.events.length, faults: faultsIn(ours.stuck.counterexample.events) };
      expect(stuck).toEqual(theirs.stuck);
      const live = Object.fromEntries(ours.properties.filter((p) => theirs.liveness.has(p.id)).map((p) => [p.id, p.holds ? (p.unfinished ? "unfinished" : "holds") : "broken"]));
      expect(live).toEqual(Object.fromEntries(theirs.liveness));
    }, 300_000);
  }
});
