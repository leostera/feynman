// The models the benchmarks run: big enough to share among threads, and between them every
// part of the search: faults, sleep sets, symmetry, `never`, step properties and liveness.
import type { Bounds } from "../src/check/index.ts";

export interface Model {
  name: string;
  /** The example file, and the export that is the spec (`default` unless named). */
  file: string;
  export?: string;
  bounds: Partial<Bounds>;
  /** What the model exercises. */
  why: string;
}

const PLAIN = { reduce: false, symmetry: false } as const;

export const MODELS: Model[] = [
  { name: "lost-update", file: "lost-update", bounds: { faults: 1, depth: 60, repeats: 2, instances: { Teller: 2 }, ...PLAIN }, why: "safety, a fault, a broken property" },
  { name: "read-repair", file: "read-repair", export: "fixed", bounds: { faults: 1, depth: 60, instances: { Replica: 3 }, ...PLAIN }, why: "safety, a fault, holds" },
  { name: "or-set", file: "or-set", export: "fixed", bounds: { faults: 0, depth: 60, instances: { Replica: 2 } }, why: "sleep sets and symmetry" },
  { name: "or-set-fault", file: "or-set", export: "fixed", bounds: { faults: 1, depth: 60, instances: { Replica: 2 }, ...PLAIN }, why: "the biggest: 129k states" },
  { name: "leader-election", file: "leader-election", bounds: { faults: 0, depth: 16, instances: { Node: 4 } }, why: "liveness, broken, 4 nodes" },
  { name: "two-phase-commit", file: "two-phase-commit", bounds: { faults: 1, depth: 16, instances: { Participant: 3 } }, why: "liveness and stuck worlds, a fault" },
  { name: "job-queue", file: "job-queue", bounds: { faults: 1, depth: 16 }, why: "liveness unfinished at the bound, a fault" },
];

export function modelNamed(name: string): Model {
  const model = MODELS.find((m) => m.name === name);
  if (!model) throw new Error(`no model ${name}; models: ${MODELS.map((m) => m.name).join(", ")}`);
  return model;
}
