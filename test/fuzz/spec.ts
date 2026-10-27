// Random specs for fuzzing the checker: each seed gives one, built from a description that is
// plain data (so a failure can be printed and replayed), through the DSL like any spec.
//
// Specs are small but use every part of the language the checker treats specially: actors
// that are singletons or many (and sometimes declared symmetric), actions with inputs,
// message handlers, replies, timers started and cancelled, guards, reading other instances,
// shared counters (fresh ids, random numbers), durable fields across restarts, steps that
// throw, final states, and every kind of property.
import { defineSpec, message, type Spec } from "../../src/spec/index.ts";

type Random = () => number;

/** A predicate on one instance's state. */
type Cond = { kind: "true" } | { kind: "aIs"; k: number } | { kind: "aBelow"; k: number } | { kind: "b"; is: boolean };

/** What a step does, in order. */
type Op =
  | { kind: "inc" }
  | { kind: "set"; k: number }
  | { kind: "flip" }
  | { kind: "fromPayload" }
  | { kind: "fromInput" }
  | { kind: "send"; message: number; to: number; all: boolean; value: "a" | "const" | "input"; k: number }
  | { kind: "reply"; message: number }
  | { kind: "start"; timer: number }
  | { kind: "cancel"; timer: number }
  | { kind: "readOthers"; actor: number }
  | { kind: "random" }
  | { kind: "fresh" }
  | { kind: "throwIf"; k: number }
  | { kind: "if"; cond: Cond; then: Op[] };

interface ActorDesc {
  name: string;
  singleton: boolean;
  count: number;
  symmetric: boolean;
  cap: number;
  durable: boolean;
  actions: { key: string; when: Cond; input: boolean; ops: Op[] }[];
  handlers: { message: number; ops: Op[]; fair?: Fair }[];
  timers: { key: string; ops: Op[]; fair?: Fair }[];
  guards: { key: string; when: Cond; ops: Op[]; fair?: Fair }[];
}

/** A transition's fairness, when not the default (weak). */
type Fair = "strong" | false;

/** A predicate on the world: some or every instance of an actor meets a condition. */
type WorldCond = { actor: number; every: boolean; cond: Cond; quiet?: boolean };

type PropDesc =
  | { kind: "always"; not: WorldCond }
  | { kind: "never"; actor: number; step: string; times: number }
  | { kind: "everyStep"; actor: number }
  | { kind: "eventually"; cond: WorldCond }
  | { kind: "leadsTo"; whenever: WorldCond; then: WorldCond }
  | { kind: "infinitelyOften"; cond: WorldCond }
  | { kind: "eventuallyAlways"; cond: WorldCond };

export interface SpecDesc {
  seed: number;
  messages: number;
  actors: ActorDesc[];
  properties: PropDesc[];
  final?: WorldCond;
  bounds: { depth: number; faults: number; repeats: number; instances: Record<string, number> };
}

/** Small specs check quickly; big ones have deeper bounds, more instances and more steps, so more interleavings. */
export type Size = "small" | "big";

