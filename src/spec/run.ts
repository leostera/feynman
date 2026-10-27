// Running a spec: a Runner applies steps and keeps the trace; scenarios script one.
import { act, choices, emptyWorld, fire, guard, lose, nextLeftAlone, restart, spawn, SpecError, startWorld, worldView, type Step } from "./engine.ts";
import type { Script } from "./dsl.ts";
import type { Event, Run, ScenarioInfo, Spec, World } from "./spec.ts";
import { sortedJson } from "./json.ts";

/** Most events one settle runs: left alone, a retry loop never ends by itself. */
export const SETTLE_LIMIT = 200;

export class Runner {
  readonly events: Event[] = [];
  readonly worlds: World[] = [];
  readonly initial: World;
  private current: World;
  private toLose: string[] = [];

  constructor(
    readonly spec: Spec,
    readonly seed = 1,
  ) {
    // Singletons exist from the start: their spawns are part of the initial world, not the trace.
    const steps = startWorld(spec, seed);
    this.initial = steps.at(-1)?.world ?? emptyWorld(seed);
    this.current = this.initial;
  }

  get world(): World {
    return this.current;
  }

  apply(step: Step): Event {
    this.current = step.world;
    this.events.push(step.event);
    this.worlds.push(step.world);
    return step.event;
  }

  spawn(actor: string, label: string): Event {
    return this.apply(spawn(this.spec, this.current, actor, label));
  }

  act(instance: string, key: string, inputs?: Record<string, unknown>): Event {
    return this.apply(act(this.spec, this.current, instance, key, inputs));
  }

  /** What the system does next left alone: a guarded transition that holds, else the next message, else the next timer. */
  next(): Event | null {
    const { guards } = choices(this.spec, this.current);
    if (guards.length) return this.apply(guard(this.spec, this.current, guards[0].instance, guards[0].key));
    const first = nextLeftAlone(this.current);
    if (!first) return null;
    const lost = first.kind === "deliver" ? this.toLose.indexOf(first.message) : -1;
    if (lost >= 0) {
      this.toLose.splice(lost, 1);
      return this.apply(lose(this.spec, this.current, first.id));
    }
    return this.apply(fire(this.spec, this.current, first.id));
  }

  /** Leave the system alone until nothing is pending, or for SETTLE_LIMIT events. */
  settle() {
    for (let n = 0; n < SETTLE_LIMIT && this.next(); n++);
  }

  /** Fire an instance's timer now, ahead of anything in flight. */
  fireTimer(instance: string, timer: string): Event {
    const pending = this.current.pending.find((p) => p.kind === "timer" && p.to === instance && p.timer === timer);
    if (!pending) throw new SpecError(`${instance} has no ${timer} timer set`);
    return this.apply(fire(this.spec, this.current, pending.id));
  }

  loseNext(message: string) {
    this.toLose.push(message);
  }

  restart(instance: string): Event {
    return this.apply(restart(this.spec, this.current, instance));
  }

  /** A message in flight to `instance`: the oldest named `message`, or the oldest carrying `payload`. */
  inFlight(instance: string, message: string, payload?: unknown): number {
    const key = message.startsWith("message:") ? message : `message:${message}`;
    const wanted = payload === undefined ? undefined : sortedJson(payload);
    const match = this.current.pending
      .filter((p) => p.kind === "deliver" && p.to === instance && p.message === key)
      .sort((a, b) => a.id - b.id)
      .find((p) => wanted === undefined || (p.kind === "deliver" && sortedJson(p.payload) === wanted));
    if (!match) throw new SpecError(`No ${key.slice("message:".length)}${wanted ? ` carrying ${wanted}` : ""} is in flight to ${instance}`);
    return match.id;
  }

  deliver(instance: string, message: string, payload?: unknown): Event {
    return this.apply(fire(this.spec, this.current, this.inFlight(instance, message, payload)));
  }

  drop(instance: string, message: string, payload?: unknown): Event {
    return this.apply(lose(this.spec, this.current, this.inFlight(instance, message, payload)));
  }

  guard(instance: string, transition: string): Event {
    if (!choices(this.spec, this.current).guards.some((g) => g.instance === instance && g.key === transition))
      throw new SpecError(`${instance}'s ${transition} guard does not hold now`);
    return this.apply(guard(this.spec, this.current, instance, transition));
  }

  run(): Run {
    return { spec: this.spec.name, seed: this.seed, initial: this.initial, events: [...this.events], worlds: [...this.worlds] };
  }
}

/** Run a scenario from the start. */
export function runScenario(spec: Spec, scenario: ScenarioInfo, seed = 1): Run & { error?: string } {
  const runner = new Runner(spec, seed);
  const script = scriptFor(runner);
  try {
    scenario.run(script);
  } catch (error) {
    return { ...runner.run(), error: error instanceof Error ? error.message : String(error) };
  }
  return runner.run();
}

function scriptFor(runner: Runner): Script {
  const live = (id: string) => ({
    id,
    get label() {
      return runner.world.instances.find((i) => i.id === id)?.label ?? id;
    },
    get state() {
      return runner.world.instances.find((i) => i.id === id)?.state as never;
    },
  });
  const view = () => worldView(runner.spec, runner.world);
  return {
    the(actor) {
      return live(view().the(actor).id) as never;
    },
    all(actor) {
      return view().all(actor).map((i) => live(i.id)) as never;
    },
    spawn(actor, label) {
      const event = runner.spawn(actor.name, label);
      return live(event.instance) as never;
    },
    act(who: { id: string }, action: string, inputs?: Record<string, unknown>) {
      const event = runner.act(who.id, action, inputs);
      if (event.error) throw new SpecError(event.error);
    },
    settle: () => runner.settle(),
    fire(who, timer) {
      const event = runner.fireTimer(who.id, timer);
      if (event.error) throw new SpecError(event.error);
    },
    lose: (key) => runner.loseNext(key),
    restart(who) {
      runner.restart(who.id);
    },
    deliver(who, message, payload) {
      const event = runner.deliver(who.id, message, payload);
      if (event.error) throw new SpecError(event.error);
    },
    drop(who, message, payload) {
      runner.drop(who.id, message, payload);
    },
    step(who, transition) {
      const event = runner.guard(who.id, transition);
      if (event.error) throw new SpecError(event.error);
    },
    get world() {
      return worldView(runner.spec, runner.world);
    },
  } as Script;
}
