// What every random spec is checked against. Each check that fails is a finding: a seed, which
// check, and what differed. See spec.ts for the specs.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, Pool, replay, type Bounds, type Counterexample, type PropertyResult, type Report } from "../../src/check/index.ts";
import { stepBreaks } from "../../src/check/judge.ts";
import { actorNamed, choices, holdsIn, LIVENESS_KINDS, traceView, violatedAlways, type Spec, type World } from "../../src/spec/index.ts";
import { scenarioSeeds } from "../../src/cli/shape.ts";
import { explore, worldKey } from "../check/reference.ts";
import { build, describe, type Size, type SpecDesc } from "./spec.ts";

export interface Finding {
  seed: number;
  check: string;
  detail: string;
}

const LIVENESS = new Set<string>(LIVENESS_KINDS);

/** Bigger searches are skipped: the reference explorer is slow on purpose. */
const MAX_STATES = 60_000;
const SEARCH = { walks: 0, maxStates: MAX_STATES, timeLimit: 60_000 } as const;

export interface FuzzOptions {
  /** Worker threads to compare against the main thread alone; none to skip that check. */
  pool?: Pool;
  size?: Size;
}

export async function fuzz(seed: number, options: FuzzOptions = {}): Promise<{ findings: Finding[]; states: number; skipped?: string }> {
  const findings: Finding[] = [];
  const find = (check: string, detail: string) => findings.push({ seed, check, detail });
  const size = options.size ?? "small";
  const desc = describe(seed, size);
  let spec: Spec;
  try {
    spec = build(desc);
  } catch (error) {
    find("build", String(error));
    return { findings, states: 0 };
  }
  const bounds: Partial<Bounds> = { ...desc.bounds, ...SEARCH };
  try {
    // The search (the integer core), and the worlds it reaches.
    const worlds = new Set<string>();
    const plain = await check(spec, { ...bounds, symmetry: false, workers: 0 }, [], { watch: { state: (w, b) => worlds.add(worldKey(w, b.acts, b.faults)) } });
    if (!plain.exhaustive) return { findings, states: plain.states, skipped: "too big" };

    againstReference(spec, desc, plain, worlds, find);
    for (const p of plain.properties) if (!p.holds) counterexampleHolds(spec, p, find);
    if (plain.stuck) stuckHolds(spec, plain.stuck.counterexample, find);

    // The classic search without reductions: the very same report.
    const classic = await check(spec, { ...bounds, reduce: false, symmetry: false, workers: 0 }, [], CLASSIC);
    sameReport("classic: report", plain, classic, find);

    const reduced = await check(spec, { ...bounds, reduce: true, symmetry: false, workers: 0 }, [], CLASSIC);
    same("sleep sets: verdicts", signature(reduced), signature(plain), find);
    same("sleep sets: states", reduced.states, plain.states, find);
    same("sleep sets: coverage", reduced.coverage, plain.coverage, find);

    const folded = await check(spec, { ...bounds, symmetry: true, workers: 0 });
    if (!folded.reductions.refuted) {
      same("symmetry: verdicts", signature(folded), signature(plain), find);
      if (folded.states > plain.states) find("symmetry: states", `${folded.states} with symmetry, ${plain.states} without`);
    }
    sameReport("classic: report with symmetry", folded, await check(spec, { ...bounds, reduce: false, symmetry: true, workers: 0 }, [], CLASSIC), find);

    // From scenario seeds too, whose instances may differ from the bounds'.
    const seeds = scenarioSeeds(spec);
    if (seeds.length) sameReport("classic: report from seeds", await check(spec, { ...bounds, workers: 0 }, seeds), await check(spec, { ...bounds, reduce: false, workers: 0 }, seeds, CLASSIC), find);

    await walksAgree(spec, desc, plain, find);
    if (options.pool) await sharedAlike(seed, size, spec, bounds, options.pool, find);
    return { findings, states: plain.states };
  } catch (error) {
    find("crash", error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { findings, states: 0 };
  }
}

/** The classic search, where a check is of it: its reductions, its threads, or agreeing with the integer core. */
const CLASSIC = { engine: "classic" } as const;

/** Two reports alike in everything but the clock. */
function sameReport(check: string, ours: Report, theirs: Report, find: (check: string, detail: string) => void): void {
  // What a stopped search's states differ in is the integer engine's diagnostic only.
  const comparable = ({ variety: _v, mostInFlight: _m, ...r }: Report) => ({ ...r, durationMs: 0 });
  if (!Bun.deepEquals(comparable(ours), comparable(theirs))) find(check, `states ${ours.states} vs ${theirs.states}; verdicts ${JSON.stringify(signature(ours))} vs ${JSON.stringify(signature(theirs))}`);
}

/** The plain search against the reference explorer: the same worlds, `always` breaks, errors, coverage, stuck world and liveness verdicts. */
function againstReference(spec: Spec, desc: SpecDesc, plain: Report, worlds: Set<string>, find: (check: string, detail: string) => void): void {
  const ref = explore(spec, desc.bounds);
  if (worlds.size !== ref.worlds.size || [...worlds].some((w) => !ref.worlds.has(w))) {
    const extra = [...worlds].filter((w) => !ref.worlds.has(w)).length;
    const missing = [...ref.worlds].filter((w) => !worlds.has(w)).length;
    find("reference: worlds", `checker ${worlds.size}, reference ${ref.worlds.size}: ${extra} only in the checker, ${missing} only in the reference`);
  }
  for (const p of plain.properties.filter((p) => p.kind === "always")) {
    const theirs = ref.broken.get(p.id);
    const ours = p.holds ? undefined : p.counterexample.events.length;
    if (theirs !== ours) find("reference: always", `${p.id}: checker ${ours ?? "holds"}, reference ${theirs ?? "holds"}`);
  }
  same("reference: errors", [...new Set(plain.errors.map((e) => e.message))].sort(), [...ref.errors].sort(), find);
  // Coverage is of the spec's steps: a message delivered where nobody handles it is an error, not a step.
  const steps = new Set([...plain.coverage.reached, ...plain.coverage.missed]);
  same("reference: coverage", [...plain.coverage.reached].sort(), [...ref.reached].filter((k) => steps.has(k)).sort(), find);
  same("reference: stuck", plain.stuck ? shape(plain.stuck.counterexample) : undefined, ref.stuck, find);
  for (const p of plain.properties.filter((p) => LIVENESS.has(p.kind))) same(`reference: liveness ${p.id}`, verdictOf(p), ref.liveness.get(p.id), find);
}

/** A counterexample replays to the same events, and breaks its property where it ends. */
function counterexampleHolds(spec: Spec, p: Extract<PropertyResult, { holds: false }>, find: (check: string, detail: string) => void): void {
  const ce = p.counterexample;
  const again = replay(spec, ce.initial, ce.choices);
  const names = (c: Counterexample) => c.events.map((e) => `${e.actor}.${e.key}${e.error ? "!" : ""}`);
  same(`replay: ${p.id}`, names(again), names(ce), find);
  const property = spec.properties.find((x) => x.id === p.id)!;
  const last = ce.events.at(-1);
  switch (property.kind) {
    case "always":
      if (last ? !last.violations.includes(p.id) : !violatedAlways(spec, ce.initial).includes(p.id)) find(`counterexample: ${p.id}`, "where it ends does not break it");
      break;
    case "never":
      if (!property.never(traceView(ce.events))) find(`counterexample: ${p.id}`, "the path does not break it");
      break;
    case "everyStep": {
      const before = ce.worlds.at(-2) ?? ce.initial;
      if (!last || !stepBreaks(spec, before, ce.worlds.at(-1)!, last, new Set()).includes(p.id)) find(`counterexample: ${p.id}`, "the last step does not break it");
      break;
    }
    default: {
      // A lasso: the loop starts where the path ends, and comes back there.
      if (!p.loop) {
        find(`counterexample: ${p.id}`, "a liveness counterexample without a loop");
        break;
      }
      const end = ce.worlds.at(-1) ?? ce.initial;
      if (p.loop.events.some((e) => e.error)) find(`counterexample: ${p.id}`, "the loop has a failed step");
      if (p.loop.events.length && worldOnly(p.loop.worlds.at(-1)!) !== worldOnly(end)) find(`counterexample: ${p.id}`, "the loop does not come back to where it starts");
      if (!p.loop.events.length && !stays(spec, end)) find(`counterexample: ${p.id}`, "an empty loop where something fair can happen");
    }
  }
}

/**
 * Random runs alone: what they break replays and really breaks, and when a run's path fits
 * the search's bounds, the exhaustive search found that property broken too.
 */
async function walksAgree(spec: Spec, desc: SpecDesc, plain: Report, find: (check: string, detail: string) => void): Promise<void> {
  const walked = await check(spec, { ...desc.bounds, depth: 0, walks: 300, walkDepth: desc.bounds.depth + 4, timeLimit: 60_000, workers: 0 });
  for (const p of walked.properties) {
    if (p.holds || p.foundBy !== "walk") continue;
    counterexampleHolds(spec, p, (check, detail) => find(`walks: ${check}`, detail));
    const ce = p.counterexample;
    const acts = new Map<string, number>();
    for (const c of ce.choices) if (c.kind === "act") acts.set(`${c.instance}.${c.key}`, (acts.get(`${c.instance}.${c.key}`) ?? 0) + 1);
    const fits = ce.events.length <= desc.bounds.depth && [...acts.values()].every((n) => n <= desc.bounds.repeats) && shape(ce).faults <= desc.bounds.faults;
    const searched = plain.properties.find((q) => q.id === p.id)!;
    if (fits && searched.holds) find("walks: found what the search missed", `${p.id} breaks in ${ce.events.length} steps within the bounds, and the search says it holds`);
  }
}

/** A stuck world: nothing can happen there, and the spec does not call it final. */
function stuckHolds(spec: Spec, ce: Counterexample, find: (check: string, detail: string) => void): void {
  const world = ce.worlds.at(-1) ?? ce.initial;
  const { actions, guards, pending } = choices(spec, world);
  if (actions.length || guards.length || pending.length) find("stuck", "something can happen in the stuck world");
  if (spec.finalState && holdsIn(spec, world, spec.finalState.when)) find("stuck", "the stuck world is final");
}

/** Nothing fair can happen: every guard that holds and everything pending is a step marked `fair: false`. */
function stays(spec: Spec, world: World): boolean {
  const { guards, pending } = choices(spec, world);
  const fair = (instance: string, key: string) => actorNamed(spec, world.instances.find((i) => i.id === instance)!.actor).transitions[key]?.fair !== false;
  return !guards.some((g) => fair(g.instance, g.key)) && !pending.some((p) => fair(p.to, p.kind === "deliver" ? p.message : p.timer));
}

/** The report with workers forced to join, against the main thread alone: the same in every way. */
async function sharedAlike(seed: number, size: Size, spec: Spec, bounds: Partial<Bounds>, pool: Pool, find: (check: string, detail: string) => void): Promise<void> {
  // A directory of its own: see importBundled in src/cli/load.ts.
  mkdirSync(join(tmpdir(), "feynman-fuzz"), { recursive: true });
  const module = join(mkdtempSync(join(tmpdir(), "feynman-fuzz", `${seed}-`)), "spec.ts");
  writeFileSync(module, `import { build, describe } from ${JSON.stringify(join(import.meta.dir, "spec.ts"))};\nexport default build(describe(${seed}, ${JSON.stringify(size)}));\n`);
  const alone = await check(spec, { ...bounds, workers: 0 }, [], CLASSIC);
  const shared = await check(spec, { ...bounds, workers: pool.size }, [], { source: { module }, pool, shareFrom: 2, ...CLASSIC });
  const comparable = (r: Report) => ({ ...r, durationMs: 0, threads: 0, bounds: { ...r.bounds, workers: 0 } });
  if (!Bun.deepEquals(comparable(shared), comparable(alone))) {
    const a = signature(alone);
    const s = signature(shared);
    find("threads", `${shared.threads} threads differ from one: states ${shared.states} vs ${alone.states}; verdicts ${JSON.stringify(s)} vs ${JSON.stringify(a)}`);
  }
}

/** Each property's verdict, with a counterexample's length; and the stuck world and errors. */
function signature(r: Report): Record<string, unknown> {
  return { ...Object.fromEntries(r.properties.map((p) => [p.id, verdictOf(p) === "broken" && !p.holds ? `broken in ${p.counterexample.events.length}` : verdictOf(p)])), stuck: r.stuck ? shape(r.stuck.counterexample) : undefined, errors: r.errors.map((e) => `${e.message} in ${e.counterexample.events.length}`).sort() };
}

function verdictOf(p: PropertyResult): "holds" | "broken" | "unfinished" {
  return p.holds ? (p.unfinished ? "unfinished" : "holds") : "broken";
}

function shape(ce: Counterexample) {
  return { events: ce.events.length, faults: ce.events.filter((e) => e.kind === "lose" || e.kind === "restart").length };
}

function worldOnly(w: World): string {
  return worldKey(w, {}, 0);
}

function same(check: string, actual: unknown, expected: unknown, find: (check: string, detail: string) => void): void {
  if (!Bun.deepEquals(actual, expected)) find(check, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
