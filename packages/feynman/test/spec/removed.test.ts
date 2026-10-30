// APIs from before time became the order of events (RFD0004), and the closure that built a spec
// before it was made of parts (RFD0011), say what replaced them, rather than failing with "is not
// a function": specs written for old versions meet them on upgrade.
import { expect, test } from "bun:test";
import { defineActor, defineScenario, defineSpec, defineZone, runScenario } from "../../src/spec/index.ts";

test("defineSpec(name, { messages }, closure) says a spec is made of parts now", () => {
  expect(() => (defineSpec as (...args: unknown[]) => unknown)("Payments", { messages: {} }, () => ({}))).toThrow(
    'defineSpec("Payments", { messages }, (spec) => …) is gone: a spec is made of parts since 0.14 (RFD0011)',
  );
});

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
