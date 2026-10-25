#!/usr/bin/env node
// Validate a model directory: each file against its JSON Schema, cross-references
// between elements, and (with a repository) that anchors exist at the modelled commit.
//
// Usage: node tools/check-model.mjs <model-dir> [<repository>]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { KINDS, loadModel, readElements } from "./model.mjs";

const [modelDir, repository] = process.argv.slice(2);
if (!modelDir) {
  console.error("usage: check-model <model-dir> [<repository>]");
  process.exit(2);
}
const problems = [];

// Schemas: one per file kind, sharing urn:feynman:common.
const schemaDir = join(import.meta.dirname, "../skills/modelling/schema");
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true });
addFormats(ajv);
for (const name of readdirSync(schemaDir)) ajv.addSchema(JSON.parse(readFileSync(join(schemaDir, name), "utf8")));
const check = (schema, path, value) => {
  const validate = ajv.getSchema(`urn:feynman:${schema}`);
  if (!validate(value)) for (const e of validate.errors) problems.push(`${relative(modelDir, path)}${e.instancePath} ${e.message}`);
};

let model;
try {
  model = loadModel(modelDir);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
check("meta", join(modelDir, "meta.json"), model.meta);
for (const kind of KINDS) {
  for (const { id, path, value } of readElements(modelDir, kind)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`${relative(modelDir, path)}: file name is not a kebab-case id`);
    check(kind.schema, path, value);
  }
}

// Cross-references, each to the collection it must name.
const ids = Object.fromEntries(KINDS.map((kind) => [kind.key, new Set(model[kind.key].map((e) => e.id))]));
const ref = (where, id, key) => {
  if (id !== undefined && !ids[key].has(id)) problems.push(`${where} → unknown ${key} ${id}`);
};
for (const flow of model.flows) {
  flow.steps.forEach((step, i) => {
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
  for (const message of protocol.messages) ref(`protocols/${protocol.id} ${message.name} from`, message.from, "actors");
}
for (const state of model.state) ref(`state/${state.id} owner`, state.owner, "actors");
const known = new Set(KINDS.flatMap((kind) => model[kind.key].map((e) => `${kind.dir}/${e.id}`)));
for (const key of ["claims", "limits"]) {
  for (const element of model[key]) for (const path of element.about ?? []) if (!known.has(path)) problems.push(`${key}/${element.id} about → no element ${path}`);
}

if (repository) checkAnchors(repository);

if (problems.length) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
const counts = KINDS.map((kind) => `${model[kind.key].length} ${kind.key}`).join(", ");
console.log(`ok: ${counts}`);

/** Every anchor's file must exist at the modelled commit, and any span must fall inside it. */
function checkAnchors(repository) {
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
      for (const path of value.footprint?.paths ?? []) anchors.push({ file: path });
      Object.values(value).forEach(collect);
    }
  };
  collect(model);

  const commit = model.meta.source?.commit ?? "HEAD";
  const git = (...args) => {
    try {
      return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 28 });
    } catch {
      return null;
    }
  };
  const lineCounts = new Map();
  const found = new Set();
  for (const { file, start, end } of anchors) {
    if (git("cat-file", "-e", `${commit}:${file.replace(/\/$/, "")}`) === null) {
      found.add(`missing path ${file} at ${commit.slice(0, 7)}`);
      continue;
    }
    if (!start) continue;
    if (!lineCounts.has(file)) lineCounts.set(file, (git("show", `${commit}:${file}`) ?? "").split("\n").length);
    const last = end ?? start;
    if (last < start || last > lineCounts.get(file)) found.add(`span ${start}-${last} outside ${file} (${lineCounts.get(file)} lines)`);
  }
  problems.push(...found);
}
