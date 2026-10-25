// Validate a model directory: each file against its JSON Schema, cross-references
// between elements, and (with a repository) that anchors exist at the modelled commit.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { tryGit } from "./git.mjs";
import { existsSync } from "node:fs";
import { modelAnchors } from "./anchors.mjs";
export { anchoredFiles, modelAnchors, parseAnchor } from "./anchors.mjs";
import { configPath } from "./config.mjs";
import { KINDS, loadModel, readCoverage, readElements } from "./model.mjs";

export const SCHEMA_DIR = join(import.meta.dirname, "../schema");

let ajv;
function validator(schema) {
  if (!ajv) {
    ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
    addFormats(ajv);
    for (const name of readdirSync(SCHEMA_DIR)) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")));
  }
  return ajv.getSchema(`urn:feynman:${schema}`);
}

/** Problems with the model, as human-readable lines; empty when it is valid. */
export function checkModel(modelDir, repository) {
  const problems = [];
  const check = (schema, path, value) => {
    const validate = validator(schema);
    if (!validate(value)) for (const e of validate.errors) problems.push(`${relative(modelDir, path)}${e.instancePath} ${e.message}`);
  };

  let model;
  try {
    model = loadModel(modelDir);
  } catch (error) {
    return [error.message];
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
      problems.push(`${configPath(modelDir)}: ${error.message}`);
    }
  }

  // Cross-references, each to the collection it must name.
  const ids = Object.fromEntries(KINDS.map((kind) => [kind.key, new Set(model[kind.key].map((e) => e.id))]));
  const ref = (where, id, key) => {
    if (id !== undefined && !ids[key].has(id)) problems.push(`${where} → unknown ${key} ${id}`);
  };
  for (const flow of model.flows) {
    (flow.steps ?? []).forEach((step, i) => {
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
  for (const key of ["claims", "limits"]) {
    for (const element of model[key]) {
      for (const path of element.about ?? []) if (!known.has(path)) problems.push(`${key}/${element.id} about → no element ${path}`);
    }
  }

  if (repository) problems.push(...checkAnchors(model, repository));
  return problems;
}

/** Every anchor's file must exist at the modelled commit, and any span must fall inside it. */
function checkAnchors(model, repository) {
  const anchors = modelAnchors(model);
  for (const actor of model.actors) for (const path of actor.footprint?.paths ?? []) anchors.push({ file: path });

  const commit = model.meta.source?.commit ?? "HEAD";
  const lineCounts = new Map();
  const found = new Set();
  for (const { file, start, end } of anchors) {
    if (tryGit(repository, "cat-file", "-e", `${commit}:${file.replace(/\/$/, "")}`) === null) {
      found.add(`missing path ${file} at ${commit.slice(0, 7)}`);
      continue;
    }
    if (!start) continue;
    if (!lineCounts.has(file)) lineCounts.set(file, (tryGit(repository, "show", `${commit}:${file}`) ?? "").split("\n").length);
    const last = end ?? start;
    if (last < start || last > lineCounts.get(file)) found.add(`span ${start}-${last} outside ${file} (${lineCounts.get(file)} lines)`);
  }
  return [...found];
}
