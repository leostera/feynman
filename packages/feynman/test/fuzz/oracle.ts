// What every random spec is checked against. Each check that fails is a finding: a seed, which
// check, and what differed. See spec.ts for the specs.
import { apply, branches, check, faultsIn, initialWorld, QUIET, replay, type Bounds, type Choice, type Counterexample, type PropertyBroken, type PropertyResult, type Report } from "../../src/check/index.ts";
import { stepBreaks } from "../../src/check/judge.ts";
import { actorNamed, choices, holdsIn, LIVENESS_KINDS, traceView, violatedAlways, worldView, type Spec, type World } from "../../src/spec/index.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { stepsTaking, whenHolds } from "../../src/spec/engine.ts";
import { explore, worldKey } from "../check/reference.ts";
import { conform, parseLog } from "../../src/check/conform.ts";
import { seeded as seededRandom } from "../../src/check/walk.ts";
import { sortedJson } from "../../src/spec/json.ts";
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
  // The budgets are the spec's variables (build): the search takes the rest.
  const { faults: _faults, repeats: _repeats, ...searched } = desc.bounds;
  const bounds: Partial<Bounds> = { ...searched, ...SEARCH };
  try {
    // The search (the integer core), and the worlds it reaches.
    const worlds = new Set<string>();
    const timed = new Set<string>();
    const timersInOrder = (w: World) => JSON.stringify(w.pending.filter((p) => p.kind === "timer").sort((a, b) => a.id - b.id).map((p) => `${p.to}|${p.timer}`));
    const plain = await check(spec, { ...bounds, symmetry: false }, [], { watch: { state: (w) => (worlds.add(worldKey(w)), timed.add(`${worldKey(w)}\n${timersInOrder(w)}`)) } });
    if (!plain.exhaustive) return { findings, states: plain.states, skipped: "too big" };

    againstReference(spec, desc, plain, worlds, timed, find);
    for (const p of plain.properties) if (!p.holds && !p.unreached) counterexampleHolds(spec, p, find);
    for (const p of plain.properties) if (!p.holds && !p.unreached && !p.loop) logConforms(spec, desc, p.id, p.counterexample, find);
    // Shortest counterexamples seldom need a fault; random runs, a third of whose steps are faults when one can happen, do.
    for (let n = 0; n < 3; n++) logConforms(spec, desc, undefined, randomRun(spec, desc, seed * 7 + n), find);
    if (plain.stuck) stuckHolds(spec, plain.stuck.counterexample, find);

    const folded = await check(spec, { ...bounds, symmetry: true });
    if (!folded.reductions.refuted) {
      same("symmetry: verdicts", signature(folded), signature(plain), find);
      if (folded.states > plain.states) find("symmetry: states", `${folded.states} with symmetry, ${plain.states} without`);
    }

    // From scenario seeds too, whose instances may differ from the bounds': the worlds the reference reaches from them.
    const seeds = scenarioSeeds(spec);
    if (seeds.length) {
      const seeded = new Set([worldKey(initialWorld(spec, desc.bounds)), ...seeds.map((s) => worldKey(s.world))]);
      const fromSeeds = await check(spec, { ...bounds, symmetry: false }, seeds, { watch: { state: (w) => seeded.add(worldKey(w)) } });
      // Only a search that finished explores all the reference does.
      if (fromSeeds.exhaustive) {
        const ref = explore(spec, { ...desc.bounds, from: seeds.map((s) => s.world) });
        if (seeded.size !== ref.worlds.size || [...seeded].some((w) => !ref.worlds.has(w))) find("seeds: worlds", `${seeded.size} worlds from the scenarios, the reference ${ref.worlds.size}`);
      }
    }

    await walksAgree(spec, desc, plain, find);
    return { findings, states: plain.states };
  } catch (error) {
    find("crash", error instanceof Error ? (error.stack ?? error.message) : String(error));
    return { findings, states: 0 };
  }
}

