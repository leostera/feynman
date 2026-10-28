// Every example comes with scenarios to play and watch: they run cleanly, the fixed variant's
// break nothing it is not known to break, and the buggy variant has one that shows its bug.
import { describe, expect, test } from "bun:test";
import { stepBreaks } from "../../src/check/judge.ts";
import { holdsIn, runScenario, traceView, type Run, type Spec } from "../../src/spec/index.ts";
import { corpus } from "./corpus.ts";

/**
 * The properties a scenario's run breaks: `always` and `everyStep` on the way, `never` over
 * it, and liveness, roughly, where it settles (a settled run stays where it ends).
 */
function broken(spec: Spec, run: Run): string[] {
  const end = run.worlds.at(-1) ?? run.initial;
  const at = (p: (w: never) => boolean) => holdsIn(spec, end, p as never);
  return spec.properties
    .filter((p) => {
      switch (p.kind) {
        case "always":
          return run.events.some((e) => e.violations.includes(p.id));
        case "everyStep":
          return run.events.some((e, i) => !e.error && stepBreaks(spec, run.worlds[i - 1] ?? run.initial, run.worlds[i], e, new Set()).includes(p.id));
        case "never":
          return p.never(traceView(run.events));
        case "eventually":
          return ![run.initial, ...run.worlds].some((w) => holdsIn(spec, w, p.eventually));
        case "leadsTo":
          return at(p.whenever) && !at(p.then);
        case "infinitelyOften":
          return !at(p.infinitelyOften);
        case "eventuallyAlways":
          return !at(p.eventuallyAlways);
      }
    })
    .map((p) => p.id);
}

for (const example of corpus) {
  describe(example.name, () => {
    const runs = (variant: "buggy" | "fixed") => {
      const spec = example.spec(variant);
      return spec.scenarios.map((scenario) => ({ scenario: scenario.name, run: runScenario(spec, scenario), spec }));
    };

    test("every scenario runs, in both variants", () => {
      for (const variant of ["buggy", "fixed"] as const) {
        const all = runs(variant);
        expect(all.length).toBeGreaterThanOrEqual(2);
        for (const { scenario, run } of all) expect({ variant, scenario, error: run.error ?? run.events.find((e) => e.error)?.error }).toEqual({ variant, scenario, error: undefined });
      }
    });

    // An example with one variant (the switch, a fixture for `never`) has no fixed one to keep clean.
    test.skipIf(!example.cases.some((c) => c.variant === "fixed"))("fixed, scenarios break only what the fixed variant is known to break", () => {
      const known = new Set(example.cases.filter((c) => c.variant === "fixed").flatMap((c) => Object.entries(c.expect).filter(([, e]) => e !== "holds").map(([id]) => id)));
      for (const { scenario, run, spec } of runs("fixed")) expect({ scenario, broken: broken(spec, run).filter((id) => !known.has(id)) }).toEqual({ scenario, broken: [] });
    });

    test("buggy, a scenario shows the bug", () => {
      const bugs = new Set(example.cases.filter((c) => c.variant === "buggy").flatMap((c) => Object.entries(c.expect).filter(([, e]) => e !== "holds").map(([id]) => id)));
      const shown = new Set(runs("buggy").flatMap(({ run, spec }) => broken(spec, run)));
      expect([...bugs].filter((id) => shown.has(id))).not.toEqual([]);
    });
  });
}
