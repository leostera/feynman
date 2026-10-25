#!/usr/bin/env node
// Validate a model: JSON Schema, cross-references, and (optionally) anchor paths.
//
// Usage: node tools/check-model.mjs <model.json> [<repository>]
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const [modelPath, repository] = process.argv.slice(2);
if (!modelPath) {
  console.error("usage: check-model <model.json> [<repository>]");
  process.exit(2);
}
const schemaPath = resolve(dirname(new URL(import.meta.url).pathname), "../skills/modelling/schema.json");
const model = JSON.parse(readFileSync(modelPath, "utf8"));
const problems = [];

const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(schemaPath, "utf8")));
if (!validate(model)) {
  for (const error of validate.errors) problems.push(`schema ${error.instancePath || "/"} ${error.message}`);
}

const collections = ["actors", "flows", "state", "stateMachines", "boundaries", "invariants", "contracts", "observability"];
const ids = new Set();
for (const name of collections) {
  for (const element of model[name] ?? []) {
    if (ids.has(element.id)) problems.push(`duplicate id ${element.id}`);
    ids.add(element.id);
  }
}
const ref = (where, id) => id !== undefined && !ids.has(id) && problems.push(`${where} → unknown id ${id}`);
for (const flow of model.flows ?? []) {
  flow.steps.forEach((step, i) => {
    for (const key of ["actor", "target", "ref", "boundary"]) ref(`flow ${flow.id} step ${i + 1} ${key}`, step[key]);
  });
}
for (const set of model.messages ?? []) ref(`messages ${set.transport}`, set.actor);
for (const state of model.state ?? []) ref(`state ${state.id} owner`, state.owner);
for (const item of model.observability ?? []) for (const id of item.flows ?? []) ref(`observability ${item.id}`, id);
(model.claims ?? []).forEach((claim, i) => {
  for (const id of claim.about ?? []) ref(`claim ${i + 1} about`, id);
});

if (repository) {
  const anchors = new Set();
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const key of ["anchors", "evidence"]) for (const anchor of value[key] ?? []) anchors.add(anchor.split("#")[0]);
      for (const footprintPath of value.footprint?.paths ?? []) anchors.add(footprintPath);
      Object.values(value).forEach(collect);
    }
  };
  collect(model);
  for (const path of anchors) if (!existsSync(join(repository, path))) problems.push(`missing path ${path}`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${modelPath}: ok`);
