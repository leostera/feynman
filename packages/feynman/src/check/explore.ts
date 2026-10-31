// The checker: a bounded breadth-first search over everything that can happen next, plus
// random runs that go deeper than the search can.
//
// From a world with the configured instances, each state branches on: every action on
// every instance (with inputs from its schema), every guarded transition that holds,
// every pending delivery taken by each step on it (networks reorder; a fault is one more
// step, RFD0012), and every timer set. The search runs on worlds as integers (integer.ts,
// RFD0008), deduplicated by fingerprint, so breadth-first order finds the shortest
// counterexample. Symmetry (keys.ts) renames interchangeable instances to one order.
import { defaultMemoryLimit } from "./memory.ts";
import { isLiveness, spawn, startWorld, type LivenessProperty, type PropertyInfo, type Spec, type World } from "../spec/index.ts";
import { verdicts, type Verdicts } from "./judge.ts";
import { NO_SYMMETRY, symmetryOf, type Symmetry } from "./keys.ts";
import { judgeLiveness, type Lasso } from "./liveness.ts";
import { IntegerSearch, type Variety } from "./integer.ts";
import type { RuleVerdict } from "./rules.ts";
import { apply, replay, type Choice, type Counterexample, type ScenarioPlace } from "./steps.ts";
import { rebind, shrink, walk, type WalkResult } from "./walk.ts";

export { apply, branches, placeText, QUIET, replay, type Choice, type Counterexample, type ScenarioPlace } from "./steps.ts";

export interface Bounds {
  /** Instances of each actor that is not a singleton (1 by default). */
  instances: Record<string, number>;
  /** Longest path explored, in events. */
  depth: number;
  /** Stop after this many distinct states. */
  maxStates: number;
  /** Stop after this long, in milliseconds. */
  timeLimit: number;
  /** Stop when the process holds more than this many megabytes (50% of the machine's by default). */
  memoryLimit: number;
  /** Random runs to try before the search; they take at most a quarter of the time limit. */
  walks: number;
  /** Longest random run, in events. */
  walkDepth: number;
  /** Treat interchangeable instances of one actor as one (see keys.ts). */
  symmetry: boolean;
  /**
   * How many merged twins to test a symmetry claim on: both must have the same next steps.
   * Each test runs every step from two worlds, so more tests catch a subtly wrong claim more
   * surely, at a cost; 0 trusts the claim.
   */
  symmetryChecks: number;
}

/** Which limit stopped a search early. */
export type StopReason = "maxStates" | "timeLimit" | "memoryLimit";

export const DEFAULT_BOUNDS: Bounds = {
  instances: {},
  depth: 14,
  maxStates: 300_000,
  timeLimit: 20_000,
  memoryLimit: defaultMemoryLimit(),
  walks: 2_000,
  walkDepth: 120,
  symmetry: true,
  symmetryChecks: 2_000,
};

/** Share of the time limit random runs may use. */
const WALK_SHARE = 0.25;

/** A property's verdict: it held, or here is how it breaks. */
export type PropertyResult = PropertyHeld | PropertyBroken;

interface PropertyVerdict {
  id: string;
  kind: PropertyInfo["kind"];
  description: string;
  /** A known bug: why the property is expected to break. */
  known?: string;
  /**
   * For `leadsTo`: in how many explored worlds it was put to the test, `whenever` holding
   * and `then` not. Zero means exploration never got there, so holding says nothing.
   */
  tested?: number;
}

export interface PropertyHeld extends PropertyVerdict {
  holds: true;
  /**
   * Holding among the worlds explored, but not all of them: the search stopped early, or (for
   * liveness) the region it was judged on reaches worlds past the depth bound, where a loop
   * may lie.
   */
  unfinished?: boolean;
  /**
   * When the search stopped early: the length of the paths it had explored in full. A safety
   * property held on every path of up to this many events, from each world it started from.
   */
  upTo?: number;
}

export interface PropertyBroken extends PropertyVerdict {
  holds: false;
  counterexample: Counterexample;
  /** Who found the counterexample: the search (shortest), or a random run (shrunk, maybe not shortest). */
  foundBy: "search" | "walk";
  /**
   * For liveness: what repeats forever after the counterexample, from where it ends. Empty
   * when the system stays where it ends (nothing fair can happen there).
   */
  loop?: Counterexample;
  /**
   * When the counterexample is not the shortest because a shorter one needs more faults:
   * that one's length and faults (see withFewestFaults).
   */
  shorter?: { events: number; faults: number };
}

