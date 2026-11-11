// The checker's verdicts on specs translated from the wild match what TLC finds on the
// originals (wild.ts; wild.oracle.ts runs TLC itself), and the reference explorer's own
// liveness judge agrees.
import { describe, expect, test } from "bun:test";
import { check } from "../../src/check/index.ts";
import { explore } from "../check/reference.ts";
import { wild } from "./wild.ts";

describe("specs from the wild", () => {
  for (const w of wild) {
    test(w.name, async () => {
      const spec = w.spec();
      const report = await check(spec, { depth: 60, walks: 0, maxStates: 1_000_000, timeLimit: 120_000 });
      expect(report.exhaustive).toBe(true);
      expect(report.states).toBe(w.states);
      expect(report.stuck).toBeUndefined();
      const temporal = report.properties.filter((p) => p.kind !== "reachable");
      const verdicts = Object.fromEntries(temporal.map((p) => [p.id, p.holds && !p.unfinished ? "holds" : p.holds ? "unfinished" : "broken"]));
      expect(verdicts).toEqual(w.expect);
      const reached = Object.fromEntries(report.properties.filter((p) => p.kind === "reachable").map((p) => [p.id, p.holds && p.witness ? p.witness.events.length : !p.holds && p.unreached && report.exhaustive && !report.cutAtDepth ? "never" : "unfinished"]));
      expect(reached).toEqual(w.reachable);
      expect(Object.fromEntries(explore(spec, { depth: 60, instances: {} }).liveness)).toEqual(w.expect);
      // Each counterexample replays: a way in, then a loop back to where it started.
      for (const p of temporal.filter((x) => !x.holds && !x.unreached)) {
        expect(p.loop!.events.length).toBeGreaterThan(0);
        expect(p.loop!.initial).toEqual(p.counterexample.worlds.at(-1) ?? p.counterexample.initial);
      }
    });
  }
});
