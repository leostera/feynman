// Ways the checker once said more than it knew, each found by review and kept from coming back:
// a wrong ✓ (a break it could not see), or a wrong ✗ (a break that is not one).
import { expect, test } from "bun:test";
import { check, checkRules } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { verdictOf } from "../../src/check/verdict.ts";
import { atMost, defineActor, defineMessage, defineProperty, defineRule, defineScenario, defineSpec, defineZone, oneOf, runScenario, type Property, type Spec, type WorldView } from "../../src/spec/index.ts";

const zone = defineZone({ name: "z" });
const ANY = { description: "Anything.", when: () => true };
/** No random runs, and a time limit the search never meets: the verdicts are the search's own. */
const SEARCH = { walks: 0, timeLimit: 600_000 };

const verdict = async (spec: Spec, bounds = {}, seeds = scenarioSeeds(spec)) => {
  const report = await check(spec, { ...SEARCH, ...bounds }, seeds);
  return Object.fromEntries(report.properties.map((p) => [p.id, p.holds ? "holds" : `breaks in ${p.counterexample.events.length}`]));
};

/** A counter a person pushes up, one step at a time: thirty ups is far past the search's depth. */
function counter(properties: Property[]) {
  const Counter = defineActor({
    name: "Counter",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    actions: { up: { label: "Up", description: "Adds one.", run: (s) => void (s.n += 1) } },
  });
  return { Counter, spec: (scenarios = [] as ReturnType<typeof defineScenario>[]) => defineSpec({ name: "Counter", actors: [Counter], properties, scenarios, finalState: ANY }) };
}

test("a scenario breaks the everyStep and never properties its path breaks, not only the always ones", async () => {
  const steps = defineProperty("neverReaches30", { description: "No step takes it to 30.", everyStep: (_before, after) => after.the(C).state.n < 30 });
  const path = defineProperty("fewerThan30Ups", { description: "Never 30 ups.", never: (t) => t.count((e) => e.is(C, "up")) >= 30 });
  const { Counter: C, spec } = counter([steps, path]);
  const thirty = defineScenario("Thirty ups", { run: (s) => { for (let i = 0; i < 30; i++) s.act(s.the(C), "up"); } });
  const run = runScenario(spec([thirty]), spec([thirty]).scenarios[0]!);
  expect(run.events.at(-1)!.violations.sort()).toEqual(["fewerThan30Ups", "neverReaches30"]);
  expect(run.events.at(-2)!.violations).toEqual([]);
  // A scenario that breaks a property is no place to search from.
  expect(scenarioSeeds(spec([thirty]))).toEqual([]);
});

test("a never property that asks a question only sometimes is judged on every path, not on merged ones", async () => {
  const S = defineActor({
    name: "S",
    zone,
    singleton: true,
    initialState: () => ({ n: 0, done: false }),
    actions: {
      up: { label: "Up", description: "Up.", when: (s) => s.n < 1 && !s.done, run: (s) => void (s.n += 1) },
      down: { label: "Down", description: "Down.", when: (s) => s.n > 0 && !s.done, run: (s) => void (s.n -= 1) },
      go: { label: "Go", description: "Go.", when: (s) => !s.done, run: (s) => void (s.done = true) },
    },
  });
  // Breaks on up, down, up, down, go. Before a go, it never counts the downs: the world after
  // "up, down" is the start again, and remembering only what was asked merged the two.
  const lazy = defineProperty("lazy", { description: "Never go after two downs.", never: (t) => t.some((e) => e.is(S, "go")) && t.count((e) => e.is(S, "down")) >= 2 });
  const eager = defineProperty("eager", {
    description: "The same, both always read.",
    never: (t) => {
      const went = t.some((e) => e.is(S, "go"));
      return t.count((e) => e.is(S, "down")) >= 2 && went;
    },
  });
  const spec = (p: Property) => defineSpec({ name: "Lazy", actors: [S], properties: [p], finalState: ANY });
  expect(await verdict(spec(eager))).toEqual({ eager: "breaks in 5" });
  expect(await verdict(spec(lazy))).toEqual({ lazy: "breaks in 5" });
});

test("a never property counts a scenario's steps when the search starts from its end", async () => {
  const Ask = defineMessage("Ask", {});
  const Answer = defineMessage("Answer", {}, { tone: "reply" });
  const Server = defineActor({
    name: "Server",
    zone,
    singleton: true,
    initialState: () => ({}),
    transitions: { ask: { on: Ask, description: "Answers.", sends: [Answer], run: (_s, _m, ctx) => ctx.reply(Answer, {}) } },
  });
  const Client = defineActor({
    name: "Client",
    zone,
    singleton: true,
    initialState: () => ({ answers: 0 }),
    actions: { ask: { with: [atMost(1)], label: "Ask", description: "Asks.", sends: [Ask], run: (_s, _i, ctx) => ctx.send(ctx.the(Server), Ask, {}) } },
    transitions: { answer: { on: Answer, description: "Hears.", run: (s) => void (s.answers += 1) } },
  });
  // True of every run. The scenario ends with the question in flight: the answer that follows
  // is to a question the path from there must still count.
  const needsQuestion = defineProperty("answersNeedQuestions", { description: "Never more answers than questions.", never: (t) => t.count((e) => e.is(Server, "ask")) > t.count((e) => e.is(Client, "ask")) });
  const asks = defineScenario("The client asks", { run: (s) => void s.act(s.the(Client), "ask") });
  const spec = defineSpec({ name: "Ask", actors: [Server, Client], properties: [needsQuestion], scenarios: [asks], finalState: ANY });
  expect(scenarioSeeds(spec).map((s) => s.at)).toEqual(["end"]);
  expect(await verdict(spec)).toEqual({ answersNeedQuestions: "holds" });
  // With random runs too, which start from the scenario's end as the search does.
  expect((await check(spec, {}, scenarioSeeds(spec))).properties[0]!.holds).toBe(true);
});

