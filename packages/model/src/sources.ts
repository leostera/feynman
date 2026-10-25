// Content hashes of the files each element was derived from.
//
// Every element records `sources`: the hash of each file it anchors, as the file
// was on disk when the element was derived, committed or not (see snapshot.ts for
// why disk and commit hashes compare). When a recorded hash differs from the file in
// a later snapshot, or the file is gone, the element is outdated and must be
// re-examined.
import { anchoredFiles } from "./anchors.ts";
import { elementsOf, loadModel, writeElement } from "./model.ts";
import { snapshotBlobIds, workingTreeBlobIds, type Snapshot } from "./snapshot.ts";

export interface OutdatedElement {
  /** Model directory of the kind, e.g. "flows". */
  kind: string;
  id: string;
  /** Sources whose content changed or that no longer exist. */
  files: string[];
}

/** Record `sources` on every element from the files on disk. Returns how many elements changed. */
export function stampSources(repository: string, modelDir: string): number {
  const elements = elementsOf(loadModel(modelDir));
  const blobs = workingTreeBlobIds(repository, elements.flatMap(({ element }) => [...anchoredFiles(element)]));
  let changed = 0;
  for (const { kind, element } of elements) {
    const sources: Record<string, string> = {};
    for (const file of [...anchoredFiles(element)].sort()) {
      const id = blobs.get(file);
      if (id) sources[file] = id;
    }
    if (JSON.stringify(sources) === JSON.stringify(element.sources ?? {})) continue;
    writeElement(modelDir, kind, { ...element, sources });
    changed += 1;
  }
  return changed;
}

/** Elements whose recorded sources differ from the snapshot. Elements without sources are skipped. */
export function outdatedElements(snapshot: Snapshot, modelDir: string): OutdatedElement[] {
  const elements = elementsOf(loadModel(modelDir));
  const blobs = snapshotBlobIds(snapshot, elements.flatMap(({ element }) => Object.keys(element.sources ?? {})));
  return elements.flatMap(({ kind, element }) => {
    const files = Object.entries(element.sources ?? {})
      .filter(([file, id]) => blobs.get(file) !== id)
      .map(([file]) => file);
    return files.length ? [{ kind: kind.dir, id: element.id, files }] : [];
  });
}