/** The plain search against the reference explorer: the same worlds, `always` breaks, errors, coverage, stuck world and liveness verdicts. */
function againstReference(spec: Spec, desc: SpecDesc, plain: Report, worlds: Set<string>, timed: Set<string>, find: (check: string, detail: string) => void): void {
  const ref = explore(spec, desc.bounds);
  if (worlds.size !== ref.worlds.size || [...worlds].some((w) => !ref.worlds.has(w))) {
    const extra = [...worlds].filter((w) => !ref.worlds.has(w)).length;
    const missing = [...ref.worlds].filter((w) => !worlds.has(w)).length;
    find("reference: worlds", `checker ${worlds.size}, reference ${ref.worlds.size}: ${extra} only in the checker, ${missing} only in the reference`);
  }
  // Without never properties, which remember the path, a state is a world with its timers in
  // the order they were set (the reference keeps them as a set): no more states than those.
  if (!spec.properties.some((p) => p.kind === "never") && plain.states !== timed.size) find("reference: states", `checker ${plain.states} states, ${timed.size} worlds with their timers in order`);
  for (const p of plain.properties.filter((p) => p.kind === "always")) {
    const theirs = ref.broken.get(p.id);
    const ours = p.holds || p.unreached ? undefined : p.counterexample.events.length;
    if (theirs !== ours) find("reference: always", `${p.id}: checker ${ours ?? "holds"}, reference ${theirs ?? "holds"}`);
  }
  for (const p of plain.properties.filter((p) => p.kind === "reachable")) {
    const theirs = ref.reachable.get(p.id);
    const ours = p.holds && p.witness ? p.witness.events.length : undefined;
    if (theirs !== ours) find("reference: reachable", `${p.id}: checker ${ours ?? "never reached"}, reference ${theirs ?? "never reached"}`);
    if (p.holds && p.witness) witnessHolds(spec, p.id, p.witness, find);
  }
  same("reference: errors", [...new Set(plain.errors.map((e) => e.message))].sort(), [...ref.errors].sort(), find);
  // Coverage is of the spec's steps: a message delivered where nobody handles it is an error, not a step.
  const steps = new Set([...plain.coverage.reached, ...plain.coverage.missed]);
  same("reference: coverage", [...plain.coverage.reached].sort(), [...ref.reached].filter((k) => steps.has(k)).sort(), find);
  same("reference: stuck", plain.stuck ? shape(plain.stuck.counterexample) : undefined, ref.stuck, find);
  for (const p of plain.properties.filter((p) => LIVENESS.has(p.kind))) same(`reference: liveness ${p.id}`, verdictOf(p), ref.liveness.get(p.id), find);
}

