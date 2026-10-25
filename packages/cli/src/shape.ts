// Mechanical hints that a spec is hiding the system it models. They catch the most
// common way a spec goes vague: one step standing for many stages of the code.
import { parseSource } from "@feynman/code";
import type { Spec, StepInfo } from "@feynman/spec";

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
