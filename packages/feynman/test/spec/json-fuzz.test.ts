// sortedJson and clone against random values: the text must be what the original
// implementation (JSON.stringify with a sorting replacer, kept here as the oracle) writes, and
// a clone must have the same text without sharing anything that can change.
import { expect, test } from "bun:test";
import { clone } from "../../src/spec/engine.ts";
import { sortedJson } from "../../src/spec/json.ts";

function oracle(value: unknown): string {
  return JSON.stringify(value, replacer) ?? "null";
}

function replacer(this: unknown, key: string, v: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key];
  if (raw instanceof Date) return { $date: Number.isNaN(raw.getTime()) ? "invalid" : raw.toISOString() };
  switch (typeof v) {
    case "undefined":
      return { $undefined: true };
    case "number":
      return Number.isFinite(v) && !Object.is(v, -0) ? v : { $number: Object.is(v, -0) ? "-0" : String(v) };
    case "bigint":
      return { $bigint: String(v) };
    case "object":
      if (v === null) return v;
      if (v instanceof Set) return { $set: [...v] };
      if (v instanceof Map) return { $map: [...v] };
      if (Array.isArray(v)) return key === "$set" || key === "$map" ? byText(v) : v;
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    default:
      return v;
  }
}

function byText(values: unknown[]): unknown[] {
  const keyed = values.map((v) => [oracle(v), v] as const);
  keyed.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return keyed.map(([, v]) => v);
}

/** A seeded generator of plain data, with every kind sortedJson writes specially. */
function values(seed: number) {
  let s = seed >>> 0 || 1;
  const random = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x6d2b79f5) >>> 0) / 2 ** 32);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)];
  const KEYS = ["a", "b", "z", "A", "é", "$set", "$map", "10", "2", "", "key with space", "\u0000"];
  const value = (depth: number): unknown => {
    const kind = depth > 3 ? pick(["n", "s", "b"]) : pick(["n", "s", "b", "o", "a", "set", "map", "special", "date", "o", "a"]);
    switch (kind) {
      case "n":
        return pick([0, 1, -1, 2.5, 1e21, 1e-7, 2 ** 53, -0, NaN, Infinity, -Infinity, Math.floor(random() * 100)]);
      case "s":
        return pick(["", "x", "y", "with \"quotes\"", "new\nline", "ünïcödé", "\u2028", "{\"$set\":[]}", String(random())]);
      case "b":
        return random() < 0.5;
      case "special":
        return pick([null, undefined, 12n, -3n]);
      case "date":
        return pick([new Date(0), new Date(1_700_000_000_000), new Date(NaN)]);
      case "a":
        return Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1));
      case "set":
        return new Set(Array.from({ length: Math.floor(random() * 4) }, () => value(depth + 1)));
      case "map":
        return new Map(Array.from({ length: Math.floor(random() * 3) }, () => [value(depth + 2), value(depth + 1)]));
      default: {
        const out: Record<string, unknown> = {};
        for (let i = Math.floor(random() * 4); i > 0; i--) out[pick(KEYS)] = value(depth + 1);
        return out;
      }
    }
  };
  return () => value(0);
}

test("sortedJson writes what the original implementation wrote, for 20,000 random values", () => {
  const next = values(1);
  for (let i = 0; i < 20_000; i++) {
    const v = next();
    expect(sortedJson(v)).toBe(oracle(v));
  }
});

test("a clone has the same text and shares nothing changeable", () => {
  const next = values(2);
  const shared = (a: unknown, b: unknown): boolean => {
    if (a === null || typeof a !== "object") return false;
    if (a === b) return true;
    if (a instanceof Set) return [...a].some((x, i) => shared(x, [...(b as Set<unknown>)][i]));
    if (a instanceof Map) return [...a].some(([k, x], i) => shared(k, [...(b as Map<unknown, unknown>).keys()][i]) || shared(x, [...(b as Map<unknown, unknown>).values()][i]));
    return Object.keys(a).some((k) => shared((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  };
  for (let i = 0; i < 5_000; i++) {
    const v = next();
    const c = clone(v);
    expect(sortedJson(c)).toBe(sortedJson(v));
    expect(shared(v, c)).toBe(false);
  }
});
