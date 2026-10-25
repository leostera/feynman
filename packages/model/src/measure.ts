// Fill the mechanical parts of a model from git: source links, commit age, position
// relative to main, code footprints (files and lines) for components and the
// repository, and each element's `sources` (content hashes of the files it anchors).
//
// Agents decide which paths belong to a component (`footprint.paths`); this only
// counts, in the modelled snapshot.
import { spawnSync } from "node:child_process";
import { readConfig } from "./config.ts";
import { MODEL_ROOT } from "./coverage.ts";
import { git, tryGit } from "./git.ts";
import { KINDS, loadModel, writeElement, writeMeta } from "./model.ts";
import { pathspecs, snapshotOf, type Snapshot } from "./snapshot.ts";
import { stampSources } from "./sources.ts";
import type { Footprint, Source } from "./types.ts";

/** Never counted as code: the model itself, dependency copies, and lockfiles. */
const NOT_CODE = [MODEL_ROOT, "vendor/", "third_party/", "*.lock", "package-lock.json", "*.lock.json"];

/** Measure the model in place; returns a one-line summary. */
export function measureModel(repository: string, modelDir: string, mainRef = "main"): string {
  const model = loadModel(modelDir);
  const source = model.meta.source;
  source.commit = git(repository, "rev-parse", source.commit);
  source.committedAt = git(repository, "log", "-1", "--format=%cI", source.commit);
  Object.assign(source, links(repository, source.commit));
  const main = mainPosition(repository, source.commit, mainRef);
  if (main) source.main = main;

  const excludes = [...new Set([...NOT_CODE, ...readConfig(modelDir).exclude])];
  const count = (paths: string[]) => countLines(snapshotOf(repository, source), paths, excludes);
  source.footprint = { ...count([":/"]), excludes };
  const components = KINDS.find((kind) => kind.key === "components")!;
  for (const component of model.components) {
    if (!component.footprint?.paths?.length) continue;
    component.footprint = { ...component.footprint, ...count(component.footprint.paths) };
    writeElement(modelDir, components, component);
  }
  writeMeta(modelDir, model.meta);
  const stamped = stampSources(repository, modelDir);
  return (
    `measured ${model.components.length} components; repository ${source.footprint.lines} lines; sources updated on ${stamped} elements` +
    (main ? `; ${main.behind} behind / ${main.ahead} ahead of ${mainRef}` : "")
  );
}

/** Browsable links to the commit and its files, for remotes on common hosts. */
function links(repository: string, commit: string): Pick<Source, "url" | "commitUrl" | "fileUrl"> {
  const web = webUrl(tryGit(repository, "remote", "get-url", "origin"));
  return web ? { url: web, commitUrl: `${web}/commit/${commit}`, fileUrl: `${web}/blob/${commit}/{path}` } : {};
}

function mainPosition(repository: string, commit: string, ref: string): Source["main"] | null {
  const main = tryGit(repository, "rev-parse", ref);
  if (!main) return null;
  const [behind, ahead] = git(repository, "rev-list", "--left-right", "--count", `${main}...${commit}`).split(/\s+/).map(Number);
  return { ref, commit: main, ahead, behind, checkedAt: new Date().toISOString() };
}

/** Text files and lines under `paths` in the snapshot. */
function countLines(snapshot: Snapshot, paths: string[], excludes: string[]): Pick<Footprint, "files" | "lines"> {
  // `git grep -c ''` prints `[<commit>:]<path>:<lines>` for every non-binary file.
  // Options go before the pattern and the revision after it; exit status 1 means no files matched.
  const [options, revision] = snapshot.worktree ? [["--untracked"], []] : [[], [snapshot.commit]];
  const scope = [...paths, ...pathspecs(excludes).slice(1)];
  const grep = spawnSync("git", ["-C", snapshot.repository, "grep", "-I", "-c", ...options, "", ...revision, "--", ...scope], { encoding: "utf8", maxBuffer: 1 << 28 });
  if (grep.status !== 0 && grep.status !== 1) throw new Error(`git grep failed: ${grep.stderr.trim()}`);
  const out = grep.stdout;
  let files = 0;
  let lines = 0;
  for (const row of out.split("\n")) {
    const n = Number(row.slice(row.lastIndexOf(":") + 1));
    if (!row || Number.isNaN(n)) continue;
    files += 1;
    lines += n;
  }
  return { files, lines };
}

/** A browsable https URL for common git remotes, or null. */
function webUrl(remote: string | null): string | null {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(\.git)?$/);
  return https ? `https://${https[1]}/${https[2]}` : null;
}
