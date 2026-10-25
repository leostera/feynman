// Read and write a model stored as a directory of small JSON files.
//
//   model/
//     meta.json
//     actors/<id>.json  flows/<id>.json  protocols/<id>.json  state/<id>.json
//     state-machines/<id>.json  invariants/<id>.json  claims/<id>.json  limits/<id>.json
//
// An element's id is its file name and is not repeated inside the file. Loading
// returns one object with every collection sorted by id, so anything built from
// it (the rendered HTML in particular) does not depend on directory order.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A collection of elements: its key in a loaded model, directory, and schema name. */
export interface Kind {
  key: "actors" | "flows" | "protocols" | "state" | "stateMachines" | "invariants" | "claims" | "limits";
  dir: string;
  schema: string;
}

/** An element as loaded: its file's contents plus the id its file name carries. */
export type Element = { id: string } & Record<string, any>;

export type Model = { meta: Record<string, any> } & Record<Kind["key"], Element[]>;

/** Collections in display order: bundle key, directory, schema name. */
export const KINDS: Kind[] = [
  { key: "actors", dir: "actors", schema: "actor" },
  { key: "flows", dir: "flows", schema: "flow" },
  { key: "protocols", dir: "protocols", schema: "protocol" },
  { key: "state", dir: "state", schema: "state" },
  { key: "stateMachines", dir: "state-machines", schema: "state-machine" },
  { key: "invariants", dir: "invariants", schema: "invariant" },
  { key: "claims", dir: "claims", schema: "claim" },
  { key: "limits", dir: "limits", schema: "limit" },
];

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
};

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** Element files of one collection, as `{ id, path, value }`, sorted by id. */
export function readElements(modelDir: string, kind: Kind): { id: string; path: string; value: Record<string, any> }[] {
  const dir = join(modelDir, kind.dir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .sort()
    .map((id) => ({ id, path: join(dir, `${id}.json`), value: readJson(join(dir, `${id}.json`)) }));
}

/** The whole model as one object: `{ meta, actors: [{ id, … }], … }`. */
export function loadModel(modelDir: string): Model {
  if (!existsSync(join(modelDir, "meta.json"))) throw new Error(`${modelDir} has no meta.json`);
  const model = { meta: readJson(join(modelDir, "meta.json")) } as Model;
  for (const kind of KINDS) model[kind.key] = readElements(modelDir, kind).map(({ id, value }) => ({ id, ...value }));
  return model;
}

/** Write one element, dropping its `id` (the file name carries it). */
export function writeElement(modelDir: string, kind: Kind, element: Element): void {
  const { id, ...value } = element;
  mkdirSync(join(modelDir, kind.dir), { recursive: true });
  writeFileSync(join(modelDir, kind.dir, `${id}.json`), json(value));
}

export function writeMeta(modelDir: string, meta: Record<string, unknown>): void {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "meta.json"), json(meta));
}

/** Replace a model directory's contents with `model`. */
export function writeModel(modelDir: string, model: Model): void {
  writeMeta(modelDir, model.meta);
  for (const kind of KINDS) {
    rmSync(join(modelDir, kind.dir), { recursive: true, force: true });
    for (const element of model[kind.key] ?? []) writeElement(modelDir, kind, element);
  }
}

/** `read` is recorded automatically; `modelled` and `no-behaviour` come from older ledgers. */
export type Outcome = "read" | "modelled" | "no-behaviour" | "vendored" | "generated";
export interface LedgerEntry {
  path: string;
  outcome: Outcome;
  note?: string;
}
export interface Ledger {
  commit: string;
  summary: string;
  files: LedgerEntry[];
}

/** Coverage ledgers (`coverage/<batch>.json`), as `{ batch, path, value }`. */
export function readCoverage(modelDir: string): { batch: string; path: string; value: Ledger }[] {
  const dir = join(modelDir, "coverage");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ batch: name.slice(0, -".json".length), path: join(dir, name), value: readJson(join(dir, name)) }));
}
