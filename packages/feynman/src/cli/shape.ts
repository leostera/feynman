// Mechanical hints that a spec is hiding the system it models. They catch the most
// common way a spec goes vague, one step standing for many stages of the code, and a step on a
// message nothing sends, which never runs.
import { parseSource } from "../code/index.ts";
import { FAULT, type Spec, type StepInfo } from "../spec/index.ts";

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
  return step.key;
}

export function shapeWarnings(spec: Spec): ShapeWarning[] {
  const warnings: ShapeWarning[] = [];
  const sent = new Set(spec.actors.flatMap((a) => [...Object.values(a.actions), ...Object.values(a.transitions)].flatMap((step) => step.sends)));
  for (const actor of spec.actors) {
    for (const step of Object.values(actor.transitions)) {
      // A call's failure is sent by the call failing; only messages are sent by steps.
      if (!step.message?.startsWith("message:") || sent.has(step.message)) continue;
      warnings.push({ actor: actor.name, step: step.key, message: `is on ${spec.messages[step.message]?.id ?? step.message}, which no step sends: it never runs` });
    }
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
/** Steps with no code yet. Faults are left out: a lost message or a crash is the world's doing, not code's. */
export function unbuilt(spec: Spec): { actor: string; step: string }[] {
  return spec.actors.flatMap((actor) =>
    [...Object.values(actor.actions), ...Object.values(actor.transitions)].filter((step) => step.sources.length === 0 && !isFault(step)).map((step) => ({ actor: actor.name, step: stepName(step) })),
  );
}

/** The steps that could point at code: every one but the faults. */
export function totalSteps(spec: Spec): number {
  return spec.actors.reduce((n, a) => n + [...Object.values(a.actions), ...Object.values(a.transitions)].filter((step) => !isFault(step)).length, 0);
}

function isFault(step: { tags?: readonly string[] }): boolean {
  return step.tags?.includes(FAULT) ?? false;
}

