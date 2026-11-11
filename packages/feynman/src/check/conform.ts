// Checking a log against a spec (RFD0016): is what the system did, as its logs tell it, a run
// of the spec? The trace validation of TLA+, and P's PObserve, for Feynman specs.
//
// A log is the events it recorded, in order. Logs do not record everything: a lost message
// leaves no line, and an actor nobody instruments leaves none at all. So between two logged
// events, up to `gap` steps the log does not show may happen: faults, and the steps of actors
// it does not log. A trace is a partial order (each step after the ones it names), and the
// log is a run when some order it allows is. The search is breadth first over (world, events
// matched, unlogged steps since the last), so the reading it finds has the fewest unlogged steps; along it, the spec's
// properties are judged, as a monitor would judge the running system. A log that no reading
// fits leaves the spec at its first line that none can match, and the report says what the
// spec could have done there instead.
import { actorNamed, choices, spawn, stepsTaking, type Event, type Spec, type World } from "../spec/index.ts";
import { holdsIn, traceView } from "../spec/index.ts";
import { sortedJson } from "../spec/json.ts";
import { initialWorld, type Counterexample } from "./explore.ts";
import { safely, stepBreaks } from "./judge.ts";
import { canonical } from "./keys.ts";
import { apply, branches, inputCombinations, QUIET, replay, type Choice } from "./steps.ts";

/** What a log line says happened: an instance appearing, or one taking a step. */
export type LogEvent = LogSpawn | LogStep;

export interface LogSpawn {
  /** Its place in the log, from 1. */
  line: number;
  /** Where it came from, when not a line of a file: a span, for a trace (trace.ts). */
  at?: string;
  kind: "spawn";
  actor: string;
  label: string;
}

export interface LogStep {
  line: number;
  at?: string;
  /** What kind of step, if the log says: an action, a delivery, a timer or a guarded step. */
  kind?: "action" | "deliver" | "timer" | "guard";
  /** Who took it: an instance's id or label. */
  instance: string;
  /** The action's or step's name. */
  key: string;
  /** An action's inputs; left out, any it can take. */
  inputs?: Record<string, unknown>;
  /** A delivery's message, by key (`message:Buy`); left out, any the step is on. */
  message?: string;
  /** A delivery's sender, by id or label. */
  from?: string;
  payload?: unknown;
  /** Fields of the instance's state after the step, which must be as given. */
  state?: Record<string, unknown>;
  /**
   * The lines of the steps that must come before it, when the log is a partial order (a trace,
   * whose machines' clocks disagree). When no step says, the log is in order: each line after
   * the one before.
   */
  after?: number[];
}

export interface ConformOptions {
  /**
   * Instances besides the singletons, as `check --instances` makes them, before the log's own
   * spawns. An actor left out has none: a log says who is there.
   */
  instances?: Record<string, number>;
  /** Unlogged steps allowed between two logged ones (and before the first). */
  gap?: number;
  /** Whether faults are logged; by default not: a lost message leaves no line. */
  logsFaults?: boolean;
  /** Actors whose steps the log does not record. */
  unlogged?: string[];
  /** Worlds the search may visit before it gives up. */
  maxStates?: number;
}

export const DEFAULT_GAP = 4;
const MAX_STATES = 200_000;

/** A property the log's run breaks: the event that breaks it, by its place on the run. */
export interface LogBreak {
  id: string;
  description: string;
  /** Its place in `run.events`. */
  at: number;
}

export type Conformance =
  | {
      conforms: true;
      /** The run the log is, with the unlogged steps it needed. */
      run: Counterexample;
      /** For each event of the run, the log line it matched; undefined for an unlogged step. */
      lines: (number | undefined)[];
      broken: LogBreak[];
      states: number;
    }
  | {
      conforms: false;
      /** Why: the line no reading can match, or the search gave up first. */
      stop: { kind: "mismatch"; line: LogStep; could: string[]; near: string[]; errors: string[] } | { kind: "limit"; states: number };
      /** The longest reading: the run as far as it fits, and its lines. */
      run: Counterexample;
      lines: (number | undefined)[];
      states: number;
    };

// Parsing --------------------------------------------------------------------------------------------

