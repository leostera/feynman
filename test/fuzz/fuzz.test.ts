// A fixed handful of random specs (spec.ts), checked as oracle.ts checks every one: against
// the reference explorer, with each reduction, and on several threads. Longer runs:
// `bun test/fuzz/run.ts --count 1000 [--big] [--workers 3]`.
import { afterAll, expect, test } from "bun:test";
import { Pool } from "../../src/check/index.ts";
import { fuzz } from "./oracle.ts";

const pool = new Pool(2);
afterAll(() => pool.close());

test("25 random specs: the checker agrees with the reference explorer, its reductions and itself", { timeout: 120_000 }, async () => {
  const findings = [];
  for (let seed = 1; seed <= 25; seed++) findings.push(...(await fuzz(seed)).findings);
  expect(findings).toEqual([]);
});

test("10 random specs on three threads: the same report as on one", { timeout: 120_000 }, async () => {
  const findings = [];
  for (let seed = 1001; seed <= 1010; seed++) findings.push(...(await fuzz(seed, { pool })).findings);
  expect(findings).toEqual([]);
});
