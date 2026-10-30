// Where a search also starts: the worlds a spec's scenarios set up and end in.
import { runScenario, scenarioStart, type ScenarioInfo, type Spec, type World } from "../spec/index.ts";
import type { Seed } from "./explore.ts";

/**
 * Where exploration should also start: the world each scenario's setup sets, and where each
 * scenario that runs cleanly (no spec error, no broken property) ends.
 */
export function scenarioSeeds(spec: Spec, runs = spec.scenarios.map((scenario) => ({ scenario, run: runScenario(spec, scenario) }))): Seed[] {
  return runs.flatMap(({ scenario, run }): Seed[] => {
    const start = scenario.setup ? setUp(spec, scenario) : undefined;
    const clean = !run.error && run.worlds.length > 0 && !run.events.some((e) => e.error || e.violations.length);
    return [...(start ? [{ scenario: scenario.name, at: "start" as const, world: start }] : []), ...(clean ? [{ scenario: scenario.name, at: "end" as const, world: run.worlds.at(-1)! }] : [])];
  });
}

/** The world a scenario's setup sets, unless the setup fails (the scenario reports that). */
function setUp(spec: Spec, scenario: ScenarioInfo): World | undefined {
  try {
    return scenarioStart(spec, scenario);
  } catch {
    return undefined;
  }
}
