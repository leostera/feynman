// Fill the mechanical parts of a model from git: source links, commit age, position
// relative to main, code footprints (files and lines) for actors and the repository,
// and each element's `sources` (content hashes of the files it anchors).
//
// Agents decide which paths belong to an actor (`actors/<id>.json` → `footprint.paths`);
// this only counts. Counts are taken at the model's commit, not the working tree.
import { readConfig } from "./config.mjs";
import { git, tryGit } from "./git.mjs";
import { KINDS, loadModel, writeElement, writeMeta } from "./model.mjs";
import { stampSources } from "./sources.mjs";

// Paths never counted, unless the model lists its own `meta.source.footprint.excludes`.
// Paths excluded in `.feynman/config.json` are never counted either.
const DEFAULT_EXCLUDES = ["vendor/", "third_party/", "*.lock", "package-lock.json", "*.lock.json"];

/** Measure the model in place; returns a one-line summary. */
export function measureModel(repository, modelDir, mainRef = "main") {
  const model = loadModel(modelDir);
  const source = model.meta.source;
  const excludes = [...new Set([...(source.footprint?.excludes ?? DEFAULT_EXCLUDES), ...readConfig(modelDir).exclude])];
  const pathspecExcludes = excludes.map((pattern) => `:!${pattern}`);
  const commit = git(repository, "rev-parse", source.commit);
  source.commit = commit;
  source.committedAt = git(repository, "log", "-1", "--format=%cI", commit);

  const web = webUrl(tryGit(repository, "remote", "get-url", "origin"));
  if (web) {
    source.url = web;
    source.commitUrl = `${web}/commit/${commit}`;
    source.fileUrl = `${web}/blob/${commit}/{path}`;
  }

  const main = tryGit(repository, "rev-parse", mainRef);
  if (main) {
    const [behind, ahead] = git(repository, "rev-list", "--left-right", "--count", `${main}...${commit}`).split(/\s+/).map(Number);
    source.main = { ref: mainRef, commit: main, ahead, behind, checkedAt: new Date().toISOString() };
  }

  /** Text files and lines under `paths` at the model's commit. */
  const count = (paths) => {
    // `git grep -c ''` prints `<commit>:<path>:<lines>` for every non-binary file.
    const out = tryGit(repository, "grep", "-I", "-c", "", commit, "--", ...paths, ...pathspecExcludes) ?? "";
    let files = 0;
    let lines = 0;
    for (const row of out.split("\n")) {
      const n = Number(row.slice(row.lastIndexOf(":") + 1));
      if (!row || Number.isNaN(n)) continue;
      files += 1;
      lines += n;
    }
    return { files, lines };
  };

  source.footprint = { ...count(["."]), excludes };
  const actorKind = KINDS.find((kind) => kind.key === "actors");
  for (const actor of model.actors) {
    if (!actor.footprint?.paths?.length) continue;
    Object.assign(actor.footprint, count(actor.footprint.paths));
    writeElement(modelDir, actorKind, actor);
  }
  writeMeta(modelDir, model.meta);
  const stamped = stampSources(repository, modelDir);
  return (
    `measured ${model.actors.filter((actor) => actor.footprint).length} actors; repository ${source.footprint.lines} lines; sources updated on ${stamped} elements` +
    (source.main ? `; ${source.main.behind} behind / ${source.main.ahead} ahead of ${mainRef}` : "")
  );
}

/** A browsable https URL for common git remotes, or null. */
function webUrl(remote) {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}
