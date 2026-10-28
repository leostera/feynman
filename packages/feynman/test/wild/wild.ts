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
  /** Each property's verdict, by the spec's name for it. */
  expect: Record<string, "holds" | "broken">;
  tla: {
    module: string;
    dir: string;
    constants: Record<string, string | number | boolean>;
    specification: string;
    /** The TLA+ name of each property, by the spec's name for it. */
    properties: Record<string, string>;
  };
}

const STARVATION = Object.fromEntries([1, 2, 3, 4, 5].map((p) => [`noStarvation${p}`, `Starve${p}`]));

export const wild: Wild[] = [
  {
    name: "dining philosophers, strong fairness",
    spec: () => diningPhilosophers("strong"),
    states: 58,
    expect: { noLivelock: "holds", noStarvation1: "holds", noStarvation2: "holds", noStarvation3: "holds", noStarvation4: "holds", noStarvation5: "holds" },
    tla: { module: "DiningPhilosophers", dir: import.meta.dir, constants: { N: 5 }, specification: "StrongSpec", properties: { noLivelock: "NoLivelock", ...STARVATION } },
  },
  {
    name: "dining philosophers, weak fairness",
    spec: () => diningPhilosophers("weak"),
    states: 58,
    expect: { noLivelock: "holds", noStarvation1: "broken", noStarvation2: "broken", noStarvation3: "broken", noStarvation4: "broken", noStarvation5: "broken" },
    tla: { module: "DiningPhilosophers", dir: import.meta.dir, constants: { N: 5 }, specification: "WeakSpec", properties: { noLivelock: "NoLivelock", ...STARVATION } },
  },
];

