// The specs from the wild against TLC on the original models: the same states, and the same
// verdict on each temporal property. Skipped when tla2tools.jar is not around (TLA_TOOLS_JAR).
import { describe, expect, test } from "bun:test";
import { feynman, TLA_JAR, tlc } from "../examples/oracle.ts";
import { wild } from "./wild.ts";

describe.skipIf(!TLA_JAR)("TLC on specs from the wild", () => {
  for (const w of wild) {
    test(w.name, async () => {
      const { module, dir, constants, specification, properties } = w.tla;
      expect(tlc(module, constants, [], { dir, temporal: { specification, properties: [] } }).distinct).toBe(w.states);
      expect((await feynman(w.spec(), { faults: 0 })).distinct).toBe(w.states);
      const theirs = Object.fromEntries(Object.entries(properties).map(([id, name]) => [id, tlc(module, constants, [], { dir, temporal: { specification, properties: [name] } }).temporal ? "broken" : "holds"]));
      expect(theirs).toEqual(w.expect);
    }, 300_000);
  }
});
