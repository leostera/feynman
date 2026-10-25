// How a world looks: each instance's icon, status, mood and rows, and the live links between
// instances, from the actors' `look` and `links`. A presentation function that throws shows
// nothing rather than breaking the view.
import type { Icon, Link, Mood, Row } from "./dsl.ts";
import type { Spec, World } from "./spec.ts";

export interface Appearance {
  icon: Icon | null;
  status: string | null;
  mood: Mood | null;
  rows: Row[];
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
  if (!instance || !actor) return { icon: null, status: null, mood: null, rows: [] };
  const { look } = actor;
  return {
    icon: look.icon ?? null,
    status: attempt(look.status && (() => look.status!(instance.state as never)), null),
    mood: attempt(look.mood && (() => look.mood!(instance.state as never)), null),
    rows: attempt(look.rows && (() => look.rows!(instance.state as never)), []),
  };
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
