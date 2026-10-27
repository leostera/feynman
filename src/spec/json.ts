// What tells states apart: JSON that is the same exactly when two values are the same.
//
// States and payloads are plain data: strings, numbers, booleans, null, undefined, arrays,
// plain objects, sets, maps, dates and bigints. Plain JSON is not enough to tell them apart:
// it writes every set and map as `{}`, NaN and the infinities as `null`, and drops undefined
// fields. `sortedJson` writes each so that different values never share text, and the same
// value always has the same text, whatever order its keys or members came in. `unstorable`
// finds what is not plain data (a function, a class instance), which the engine refuses.

/**
 * The text of a value. Objects have their keys in order. Values plain JSON loses are written
 * as one-key objects: `{"$set": [...]}`, `{"$map": [[k, v], ...]}` (both sorted, and sorted
 * again when read back from a renamed key, where the names they hold may have changed places),
 * `{"$number": "NaN"}`, `{"$undefined": true}`, `{"$bigint": "12"}`, `{"$date": "..."}`.
 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer) ?? "null";
}

function sortReplacer(this: unknown, key: string, v: unknown): unknown {
  // A date has already become its toJSON text (null, if invalid); the holder still has the date.
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

/** Members in the order of their text. Sorted as pairs: Array.sort puts undefined last without asking. */
function byText(values: unknown[]): unknown[] {
  const keyed = values.map((v) => [sortedJson(v), v] as const);
  keyed.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return keyed.map(([, v]) => v);
}

/**
 * Where a value holds something that is not plain data, and what: `"state.handler: a
 * function"`. Undefined when it is all plain data. Such a value cannot be told apart from
 * another or copied faithfully, so the engine refuses it in states and payloads.
 */
export function unstorable(value: unknown, path: string): string | undefined {
  switch (typeof value) {
    case "function":
      return `${path}: a function`;
    case "symbol":
      return `${path}: a symbol`;
    case "object": {
      if (value === null || value instanceof Date) return undefined;
      if (Array.isArray(value)) return firstOf(value.map((v, i) => () => unstorable(v, `${path}[${i}]`)));
      if (value instanceof Set) return firstOf([...value].map((v) => () => unstorable(v, `${path} (a member)`)));
      if (value instanceof Map) return firstOf([...value].flatMap(([k, v]) => [() => unstorable(k, `${path} (a key)`), () => unstorable(v, `${path}.get(${String(k)})`)]));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return `${path}: an instance of ${proto?.constructor?.name ?? "a class"}`;
      const keys = Object.keys(value);
      if (keys.length === 1 && MARKERS.has(keys[0])) return `${path}: an object whose only key is ${keys[0]}, which is how a key writes another kind of value`;
      return firstOf(Object.keys(value).map((k) => () => unstorable((value as Record<string, unknown>)[k], `${path}.${k}`)));
    }
    default:
      return undefined;
  }
}

/** The keys `sortedJson` writes values plain JSON loses with; a plain object made of one is refused. */
const MARKERS = new Set(["$set", "$map", "$number", "$undefined", "$bigint", "$date"]);

function firstOf(checks: (() => string | undefined)[]): string | undefined {
  for (const check of checks) {
    const found = check();
    if (found) return found;
  }
  return undefined;
}
