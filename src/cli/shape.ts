// Mechanical hints that a spec is hiding the system it models. They catch the most
// common way a spec goes vague: one step standing for many stages of the code.
import { parseSource } from "../code/index.ts";
import { runScenario, scenarioStart, type ScenarioInfo, type Spec, type StepInfo, type World } from "../spec/index.ts";
import type { Seed } from "../check/index.ts";

/** A step citing this many files is most likely several stages of the code. */
export const MAX_FILES_PER_STEP = 4;

export interface ShapeWarning {
  actor: string;
  step: string;
  message: string;
}

function filesOf(step: StepInfo): string[] {
  return [...new Set(step.sources.map((s) => parseSource(s)?.path ?? s))];
}

function stepName(step: StepInfo): string {
  return step.key.startsWith("message:") ? `on ${step.key.slice("message:".length)}` : step.key;
}

export function shapeWarnings(spec: Spec): ShapeWarning[] {
  const warnings: ShapeWarning[] = [];
  for (const actor of spec.actors) {
    for (const step of [...Object.values(actor.actions), ...Object.values(actor.transitions)]) {
      const files = filesOf(step);
      if (files.length < MAX_FILES_PER_STEP) continue;
      warnings.push({
        actor: actor.name,
        step: stepName(step),
        message: `stands for ${step.sources.length} pieces of code in ${files.length} files; if these are stages the code runs one after another, make each its own step`,
      });
    }
  }
  return warnings;
}

/** Steps with no sources: designed but not built yet, or not anchored to their code. */
export function unbuilt(spec: Spec): { actor: string; step: string }[] {
  return spec.actors.flatMap((actor) =>
    [...Object.values(actor.actions), ...Object.values(actor.transitions)].filter((step) => step.sources.length === 0).map((step) => ({ actor: actor.name, step: stepName(step) })),
  );
}

export function totalSteps(spec: Spec): number {
  return spec.actors.reduce((n, a) => n + Object.keys(a.actions).length + Object.keys(a.transitions).length, 0);
}

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
