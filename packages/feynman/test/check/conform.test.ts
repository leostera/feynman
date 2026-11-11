// Checking logs against a spec (RFD0016). A log is a run of the spec when some path through it
// shows the log's events, in order, with at most `gap` unlogged steps between two logged ones.
// The reference here shares nothing with conform but the engine: it lists every path up to a
// length, without merging worlds, writes each as the log it would leave, and the logs conform
// must accept are exactly those.
import { expect, test } from "bun:test";
import { conform, LogError, parseLog, type LogEvent } from "../../src/check/conform.ts";
import { apply, branches, initialWorld, QUIET } from "../../src/check/index.ts";
import { seeded } from "../../src/check/walk.ts";
import { scenarioCode } from "../../src/cli/scenario-code.ts";
import { runScenario, type Event, type Spec, type World } from "../../src/spec/index.ts";
import { alternatingBit } from "../../examples/alternating-bit.ts";
import { orderedWrites } from "../../examples/ordered-writes.ts";
import { payments } from "../../examples/payments.ts";
import { twoPhaseCommit } from "../../examples/two-phase-commit.ts";
import { compile } from "../cli/compile.ts";

/** An event as a log line: who, what, and with which inputs, message, sender and payload. */
function lineOf(world: World, e: Event): Record<string, unknown> {
  const label = (id?: string) => world.instances.find((i) => i.id === id)?.label;
  return { kind: e.kind, instance: label(e.instance), key: e.key, ...(e.kind === "action" ? { inputs: e.inputs ?? {} } : {}), ...(e.kind === "deliver" ? { message: e.message, from: label(e.from), payload: e.payload } : {}) };
}

const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n");
const isFault = (e: Event) => e.tags?.includes("fault") === true;

/** Every log some path of up to `length` steps leaves, faults unlogged, with at most `gap` of them in a row. */
function logsOf(spec: Spec, length: number, gap: number): Set<string> {
  const out = new Set<string>();
  const walk = (world: World, logged: string[], run: number, left: number) => {
    out.add(logged.join("\n"));
    if (!left) return;
    for (const c of branches(spec, world)) {
      const step = apply(spec, world, c, QUIET);
      if (step.event.error) continue;
      if (isFault(step.event)) {
        if (run < gap) walk(step.world, logged, run + 1, left - 1);
      } else walk(step.world, [...logged, JSON.stringify(lineOf(world, step.event))], 0, left - 1);
    }
  };
  walk(initialWorld(spec, { instances: {} }), [], 0, length);
  return out;
}

test("the logs conform accepts are the logs of the spec's paths, on a network that reorders and one that keeps order", () => {
  for (const [variant, faults] of [["buggy", 0], ["fixed", 0], ["fixed", 1], ["buggy", 1]] as const) {
    const spec = orderedWrites(variant).setting({ faults });
    const gap = 1;
    const theirs = logsOf(spec, 7, gap);
    // Every log of a path conforms; a log with a line changed conforms just when it is another path's.
    const lines = [...new Set([...theirs].flatMap((l) => l.split("\n")).filter(Boolean))];
    let checked = 0;
    for (const log of theirs) {
      const events = log ? log.split("\n") : [];
      expect({ log, conforms: conform(spec, parseLog(log, spec), { gap }).conforms }).toEqual({ log, conforms: true });
      for (let at = 0; at < events.length; at++)
        for (const other of lines) {
          const changed = [...events.slice(0, at), other, ...events.slice(at + 1)].join("\n");
          // A path has at most 6 steps (three writes, each put or lost): the reference has them all.
          const r = conform(spec, parseLog(changed, spec), { gap });
          expect({ changed, conforms: r.conforms }).toEqual({ changed, conforms: theirs.has(changed) });
          checked++;
        }
    }
    expect(checked).toBeGreaterThan(100);
  }
});

test("random runs of the examples conform to their specs, faults unlogged, and conform finds them as short", () => {
  const specs = [orderedWrites("fixed").setting({ faults: 1 }), alternatingBit("buggy", "ordered"), alternatingBit("buggy"), payments("fixed"), twoPhaseCommit("fixed")];
  for (const spec of specs)
    for (let seed = 1; seed <= 30; seed++) {
      const random = seeded(seed);
      let world = initialWorld(spec, { instances: spec.name.startsWith("Two-phase") ? { Participant: 2 } : {} });
      const start = world;
      const log: unknown[] = [];
      let faults = 0;
      for (let n = 0; n < 12; n++) {
        const options = branches(spec, world).filter((c) => !apply(spec, world, c, QUIET).event.error);
        if (!options.length) break;
        const step = apply(spec, world, options[Math.floor(random() * options.length)]!, QUIET);
        if (isFault(step.event)) faults++;
        // Some lines say the state after too, which must then be as logged.
        else log.push({ ...lineOf(world, step.event), ...(random() < 0.3 ? { state: JSON.parse(JSON.stringify(step.world.instances.find((i) => i.id === step.event.instance)!.state)) } : {}) });
        world = step.world;
      }
      const r = conform(spec, parseLog(jsonl(log), spec), { instances: Object.fromEntries(start.instances.filter((i) => !spec.actors.find((a) => a.name === i.actor)!.singleton).map((i) => [i.actor, start.instances.filter((j) => j.actor === i.actor).length])) });
      expect({ spec: spec.name, seed, conforms: r.conforms }).toEqual({ spec: spec.name, seed, conforms: true });
      if (!r.conforms) continue;
      expect(r.lines.filter((l) => l !== undefined).length).toBe(log.length);
      // The reading has the fewest unlogged steps: no more than the run had.
      expect(r.lines.filter((l) => l === undefined).length).toBeLessThanOrEqual(faults);
    }
});

