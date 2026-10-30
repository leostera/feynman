// Schemas (RFD0011): what a payload or an input holds, as a value. The checker reads them at run
// time, to check every payload sent, and their TypeScript types are inferred from them, so a
// payload is described once.

declare const TYPE: unique symbol;

/** A schema built by `oneOf`, `listOf`, `setOf`, `recordOf`, `nullable` or `type`. */
export interface Shaped<T> {
  readonly schema: "oneOf" | "list" | "set" | "record" | "nullable" | "type";
  /** Phantom: the type it describes. */
  readonly [TYPE]?: T;
}

/** A schema: a constructor, a nested object of schemas, or one built by the functions below. */
export type Schema = StringConstructor | NumberConstructor | BooleanConstructor | Shaped<unknown> | { readonly [field: string]: Schema };

/** An object of field schemas: a payload's schema. */
export type Fields = { readonly [field: string]: Schema };

/** The type a schema describes. */
export type TypeOf<S> = S extends StringConstructor
  ? string
  : S extends NumberConstructor
    ? number
    : S extends BooleanConstructor
      ? boolean
      : S extends Shaped<infer T>
        ? T
        : S extends { readonly [field: string]: Schema }
          ? { -readonly [K in keyof S]: TypeOf<S[K]> }
          : never;

interface OneOf<T> extends Shaped<T> {
  readonly schema: "oneOf";
  readonly values: readonly T[];
}
interface Of<T> extends Shaped<T> {
  readonly schema: "list" | "set" | "record" | "nullable";
  readonly of: Schema;
}

/** One of these values: `oneOf("yes", "no")` is `"yes" | "no"`. */
export function oneOf<const T extends string | number | boolean>(...values: T[]): OneOf<T> {
  if (values.length === 0) throw new Error("oneOf takes the values it may be, like oneOf(\"yes\", \"no\")");
  return { schema: "oneOf", values } as OneOf<T>;
}
/** A list: `listOf(String)` is `string[]`. */
export function listOf<S extends Schema>(item: S): Of<TypeOf<S>[]> {
  return { schema: "list", of: schemaOf(item, "listOf") } as Of<TypeOf<S>[]>;
}
/** A set: `setOf(String)` is `Set<string>`. */
export function setOf<S extends Schema>(item: S): Of<Set<TypeOf<S>>> {
  return { schema: "set", of: schemaOf(item, "setOf") } as Of<Set<TypeOf<S>>>;
}
/** A record keyed by strings: `recordOf(Number)` is `Record<string, number>`. */
export function recordOf<S extends Schema>(value: S): Of<Record<string, TypeOf<S>>> {
  return { schema: "record", of: schemaOf(value, "recordOf") } as Of<Record<string, TypeOf<S>>>;
}
/** The schema's type, or null. */
export function nullable<S extends Schema>(of: S): Of<TypeOf<S> | null> {
  return { schema: "nullable", of: schemaOf(of, "nullable") } as Of<TypeOf<S> | null>;
}
/** Any TypeScript type, for what a schema can't say. It is not checked at run time. */
export function type<T>(): Shaped<T> {
  return { schema: "type" } as Shaped<T>;
}

function schemaOf<S>(schema: S, where: string): S {
  if (!isSchema(schema)) throw new Error(`${where} takes a schema (String, Number, Boolean, oneOf(…), listOf(…), an object of fields…), not ${describeValue(schema)}`);
  return schema;
}

export function isSchema(value: unknown): value is Schema {
  if (value === String || value === Number || value === Boolean) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if ("schema" in value && typeof (value as { schema: unknown }).schema === "string") return true;
  return Object.values(value).every(isSchema);
}

/**
 * Where `value` doesn't match `schema`, in words ("payment: 1, but its schema says string"),
 * or null when it matches. Objects must have exactly their schema's fields.
 */
export function mismatch(schema: Schema, value: unknown, path = ""): string | null {
  const at = (what: string) => `${path ? `${path}: ` : ""}${what}`;
  const wrong = (expected: string) => at(`${describeValue(value)}, but its schema says ${expected}`);
  if (schema === String) return typeof value === "string" ? null : wrong("string");
  if (schema === Number) return typeof value === "number" ? null : wrong("number");
  if (schema === Boolean) return typeof value === "boolean" ? null : wrong("boolean");
  if ("schema" in schema && typeof schema.schema === "string") {
    const shaped = schema as OneOf<unknown> | Of<unknown> | Shaped<unknown>;
    switch (shaped.schema) {
      case "type":
        return null;
      case "oneOf": {
        const values = (shaped as OneOf<unknown>).values;
        return values.includes(value) ? null : wrong(`one of ${values.map((v) => JSON.stringify(v)).join(", ")}`);
      }
      case "nullable":
        return value === null ? null : mismatch((shaped as Of<unknown>).of, value, path);
      case "list": {
        if (!Array.isArray(value)) return wrong("a list");
        for (const [i, item] of value.entries()) {
          const found = mismatch((shaped as Of<unknown>).of, item, `${path}[${i}]`);
          if (found) return found;
        }
        return null;
      }
      case "set": {
        if (!(value instanceof Set)) return wrong("a set");
        for (const item of value) {
          const found = mismatch((shaped as Of<unknown>).of, item, `${path}{}`);
          if (found) return found;
        }
        return null;
      }
      case "record": {
        if (!isPlainObject(value)) return wrong("a record");
        for (const [key, item] of Object.entries(value)) {
          const found = mismatch((shaped as Of<unknown>).of, item, path ? `${path}.${key}` : key);
          if (found) return found;
        }
        return null;
      }
    }
  }
  const fields = schema as Fields;
  if (!isPlainObject(value)) return wrong(`an object with ${Object.keys(fields).join(", ") || "no fields"}`);
  for (const [key, field] of Object.entries(fields)) {
    const inner = path ? `${path}.${key}` : key;
    if (!(key in value)) return `${inner} is missing`;
    const found = mismatch(field, (value as Record<string, unknown>)[key], inner);
    if (found) return found;
  }
  for (const key of Object.keys(value)) if (!(key in fields)) return `${path ? `${path}.` : ""}${key} is not in its schema`;
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "a function";
  if (value instanceof Set) return "a set";
  try {
    const json = JSON.stringify(value);
    return json.length > 40 ? `${json.slice(0, 37)}…` : json;
  } catch {
    return String(value);
  }
}

/** A schema in words, for the views: `{ socket: number, chains: string[] }`. */
export function describeSchema(schema: Schema): string {
  if (schema === String) return "string";
  if (schema === Number) return "number";
  if (schema === Boolean) return "boolean";
  if ("schema" in schema && typeof schema.schema === "string") {
    const shaped = schema as OneOf<unknown> | Of<unknown> | Shaped<unknown>;
    switch (shaped.schema) {
      case "type":
        return "unchecked";
      case "oneOf":
        return (shaped as OneOf<unknown>).values.map((v) => JSON.stringify(v)).join(" | ");
      case "nullable":
        return `${describeSchema((shaped as Of<unknown>).of)} | null`;
      case "list":
        return `${describeSchema((shaped as Of<unknown>).of)}[]`;
      case "set":
        return `Set<${describeSchema((shaped as Of<unknown>).of)}>`;
      case "record":
        return `Record<string, ${describeSchema((shaped as Of<unknown>).of)}>`;
    }
  }
  const fields = Object.entries(schema as Fields);
  return fields.length ? `{ ${fields.map(([k, v]) => `${k}: ${describeSchema(v)}`).join(", ")} }` : "{}";
}
