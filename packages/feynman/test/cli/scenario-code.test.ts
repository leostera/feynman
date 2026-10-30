// A counterexample printed as scenario code must replay it: the same events, from the same
// instances, ending where the property breaks. Checked on every bug in the corpus.
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { actorVariable, scenarioCode } from "../../src/cli/scenario-code.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { runScenario, type ScenarioInfo, type Script, type Setup, type Spec } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";

/** The scenario the code defines, its setup and run compiled with the spec's actors and messages in scope. */
function compile(spec: Spec, name: string, code: string): ScenarioInfo {
  // The code is TypeScript (`find(…)!`): transpile it, with the spec's actors in scope.
  const scope = (body: string, param: string) => {
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(`const f = (${param}) => {${body}};`);
    const messages = Object.values(spec.messages);
    const names = [...spec.actors.map((a) => actorVariable(a.name)), ...messages.map((m) => m.id), "failed"];
    const values = [...spec.actors.map((a) => ({ name: a.name })), ...messages.map((m) => ({ kind: "message", key: m.key })), (m: { key: string }) => ({ kind: "failure", key: `failed:${m.key}` })];
    return new Function(...names, `${js}\nreturn f;`)(...values);
  };
  const run = code.slice(code.indexOf("run(s) {") + "run(s) {".length, code.lastIndexOf("},"));
  const setup = code.includes("setup(w) {") ? code.slice(code.indexOf("setup(w) {") + "setup(w) {".length, code.indexOf("\n  },\n  run(s) {")) : null;
  return { name, run: scope(run, "s") as (s: Script) => void, ...(setup ? { setup: scope(setup, "w") as (w: Setup) => void } : {}) };
}

for (const example of corpus)
  for (const c of example.cases) {
    const broken = Object.entries(c.expect).filter(([, e]) => e !== "holds");
    if (!broken.length) continue;
    test(`${caseName(example, c)}: counterexamples replay as scenarios`, async () => {
      const spec = example.spec(c.variant);
      const report = await check(spec, { ...c.bounds, instances: example.instances ?? {}, walks: 0 }, scenarioSeeds(spec));
      for (const p of report.properties.filter((x) => !x.holds)) {
        const code = scenarioCode(spec, p);
        // From a scenario world a setup cannot build (messages in flight, fresh ids): the code says to copy the scenario.
        if (p.counterexample.from && !code.includes("setup(w) {")) continue;
        const run = runScenario(spec, compile(spec, p.id, code));
        expect(run.error).toBeUndefined();
        const steps = (events: typeof run.events) => events.filter((e) => e.kind !== "spawn").map((e) => `${e.instance} ${e.kind} ${e.key}`);
        // A liveness counterexample is followed by one round of its loop.
        expect(steps(run.events)).toEqual(steps([...p.counterexample.events, ...(p.loop?.events ?? [])]));
        if (p.kind === "always") expect(run.events.at(-1)!.violations).toContain(p.id);
      }
    });
  }
