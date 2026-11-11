// Ways the checker once said more than it knew, each found by review and kept from coming back:
// a wrong ✓ (a break it could not see), or a wrong ✗ (a break that is not one).
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { atMost, defineActor, defineMessage, defineProperty, defineScenario, defineSpec, defineZone, runScenario, type Property, type Spec } from "../../src/spec/index.ts";

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
