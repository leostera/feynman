// Content hashes of the files each element was derived from.
//
// Every element records `sources`: the content hash of each file it anchors, as the
// file was on disk when the element was derived, committed or not. The hash is the
// git blob id (`git hash-object`), which equals the id git gives the same content
// when it is committed, so working-tree hashes and commit hashes compare directly:
// a model of uncommitted work stays current once that work is committed. When a
// recorded hash differs from the file at a later commit or in the working tree (or
// the file is gone), the element is outdated and must be re-examined.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

/**
 * Blob id of each existing file in `paths` as it is on disk now (tracked or not),
 * with git's clean filters applied, exactly as `git add` would hash it.
 */
export function workingTreeBlobIds(repository, paths) {
  const files = [...new Set(paths)].filter((path) => {
    const full = join(repository, path);
    return existsSync(full) && statSync(full).isFile();
  });
  if (!files.length) return new Map();
  const ids = execFileSync("git", ["-C", repository, "hash-object", "--stdin-paths"], { input: files.join("\n") + "\n", encoding: "utf8" })
    .trim()
    .split("\n");
  return new Map(files.map((path, i) => [path, ids[i]]));
}

/** Blob ids for `paths` at `target`: a commit, or the working tree when `target` is null. */
function blobsAt(repository, target, paths) {
  return target === null ? workingTreeBlobIds(repository, paths) : blobIds(repository, target);
}

/**
 * Record `sources` on every element: the hash of each file it anchors, as on disk
 * now (the contents the agent examined). Returns how many elements changed.
 */
export function stampSources(repository, modelDir) {
  const model = loadModel(modelDir);
  const elements = KINDS.flatMap((kind) => model[kind.key]);
  const blobs = workingTreeBlobIds(repository, elements.flatMap((element) => [...anchoredFiles(element)]));
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
 * Elements whose recorded sources differ from `target` (a commit, or the working tree
 * when null): `{ kind, id, files }`, where `files` are the changed or removed sources.
 * Elements without sources are skipped.
 */
export function outdatedElements(repository, modelDir, target = null) {
  const model = loadModel(modelDir);
  const recorded = KINDS.flatMap((kind) => model[kind.key]).flatMap((element) => Object.keys(element.sources ?? {}));
  const blobs = blobsAt(repository, target, recorded);
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
