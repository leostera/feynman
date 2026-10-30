// A fixed handful of random specs (spec.ts), checked as oracle.ts checks every one: against
// the reference explorer, with symmetry, and from scenario seeds. Longer runs:
// `bun test/fuzz/run.ts --count 1000 [--big]`.
import { expect, test } from "bun:test";
import { fuzz } from "./oracle.ts";

test("25 random specs: the checker agrees with the reference explorer and with itself", { timeout: 300_000 }, async () => {
  const findings = [];
  for (let seed = 1; seed <= 25; seed++) findings.push(...(await fuzz(seed)).findings);
  expect(findings).toEqual([]);
});
