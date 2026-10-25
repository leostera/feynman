// Where the repository and its model are, and how an extraction starts.
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { git, loadModel, tryGit, writeMeta, type Meta } from "@feynman/model";

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

export type Start = (
  | { kind: "bootstrap"; commit: string }
  | { kind: "update"; base: string; commit: string }
  | { kind: "resume"; mode: "bootstrap" | "update"; commit: string }
) & {
  /** Whether the snapshot includes uncommitted changes on top of the commit. */
  worktree: boolean;
};

/**
 * Prepare the model directory for an extraction at HEAD:
 * - no model: write a skeleton meta.json for a bootstrap;
 * - model at HEAD: resume it;
 * - model at an ancestor of HEAD: turn it into an update from that commit.
 * The agent reads the working tree, so with uncommitted changes (untracked files
 * included) the model describes HEAD plus those changes (`meta.source.worktree`).
 */
export function startExtraction({ repository, modelDir }: Workspace): Start {
  const worktree = git(repository, "status", "--porcelain", "--untracked-files=normal", "--", ":/", ":(top,exclude).feynman") !== "";
  const commit = git(repository, "rev-parse", "HEAD");

  if (!existsSync(join(modelDir, "meta.json"))) {
    mkdirSync(modelDir, { recursive: true });
    writeMeta(modelDir, {
      system: basename(repository),
      summary: "",
      source: { repository: ".", commit, ...(worktree ? { worktree } : {}) },
      extractedBy: "feynman",
      extraction: "bootstrap",
    });
    return { kind: "bootstrap", commit, worktree };
  }

  const { meta } = loadModel(modelDir);
  const modelled = tryGit(repository, "rev-parse", meta.source.commit);
  if (modelled === commit) {
    // Same commit: what changed on disk since is caught by the hashes of what was read.
    writeMeta(modelDir, { ...meta, source: withWorktree(meta.source, worktree) });
    return { kind: "resume", mode: meta.extraction ?? "bootstrap", commit, worktree };
  }
  if (!modelled || tryGit(repository, "merge-base", "--is-ancestor", modelled, commit) === null) {
    throw new Error(`The model is at ${meta.source.commit}, which is not an ancestor of HEAD. Check out a descendant, or remove ${MODEL_DIR} to bootstrap.`);
  }

  const { main: _main, ...source } = meta.source;
  writeMeta(modelDir, { ...meta, extraction: "update", source: withWorktree({ ...source, base: { commit: modelled }, commit }, worktree) });
  // Ledgers describe coverage at the old commit; history keeps them.
  rmSync(join(modelDir, "coverage"), { recursive: true, force: true });
  return { kind: "update", base: modelled, commit, worktree };
}

function withWorktree(source: Meta["source"], worktree: boolean): Meta["source"] {
  const { worktree: _was, ...rest } = source;
  return worktree ? { ...rest, worktree } : rest;
}
