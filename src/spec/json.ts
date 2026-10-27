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
  return write(value, "") ?? "null";
}

/**
 * A value's text, written directly (the checker writes one for every state it meets). The
 * key it is held under matters only for `$set` and `$map`: an array under one is a set's or a
 * map's members, written in the order of their text. Undefined for what JSON leaves out of an
 * object: functions and symbols, which states never hold (see unstorable).
 */
function write(v: unknown, key: string): string | undefined {
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "undefined":
      return '{"$undefined":true}';
    case "number":
      return Number.isFinite(v) && !Object.is(v, -0) ? JSON.stringify(v) : `{"$number":${JSON.stringify(Object.is(v, -0) ? "-0" : String(v))}}`;
    case "bigint":
      return `{"$bigint":${JSON.stringify(String(v))}}`;
    case "object": {
      if (v === null) return "null";
      if (v instanceof Date) return `{"$date":${JSON.stringify(Number.isNaN(v.getTime()) ? "invalid" : v.toISOString())}}`;
      if (v instanceof Set) return `{"$set":${members([...v])}}`;
      if (v instanceof Map) return `{"$map":${members([...v])}}`;
      if (Array.isArray(v)) return key === "$set" || key === "$map" ? members(v) : `[${v.map((x) => write(x, "") ?? "null").join(",")}]`;
      const parts: string[] = [];
      for (const k of keyOrder(v)) {
        const text = write((v as Record<string, unknown>)[k], k);
        if (text !== undefined) parts.push(`${JSON.stringify(k)}:${text}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      return undefined;
  }
}

/**
 * An object's keys in the order the text has always had them: integer-like keys first, in
 * numeric order (as JavaScript keeps them in any object), then the rest sorted.
 */
function keyOrder(v: object): string[] {
  const keys = Object.keys(v);
  // Object.keys lists integer-like keys first, already in numeric order.
  let integers = 0;
  while (integers < keys.length && isIndex(keys[integers])) integers++;
  if (integers === keys.length) return keys;
  return [...keys.slice(0, integers), ...keys.slice(integers).sort()];
}

function isIndex(key: string): boolean {
  const n = Number(key);
  return Number.isInteger(n) && n >= 0 && n < 2 ** 32 - 1 && String(n) === key;
}

/** A set's or a map's members, in the order of their text. */
function members(values: unknown[]): string {
  const texts = values.map((x) => write(x, "") ?? "null");
  texts.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `[${texts.join(",")}]`;
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
      // Paths are written only for what is found: the engine checks every state it makes.
      if (value === null || value instanceof Date) return undefined;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (!plain(value[i])) return unstorable(value[i], `${path}[${i}]`);
        return undefined;
      }
      if (value instanceof Set) {
        for (const v of value) if (!plain(v)) return unstorable(v, `${path} (a member)`);
        return undefined;
      }
      if (value instanceof Map) {
        for (const [k, v] of value) {
          if (!plain(k)) return unstorable(k, `${path} (a key)`);
          if (!plain(v)) return unstorable(v, `${path}.get(${String(k)})`);
        }
        return undefined;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return `${path}: an instance of ${proto?.constructor?.name ?? "a class"}`;
      const keys = Object.keys(value);
      if (keys.length === 1 && MARKERS.has(keys[0])) return `${path}: an object whose only key is ${keys[0]}, which is how a key writes another kind of value`;
      for (const k of keys) {
        const v = (value as Record<string, unknown>)[k];
        if (!plain(v)) return unstorable(v, `${path}.${k}`);
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The keys `sortedJson` writes values plain JSON loses with; a plain object made of one is refused. */
const MARKERS = new Set(["$set", "$map", "$number", "$undefined", "$bigint", "$date"]);

/** Whether a value is plain data all the way down: what `unstorable` finds nothing in, without writing paths. */
function plain(value: unknown): boolean {
  switch (typeof value) {
    case "function":
    case "symbol":
      return false;
    case "object": {
      if (value === null || value instanceof Date) return true;
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) if (!plain(value[i])) return false;
        return true;
      }
      if (value instanceof Set) {
        for (const v of value) if (!plain(v)) return false;
        return true;
      }
      if (value instanceof Map) {
        for (const [k, v] of value) if (!plain(k) || !plain(v)) return false;
        return true;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      const keys = Object.keys(value);
      if (keys.length === 1 && MARKERS.has(keys[0])) return false;
      for (const k of keys) if (!plain((value as Record<string, unknown>)[k])) return false;
      return true;
    }
    default:
      return true;
  }
}
