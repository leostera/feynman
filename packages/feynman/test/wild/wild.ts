// Specs translated from TLA+ found in the wild (tlaplus/Examples), with the verdicts TLC
// gives on the original model. They check the checker's liveness against TLC's on models
// written by others, for TLC.
import type { Spec } from "../../src/spec/index.ts";
import { diningPhilosophers } from "./dining-philosophers.ts";

export interface Wild {
  name: string;
  spec: () => Spec;
  /** Distinct states, as TLC counts them. */
  states: number;
  /** Each temporal property's verdict, by the spec's name for it. */
  expect: Record<string, "holds" | "broken">;
  /** Each reachable property: the events on a shortest way there, or never. */
  reachable: Record<string, number | "never">;
  tla: {
    module: string;
    dir: string;
    constants: Record<string, string | number | boolean>;
    specification: string;
    /** The TLA+ name of each temporal property, by the spec's name for it. */
    properties: Record<string, string>;
    /** The TLA+ invariant that each reachable property is never reached, by the spec's name for it. */
    never: Record<string, string>;
  };
}

const STARVATION = Object.fromEntries([1, 2, 3, 4, 5].map((p) => [`noStarvation${p}`, `Starve${p}`]));

/** Philosopher 1 takes the left fork, then the right; 3 likewise: 4 events. Neighbours share a fork. */
const REACHABLE = { apartEat: 4, neighboursEat: "never" } as const;
const NEVER = { apartEat: "ApartEatNever", neighboursEat: "NeighboursEatNever" };

export const wild: Wild[] = [
  {
    name: "dining philosophers, strong fairness",
    spec: () => diningPhilosophers("strong"),
    states: 58,
    expect: { noLivelock: "holds", noStarvation1: "holds", noStarvation2: "holds", noStarvation3: "holds", noStarvation4: "holds", noStarvation5: "holds" },
    reachable: REACHABLE,
    tla: { module: "DiningPhilosophers", dir: import.meta.dir, constants: { N: 5 }, specification: "StrongSpec", properties: { noLivelock: "NoLivelock", ...STARVATION }, never: NEVER },
  },
  {
    name: "dining philosophers, weak fairness",
    spec: () => diningPhilosophers("weak"),
    states: 58,
    expect: { noLivelock: "holds", noStarvation1: "broken", noStarvation2: "broken", noStarvation3: "broken", noStarvation4: "broken", noStarvation5: "broken" },
    reachable: REACHABLE,
    tla: { module: "DiningPhilosophers", dir: import.meta.dir, constants: { N: 5 }, specification: "WeakSpec", properties: { noLivelock: "NoLivelock", ...STARVATION }, never: NEVER },
  },
];

