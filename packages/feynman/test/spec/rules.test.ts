// Rules that are needed (RFD0010): a spec names the rules of its design, properties say which
// they need, and the check expects each such property to break in the design without the rule.
import { expect, test } from "bun:test";
import { check, checkRules } from "../../src/check/index.ts";
import { defineSpec, type Rule } from "../../src/spec/index.ts";
import { retriedCall } from "../../examples/retried-call.ts";

const PLAIN = { depth: 12, repeats: 6, walks: 0, reduce: false, symmetry: false, workers: 0 } as const;

/** A counter that must stay below 3: `cap` keeps it there; `decoy` is read nowhere. */
function capped(claims: (rules: { cap: Rule; decoy: Rule }) => Rule[]) {
  return defineSpec("Capped", { messages: {} }, (spec) => {
    const cap = spec.defineRule({ name: "cap", description: "Counting stops at two." });
    const decoy = spec.defineRule({ name: "decoy", description: "Changes nothing." });
    const zone = spec.defineZone({ name: "z" });
    const Counter = spec.defineActor({
      name: "Counter",
      zone,
      singleton: true,
      initialState: () => ({ n: 0 }),
      actions: { count: { label: "Count", description: "Counts one more.", when: (s) => !cap.on || s.n < 2, run: (s) => void s.n++ } },
    });
    spec.defineProperties({ belowThree: { description: "The count stays below three.", always: (w) => w.the(Counter).state.n < 3, needs: claims({ cap, decoy }) } });
  });
}

test("a rule is on as written, and off in the variant without it", () => {
  const spec = capped(({ cap }) => [cap]);
  expect(spec.rules).toEqual([
    { name: "cap", description: "Counting stops at two.", neededBy: ["belowThree"] },
    { name: "decoy", description: "Changes nothing.", neededBy: [] },
  ]);
  expect(spec.properties[0].needs).toEqual(["cap"]);
  expect(spec.without).toEqual([]);
  const without = spec.withoutRules(["cap"]);
  expect(without.name).toBe("Capped without cap");
  expect(without.without).toEqual(["cap"]);
  expect(() => spec.withoutRules(["nope"])).toThrow('Capped has no rule named "nope"; its rules: cap, decoy');
});

test("rules: names are words, unique, and a property only needs its own spec's rules", () => {
  expect(() => defineSpec("A", { messages: {} }, (s) => void s.defineRule({ name: "two words", description: "" }))).toThrow("A rule's name is a word");
  expect(() => defineSpec("A", { messages: {} }, (s) => (s.defineRule({ name: "r", description: "" }), void s.defineRule({ name: "r", description: "" })))).toThrow('Two rules are named "r"');
  let foreign: Rule | undefined;
  defineSpec("B", { messages: {} }, (s) => void (foreign = s.defineRule({ name: "r", description: "" })));
  expect(() => defineSpec("A", { messages: {} }, (s) => s.defineProperties({ p: { description: "", always: () => true, needs: [foreign!] } }))).toThrow(`Property "p" needs rule "r", which is not one of this spec's`);
});

for (const engine of ["integer", "classic"] as const) {
  test(`${engine}: a needed rule breaks its property without it; a decoy does not`, async () => {
    const spec = capped(({ cap, decoy }) => [cap, decoy]);
    expect((await check(spec, PLAIN, [], { engine })).properties[0].holds).toBe(true);
    expect(await checkRules(spec, PLAIN, { engine })).toEqual([
      { name: "cap", description: "Counting stops at two.", neededBy: [{ property: "belowThree", verdict: "breaks", events: 3 }] },
      { name: "decoy", description: "Changes nothing.", neededBy: [{ property: "belowThree", verdict: "holds" }] },
    ]);
  });
}

test("the retried call's idempotency key is needed: without it, a lost answer charges twice", async () => {
  const [rule] = await checkRules(retriedCall("fixed"), { ...PLAIN, faults: 1 });
  expect(rule).toMatchObject({ name: "idempotencyKey", neededBy: [{ property: "chargedOnce", verdict: "breaks", events: 5 }] });
});

test("the search for a rule's claim stops once every property needing it has broken", async () => {
  const spec = capped(({ cap }) => [cap]).withoutRules(["cap"]);
  const bounds = { ...PLAIN, depth: 40 };
  const full = await check(spec, bounds);
  const early = await check(spec, bounds, [], { untilBroken: true });
  expect(early.properties[0].holds).toBe(false);
  expect(early.exhaustive).toBe(false);
  expect(early.states).toBeLessThan(full.states);
});
