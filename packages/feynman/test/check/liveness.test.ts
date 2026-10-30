// Liveness, step properties and stuck worlds on systems small enough to work out by hand:
// what is fair (messages, timers and guards; never actions or steps with fair: false), weak against strong,
// the loop a counterexample ends with, and when a verdict is unfinished.
import { brokenIn } from "../helpers.ts";
import { expect, test } from "bun:test";
import { check, type Report } from "../../src/check/index.ts";
import { atMost, defineActor, defineMessage, defineProperty, defineSpec, defineZone, type Event, type Spec, type WorldView } from "../../src/spec/index.ts";
import { explore } from "./reference.ts";

const BOUNDS = { depth: 20, walks: 0, maxStates: 100_000, timeLimit: 30_000 };

function verdict(report: Report, id: string) {
  const p = report.properties.find((x) => x.id === id)!;
  if (p.holds) return p.unfinished ? "unfinished" : "holds";
  const keys = (events: Event[]) => events.map((e) => e.key.replace("message:", ""));
  return { events: keys(p.counterexample.events), loop: keys(p.loop!.events) };
}

/** The reference explorer's liveness verdict, to agree with. */
function reference(spec: Spec, id: string) {
  return explore(spec, { depth: BOUNDS.depth, instances: {} }).liveness.get(id);
}



/** A door someone may open, and a property that it opens, with or without a final state. */
function door(final: boolean) {
  const zone = defineZone({ name: "Hall" });
  const Door = defineActor({
    name: "Door",
    zone,
    singleton: true,
    initialState: () => ({ open: false }),
    actions: { open: { label: "Open", description: "Someone opens the door.", when: (s) => !s.open, run: (s) => void (s.open = true) } },
  });

  const opens = defineProperty("opens", { description: "The door opens.", eventually: (w) => w.the(Door).state.open });

  return defineSpec({
    name: "Door",
    actors: [Door],
    properties: [opens],
    ...(final ? { finalState: { description: "The door is open.", when: (w: WorldView) => w.the(Door).state.open } } : {}),
  });
}

test("actions are not fair: nobody has to open the door, so it may stay shut forever", async () => {
  const report = await check(door(true), BOUNDS);
  expect(verdict(report, "opens")).toEqual({ events: [], loop: [] });
  expect(reference(door(true), "opens")).toBe("broken");
});

test("a world where nothing can happen is stuck, unless the spec calls it final", async () => {
  expect((await check(door(true), BOUNDS)).stuck).toBeUndefined();
  const stuck = (await check(door(false), BOUNDS)).stuck!;
  expect(stuck.counterexample.events.map((e) => e.key)).toEqual(["open"]);
});

const Ping = defineMessage("Ping");

/** A ping that, once sent, may or may not have to arrive. */
function ping(fair: false | undefined) {
  const zone = defineZone({ name: "Net" });
  const Receiver = defineActor({
    name: "Receiver",
    zone,
    singleton: true,
    initialState: () => ({ got: false }),
    transitions: { ping: { on: Ping, description: "Gets it.", fair, run: (s) => void (s.got = true) } },
  });
  const Sender = defineActor({
    name: "Sender",
    zone,
    singleton: true,
    initialState: () => ({ sent: false }),
    actions: { send: { label: "Send", description: "Sends a ping.", when: (s) => !s.sent, sends: [Ping], run: (s, _i, ctx) => void ((s.sent = true), ctx.send(ctx.the(Receiver), Ping, {})) } },
  });

  const arrives = defineProperty("arrives", { description: "A ping sent arrives.", leadsTo: { whenever: (w) => w.the(Sender).state.sent, then: (w) => w.the(Receiver).state.got } });

  return defineSpec({
    name: "Ping",
    actors: [Receiver, Sender],
    properties: [arrives],
    finalState: { description: "Nothing left to send.", when: (w) => w.the(Sender).state.sent },
  });
}

