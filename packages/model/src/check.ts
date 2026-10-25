// Validate a model directory: each file against its JSON Schema, references between
// elements, and (with a repository) that anchors exist in the modelled snapshot.
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { modelAnchors } from "./anchors.ts";
import { readConfig } from "./config.ts";
import { KINDS, loadModel, readCoverage, readElements } from "./model.ts";
import { schemaProblems } from "./schema.ts";
import { existsInSnapshot, readInSnapshot, snapshotOf } from "./snapshot.ts";
import type { KindKey, Model, ResolvedAnchor } from "./types.ts";

export { SCHEMA_DIR } from "./schema.ts";

/** Problems with the model, as human-readable lines; empty when it is valid. */
export function checkModel(modelDir: string, repository?: string): string[] {
  let model: Model;
  try {
    model = loadModel(modelDir);
  } catch (error) {
    return [(error as Error).message];
  }
  return [...checkFiles(modelDir, model), ...checkReferences(model), ...(repository ? checkAnchors(model, repository) : [])];
}

/**
 * Problems with one file of the model (`file` relative to the model directory): its
 * JSON, its schema, and its name. Null when the file is not part of the model.
 * References to other elements are checked with the whole model.
 */
export function checkModelFile(modelDir: string, file: string): string[] | null {
  const [dir, name, extra] = file.split("/");
  const schema = file === "meta.json" ? "meta" : extra === undefined && name?.endsWith(".json") ? KINDS.find((kind) => kind.dir === dir)?.schema : undefined;
  if (!schema) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(modelDir, file), "utf8"));
  } catch (error) {
    return [`not valid JSON: ${(error as Error).message}`];
  }
  const problems = schemaProblems(schema, value);
  if (name && !/^[a-z0-9][a-z0-9-]*\.json$/.test(name)) problems.push("file name is not a kebab-case id");
  return problems;
}

/** Every file against its schema, and element file names as ids. */
function checkFiles(modelDir: string, model: Model): string[] {
  const problems: string[] = [];
  const check = (schema: string, path: string, value: unknown) => {
    for (const problem of schemaProblems(schema, value)) problems.push(`${relative(modelDir, path)}${problem.startsWith("/") ? "" : " "}${problem}`);
  };
  check("meta", join(modelDir, "meta.json"), model.meta);
  for (const kind of KINDS) {
    for (const { id, path, value } of readElements(modelDir, kind)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`${relative(modelDir, path)}: file name is not a kebab-case id`);
      check(kind.schema, path, value);
    }
  }
  for (const { path, value } of readCoverage(modelDir)) check("coverage", path, value);
  try {
    readConfig(modelDir);
  } catch (error) {
    problems.push((error as Error).message);
  }
  return problems;
}

/** Every reference names an element of the kind it must name. */
function checkReferences(model: Model): string[] {
  const problems: string[] = [];
  const ids = Object.fromEntries(KINDS.map((kind) => [kind.key, new Set(model[kind.key].map((element) => element.id))])) as Record<KindKey, Set<string>>;
  const ref = (where: string, id: string | undefined, key: KindKey) => {
    if (id !== undefined && !ids[key].has(id)) problems.push(`${where} → unknown ${key} ${id}`);
  };
  for (const flow of model.flows) {
    (flow.steps ?? []).forEach((step, i) => {
      const at = `flows/${flow.id} step ${i + 1}`;
      ref(`${at} actor`, step.actor, "actors");
      ref(`${at} target`, step.target, "actors");
      ref(`${at} component`, step.component, "components");
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
  for (const actor of model.actors) for (const id of actor.talksTo ?? []) ref(`actors/${actor.id} talksTo`, id, "actors");
  for (const component of model.components) {
    for (const id of component.actors ?? []) ref(`components/${component.id} actors`, id, "actors");
    for (const id of component.dependsOn ?? []) ref(`components/${component.id} dependsOn`, id, "components");
  }
  const paths = new Set(KINDS.flatMap((kind) => model[kind.key].map((element) => `${kind.dir}/${element.id}`)));
  const about = (where: string, targets: string[] = []) => {
    for (const path of targets) if (!paths.has(path)) problems.push(`${where} about → no element ${path}`);
  };
  for (const claim of model.claims) about(`claims/${claim.id}`, claim.about);
  for (const limit of model.limits) about(`limits/${limit.id}`, limit.about);
  return problems;
}

/** Every anchored file exists in the snapshot, and every span falls inside its file. */
function checkAnchors(model: Model, repository: string): string[] {
  const footprints = model.components.flatMap((component) => component.footprint?.paths ?? []).map((file): ResolvedAnchor => ({ file }));
  const anchors = [...modelAnchors(model), ...footprints];
  const snapshot = snapshotOf(repository, { commit: model.meta.source?.commit ?? "HEAD", worktree: model.meta.source?.worktree });
  const where = `${snapshot.commit.slice(0, 7)}${snapshot.worktree ? " with uncommitted changes" : ""}`;
  const lineCounts = new Map<string, number>();
  const problems = new Set<string>();
  for (const { file, span } of anchors) {
    if (!existsInSnapshot(snapshot, file)) {
      problems.add(`missing path ${file} at ${where}`);
      continue;
    }
    if (!span) continue;
    if (!lineCounts.has(file)) lineCounts.set(file, (readInSnapshot(snapshot, file) ?? "").split("\n").length);
    const total = lineCounts.get(file)!;
    const [start, end] = [span.start.line, span.end?.line ?? span.start.line];
    if (end < start || end > total) problems.add(`span ${start}-${end} outside ${file} (${total} lines)`);
  }
  return [...problems];
}
