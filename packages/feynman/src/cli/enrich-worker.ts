// The slow half of `feynman dev`, on its own thread: checking every spec, and the call trees
// under their sources. Both block (the checker is CPU, calldiff is spawned synchronously), so
// on the server's thread they would freeze the page for as long as they take.
//
// Each run reports checks first and call trees after, so neither waits for the other. Call
// trees depend on the code, not on the spec, so they are kept between runs while the code is
// unchanged: the commit, and every uncommitted file's modification time.
import { statSync } from "node:fs";
import { join } from "node:path";
import { check, type Report } from "../check/index.ts";
import type { Spec } from "../spec/index.ts";
import { callTrees, git, type CallNode } from "../code/index.ts";
import type { FunctionCode } from "../view/data.ts";
import { context, specSources } from "./commands.ts";
import { functionCode } from "./functions.ts";
import { loadSpec } from "./load.ts";
import { scenarioSeeds } from "../check/seeds.ts";

declare const self: Worker;

/** What the server asks for: a run over the specs in this directory's repository. */
export interface EnrichRequest {
  cwd: string;
}

/** What a run reports, by spec path; `done` ends a run, whether or not it got that far. */
export type EnrichMessage =
  | { kind: "progress"; message: string }
  | { kind: "reports"; reports: Record<string, Report> }
  | { kind: "calls"; calls: Record<string, Record<string, CallNode>>; functions: Record<string, Record<string, FunctionCode>> }
  | { kind: "done"; seconds: number; error?: string };

const say = (message: EnrichMessage) => self.postMessage(message);

/** Call trees by source, for the code as it was when they were found; null where calldiff found none. */
const cachedCalls = new Map<string, CallNode | null>();
let cachedFor: string | null = null;

/** Changes whenever the code could have: another commit, or an uncommitted file touched. */
function codeVersion(root: string): string {
  const head = git(root, "rev-parse", "HEAD");
  const dirty = git(root, "status", "--porcelain=v1", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const path = line.slice(3).split(" -> ").at(-1)!;
      try {
        return `${path}@${statSync(join(root, path)).mtimeMs}`;
      } catch {
        return `${path}@gone`;
      }
    });
  return [head, ...dirty].join("\n");
}

self.onmessage = async (event: MessageEvent<EnrichRequest>) => {
  const started = Date.now();
  try {
    const ctx = await context(event.data.cwd);
    const root = ctx.repository.root;
    const specs: { path: string; spec: Spec }[] = [];
    for (const path of ctx.found) {
      try {
        specs.push({ path, spec: await loadSpec(join(root, path)) });
      } catch {
        // The server's own pass shows a spec that does not load; there is nothing to check.
      }
    }

    const reports: Record<string, Report> = {};
    for (const [i, { path, spec }] of specs.entries()) {
      say({ kind: "progress", message: `checking [${i + 1}/${specs.length}] ${path}` });
      // On this thread only: it is a worker already, and the server's checks are small.
      reports[path] = await check(spec, { ...ctx.config.check }, scenarioSeeds(spec));
    }
    say({ kind: "reports", reports });

    const version = codeVersion(root);
    if (version !== cachedFor) {
      cachedCalls.clear();
      cachedFor = version;
    }
    const wanted = [...new Set(specs.flatMap(({ spec }) => specSources(spec)))];
    const missing = wanted.filter((source) => !cachedCalls.has(source));
    if (missing.length) {
      say({ kind: "progress", message: `finding calls under ${missing.length} source(s)` });
      const { trees } = callTrees(root, missing);
      for (const source of missing) cachedCalls.set(source, trees[source] ?? null);
    }
    const calls: Record<string, Record<string, CallNode>> = {};
    const functions: Record<string, Record<string, FunctionCode>> = {};
    for (const { path, spec } of specs) {
      calls[path] = Object.fromEntries(specSources(spec).flatMap((source) => {
        const tree = cachedCalls.get(source);
        return tree ? [[source, tree]] : [];
      }));
      functions[path] = await functionCode(root, ctx.repository.fileUrl, calls[path]);
    }
    say({ kind: "calls", calls, functions });
    say({ kind: "done", seconds: (Date.now() - started) / 1000 });
  } catch (error) {
    say({ kind: "done", seconds: (Date.now() - started) / 1000, error: error instanceof Error ? error.message : String(error) });
  }
};
