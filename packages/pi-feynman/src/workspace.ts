// Where the repository and its model are, and how an extraction starts.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { git, tryGit } from "@feynman/model";

export const MODEL_DIR = ".feynman/model";

export interface Workspace {
  /** Absolute path of the repository root. */
  repository: string;
  /** Absolute path of the model directory. */
  modelDir: string;
}

/** The repository containing `cwd`, or null outside a git repository. */
export function findWorkspace(cwd: string): Workspace | null {
  const repository = tryGit(cwd, "rev-parse", "--show-toplevel");
  return repository ? { repository, modelDir: join(repository, MODEL_DIR) } : null;
}

export type Start =
  | { kind: "bootstrap"; commit: string }
  | { kind: "update"; base: string; commit: string }
  | { kind: "resume"; mode: "bootstrap" | "update"; commit: string };

/**
 * Prepare the model directory for an extraction at HEAD:
 * - no model: write a skeleton meta.json for a bootstrap;
 * - model at HEAD: resume it;
 * - model at an ancestor of HEAD: turn it into an update from that commit.
 * The tracked files must match HEAD, because the agent reads the working tree.
 */
export function startExtraction({ repository, modelDir }: Workspace): Start {
  const dirty = git(repository, "status", "--porcelain", "--untracked-files=no", "--", ".", ":!.feynman");
  if (dirty) throw new Error(`Tracked files differ from HEAD; commit or stash them first:\n${dirty}`);
  const commit = git(repository, "rev-parse", "HEAD");
  const metaPath = join(modelDir, "meta.json");

  if (!existsSync(metaPath)) {
    mkdirSync(modelDir, { recursive: true });
    const meta = {
      system: basename(repository),
      summary: "",
      source: { repository: ".", commit },
      extractedBy: "pi-feynman",
      extraction: "bootstrap",
    };
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
    return { kind: "bootstrap", commit };
  }

  const meta = JSON.parse(readFileSync(metaPath, "utf8"));
  const modelled = tryGit(repository, "rev-parse", meta.source?.commit ?? "");
  if (modelled === commit) return { kind: "resume", mode: meta.extraction === "update" ? "update" : "bootstrap", commit };
  if (!modelled || tryGit(repository, "merge-base", "--is-ancestor", modelled, commit) === null) {
    throw new Error(`The model is at ${meta.source?.commit}, which is not an ancestor of HEAD. Check out a descendant, or remove ${MODEL_DIR} to bootstrap.`);
  }

  meta.extraction = "update";
  meta.source = { ...meta.source, base: { commit: modelled }, commit };
  delete meta.source.main;
  writeFileSync(metaPath, JSON.stringify(meta, null, 2) + "\n");
  // Ledgers describe reviews at the old commit; history keeps them.
  const coverageDir = join(modelDir, "coverage");
  if (existsSync(coverageDir)) for (const name of readdirSync(coverageDir)) rmSync(join(coverageDir, name));
  return { kind: "update", base: modelled, commit };
}