test("symmetry is refuted by a property that tells interchangeable instances apart", async () => {
  const P = defineActor({
    name: "P",
    zone,
    symmetric: true,
    initialState: () => ({ x: 0 }),
    actions: { inc: { label: "Inc", description: "Adds one.", when: (s) => s.x < 2, run: (s) => void (s.x += 1) } },
  });
  const x = (w: WorldView, label: string) => w.all(P).find((p) => p.label === label)?.state.x ?? 0;
  // The steps are symmetric; the properties name B. The worlds where only B is at two are
  // renamings of the one where only A is, which is the one the search keeps.
  const state = defineProperty("onlyBAtTwo", { description: "B is never alone at two.", always: (w) => !(x(w, "P A") === 0 && x(w, "P B") === 2 && x(w, "P C") === 0) });
  const step = defineProperty("bNeverFirstToTwo", { description: "B is never first to two.", everyStep: (b, a) => !(x(b, "P B") === 1 && x(a, "P B") === 2 && x(a, "P A") === 0 && x(a, "P C") === 0) });
  for (const property of [state, step]) {
    const spec = defineSpec({ name: "Three", actors: [P], properties: [property], finalState: ANY });
    const report = await check(spec, { ...SEARCH, instances: { P: 3 } });
    expect(report.reductions.refuted).toEqual(["P"]);
    expect(report.properties[0]!.holds).toBe(false);
    expect(!report.properties[0]!.holds && report.properties[0]!.counterexample.events.length).toBe(2);
  }
});

test("every value of an input is tried, however many there are", async () => {
  const seats = Array.from({ length: 13 }, (_, i) => `s${i + 1}`);
  const A = defineActor({
    name: "A",
    zone,
    singleton: true,
    initialState: () => ({ picked: null as string | null }),
    actions: { pick: { with: [atMost(1)], label: "Pick", description: "Picks a seat.", inputs: { seat: oneOf(...seats) }, run: (s, i) => void (s.picked = i.seat) } },
  });
  const last = defineProperty("notTheLast", { description: "The last seat is never picked.", always: (w) => w.the(A).state.picked !== "s13" });
  expect(await verdict(defineSpec({ name: "Seats", actors: [A], properties: [last], finalState: ANY }))).toEqual({ notTheLast: "breaks in 1" });
});

test("a property that held where a step drew a random number is not proved", async () => {
  // One flip of a seeded coin: the checker sees the side its seed gives, and never the other.
  const coin = (bug: (x: number) => boolean) => {
    const A = defineActor({
      name: "A",
      zone,
      singleton: true,
      initialState: () => ({ bug: false }),
      actions: { flip: { with: [atMost(1)], label: "Flip", description: "Flips once.", run: (s, _i, ctx) => void (s.bug = bug(ctx.random())) } },
    });
    const noBug = defineProperty("noBug", { description: "No bug.", always: (w) => !w.the(A).state.bug });
    return defineSpec({ name: "Coin", actors: [A], properties: [noBug], finalState: ANY });
  };
  const reports = [await check(coin((x) => x < 0.5), SEARCH), await check(coin((x) => x >= 0.5), SEARCH)];
  // One side is the bug in each: the search finds it in one, and says what it did not try in the other.
  expect(reports.map((r) => r.properties[0]!.holds).sort()).toEqual([false, true]);
  const held = reports.find((r) => r.properties[0]!.holds)!;
  expect(held.chance).toEqual(["A.flip"]);
  expect(verdictOf(held.properties[0]!, { report: held, brokenBy: new Map() })).toBe("unfinished");
});

test("a rule is needed when only a scenario shows it: one that breaks the property without the rule", async () => {
  const cap = defineRule("cap", { description: "Counting stops at thirty." });
  const Counter = defineActor({
    name: "Counter",
    zone,
    singleton: true,
    initialState: () => ({ n: 0 }),
    actions: { up: { label: "Up", description: "Adds one, up to the cap.", run: (s) => void (!cap.on || s.n < 30 ? (s.n += 1) : undefined) } },
  });
  const below = defineProperty("atMostThirty", { description: "Never past thirty.", needs: [cap], always: (w) => w.the(Counter).state.n <= 30 });
  // Thirty-one ups: past the search's depth from the start, and no place to search from without
  // the rule, since it breaks the property there.
  const many = defineScenario("Thirty-one ups", { run: (s) => { for (let i = 0; i < 31; i++) s.act(s.the(Counter), "up"); } });
  const spec = defineSpec({ name: "Capped", actors: [Counter], properties: [below], scenarios: [many], finalState: ANY });
  expect(await checkRules(spec, { ...SEARCH, depth: 5 })).toEqual([
    { name: "cap", description: "Counting stops at thirty.", neededBy: [{ property: "atMostThirty", verdict: "breaks", events: 31, scenario: "Thirty-one ups" }] },
  ]);
});
