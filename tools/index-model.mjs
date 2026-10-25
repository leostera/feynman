#!/usr/bin/env node
// Print a one-line-per-element overview of a model directory, so an agent can see
// what exists without loading every file.
//
// Usage: node tools/index-model.mjs <model-dir> [<kind>…]
import { KINDS, loadModel } from "./model.mjs";

const [modelDir, ...only] = process.argv.slice(2);
if (!modelDir) {
  console.error(`usage: index-model <model-dir> [${KINDS.map((kind) => kind.dir).join("|")}]…`);
  process.exit(2);
}
const model = loadModel(modelDir);
const oneLine = (text = "") => (text.length > 120 ? `${text.slice(0, 117)}…` : text).replace(/\s+/g, " ");
const describe = (e) => e.summary ?? e.statement ?? (e.subject && `${e.subject}: ${e.value}`) ?? "";

console.log(`${model.meta.system} @ ${model.meta.source.commit.slice(0, 7)}: ${oneLine(model.meta.summary)}`);
for (const kind of KINDS) {
  if (only.length && !only.includes(kind.dir) && !only.includes(kind.key)) continue;
  console.log(`\n${kind.dir}/ (${model[kind.key].length})`);
  for (const element of model[kind.key]) console.log(`  ${element.id}  ${oneLine(describe(element))}`);
}
