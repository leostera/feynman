// APIs from before time became the order of events (RFD0004) say what replaced them, rather
// than failing with "is not a function": specs written for old versions meet them on upgrade.
import { expect, test } from "bun:test";
import { defineActor, defineScenario, defineSpec, defineZone, runScenario } from "../../src/spec/index.ts";



function specWith(run: (s: any) => void) {
  const zone = defineZone({ name: "z" });
  const AActor = defineActor({ name: "A", zone, singleton: true, initialState: () => ({}) });

  const old = defineScenario("old", { run });

  return defineSpec({
    name: "Old",
    actors: [AActor],
    scenarios: [old],
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