export function describe(seed: number, size: Size = "small"): SpecDesc {
  const big = size === "big";
  const random = seeded(seed);
  const int = (n: number) => Math.floor(random() * n);
  const chance = (p: number) => random() < p;
  const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)];
  const messages = 1 + int(3);
  const actorCount = 1 + int(3);
  const timersOf: number[] = [];
  const cond = (cap: number): Cond => pick<Cond>([{ kind: "true" }, { kind: "aIs", k: int(cap) }, { kind: "aBelow", k: 1 + int(cap - 1) }, { kind: "b", is: chance(0.5) }]);
  const actors: ActorDesc[] = Array.from({ length: actorCount }, (_, i) => {
    const singleton = chance(0.4);
    const count = singleton ? 1 : 1 + int(3) + (big && chance(0.3) ? 1 : 0);
    timersOf.push(int(3));
    return { name: `Actor${i}`, singleton, count, symmetric: !singleton && count > 1 && chance(0.5), cap: 2 + int(2), durable: chance(0.3), actions: [], handlers: [], timers: [], guards: [] };
  });
  // Who handles each message, decided first so sends mostly go where they are handled; a
  // message nobody handles is a spec error, and every message has a handler somewhere.
  const handledBy = Array.from({ length: messages }, () => {
    const owners = actors.map((_, i) => i).filter(() => chance(0.6));
    return owners.length ? owners : [int(actorCount)];
  });
  const target = (m: number) => (chance(0.85) ? pick(handledBy[m]) : int(actorCount));
  const fair = (): { fair?: Fair } => (chance(0.8) ? {} : { fair: pick<Fair>(["strong", false]) });
  const ops = (actor: number, where: "action" | "handler" | "timer" | "guard", depth = 0): Op[] => {
    const a = actors[actor];
    const out: Op[] = [];
    for (let n = 1 + int(3); n > 0; n--) {
      const roll = int(100);
      if (roll < 18) out.push({ kind: "inc" });
      else if (roll < 26) out.push({ kind: "set", k: int(a.cap) });
      else if (roll < 36) out.push({ kind: "flip" });
      else if (roll < 42 && where === "handler") out.push({ kind: "fromPayload" });
      else if (roll < 46 && where === "action") out.push({ kind: "fromInput" });
      else if (roll < 66) {
        const m = int(messages);
        out.push({ kind: "send", message: m, to: target(m), all: chance(0.4), value: pick(["a", "const", ...(where === "action" ? (["input"] as const) : [])]), k: int(2) });
      }
      else if (roll < 71 && where === "handler") out.push({ kind: "reply", message: int(messages) });
      else if (roll < 77 && timersOf[actor] > 0) out.push({ kind: "start", timer: int(timersOf[actor]) });
      else if (roll < 80 && timersOf[actor] > 0) out.push({ kind: "cancel", timer: int(timersOf[actor]) });
      else if (roll < 85) out.push({ kind: "readOthers", actor: int(actorCount) });
      else if (roll < 88) out.push({ kind: "random" });
      else if (roll < 90) out.push({ kind: "fresh" });
      else if (roll < 92) out.push({ kind: "throwIf", k: int(a.cap) });
      else if (depth === 0) out.push({ kind: "if", cond: cond(a.cap), then: ops(actor, where, 1) });
    }
    return out;
  };
  actors.forEach((a, i) => {
    a.actions = Array.from({ length: int(big ? 4 : 3) }, (_, n) => ({ key: `act${n}`, when: cond(a.cap), input: chance(0.3), ops: ops(i, "action") }));
    a.timers = Array.from({ length: timersOf[i] }, (_, n) => ({ key: `timer${n}`, ops: ops(i, "timer"), ...fair() }));
    a.guards = chance(0.3) ? [{ key: "guard0", when: { kind: "aIs", k: int(a.cap) }, ops: [{ kind: "inc" }, ...ops(i, "guard").filter((o) => o.kind !== "inc" && o.kind !== "set")], ...fair() }] : [];
  });
  handledBy.forEach((owners, m) => {
    for (const i of owners) actors[i].handlers.push({ message: m, ops: ops(i, "handler"), ...fair() });
  });
  // Something must happen: at least one action.
  if (!actors.some((a) => a.actions.length)) actors[0].actions.push({ key: "act0", when: { kind: "true" }, input: false, ops: ops(0, "action") });
  const worldCond = (): WorldCond => {
    const actor = int(actorCount);
    return { actor, every: chance(0.5), cond: cond(actors[actor].cap), ...(chance(0.3) ? { quiet: true } : {}) };
  };
  const properties: PropDesc[] = [];
  for (let n = 1 + int(3); n > 0; n--) {
    const roll = int(100);
    const actor = int(actorCount);
    const steps = [...actors[actor].actions.map((s) => s.key), ...actors[actor].timers.map((s) => s.key), ...actors[actor].guards.map((s) => s.key)];
    if (roll < 35) properties.push({ kind: "always", not: worldCond() });
    else if (roll < 45 && steps.length) properties.push({ kind: "never", actor, step: pick(steps), times: 1 + int(2) });
    else if (roll < 55) properties.push({ kind: "everyStep", actor });
    else if (roll < 67) properties.push({ kind: "eventually", cond: worldCond() });
    else if (roll < 82) properties.push({ kind: "leadsTo", whenever: worldCond(), then: worldCond() });
    else if (roll < 91) properties.push({ kind: "infinitelyOften", cond: worldCond() });
    else properties.push({ kind: "eventuallyAlways", cond: worldCond() });
  }
  return {
    seed,
    messages,
    actors,
    properties,
    ...(chance(0.3) ? { final: worldCond() } : {}),
    bounds: { depth: big ? 7 + int(6) : 4 + int(5), faults: chance(0.6) ? 0 : 1, repeats: 1 + int(2), instances: Object.fromEntries(actors.filter((a) => !a.singleton).map((a) => [a.name, a.count])) },
  };
}

