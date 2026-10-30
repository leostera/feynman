// Schemas (RFD0011): a payload's shape as a value, checked at run time, its type inferred.
import { expect, test } from "bun:test";
import { describeSchema, listOf, mismatch, nullable, oneOf, recordOf, setOf, type, type TypeOf } from "../../src/spec/index.ts";

test("each form matches what it describes, and says where a value doesn't", () => {
  const schema = { socket: Number, name: String, ok: Boolean, status: oneOf(403, 404), tags: setOf(String), chains: listOf(String), counts: recordOf(Number), cookie: nullable(String), key: { shard: String } };
  const good: TypeOf<typeof schema> = { socket: 1, name: "a", ok: true, status: 404, tags: new Set(["x"]), chains: ["h"], counts: { a: 1 }, cookie: null, key: { shard: "s" } };
  expect(mismatch(schema, good)).toBeNull();
  expect(mismatch(schema, { ...good, cookie: "c" })).toBeNull();
  expect(mismatch(schema, { ...good, socket: "1" })).toBe('socket: "1", but its schema says number');
  expect(mismatch(schema, { ...good, status: 500 })).toBe("status: 500, but its schema says one of 403, 404");
  expect(mismatch(schema, { ...good, chains: ["h", 2] })).toBe("chains[1]: 2, but its schema says string");
  expect(mismatch(schema, { ...good, tags: ["x"] })).toBe('tags: ["x"], but its schema says a set');
  expect(mismatch(schema, { ...good, counts: { a: "1" } })).toBe('counts.a: "1", but its schema says number');
  expect(mismatch(schema, { ...good, key: { shard: 1 } })).toBe("key.shard: 1, but its schema says string");
  const { name: _, ...missing } = good;
  expect(mismatch(schema, missing)).toBe("name is missing");
  expect(mismatch(schema, { ...good, extra: 1 })).toBe("extra is not in its schema");
  expect(mismatch({}, {})).toBeNull();
  expect(mismatch({ anything: type<{ deep: unknown }>() }, { anything: 42 })).toBeNull();
});

test("schemas read in words", () => {
  expect(describeSchema({ socket: Number, chains: listOf(String), status: oneOf("a", "b"), cookie: nullable(String) })).toBe('{ socket: number, chains: string[], status: "a" | "b", cookie: string | null }');
});

test("schema builders take schemas", () => {
  expect(() => listOf("string" as never)).toThrow("listOf takes a schema");
  expect(() => oneOf()).toThrow("oneOf takes the values it may be");
});
