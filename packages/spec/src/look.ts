// How a world looks: each instance's icon, status, mood and rows, and the live links between
// instances, from the actors' `look` and `links`. A presentation function that throws shows
// nothing rather than breaking the view.
import type { Icon, Link, Mood, Row, Token } from "./dsl.ts";
import type { ActionInfo, Spec, World } from "./spec.ts";
import { worldView } from "./engine.ts";

export interface Appearance {
  icon: Icon | null;
  status: string | null;
  mood: Mood | null;
  rows: Row[];
  tokens: Token[];
  /** Whose this is, if the actor says; undefined when it does not. */
  owner: string | null | undefined;
}

export interface LiveLink extends Link {
  from: string;
  /** The resolved instance id. */
  target: string;
}

function attempt<T>(f: (() => T) | undefined, fallback: T): T {
  if (!f) return fallback;
  try {
    return f() ?? fallback;
  } catch {
    return fallback;
  }
}

export function appearance(spec: Spec, world: World, id: string): Appearance {
  const instance = world.instances.find((i) => i.id === id);
  const actor = instance && spec.actors.find((a) => a.name === instance.actor);
  if (!instance || !actor) return { icon: null, status: null, mood: null, rows: [], tokens: [], owner: undefined };
  const { look } = actor;
  return {
    icon: look.icon ?? null,
    status: attempt(look.status && (() => look.status!(instance.state as never)), null),
    mood: attempt(look.mood && (() => look.mood!(instance.state as never)), null),
    rows: attempt(look.rows && (() => look.rows!(instance.state as never)), []),
    tokens: declaresTokens(spec)
      ? attempt(look.tokens && (() => look.tokens!(instance.state as never, { id: instance.id, label: instance.label })), [])
      : (inferredTokens(spec, world).get(id) ?? []),
    owner: look.owner ? attempt(() => look.owner!(instance.state as never), null) : undefined,
  };
}

/** What dropping `token` on instance `id` would do: each enabled action with an input accepting it. */
export interface Drop {
  action: ActionInfo;
  inputs: Record<string, unknown>;
  /** Whether other inputs still need a person to fill them in. */
  complete: boolean;
}

/** Whether any actor says what can be carried; if none does, it is inferred. */
export function declaresTokens(spec: Spec): boolean {
  return spec.actors.some((a) => a.look.tokens);
}

/** The token kind an input takes when tokens are inferred for it. */
function inferredKind(actor: string, action: string, input: string): string {
  return `${actor}.${action}.${input}`;
}

const inferred = new WeakMap<World, Map<string, Token[]>>();

/**
 * Without declared tokens: what a person would carry. When an action someone can take now
 * gets its input examples from other instances' state, each value can be dragged from the
 * instance it came from, like a pairing code on a phone typed into a Mac. Only instances
 * the examples actually read count, so a value that merely also appears elsewhere stays
 * put. Values that name instances are left out; those are references, not things to carry.
 */
export function inferredTokens(spec: Spec, world: World): Map<string, Token[]> {
  const cached = inferred.get(world);
  if (cached) return cached;
  const out = new Map<string, Token[]>();
  const names = new Set(world.instances.flatMap((i) => [i.id, i.label, i.actor]));
  for (const target of world.instances) {
    const actor = spec.actors.find((a) => a.name === target.actor);
    if (!actor) continue;
    for (const action of Object.values(actor.actions)) {
      if (action.when && !attempt(() => action.when!(target.state), false)) continue;
      for (const [name, input] of Object.entries(action.inputs)) {
        if (input.type !== "string" && input.type !== "number") continue;
        const read = new Set<string>();
        const view = worldView(spec, world, (id) => read.add(id));
        const values = attempt(() => input.examples?.(view as never), [] as unknown[]);
        const sources = world.instances.filter((i) => read.has(i.id) && i.id !== target.id);
        for (const value of [...new Set(values)].reverse()) {
          if ((typeof value !== "string" && typeof value !== "number") || names.has(String(value)) || value === "") continue;
          for (const holder of sources) {
            if (!holds(holder.state, value)) continue;
            const list = out.get(holder.id) ?? [];
            const kind = inferredKind(actor.name, action.key, name);
            if (!list.some((t) => t.value === value)) list.push({ kind, value });
            out.set(holder.id, list);
          }
        }
      }
    }
  }
  inferred.set(world, out);
  return out;
}

/** Whether a scalar appears anywhere in a state, as a value or a key. */
function holds(state: unknown, value: string | number, depth = 0): boolean {
  if (state === value) return true;
  if (depth > 6 || state === null || typeof state !== "object") return false;
  if (Array.isArray(state)) return state.some((v) => holds(v, value, depth + 1));
  return Object.entries(state).some(([k, v]) => k === String(value) || holds(v, value, depth + 1));
}

export function dropsFor(spec: Spec, world: World, id: string, token: Token): Drop[] {
  const instance = world.instances.find((i) => i.id === id);
  const actor = instance && spec.actors.find((a) => a.name === instance.actor);
  if (!instance || !actor) return [];
  const view = worldView(spec, world);
  const out: Drop[] = [];
  for (const action of Object.values(actor.actions)) {
    const slot = Object.entries(action.inputs).find(([name, input]) => input.accepts === token.kind || token.kind === inferredKind(actor.name, action.key, name));
    if (!slot) continue;
    if (action.when && !attempt(() => action.when!(instance.state), false)) continue;
    const inputs: Record<string, unknown> = {};
    let complete = true;
    for (const [name, input] of Object.entries(action.inputs)) {
      if (name === slot[0]) inputs[name] = token.value;
      else {
        const first = attempt(() => input.examples?.(view as never)[0], undefined);
        if (first === undefined) complete = false;
        else inputs[name] = first;
      }
    }
    out.push({ action, inputs, complete });
  }
  return out;
}

/** Whether any actor declares links; views fall back to the static topology when none does. */
export function declaresLinks(spec: Spec): boolean {
  return spec.actors.some((a) => a.links);
}

export function liveLinks(spec: Spec, world: World): LiveLink[] {
  const out: LiveLink[] = [];
  for (const instance of world.instances) {
    const actor = spec.actors.find((a) => a.name === instance.actor);
    if (!actor?.links) continue;
    for (const link of attempt(() => actor.links!(instance.state, { id: instance.id, label: instance.label }), [] as Link[])) {
      const target = resolve(spec, world, link.to);
      if (target && target !== instance.id) out.push({ ...link, from: instance.id, target });
    }
  }
  return out;
}

function resolve(spec: Spec, world: World, to: string): string | null {
  const byId = world.instances.find((i) => i.id === to);
  if (byId) return byId.id;
  const byLabel = world.instances.find((i) => i.label === to);
  if (byLabel) return byLabel.id;
  const actor = spec.actors.find((a) => a.name === to);
  const ofActor = actor ? world.instances.filter((i) => i.actor === actor.name) : [];
  return ofActor.length === 1 ? ofActor[0].id : null;
}
