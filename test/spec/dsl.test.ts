// The DSL is a boundary: specs are code, but not always type-checked code (plain JavaScript,
// casts, generated specs). Mistakes it can see are reported where they are made, not taken
// for something else.
import { expect, test } from "bun:test";
import { defineSpec, type SpecBuilder } from "../../src/spec/index.ts";

/** A spec with one actor, and whatever `body` declares. */
function specWith(body: (spec: SpecBuilder<{}>, actor: { name: string }) => void) {
  return () =>
    defineSpec("T", { messages: {} }, (spec) => {
      const zone = spec.defineZone({ name: "Z" });
      const actor = spec.defineActor({ name: "A", zone, singleton: true, initialState: () => ({ on: false }), transitions: { flip: { description: "Flips.", when: () => true, run: (s) => void (s.on = !s.on) } } });
      body(spec, actor);
      return { actor };
    });
}

test("a property declares exactly one kind, with a function", () => {
  expect(specWith((spec) => spec.defineProperties({ p: { description: "Two at once.", always: () => true, eventually: () => true } as never }))).toThrow('Property "p": say what it checks with one of always, everyStep, never, eventually, leadsTo, infinitelyOften, eventuallyAlways, not always and eventually');
  expect(specWith((spec) => spec.defineProperties({ p: { description: "None." } as never }))).toThrow('Property "p": say what it checks with one of');
  expect(specWith((spec) => spec.defineProperties({ p: { description: "Half.", leadsTo: { whenever: () => true } } as never }))).toThrow('Property "p": leadsTo.then is a function');
  expect(specWith((spec) => spec.defineProperties({ p: { description: "Not a function.", always: true } as never }))).toThrow('Property "p": always is a function');
});

test("property names are unique across calls", () => {
  expect(specWith((spec) => {
    spec.defineProperties({ p: { description: "One.", always: () => true } });
    spec.defineProperties({ p: { description: "Again.", always: () => true } });
  })).toThrow('Two properties are named "p"');
});

test("fairness is weak, strong or false, and only for transitions", () => {
  const withFair = (fair: unknown, on: "actions" | "transitions") => () =>
    defineSpec("T", { messages: {} }, (spec) => {
      const zone = spec.defineZone({ name: "Z" });
      spec.defineActor({ name: "A", zone, singleton: true, initialState: () => ({}), [on]: { go: { label: "Go", description: "Goes.", when: () => true, fair, run: () => {} } } } as never);
    });
  expect(withFair("strong", "transitions")).not.toThrow();
  expect(withFair(false, "transitions")).not.toThrow();
  expect(withFair("weekly", "transitions")).toThrow('A.go: fair is "weak", "strong" or false, not "weekly"');
  expect(withFair("weak", "actions")).toThrow("A.go: actions are never fair");
});

test("the final state is said once, with a predicate", () => {
  expect(specWith((spec) => spec.defineFinalState({ description: "Done.", when: true as never }))).toThrow("defineFinalState: `when` is a predicate");
  expect(specWith((spec) => {
    spec.defineFinalState({ description: "Done.", when: () => true });
    spec.defineFinalState({ description: "Also done.", when: () => true });
  })).toThrow("defineFinalState is called once");
});
