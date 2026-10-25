// Read and write a model stored as a directory of small JSON files.
//
//   model/
//     meta.json
//     actors/<id>.json  components/<id>.json  flows/<id>.json  protocols/<id>.json
//     state/<id>.json  state-machines/<id>.json  invariants/<id>.json  claims/<id>.json  limits/<id>.json
//     coverage/<batch>.json
//
// An element's id is its file name and is not repeated inside the file. Loading
// returns one object with every collection sorted by id, so anything built from
// it (the rendered HTML in particular) does not depend on directory order.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Element, KindKey, Ledger, Meta, Model } from "./types.ts";

/** An element collection: its key in a loaded model, directory, and schema name. */
export interface Kind {
  key: KindKey;
  dir: string;
  schema: string;
}

/** Collections in display order. */
export const KINDS: Kind[] = [
  { key: "journeys", dir: "journeys", schema: "journey" },
  { key: "actors", dir: "actors", schema: "actor" },
  { key: "components", dir: "components", schema: "component" },
  { key: "flows", dir: "flows", schema: "flow" },
  { key: "protocols", dir: "protocols", schema: "protocol" },
  { key: "state", dir: "state", schema: "state" },
  { key: "stateMachines", dir: "state-machines", schema: "state-machine" },
  { key: "invariants", dir: "invariants", schema: "invariant" },
  { key: "claims", dir: "claims", schema: "claim" },
  { key: "limits", dir: "limits", schema: "limit" },
];

/** Every element of a model, with its kind. */
export function elementsOf(model: Model): { kind: Kind; element: Element }[] {
  return KINDS.flatMap((kind) => model[kind.key].map((element) => ({ kind, element })));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
}

const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** `*.json` files in `dir`, as `{ name, path }` sorted by name (without `.json`). */
function jsonFiles(dir: string): { name: string; path: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ name: file.slice(0, -".json".length), path: join(dir, file) }));
}

/** Element files of one collection, as `{ id, path, value }`, sorted by id. */
export function readElements(modelDir: string, kind: Kind): { id: string; path: string; value: unknown }[] {
  return jsonFiles(join(modelDir, kind.dir)).map(({ name, path }) => ({ id: name, path, value: readJson(path) }));
}

/**
 * The whole model as one object. Files are not validated (see `checkModel`): during
 * an extraction the model is incomplete, and readers must tolerate missing fields.
 */
export function loadModel(modelDir: string): Model {
  if (!existsSync(join(modelDir, "meta.json"))) throw new Error(`${modelDir} has no meta.json`);
  const model = { meta: readJson(join(modelDir, "meta.json")) } as Model;
  for (const kind of KINDS) {
    const elements = readElements(modelDir, kind).map(({ id, value }) => ({ id, ...(value as object) }));
    (model as Record<KindKey, unknown>)[kind.key] = elements;
  }
  return model;
}

/** Write one element, dropping its `id` (the file name carries it). */
export function writeElement(modelDir: string, kind: Kind, element: Element): void {
  const { id, ...value } = element;
  mkdirSync(join(modelDir, kind.dir), { recursive: true });
  writeFileSync(join(modelDir, kind.dir, `${id}.json`), json(value));
}

export function writeMeta(modelDir: string, meta: Meta): void {
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(join(modelDir, "meta.json"), json(meta));
}

/** Coverage ledgers (`coverage/<batch>.json`), as `{ batch, path, value }`. */
export function readCoverage(modelDir: string): { batch: string; path: string; value: Ledger }[] {
  return jsonFiles(join(modelDir, "coverage")).map(({ name, path }) => ({ batch: name, path, value: readJson(path) as Ledger }));
}