export interface Report {
  spec: string;
  bounds: Bounds;
  states: number;
  /** The scenario worlds explored from, besides the initial world. */
  seeds: ScenarioPlace[];
  /** Whether every state within the bounds was explored. */
  exhaustive: boolean;
  /** Why the search stopped early, when it did. */
  stoppedBy?: StopReason;
  /** When the search stopped early: what its states differ in, most first (integer engine). */
  variety?: Variety[];
  /** With `variety`: the most messages in flight at once in an explored world. */
  mostInFlight?: number;
  /** Each rule a property needs, checked in the design without it (RFD0010), when asked for (checkRules). */
  rules?: RuleVerdict[];
  depthReached: number;
  durationMs: number;
  properties: PropertyResult[];
  /** Spec bugs met while exploring: an undeclared send, a message nobody handles. */
  errors: { message: string; counterexample: Counterexample }[];
  /** A world where nothing can happen and the spec does not call it final (the first found). */
  stuck?: { counterexample: Counterexample; foundBy: "search" | "walk" };
  /** Steps that ran somewhere, in the search or a random run. */
  coverage: { reached: string[]; missed: string[] };
  /** The random runs: how many, how many steps in all, and the longest. */
  walks: { runs: number; steps: number; deepest: number };
  /** Symmetry: the instances taken as interchangeable. */
  reductions: {
    symmetric: string[][];
    /** Actors declared symmetric whose instances turned out not to be; the search was redone without. */
    refuted?: string[];
  };
}

/** A world to explore from besides the initial one: where a scenario's setup leaves it, or where it ends. */
export interface Seed extends ScenarioPlace {
  world: World;
}

/** Callbacks for tools that compare the checker with another: every distinct state, as the search first meets it. */
export interface Watch {
  state?(world: World, memory: string): void;
}


/** How to run a check, besides the bounds. */
export interface CheckOptions {
  /** Every distinct state, as the search first meets it. */
  watch?: Watch;
  /** Stop once every property has broken: for searches that only look for breaks. */
  untilBroken?: boolean;
}

/** Where paths start: the initial world, then each seed, with the symmetry of each. */
export interface Root {
  from?: ScenarioPlace;
  world: World;
  symmetry: Symmetry;
}

/**
 * Explore every interleaving within the bounds, from the initial world and from each seed
 * at once, breadth first, after a share of random runs. Seeding with where scenarios end puts
 * the search where the interesting states are, rather than spending its budget getting there.
 */
export async function check(spec: Spec, bounds: Partial<Bounds> = {}, seeds: Seed[] = [], options: CheckOptions = {}): Promise<Report> {
  const apart = spec.properties.some(isLiveness) && spec.properties.some((p) => p.kind === "never");
  return apart ? checkApart(spec, bounds, seeds, options) : checkTogether(spec, bounds, seeds, options);
}

/**
 * Liveness and `never` properties, judged in searches of their own. What a `never` property
 * remembers of the path is part of a state (see memoryOf), which unrolls the system's loops:
 * a loop that counts a step comes back to a different state each time round, and no liveness
 * counterexample could close. Liveness is a property of the system's states alone, as in
 * TLA+, so it is judged on a search without that memory. The safety search, without liveness,
 * keeps symmetry too.
 */
async function checkApart(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[], options: CheckOptions): Promise<Report> {
  const started = Date.now();
  const part = (keep: (p: PropertyInfo) => boolean): Spec => ({ ...spec, properties: spec.properties.filter(keep) });
  const a = await checkTogether(part((p) => !isLiveness(p)), bounds, seeds, options);
  const b = await checkTogether(part(isLiveness), { ...bounds, walks: 0 }, seeds, { ...options, watch: undefined });
  return {
    ...a,
    properties: spec.properties.map((p) => (isLiveness(p) ? b : a).properties.find((q) => q.id === p.id)!),
    states: a.states + b.states,
    exhaustive: a.exhaustive && b.exhaustive,
    stoppedBy: a.stoppedBy ?? b.stoppedBy,
    ...(a.variety || b.variety ? { variety: a.variety ?? b.variety, mostInFlight: a.mostInFlight ?? b.mostInFlight } : {}),
    depthReached: Math.max(a.depthReached, b.depthReached),
    durationMs: Date.now() - started,
  };
}

