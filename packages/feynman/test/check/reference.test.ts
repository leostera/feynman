// The checker against the reference explorer (reference.ts) on every case in the corpus. The
// reference is slow and plain on purpose; agreeing with it says the checker's search, its
// state identity and its judging lose nothing.
import { describe, test } from "bun:test";
import { caseName, configured, corpus } from "../examples/corpus.ts";
import { agreesWithReference } from "./agree.ts";

describe("the checker against a reference explorer", () => {
  for (const example of corpus) for (const c of example.cases) {
    test(caseName(example, c), async () => {
      const { spec } = configured(example.spec(c.variant), { faults: c.bounds.faults ?? 0 });
      await agreesWithReference(spec, { depth: c.bounds.depth ?? 60, instances: example.instances ?? {} });
    }, 300_000);
  }
});
