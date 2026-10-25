// Running a spec: a Runner applies steps and keeps the trace; scenarios script one.
import { act, choices, emptyWorld, fire, guard, lose, pendingInOrder, restart, spawn, SpecError, startWorld, worldView, type Step } from "./engine.ts";
import type { Script } from "./dsl.ts";
import type { Event, Run, ScenarioInfo, Spec, World } from "./spec.ts";

/** Most events one settle may run before the spec is assumed to loop. */
const SETTLE_LIMIT = 1000;

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

  /** Run the earliest due delivery or timer, or a guarded transition that holds first. */
  next(): Event | null {
    const { guards } = choices(this.spec, this.current);
    if (guards.length) return this.apply(guard(this.spec, this.current, guards[0].instance, guards[0].key));
    const [first] = pendingInOrder(this.current);
    if (!first) return null;
    const lost = first.kind === "deliver" ? this.toLose.indexOf(first.message) : -1;
    if (lost >= 0) {
      this.toLose.splice(lost, 1);
      return this.apply(lose(this.spec, this.current, first.id));
    }
    return this.apply(fire(this.spec, this.current, first.id));
  }

  /** Run what is due up to `until`, in time order. */
  runUntil(until: number) {
    for (let n = 0; ; n++) {
      if (n >= SETTLE_LIMIT) throw new SpecError(`ran ${SETTLE_LIMIT} events without settling; a transition may loop`);
      const { guards, pending } = choices(this.spec, this.current);
      if (!guards.length && (!pending.length || pending[0].at > until)) break;
      this.next();
    }
  }

  settle(horizon = 60_000) {
    this.runUntil(this.current.clock + horizon);
  }

  wait(ms: number) {
    const until = this.current.clock + ms;
    this.runUntil(until);
    this.current = { ...this.current, clock: Math.max(this.current.clock, until) };
  }

  loseNext(message: string) {
    this.toLose.push(message);
  }

  restart(instance: string): Event {
    return this.apply(restart(this.spec, this.current, instance));
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
  return {
    spawn(actor, label) {
      const event = runner.spawn(actor.name, label);
      return live(event.instance) as never;
    },
    act(who: { id: string }, action: string, inputs?: Record<string, unknown>) {
      const event = runner.act(who.id, action, inputs);
      if (event.error) throw new SpecError(event.error);
    },
    settle: (horizon) => runner.settle(horizon),
    wait: (ms) => runner.wait(ms),
    lose: (key) => runner.loseNext(key),
    restart(who) {
      runner.restart(who.id);
    },
    get world() {
      return worldView(runner.spec, runner.world);
    },
  } as Script;
}
