// State identity, tested as a property: two values have the same key text exactly when they
// are the same value. Values are generated at random (from a fixed seed), along with copies
// built in another order and near misses, and judged against `same`, an independent
// structural equality written for this test.
import { expect, test } from "bun:test";
import { symmetricKey, symmetryOf } from "../../src/check/index.ts";
import { defineSpec, emptyWorld, spawn, type World } from "../../src/spec/index.ts";
import { sortedJson, unstorable } from "../../src/spec/json.ts";

/** A small seeded generator, so a failure is the same failure next time. */
function random(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)];
  const shuffle = <T>(xs: T[]): T[] => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  return { next, int, pick, shuffle };
}

type R = ReturnType<typeof random>;

const LEAVES: readonly unknown[] = [0, 1, 2, -0, 0.5, NaN, Infinity, -Infinity, "", "a", "b", "replica-a", "0", "null", true, false, null, undefined, 1n, 2n, new Date(0), new Date(1), new Date(NaN)];
const KEYS = ["a", "b", "c", "0", "1", "replica-a", "replica-b"];

/** A random value, at most `depth` deep. */
function value(r: R, depth: number): unknown {
  if (depth === 0 || r.next() < 0.35) return r.pick(LEAVES);
  const size = r.int(4);
  switch (r.int(4)) {
    case 0:
      return Array.from({ length: size }, () => value(r, depth - 1));
    case 1:
      return Object.fromEntries(Array.from({ length: size }, () => [r.pick(KEYS), value(r, depth - 1)]));
    case 2:
      return new Set(Array.from({ length: size }, () => value(r, depth - 1)));
    default:
      return new Map(Array.from({ length: size }, () => [value(r, depth - 1), value(r, depth - 1)] as const));
  }
}

/** The same value, built again with keys, members and entries in another order. */
function reordered(r: R, v: unknown): unknown {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map((x) => reordered(r, x));
  if (v instanceof Set) return new Set(r.shuffle([...v]).map((x) => reordered(r, x)));
  if (v instanceof Map) return new Map(r.shuffle([...v]).map(([k, x]) => [reordered(r, k), reordered(r, x)] as const));
  if (v && typeof v === "object") return Object.fromEntries(r.shuffle(Object.entries(v)).map(([k, x]) => [k, reordered(r, x)]));
  return v;
}

/** A value one small change away, which may or may not still be the same. */
function nearMiss(r: R, v: unknown): unknown {
  if (Array.isArray(v) && v.length && r.next() < 0.7) {
    const i = r.int(v.length);
    return v.map((x, j) => (j === i ? nearMiss(r, x) : x));
  }
  if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof Set) && !(v instanceof Map) && Object.keys(v).length && r.next() < 0.7) {
    const k = r.pick(Object.keys(v));
    return { ...v, [k]: nearMiss(r, (v as Record<string, unknown>)[k]) };
  }
  return r.pick(LEAVES);
}

/** Structural equality, as a spec means it: sets and maps unordered, NaN equal to itself, 0 not -0, a missing key not an undefined one. */
function same(a: unknown, b: unknown): boolean {
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object" || a === null || b === null) return Object.is(a, b);
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (a instanceof Set || b instanceof Set) return a instanceof Set && b instanceof Set && sameBag([...a], [...b], same);
  if (a instanceof Map || b instanceof Map) return a instanceof Map && b instanceof Map && sameBag([...a], [...b], (x, y) => same(x[0], y[0]) && same(x[1], y[1]));
  const [ka, kb] = [Object.keys(a).sort(), Object.keys(b as object).sort()];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function sameBag<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean): boolean {
  if (a.length !== b.length) return false;
  const left = [...b];
  return a.every((x) => {
    const i = left.findIndex((y) => eq(x, y));
    return i >= 0 && (left.splice(i, 1), true);
  });
}

