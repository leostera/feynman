// Steps the checker can take from a world, and replaying them.
import { act, actorNamed, choices, fire, guard, lose, restart, worldView, type Event, type Spec, type Step, type StepOptions, type World } from "../spec/index.ts";

export type Choice =
  | { kind: "act"; instance: string; key: string; inputs: Record<string, unknown> }
  | { kind: "fire"; pending: number }
  | { kind: "guard"; instance: string; key: string }
  | { kind: "lose"; pending: number }
  | { kind: "restart"; instance: string };

/** A path from the initial world, replayed with every world along it. */
export interface Counterexample {
  /** The scenario whose end the path starts from; none for the empty world. */
  from?: string;
  initial: World;
  choices: Choice[];
  events: Event[];
  worlds: World[];
}

export function branches(spec: Spec, world: World, faultsLeft: boolean): Choice[] {
  const { actions, guards, pending } = choices(spec, world);
  const out: Choice[] = [];
  for (const action of actions) {
    const instance = world.instances.find((i) => i.id === action.instance)!;
    const info = actorNamed(spec, instance.actor).actions[action.key];
    for (const inputs of inputCombinations(spec, world, info.inputs)) out.push({ kind: "act", instance: action.instance, key: action.key, inputs });
  }
  for (const g of guards) out.push({ kind: "guard", instance: g.instance, key: g.key });
  // Anything pending may happen next: any message may overtake any other, and a timer may fire at any moment (RFD0004).
  for (const p of pending) out.push({ kind: "fire", pending: p.id });
  if (faultsLeft) {
    for (const p of pending) if (p.kind === "deliver") out.push({ kind: "lose", pending: p.id });
    for (const instance of world.instances) if (!actorNamed(spec, instance.actor).singleton) out.push({ kind: "restart", instance: instance.id });
  }
  return out;
}

/** Exploring reads only the next world, errors, violations and what was sent; counterexamples are replayed in full. */
export const QUIET: StepOptions = { explain: false };

export function apply(spec: Spec, world: World, choice: Choice, how?: StepOptions): Step {
  switch (choice.kind) {
    case "act":
      return act(spec, world, choice.instance, choice.key, choice.inputs, how);
    case "fire":
      return fire(spec, world, choice.pending, how);
    case "guard":
      return guard(spec, world, choice.instance, choice.key, how);
    case "lose":
      return lose(spec, world, choice.pending, how);
    case "restart":
      return restart(spec, world, choice.instance, how);
  }
}

export function replay(spec: Spec, initial: World, choices: Choice[]): Counterexample {
  const events: Event[] = [];
  const worlds: World[] = [];
  let world = initial;
  for (const choice of choices) {
    const step = apply(spec, world, choice);
    events.push(step.event);
    worlds.push(step.world);
    world = step.world;
  }
  return { initial, choices, events, worlds };
}

/** Values to try for each input: its examples, or a small set per type. At most 12 combinations. */
export function inputCombinations(spec: Spec, world: World, inputs: Record<string, { type: string; values?: string[]; examples?: (w: never) => unknown[] }>): Record<string, unknown>[] {
  let combos: Record<string, unknown>[] = [{}];
  for (const [name, input] of Object.entries(inputs)) {
    const values = input.examples
      ? dedupe(safely(() => input.examples!(worldView(spec, world) as never)) || [])
      : input.type === "choice"
        ? (input.values ?? [])
        : input.type === "number"
          ? [0, 1]
          : input.type === "boolean"
            ? [true, false]
            : ["", "x"];
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [name]: value }))).slice(0, 12);
  }
  return combos;
}

function safely<T>(f: () => T): T | false {
  try {
    return f();
  } catch {
    return false;
  }
}

function dedupe(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const key = JSON.stringify(v);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
