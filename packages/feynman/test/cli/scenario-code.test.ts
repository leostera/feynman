// A counterexample printed as scenario code must replay it: the same events, from the same
// instances, ending where the property breaks. Checked on every bug in the corpus.
import { expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { scenarioCode } from "../../src/cli/scenario-code.ts";
import { compile } from "./compile.ts";
import { scenarioSeeds } from "../../src/check/seeds.ts";
import { runScenario } from "../../src/spec/index.ts";
import { caseName, corpus } from "../examples/corpus.ts";

for (const example of corpus)
  for (const c of example.cases) {
    const broken = Object.entries(c.expect).filter(([, e]) => e !== "holds");
    if (!broken.length) continue;
    test(`${caseName(example, c)}: counterexamples replay as scenarios`, async () => {
      const spec = example.spec(c.variant);
      const report = await check(spec, { ...c.bounds, instances: example.instances ?? {}, walks: 0 }, scenarioSeeds(spec));
      for (const p of report.properties.filter((x) => !x.holds && !x.unreached)) {
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
