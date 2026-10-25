import { expect, test } from "bun:test";
import { defineSpec, message } from "@feynman/spec";
import { shapeWarnings } from "../src/shape.ts";

const spec = defineSpec("Shape", { messages: { Go: message<{}>({ name: "go" }) } }, (spec) => {
  const zone = spec.defineZone({ name: "z" });
  spec.defineActor({
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
    },
  });
});

test("a step citing many files is flagged; a short trail is not", () => {
  expect(shapeWarnings(spec).map((w) => w.step)).toEqual(["process"]);
});
