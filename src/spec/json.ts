// JSON that is the same for the same value: what tells states apart, and changes from no change.

/**
 * JSON with every object's keys in order, and sets and maps by what they hold, in order too
 * (plain JSON writes both as `{}`, which would make every set the same state). A set is
 * `{"$set": [...]}` and a map `{"$map": [[k, v], ...]}`; they are sorted again when read back
 * from a renamed key, where the names they hold may have changed places.
 */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, sortReplacer) ?? "null";
}

function sortReplacer(this: unknown, key: string, v: unknown): unknown {
  if (v instanceof Set) return { $set: [...v] };
  if (v instanceof Map) return { $map: [...v] };
  if (key === "$set" && Array.isArray(v)) return [...v].sort(byText);
  if (key === "$map" && Array.isArray(v)) return [...v].sort((a, b) => byText(a[0], b[0]));
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
  return v;
}

function byText(a: unknown, b: unknown): number {
  const [x, y] = [sortedJson(a), sortedJson(b)];
  return x < y ? -1 : x > y ? 1 : 0;
}