/** A log's lines, as JSON Lines: each one an object for one event, blank lines skipped. */
export function parseLog(text: string, spec: Spec): LogEvent[] {
  const out: LogEvent[] = [];
  let stepped = false;
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new LogError(line, "is not JSON: each line of a log is one event, a JSON object");
    }
    if (!isRecord(value)) throw new LogError(line, "is not an object: each line of a log is one event, like {\"instance\": \"Alice\", \"key\": \"buy\"}");
    const event = parseEvent(value, line, spec);
    if (event.kind === "spawn" && stepped) throw new LogError(line, "spawns after a step: the instances a log is about are there from its start, so their spawns come first");
    if (event.kind !== "spawn") stepped = true;
    out.push(event);
  });
  return out;
}

/** One event, from a log line or (trace.ts) a span, `at` saying where it came from. */
export function parseEvent(v: Record<string, unknown>, line: number, spec: Spec, at?: string): LogEvent {
  try {
    const event = eventOf(v, line, spec);
    return at ? { ...event, at } : event;
  } catch (error) {
    if (error instanceof LogError && at) throw new LogError(line, error.what, at);
    throw error;
  }
}

function eventOf(v: Record<string, unknown>, line: number, spec: Spec): LogEvent {
  const kinds = ["spawn", "action", "deliver", "timer", "guard"];
  if (v.kind !== undefined && !kinds.includes(v.kind as string)) throw new LogError(line, `has kind ${JSON.stringify(v.kind)}: a kind is ${kinds.join(", ")}`);
  if (v.kind === "spawn") {
    const actor = text(v.actor, line, "actor");
    const info = spec.actors.find((a) => a.name === actor);
    if (!info) throw new LogError(line, `spawns ${actor}, which is not an actor of ${spec.name}: its actors are ${spec.actors.map((a) => a.name).join(", ")}`);
    if (info.singleton) throw new LogError(line, `spawns ${actor}, a singleton, which is there from the start`);
    return { line, kind: "spawn", actor, label: text(v.label, line, "label") };
  }
  const step: LogStep = { line, instance: text(v.instance, line, "instance"), key: text(v.key, line, "key") };
  if (v.kind !== undefined) step.kind = v.kind as LogStep["kind"];
  if (v.inputs !== undefined) step.inputs = record(v.inputs, line, "inputs");
  if (v.message !== undefined) step.message = messageKey(text(v.message, line, "message"), line, spec);
  if (v.from !== undefined) step.from = text(v.from, line, "from");
  if ("payload" in v) step.payload = v.payload;
  if (v.state !== undefined) step.state = record(v.state, line, "state");
  if (v.after !== undefined) {
    if (!Array.isArray(v.after) || !v.after.every((n) => Number.isInteger(n) && n > 0 && n < line)) throw new LogError(line, "has after that is not a list of the lines before it");
    step.after = v.after as number[];
  }
  const known = new Set(["kind", "instance", "key", "inputs", "message", "from", "payload", "state", "after", "line"]);
  const odd = Object.keys(v).find((k) => !known.has(k));
  if (odd) throw new LogError(line, `has ${JSON.stringify(odd)}, which a log event does not: it has instance, key, and maybe kind, inputs, message, from, payload, state, after`);
  return step;
}

/** A message named as a log would: its id (`Buy`), its key (`message:Buy`), or its name in words (`buy`). */
function messageKey(name: string, line: number, spec: Spec): string {
  const info = Object.values(spec.messages).find((m) => m.key === name || m.id === name || m.name === name);
  if (!info) throw new LogError(line, `names message ${name}, which is not one of ${spec.name}'s: ${Object.values(spec.messages).map((m) => m.id).join(", ")}`);
  return info.key;
}

function text(v: unknown, line: number, field: string): string {
  if (typeof v !== "string" || !v) throw new LogError(line, `has no ${field}: it is a string`);
  return v;
}