test("two values have the same key text exactly when they are the same value", () => {
  const r = random(20261027);
  let equal = 0;
  let different = 0;
  for (let n = 0; n < 20_000; n++) {
    const a = value(r, 3);
    const b = r.pick([() => reordered(r, a), () => nearMiss(r, a), () => value(r, 3)])();
    const agree = sortedJson(a) === sortedJson(b);
    if (agree !== same(a, b)) throw new Error(`key text ${agree ? "matches" : "differs"} for ${Bun.inspect(a)} and ${Bun.inspect(b)}`);
    if (agree) equal++;
    else different++;
  }
  // Both sides of the property were exercised, plenty.
  expect(equal).toBeGreaterThan(5_000);
  expect(different).toBeGreaterThan(5_000);
});

test("only plain data is storable", () => {
  expect(unstorable({ a: [1, new Set([new Map([[1, new Date(0)]])])], b: undefined, c: NaN, d: 1n }, "state")).toBeUndefined();
  expect(unstorable({ a: { f: () => 1 } }, "state")).toBe("state.a.f: a function");
  expect(unstorable([new (class Point {})()], "payload")).toBe("payload[0]: an instance of Point");
  expect(unstorable(new Set([Symbol("x")]), "state")).toBe("state (a member): a symbol");
  expect(unstorable({ $set: [1] }, "state")).toContain("whose only key is $set");
});

/** The same value with two names swapped wherever they appear whole: in strings, keys, members. */
function swapped(v: unknown, a: string, b: string): unknown {
  const name = (x: string) => (x === a ? b : x === b ? a : x);
  if (typeof v === "string") return name(v);
  if (v instanceof Date || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => swapped(x, a, b));
  if (v instanceof Set) return new Set([...v].map((x) => swapped(x, a, b)));
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [swapped(k, a, b), swapped(x, a, b)] as const));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [name(k), swapped(x, a, b)]));
}

test("two worlds that are renamings of each other have the same key under symmetry, and only those", () => {
  const spec = defineSpec("twins", { messages: {} }, (spec) => {
    const zone = spec.defineZone({ name: "Z" });
    const Replica = spec.defineActor({ name: "Replica", zone, symmetric: true, initialState: () => ({ v: null as unknown }) });
    return { Replica };
  });
  let world = emptyWorld();
  for (const label of ["A", "B"]) world = spawn(spec, world, "Replica", label).world;
  const [a, b] = world.instances.map((i) => i.id);
  expect([a, b]).toEqual(["replica-a", "replica-b"]);
  const symmetry = symmetryOf(spec, world);
  const holding = (va: unknown, vb: unknown): World => ({ ...world, instances: [{ ...world.instances[0], state: { v: va } }, { ...world.instances[1], state: { v: vb } }] });
  const r = random(7);
  let twins = 0;
  for (let n = 0; n < 5_000; n++) {
    const [va, vb] = [value(r, 3), value(r, 3)];
    // A holding va and B holding vb is B holding va and A holding vb, with the names swapped.
    const twin = holding(swapped(reordered(r, vb), a, b), swapped(reordered(r, va), a, b));
    if (symmetricKey(holding(va, vb), symmetry) !== symmetricKey(twin, symmetry)) throw new Error(`twins keyed apart: ${Bun.inspect([va, vb])}`);
    twins++;
    // And a near miss is a twin only if it is the same world, or a renaming of it.
    const other = holding(nearMiss(r, va), vb);
    const isTwin = same([va, vb], [(other.instances[0].state as { v: unknown }).v, vb]) || same([va, vb], [swapped(vb, a, b), swapped((other.instances[0].state as { v: unknown }).v, a, b)]);
    if ((symmetricKey(holding(va, vb), symmetry) === symmetricKey(other, symmetry)) !== isTwin) throw new Error(`keys disagree with twins for ${Bun.inspect([va, vb])} and ${Bun.inspect(other.instances.map((i) => i.state))}`);
  }
  expect(twins).toBe(5_000);
});