test("a log that leaves the spec says where, and what the spec could do there", () => {
  const spec = orderedWrites("fixed");
  const log = jsonl([
    { instance: "Client", key: "set", inputs: { value: "a" } },
    { instance: "Client", key: "set", inputs: { value: "b" } },
    { instance: "Store", key: "put", payload: { value: "b" } },
  ]);
  const r = conform(spec, parseLog(log, spec));
  if (r.conforms || r.stop.kind !== "mismatch") throw new Error("conforms");
  expect(r.stop.line.line).toBe(3);
  expect(r.lines).toEqual([1, 2]);
  // The store can take put, but only of a, which is ahead of b on the connection.
  expect(r.stop.near).toEqual(['Store put  Put {"value":"a"} from Client  → {"value":"a"}']);
  expect(r.stop.could).toEqual(['Client set  {"value":"a"}  → {"last":"a"}', 'Client set  {"value":"b"}  → {"last":"b"}']);
  // With a fault, the reading loses a, which the log does not show.
  const lossy = conform(orderedWrites("fixed").setting({ faults: 1 }), parseLog(log, spec));
  if (!lossy.conforms) throw new Error("does not conform");
  expect(lossy.run.events.map((e) => e.key)).toEqual(["set", "set", "putLost", "put"]);
  expect(lossy.lines).toEqual([1, 2, undefined, 3]);
});

test("a state on a line must be the instance's after the step", () => {
  const spec = orderedWrites("buggy");
  const log = (value: string) => jsonl([{ instance: "Client", key: "set", inputs: { value: "a" }, state: { last: value } }]);
  expect(conform(spec, parseLog(log("a"), spec)).conforms).toBe(true);
  expect(conform(spec, parseLog(log("b"), spec)).conforms).toBe(false);
});

test("along the log's run, the spec's properties are judged", () => {
  const spec = orderedWrites("buggy");
  const r = conform(spec, parseLog(jsonl([
    { instance: "Client", key: "set", inputs: { value: "a" } },
    { instance: "Client", key: "set", inputs: { value: "b" } },
    { instance: "Store", key: "put", payload: { value: "b" } },
    { instance: "Store", key: "put", payload: { value: "a" } },
  ]), spec));
  if (!r.conforms) throw new Error("does not conform");
  expect(r.broken.map((b) => [b.id, b.at])).toEqual([["lastWriteWins", 3]]);
});

test("the steps of an actor the log does not record are unlogged, like faults", () => {
  // Payments, logged at the bank alone: the client's and the server's steps leave no line.
  const spec = payments("fixed");
  const world = initialWorld(spec, { instances: {} });
  const scenario = spec.scenarios[0]!;
  const run = runScenario(spec, scenario);
  const bank = run.events.map((e, i) => ({ e, before: i === 0 ? run.initial : run.worlds[i - 1]! })).filter(({ e }) => e.actor === "Bank" && e.kind !== "spawn");
  expect(bank.length).toBeGreaterThan(0);
  // Who the scenario brings in, then the bank's lines.
  const spawns = run.events.filter((e) => e.kind === "spawn").map((e, i) => ({ kind: "spawn", actor: e.actor, label: run.worlds[run.events.indexOf(e)]!.instances.find((x) => x.id === e.instance)!.label, i }));
  const log = jsonl([...spawns.map(({ i: _, ...s }) => s), ...bank.map(({ e, before }) => lineOf(before, e))]);
  const others = spec.actors.map((a) => a.name).filter((a) => a !== "Bank");
  expect(world.instances.length).toBeGreaterThan(1);
  expect(conform(spec, parseLog(log, spec), { unlogged: others, gap: 8 }).conforms).toBe(true);
  expect(conform(spec, parseLog(log, spec), { gap: 8 }).conforms).toBe(false);
});

