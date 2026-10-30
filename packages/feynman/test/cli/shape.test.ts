import { expect, test } from "bun:test";
import { defineActor, defineMessage, defineSpec, defineZone } from "../../src/spec/index.ts";
import { shapeWarnings, unbuilt } from "../../src/cli/shape.ts";

const spec = (() => {
  const zone = defineZone({ name: "z" });
  const WorkerActor = defineActor({
    name: "Worker",
    zone,
    initialState: () => ({ done: false }),
    actions: {
      process: {
        label: "Process",
        description: "Everything at once.",
        sources: ["a.py#run", "b.py#download", "c.py#transcribe", "d.py#analyze"],
        run: (s) => void (s.done = true),
      },
      finish: { label: "Finish", description: "One stage.", sources: ["a.py#finish", "a.py#save"], run: () => {} },
      // Designed, not built yet: no sources.
      archive: { label: "Archive", description: "Not written yet.", run: () => {} },
    },
  });
  return defineSpec({
    name: "Shape",
    actors: [WorkerActor],
  });
})();

test("a step citing many files is flagged; a short trail is not", () => {
  expect(shapeWarnings(spec).map((w) => w.step)).toEqual(["process"]);
});

test("steps without sources are designs, not errors", () => {
  expect(unbuilt(spec)).toEqual([{ actor: "Worker", step: "archive" }]);
});

test("a step on a message no step sends is flagged: it never runs", () => {
  const Ping = defineMessage("Ping");
  const Pong = defineMessage("Pong");
  const zone = defineZone({ name: "z" });
  const A = defineActor({
    name: "A",
    zone,
    singleton: true,
    initialState: () => ({}),
    actions: { ping: { label: "Ping", description: "Pings.", sends: [Ping], run: (_s, _i, ctx) => ctx.send(ctx.self, Ping, {}) } },
    transitions: {
      pinged: { on: Ping, description: "Is pinged.", run: () => {} },
      pong: { on: Pong, description: "Nothing sends it.", run: () => {} },
    },
  });
  expect(shapeWarnings(defineSpec({ name: "Talk", actors: [A] }))).toEqual([{ actor: "A", step: "pong", message: "is on Pong, which no step sends: it never runs" }]);
});
