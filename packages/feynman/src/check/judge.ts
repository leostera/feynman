// Judging what the search or a random run meets: which properties a world, a step, or a path
// breaks, and whether the system is stuck. Shared, so both ways of exploring judge alike.
// Liveness is judged after exploring, on the whole graph (liveness.ts).
import { actorNamed, holdsIn, whenHolds, traceView, violatedAlways, worldView, type Event, type Spec, type TraceEvent, type World, type WorldView } from "../spec/index.ts";

/** What the exploring so far knows: which properties broke, which errors were met, which steps ran. */
export interface Verdicts {
  broken: Set<string>;
  errors: Set<string>;
  /** Steps (`Actor.key`) that ran somewhere. */
  reached: Set<string>;
}

export function verdicts(): Verdicts {
  return { broken: new Set(), errors: new Set(), reached: new Set() };
}

/**
 * Judge a world and the event that led to it: the event's error and `always` violations, and
 * `never` over the path. Only properties not yet broken are judged. A step that fails is a
 * spec error and breaks no property: what is left after it is not a state the system gets to.
 */
export function judge(spec: Spec, event: Event | null, path: () => Event[], v: Verdicts): { findings: string[]; error?: string } {
  const findings: string[] = [];
  if (!event) return { findings };
  v.reached.add(`${event.actor}.${event.key}`);
  if (event.error) return { findings, ...(v.errors.has(event.error) ? {} : { error: event.error }) };
  for (const id of event.violations) if (!v.broken.has(id)) findings.push(id);
  for (const p of spec.properties) {
    if (p.kind !== "never" || v.broken.has(p.id) || findings.includes(p.id)) continue;
    if (safely(() => p.never(traceView(path())))) findings.push(p.id);
  }
  return { findings };
}

/**
 * The properties a world breaks before anything happens: where a path starts (the initial
 * world, or where a scenario ends). Its `always` properties, and `never` ones over no events.
 */
export function startBreaks(spec: Spec, world: World): string[] {
  const nevers = spec.properties.filter((p) => p.kind === "never" && safely(() => p.never(traceView([])))).map((p) => p.id);
  return [...violatedAlways(spec, world), ...nevers];
}

/** The `everyStep` properties a step breaks, of those not yet broken. A predicate that cannot be evaluated holds, as an `always` one does. */
export function stepBreaks(spec: Spec, before: World, after: World, event: Event, broken: Set<string>): string[] {
  const out: string[] = [];
  // Built once, and only if some step property is still to judge.
  let views: { before: WorldView; after: WorldView; event: TraceEvent } | undefined;
  for (const p of spec.properties) {
    if (p.kind !== "everyStep" || broken.has(p.id)) continue;
    views ??= { before: worldView(spec, before), after: worldView(spec, after), event: traceView([event]).events[0] };
    try {
      if (!p.everyStep(views.before, views.after, views.event)) out.push(p.id);
    } catch {
      // Holds vacuously, like an `always` that looks at an instance not there yet.
    }
  }
  return out;
}

/**
 * Whether nothing can happen in a world, and the spec does not call it final: nothing pending,
 * no action whose `when` holds, and no fair guard whose `when` holds. A bound of the model (a
 * step's parts, such as atMost or a budget) does not count: running out of repeats is not the
 * system getting stuck, and neither is a fault left to happen (RFD0012).
 */
export function stuck(spec: Spec, world: World): boolean {
  if (world.pending.length) return false;
  for (const instance of world.instances) {
    const actor = actorNamed(spec, instance.actor);
    if (Object.values(actor.actions).some((a) => whenHolds(spec, world, instance, a, true))) return false;
    if (Object.values(actor.transitions).some((t) => !t.message && t.when && t.fair !== false && whenHolds(spec, world, instance, t, true))) return false;
  }
  return !(spec.finalState && holdsIn(spec, world, spec.finalState.when));
}

export function safely<T>(f: () => T): T | false {
  try {
    return f();
  } catch {
    return false;
  }
}