async function checkTogether(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[], options: CheckOptions): Promise<Report> {
  const b = boundsFor(spec, bounds);
  const started = Date.now();
  const roots = rootsOf(spec, b, seeds);
  const walkVerdicts = verdicts();
  const search = new IntegerSearch(spec, b, roots, options.watch ?? {}, started);
  search.untilBroken = options.untilBroken === true && spec.properties.length > 0;
  // The search goes first, leaving random runs their share of the time. When it explores every
  // world there is, they would find nothing it did not, and are skipped; else they run, and a
  // search stopped at its share goes on, up to the time limit.
  search.run(b.walks > 0 ? started + b.timeLimit * (1 - WALK_SHARE) : undefined);
  if (search.refuted) return await withoutSymmetry(spec, bounds, seeds, options, roots, started);
  let walked = NO_WALKS;
  if (b.walks > 0 && !search.complete && !search.allBroken) {
    walked = walk(spec, roots, b, walkVerdicts, Math.min(Date.now() + b.timeLimit * WALK_SHARE, started + b.timeLimit));
    if (search.stoppedBy === "timeLimit") search.run();
    if (search.refuted) return await withoutSymmetry(spec, bounds, seeds, options, roots, started);
  }
  return await reportOf(spec, b, seeds.map(({ scenario, at }) => ({ scenario, at })), search, walked, walkVerdicts, started);
}

const NO_WALKS: WalkResult = { runs: 0, steps: 0, deepest: 0, findings: [], errors: [] };

/** The bounds asked for; liveness is judged without symmetry for now (RFD0006: a property naming one instance is not symmetric). */
function boundsFor(spec: Spec, bounds: Partial<Bounds>): Bounds {
  const b: Bounds = { ...DEFAULT_BOUNDS, ...bounds, instances: { ...DEFAULT_BOUNDS.instances, ...bounds.instances } };
  if (spec.properties.some(isLiveness)) b.symmetry = false;
  return b;
}

function rootsOf(spec: Spec, b: Bounds, seeds: Seed[]): Root[] {
  const scenarios = seeds.map(({ world, ...from }): Omit<Root, "symmetry"> => ({ world, from }));
  return [{ world: initialWorld(spec, b) }, ...scenarios].map((r) => ({ ...r, symmetry: b.symmetry ? symmetryOf(spec, r.world) : NO_SYMMETRY }));
}

/** A symmetry claim turned out false: search again without it, and say which actors claimed it. */
async function withoutSymmetry(spec: Spec, bounds: Partial<Bounds>, seeds: Seed[], options: CheckOptions, roots: Root[], started: number): Promise<Report> {
  const again = await check(spec, { ...bounds, symmetry: false }, seeds, options);
  const classes = roots.flatMap((r) => r.symmetry.classes.map((c) => c.ids));
  const actors = [...new Set(classes.flatMap((ids) => ids.map((id) => roots[0].world.instances.find((i) => i.id === id)?.actor ?? id)))];
  return { ...again, durationMs: Date.now() - started, reductions: { ...again.reductions, refuted: actors } };
}

/** The report: each property's verdict (from the search, else a random run), errors, stuck, coverage. */
async function reportOf(spec: Spec, b: Bounds, seeds: ScenarioPlace[], search: IntegerSearch, walked: WalkResult, walkVerdicts: Verdicts, started: number): Promise<Report> {
  const { roots } = search;
  const named = (root: number, ce: Counterexample): Counterexample => ({ ...ce, ...(roots[root].from ? { from: roots[root].from } : {}) });
  const fromRoot = (root: number, choices: Choice[]) => named(root, replay(spec, roots[root].world, choices));
  const fromWalk = (id: string): Counterexample | undefined => {
    const found = walked.findings.find((f) => f.id === id);
    return found && named(found.root, shrink(spec, roots[found.root].world, found, fromRoot(found.root, found.choices)));
  };
  const liveness = await livenessVerdicts(spec, spec.properties.filter(isLiveness), search);
  const paths = await search.paths([...search.failures.values(), ...search.errors.values(), ...(search.stuckAt === undefined ? [] : [search.stuckAt])]);
  const fromSearch = (gid: number) => fromRoot(search.root[gid], paths.get(gid)!);
  const properties = spec.properties.map((property): PropertyResult => {
    const live = liveness.get(property.id);
    if (live) return live;
    const base = verdictBase(property);
    const found = search.failures.get(property.id);
    if (found !== undefined) return { ...base, holds: false, counterexample: fromSearch(found), foundBy: "search" };
    const walkedTo = fromWalk(property.id);
    if (walkedTo) return { ...base, holds: false, counterexample: walkedTo, foundBy: "walk" };
    return { ...base, holds: true, ...(search.stoppedBy ? { upTo: search.completeDepth } : {}) };
  });
  const stuckFound =
    search.stuckAt !== undefined ? { counterexample: fromSearch(search.stuckAt), foundBy: "search" as const } : walked.stuck ? { counterexample: fromRoot(walked.stuck.root, walked.stuck.choices), foundBy: "walk" as const } : undefined;
  const walkErrors = walked.errors.filter((e) => !search.errors.has(e.message)).map((e) => ({ message: e.message, counterexample: fromRoot(e.root, e.choices) }));
  const reached = new Set([...search.stats.reached, ...walkVerdicts.reached]);
  const all = allSteps(spec);
  return {
    spec: spec.name,
    bounds: b,
    seeds,
    states: search.states,
    exhaustive: !search.stoppedBy && !search.allBroken,
    stoppedBy: search.stoppedBy,
    ...(search.stoppedBy ? { variety: search.variety(), mostInFlight: search.mostInFlight } : {}),
    depthReached: search.depthReached,
    durationMs: Date.now() - started,
    properties,
    errors: [...[...search.errors].map(([message, gid]) => ({ message, counterexample: fromSearch(gid) })), ...walkErrors],
    ...(stuckFound ? { stuck: stuckFound } : {}),
    coverage: { reached: all.filter((k) => reached.has(k)), missed: all.filter((k) => !reached.has(k)) },
    walks: { runs: walked.runs, steps: walked.steps, deepest: walked.deepest },
    reductions: { symmetric: roots[0].symmetry.classes.map((c) => c.labels) },
  };
}

