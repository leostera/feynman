// A counterexample printed as scenario code must replay it: the same events, from the same
// instances, ending where the property breaks. Checked on every bug in the corpus.
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { actorVariable, scenarioCode } from "../../src/cli/scenario-code.ts";
import { runScenario, type Script, type Spec } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";

/** The scenario the code defines, compiled with the spec's actors in scope. */
function compile(spec: Spec, code: string): (s: Script) => void {
  const body = code.slice(code.indexOf("run(s) {") + "run(s) {".length, code.lastIndexOf("},"));
  const run = new Function(...spec.actors.map((a) => actorVariable(a.name)), `return (s) => {${body}}`);
  const handles = spec.actors.map((a) => ({ name: a.name }));
  return run(...handles);
}

for (const example of corpus)
  for (const c of example.cases) {
    const broken = Object.entries(c.expect).filter(([, e]) => e !== "holds");
    if (!broken.length) continue;
    test(`${caseName(example, c)}: counterexamples replay as scenarios`, () => {
      const spec = example.spec(c.variant);
      const report = check(spec, { ...c.bounds, instances: example.instances ?? {}, walks: 0 });
      for (const p of report.properties.filter((x) => !x.holds && !x.counterexample!.from)) {
        const run = runScenario(spec, { name: p.id, run: compile(spec, scenarioCode(spec, p)) });
        expect(run.error).toBeUndefined();
        const steps = (events: typeof run.events) => events.filter((e) => e.kind !== "spawn").map((e) => `${e.instance} ${e.kind} ${e.key}`);
        // A liveness counterexample is followed by one round of its loop.
        expect(steps(run.events)).toEqual(steps([...p.counterexample!.events, ...(p.loop?.events ?? [])]));
        if (p.kind === "always") expect(run.events.at(-1)!.violations).toContain(p.id);
      }
    });
  }
