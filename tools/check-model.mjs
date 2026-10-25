#!/usr/bin/env node
// Validate a model: JSON Schema, cross-references, and (optionally) anchor paths.
//
// Usage: node tools/check-model.mjs <model.json> [<repository>]
import { execFileSync } from "node:child_process";
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
  // Every anchor's file must exist, and any span must fall inside it.
  const SHORTHAND = /^([^#:]+)(?::(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?)?(?:#.+)?$/;
  const parse = (anchor) => {
    if (typeof anchor !== "string") return { file: anchor.file, start: anchor.span?.start.line, end: anchor.span?.end?.line };
    const [, file, start, end] = SHORTHAND.exec(anchor) ?? [null, anchor];
    return { file, start: start && Number(start), end: end && Number(end) };
  };
  const anchors = [];
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      for (const key of ["anchors", "evidence", "tests", "definitions"]) for (const anchor of value[key] ?? []) anchors.push(parse(anchor));
      if (value.anchor) anchors.push(parse(value.anchor));
      for (const footprintPath of value.footprint?.paths ?? []) anchors.push({ file: footprintPath });
      Object.values(value).forEach(collect);
    }
  };
  collect(model);
  const lineCounts = new Map();
  const found = new Set();
  // Read files at the modelled commit when known; the working tree may have moved on.
  const commit = model.meta?.source?.commit;
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
    } catch {
      return null;
    }
  };
  const exists = (file) => (commit ? git("cat-file", "-e", `${commit}:${file.replace(/\/$/, "")}`) !== null : existsSync(join(repository, file)));
  const contents = (file) => (commit ? git("show", `${commit}:${file}`) : readFileSync(join(repository, file), "utf8"));
  for (const { file, start, end } of anchors) {
    if (!exists(file)) {
      found.add(`missing path ${file}`);
      continue;
    }
    if (!start) continue;
    if (!lineCounts.has(file)) lineCounts.set(file, (contents(file) ?? "").split("\n").length);
    const last = end ?? start;
    if (last < start || last > lineCounts.get(file)) found.add(`span ${start}-${last} outside ${file} (${lineCounts.get(file)} lines)`);
  }
  problems.push(...found);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`${modelPath}: ok`);