/** What every verdict on a property carries. */
function verdictBase(property: PropertyInfo) {
  return { id: property.id, kind: property.kind, description: property.description, ...(property.known === undefined ? {} : { known: property.known }) };
}

/** Singletons, plus the configured number of every other actor, labelled by actor: "Mac", or "Mac A", "Mac B"… */
export function initialWorld(spec: Spec, bounds: Pick<Bounds, "instances">): World {
  let world = startWorld(spec).at(-1)?.world ?? { seq: 0, fresh: {}, rng: 1, instances: [], pending: [] };
  for (const actor of spec.actors.filter((a) => !a.singleton)) {
    const count = bounds.instances[actor.name] ?? 1;
    for (let n = 0; n < count; n++) world = spawn(spec, world, actor.name, count === 1 ? actor.name : `${actor.name} ${String.fromCharCode(65 + n)}`).world;
  }
  return world;
}

function allSteps(spec: Spec): string[] {
  return spec.actors.flatMap((actor) => [...Object.keys(actor.actions), ...Object.keys(actor.transitions)].map((key) => `${actor.name}.${key}`));
}

// Liveness counterexamples --------------------------------------------------------------------------

/**
 * Each liveness property's verdict, by id. A property that held after the search stopped
 * early is unfinished.
 */
async function livenessVerdicts(spec: Spec, liveness: LivenessProperty[], search: IntegerSearch): Promise<Map<string, PropertyResult>> {
  if (!liveness.length) return new Map();
  const graph = search.graph();
  const judged = liveness.map((property) => ({ property, verdict: judgeLiveness(graph, property) }));
  const steps = judged.flatMap(({ verdict }) => (verdict.holds ? [] : [...verdict.lasso.prefix, ...verdict.lasso.loop]));
  const resolved = await search.resolve(steps, true);
  return new Map(
    judged.map(({ property, verdict }): [string, PropertyResult] => {
      const base = { ...verdictBase(property), ...(verdict.tested === undefined ? {} : { tested: verdict.tested }) };
      if (verdict.holds) return [property.id, { ...base, holds: true, ...(verdict.unfinished || search.stoppedBy ? { unfinished: true } : {}) }];
      const root = search.roots[search.root[verdict.lasso.root]];
      return [property.id, { ...base, holds: false, ...lassoOf(spec, root.world, verdict.lasso, resolved, root.from), foundBy: "search" }];
    }),
  );
}

/**
 * A lasso as a counterexample and the loop after it, replayed with explanations. Steps are
 * matched to the world they run in by what they carry, since paths through the graph differ
 * from the ones the search took.
 */
function lassoOf(spec: Spec, start: World, lasso: Lasso, resolved: Map<string, { choice: Choice; world?: World }>, from: ScenarioPlace | undefined): { counterexample: Counterexample; loop: Counterexample } {
  const run = (initial: World, steps: Lasso["prefix"]): Counterexample => {
    const out: Counterexample = { initial, choices: [], events: [], worlds: [] };
    let world = initial;
    for (const step of steps) {
      const { choice, world: was } = resolved.get(`${step.from}:${step.option}`)!;
      const now = rebind(spec, was!, world, choice);
      if (!now) throw new Error(`a liveness counterexample does not replay at ${choice.kind}`);
      const next = apply(spec, world, now);
      out.choices.push(now);
      out.events.push(next.event);
      out.worlds.push(next.world);
      world = next.world;
    }
    return out;
  };
  const counterexample = { ...run(start, lasso.prefix), ...(from ? { from } : {}) };
  return { counterexample, loop: run(counterexample.worlds.at(-1) ?? counterexample.initial, lasso.loop) };
}
