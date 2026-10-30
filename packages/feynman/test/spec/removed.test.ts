// APIs from before time became the order of events (RFD0004) say what replaced them, rather
// than failing with "is not a function": specs written for old versions meet them on upgrade.
import { expect, test } from "bun:test";
import { defineSpec, runScenario } from "../../src/spec/index.ts";

function specWith(run: (s: any) => void) {
  return defineSpec("Old", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "z" });
    spec.defineActor({ name: "A", zone, singleton: true, initialState: () => ({}) });
    spec.defineScenario({ name: "old", run });
  });
}

test("s.wait says there is no clock, and what to do instead", () => {
  const spec = specWith((s) => s.wait(60_000));
  expect(runScenario(spec, spec.scenarios[0]).error).toContain('s.wait is gone: there is no clock, time is the order of events (RFD0004)');
});

test("s.settle with a duration says it takes none", () => {
  const spec = specWith((s) => s.settle(5 * 60_000));
  expect(runScenario(spec, spec.scenarios[0]).error).toContain("settle takes no duration");
});
