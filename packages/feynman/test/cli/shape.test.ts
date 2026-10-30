import { expect, test } from "bun:test";
import { defineActor, defineSpec, defineZone } from "../../src/spec/index.ts";
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
