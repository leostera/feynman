// Content hashes of the files each element was derived from.
//
// Every element records `sources`: the git blob id of each file it anchors, at the
// modelled commit. Blob ids are content hashes git keeps for every file at every
// commit, so comparing an element against another commit costs one `git ls-tree`.
// When a recorded hash differs from the file at a later commit (or the file is
// gone), the element is outdated and must be re-examined.
import { git, lines } from "./git.mjs";
import { anchoredFiles } from "./anchors.mjs";
import { KINDS, loadModel, writeElement } from "./model.mjs";

/** Blob id of every file at `commit`. */
export function blobIds(repository, commit) {
  const blobs = new Map();
  for (const row of lines(git(repository, "-c", "core.quotePath=false", "ls-tree", "-r", "--full-tree", commit))) {
    const tab = row.indexOf("\t");
    const [, type, id] = row.slice(0, tab).split(" ");
    if (type === "blob") blobs.set(row.slice(tab + 1), id);
  }
  return blobs;
}

/** Record `sources` on every element from its anchors at the modelled commit. Returns how many changed. */
export function stampSources(repository, modelDir) {
  const model = loadModel(modelDir);
  const blobs = blobIds(repository, model.meta.source.commit);
  let changed = 0;
  for (const kind of KINDS) {
    for (const element of model[kind.key]) {
      const sources = {};
      for (const file of [...anchoredFiles(element)].sort()) if (blobs.has(file)) sources[file] = blobs.get(file);
      if (JSON.stringify(sources) === JSON.stringify(element.sources ?? {})) continue;
      writeElement(modelDir, kind, { ...element, sources });
      changed += 1;
    }
  }
  return changed;
}

/**
 * Elements whose recorded sources differ from `commit`: `{ kind, id, files }`, where
 * `files` are the changed or removed sources. Elements without sources are skipped.
 */
export function outdatedElements(repository, modelDir, commit) {
  const model = loadModel(modelDir);
  const blobs = blobIds(repository, commit);
  const outdated = [];
  for (const kind of KINDS) {
    for (const element of model[kind.key]) {
      const files = Object.entries(element.sources ?? {})
        .filter(([file, id]) => blobs.get(file) !== id)
        .map(([file]) => file);
      if (files.length) outdated.push({ kind: kind.dir, id: element.id, files });
    }
  }
  return outdated;
}
