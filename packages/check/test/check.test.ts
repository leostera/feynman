import { expect, test } from "bun:test";
import { check } from "../src/index.ts";
import remoteAccess from "../../spec/test/fixtures/remote-access.ts";

test("with one fault, a Mac given a valid code can end up never linked, and the checker shows how", () => {
  const report = check(remoteAccess, { depth: 12, faults: 1 });
  const byId = Object.fromEntries(report.properties.map((p) => [p.id, p]));
  expect(byId.relayNeverStoresSecrets.holds).toBe(true);
  expect(byId.codeRedeemedOnce.holds).toBe(true);
  const links = byId.macWithValidCodeLinks;
  expect(links.holds).toBe(false);
  const example = links.counterexample!;
  // It takes a lost message…
  expect(example.events.some((e) => e.kind === "lose")).toBe(true);
  // …after which the system, left alone, never links the Mac. (The shortest such path:
  // a stale "refused" for an earlier attempt clears the pending link of the later one.)
  const end = links.then!.at(-1) ?? example.events.at(-1)!;
  expect(end.key).toBe("message:Refused");
  expect(report.errors).toEqual([]);
});

test("without faults, every redemption gets its answer and the property holds", () => {
  const report = check(remoteAccess, { depth: 10, faults: 0 });
  expect(report.properties.every((p) => p.holds)).toBe(true);
  expect(report.states).toBeGreaterThan(10);
  expect(report.coverage.reached).toContain("Axo relay.message:Redeem");
});

test("counterexamples replay: the same choices give the same events", () => {
  const report = check(remoteAccess, { depth: 12, faults: 1 });
  const example = report.properties.find((p) => !p.holds)!.counterexample!;
  expect(example.events.length).toBe(example.choices.length);
  expect(example.worlds.length).toBe(example.choices.length);
  expect(example.events.every((e) => !e.error)).toBe(true);
});
