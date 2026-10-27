// Liveness, step properties and stuck worlds on systems small enough to work out by hand:
// what is fair (messages, timers and guards; never actions or faults), weak against strong,
// the loop a counterexample ends with, and when a verdict is unfinished.
import { brokenIn } from "../helpers.ts";
import { expect, test } from "bun:test";
import { check, type Report } from "../../src/check/index.ts";
import { defineSpec, message, type Event, type Spec } from "../../src/spec/index.ts";
import { explore } from "./reference.ts";

const BOUNDS = { depth: 20, faults: 0, walks: 0, maxStates: 100_000, timeLimit: 30_000 };

function verdict(report: Report, id: string) {
  const p = report.properties.find((x) => x.id === id)!;
  if (p.holds) return p.unfinished ? "unfinished" : "holds";
  const keys = (events: Event[]) => events.map((e) => e.key.replace("message:", ""));
  return { events: keys(p.counterexample.events), loop: keys(p.loop!.events) };
}

/** The reference explorer's liveness verdict, to agree with. */
function reference(spec: Spec, id: string) {
  return explore(spec, { depth: BOUNDS.depth, faults: 0, repeats: 2, instances: {} }).liveness.get(id);
}

/** A door someone may open, and a property that it opens, with or without a final state. */
function door(final: boolean) {
  return defineSpec("Door", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Hall" });
    const Door = spec.defineActor({
      name: "Door",
      zone,
      singleton: true,
      initialState: () => ({ open: false }),
      actions: { open: { label: "Open", description: "Someone opens the door.", when: (s) => !s.open, run: (s) => void (s.open = true) } },
    });
    if (final) spec.defineFinalState({ description: "The door is open.", when: (w) => w.the(Door).state.open });
    spec.defineProperties({ opens: { description: "The door opens.", eventually: (w) => w.the(Door).state.open } });
    return { Door };
  });
}

test("actions are not fair: nobody has to open the door, so it may stay shut forever", () => {
  const report = check(door(true), BOUNDS);
  expect(verdict(report, "opens")).toEqual({ events: [], loop: [] });
  expect(reference(door(true), "opens")).toBe("broken");
});

test("a world where nothing can happen is stuck, unless the spec calls it final", () => {
  expect(check(door(true), BOUNDS).stuck).toBeUndefined();
  const stuck = check(door(false), BOUNDS).stuck!;
  expect(stuck.counterexample.events.map((e) => e.key)).toEqual(["open"]);
});

/** A ping that, once sent, may or may not have to arrive. */
function ping(fair: false | undefined) {
  return defineSpec("Ping", { messages: { Ping: message<{}>({ name: "ping" }) } }, (spec) => {
    const zone = spec.defineZone({ name: "Net" });
    const Receiver = spec.defineActor({
      name: "Receiver",
      zone,
      singleton: true,
      initialState: () => ({ got: false }),
      transitions: { [spec.messages.Ping]: { description: "Gets it.", fair, run: (s) => void (s.got = true) } },
    });
    const Sender = spec.defineActor({
      name: "Sender",
      zone,
      singleton: true,
      initialState: () => ({ sent: false }),
      actions: { send: { label: "Send", description: "Sends a ping.", when: (s) => !s.sent, sends: [spec.messages.Ping], run: (s, _i, ctx) => void ((s.sent = true), ctx.send(ctx.the(Receiver), spec.messages.Ping, {})) } },
    });
    spec.defineFinalState({ description: "Nothing left to send.", when: (w) => w.the(Sender).state.sent });
    spec.defineProperties({
      arrives: { description: "A ping sent arrives.", leadsTo: { whenever: (w) => w.the(Sender).state.sent, then: (w) => w.the(Receiver).state.got } },
    });
    return { Sender, Receiver };
  });
}

test("a message in flight is delivered, unless its step says it need not be", () => {
  expect(verdict(check(ping(undefined), BOUNDS), "arrives")).toBe("holds");
  expect(check(ping(undefined), BOUNDS).properties[0].tested).toBe(1);
  expect(verdict(check(ping(false), BOUNDS), "arrives")).toEqual({ events: ["send"], loop: [] });
  expect(reference(ping(undefined), "arrives")).toBe("holds");
  expect(reference(ping(false), "arrives")).toBe("broken");
});

/** A light that keeps flipping, and a prize to take while it is on. */
function light(win: "weak" | "strong" | null) {
  return defineSpec("Light", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Room" });
    const Light = spec.defineActor({
      name: "Light",
      zone,
      singleton: true,
      initialState: () => ({ on: false, won: false }),
      transitions: {
        flip: { description: "Flips.", when: (s) => !s.won, run: (s) => void (s.on = !s.on) },
        ...(win ? { win: { description: "Takes the prize while on.", fair: win, when: (s: { on: boolean; won: boolean }) => s.on && !s.won, run: (s: { won: boolean }) => void (s.won = true) } } : {}),
      },
    });
    spec.defineFinalState({ description: "The prize is taken.", when: (w) => w.the(Light).state.won });
    spec.defineProperties({
      wins: { description: "The prize is taken.", eventually: (w) => w.the(Light).state.won },
      onAgain: { description: "The light is on again and again.", infinitelyOften: (w) => w.the(Light).state.on || w.the(Light).state.won },
      settles: { description: "The light ends up off for good.", eventuallyAlways: (w) => !w.the(Light).state.on },
    });
    return { Light };
  });
}

test("weak fairness lets a step possible only on and off wait forever; strong fairness does not", () => {
  expect(verdict(check(light("weak"), BOUNDS), "wins")).toEqual({ events: [], loop: ["flip", "flip"] });
  expect(verdict(check(light("strong"), BOUNDS), "wins")).toBe("holds");
  expect(reference(light("weak"), "wins")).toBe("broken");
  expect(reference(light("strong"), "wins")).toBe("holds");
});

test("infinitelyOften and eventuallyAlways: a light that flips forever is on again and again, and never settles", () => {
  const report = check(light(null), BOUNDS);
  expect(verdict(report, "onAgain")).toBe("holds");
  expect(verdict(report, "settles")).toEqual({ events: [], loop: ["flip", "flip"] });
  expect(reference(light(null), "onAgain")).toBe("holds");
  expect(reference(light(null), "settles")).toBe("broken");
});

/** A counter that counts up for ever, and someone who may reset it. */
function counter() {
  return defineSpec("Counter", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Box" });
    const Counter = spec.defineActor({
      name: "Counter",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: { reset: { label: "Reset", description: "Someone resets it.", run: (s) => void (s.n = 0) } },
      transitions: { tick: { description: "Counts.", when: () => true, run: (s) => void s.n++ } },
    });
    spec.defineProperties({
      neverDown: { description: "The count never goes down.", everyStep: (before, after) => after.the(Counter).state.n >= before.the(Counter).state.n },
      negative: { description: "The count goes below zero.", eventually: (w) => w.the(Counter).state.n < 0 },
    });
    return { Counter };
  });
}

test("everyStep judges each step, with the worlds on both sides", () => {
  const report = check(counter(), BOUNDS);
  expect(brokenIn(report, "neverDown").counterexample.events.map((e) => e.key)).toEqual(["tick", "reset"]);
});

test("a loop that may lie past the depth bound leaves the verdict unfinished", () => {
  expect(verdict(check(counter(), BOUNDS), "negative")).toBe("unfinished");
  expect(reference(counter(), "negative")).toBe("unfinished");
});