/** The spec a description stands for. */
export function build(desc: SpecDesc): Spec {
  const messageDefs = Object.fromEntries(Array.from({ length: desc.messages }, (_, m) => [`M${m}`, message<{ v: number }>({ name: `m${m}` })]));
  return defineSpec(`Fuzz ${desc.seed}`, { messages: messageDefs }, (spec) => {
    const zone = spec.defineZone({ name: "Zone" });
    const actors: any[] = [];
    const holds = (c: Cond, s: any) => (c.kind === "true" ? true : c.kind === "aIs" ? s.a === c.k : c.kind === "aBelow" ? s.a < c.k : s.b === c.is);
    const messageKey = (m: number): string => (spec.messages as Record<string, string>)[`M${m}`];
    const sendsOf = (ops: Op[]): string[] => [...new Set(ops.flatMap((o) => (o.kind === "send" || o.kind === "reply" ? [messageKey(o.message)] : o.kind === "if" ? sendsOf(o.then) : [])))];
    const startsOf = (ops: Op[]): string[] => [...new Set(ops.flatMap((o) => (o.kind === "start" ? [`timer${o.timer}`] : o.kind === "if" ? startsOf(o.then) : [])))];
    const runOps = (a: ActorDesc, ops: Op[], state: any, ctx: any, extra: { payload?: number; input?: number }) => {
      for (const op of ops) {
        switch (op.kind) {
          case "inc":
            state.a = (state.a + 1) % a.cap;
            break;
          case "set":
            state.a = op.k;
            break;
          case "flip":
            state.b = !state.b;
            break;
          case "fromPayload":
            state.a = (extra.payload ?? 0) % a.cap;
            break;
          case "fromInput":
            state.a = (extra.input ?? 0) % a.cap;
            break;
          case "send": {
            const target = actors[op.to];
            const v = op.value === "a" ? state.a : op.value === "input" ? (extra.input ?? 0) : op.k;
            const to = op.all || !desc.actors[op.to].singleton ? ctx.all(target) : [ctx.the(target)];
            for (const t of to) ctx.send(t, messageKey(op.message), { v });
            break;
          }
          case "reply":
            if (ctx.from) ctx.reply(messageKey(op.message), { v: state.a });
            break;
          case "start":
            ctx.start(`timer${op.timer}`);
            break;
          case "cancel":
            ctx.cancel(`timer${op.timer}`);
            break;
          case "readOthers":
            state.a = Math.max(0, ...ctx.all(actors[op.actor]).map((i: any) => i.state.a)) % a.cap;
            break;
          case "random":
            state.b = ctx.random() < 0.5;
            break;
          case "fresh":
            state.tag = ctx.fresh("t");
            break;
          case "throwIf":
            if (state.a === op.k && state.b) throw new Error(`boom at ${op.k}`);
            break;
          case "if":
            if (holds(op.cond, state)) runOps(a, op.then, state, ctx, extra);
            break;
        }
      }
    };
    for (const a of desc.actors) {
      const transitions: Record<string, unknown> = {};
      const fairOf = (x: { fair?: Fair }) => (x.fair === undefined ? {} : { fair: x.fair });
      for (const h of a.handlers) transitions[messageKey(h.message)] = { description: `handles M${h.message}`, ...fairOf(h), sends: sendsOf(h.ops), starts: startsOf(h.ops), run: (state: any, msg: any, ctx: any) => runOps(a, h.ops, state, ctx, { payload: msg.v }) };
      for (const t of a.timers) transitions[t.key] = { description: t.key, after: "1 second", ...fairOf(t), sends: sendsOf(t.ops), starts: startsOf(t.ops), run: (state: any, ctx: any) => runOps(a, t.ops, state, ctx, {}) };
      for (const g of a.guards) transitions[g.key] = { description: g.key, ...fairOf(g), when: (s: any) => holds(g.when, s), sends: sendsOf(g.ops), starts: startsOf(g.ops), run: (state: any, ctx: any) => runOps(a, g.ops, state, ctx, {}) };
      const actions = Object.fromEntries(
        a.actions.map((x) => [
          x.key,
          {
            label: x.key,
            description: x.key,
            when: (s: any) => holds(x.when, s),
            ...(x.input ? { inputs: { n: { type: [0, 1] as const } } } : {}),
            sends: sendsOf(x.ops),
            starts: startsOf(x.ops),
            run: (state: any, inputs: any, ctx: any) => runOps(a, x.ops, state, ctx, { input: inputs?.n }),
          },
        ]),
      );
      actors.push(
        (spec as any).defineActor({
          name: a.name,
          zone,
          singleton: a.singleton,
          symmetric: a.symmetric,
          initialState: () => ({ a: 0, b: false, tag: "" }),
          ...(a.durable ? { durable: ["a"] } : {}),
          actions,
          transitions,
        }),
      );
    }
    const worldHolds = (c: WorldCond, w: any) => {
      if (c.quiet && !w.quiet) return false;
      const all = w.all(actors[c.actor]);
      return c.every ? all.every((i: any) => holds(c.cond, i.state)) : all.some((i: any) => holds(c.cond, i.state));
    };
    const properties: Record<string, unknown> = {};
    desc.properties.forEach((p, n) => {
      const id = `p${n}_${p.kind}`;
      switch (p.kind) {
        case "always":
          properties[id] = { description: id, always: (w: any) => !worldHolds(p.not, w) };
          break;
        case "never":
          properties[id] = { description: id, never: (t: any) => t.count((e: any) => e.is(actors[p.actor], p.step)) > p.times };
          break;
        case "everyStep":
          // The number of the actor's instances with `b` set never drops by more than one in a step.
          properties[id] = { description: id, everyStep: (before: any, after: any) => after.all(actors[p.actor]).filter((i: any) => i.state.b).length >= before.all(actors[p.actor]).filter((i: any) => i.state.b).length - 1 };
          break;
        case "eventually":
          properties[id] = { description: id, eventually: (w: any) => worldHolds(p.cond, w) };
          break;
        case "leadsTo":
          properties[id] = { description: id, leadsTo: { whenever: (w: any) => worldHolds(p.whenever, w), then: (w: any) => worldHolds(p.then, w) } };
          break;
        case "infinitelyOften":
          properties[id] = { description: id, infinitelyOften: (w: any) => worldHolds(p.cond, w) };
          break;
        case "eventuallyAlways":
          properties[id] = { description: id, eventuallyAlways: (w: any) => worldHolds(p.cond, w) };
          break;
      }
    });
    (spec as any).defineProperties(properties);
    if (desc.final) (spec as any).defineFinalState({ description: "final", when: (w: any) => worldHolds(desc.final!, w) });
    return {};
  });
}

function seeded(seed: number): Random {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0) / 2 ** 32);
}
