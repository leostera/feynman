// The JSON Schemas in schema/, compiled once.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SCHEMA_DIR = join(import.meta.dirname, "../schema");

let ajv: InstanceType<typeof Ajv2020> | undefined;

/** Problems with `value` against schema `urn:feynman:<name>`, as `<instance path> <message>`; empty when valid. */
export function schemaProblems(name: string, value: unknown): string[] {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
    (addFormats as unknown as (ajv: object) => void)(ajv);
    for (const file of readdirSync(SCHEMA_DIR)) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")));
  }
  const validate = ajv.getSchema(`urn:feynman:${name}`);
  if (!validate) throw new Error(`no schema urn:feynman:${name}`);
  return validate(value) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`.trim());
}