/** A counterexample replays to the same events, and breaks its property where it ends. */
function counterexampleHolds(spec: Spec, p: PropertyBroken, find: (check: string, detail: string) => void): void {
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
 * A counterexample, written as the log it would leave, is a run of the spec: with every step
 * logged, faults too, and with faults left out and a gap as long as their count. When the
 * reading ends in the counterexample's world, it breaks the property too.
 */
function logConforms(spec: Spec, desc: SpecDesc, id: string | undefined, ce: Counterexample, find: (check: string, detail: string) => void): void {
  if (ce.events.some((e) => e.error)) return;
  const before = (i: number) => (i === 0 ? ce.initial : ce.worlds[i - 1]!);
  const label = (w: World, id?: string) => w.instances.find((i) => i.id === id)?.label;
  const lines = ce.events.map((e, i) => ({
    line: JSON.stringify({ kind: e.kind, instance: label(before(i), e.instance), key: e.key, ...(e.kind === "action" ? { inputs: e.inputs ?? {} } : {}), ...(e.kind === "deliver" ? { message: e.message, from: label(before(i), e.from), payload: e.payload } : {}), state: JSON.parse(sortedJson(ce.worlds[i]!.instances.find((x) => x.id === e.instance)!.state)) }),
    fault: e.tags?.includes("fault") === true,
  }));
  const instances = desc.bounds.instances ?? {};
  if (worldKey(initialWorld(spec, { instances })) !== worldKey(ce.initial)) return;
  const faults = lines.filter((l) => l.fault).length;
  for (const [what, text, options] of [
    ["every step logged", lines.map((l) => l.line).join("\n"), { instances, gap: 0, logsFaults: true }],
    ["faults unlogged", lines.filter((l) => !l.fault).map((l) => l.line).join("\n"), { instances, gap: faults }],
  ] as const) {
    const r = conform(spec, parseLog(text, spec), options);
    if (!r.conforms) {
      find(`log: ${id ?? "a random run"}`, `${what}, it is not a run of the spec: ${r.stop.kind === "mismatch" ? `line ${r.stop.line.line}` : "limit"}`);
      continue;
    }
    const end = (c: Counterexample) => worldOnly(c.worlds.at(-1) ?? c.initial);
    if (id && end(r.run) === end(ce) && !r.broken.some((b) => b.id === id) && spec.properties.find((x) => x.id === id)!.kind === "always") find(`log: ${id}`, `the counterexample, ${what}, ends where it breaks, but conform does not say so`);
  }
  partialLogConforms(spec, instances, ce, lines.map((l) => l.line), lines.map((l) => l.fault), find, id);
}

/**
 * The run as a partial order, as a trace from machines whose clocks disagree gives it: each
 * step after the one before it on its instance and after the step that sent its message,
 * written in a random order that keeps that, faults left out. It conforms.
 */
function partialLogConforms(spec: Spec, instances: Record<string, number>, ce: Counterexample, lines: string[], faults: boolean[], find: (check: string, detail: string) => void, id: string | undefined): void {
  const random = seededRandom(lines.length * 31 + ce.events.length);
  const sentBy = new Map<number, number>();
  const after: Set<number>[] = ce.events.map(() => new Set());
  const last = new Map<string, number>();
  ce.events.forEach((e, i) => {
    const before = i === 0 ? ce.initial : ce.worlds[i - 1]!;
    const choice = ce.choices[i]!;
    if (choice.kind === "fire" && sentBy.has(choice.pending)) after[i]!.add(sentBy.get(choice.pending)!);
    if (last.has(e.instance!)) after[i]!.add(last.get(e.instance!)!);
    if (!faults[i]) last.set(e.instance!, i);
    const had = new Set(before.pending.map((p) => p.id));
    for (const p of ce.worlds[i]!.pending) if (!had.has(p.id) && !faults[i]) sentBy.set(p.id, i);
  });
  const kept = ce.events.map((_, i) => i).filter((i) => !faults[i]);
  const order: number[] = [];
  while (order.length < kept.length) {
    const ready = kept.filter((i) => !order.includes(i) && [...after[i]!].every((j) => faults[j] || order.includes(j)));
    order.push(ready[Math.floor(random() * ready.length)]!);
  }
  const lineOf = new Map(order.map((i, n) => [i, n + 1]));
  const text = order.map((i) => JSON.stringify({ ...JSON.parse(lines[i]!), after: [...after[i]!].filter((j) => !faults[j]).map((j) => lineOf.get(j)!) })).join("\n");
  const r = conform(spec, parseLog(text, spec), { instances, gap: faults.filter(Boolean).length });
  if (!r.conforms) find(`log: ${id ?? "a random run"}`, `as a partial order, it is not a run of the spec: ${r.stop.kind === "mismatch" ? `line ${r.stop.line.line}` : "limit"}`);
}

/** A random run from the initial world, of up to the depth bound's steps, without failed ones. */
function randomRun(spec: Spec, desc: SpecDesc, seed: number): Counterexample {
  const random = seededRandom(seed);
  const initial = initialWorld(spec, { instances: desc.bounds.instances ?? {} });
  const picked: Choice[] = [];
  let world = initial;
  for (let n = 0; n < desc.bounds.depth; n++) {
    const ok = branches(spec, world).map((c) => ({ c, step: apply(spec, world, c, QUIET) })).filter(({ step }) => !step.event.error);
    if (!ok.length) break;
    const faults = ok.filter(({ step }) => step.event.tags?.includes("fault"));
    const from = faults.length && random() < 1 / 3 ? faults : ok;
    const { c, step } = from[Math.floor(random() * from.length)]!;
    picked.push(c);
    world = step.world;
  }
  return replay(spec, initial, picked);
}

/**
 * Random runs alone: what they break replays and really breaks, and when a run's path fits
 * the search's bounds, the exhaustive search found that property broken too.
 */
async function walksAgree(spec: Spec, desc: SpecDesc, plain: Report, find: (check: string, detail: string) => void): Promise<void> {
  const walked = await check(spec, { ...desc.bounds, depth: 0, walks: 300, walkDepth: desc.bounds.depth + 4, timeLimit: 60_000 });
  for (const p of walked.properties) {
    // A reachable property a run got to: the way there replays and gets there, and when it fits
    // the search's bounds, the search got there too.
    if (p.holds && p.witness && p.witnessBy === "walk") {
      witnessHolds(spec, p.id, p.witness, (check, detail) => find(`walks: ${check}`, detail));
      const searched = plain.properties.find((q) => q.id === p.id)!;
      if (fitsBounds(p.witness, desc) && !searched.holds) find("walks: reached what the search missed", `${p.id} is reached in ${p.witness.events.length} steps within the bounds, and the search says never`);
      continue;
    }
    if (p.holds || p.unreached || p.foundBy !== "walk") continue;
    counterexampleHolds(spec, p, (check, detail) => find(`walks: ${check}`, detail));
    const ce = p.counterexample;
    const fits = fitsBounds(ce, desc);
    const searched = plain.properties.find((q) => q.id === p.id)!;
    if (fits && searched.holds) find("walks: found what the search missed", `${p.id} breaks in ${ce.events.length} steps within the bounds, and the search says it holds`);
  }
}

/** Whether a path found by a random run is one the search's bounds allow: as deep, as many repeats and as many faults at most. */
function fitsBounds(ce: Counterexample, desc: SpecDesc): boolean {
  const acts = new Map<string, number>();
  for (const c of ce.choices) if (c.kind === "act") acts.set(`${c.instance}.${c.key}`, (acts.get(`${c.instance}.${c.key}`) ?? 0) + 1);
  return ce.events.length <= desc.bounds.depth && [...acts.values()].every((n) => n <= desc.bounds.repeats) && shape(ce).faults <= desc.bounds.faults;
}

/** A reachable property's way there replays to the same events, takes no failed step, and ends where the property looks for. */
function witnessHolds(spec: Spec, id: string, witness: Counterexample, find: (check: string, detail: string) => void): void {
  const again = replay(spec, witness.initial, witness.choices);
  const names = (c: Counterexample) => c.events.map((e) => `${e.actor}.${e.key}${e.error ? "!" : ""}`);
  same(`replay: ${id}`, names(again), names(witness), find);
  if (witness.events.some((e) => e.error)) find(`witness: ${id}`, "the way there takes a failed step");
  const property = spec.properties.find((x) => x.id === id)!;
  if (property.kind !== "reachable") return;
  let there = false;
  try {
    there = property.reachable(worldView(spec, witness.worlds.at(-1) ?? witness.initial)) === true;
  } catch {}
  if (!there) find(`witness: ${id}`, "where the way there ends is not a world it looks for");
}

/** A stuck world: nothing pending, no action and no fair guard (past the model's bounds, such as atMost), and the spec does not call it final. */
function stuckHolds(spec: Spec, ce: Counterexample, find: (check: string, detail: string) => void): void {
  const world = ce.worlds.at(-1) ?? ce.initial;
  const waiting = world.instances.some((i) => {
    const actor = actorNamed(spec, i.actor);
    return Object.values(actor.actions).some((a) => whenHolds(spec, world, i, a, true)) || Object.values(actor.transitions).some((t) => !t.message && t.when && t.fair !== false && whenHolds(spec, world, i, t, true));
  });
  if (waiting || world.pending.length) find("stuck", "something can happen in the stuck world");
  if (spec.finalState && holdsIn(spec, world, spec.finalState.when)) find("stuck", "the stuck world is final");
}

/** Nothing fair can happen: every guard that holds and everything pending is a step marked `fair: false`. */
function stays(spec: Spec, world: World): boolean {
  const { guards, pending } = choices(spec, world);
  const actorOf = (instance: string) => actorNamed(spec, world.instances.find((i) => i.id === instance)!.actor);
  const fair = (instance: string, step: string) => actorOf(instance).transitions[step]?.fair !== false;
  // A message is taken fairly when one of the steps that can take it now is fair: behind
  // another on an ordered channel, only a loss can, which is not.
  const fairlyTaken = (p: Extract<World["pending"][number], { kind: "deliver" }>) => stepsTaking(spec, world, p).some((step) => fair(p.to, step));
  return !guards.some((g) => fair(g.instance, g.key)) && !pending.some((p) => (p.kind === "deliver" ? fairlyTaken(p) : fair(p.to, p.timer)));
}

/** Each property's verdict, with a counterexample's length; and the stuck world and errors. */
function signature(r: Report): Record<string, unknown> {
  const said = (p: PropertyResult) => (p.holds && p.witness ? `reached in ${p.witness.events.length}` : verdictOf(p) === "broken" && !p.holds && !p.unreached ? `broken in ${p.counterexample.events.length}` : verdictOf(p));
  return { ...Object.fromEntries(r.properties.map((p) => [p.id, said(p)])), stuck: r.stuck ? shape(r.stuck.counterexample) : undefined, errors: r.errors.map((e) => `${e.message} in ${e.counterexample.events.length}`).sort() };
}

function verdictOf(p: PropertyResult): "holds" | "broken" | "unfinished" {
  return p.holds ? (p.unfinished ? "unfinished" : "holds") : "broken";
}

function shape(ce: Counterexample) {
  return { events: ce.events.length, faults: faultsIn(ce.events) };
}

function worldOnly(w: World): string {
  return worldKey(w);
}

function same(check: string, actual: unknown, expected: unknown, find: (check: string, detail: string) => void): void {
  if (!Bun.deepEquals(actual, expected)) find(check, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