function record(v: unknown, line: number, field: string): Record<string, unknown> {
  if (!isRecord(v)) throw new LogError(line, `has ${field} that is not an object`);
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A log the spec cannot read: at a line (`line 3 …`), at a span, or (`at` empty) about the whole. */
export class LogError extends Error {
  constructor(
    readonly line: number,
    readonly what: string,
    at?: string,
  ) {
    super(at === "" ? what : `${at ?? `line ${line}`} ${what}`);
  }
}

// Following a log -----------------------------------------------------------------------------------

interface Node {
  world: World;
  /** The steps matched, one bit each, by their place among the log's steps. */
  done: bigint;
  matched: number;
  gap: number;
  parent: number;
  choice?: Choice;
  line?: number;
}

/** Whether a log is a run of the spec, and the reading that says so, or where it leaves the spec. */
export function conform(spec: Spec, log: LogEvent[], options: ConformOptions = {}): Conformance {
  const gap = options.gap ?? DEFAULT_GAP;
  const maxStates = options.maxStates ?? MAX_STATES;
  const unlogged = new Set(options.unlogged ?? []);
  for (const name of unlogged) actorNamed(spec, name);
  // Spawns come first (parseLog): they make the world the log starts in.
  const counts = Object.fromEntries(spec.actors.filter((a) => !a.singleton).map((a) => [a.name, options.instances?.[a.name] ?? 0]));
  let initial = initialWorld(spec, { instances: counts });
  const spawns = log.filter((e): e is LogSpawn => e.kind === "spawn");
  for (const s of spawns) initial = spawn(spec, initial, s.actor, s.label).world;
  const steps = log.filter((e): e is LogStep => e.kind !== "spawn");
  for (const s of steps) checkNames(spec, initial, s);

  const hidden = (world: World, c: Choice) => isHidden(spec, world, c, options.logsFaults === true, unlogged);
  // What must come before each step: the one before it, or (a partial order) the ones it names.
  const partial = steps.some((s) => s.after !== undefined);
  const placeOf = new Map(steps.map((s, i) => [s.line, i]));
  const before = steps.map((s, i): number[] => (partial ? (s.after ?? []).map((line) => placeOf.get(line)!).filter((j) => j !== undefined) : i > 0 ? [i - 1] : []));
  const bit = (i: number) => 1n << BigInt(i);
  /** The steps that may be matched next: not yet, and everything before them has been. */
  const ready = (done: bigint, matched: number) => {
    // In order, the next is the one after those matched.
    if (!partial) return matched < steps.length ? [matched] : [];
    const out: number[] = [];
    for (let i = 0; i < steps.length; i++) if (!(done & bit(i)) && before[i]!.every((j) => done & bit(j))) out.push(i);
    return out;
  };
  const nodes: Node[] = [{ world: initial, done: 0n, matched: 0, gap: 0, parent: -1 }];
  const seen = new Set<string>([`0|0|${canonical(initial)}`]);
  let furthest = 0;
  let done = -1;
  for (let at = 0; at < nodes.length && done < 0; at++) {
    const node = nodes[at]!;
    if (node.matched > nodes[furthest]!.matched) furthest = at;
    if (node.matched === steps.length) {
      done = at;
      break;
    }
    if (nodes.length > maxStates) break;
    const add = (world: World, done: bigint, matched: number, g: number, choice: Choice, line?: number) => {
      const key = `${done.toString(36)}|${g}|${canonical(world)}`;
      if (seen.has(key)) return;
      seen.add(key);
      nodes.push({ world, done, matched, gap: g, parent: at, choice, line });
    };
    for (const i of ready(node.done, node.matched)) {
      const want = steps[i]!;
      for (const c of candidates(spec, node.world, want)) {
        const step = safely(() => apply(spec, node.world, c, QUIET));
        if (!step || step.event.error) continue;
        if (matches(spec, node.world, want, step.event, step.world)) add(step.world, node.done | bit(i), node.matched + 1, 0, c, want.line);
      }
    }
    if (node.gap < gap)
      for (const c of branches(spec, node.world)) {
        if (!hidden(node.world, c)) continue;
        const step = safely(() => apply(spec, node.world, c, QUIET));
        if (!step || step.event.error) continue;
        add(step.world, node.done, node.matched, node.gap + 1, c);
      }
  }

  const pathTo = (at: number) => {
    const out: { choice: Choice; line?: number }[] = [];
    for (let n = at; nodes[n]!.parent >= 0; n = nodes[n]!.parent) out.unshift({ choice: nodes[n]!.choice!, line: nodes[n]!.line });
    return out;
  };
  const runOf = (at: number) => {
    const path = pathTo(at);
    return { run: replay(spec, initial, path.map((p) => p.choice)), lines: path.map((p) => p.line) };
  };
  if (done >= 0) {
    const { run, lines } = runOf(done);
    return { conforms: true, run, lines, broken: brokenOn(spec, run), states: nodes.length };
  }
  const { run, lines } = runOf(furthest);
  if (nodes.length > maxStates) return { conforms: false, stop: { kind: "limit", states: nodes.length }, run, lines, states: nodes.length };
  const world = run.worlds.at(-1) ?? run.initial;
  // Of the steps that could come next, the first in the log: the one a person reads on to.
  const want = steps[ready(nodes[furthest]!.done, nodes[furthest]!.matched)[0]!]!;
  return { conforms: false, stop: { kind: "mismatch", line: want, ...whatCould(spec, world, want) }, run, lines, states: nodes.length };
}

/** A log step's names must be ones the spec has: an instance, and an action or step of its actor. */
function checkNames(spec: Spec, world: World, s: LogStep): void {
  const instance = world.instances.find((i) => i.id === s.instance || i.label === s.instance);
  if (!instance) throw new LogError(s.line, `is about ${s.instance}, who is not there: the instances are ${world.instances.map((i) => i.label).join(", ")}; spawn the others first (in a trace, give a span of theirs feynman.actor), or pass --instances`, s.at);
  const actor = actorNamed(spec, instance.actor);
  if (!actor.actions[s.key] && !actor.transitions[s.key]) throw new LogError(s.line, `has ${instance.label} take ${s.key}, which ${actor.name} has no action or step named: it has ${[...Object.keys(actor.actions), ...Object.keys(actor.transitions)].join(", ")}`, s.at);
  if (s.from && !world.instances.some((i) => i.id === s.from || i.label === s.from)) throw new LogError(s.line, `has a message from ${s.from}, who is not there`, s.at);
}

/** The choices that may be a log step: its instance taking its action or step, the ones that can be taken now. */
function candidates(spec: Spec, world: World, want: LogStep): Choice[] {
  const instance = world.instances.find((i) => i.id === want.instance || i.label === want.instance)!;
  const actor = actorNamed(spec, instance.actor);
  const action = actor.actions[want.key];
  if (action) {
    if (want.kind && want.kind !== "action") return [];
    if (!choices(spec, world).actions.some((a) => a.instance === instance.id && a.key === want.key)) return [];
    // The log's inputs, as logged: they need not be among the values the checker tries.
    const combos = want.inputs ? [want.inputs] : inputCombinations(spec, world, action.inputs);
    return combos.map((inputs) => ({ kind: "act", instance: instance.id, key: want.key, inputs }));
  }
  // A step on a message takes one in flight; a timer fires one that is set; a guard runs while its when holds.
  const out: Choice[] = [];
  const transition = actor.transitions[want.key]!;
  for (const p of world.pending) {
    if (p.to !== instance.id) continue;
    if (p.kind === "deliver" ? p.message === transition.message && stepsTaking(spec, world, p).includes(want.key) : p.timer === want.key) out.push({ kind: "fire", pending: p.id, step: want.key });
  }
  if (!transition.message && choices(spec, world).guards.some((g) => g.instance === instance.id && g.key === want.key)) out.push({ kind: "guard", instance: instance.id, key: want.key });
  return out;
}

/** Whether a step is one the log does not show: a fault (unless faults are logged), or a step of an actor it does not log. */
function isHidden(spec: Spec, world: World, c: Choice, logsFaults: boolean, unlogged: Set<string>): boolean {
  const id = c.kind === "fire" ? world.pending.find((p) => p.id === c.pending)!.to : c.instance;
  const actor = actorNamed(spec, world.instances.find((i) => i.id === id)!.actor);
  if (unlogged.has(actor.name)) return true;
  if (logsFaults) return false;
  const key = c.kind === "fire" ? c.step : c.key;
  const step = actor.actions[key] ?? actor.transitions[key];
  return step?.tags.includes("fault") === true;
}

/** Whether the event a step made is the one the log says. */
function matches(spec: Spec, before: World, want: LogStep, event: Event, after: World): boolean {
  if (want.kind && want.kind !== event.kind) return false;
  if (want.inputs && sortedJson(want.inputs) !== sortedJson(event.inputs ?? {})) return false;
  if (want.message && want.message !== event.message) return false;
  if (want.from && !names(before, event.from, want.from)) return false;
  if ("payload" in want && sortedJson(want.payload) !== sortedJson(event.payload)) return false;
  if (want.state) {
    const instance = after.instances.find((i) => i.id === event.instance)!;
    if (!within(want.state, plain(instance.state))) return false;
  }
  return true;
}

/** Whether `name` is the id or label of the instance with id `id`. */
function names(world: World, id: string | undefined, name: string): boolean {
  const instance = world.instances.find((i) => i.id === id);
  return !!instance && (instance.id === name || instance.label === name);
}

/** A state as JSON sees it: sets and maps as sortedJson writes them. */
function plain(value: unknown): unknown {
  return JSON.parse(sortedJson(value));
}

/** Whether every field the pattern names is in the value, as given; arrays and other values whole. */
function within(pattern: unknown, value: unknown): boolean {
  if (isRecord(pattern) && isRecord(value)) return Object.entries(pattern).every(([k, v]) => k in value && within(v, value[k]));
  return sortedJson(pattern) === sortedJson(value);
}

/**
 * What the spec could do where the log leaves it: every step it could take (`could`), the ones
 * by the instance the log names with the same name but another message, sender, payload or
 * state (`near`), and errors the logged step meets in the spec.
 */
function whatCould(spec: Spec, world: World, want: LogStep): { could: string[]; near: string[]; errors: string[] } {
  const could: string[] = [];
  const near: string[] = [];
  const errors: string[] = [];
  const instance = world.instances.find((i) => i.id === want.instance || i.label === want.instance);
  for (const c of branches(spec, world)) {
    const step = safely(() => apply(spec, world, c, QUIET));
    if (!step) continue;
    const e = step.event;
    const said = describeEvent(world, e, step.world);
    if (e.instance === instance?.id && e.key === want.key) {
      if (e.error) errors.push(e.error);
      else near.push(said);
    } else if (!e.error) could.push(said);
  }
  return { could, near, errors };
}

/** An event as a log line would put it: who, what, and with which message, inputs or payload. */
export function describeEvent(before: World, e: Event, after?: World): string {
  const label = (id?: string) => before.instances.find((i) => i.id === id)?.label ?? id;
  const parts = [`${label(e.instance)} ${e.key}`];
  if (e.kind === "action" && e.inputs && Object.keys(e.inputs).length) parts.push(sortedJson(e.inputs));
  if (e.kind === "deliver") parts.push(`${e.message?.replace(/^message:/, "")} ${sortedJson(e.payload)} from ${label(e.from)}`);
  const state = after?.instances.find((i) => i.id === e.instance)?.state;
  if (after && state !== undefined) parts.push(`→ ${sortedJson(state)}`);
  return parts.join("  ");
}

/** The properties the run breaks, each at the first event that does: `always`, `everyStep` and `never`. */
function brokenOn(spec: Spec, run: Counterexample): LogBreak[] {
  const out: LogBreak[] = [];
  const broken = new Set<string>();
  const note = (id: string, at: number) => {
    if (broken.has(id)) return;
    broken.add(id);
    out.push({ id, description: spec.properties.find((p) => p.id === id)!.description, at });
  };
  for (const p of spec.properties) if (p.kind === "always" && !holdsIn(spec, run.initial, p.always)) note(p.id, -1);
  run.events.forEach((event, i) => {
    const before = i === 0 ? run.initial : run.worlds[i - 1]!;
    for (const id of event.violations) note(id, i);
    for (const id of stepBreaks(spec, before, run.worlds[i]!, event, broken)) note(id, i);
    for (const p of spec.properties) if (p.kind === "never" && !broken.has(p.id) && safely(() => p.never(traceView(run.events.slice(0, i + 1))))) note(p.id, i);
  });
  return out;
}