test("a message in flight is delivered, unless its step says it need not be", async () => {
  expect(verdict((await check(ping(undefined), BOUNDS)), "arrives")).toBe("holds");
  expect((await check(ping(undefined), BOUNDS)).properties[0].tested).toBe(1);
  expect(verdict((await check(ping(false), BOUNDS)), "arrives")).toEqual({ events: ["send"], loop: [] });
  expect(reference(ping(undefined), "arrives")).toBe("holds");
  expect(reference(ping(false), "arrives")).toBe("broken");
});



/** A light that keeps flipping, and a prize to take while it is on. */
function light(win: "weak" | "strong" | null) {
  const zone = defineZone({ name: "Room" });
  const Light = defineActor({
    name: "Light",
    zone,
    singleton: true,
    initialState: () => ({ on: false, won: false }),
    transitions: {
      flip: { description: "Flips.", when: (s) => !s.won, run: (s) => void (s.on = !s.on) },
      ...(win ? { win: { description: "Takes the prize while on.", fair: win, when: (s: { on: boolean; won: boolean }) => s.on && !s.won, run: (s: { won: boolean }) => void (s.won = true) } } : {}),
    },
  });

  const wins = defineProperty("wins", { description: "The prize is taken.", eventually: (w) => w.the(Light).state.won });

  const onAgain = defineProperty("onAgain", { description: "The light is on again and again.", infinitelyOften: (w) => w.the(Light).state.on || w.the(Light).state.won });

  const settles = defineProperty("settles", { description: "The light ends up off for good.", eventuallyAlways: (w) => !w.the(Light).state.on });

  return defineSpec({
    name: "Light",
    actors: [Light],
    properties: [wins, onAgain, settles],
    finalState: { description: "The prize is taken.", when: (w) => w.the(Light).state.won },
  });
}

test("weak fairness lets a step possible only on and off wait forever; strong fairness does not", async () => {
  expect(verdict((await check(light("weak"), BOUNDS)), "wins")).toEqual({ events: [], loop: ["flip", "flip"] });
  expect(verdict((await check(light("strong"), BOUNDS)), "wins")).toBe("holds");
  expect(reference(light("weak"), "wins")).toBe("broken");
  expect(reference(light("strong"), "wins")).toBe("holds");
});

test("infinitelyOften and eventuallyAlways: a light that flips forever is on again and again, and never settles", async () => {
  const report = await check(light(null), BOUNDS);
  expect(verdict(report, "onAgain")).toBe("holds");
  expect(verdict(report, "settles")).toEqual({ events: [], loop: ["flip", "flip"] });
  expect(reference(light(null), "onAgain")).toBe("holds");
  expect(reference(light(null), "settles")).toBe("broken");
});



/** A counter that counts up for ever, and someone who may reset it. */
function counter() {
  const zone = defineZone({ name: "Box" });
  const Counter = defineActor({
    name: "Counter",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    actions: { reset: { label: "Reset", description: "Someone resets it, twice at most.", with: [atMost(2)], run: (s) => void (s.n = 0) } },
    transitions: { tick: { description: "Counts.", when: () => true, run: (s) => void s.n++ } },
  });

  const neverDown = defineProperty("neverDown", { description: "The count never goes down.", everyStep: (before, after) => after.the(Counter).state.n >= before.the(Counter).state.n });

  const negative = defineProperty("negative", { description: "The count goes below zero.", eventually: (w) => w.the(Counter).state.n < 0 });

  return defineSpec({
    name: "Counter",
    actors: [Counter],
    properties: [neverDown, negative],
  });
}

test("everyStep judges each step, with the worlds on both sides", async () => {
  const report = await check(counter(), BOUNDS);
  expect(brokenIn(report, "neverDown").counterexample.events.map((e) => e.key)).toEqual(["tick", "reset"]);
});

test("a loop that may lie past the depth bound leaves the verdict unfinished", async () => {
  expect(verdict((await check(counter(), BOUNDS)), "negative")).toBe("unfinished");
  expect(reference(counter(), "negative")).toBe("unfinished");
});
