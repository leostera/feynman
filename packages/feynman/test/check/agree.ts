// The checker against the reference explorer (reference.ts): the same reachable worlds, the
// same `always` properties broken in as few steps, the same errors, the same steps run, the
// same stuck world and the same liveness verdicts.
import { expect } from "bun:test";
import { check, initialWorld, type Report, type Seed } from "../../src/check/explore.ts";
import { faultsIn } from "../../src/check/faults.ts";
import type { Spec } from "../../src/spec/index.ts";
import { explore, worldKey } from "./reference.ts";

export interface AgreeBounds {
  depth: number;
  instances: Record<string, number>;
}

/** Check `spec` exhaustively without symmetry, and expect what the reference explorer finds from the same roots. */
export async function agreesWithReference(spec: Spec, bounds: AgreeBounds, seeds: Seed[] = []): Promise<Report> {
  const theirs = explore(spec, { ...bounds, from: seeds.map((s) => s.world) });
  const worlds = new Set([worldKey(initialWorld(spec, bounds)), ...seeds.map((s) => worldKey(s.world))]);
  const ours = await check(spec, { ...bounds, walks: 0, symmetry: false, maxStates: 2_000_000, timeLimit: 120_000 }, seeds, {
    watch: { state: (world) => worlds.add(worldKey(world)) },
  });
  expect(ours.exhaustive).toBe(true);
  expect(worlds.size).toBe(theirs.worlds.size);
  expect([...worlds].filter((w) => !theirs.worlds.has(w))).toEqual([]);
  const broken = Object.fromEntries(ours.properties.filter((p) => !p.holds && p.kind === "always").map((p) => [p.id, p.holds ? 0 : p.counterexample.events.length]));
  expect(broken).toEqual(Object.fromEntries(theirs.broken));
  expect(ours.errors.map((e) => e.message).sort()).toEqual([...theirs.errors].sort());
  expect([...ours.coverage.reached].sort()).toEqual([...theirs.reached].sort());
  const stuck = ours.stuck && { events: ours.stuck.counterexample.events.length, faults: faultsIn(ours.stuck.counterexample.events) };
  expect(stuck).toEqual(theirs.stuck);
  const live = Object.fromEntries(ours.properties.filter((p) => theirs.liveness.has(p.id)).map((p) => [p.id, p.holds ? (p.unfinished ? "unfinished" : "holds") : "broken"]));
  expect(live).toEqual(Object.fromEntries(theirs.liveness));
  return ours;
}