test("a log becomes a scenario that replays it, with the steps it does not show named", () => {
  const spec = orderedWrites("fixed").setting({ faults: 1 });
  const r = conform(spec, parseLog(jsonl([
    { instance: "Client", key: "set", inputs: { value: "a" } },
    { instance: "Client", key: "set", inputs: { value: "b" } },
    { instance: "Store", key: "put", payload: { value: "b" } },
  ]), spec));
  if (!r.conforms) throw new Error("does not conform");
  const code = scenarioCode(spec, { id: "log", description: "The log.", counterexample: r.run, log: "run.jsonl", notes: r.lines.map((l) => (l === undefined ? "not in the log" : `line ${l}`)) });
  expect(code).toContain('const theLog = defineScenario("The log run.jsonl", {');
  expect(code).toContain('s.step(store, "putLost"); // from client // not in the log');
  const replayed = runScenario(spec, compile(spec, "The log run.jsonl", code));
  expect(replayed.error).toBeUndefined();
  expect(replayed.events.map((e) => `${e.actor}.${e.key}`)).toEqual(r.run.events.map((e) => `${e.actor}.${e.key}`));
});

test("a log is parsed into events, or refused with its line and what is wrong", () => {
  const spec = twoPhaseCommit("fixed");
  const refused = (text: string): string => {
    try {
      parseLog(text, spec);
    } catch (error) {
      if (error instanceof LogError) return error.message;
      throw error;
    }
    return "parsed";
  };
  expect(refused("{")).toBe("line 1 is not JSON: each line of a log is one event, a JSON object");
  expect(refused('\n[1]')).toContain("line 2 is not an object");
  expect(refused('{"key":"begin"}')).toBe("line 1 has no instance: it is a string");
  expect(refused('{"instance":"Coordinator","key":"vote","message":"Ballot"}')).toBe("line 1 names message Ballot, which is not one of Two-phase commit (fixed)'s: Prepare, Vote, Decide");
  expect(refused('{"instance":"Coordinator","key":"begin","kind":"act"}')).toBe('line 1 has kind "act": a kind is spawn, action, deliver, timer, guard');
  expect(refused('{"instance":"Coordinator","key":"begin","when":3}')).toContain('line 1 has "when", which a log event does not');
  expect(refused('{"instance":"Coordinator","key":"begin"}\n{"kind":"spawn","actor":"Participant","label":"C"}')).toBe("line 2 spawns after a step: the instances a log is about are there from its start, so their spawns come first");
  expect(refused('{"kind":"spawn","actor":"Coordinator","label":"C"}')).toBe("line 1 spawns Coordinator, a singleton, which is there from the start");
  const parsed: LogEvent[] = parseLog('{"kind":"spawn","actor":"Participant","label":"A"}\n\n{"instance":"A","key":"vote","inputs":{"choice":"yes"}}\n{"instance":"Coordinator","key":"vote","message":"vote","from":"A","payload":{"yes":true}}', spec);
  expect(parsed).toEqual([
    { line: 1, kind: "spawn", actor: "Participant", label: "A" },
    { line: 3, instance: "A", key: "vote", inputs: { choice: "yes" } },
    { line: 4, instance: "Coordinator", key: "vote", message: "message:Vote", from: "A", payload: { yes: true } },
  ]);
  // Names are checked against the world the log starts in.
  expect(() => conform(spec, parseLog('{"instance":"Z","key":"vote"}', spec))).toThrow("line 1 is about Z, who is not there: the instances are Coordinator; spawn the others first (in a trace, give a span of theirs feynman.actor), or pass --instances");
  expect(() => conform(spec, parseLog('{"instance":"Coordinator","key":"fly"}', spec))).toThrow("line 1 has Coordinator take fly, which Coordinator has no action or step named");
});

test("a log may be a partial order: it is a run when some order that keeps it is", () => {
  const spec = orderedWrites("buggy");
  const log = (afterPut: number[], afterSet: number[]) =>
    jsonl([
      { instance: "Client", key: "set", inputs: { value: "a" } },
      // Written before the write it applies: on another machine, whose clock ran ahead.
      { instance: "Store", key: "put", payload: { value: "b" }, after: afterPut },
      { instance: "Client", key: "set", inputs: { value: "b" }, after: afterSet },
    ]);
  const r = conform(spec, parseLog(log([], [1]), spec));
  if (!r.conforms) throw new Error("does not conform");
  expect(r.run.events.map((e) => `${e.key} ${JSON.stringify(e.inputs ?? e.payload)}`)).toEqual(['set {"value":"a"}', 'set {"value":"b"}', 'put {"value":"b"}']);
  expect(r.lines).toEqual([1, 3, 2]);
  // In the order written, or with the put before the second set, it is not.
  expect(conform(spec, parseLog(log([], [1]).replaceAll(/,"after":\[[\d,]*\]/g, ""), spec)).conforms).toBe(false);
  const before = conform(spec, parseLog(log([1], [1, 2]), spec));
  if (before.conforms || before.stop.kind !== "mismatch") throw new Error("conforms");
  expect(before.stop.line.line).toBe(2);
  expect(() => parseLog(jsonl([{ instance: "Client", key: "set", after: [1] }]), spec)).toThrow("line 1 has after that is not a list of the lines before it");
});
