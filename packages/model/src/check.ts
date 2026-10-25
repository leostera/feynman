// Validate a model directory: each file against its JSON Schema, cross-references
// between elements, and (with a repository) that anchors exist at the modelled commit.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { existsSync } from "node:fs";
import { tryGit } from "./git.ts";
import { modelAnchors, type ParsedAnchor } from "./anchors.ts";
export { anchoredFiles, modelAnchors, parseAnchor } from "./anchors.ts";
import { configPath } from "./config.ts";
import { KINDS, loadModel, readCoverage, readElements, type Kind, type Model } from "./model.ts";

export const SCHEMA_DIR = join(import.meta.dirname, "../schema");

let ajv: InstanceType<typeof Ajv2020> | undefined;
function validator(schema: string) {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
    (addFormats as unknown as (ajv: object) => void)(ajv);
    for (const name of readdirSync(SCHEMA_DIR)) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")));
  }
  const validate = ajv.getSchema(`urn:feynman:${schema}`);
  if (!validate) throw new Error(`no schema urn:feynman:${schema}`);
  return validate;
}

/** Problems with the model, as human-readable lines; empty when it is valid. */
export function checkModel(modelDir: string, repository?: string): string[] {
  const problems: string[] = [];
  const check = (schema: string, path: string, value: unknown) => {
    const validate = validator(schema);
    if (!validate(value)) for (const e of validate.errors ?? []) problems.push(`${relative(modelDir, path)}${e.instancePath} ${e.message}`);
  };

  let model: Model;
  try {
    model = loadModel(modelDir);
  } catch (error) {
    return [(error as Error).message];
  }
  check("meta", join(modelDir, "meta.json"), model.meta);
  for (const kind of KINDS) {
    for (const { id, path, value } of readElements(modelDir, kind)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`${relative(modelDir, path)}: file name is not a kebab-case id`);
      check(kind.schema, path, value);
    }
  }
  for (const { path, value } of readCoverage(modelDir)) check("coverage", path, value);
  if (existsSync(configPath(modelDir))) {
    try {
      check("config", configPath(modelDir), JSON.parse(readFileSync(configPath(modelDir), "utf8")));
    } catch (error) {
      problems.push(`${configPath(modelDir)}: ${(error as Error).message}`);
    }
  }

  // Cross-references, each to the collection it must name.
  const ids = Object.fromEntries(KINDS.map((kind) => [kind.key, new Set(model[kind.key].map((e) => e.id))])) as Record<Kind["key"], Set<string>>;
  const ref = (where: string, id: string | undefined, key: Kind["key"]) => {
    if (id !== undefined && !ids[key].has(id)) problems.push(`${where} → unknown ${key} ${id}`);
  };
  for (const flow of model.flows) {
    (flow.steps ?? []).forEach((step: Record<string, string>, i: number) => {
      const at = `flows/${flow.id} step ${i + 1}`;
      ref(`${at} actor`, step.actor, "actors");
      ref(`${at} target`, step.target, "actors");
      ref(`${at} ref`, step.ref, "flows");
      ref(`${at} protocol`, step.protocol, "protocols");
    });
  }
  for (const protocol of model.protocols) {
    ref(`protocols/${protocol.id} server`, protocol.server, "actors");
    for (const id of protocol.clients ?? []) ref(`protocols/${protocol.id} clients`, id, "actors");
    for (const message of protocol.messages ?? []) ref(`protocols/${protocol.id} ${message.name} from`, message.from, "actors");
  }
  for (const state of model.state) ref(`state/${state.id} owner`, state.owner, "actors");
  const known = new Set(KINDS.flatMap((kind) => model[kind.key].map((e) => `${kind.dir}/${e.id}`)));
  for (const key of ["claims", "limits"] as const) {
    for (const element of model[key]) {
      for (const path of element.about ?? []) if (!known.has(path)) problems.push(`${key}/${element.id} about → no element ${path}`);
    }
  }

  if (repository) problems.push(...checkAnchors(model, repository));
  return problems;
}

/** Every anchor's file must exist at the modelled commit, and any span must fall inside it. */
function checkAnchors(model: Model, repository: string): string[] {
  const anchors: ParsedAnchor[] = modelAnchors(model);
  for (const actor of model.actors) for (const path of actor.footprint?.paths ?? []) anchors.push({ file: path });

  const commit: string = model.meta.source?.commit ?? "HEAD";
  const lineCounts = new Map<string, number>();
  const found = new Set<string>();
  for (const { file, start, end } of anchors) {
    if (tryGit(repository, "cat-file", "-e", `${commit}:${file.replace(/\/$/, "")}`) === null) {
      found.add(`missing path ${file} at ${commit.slice(0, 7)}`);
      continue;
    }
    if (!start) continue;
    if (!lineCounts.has(file)) lineCounts.set(file, (tryGit(repository, "show", `${commit}:${file}`) ?? "").split("\n").length);
    const last = end ?? start;
    if (last < start || last > lineCounts.get(file)!) found.add(`span ${start}-${last} outside ${file} (${lineCounts.get(file)} lines)`);
  }
  return [...found];
}
